# Claude Prompt Suggest

The Claude Code **CLI** shows a suggested next prompt between turns; the official VS Code extension doesn't (yet). This companion extension fills that gap:

1. It watches your Claude Code session transcripts (`~/.claude/projects/<slug>/*.jsonl`) for the open workspace.
2. When a turn completes (`stop_reason: end_turn`), it generates one suggested next prompt with a cheap headless call — `claude -p --model haiku` — reusing your existing Claude subscription auth. No API key needed.
3. The suggestion appears in the **status bar** (`💡 Add tests for the parser…`) and as a **💡 button in the Claude panel's tab bar** — including popped-out floating windows, which have no status bar. The tab-bar lightbulb is per-conversation: it only shows on the tab of the session the suggestion belongs to.
4. **Press `Ctrl+Alt+.`** (or click either 💡) → the full text is copied, the Claude chat input is focused, and a native `Ctrl+V` keystroke is simulated so the text lands in the input automatically. Just press Enter. All suggestion indicators clear everywhere the moment the text is copied.

The official extension's chat input can't be written to through any VS Code API, so the flow is clipboard + focus + a simulated OS-level paste keystroke (WScript SendKeys on Windows, `osascript` on macOS — needs Accessibility permission, `xdotool` on Linux). The keystroke never fires blind: the target window is verified against the Claude panel's actual tab labels first (window titles follow the active tab), and if no Claude window can be identified it falls back to clipboard-only — the flash reads `✓ Copied` instead of `✓ Pasted`. Set `claudeSuggest.autoPaste: false` to opt out entirely.

## Requirements

- The official [Claude Code extension](https://marketplace.visualstudio.com/items?itemName=anthropic.claude-code) (its bundled `claude.exe` is auto-discovered if `claude` isn't on your PATH)
- A logged-in Claude Code (subscription or API auth — whatever `claude` already uses)

## Commands

| Command | Effect |
|---|---|
| `claudeSuggest.accept` | Copy suggestion + focus Claude chat + auto-paste. Bound to `Ctrl+Alt+.` (`Cmd+Alt+.` on macOS) while a suggestion is showing; also what clicking the status bar does |
| `claudeSuggest.dismiss` | Hide the current suggestion |
| `claudeSuggest.regenerate` | Regenerate for the last completed turn (also clears auth backoff) |
| `claudeSuggest.toggle` | Enable/disable the whole extension |

## Settings

| Setting | Default | Meaning |
|---|---|---|
| `claudeSuggest.enabled` | `true` | Master switch |
| `claudeSuggest.model` | `haiku` | Model for `claude -p --model` |
| `claudeSuggest.claudePath` | `""` | Explicit binary path; empty = auto-discover (PATH → bundled) |
| `claudeSuggest.autoPaste` | `true` | Simulate the paste keystroke after copy+focus; off = copy+focus only |
| `claudeSuggest.showToast` | `false` | Mirror errors (timeout/auth/missing binary) as warning toasts with Retry |
| `claudeSuggest.timeoutSeconds` | `60` | Generation timeout; a timeout auto-retries once |
| `claudeSuggest.maxContextMessages` | `8` | Recent messages sent as context |
| `claudeSuggest.debounceMs` | `400` | Debounce for transcript file events |
| `claudeSuggest.entrypointFilter` | `claude-vscode` | Only suggest for VS Code sessions, or `all` (incl. terminal CLI sessions) |

## How it works

- **Turn detection**: transcripts are append-only JSONL; the tail is read incrementally (never the whole multi-MB file). A turn is complete when the newest `assistant` line has `stop_reason: "end_turn"` or `"stop_sequence"`; `"tool_use"` means Claude is still working.
- **Suppression**: if you've already typed your next prompt, the pending suggestion is dropped and any in-flight generation is killed.
- **Generation**: `claude -p --model haiku --max-turns 1 --tools "" --no-session-persistence --strict-mcp-config --effort low` with a small replacement system prompt and the conversation tail on stdin. It runs in the extension's storage dir, never your workspace — it can't touch your session or project.
- Sessions started by the extension are marked `entrypoint: claude-vscode` in the transcript, which is how the default filter ignores terminal sessions.

## Development

```
npm install
npm run watch        # esbuild watch; F5 to launch the Extension Development Host
npm test             # vitest unit tests (tail parser, turn detector)
npm run harness      # full pipeline against your newest real transcript, no VS Code
npm run package      # .vsix
```

`npm run harness -- --dry` prints the extracted context and the exact stdin without spawning claude.
