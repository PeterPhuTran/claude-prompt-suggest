import { describe, expect, it } from 'vitest';
import { TurnDetector } from '../src/turnDetector';
import type { TurnCompleteEvent } from '../src/types';
import { assistantLine, bookkeepingLine, toolResultLine, userLine } from './helpers';

function detector(maxContext = 8): TurnDetector {
  return new TurnDetector('sess-1', { maxContext });
}

describe('TurnDetector', () => {
  it('fires exactly one turn-complete with ordered context for a simple turn', () => {
    const d = detector();
    const events = d.ingest([
      bookkeepingLine('queue-operation'),
      userLine('fix the bug in parser.ts'),
      assistantLine('Fixed — the off-by-one is gone.', 'end_turn'),
      bookkeepingLine('last-prompt'),
    ]);
    const turns = events.filter((e) => e.kind === 'turn-complete') as TurnCompleteEvent[];
    expect(turns).toHaveLength(1);
    expect(turns[0].contextMessages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(turns[0].contextMessages[0].text).toContain('fix the bug');
    // the human prompt also produced a user-message event
    expect(events.filter((e) => e.kind === 'user-message')).toHaveLength(1);
  });

  it('does not fire mid-flight on tool_use, fires at the final end_turn', () => {
    const d = detector();
    let events = d.ingest([
      userLine('run the tests'),
      assistantLine('Running tests now.', 'tool_use'),
      toolResultLine(),
    ]);
    expect(events.filter((e) => e.kind === 'turn-complete')).toHaveLength(0);

    events = d.ingest([assistantLine('All 12 tests pass.', 'end_turn')]);
    const turns = events.filter((e) => e.kind === 'turn-complete') as TurnCompleteEvent[];
    expect(turns).toHaveLength(1);
    // context contains both assistant texts merged/appended, no tool_result noise
    const texts = turns[0].contextMessages.map((m) => m.text).join(' | ');
    expect(texts).toContain('All 12 tests pass.');
  });

  it('fires on stop_sequence turn ends too (seen in SDK/VS Code sessions)', () => {
    const d = detector();
    const events = d.ingest([
      userLine('summarize the diff'),
      assistantLine('Here is the summary.', 'stop_sequence'),
    ]);
    expect(events.filter((e) => e.kind === 'turn-complete')).toHaveLength(1);
  });

  it('never fires twice for the same end_turn uuid', () => {
    const d = detector();
    const line = assistantLine('done', 'end_turn');
    expect(d.ingest([userLine('go'), line]).filter((e) => e.kind === 'turn-complete')).toHaveLength(1);
    expect(d.ingest([line]).filter((e) => e.kind === 'turn-complete')).toHaveLength(0);
  });

  it('suppresses turn-complete when a user message follows end_turn in the same batch', () => {
    const d = detector();
    const events = d.ingest([
      userLine('first ask'),
      assistantLine('answer', 'end_turn'),
      userLine('already typed my next prompt'),
    ]);
    expect(events.filter((e) => e.kind === 'turn-complete')).toHaveLength(0);
    expect(events.filter((e) => e.kind === 'user-message')).toHaveLength(2);
  });

  it('tool_result user lines do not count as human messages and do not suppress', () => {
    const d = detector();
    const events = d.ingest([
      userLine('do a thing'),
      assistantLine('working', 'tool_use'),
      toolResultLine(),
      assistantLine('finished', 'end_turn'),
      toolResultLine(), // stray trailing tool result must not suppress
    ]);
    expect(events.filter((e) => e.kind === 'turn-complete')).toHaveLength(1);
  });

  it('bootstrap seeds the duplicate-guard so historical turns never fire', () => {
    const d = detector();
    d.bootstrap([userLine('old prompt'), assistantLine('old answer', 'end_turn')]);
    expect(d.ingest([]).length).toBe(0);
    // context was still absorbed for future suggestions
    expect(d.contextSnapshot().length).toBe(2);
    // a NEW turn still fires
    const events = d.ingest([userLine('new prompt'), assistantLine('new answer', 'end_turn')]);
    expect(events.filter((e) => e.kind === 'turn-complete')).toHaveLength(1);
  });

  it('resets state on __reset__ marker', () => {
    const d = detector();
    d.ingest([userLine('before'), assistantLine('answer', 'end_turn')]);
    const events = d.ingest([
    { type: '__reset__' },
      userLine('after compaction'),
      assistantLine('fresh answer', 'end_turn'),
    ]);
    const turns = events.filter((e) => e.kind === 'turn-complete') as TurnCompleteEvent[];
    expect(turns).toHaveLength(1);
    expect(turns[0].contextMessages.map((m) => m.text).join(' ')).not.toContain('before');
  });

  it('ignores sidechain lines entirely', () => {
    const d = detector();
    const events = d.ingest([
      userLine('main prompt'),
      assistantLine('subagent chatter', 'end_turn', { isSidechain: true }),
    ]);
    expect(events.filter((e) => e.kind === 'turn-complete')).toHaveLength(0);
  });

  it('caps context at maxContext and truncates long messages', () => {
    const d = detector(4);
    const lines = [];
    for (let i = 0; i < 6; i++) {
      lines.push(userLine(`prompt ${i} ${'y'.repeat(1000)}`));
      lines.push(assistantLine(`answer ${i}`, 'end_turn'));
    }
    d.ingest(lines);
    const ctx = d.contextSnapshot();
    expect(ctx.length).toBeLessThanOrEqual(4);
    for (const m of ctx) expect(m.text.length).toBeLessThanOrEqual(700);
  });

  it('records the session entrypoint from message lines', () => {
    const d = detector();
    d.ingest([userLine('hi', { entrypoint: 'cli' })]);
    expect(d.entrypoint).toBe('cli');
  });
});
