/** One parsed line of a Claude Code session transcript (.jsonl). */
export interface TranscriptLine {
  type:
    | 'user'
    | 'assistant'
    | 'queue-operation'
    | 'attachment'
    | 'file-history-snapshot'
    | 'last-prompt'
    | 'ai-title'
    | '__reset__'
    | string;
  uuid?: string;
  parentUuid?: string | null;
  sessionId?: string;
  entrypoint?: string;
  isSidechain?: boolean;
  isMeta?: boolean;
  timestamp?: string;
  message?: {
    role?: string;
    stop_reason?: string | null;
    content?: string | Array<{ type: string; text?: string }>;
  };
}

export interface ContextMsg {
  role: 'user' | 'assistant';
  text: string;
}

export interface TurnCompleteEvent {
  kind: 'turn-complete';
  sessionId: string;
  /** uuid of the assistant line whose stop_reason was end_turn */
  assistantUuid: string;
  /** recent user/assistant text, oldest first */
  contextMessages: ContextMsg[];
}

export interface NewUserMessageEvent {
  kind: 'user-message';
  sessionId: string;
}

export type DetectorEvent = TurnCompleteEvent | NewUserMessageEvent;

export interface ClaudeBinary {
  path: string;
  source: 'setting' | 'path' | 'bundled';
  /** true for .cmd/.bat shims that must be spawned via cmd.exe with simple args only */
  isShellShim: boolean;
}

export type SuggestionResult =
  | { ok: true; suggestion: string }
  | {
      ok: false;
      error: 'timeout' | 'auth' | 'spawn' | 'parse' | 'aborted' | 'nonzero';
      detail: string;
    };
