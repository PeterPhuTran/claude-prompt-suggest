import { spawn } from 'node:child_process';
import type { ClaudeBinary, ContextMsg, SuggestionResult } from './types';

export const SUGGESTION_SYSTEM_PROMPT = [
  "You write the user's next prompt for an ongoing Claude Code coding session.",
  'You will be given the most recent exchange between the user and the assistant.',
  'Reply with exactly ONE suggested next prompt:',
  '- written in first person, as if the user typed it ("Add tests for the parser")',
  '- imperative, specific, and directly useful given what just happened',
  '- a natural next step: verify, test, commit, fix a loose end, or extend the work',
  '- a task the ASSISTANT can perform in the session (edit code, run commands, commit)',
  '- never manual steps for the human to do outside the chat (no "reload the window", "click X", "open settings")',
  '- at most 120 characters, single line, no quotes, no explanation, no numbering',
  'If the assistant asked the user a question, suggest a plausible concrete answer.',
  'Never suggest something already done in the conversation.',
].join('\n');

const JSON_SCHEMA = JSON.stringify({
  type: 'object',
  properties: { suggestion: { type: 'string' } },
  required: ['suggestion'],
});

export interface EngineOptions {
  binary: ClaudeBinary;
  model: string;
  /** working directory for the child — must NOT be the watched workspace */
  cwd: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

export function buildExcerpt(context: ContextMsg[], withInstructions: boolean): string {
  const convo = context.map((m) => `[${m.role}] ${m.text}`).join('\n\n');
  const parts = withInstructions ? [SUGGESTION_SYSTEM_PROMPT, ''] : [];
  parts.push('Recent conversation (oldest first):', '', convo, '', 'Suggest my next prompt.');
  return parts.join('\n');
}

export async function generateSuggestion(
  context: ContextMsg[],
  opts: EngineOptions,
): Promise<SuggestionResult> {
  if (context.length === 0) return { ok: false, error: 'parse', detail: 'no conversation context' };
  if (opts.signal?.aborted) return { ok: false, error: 'aborted', detail: 'aborted before spawn' };

  const baseArgs = [
    '-p',
    '--model', opts.model,
    '--max-turns', '1',
    '--tools', '',
    '--no-session-persistence',
    '--strict-mcp-config', // skip user MCP servers — they add tens of seconds of startup
    '--effort', 'low',
    '--output-format', 'json',
  ];

  // Direct .exe spawn tolerates args with quotes/newlines (no shell parsing);
  // cmd.exe shims don't, so for those the instructions move into stdin and we
  // skip --system-prompt/--json-schema entirely.
  let command: string;
  let args: string[];
  if (opts.binary.isShellShim) {
    command = process.env.ComSpec ?? 'cmd.exe';
    args = ['/d', '/s', '/c', opts.binary.path, ...baseArgs];
  } else {
    command = opts.binary.path;
    args = [...baseArgs, '--system-prompt', SUGGESTION_SYSTEM_PROMPT, '--json-schema', JSON_SCHEMA];
  }
  const stdinText = buildExcerpt(context, opts.binary.isShellShim);

  return new Promise<SuggestionResult>((resolve) => {
    let settled = false;
    const finish = (r: SuggestionResult) => {
      if (!settled) {
        settled = true;
        cleanup();
        resolve(r);
      }
    };

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, args, {
        cwd: opts.cwd,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (err) {
      resolve({ ok: false, error: 'spawn', detail: String(err) });
      return;
    }

    const killTree = () => {
      if (child.pid == null) return;
      if (process.platform === 'win32') {
        // claude spawns children; kill the whole tree
        spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      } else {
        child.kill('SIGKILL');
      }
    };

    const timeoutMs = opts.timeoutMs ?? 30_000;
    const timer = setTimeout(() => {
      killTree();
      finish({ ok: false, error: 'timeout', detail: `no result in ${timeoutMs}ms` });
    }, timeoutMs);

    const onAbort = () => {
      killTree();
      finish({ ok: false, error: 'aborted', detail: 'superseded' });
    };
    opts.signal?.addEventListener('abort', onAbort, { once: true });

    const cleanup = () => {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
    };

    let stdout = '';
    let stderr = '';
    child.stdout!.setEncoding('utf8').on('data', (d: string) => (stdout += d));
    child.stderr!.setEncoding('utf8').on('data', (d: string) => (stderr += d));

    child.on('error', (err) => finish({ ok: false, error: 'spawn', detail: String(err) }));

    child.on('close', (code) => {
      if (settled) return;
      const classify = (detail: string): SuggestionResult => {
        const haystack = `${detail}\n${stderr}`.toLowerCase();
        if (/log ?in|logged out|authentication|credential|oauth|api key|unauthorized|expired/.test(haystack)) {
          return { ok: false, error: 'auth', detail: detail.slice(0, 300) };
        }
        return { ok: false, error: 'nonzero', detail: detail.slice(0, 300) };
      };

      let envelope: any;
      try {
        envelope = JSON.parse(stdout);
      } catch {
        if (code !== 0) {
          finish(classify(stderr || stdout || `exit code ${code}`));
        } else {
          finish({ ok: false, error: 'parse', detail: `unparseable stdout: ${stdout.slice(0, 200)}` });
        }
        return;
      }

      if (envelope?.is_error || code !== 0) {
        finish(classify(String(envelope?.result ?? stderr ?? `exit code ${code}`)));
        return;
      }

      let text: string | undefined;
      if (typeof envelope?.structured_output?.suggestion === 'string') {
        text = envelope.structured_output.suggestion;
      } else if (typeof envelope?.result === 'string') {
        text = envelope.result;
        try {
          const inner = JSON.parse(text!);
          if (typeof inner?.suggestion === 'string') text = inner.suggestion;
        } catch {
          // plain-text result is fine
        }
      }
      if (!text?.trim()) {
        finish({ ok: false, error: 'parse', detail: 'empty result' });
        return;
      }
      finish({ ok: true, suggestion: postProcess(text) });
    });

    child.stdin!.on('error', () => {
      // EPIPE if the process died early; close handler reports the real error
    });
    child.stdin!.end(stdinText, 'utf8');
  });
}

function postProcess(raw: string): string {
  let s = raw.trim();
  s = s.replace(/^["'`]+|["'`]+$/g, '');
  s = s.replace(/\s*\n+\s*/g, ' ').replace(/\s{2,}/g, ' ').trim();
  if (s.length > 200) s = `${s.slice(0, 199)}…`;
  return s;
}
