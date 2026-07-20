import { mkdtemp, rm, writeFile, appendFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TranscriptTailer, readHeadLines } from '../src/transcriptTailer';
import { assistantLine, toJsonl, userLine } from './helpers';

describe('TranscriptTailer', () => {
  let dir: string;
  let file: string;

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'tailer-test-'));
    file = path.join(dir, 'session.jsonl');
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('bootstraps from a small file and reads all lines', async () => {
    const lines = [userLine('hello'), assistantLine('hi there', 'end_turn')];
    await writeFile(file, toJsonl(lines));
    const tailer = new TranscriptTailer(file);
    const parsed = await tailer.bootstrap();
    expect(parsed).toHaveLength(2);
    expect(parsed[0].type).toBe('user');
    expect(parsed[1].message?.stop_reason).toBe('end_turn');
  });

  it('bootstrap on a large file reads only the tail window and drops the partial first line', async () => {
    const filler = Array.from({ length: 500 }, (_, i) => userLine(`old message ${i} ${'x'.repeat(400)}`));
    const recent = assistantLine('recent answer', 'end_turn');
    await writeFile(file, toJsonl([...filler, recent]));

    const tailer = new TranscriptTailer(file, { bootstrapBytes: 4 * 1024 });
    const parsed = await tailer.bootstrap();
    expect(parsed.length).toBeGreaterThan(0);
    expect(parsed.length).toBeLessThan(500);
    expect(parsed[parsed.length - 1].message?.stop_reason).toBe('end_turn');
    // every parsed line is intact JSON (no half-line garbage)
    for (const line of parsed) expect(line.type).toBeDefined();
  });

  it('grows the bootstrap window when it lands inside one giant line', async () => {
    const giant = userLine('g'.repeat(8 * 1024));
    const after = assistantLine('done', 'end_turn');
    await writeFile(file, toJsonl([giant, after]));
    const tailer = new TranscriptTailer(file, { bootstrapBytes: 512, maxBootstrapBytes: 64 * 1024 });
    const parsed = await tailer.bootstrap();
    expect(parsed.some((l) => l.type === 'assistant')).toBe(true);
  });

  it('poll returns only appended lines, reassembled across split chunks', async () => {
    await writeFile(file, toJsonl([userLine('first')]));
    const tailer = new TranscriptTailer(file);
    await tailer.bootstrap();

    const next = JSON.stringify(assistantLine('multibyte ✓ résumé — done', 'end_turn')) + '\n';
    const bytes = Buffer.from(next, 'utf8');
    // split in the middle of the multibyte '✓'
    const splitAt = next.indexOf('✓') + 1; // char offset; take byte prefix crossing it
    const cut = Buffer.byteLength(next.slice(0, splitAt), 'utf8') - 2;

    await appendFile(file, bytes.subarray(0, cut));
    expect(await tailer.poll()).toHaveLength(0); // incomplete line held back

    await appendFile(file, bytes.subarray(cut));
    const parsed = await tailer.poll();
    expect(parsed).toHaveLength(1);
    expect(parsed[0].message?.content).toEqual([{ type: 'text', text: 'multibyte ✓ résumé — done' }]);
  });

  it('handles CRLF line endings', async () => {
    const a = JSON.stringify(userLine('one'));
    const b = JSON.stringify(assistantLine('two', 'end_turn'));
    await writeFile(file, `${a}\r\n${b}\r\n`);
    const tailer = new TranscriptTailer(file);
    const parsed = await tailer.bootstrap();
    expect(parsed).toHaveLength(2);
  });

  it('emits a __reset__ marker and recovers when the file is truncated', async () => {
    await writeFile(file, toJsonl([userLine('a'), assistantLine('b', 'end_turn'), userLine('c')]));
    const tailer = new TranscriptTailer(file);
    await tailer.bootstrap();

    await writeFile(file, toJsonl([userLine('fresh start')])); // shrink
    const parsed = await tailer.poll();
    expect(parsed[0].type).toBe('__reset__');
    expect(parsed.slice(1).some((l) => l.type === 'user')).toBe(true);
  });

  it('skips malformed lines and keeps parsing subsequent ones', async () => {
    const errors: string[] = [];
    const good = JSON.stringify(userLine('ok'));
    const alsoGood = JSON.stringify(assistantLine('fine', 'end_turn'));
    await writeFile(file, `${good}\n{this is not json}\n${alsoGood}\n`);
    const tailer = new TranscriptTailer(file, { onParseError: (_e, raw) => errors.push(raw) });
    const parsed = await tailer.bootstrap();
    expect(parsed).toHaveLength(2);
    expect(errors).toHaveLength(1);
  });

  it('returns nothing when file is unchanged', async () => {
    await writeFile(file, toJsonl([userLine('x')]));
    const tailer = new TranscriptTailer(file);
    await tailer.bootstrap();
    expect(await tailer.poll()).toHaveLength(0);
    expect(await tailer.poll()).toHaveLength(0);
  });

  it('readHeadLines recovers the early ai-title of a long transcript', async () => {
    const head = [
      userLine('first prompt'),
      { type: 'ai-title', aiTitle: 'My long session', sessionId: 'sess-1' },
    ];
    const filler = Array.from({ length: 500 }, (_, i) => userLine(`later ${i} ${'y'.repeat(400)}`));
    await writeFile(file, toJsonl([...head, ...filler]));

    const lines = await readHeadLines(file, 8 * 1024);
    const title = lines.find((l) => l.type === 'ai-title');
    expect(title?.aiTitle).toBe('My long session');
    // head window must not have read the whole file
    expect(lines.length).toBeLessThan(500);
  });
});
