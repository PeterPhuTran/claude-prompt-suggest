import type { ContextMsg, DetectorEvent, TranscriptLine } from './types';

export interface DetectorOptions {
  maxContext: number;
  maxCharsPerMsg?: number;
}

/** Turn-ending stop_reasons: "tool_use" means mid-flight, these mean done. */
const TURN_END_STOP_REASONS = new Set(['end_turn', 'stop_sequence']);

/**
 * Consumes parsed transcript lines and decides when a turn has completed.
 * Fires `turn-complete` exactly once per new turn-ending assistant line, and
 * `user-message` whenever a real (human, non-tool-result) prompt appears.
 * A user message that lands in the same batch after a turn end suppresses
 * the turn-complete (the user has already moved on).
 */
export class TurnDetector {
  private lastFiredUuid: string | undefined;
  private context: ContextMsg[] = [];
  /** entrypoint seen on message lines, e.g. "claude-vscode" or "cli" */
  entrypoint: string | undefined;

  constructor(
    readonly sessionId: string,
    private readonly opts: DetectorOptions,
  ) {}

  /** Absorb historical lines without emitting events; seeds duplicate-guard. */
  bootstrap(lines: TranscriptLine[]): void {
    for (const line of lines) this.absorb(line);
    for (let i = lines.length - 1; i >= 0; i--) {
      const l = lines[i];
      if (this.isRelevant(l) && this.isTurnEnd(l) && l.uuid) {
        this.lastFiredUuid = l.uuid;
        break;
      }
    }
  }

  ingest(lines: TranscriptLine[]): DetectorEvent[] {
    const events: DetectorEvent[] = [];
    let pending: TranscriptLine | undefined;

    for (const line of lines) {
      if (line.type === '__reset__') {
        this.context = [];
        this.lastFiredUuid = undefined;
        pending = undefined;
        continue;
      }
      const isHumanText = this.absorb(line);
      if (isHumanText) {
        pending = undefined;
        events.push({ kind: 'user-message', sessionId: this.sessionId });
      } else if (
        this.isRelevant(line) &&
        this.isTurnEnd(line) &&
        line.uuid &&
        line.uuid !== this.lastFiredUuid
      ) {
        pending = line;
      }
    }

    if (pending?.uuid) {
      this.lastFiredUuid = pending.uuid;
      events.push({
        kind: 'turn-complete',
        sessionId: this.sessionId,
        assistantUuid: pending.uuid,
        contextMessages: [...this.context],
      });
    }
    return events;
  }

  contextSnapshot(): ContextMsg[] {
    return [...this.context];
  }

  /**
   * Track context; returns true only for a real human text message
   * (type user with text content — not tool_result feedback lines).
   */
  private absorb(line: TranscriptLine): boolean {
    if (!this.isRelevant(line)) return false;
    if (line.entrypoint) this.entrypoint = line.entrypoint;

    if (line.type !== 'user' && line.type !== 'assistant') return false;
    const text = extractText(line);
    if (!text) return false;

    this.pushContext(line.type, truncate(text, this.opts.maxCharsPerMsg ?? 700));
    return line.type === 'user';
  }

  private isRelevant(line: TranscriptLine): boolean {
    return line.isSidechain !== true && line.isMeta !== true;
  }

  private isTurnEnd(line: TranscriptLine): boolean {
    return (
      line.type === 'assistant' &&
      typeof line.message?.stop_reason === 'string' &&
      TURN_END_STOP_REASONS.has(line.message.stop_reason)
    );
  }

  private pushContext(role: 'user' | 'assistant', text: string) {
    const last = this.context[this.context.length - 1];
    if (last && last.role === role) {
      last.text = truncate(`${last.text}\n${text}`, this.opts.maxCharsPerMsg ?? 700);
    } else {
      this.context.push({ role, text });
      if (this.context.length > this.opts.maxContext) this.context.shift();
    }
  }
}

export function extractText(line: TranscriptLine): string {
  const content = line.message?.content;
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  return content
    .filter((b) => b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text!.trim())
    .filter(Boolean)
    .join('\n');
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}
