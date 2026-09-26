import { describe, expect, it } from 'vitest';
import type { ExtensionAPI, ProjectedSessionEntry } from '@earendil-works/pi-coding-agent';

import {
  decisionsToDrafts,
  pruneEntries,
  resolvePiConfig,
  summarizePrune,
  toMapping,
  toMessage,
  register,
  type PiConfig,
} from '../pi/extension.ts';
import { collectToolCalls, resolveOptions, truncatedResultText } from '../src/index.js';
import type { JevAsker, JevQuestions } from '../src/types.js';

const fileA = 'export const a = 1;\n'.repeat(50);
const failText = 'FAIL b.test.ts: expected 2 to be 3\n'.repeat(40);

function entry(id: string, ...messages: unknown[]): ProjectedSessionEntry {
  return {
    sourceEntry: { type: 'message', id, parentId: null, timestamp: 't' },
    messages: messages as ProjectedSessionEntry['messages'],
  };
}

function user(text: string) {
  return { role: 'user', content: text, timestamp: 0 };
}

function assistant(text: string, ...calls: { id: string; name: string; args?: Record<string, unknown> }[]) {
  return {
    role: 'assistant',
    content: [
      ...(text ? [{ type: 'text', text }] : []),
      ...calls.map((call) => ({
        type: 'toolCall',
        id: call.id,
        name: call.name,
        arguments: call.args ?? {},
      })),
    ],
    timestamp: 0,
  };
}

function result(id: string, text: string, isError = false) {
  return {
    role: 'toolResult',
    toolCallId: id,
    toolName: 'read',
    content: [{ type: 'text', text }],
    isError,
    timestamp: 0,
  };
}

function projection(): ProjectedSessionEntry[] {
  return [
    entry('e1', user('Fix the failing test. Never edit src/generated.')),
    entry('e2', assistant('', { id: 'tool-1', name: 'read', args: { file_path: 'src/a.ts' } })),
    entry('e3', result('tool-1', fileA)),
    entry('e4', assistant('Looking at the failure.', { id: 'tool-2', name: 'bash', args: { command: 'npm test' } })),
    entry('e5', result('tool-2', failText, true)),
  ];
}

/** Answers `call_*` and `result_*` questions from one probability function. */
function jevAsker(answer: (name: string) => number): JevAsker {
  return {
    async ask(_state, questions: JevQuestions) {
      return {
        answers: Object.fromEntries(
          Object.keys(questions).map((key) => [key, { type: 'noul', noul: answer(key) }]),
        ),
      };
    },
  };
}

const config: PiConfig = {
  apiKey: 'k',
  model: 'jev-x',
  compactAtPercent: 60,
  preserveRecentMessages: 0,
};

describe('pi message mapping', () => {
  it('flattens the projection into the library transcript with entry ids', () => {
    const mapping = toMapping(projection());
    expect(mapping.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant', 'user']);
    expect(mapping.entryIds).toEqual(['e1', 'e2', 'e3', 'e4', 'e5']);
    expect(mapping.messages[1]?.toolUses).toEqual([
      { tool_use_id: 'tool-1', tool: 'read', input: { file_path: 'src/a.ts' } },
    ]);
    expect(mapping.messages[2]?.toolResults).toEqual([
      { tool_use_id: 'tool-1', text: fileA, isError: false },
    ]);
    expect(mapping.byEntryId.get('e5')).toMatchObject({ role: 'toolResult' });
  });

  it('keeps text messages and drops system messages from the candidate transcript', () => {
    expect(toMessage({ role: 'system', content: 'prompt', timestamp: 0 })).toBeUndefined();
    expect(toMessage(user('hello'))).toEqual({ role: 'user', text: 'hello', toolUses: [] });
    expect(
      toMessage({
        role: 'compactionSummary',
        summary: 'earlier work',
        tokensBefore: 1,
        timestamp: 0,
      }),
    ).toEqual({ role: 'user', text: 'earlier work', toolUses: [] });
  });
});

describe('decisions to context edits', () => {
  it('removes a dropped call from its assistant message and omits its result', () => {
    const mapping = toMapping(projection());
    const calls = collectToolCalls(mapping.messages, 0);
    const decisions = [
      { id: 't1', tool: 'read', keepCall: 0.1, keepResult: 0.1, action: 'drop_call' as const, reason: 'call_dropped' as const },
      { id: 't2', tool: 'bash', keepCall: 0.9, keepResult: 0.1, action: 'drop_result' as const, reason: 'result_dropped' as const },
    ];
    const drafts = decisionsToDrafts(mapping, calls, decisions, 300);
    expect(drafts).toHaveLength(3);
    expect(drafts).toContainEqual({ type: 'context_edit', targetId: 'e3', replacement: null });
    expect(drafts).toContainEqual({ type: 'context_edit', targetId: 'e2', replacement: null });
    const truncated = drafts.find((d) => d.targetId === 'e5');
    expect(truncated?.replacement).toEqual({
      content: truncatedResultText(failText, true, 300),
    });
  });

  it('keeps the assistant text when only the call block is dropped', () => {
    const mapping = toMapping([
      entry('a', assistant('Checking now.', { id: 'tool-1', name: 'read' })),
      entry('b', result('tool-1', fileA)),
      entry('c', user('thanks')),
    ]);
    const calls = collectToolCalls(mapping.messages, 0);
    const decisions = [
      { id: 't1', tool: 'read', keepCall: 0.1, keepResult: 0.1, action: 'drop_call' as const, reason: 'call_dropped' as const },
    ];
    const drafts = decisionsToDrafts(mapping, calls, decisions, 300);
    const rebuilt = drafts.find((d) => d.targetId === 'a');
    expect(rebuilt?.replacement).toEqual({ content: [{ type: 'text', text: 'Checking now.' }] });
  });

  it('collapses several dropped calls in one assistant message into one replacement', () => {
    const mapping = toMapping([
      entry(
        'a',
        assistant('', { id: 'tool-1', name: 'read' }, { id: 'tool-2', name: 'bash' }),
      ),
      entry('b', result('tool-1', fileA)),
      entry('c', result('tool-2', failText)),
      entry('d', user('go on')),
    ]);
    const calls = collectToolCalls(mapping.messages, 0);
    const decisions = calls.map((call) => ({
      id: call.id,
      tool: call.tool,
      keepCall: 0.1,
      keepResult: 0.1,
      action: 'drop_call' as const,
      reason: 'call_dropped' as const,
    }));
    const drafts = decisionsToDrafts(mapping, calls, decisions, 300);
    expect(drafts.filter((d) => d.targetId === 'a')).toEqual([
      { type: 'context_edit', targetId: 'a', replacement: null },
    ]);
    expect(drafts.filter((d) => d.targetId === 'b' || d.targetId === 'c')).toHaveLength(2);
  });
});

describe('pruneEntries', () => {
  it('asks Jev, returns edits, and remembers the calls it asked about', async () => {
    const asked = new Set<string>();
    const first = await pruneEntries(
      projection(),
      config,
      jevAsker((name) => (name.endsWith('_t1') ? 0.1 : name === 'call_t2' ? 0.9 : 0.1)),
      asked,
    );
    expect(first?.requests).toBe(1);
    expect(first?.decisions.map((d) => d.action)).toEqual(['drop_call', 'drop_result']);
    expect(first?.drafts.map((d) => d.targetId).sort()).toEqual(['e2', 'e3', 'e5']);
    expect(first?.reductionRatio).toBeGreaterThan(0.8);
    expect(summarizePrune(first!)).toBe(
      `1 call(s) dropped, 1 result(s) truncated; tool output down ${Math.round(
        first!.reductionRatio * 100,
      )}% in 1 request(s)`,
    );
    expect(asked).toEqual(new Set(['tool-1', 'tool-2']));

    const second = await pruneEntries(projection(), config, jevAsker(() => 0.1), asked);
    expect(second).toBeUndefined();
  });

  it('never touches a pinned call', async () => {
    const asked = new Set<string>();
    const pruned = await pruneEntries(
      projection(),
      { ...config, preserveRecentMessages: 6 },
      jevAsker(() => 0.1),
      asked,
    );
    expect(pruned).toBeUndefined();
  });
});

type Notify = { message: string; type?: string };

function fakePi() {
  const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  const commands = new Map<string, (args: string, ctx: unknown) => unknown>();
  const api = {
    on(event: string, handler: (event: unknown, ctx: unknown) => unknown) {
      handlers.set(event, handler);
      return () => handlers.delete(event);
    },
    registerCommand(name: string, options: { handler: (args: string, ctx: unknown) => unknown }) {
      commands.set(name, options.handler);
    },
  } as unknown as ExtensionAPI;
  return {
    api,
    fire: async (event: string, payload: unknown, ctx: unknown) =>
      handlers.get(event)?.(payload, ctx),
    run: async (name: string, args: string, ctx: unknown) => commands.get(name)?.(args, ctx),
    has: (event: string) => handlers.has(event),
    hasCommand: (name: string) => commands.has(name),
  };
}

function fakeCtx(percent: number, notify: Notify[], entries: ProjectedSessionEntry[] = []) {
  return {
    hasUI: true,
    mode: 'tui' as const,
    cwd: '/tmp',
    ui: { notify: (message: string, type?: string) => notify.push({ message, type }), setStatus() {} },
    sessionManager: {
      buildSessionProjection: () => ({ entries, messages: [] }),
    },
    getContextUsage: () => ({ tokens: 1, contextWindow: 1, percent }),
  };
}

function turnEndEvent(entries: ProjectedSessionEntry[]) {
  return {
    type: 'turn_end',
    turnIndex: 1,
    message: { role: 'assistant', content: [], timestamp: 0 },
    toolResults: [],
    messageEntryId: 'e4',
    toolResultEntryIds: ['e5'],
    entries: [],
    continue: false,
    outcome: 'completed' as const,
    context: {
      contextEntries: entries,
      contextMessages: [],
      llmMessages: [],
      pendingMessages: [],
      canContinue: true,
    },
  };
}

describe('turn_end handler', () => {
  it('does nothing below the compaction percentage', async () => {
    const notify: Notify[] = [];
    const harness = fakePi();
    register(harness.api, config, () => jevAsker(() => 0.1));
    const out = await harness.fire('turn_end', turnEndEvent(projection()), fakeCtx(10, notify));
    expect(out).toBeUndefined();
    expect(notify).toEqual([]);
  });

  it('returns context edits and notifies once the context is large enough', async () => {
    const notify: Notify[] = [];
    const harness = fakePi();
    register(harness.api, config, () => jevAsker((name) => (name.endsWith('_t1') ? 0.1 : 0.9)));
    const out = await harness.fire('turn_end', turnEndEvent(projection()), fakeCtx(80, notify)) as {
      entries?: unknown[];
    };
    expect(out?.entries).toHaveLength(2);
    expect(notify).toHaveLength(1);
    expect(notify[0]?.type).toBe('info');
    expect(notify[0]?.message).toMatch(
      /^fast-jev-compaction: 1 call\(s\) dropped; tool output down \d+% in 1 request\(s\)$/,
    );
  });

  it('warns and leaves Pi its own compaction when Jev fails', async () => {
    const notify: Notify[] = [];
    const harness = fakePi();
    register(harness.api, config, () => ({
      async ask() {
        throw new Error('Jev request failed (500)');
      },
    }));
    const out = await harness.fire('turn_end', turnEndEvent(projection()), fakeCtx(80, notify));
    expect(out).toBeUndefined();
    expect(notify).toEqual([
      { message: 'fast-jev-compaction skipped (Jev request failed (500))', type: 'warning' },
    ]);
  });

  it('warns when the key is missing', async () => {
    const notify: Notify[] = [];
    const harness = fakePi();
    register(harness.api, { ...config, apiKey: undefined });
    await harness.fire('turn_end', turnEndEvent(projection()), fakeCtx(80, notify));
    expect(notify[0]?.message).toMatch(/TYPESAFE_API_KEY is not set/);
  });
});

describe('manual /compact interception', () => {
  function compactEvent(reason: 'manual' | 'threshold' | 'overflow') {
    return { type: 'session_before_compact', preparation: {}, branchEntries: [], reason, willRetry: false };
  }

  it('cancels a manual compaction when there is nothing left to drop', async () => {
    const notify: Notify[] = [];
    const harness = fakePi();
    register(harness.api, config, () => jevAsker(() => 0.1));
    const out = (await harness.fire(
      'session_before_compact',
      compactEvent('manual'),
      fakeCtx(10, notify, [entry('e1', user('no tools here')), entry('e2', assistant('just text'))]),
    )) as { cancel?: boolean } | undefined;
    expect(out).toEqual({ cancel: true });
    expect(notify).toEqual([
      { message: 'fast-jev-compaction: nothing left to drop, keeping history verbatim', type: 'info' },
    ]);
  });

  it('falls back to Pi summary when Jev still has drops to apply', async () => {
    const notify: Notify[] = [];
    const harness = fakePi();
    register(harness.api, config, () => jevAsker(() => 0.1));
    const out = (await harness.fire(
      'session_before_compact',
      compactEvent('manual'),
      fakeCtx(10, notify, projection()),
    )) as { cancel?: boolean } | undefined;
    expect(out).toBeUndefined();
    expect(notify[0]?.type).toBe('warning');
    expect(notify[0]?.message).toMatch(/edits need a turn boundary; using Pi's summary$/);
  });

  it('never cancels a threshold or overflow compaction', async () => {
    const notify: Notify[] = [];
    const harness = fakePi();
    register(harness.api, config, () => jevAsker(() => 0.1));
    for (const reason of ['threshold', 'overflow'] as const) {
      const out = await harness.fire(
        'session_before_compact',
        compactEvent(reason),
        fakeCtx(99, notify, projection()),
      );
      expect(out).toBeUndefined();
    }
    expect(notify).toEqual([]);
  });
});

describe('/jev-prune command', () => {
  it('queues the edits and applies them at the next turn end, even below the threshold', async () => {
    const notify: Notify[] = [];
    const harness = fakePi();
    register(harness.api, config, () => jevAsker(() => 0.1));
    expect(harness.hasCommand('jev-prune')).toBe(true);

    await harness.run('jev-prune', '', fakeCtx(5, notify, projection()));
    expect(notify).toEqual([
      {
        message: expect.stringMatching(/applies at the end of your next turn$/),
        type: 'info',
      },
    ]);

    const out = (await harness.fire(
      'turn_end',
      turnEndEvent(projection()),
      fakeCtx(5, notify),
    )) as { entries?: unknown[] } | undefined;
    expect(out?.entries).toHaveLength(4);
    expect(notify[1]?.type).toBe('info');
  });

  it('reports nothing to drop and queues nothing', async () => {
    const notify: Notify[] = [];
    const harness = fakePi();
    register(harness.api, config, () => jevAsker(() => 0.1));
    await harness.run(
      'jev-prune',
      '',
      fakeCtx(5, notify, [entry('e1', user('no tools')), entry('e2', assistant('just text'))]),
    );
    expect(notify).toEqual([{ message: 'fast-jev-compaction: nothing to drop', type: 'info' }]);
    const out = await harness.fire('turn_end', turnEndEvent(projection()), fakeCtx(5, notify));
    expect(out).toBeUndefined();
  });

  it('says a queued prune is already waiting instead of asking twice', async () => {
    const notify: Notify[] = [];
    const harness = fakePi();
    register(harness.api, config, () => jevAsker(() => 0.1));
    const ctx = fakeCtx(5, notify, projection());
    await harness.run('jev-prune', '', ctx);
    await harness.run('jev-prune', '', ctx);
    expect(notify[1]?.message).toMatch(/already queued for your next turn$/);
  });

  it('warns when the key is missing', async () => {
    const notify: Notify[] = [];
    const harness = fakePi();
    register(harness.api, { ...config, apiKey: undefined });
    await harness.run('jev-prune', '', fakeCtx(5, notify, projection()));
    expect(notify[0]?.message).toMatch(/TYPESAFE_API_KEY is not set/);
  });
});

describe('pi config', () => {
  it('reads the key, model and overrides from the environment', () => {
    expect(resolvePiConfig({})).toEqual({ model: 'jev-latest', compactAtPercent: 60 });
    expect(
      resolvePiConfig({
        TYPESAFE_API_KEY: 'k',
        FAST_JEV_MODEL: 'jev-x',
        FAST_JEV_BASE_URL: 'http://localhost:1',
        FAST_JEV_COMPACT_AT_PERCENT: '45',
        FAST_JEV_KEEP_THRESHOLD: '0.3',
        FAST_JEV_PRESERVE_RECENT_MESSAGES: '2',
        FAST_JEV_TRUNCATE_HEAD_CHARS: '0',
      }),
    ).toEqual({
      apiKey: 'k',
      model: 'jev-x',
      baseUrl: 'http://localhost:1',
      compactAtPercent: 45,
      keepThreshold: 0.3,
      preserveRecentMessages: 2,
      truncateHeadChars: 0,
    });
  });

  it('falls back to library defaults for the options it does not set', () => {
    expect(resolveOptions(resolvePiConfig({}))).toMatchObject({
      keepThreshold: 0.5,
      preserveRecentMessages: 6,
      truncateHeadChars: 300,
    });
  });
});
