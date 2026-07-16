/**
 * Standalone pipeline test, no VS Code:
 *   node dist/harness.js [--transcript <path>] [--model <model>] [--dry]
 * Defaults to the newest .jsonl for the current working directory's project.
 * --dry prints the context and the exact claude invocation without spawning.
 */
import { readdir, stat, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { TranscriptTailer } from '../src/transcriptTailer';
import { TurnDetector } from '../src/turnDetector';
import { projectDir } from '../src/sessionLocator';
import { discoverClaudeBinary } from '../src/claudeBinary';
import { generateSuggestion, buildExcerpt } from '../src/suggestionEngine';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

async function newestTranscript(dir: string): Promise<string> {
  const names = (await readdir(dir)).filter((n) => n.endsWith('.jsonl'));
  if (names.length === 0) throw new Error(`no .jsonl transcripts in ${dir}`);
  const stats = await Promise.all(
    names.map(async (n) => ({ n, m: (await stat(path.join(dir, n))).mtimeMs })),
  );
  stats.sort((a, b) => b.m - a.m);
  return path.join(dir, stats[0].n);
}

async function main() {
  const transcript = arg('--transcript') ?? (await newestTranscript(projectDir(process.cwd())));
  const model = arg('--model') ?? 'haiku';
  console.log(`transcript: ${transcript}`);

  const tailer = new TranscriptTailer(transcript, {
    onParseError: (e, raw) => console.warn(`parse error: ${e} :: ${raw}`),
  });
  const lines = await tailer.bootstrap();
  console.log(`bootstrap: ${lines.length} lines parsed from tail window`);

  const sessionId = path.basename(transcript, '.jsonl');
  const detector = new TurnDetector(sessionId, { maxContext: 8 });
  detector.bootstrap(lines);
  const context = detector.contextSnapshot();
  console.log(`entrypoint: ${detector.entrypoint ?? '(unknown)'}, context messages: ${context.length}`);
  for (const m of context) console.log(`  [${m.role}] ${m.text.slice(0, 100).replace(/\n/g, ' ')}`);
  if (context.length === 0) throw new Error('no context extracted — nothing to suggest from');

  const binary = await discoverClaudeBinary(arg('--claude'));
  if (!binary) throw new Error('claude binary not found (PATH or bundled extension)');
  console.log(`binary: ${binary.path} (${binary.source}${binary.isShellShim ? ', shell shim' : ''})`);

  if (process.argv.includes('--dry')) {
    console.log('\n--- stdin that would be sent ---\n');
    console.log(buildExcerpt(context, binary.isShellShim));
    return;
  }

  const scratch = await mkdtemp(path.join(tmpdir(), 'claude-suggest-'));
  const t0 = Date.now();
  const result = await generateSuggestion(context, { binary, model, cwd: scratch });
  const ms = Date.now() - t0;

  if (result.ok) {
    console.log(`\nsuggestion (${ms}ms):\n  ${result.suggestion}`);
  } else {
    console.error(`\nFAILED (${ms}ms): ${result.error} — ${result.detail}`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
