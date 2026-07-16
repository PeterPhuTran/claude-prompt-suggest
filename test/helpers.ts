import type { TranscriptLine } from '../src/types';

let uuidCounter = 0;
export function nextUuid(): string {
  return `uuid-${++uuidCounter}`;
}

const BASE = {
  sessionId: 'sess-1',
  cwd: 'd:\\claude\\cli_work',
  version: '2.1.211',
  gitBranch: 'main',
  entrypoint: 'claude-vscode',
  timestamp: '2026-07-16T00:00:00.000Z',
};

export function userLine(text: string, extra: Partial<TranscriptLine> = {}): TranscriptLine {
  return {
    ...BASE,
    type: 'user',
    uuid: nextUuid(),
    parentUuid: null,
    isSidechain: false,
    message: { role: 'user', content: [{ type: 'text', text }] },
    ...extra,
  };
}

export function toolResultLine(extra: Partial<TranscriptLine> = {}): TranscriptLine {
  return {
    ...BASE,
    type: 'user',
    uuid: nextUuid(),
    isSidechain: false,
    message: {
      role: 'user',
      content: [{ type: 'tool_result', text: undefined } as never],
    },
    ...extra,
  };
}

export function assistantLine(
  text: string,
  stopReason: 'end_turn' | 'tool_use' | null,
  extra: Partial<TranscriptLine> = {},
): TranscriptLine {
  const content: Array<{ type: string; text?: string }> = [{ type: 'text', text }];
  if (stopReason === 'tool_use') content.push({ type: 'tool_use' });
  return {
    ...BASE,
    type: 'assistant',
    uuid: nextUuid(),
    isSidechain: false,
    message: { role: 'assistant', stop_reason: stopReason, content },
    ...extra,
  };
}

export function bookkeepingLine(type: string): TranscriptLine {
  return { type, sessionId: BASE.sessionId } as TranscriptLine;
}

export function toJsonl(lines: TranscriptLine[]): string {
  return lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
}
