/**
 * Native omp pruning: project messages at the provider boundary, keeping the
 * raw session journal intact. Custom entries persist branch-local decisions;
 * omp's built-in summary compaction remains an independent fallback.
 */
import type { AgentMessage } from '@oh-my-pi/pi-agent-core';
import type { ToolCall as OmpToolCall } from '@oh-my-pi/pi-ai';
import type {
  ExtensionAPI,
  ExtensionContext,
  SessionEntry,
} from '@oh-my-pi/pi-coding-agent';

import {
  defaultAsker,
  resolvePiConfig,
  textOf,
  type JevAskerFactory,
  type PiConfig,
} from '../pi/extension.js';
import {
  askBatch,
  batchCalls,
  collectToolCalls,
  decideCall,
  fitState,
  resolveOptions,
  truncatedResultText,
} from '../src/index.js';
import type { CallAction, CallAnswer, Message } from '../src/types.js';

export const OMP_JEV_ENTRY_TYPE = 'fast-jev-compaction';

type StoredDecision = { toolCallId: string; action: CallAction };
type JournalData = {
  version: 1;
  truncateHeadChars: number;
  decisions: StoredDecision[];
};
type Decision = { action: CallAction; truncateHeadChars: number };

/** Ignore a malformed batch in its entirety, rather than applying partial drops. */
function journalData(value: unknown): JournalData | undefined {
  if (value === null || typeof value !== 'object' ||
      !('version' in value) || value.version !== 1 ||
      !('truncateHeadChars' in value) || typeof value.truncateHeadChars !== 'number' ||
      !Number.isSafeInteger(value.truncateHeadChars) || value.truncateHeadChars < 0 ||
      !('decisions' in value) || !Array.isArray(value.decisions)) return undefined;
  const ids = new Set<string>();
  for (const decision of value.decisions) {
    if (decision === null || typeof decision !== 'object' ||
        !('toolCallId' in decision) || typeof decision.toolCallId !== 'string' ||
        decision.toolCallId.length === 0 || ids.has(decision.toolCallId) ||
        !('action' in decision) ||
        (decision.action !== 'keep' && decision.action !== 'drop_result' &&
         decision.action !== 'drop_call')) return undefined;
    ids.add(decision.toolCallId);
  }
  return value as JournalData;
}

function branchDecisions(entries: readonly SessionEntry[]): Map<string, Decision> {
  const decisions = new Map<string, Decision>();
  for (const entry of entries) {
    if (entry.type !== 'custom' || entry.customType !== OMP_JEV_ENTRY_TYPE) continue;
    const data = journalData(entry.data);
    if (!data) continue;
    for (const decision of data.decisions) {
      if (!decisions.has(decision.toolCallId)) {
        decisions.set(decision.toolCallId, {
          action: decision.action,
          truncateHeadChars: data.truncateHeadChars,
        });
      }
    }
  }
  return decisions;
}

/** Include every native message in the flat history so pinning keeps its indices. */
function toMessage(message: AgentMessage): Message {
  if (message.role === 'assistant') {
    return {
      role: 'assistant',
      text: textOf(message.content),
      toolUses: message.content
        .filter((block): block is OmpToolCall => block.type === 'toolCall')
        .map((block) => ({ tool_use_id: block.id, tool: block.name, input: block.arguments })),
    };
  }
  if (message.role === 'toolResult') {
    return {
      role: 'user', text: '', toolUses: [],
      toolResults: [{
        tool_use_id: message.toolCallId,
        text: textOf(message.content),
        isError: message.isError,
      }],
    };
  }
  let text = '';
  if ('content' in message) text = textOf(message.content);
  else if ('output' in message) text = message.output;
  else if ('summary' in message) text = message.summary;
  else if (message.role === 'fileMention') text = message.files.map((file) => file.content).join('\n');
  return { role: 'user', text, toolUses: [] };
}

/** Ambiguous or incomplete IDs must never cause a call or result to disappear. */
function pairedIds(messages: readonly AgentMessage[]): Set<string> {
  const pairs = new Map<string, { calls: number; results: number; callIndex: number; resultIndex: number }>();
  const pairFor = (id: string) => {
    let pair = pairs.get(id);
    if (!pair) {
      pair = { calls: 0, results: 0, callIndex: -1, resultIndex: -1 };
      pairs.set(id, pair);
    }
    return pair;
  };
  messages.forEach((message, index) => {
    if (message.role === 'assistant') {
      for (const block of message.content) {
        if (block.type !== 'toolCall') continue;
        const pair = pairFor(block.id);
        pair.calls++;
        pair.callIndex = index;
      }
    } else if (message.role === 'toolResult') {
      const pair = pairFor(message.toolCallId);
      pair.results++;
      pair.resultIndex = index;
    }
  });
  const paired = new Set<string>();
  for (const [id, pair] of pairs) {
    if (pair.calls === 1 && pair.results === 1 && pair.callIndex < pair.resultIndex) paired.add(id);
  }
  return paired;
}

function applyDecisions(messages: AgentMessage[], decisions: ReadonlyMap<string, Decision>): AgentMessage[] {
  if (decisions.size === 0) return messages;
  const paired = pairedIds(messages);
  const kept: AgentMessage[] = [];
  let changed = false;
  for (const message of messages) {
    if (message.role === 'assistant') {
      const shouldDrop = (block: typeof message.content[number]) =>
        block.type === 'toolCall' && paired.has(block.id) &&
        decisions.get(block.id)?.action === 'drop_call';
      if (message.content.some(shouldDrop)) {
        const content = message.content.filter((block) => !shouldDrop(block));
        changed = true;
        if (content.length > 0) {
          const projected = { ...message, content };
          // Native replay payloads still contain the removed calls. Let the
          // provider serialize the projected content instead; keep the raw
          // journal message and unchanged assistants' payloads intact.
          delete projected.providerPayload;
          kept.push(projected);
        }
        continue;
      }
    } else if (message.role === 'toolResult' && paired.has(message.toolCallId)) {
      const decision = decisions.get(message.toolCallId);
      if (decision?.action === 'drop_call') {
        changed = true;
        continue;
      }
      if (decision?.action === 'drop_result') {
        const original = textOf(message.content);
        const text = truncatedResultText(original, message.isError, decision.truncateHeadChars);
        if (text !== original) {
          let replaced = false;
          const content: typeof message.content = [];
          for (const block of message.content) {
            if (block.type !== 'text') content.push(block);
            else if (!replaced) {
              replaced = true;
              content.push({ ...block, text });
            }
          }
          kept.push({ ...message, content });
          changed = true;
          continue;
        }
      }
    }
    kept.push(message);
  }
  return changed ? kept : messages;
}

export function register(
  pi: ExtensionAPI,
  config: PiConfig,
  askerFactory: JevAskerFactory = defaultAsker,
): void {
  // Only in-flight ownership is cached. Choices are always read from getBranch.
  let epoch = 0;
  let activePass: symbol | undefined;
  const invalidatePass = () => { epoch++; activePass = undefined; };
  pi.on('session_start', invalidatePass);
  pi.on('session_switch', invalidatePass);
  pi.on('session_branch', invalidatePass);
  pi.on('session_tree', invalidatePass);
  pi.on('session_shutdown', invalidatePass);

  async function prune(
    messages: AgentMessage[],
    branch: SessionEntry[],
    decisions: ReadonlyMap<string, Decision>,
    ctx: ExtensionContext,
  ): Promise<string | undefined> {
    if (activePass) return undefined;
    const options = resolveOptions(config);
    const mapped = messages.map(toMessage);
    const calls = collectToolCalls(mapped, options.preserveRecentMessages);
    const paired = pairedIds(messages);
    const candidates = calls.filter((call) =>
      !call.pinned && !decisions.has(call.tool_use_id) && paired.has(call.tool_use_id),
    );
    if (candidates.length === 0) return undefined;
    const fitted = fitState(mapped, calls, options);
    const batches = batchCalls(candidates, fitted.tokens, options);
    const sessionId = ctx.sessionManager.getSessionId();
    const branchIds = branch.map((entry) => entry.id);
    const ownerEpoch = epoch;
    const pass = Symbol();
    activePass = pass;
    try {
      const asker = askerFactory(config);
      const answered = await Promise.all(batches.map((batch) => askBatch(asker, fitted.state, batch)));
      const currentBranch = ctx.sessionManager.getBranch();
      if (epoch !== ownerEpoch || activePass !== pass ||
          ctx.sessionManager.getSessionId() !== sessionId ||
          !branchIds.every((id, index) => currentBranch[index]?.id === id)) return undefined;
      const answers = new Map<string, CallAnswer>();
      for (const batch of answered) for (const [id, answer] of batch) answers.set(id, answer);
      const choices = candidates.map((call) => {
        const answer = answers.get(call.id);
        if (!answer) throw new Error(`Jev did not answer ${call.id}`);
        return { toolCallId: call.tool_use_id, action: decideCall(call, answer, options).action };
      });
      // One append after every batch succeeds: failures cannot mark partial work asked.
      pi.appendEntry<JournalData>(OMP_JEV_ENTRY_TYPE, {
        version: 1,
        truncateHeadChars: options.truncateHeadChars,
        decisions: choices,
      });
      let dropped = 0;
      let truncated = 0;
      for (const choice of choices) {
        if (choice.action === 'drop_call') dropped++;
        else if (choice.action === 'drop_result') truncated++;
      }
      return `${dropped} call(s) dropped, ${truncated} result(s) truncated in ${batches.length} request(s)`;
    } finally {
      if (activePass === pass) activePass = undefined;
    }
  }

  pi.registerCommand('jev-prune', {
    description: 'Ask Jev now; pruning applies before the next provider request',
    handler: async (_args, ctx) => {
      if (!config.apiKey) {
        ctx.ui.notify('fast-jev-compaction skipped (TYPESAFE_API_KEY is not set)', 'warning');
        return;
      }
      try {
        const branch = ctx.sessionManager.getBranch();
        const decisions = branchDecisions(branch);
        const messages = applyDecisions(pi.pi.buildSessionContext(branch).messages, decisions);
        const summary = await prune(messages, branch, decisions, ctx);
        ctx.ui.notify(
          `fast-jev-compaction: ${summary ? `${summary}; applies before the next provider request` : 'nothing to drop'}`,
          'info',
        );
      } catch (error) {
        ctx.ui.notify(`fast-jev-compaction skipped (${error instanceof Error ? error.message : String(error)})`, 'warning');
      }
    },
  });

  pi.on('context', async (event, ctx) => {
    const branch = ctx.sessionManager.getBranch();
    const decisions = branchDecisions(branch);
    const messages = applyDecisions(event.messages, decisions);
    const percent = ctx.getContextUsage()?.percent;
    if (typeof percent === 'number' && percent >= config.compactAtPercent) {
      if (!config.apiKey) {
        ctx.ui.notify('fast-jev-compaction skipped (TYPESAFE_API_KEY is not set)', 'warning');
      } else {
        try {
          const summary = await prune(messages, branch, decisions, ctx);
          if (summary) {
            ctx.ui.notify(`fast-jev-compaction: ${summary}`, 'info');
            return { messages: applyDecisions(event.messages, branchDecisions(ctx.sessionManager.getBranch())) };
          }
        } catch (error) {
          ctx.ui.notify(`fast-jev-compaction skipped (${error instanceof Error ? error.message : String(error)})`, 'warning');
        }
      }
    }
    return { messages };
  });
}

export default function (pi: ExtensionAPI): void {
  register(pi, resolvePiConfig());
}
