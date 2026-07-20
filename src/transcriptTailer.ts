import { open, stat } from 'node:fs/promises';
import type { TranscriptLine } from './types';

const NL = 0x0a;
const CR = 0x0d;

export interface TailerOptions {
  bootstrapBytes?: number;
  maxBootstrapBytes?: number;
  onParseError?: (error: unknown, rawLine: string) => void;
}

/**
 * Incremental tail reader for one append-only .jsonl transcript.
 * Never reads the whole file: bootstrap reads a window from EOF, then poll()
 * reads only bytes appended since the last read. Partial trailing lines are
 * buffered as raw bytes (multibyte-safe) until completed by a later append.
 */
export class TranscriptTailer {
  private offset = 0;
  private remainder: Buffer = Buffer.alloc(0);
  private bootstrapped = false;

  constructor(
    readonly filePath: string,
    private readonly opts: TailerOptions = {},
  ) {}

  async bootstrap(): Promise<TranscriptLine[]> {
    let window = this.opts.bootstrapBytes ?? 512 * 1024;
    const max = this.opts.maxBootstrapBytes ?? 2 * 1024 * 1024;
    const size = (await stat(this.filePath)).size;

    for (;;) {
      const start = Math.max(0, size - window);
      const buf = await this.readRange(start, size);
      let data = buf;
      if (start > 0) {
        const nl = buf.indexOf(NL);
        if (nl === -1) {
          // window landed inside one giant line
          if (window >= max || window >= size) {
            this.offset = size;
            this.remainder = Buffer.alloc(0);
            this.bootstrapped = true;
            return [];
          }
          window = Math.min(window * 2, max);
          continue;
        }
        data = buf.subarray(nl + 1);
      }
      const { lines, remainder } = splitCompleteLines(data);
      const parsed = this.parseLines(lines);
      const hasMessage = parsed.some((l) => l.type === 'user' || l.type === 'assistant');
      if (!hasMessage && start > 0 && window < max) {
        window = Math.min(window * 2, max);
        continue;
      }
      this.offset = size;
      this.remainder = remainder;
      this.bootstrapped = true;
      return parsed;
    }
  }

  /**
   * Returns lines appended since the last bootstrap/poll. On truncation or
   * rotation (file shrank), re-bootstraps and prefixes a `__reset__` marker.
   */
  async poll(): Promise<TranscriptLine[]> {
    if (!this.bootstrapped) return this.bootstrap();
    const size = (await stat(this.filePath)).size;
    if (size < this.offset) {
      this.bootstrapped = false;
      this.offset = 0;
      this.remainder = Buffer.alloc(0);
      const lines = await this.bootstrap();
      return [{ type: '__reset__' }, ...lines];
    }
    if (size === this.offset) return [];

    const appended = await this.readRange(this.offset, size);
    this.offset = size;
    const combined = this.remainder.length ? Buffer.concat([this.remainder, appended]) : appended;
    const { lines, remainder } = splitCompleteLines(combined);
    this.remainder = remainder;
    return this.parseLines(lines);
  }

  private parseLines(rawLines: Buffer[]): TranscriptLine[] {
    const out: TranscriptLine[] = [];
    for (const raw of rawLines) {
      if (raw.length === 0) continue;
      const text = raw.toString('utf8');
      if (!text.trim()) continue;
      try {
        const obj = JSON.parse(text);
        if (obj && typeof obj === 'object' && typeof obj.type === 'string') out.push(obj);
      } catch (err) {
        this.opts.onParseError?.(err, text.slice(0, 200));
      }
    }
    return out;
  }

  private async readRange(start: number, end: number): Promise<Buffer> {
    const fh = await open(this.filePath, 'r');
    try {
      const len = end - start;
      const buf = Buffer.allocUnsafe(len);
      let done = 0;
      while (done < len) {
        const { bytesRead } = await fh.read(buf, done, len - done, start + done);
        if (bytesRead === 0) break;
        done += bytesRead;
      }
      return buf.subarray(0, done);
    } finally {
      await fh.close();
    }
  }
}

/**
 * Parse the first complete lines of a transcript (up to maxBytes from the
 * head). Long sessions keep their one ai-title line near the top, outside the
 * tail bootstrap window — this recovers it cheaply.
 */
export async function readHeadLines(filePath: string, maxBytes = 256 * 1024): Promise<TranscriptLine[]> {
  const fh = await open(filePath, 'r');
  try {
    const size = (await fh.stat()).size;
    const len = Math.min(size, maxBytes);
    const buf = Buffer.allocUnsafe(len);
    let done = 0;
    while (done < len) {
      const { bytesRead } = await fh.read(buf, done, len - done, done);
      if (bytesRead === 0) break;
      done += bytesRead;
    }
    const { lines } = splitCompleteLines(buf.subarray(0, done));
    const out: TranscriptLine[] = [];
    for (const raw of lines) {
      if (raw.length === 0) continue;
      try {
        const obj = JSON.parse(raw.toString('utf8'));
        if (obj && typeof obj === 'object' && typeof obj.type === 'string') out.push(obj);
      } catch {
        // partial or corrupt line in the head window — skip
      }
    }
    return out;
  } finally {
    await fh.close();
  }
}

function splitCompleteLines(data: Buffer): { lines: Buffer[]; remainder: Buffer } {
  const lines: Buffer[] = [];
  let start = 0;
  for (;;) {
    const nl = data.indexOf(NL, start);
    if (nl === -1) break;
    let end = nl;
    if (end > start && data[end - 1] === CR) end -= 1;
    lines.push(data.subarray(start, end));
    start = nl + 1;
  }
  return { lines, remainder: Buffer.from(data.subarray(start)) };
}
