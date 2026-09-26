/**
 * Minimal type reference for the Pi extension surface this adapter uses.
 *
 * The full declarations live in `@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts`
 * and `.../session-manager.d.ts`; only the shapes `pi/extension.ts` touches are
 * declared here so the adapter typechecks without depending on Pi. Regenerate
 * and review after a Pi upgrade, like `types/claude-code.d.ts`.
 *
 * Verified against pi-coding-agent 0.52.x.
 */
declare module '@earendil-works/pi-coding-agent' {
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
    redacted?: boolean;
  }

  export interface ToolCall {
    type: 'toolCall';
    id: string;
    name: string;
    arguments: Record<string, any>;
    thoughtSignature?: string;
    namespace?: string;
  }

  export interface SystemMessage {
    role: 'system';
    content: string | TextContent[];
    timestamp: number;
  }

  export interface UserMessage {
    role: 'user';
    content: string | (TextContent | ImageContent)[];
    timestamp: number;
  }

  export interface AssistantMessage {
    role: 'assistant';
    content: (TextContent | ThinkingContent | ToolCall)[];
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
  }

  export interface CustomMessage {
    role: 'custom';
    customType: string;
    content: string | (TextContent | ImageContent)[];
    display: boolean;
    details?: unknown;
    timestamp: number;
  }

  export interface BashExecutionMessage {
    role: 'bashExecution';
    command: string;
    output: string;
    exitCode: number | undefined;
    cancelled: boolean;
    truncated: boolean;
    fullOutputPath?: string;
    excludeFromContext?: boolean;
    timestamp: number;
  }

  export interface BranchSummaryMessage {
    role: 'branchSummary';
    summary: string;
    fromId: string | null;
    timestamp: number;
  }

  export interface CompactionSummaryMessage {
    role: 'compactionSummary';
    summary: string;
    tokensBefore: number;
    timestamp: number;
  }

  export type AgentMessage =
    | SystemMessage
    | UserMessage
    | AssistantMessage
    | ToolResultMessage
    | CustomMessage
    | BashExecutionMessage
    | BranchSummaryMessage
    | CompactionSummaryMessage;

  /** Content an append-only context edit may replace. */
  export type ContextEditableContent =
    | UserMessage['content']
    | AssistantMessage['content']
    | ToolResultMessage['content']
    | CustomMessage['content'];

  export interface SessionEntry {
    type: string;
    id: string;
    parentId: string | null;
    timestamp: string;
    message?: AgentMessage;
    targetId?: string;
    replacement?: { content: ContextEditableContent } | null;
    [key: string]: unknown;
  }

  /** A session entry with the messages it contributes to model context. */
  export interface ProjectedSessionEntry {
    sourceEntry: SessionEntry;
    messages: AgentMessage[];
  }

  export interface ContextEditEntryDraft {
    type: 'context_edit';
    targetId: string;
    replacement: { content: ContextEditableContent } | null;
  }

  export interface CustomEntryDraft {
    type: 'custom';
    customType: string;
    data?: unknown;
  }

  export interface CustomMessageEntryDraft {
    type: 'custom_message';
    customType: string;
    content: string | (TextContent | ImageContent)[];
    display: boolean;
    details?: unknown;
  }

  export interface CompactionEntryDraft {
    type: 'compaction';
    summary: string;
    firstKeptEntryId: string | null;
    details?: unknown;
  }

  export type SessionBoundaryDraft =
    | CustomEntryDraft
    | CustomMessageEntryDraft
    | ContextEditEntryDraft
    | CompactionEntryDraft;

  export interface ContextUsage {
    tokens: number | null;
    contextWindow: number;
    percent: number | null;
  }

  export interface BoundaryContextPreview {
    contextEntries: ProjectedSessionEntry[];
    contextMessages: AgentMessage[];
    llmMessages: unknown[];
    pendingMessages: AgentMessage[];
    canContinue: boolean;
  }

  export interface BoundaryState {
    entries: SessionBoundaryDraft[];
    continue: boolean;
    context: BoundaryContextPreview;
    outcome: 'completed' | 'aborted' | 'error';
  }

  export interface TurnEndEvent extends BoundaryState {
    type: 'turn_end';
    turnIndex: number;
    message: AgentMessage;
    toolResults: ToolResultMessage[];
    messageEntryId: string;
    toolResultEntryIds: string[];
  }

  export interface TurnEndEventResult {
    entries?: SessionBoundaryDraft[];
    continue?: boolean;
  }

  export interface SessionStartEvent {
    type: 'session_start';
    reason: 'startup' | 'reload' | 'new' | 'resume' | 'fork';
    previousSessionFile?: string;
  }

  export interface SessionBeforeCompactEvent {
    type: 'session_before_compact';
    preparation: unknown;
    branchEntries: SessionEntry[];
    customInstructions?: string;
    reason: 'manual' | 'threshold' | 'overflow';
    willRetry: boolean;
    signal: AbortSignal;
  }

  export interface SessionBeforeCompactResult {
    cancel?: boolean;
    compaction?: unknown;
  }

  export interface ExtensionContext {
    hasUI: boolean;
    mode: 'tui' | 'rpc' | 'json' | 'print';
    cwd: string;
    ui: {
      notify(message: string, type?: 'info' | 'warning' | 'error'): void;
      setStatus(key: string, text: string | undefined): void;
    };
    sessionManager: {
      buildSessionProjection(): { entries: ProjectedSessionEntry[]; messages: AgentMessage[] };
    };
    getContextUsage(): ContextUsage | undefined;
  }

  export type TurnEndHandler = (
    event: TurnEndEvent,
    ctx: ExtensionContext,
  ) => Promise<TurnEndEventResult | void> | TurnEndEventResult | void;

  export type SessionStartHandler = (
    event: SessionStartEvent,
    ctx: ExtensionContext,
  ) => Promise<void> | void;

  export type SessionBeforeCompactHandler = (
    event: SessionBeforeCompactEvent,
    ctx: ExtensionContext,
  ) => Promise<SessionBeforeCompactResult | void> | SessionBeforeCompactResult | void;

  export interface ExtensionCommandContext extends ExtensionContext {}

  export interface RegisteredCommand {
    description?: string;
    handler: (args: string, ctx: ExtensionCommandContext) => Promise<void> | void;
  }

  export interface ExtensionAPI {
    on(event: 'turn_end', handler: TurnEndHandler): () => void;
    on(event: 'session_start', handler: SessionStartHandler): () => void;
    on(event: 'session_before_compact', handler: SessionBeforeCompactHandler): () => void;
    registerCommand(name: string, options: RegisteredCommand): void;
  }
}
