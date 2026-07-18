# Claude Prompt Suggest

**Suggested next prompts for the Claude Code VS Code extension.**

The Claude Code **CLI** shows a suggested next prompt between turns (accept with Tab). The official VS Code extension doesn't have that feature yet — this companion extension fills the gap. After each completed turn in a Claude Code session, it generates one suggested next prompt and offers it as a **💡 lightbulb** you can accept with one click or keystroke.

Works with the official [Claude Code extension](https://marketplace.visualstudio.com/items?itemName=anthropic.claude-code), including conversations popped out into floating windows, with one pending suggestion per open conversation.

## Install

Not on the Marketplace (yet). Two options:

**From a release VSIX:**

```
code --install-extension claude-prompt-suggest-<version>.vsix
```

(or in VS Code: Extensions panel → `···` menu → *Install from VSIX…*), then reload the window.

**From source:**

```
git clone https://github.com/PeterPhuTran/claude-prompt-suggest
cd claude-prompt-suggest
npm install
npm run package        # produces claude-prompt-suggest-<version>.vsix
code --install-extension claude-prompt-suggest-<version>.vsix
```

### Requirements

- VS Code ≥ 1.90 on Windows (auto-paste is Windows-first; macOS needs Accessibility permission, Linux needs `xdotool` — everything else is cross-platform)
- The official **Claude Code extension**, logged in (subscription or API auth — whatever `claude` already uses)
- The `claude` CLI is auto-discovered: your `claudeSuggest.claudePath` setting → PATH → the official extension's bundled binary. No separate install needed.

## Using it

1. Work in a Claude Code conversation as usual. When a turn completes, a suggestion is generated in the background (typically 10–30 s, model: haiku).
2. The suggestion appears as:
   - a **💡 button in that conversation's tab title bar** — including popped-out floating windows. The lightbulb is per-conversation: it only shows on the tab it belongs to, follows you when you switch tabs, and each open conversation keeps its own pending suggestion independently;
   - the **status bar** (bottom right of the main window): `💡 Add tests for the parser…` — hover for the full text of every pending suggestion.
3. Accept with **`Ctrl+Alt+.`** (`Cmd+Alt+.` on macOS) or by **clicking either 💡**. The text is copied, the chat input focused, and a paste keystroke lands it in the input box. You review it, then press Enter to send — nothing is ever sent automatically.
4. Accepting doesn't consume the suggestion — the 💡 stays lit so you can paste, evaluate, delete, and re-accept it. A conversation's suggestion clears when you actually **send** a message in it (yours or the accepted one), when you dismiss it, or when a newer suggestion replaces it. Other conversations' suggestions are always independent.

If the paste can't verify a safe target (see Security), it copies to the clipboard only — the status bar flashes `✓ Copied` instead of `✓ Pasted` and a toast tells you to press `Ctrl+V` yourself.

### Commands (Ctrl+Shift+P)

| Command | Effect |
|---|---|
| **Claude Suggest: Copy Suggestion & Focus Chat** | Accept the active tab's suggestion (else the newest). `Ctrl+Alt+.` |
| **Claude Suggest: Dismiss Suggestion** | Drop the active tab's suggestion |
| **Claude Suggest: Regenerate Suggestion** | Redo the suggestion for the last completed turn |
| **Claude Suggest: Enable/Disable** | Master toggle |
| **Claude Suggest: Show Log** | Open the output channel (activation, detection, generation, paste decisions) |

### Settings

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

Claude Code writes every session to an append-only JSONL transcript under `~/.claude/projects/<workspace-slug>/`. This extension:

1. **Watches** the transcript directory for the open workspace and tails every live session's file incrementally (never reading whole multi-MB files).
2. **Detects turn completion**: the newest `assistant` line with `stop_reason` `"end_turn"` or `"stop_sequence"` (`"tool_use"` means Claude is still working). If you've already typed your next prompt, the suggestion is suppressed and any in-flight generation killed.
3. **Generates** one suggestion per completed turn via a headless CLI call — `claude -p --model haiku --max-turns 1 --tools "" --no-session-persistence --strict-mcp-config --effort low` — with a small replacement system prompt and the recent conversation as stdin. It reuses your existing `claude` login; no API key, no other network calls.
4. **Delivers** it through the status bar and a per-conversation tab-bar lightbulb (an `editor/title` menu contribution gated by context keys, re-evaluated on every tab switch).

Because VS Code offers no API to type into another extension's webview, accepting works by clipboard + focus + a simulated OS-level `Ctrl+V` — with the safety gate described below.

## Security & privacy

- **What leaves your machine**: the last few user/assistant messages (default 8, truncated to ~700 chars each) are sent to Anthropic through your own `claude` CLI and auth — the same place the conversation already lives. There is no telemetry, no analytics, and no network access besides that CLI call.
- **The generation subprocess can't act**: it runs with all tools disabled (`--tools ""`), MCP servers skipped, no session persistence, and its working directory is the extension's storage dir — it cannot touch your workspace or your real session.
- **The paste keystroke never fires blind.** A simulated `Ctrl+V` goes to whatever window the OS has in the foreground, so before sending it the extension verifies the foreground window's title matches the target conversation's actual tab label (or activates that window first). If no Claude window can be positively identified, it degrades to clipboard-only. Tab labels are embedded in the verification script single-quote-escaped and length-capped.
- **Nothing is auto-submitted**: the suggestion lands in the input box; you always press Enter yourself.
- **Transcripts are read-only**: the extension never writes to `~/.claude`.

## Known limitations

- Floating (popped-out) windows have no status bar ([VS Code won't add one](https://github.com/microsoft/vscode/issues/196395)) and VS Code notification toasts render only in the main window — hence the tab-bar lightbulb as the floating-window surface.
- Generation latency varies (≈10–90 s observed) with API load; a timeout triggers one automatic retry.
- Tab ↔ conversation matching uses the tab label (VS Code exposes no stronger link), normalized for truncation ellipses and dirty markers. Two conversations with near-identical titles could confuse it.
- Windows is the primary platform; macOS/Linux auto-paste is best-effort.

## Development

```
npm install
npm run watch        # esbuild watch; F5 to launch the Extension Development Host
npm test             # vitest unit tests (tail parser, turn detector)
npm run harness      # full pipeline against your newest real transcript, no VS Code
npm run package      # .vsix
```

`npm run harness -- --dry` prints the extracted context and the exact stdin without spawning claude. The output channel (*Claude Suggest: Show Log*) narrates every decision the extension makes.

## License

[MIT](LICENSE)
