/**
 * Minimal type references for the native omp adapter, verified against 18.4.4.
 *
 * Sources: pi-coding-agent/src/extensibility/{extensions/types,shared-events}.ts,
 * session/{session-entries,session-manager,session-context}.ts, pi-ai/src/types.ts,
 * pi-agent-core/src/{types,compaction/messages}.ts and pi-tui/src/chat/messages.ts.
 * Only fields used by omp/extension.ts are declared, as in types/pi.d.ts.
 */
declare module '@oh-my-pi/pi-ai' {
  export interface TextContent {
    type: 'text';
    text: string;
    textSignature?: string;
  }

  export interface ImageContent {
    type: 'image';
    data: string;
    mimeType: string;
  }

  export interface ThinkingContent {
    type: 'thinking';
    thinking: string;
    thinkingSignature?: string;
    itemId?: string;
  }

  export interface ToolCall {
    type: 'toolCall';
    id: string;
    name: string;
    arguments: Record<string, unknown>;
    thoughtSignature?: string;
    intent?: string;
    rawBlock?: string;
  }

  export interface AssistantMessage {
    role: 'assistant';
    content: (
      | TextContent
      | ThinkingContent
      | ToolCall
      | ImageContent
      | { type: 'redactedThinking'; data: string }
      | { type: 'fallback'; from: { model: string }; to: { model: string } }
      | { type: 'anthropicServerTool'; block: unknown }
    )[];
    timestamp: number;
    [key: string]: unknown;
  }

  export interface ToolResultMessage {
    role: 'toolResult';
    toolCallId: string;
    toolName: string;
    content: (TextContent | ImageContent)[];
    details?: unknown;
    isError: boolean;
    timestamp: number;
    [key: string]: unknown;
  }

  export interface UserMessage {
    role: 'user';
    content: string | (TextContent | ImageContent)[];
    timestamp: number;
  }

  export interface DeveloperMessage {
    role: 'developer';
    content: string | (TextContent | ImageContent)[];
    timestamp: number;
  }
}

declare module '@oh-my-pi/pi-agent-core' {
  import type {
    AssistantMessage,
    DeveloperMessage,
    ImageContent,
    TextContent,
    ToolResultMessage,
    UserMessage,
  } from '@oh-my-pi/pi-ai';

  export type AgentMessage =
    | UserMessage
    | DeveloperMessage
    | AssistantMessage
    | ToolResultMessage
    | {
        role: 'custom' | 'hookMessage';
        customType: string;
        content: string | (TextContent | ImageContent)[];
        display: boolean;
        details?: unknown;
        timestamp: number;
      }
    | {
        role: 'bashExecution' | 'pythonExecution';
        output: string;
        timestamp: number;
      }
    | {
        role: 'branchSummary' | 'compactionSummary';
        summary: string;
        timestamp: number;
      }
    | {
        role: 'fileMention';
        files: { path: string; content: string }[];
        timestamp: number;
      };
}

declare module '@oh-my-pi/pi-coding-agent' {
  import type { AgentMessage } from '@oh-my-pi/pi-agent-core';

  export interface SessionEntry {
    type: string;
    id: string;
    parentId: string | null;
    timestamp: string;
    message?: AgentMessage;
    customType?: string;
    data?: unknown;
    [key: string]: unknown;
  }

  export function buildSessionContext(entries: SessionEntry[]): { messages: AgentMessage[] };

  export interface ContextUsage {
    tokens: number | null;
    contextWindow: number;
    percent: number | null;
  }

  export interface ExtensionContext {
    sessionManager: {
      getBranch(fromId?: string): SessionEntry[];
      getSessionId(): string;
    };
    getContextUsage(): ContextUsage | undefined;
    ui: {
      notify(message: string, type?: 'info' | 'warning' | 'error'): void;
    };
  }

  export interface ExtensionCommandContext extends ExtensionContext {}

  export interface RegisteredCommand {
    description?: string;
    handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> | void;
  }

  export interface ContextEvent {
    type: 'context';
    messages: AgentMessage[];
  }

  export interface ContextEventResult {
    messages?: AgentMessage[];
  }

  type SessionLifecycleEvent = {
    type: 'session_start' | 'session_switch' | 'session_branch' | 'session_tree' | 'session_shutdown';
  };

  export interface ExtensionAPI {
    pi: { buildSessionContext: typeof buildSessionContext };
    on(
      event: SessionLifecycleEvent['type'],
      handler: (event: SessionLifecycleEvent, ctx: ExtensionContext) => Promise<void> | void,
    ): void;
    on(
      event: 'context',
      handler: (event: ContextEvent, ctx: ExtensionContext) =>
        Promise<ContextEventResult | void> | ContextEventResult | void,
    ): void;
    registerCommand(name: string, command: RegisteredCommand): void;
    appendEntry<T = unknown>(customType: string, data?: T): void;
  }
}
