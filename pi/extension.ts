/**
 * fast-jev-compaction as a Pi extension.
 *
 * Pi has no "replace the summary with these messages" hook. Its verbatim
 * mechanism is the append-only `context_edit` entry: a later entry can omit an
 * earlier entry from model context or replace its content, and Pi keeps every
 * raw message on disk. So this adapter never summarizes. When the context
 * crosses `compactAtPercent`, it asks Jev about the tool calls outside the
 * pinned first and newest messages and appends `context_edit` entries for the
 * ones Jev lets go:
 *
 * - `drop_call`   -> the tool call is removed from its assistant message and
 *                    its tool result entry is omitted;
 * - `drop_result` -> the tool result keeps a bounded head plus a note;
 * - `keep`        -> nothing.
 *
 * User and assistant text stays verbatim, and Pi's own summary compaction
 * remains the fallback when Jev fails or cannot free enough.
 */

import type {
  AgentMessage,
  AssistantMessage,
  ContextEditEntryDraft,
  ContextEditableContent,
  ExtensionAPI,
  ExtensionContext,
  ProjectedSessionEntry,
  TextContent,
  ToolCall as PiToolCall,
} from '@earendil-works/pi-coding-agent';

import { JevClient } from '../src/client.js';
import {
  askBatch,
  batchCalls,
  collectToolCalls,
  decideCall,
  fitState,
  resolveOptions,
  truncatedResultText,
} from '../src/index.js';
import { DEFAULT_MODEL } from '../src/request.js';
import type {
  CallAnswer,
  CallDecision,
  CompactOptions,
  JevAsker,
  Message,
  ToolCall,
} from '../src/types.js';

export const PI_DEFAULTS = {
  compactAtPercent: 60,
  model: DEFAULT_MODEL,
};

export type PiConfig = CompactOptions & {
  apiKey?: string;
  model: string;
  /** Context percentage at which a turn asks Jev to prune. Default 60. */
  compactAtPercent: number;
  baseUrl?: string;
};

function envNumber(env: Record<string, string | undefined>, key: string, fallback: number): number {
  const raw = env[key];
  const value = raw === undefined ? NaN : Number(raw);
  return Number.isFinite(value) ? value : fallback;
}

/** Reads `TYPESAFE_API_KEY`, `FAST_JEV_*` overrides and the built-in defaults. */
export function resolvePiConfig(
  env: Record<string, string | undefined> = process.env,
): PiConfig {
  const config: PiConfig = {
    model: env.FAST_JEV_MODEL || PI_DEFAULTS.model,
    compactAtPercent: envNumber(
      env,
      'FAST_JEV_COMPACT_AT_PERCENT',
      PI_DEFAULTS.compactAtPercent,
    ),
  };
  if (env.TYPESAFE_API_KEY) config.apiKey = env.TYPESAFE_API_KEY;
  if (env.FAST_JEV_BASE_URL) config.baseUrl = env.FAST_JEV_BASE_URL;
  const keepThreshold = envNumber(env, 'FAST_JEV_KEEP_THRESHOLD', NaN);
  if (Number.isFinite(keepThreshold)) config.keepThreshold = keepThreshold;
  const preserveRecentMessages = envNumber(env, 'FAST_JEV_PRESERVE_RECENT_MESSAGES', NaN);
  if (Number.isFinite(preserveRecentMessages)) {
    config.preserveRecentMessages = preserveRecentMessages;
  }
  const truncateHeadChars = envNumber(env, 'FAST_JEV_TRUNCATE_HEAD_CHARS', NaN);
  if (Number.isFinite(truncateHeadChars)) config.truncateHeadChars = truncateHeadChars;
  return config;
}

/** The text a message contributes to the library's flat `Message`. */
export function textOf(content: string | readonly { type: string; text?: string }[]): string {
  if (typeof content === 'string') return content;
  return content
    .filter((block): block is TextContent => block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n');
}

/** One Pi message as the library sees it; system messages are not candidates. */
export function toMessage(agent: AgentMessage): Message | undefined {
  switch (agent.role) {
    case 'assistant': {
      const toolUses = agent.content
        .filter((block): block is PiToolCall => block.type === 'toolCall')
        .map((block) => ({
          tool_use_id: block.id,
          tool: block.name,
          input: block.arguments,
        }));
      return { role: 'assistant', text: textOf(agent.content), toolUses };
    }
    case 'toolResult':
      return {
        role: 'user',
        text: '',
        toolUses: [],
        toolResults: [
          {
            tool_use_id: agent.toolCallId,
            text: textOf(agent.content),
            isError: agent.isError,
          },
        ],
      };
    case 'user':
      return { role: 'user', text: textOf(agent.content), toolUses: [] };
    case 'custom':
      return { role: 'user', text: textOf(agent.content), toolUses: [] };
    case 'bashExecution':
      return { role: 'user', text: agent.output, toolUses: [] };
    case 'branchSummary':
      return { role: 'user', text: agent.summary, toolUses: [] };
    case 'compactionSummary':
      return { role: 'user', text: agent.summary, toolUses: [] };
    case 'system':
      return undefined;
  }
}

export type Mapping = {
  messages: Message[];
  /** Entry id owning each mapped message, parallel to `messages`. */
  entryIds: string[];
  /** The Pi message each entry id contributes, for content edits. */
  byEntryId: Map<string, AgentMessage>;
};

/** Flattens a Pi session projection into the library's transcript shape. */
export function toMapping(entries: readonly ProjectedSessionEntry[]): Mapping {
  const messages: Message[] = [];
  const entryIds: string[] = [];
  const byEntryId = new Map<string, AgentMessage>();
  for (const { sourceEntry, messages: agentMessages } of entries) {
    for (const agent of agentMessages) {
      const mapped = toMessage(agent);
      if (!mapped) continue;
      messages.push(mapped);
      entryIds.push(sourceEntry.id);
      byEntryId.set(sourceEntry.id, agent);
    }
  }
  return { messages, entryIds, byEntryId };
}

/**
 * Turns Jev's decisions into append-only `context_edit` drafts. Dropped calls
 * are grouped per assistant entry so each entry gets one replacement, and every
 * omitted result follows its dropped call.
 */
export function decisionsToDrafts(
  mapping: Mapping,
  calls: readonly ToolCall[],
  decisions: readonly CallDecision[],
  headChars: number,
): ContextEditEntryDraft[] {
  const drafts: ContextEditEntryDraft[] = [];
  const droppedByEntry = new Map<string, Set<string>>();

  calls.forEach((call, index) => {
    const decision = decisions[index];
    if (!decision || decision.reason === 'pinned' || decision.action === 'keep') return;
    const resultEntryId = mapping.entryIds[call.resultIndex];
    const resultSource = resultEntryId ? mapping.byEntryId.get(resultEntryId) : undefined;

    if (decision.action === 'drop_call') {
      if (resultEntryId) {
        drafts.push({ type: 'context_edit', targetId: resultEntryId, replacement: null });
      }
      const callEntryId = mapping.entryIds[call.callIndex];
      if (callEntryId) {
        const ids = droppedByEntry.get(callEntryId) ?? new Set<string>();
        ids.add(call.tool_use_id);
        droppedByEntry.set(callEntryId, ids);
      }
      return;
    }

    if (resultSource?.role !== 'toolResult' || !resultEntryId) return;
    const original = textOf(resultSource.content);
    const text = truncatedResultText(original, resultSource.isError, headChars);
    if (text !== original) {
      drafts.push({
        type: 'context_edit',
        targetId: resultEntryId,
        replacement: { content: text },
      });
    }
  });

  for (const [entryId, ids] of droppedByEntry) {
    const source = mapping.byEntryId.get(entryId);
    if (source?.role !== 'assistant') continue;
    const content = (source as AssistantMessage).content.filter(
      (block) => !(block.type === 'toolCall' && ids.has(block.id)),
    );
    const replacement: { content: ContextEditableContent } | null =
      content.length > 0 ? { content } : null;
    drafts.push({ type: 'context_edit', targetId: entryId, replacement });
  }

  return drafts;
}

export type PruneResult = {
  drafts: ContextEditEntryDraft[];
  decisions: CallDecision[];
  calls: ToolCall[];
  /** Jev's estimated reduction over the mapped transcript. */
  reductionRatio: number;
  requests: number;
};

/**
 * Asks Jev about the unpinned tool calls not asked before and builds the
 * context edits for its decisions. Returns `undefined` when there is nothing
 * new to ask. Throws when Jev fails or the history cannot be fitted; the
 * caller decides what to fall back to.
 */
export async function pruneEntries(
  entries: readonly ProjectedSessionEntry[],
  config: PiConfig,
  asker: JevAsker,
  asked: Set<string>,
): Promise<PruneResult | undefined> {
  const mapping = toMapping(entries);
  const options = resolveOptions(config);
  const calls = collectToolCalls(mapping.messages, options.preserveRecentMessages);
  const candidates = calls.filter(
    (call) => !call.pinned && !asked.has(call.tool_use_id),
  );
  if (candidates.length === 0) return undefined;

  const fitted = fitState(mapping.messages, calls, options);
  const batches = batchCalls(candidates, fitted.tokens, options);
  const answered = await Promise.all(
    batches.map((batch) => askBatch(asker, fitted.state, batch)),
  );
  const answers = new Map<string, CallAnswer>();
  for (const map of answered) for (const [id, answer] of map) answers.set(id, answer);
  for (const call of candidates) asked.add(call.tool_use_id);

  const decisions = calls.map((call) =>
    decideCall(call, answers.get(call.id) ?? { keepCall: 1, keepResult: 1 }, options),
  );
  const drafts = decisionsToDrafts(mapping, calls, decisions, options.truncateHeadChars);

  const charsBefore = calls.reduce((sum, call) => sum + call.resultChars, 0);
  const charsAfter = calls.reduce((sum, call, index) => {
    const action = decisions[index]?.action;
    if (action === 'drop_call') return sum;
    if (action === 'drop_result') return sum + Math.min(call.resultChars, options.truncateHeadChars);
    return sum + call.resultChars;
  }, 0);
  const reductionRatio = charsBefore === 0 ? 0 : (charsBefore - charsAfter) / charsBefore;

  return { drafts, decisions, calls, reductionRatio, requests: batches.length };
}

/** One line for the user: what Jev let go and how much of it there was. */
export function summarizePrune(result: PruneResult): string {
  const dropped = result.decisions.filter((d) => d.action === 'drop_call').length;
  const truncated = result.decisions.filter((d) => d.action === 'drop_result').length;
  const parts = [
    dropped > 0 ? `${dropped} call(s) dropped` : '',
    truncated > 0 ? `${truncated} result(s) truncated` : '',
  ].filter(Boolean);
  return `${parts.join(', ') || 'nothing to drop'}; tool output down ${Math.round(
    result.reductionRatio * 100,
  )}% in ${result.requests} request(s)`;
}

export type JevAskerFactory = (config: PiConfig) => JevAsker;

/** A hung Jev call would otherwise stall every turn; the caller falls back on abort. */
const REQUEST_TIMEOUT_MS = 30_000;

/** The library's HTTP client, over the global fetch Pi runs with. */
export const defaultAsker: JevAskerFactory = (config) =>
  new JevClient({
    apiKey: config.apiKey,
    model: config.model,
    baseUrl: config.baseUrl,
    fetch: (url, init) =>
      fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) }),
  });

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Registers the `turn_end` pruner and the `/jev-prune` command on a Pi extension API. */
export function register(
  pi: ExtensionAPI,
  config: PiConfig,
  askerFactory: JevAskerFactory = defaultAsker,
): void {
  const asked = new Set<string>();
  // Drafts from `/jev-prune`, applied by the next turn boundary.
  let pending: { drafts: ContextEditEntryDraft[]; summary: string } | undefined;

  pi.on('session_start', () => {
    asked.clear();
    pending = undefined;
  });

  pi.registerCommand('jev-prune', {
    description: 'Ask Jev now; the edits apply at the end of your next turn',
    handler: async (_args, ctx) => {
      if (!config.apiKey) {
        ctx.ui.notify('fast-jev-compaction skipped (TYPESAFE_API_KEY is not set)', 'warning');
        return;
      }
      if (pending) {
        ctx.ui.notify(
          `fast-jev-compaction: ${pending.summary} already queued for your next turn`,
          'info',
        );
        return;
      }
      try {
        const entries = ctx.sessionManager.buildSessionProjection().entries;
        const pruned = await pruneEntries(entries, config, askerFactory(config), asked);
        if (!pruned || pruned.drafts.length === 0) {
          ctx.ui.notify('fast-jev-compaction: nothing to drop', 'info');
          return;
        }
        pending = { drafts: pruned.drafts, summary: summarizePrune(pruned) };
        ctx.ui.notify(
          `fast-jev-compaction: ${summarizePrune(pruned)}; applies at the end of your next turn`,
          'info',
        );
      } catch (error) {
        ctx.ui.notify(`fast-jev-compaction: ${messageOf(error)}`, 'warning');
      }
    },
  });

  pi.on('turn_end', async (event, ctx: ExtensionContext) => {
    const percent = ctx.getContextUsage()?.percent;
    const overThreshold = typeof percent === 'number' && percent >= config.compactAtPercent;
    if (!overThreshold && !pending) return;
    if (!config.apiKey) {
      ctx.ui.notify('fast-jev-compaction skipped (TYPESAFE_API_KEY is not set)', 'warning');
      return;
    }
    const queued = pending;
    try {
      const pruned = overThreshold
        ? await pruneEntries(event.context.contextEntries, config, askerFactory(config), asked)
        : undefined;
      const drafts = [...(queued?.drafts ?? []), ...(pruned?.drafts ?? [])];
      pending = undefined;
      if (drafts.length === 0) return;
      const summary = pruned ? summarizePrune(pruned) : (queued?.summary ?? 'queued edits');
      ctx.ui.notify(`fast-jev-compaction: ${summary}`, 'info');
      return { entries: drafts };
    } catch (error) {
      ctx.ui.notify(`fast-jev-compaction skipped (${messageOf(error)})`, 'warning');
      return;
    }
  });

  // A manual /compact can be answered with "keep everything verbatim": if Jev
  // has nothing left to drop, the summary would only lose information. The
  // drops themselves need a turn boundary to apply, so when Jev does find
  // something, Pi's summary stays the fallback. Threshold and overflow
  // compactions are capacity emergencies and are never cancelled.
  pi.on('session_before_compact', async (event, ctx: ExtensionContext) => {
    if (event.reason !== 'manual' || !config.apiKey) return;
    try {
      const entries = ctx.sessionManager.buildSessionProjection().entries;
      const pruned = await pruneEntries(entries, config, askerFactory(config), asked);
      if (pruned && pruned.drafts.length > 0) {
        ctx.ui.notify(
          `fast-jev-compaction: ${summarizePrune(pruned)}, but edits need a turn boundary; using Pi's summary`,
          'warning',
        );
        return;
      }
      ctx.ui.notify(
        'fast-jev-compaction: nothing left to drop, keeping history verbatim',
        'info',
      );
      return { cancel: true };
    } catch (error) {
      ctx.ui.notify(
        `fast-jev-compaction: ${messageOf(error)}; using Pi's summary`,
        'warning',
      );
      return;
    }
  });
}

export default function (pi: ExtensionAPI): void {
  register(pi, resolvePiConfig());
}
