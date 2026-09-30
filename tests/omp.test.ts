import { describe, expect, it } from 'vitest';
import type { AgentMessage } from '@oh-my-pi/pi-agent-core';

import { register } from '../omp/extension.ts';
import type { PiConfig } from '../pi/extension.ts';
import type { JevAsker, JevQuestions, JevResponse } from '../src/types.js';

type Assistant = Extract<AgentMessage, { role: 'assistant' }>;
type ToolResult = Extract<AgentMessage, { role: 'toolResult' }>;
type BranchEntry = {
  id: string;
  parentId: string | null;
  timestamp: string;
} & (
  | { type: 'message'; message: AgentMessage }
  | { type: 'custom'; customType: string; data?: unknown }
);
type Handler = (event: unknown, ctx: unknown) => unknown;

const config: PiConfig = {
  apiKey: 'test-key',
  model: 'jev-test',
  compactAtPercent: 60,
  preserveRecentMessages: 0,
};

function user(text: string): Extract<AgentMessage, { role: 'user' }> {
  return { role: 'user', content: text, timestamp: 1 };
}

function assistant(text: string, ...ids: string[]): Assistant {
  return {
    role: 'assistant',
    content: [
      ...(text ? [{ type: 'text' as const, text, textSignature: 'signed-prose' }] : []),
      ...ids.map((id) => ({ type: 'toolCall' as const, id, name: 'read', arguments: { path: `${id}.ts` } })),
    ],
    api: 'openai-responses',
    provider: 'openai',
    model: 'test-model',
    responseId: 'response-1',
    usage: {
      input: 12,
      output: 3,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 15,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: ids.length ? 'toolUse' : 'stop',
    timestamp: 2,
  };
}

function result(id: string, text = 'tool output'): ToolResult {
  return {
    role: 'toolResult',
    toolCallId: id,
    toolName: 'read',
    content: [{ type: 'text', text }],
    isError: false,
    details: { path: `${id}.ts`, line: 17 },
    timestamp: 3,
  };
}

function branch(messages: AgentMessage[]): BranchEntry[] {
  return messages.map((message, index) => ({
    type: 'message',
    id: `message-${index}`,
    parentId: index === 0 ? null : `message-${index - 1}`,
    timestamp: '2026-01-01T00:00:00.000Z',
    message,
  }));
}

function answers(questions: JevQuestions, score: (name: string) => number) {
  return {
    answers: Object.fromEntries(
      Object.keys(questions).map((name) => [name, { type: 'noul' as const, noul: score(name) }]),
    ),
  };
}

function jev(score: (name: string) => number): JevAsker {
  return { async ask(_state, questions) { return answers(questions, score); } };
}

function harness(entries: BranchEntry[], asker: JevAsker, overrides: Partial<PiConfig> = {}) {
  const handlers = new Map<string, Handler>();
  const commands = new Map<string, (args: string, ctx: unknown) => unknown>();
  const notifications: { message: string; type?: string }[] = [];
  let currentBranch = entries;
  let currentSessionId = 'test-session';
  let nextEntryId = 0;
  const api = {
    pi: {
      buildSessionContext(branchEntries: BranchEntry[]) {
        return {
          messages: branchEntries.flatMap((entry) => entry.type === 'message' ? [entry.message] : []),
        };
      },
    },
    on(name: string, handler: Handler) {
      handlers.set(name, handler);
      return () => handlers.delete(name);
    },
    registerCommand(name: string, options: { handler: (args: string, ctx: unknown) => unknown }) {
      commands.set(name, options.handler);
    },
    appendEntry(customType: string, data?: unknown) {
      currentBranch.push({
        type: 'custom',
        customType,
        data: structuredClone(data),
        id: `custom-${nextEntryId++}`,
        parentId: currentBranch.at(-1)?.id ?? null,
        timestamp: '2026-01-01T00:00:01.000Z',
      });
    },
  } as unknown as Parameters<typeof register>[0];
  register(api, { ...config, ...overrides }, () => asker);

  // Deliberately expose only native omp context APIs, never Pi projections.
  const ctx = (percent: number) => ({
    sessionManager: {
      getBranch: () => currentBranch,
      getSessionId: () => currentSessionId,
    },
    getContextUsage: () => ({ tokens: percent, contextWindow: 100, percent }),
    ui: { notify: (message: string, type?: string) => notifications.push({ message, type }) },
  });
  return {
    notifications,
    entries: () => currentBranch,
    switchBranch(next: BranchEntry[], sessionId = currentSessionId) {
      currentBranch = next;
      currentSessionId = sessionId;
    },
    async fire(name: string, event: unknown, percent = 80) {
      return handlers.get(name)?.(event, ctx(percent));
    },
    async request(messages: AgentMessage[], percent = 80): Promise<AgentMessage[]> {
      const out = await handlers.get('context')?.({ type: 'context', messages }, ctx(percent)) as
        | { messages?: AgentMessage[] }
        | undefined;
      return out?.messages ?? messages;
    },
    async prune(percent = 5) {
      const command = commands.get('jev-prune');
      if (!command) throw new Error('/jev-prune is unavailable');
      return command('', ctx(percent));
    },
  };
}

function toolIds(messages: AgentMessage[]) {
  return messages.flatMap((message) => message.role === 'assistant'
    ? message.content.flatMap((block) => block.type === 'toolCall' ? [block.id] : [])
    : []);
}

function resultIds(messages: AgentMessage[]) {
  return messages.flatMap((message) => message.role === 'toolResult' ? [message.toolCallId] : []);
}

describe('omp context pruning', () => {
  it('drops calls and their results together without losing assistant prose, thinking, or metadata', async () => {
    const prompt = user('Fix the bug without editing generated files.');
    const mixed = assistant('The useful evidence is still needed.', 'discard', 'retain');
    const thinking = { type: 'thinking' as const, thinking: 'Compare the evidence.', thinkingSignature: 'signed-thinking' };
    mixed.content.unshift(thinking);
    const retainedResult = result('retain', 'Important evidence');
    const tail = assistant('I can now explain the fix.');
    const messages = [prompt, mixed, result('discard'), retainedResult, assistant('', 'empty'), result('empty'), tail];
    const original = structuredClone(messages);
    const h = harness(branch(messages), jev((name) => name.endsWith('_t2') ? 0.9 : 0.1));

    const out = await h.request(messages, 60);

    expect(out).toEqual([
      prompt,
      { ...mixed, content: [thinking, mixed.content[1], mixed.content[3]] },
      retainedResult,
      tail,
    ]);
    expect(toolIds(out)).toEqual(['retain']);
    expect(resultIds(out)).toEqual(['retain']);
    expect(out[0]).toBe(prompt);
    expect(out[2]).toBe(retainedResult);
    expect(out[3]).toBe(tail);
    expect(messages).toEqual(original);
    expect(h.entries().filter((entry) => entry.type === 'message').map((entry) => entry.message)).toEqual(original);
  });

  it('truncates only result text while retaining image blocks and result metadata', async () => {
    const call = assistant('Keep the call and the screenshot.', 'image-read');
    const image = { type: 'image' as const, mimeType: 'image/png', data: 'aW1hZ2U=' };
    const image2 = { type: 'image' as const, mimeType: 'image/jpeg', data: 'bW9yZQ==' };
    const output = result('image-read');
    output.content = [
      { type: 'text', text: `HEADER12${'obsolete line\n'.repeat(80)}` },
      image,
      { type: 'text', text: 'additional obsolete output\n'.repeat(80) },
      image2,
    ];
    output.isError = true;
    const messages = [user('Diagnose this screenshot.'), call, output];
    const original = structuredClone(output);
    const h = harness(branch(messages), jev((name) => name.startsWith('call_') ? 0.9 : 0.1), {
      truncateHeadChars: 8,
    });

    const out = await h.request(messages);
    const truncated = out.find((message): message is ToolResult => message.role === 'toolResult')!;
    const text = truncated.content.flatMap((block) => block.type === 'text' ? [block.text] : []).join('\n');

    expect(toolIds(out)).toEqual(['image-read']);
    expect(resultIds(out)).toEqual(['image-read']);
    expect(out[1]).toBe(call);
    expect(truncated).toEqual({ ...output, content: expect.any(Array) });
    expect(truncated.content.filter((block) => block.type === 'image')).toEqual([image, image2]);
    expect(truncated.content.find((block) => block.type === 'image')).toBe(image);
    expect(text).toMatch(/^HEADER12\n\[fast-jev-compaction truncated /);
    expect(text).toContain('(error)');
    expect(text).not.toContain('obsolete');
    expect(output).toEqual(original);
  });

  it('pins the first call and any call whose paired result is recent, leaving unpaired calls intact', async () => {
    const first = assistant('', 'first');
    const firstResult = result('first');
    const older = assistant('', 'older');
    const olderResult = result('older');
    const recent = assistant('', 'recent');
    const recentResult = result('recent');
    const pending = assistant('Waiting on a tool.', 'pending');
    const messages = [first, firstResult, older, olderResult, recent, user('Keep working.'), recentResult, pending];
    const h = harness(branch(messages), jev(() => 0.1), { preserveRecentMessages: 2 });

    const out = await h.request(messages);

    expect(out).toEqual([first, firstResult, recent, messages[5], recentResult, pending]);
    expect(toolIds(out)).toEqual(['first', 'recent', 'pending']);
    expect(resultIds(out)).toEqual(['first', 'recent']);
  });

  it('restores drop decisions from the current branch after reload without scoring them again', async () => {
    const messages = [user('Read the file.'), assistant('Finished reading.', 'old'), result('old')];
    let requests = 0;
    const first = harness(branch(messages), {
      async ask(_state, questions) {
        requests += 1;
        return answers(questions, () => 0.1);
      },
    });
    const pruned = await first.request(messages);
    expect(toolIds(pruned)).toEqual([]);
    expect(resultIds(pruned)).toEqual([]);
    expect(pruned).toContainEqual({
      ...messages[1],
      content: [{ type: 'text', text: 'Finished reading.', textSignature: 'signed-prose' }],
    });
    expect(requests).toBe(1);
    const savedBranch = structuredClone(first.entries());
    const resumed = harness(savedBranch, {
      async ask() {
        requests += 1;
        throw new Error('A restored call must not be scored again');
      },
    });
    await resumed.fire('session_start', { type: 'session_start' });

    const belowThreshold = await resumed.request(messages, 5);
    const aboveThreshold = await resumed.request(messages, 80);

    expect(toolIds(belowThreshold)).toEqual([]);
    expect(resultIds(belowThreshold)).toEqual([]);
    expect(aboveThreshold).toEqual(belowThreshold);
    expect(requests).toBe(1);
    expect(resumed.notifications.filter((notice) => notice.type === 'warning')).toEqual([]);
  });

  it('identifies persisted choices by tool call ID when the next projection renumbers candidates', async () => {
    const prompt = user('Read files.');
    const oldMessages = [prompt, assistant('', 'old'), result('old')];
    let requests = 0;
    const h = harness(branch(oldMessages), {
      async ask(_state, questions) {
        requests += 1;
        return answers(questions, () => requests === 1 ? 0.1 : 0.9);
      },
    });
    expect(await h.request(oldMessages)).toEqual([prompt]);
    const newCall = assistant('', 'new');
    const newResult = result('new');
    const lastId = h.entries().at(-1)!.id;
    h.entries().push(
      { type: 'message', id: 'new-call', parentId: lastId, timestamp: 't', message: newCall },
      { type: 'message', id: 'new-result', parentId: 'new-call', timestamp: 't', message: newResult },
    );

    const out = await h.request([prompt, newCall, newResult]);

    expect(out).toEqual([prompt, newCall, newResult]);
    expect(toolIds(out)).toEqual(['new']);
    expect(resultIds(out)).toEqual(['new']);
    expect(requests).toBe(2);
  });

  it.each([
    { name: 'session resume', event: { type: 'session_switch', reason: 'resume', previousSessionFile: 'old.jsonl' } },
    { name: 'session fork', event: { type: 'session_switch', reason: 'fork', previousSessionFile: 'old.jsonl' } },
    { name: 'tree navigation', event: { type: 'session_tree', newLeafId: 'message-2', oldLeafId: 'custom-0' } },
  ])('does not inherit sibling decisions after $name', async ({ event }) => {
    const messages = [user('Inspect the shared file.'), assistant('', 'shared'), result('shared')];
    const siblingBranch = branch(messages);
    let requests = 0;
    const h = harness(branch(messages), {
      async ask(_state, questions) {
        requests += 1;
        return answers(questions, () => requests === 1 ? 0.1 : 0.9);
      },
    });
    expect(await h.request(messages)).toEqual([messages[0]]);
    const prunedBranch = h.entries();
    h.switchBranch(siblingBranch);
    await h.fire(event.type, event);

    expect(await h.request(messages, 5)).toEqual(messages);
    expect(await h.request(messages, 80)).toEqual(messages);
    expect(requests).toBe(2);

    h.switchBranch(prunedBranch);
    await h.fire('session_tree', { type: 'session_tree', newLeafId: prunedBranch.at(-1)!.id, oldLeafId: siblingBranch.at(-1)!.id });
    expect(await h.request(messages, 5)).toEqual([messages[0]]);
    expect(requests).toBe(2);
  });

  it('commits no partial batch choices and leaves context intact if a later request fails', async () => {
    const prompt = user('Inspect all files.');
    const messages: AgentMessage[] = [prompt];
    for (let index = 0; index < 20; index += 1) {
      messages.push(assistant('', `batch-${index}`), result(`batch-${index}`, 'row'));
    }
    const original = structuredClone(messages);
    let requests = 0;
    let fail = true;
    const scoredAfterFailure: string[] = [];
    const h = harness(branch(messages), {
      async ask(_state, questions) {
        requests += 1;
        if (fail && requests === 2) throw new Error('second batch failed');
        if (!fail) scoredAfterFailure.push(...Object.keys(questions));
        return answers(questions, () => 0.1);
      },
    }, { maxStateTokens: 1_000, maxRequestTokens: 1_500 });

    expect(await h.request(messages)).toEqual(original);
    expect(h.entries().filter((entry) => entry.type === 'custom')).toEqual([]);
    expect(await h.request(messages, 5)).toEqual(original);
    expect(h.notifications.some((notice) => notice.type === 'warning')).toBe(true);
    expect(messages).toEqual(original);

    fail = false;
    expect(await h.request(messages)).toEqual([prompt]);
    expect(new Set(scoredAfterFailure).size).toBe(40);
    expect(scoredAfterFailure).toHaveLength(40);
  });

  it('scores manual pruning immediately and applies it to the next context even below the threshold', async () => {
    const prompt = user('Read a file.');
    const call = assistant('I have checked it.', 'manual');
    const output = result('manual');
    const messages = [prompt, call, output];
    let requests = 0;
    const h = harness(branch(messages), {
      async ask(_state, questions) {
        requests += 1;
        return answers(questions, () => 0.1);
      },
    });
    expect(await h.request(messages, 5)).toEqual(messages);
    expect(requests).toBe(0);

    await h.prune();
    expect(requests).toBe(1);
    expect(h.entries().filter((entry) => entry.type === 'message').map((entry) => entry.message)).toEqual(messages);
    const out = await h.request(messages, 5);

    expect(out).toEqual([prompt, { ...call, content: [call.content[0]] }]);
    expect(toolIds(out)).toEqual([]);
    expect(resultIds(out)).toEqual([]);
    await h.prune();
    expect(requests).toBe(1);
  });

  it('does not journal delayed Jev choices into a different session after a switch', async () => {
    const oldMessages = [user('Inspect the old session.'), assistant('', 'slow'), result('slow')];
    const newMessages = [user('Inspect the new session.'), assistant('', 'slow'), result('slow')];
    const oldBranch = branch(oldMessages);
    const newBranch = branch(newMessages);
    const started = Promise.withResolvers<void>();
    const response = Promise.withResolvers<JevResponse>();
    let pendingQuestions!: JevQuestions;
    const h = harness(oldBranch, {
      async ask(_state, questions) {
        pendingQuestions = questions;
        started.resolve();
        return response.promise;
      },
    });
    const pending = h.request(oldMessages);
    await started.promise;
    h.switchBranch(newBranch, 'different-session');
    await h.fire('session_switch', {
      type: 'session_switch',
      reason: 'new',
      previousSessionFile: 'old.jsonl',
    });
    response.resolve(answers(pendingQuestions, () => 0.1));

    expect(await pending).toEqual(oldMessages);
    expect(h.entries().filter((entry) => entry.type === 'custom')).toEqual([]);
    expect(await h.request(newMessages, 5)).toEqual(newMessages);
    expect(oldBranch.filter((entry) => entry.type === 'custom')).toEqual([]);
  });

  it('leaves context and the raw journal intact when the API key is missing', async () => {
    const messages = [user('Read a file.'), assistant('', 'no-key'), result('no-key')];
    const h = harness(branch(messages), jev(() => 0.1), { apiKey: undefined });

    expect(await h.request(messages)).toEqual(messages);
    expect(h.entries().filter((entry) => entry.type === 'custom')).toEqual([]);
    expect(h.notifications.some((notice) => notice.type === 'warning')).toBe(true);
  });

  it('persists keep choices so later requests and resumed sessions never rescore retained calls', async () => {
    const messages = [user('Keep this evidence.'), assistant('', 'kept'), result('kept')];
    let requests = 0;
    const asker: JevAsker = {
      async ask(_state, questions) {
        requests += 1;
        return answers(questions, () => requests === 1 ? 0.9 : 0.1);
      },
    };
    const h = harness(branch(messages), asker);
    expect(await h.request(messages)).toEqual(messages);
    expect(await h.request(messages)).toEqual(messages);
    const resumed = harness(structuredClone(h.entries()), asker);
    await resumed.fire('session_switch', { type: 'session_switch', reason: 'resume', previousSessionFile: undefined });

    expect(await resumed.request(messages)).toEqual(messages);
    expect(requests).toBe(1);
  });
});
