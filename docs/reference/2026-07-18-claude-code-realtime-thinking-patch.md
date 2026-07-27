# Claude Code real-time thinking patch — pointer

**This is about the stock Claude Code CLI (the `claude` binary), NOT cat-code.**
It's recorded here only so it's findable from this workspace. Do not confuse it
with cat-code's own reasoning code (`src/utils/messages.ts`, `AssistantThinkingMessage`).

## Canonical doc
Full reference + troubleshooting lives with the patch files:

- **`~/.claude/patches/README.md`** ← read this when something breaks
- Patcher: `~/.claude/patches/realtime-thinking.py`
- Auto-updater agent: `~/Library/LaunchAgents/com.user.claude-realtime-thinking.plist`
- Agent log: `~/.claude/patches/realtime-thinking.log`
- Original-binary backups: `~/.local/share/claude/versions/<ver>.orig-<ver>`

## What it does (one line)
Rewires the stock `claude` native binary's `thinking_delta` handler to capture
the live reasoning text into REPL state — **but a 2026-07-27 render-path trace
proved the stock TUI has NO component that renders that state (checked
2.1.214/215/220), so there is no visible live streaming and never was.** Net
effect: the "(N tokens)" counter is dropped and ESC mid-thinking salvages the
partial reasoning into the transcript; kept for the salvage. Length-preserving
in-place byte edit + ad-hoc re-sign; a launchd agent re-applies it after each
Claude Code auto-update.

## When something's wrong — quick commands
```bash
python3 ~/.claude/patches/realtime-thinking.py --check    # patched?
python3 ~/.claude/patches/realtime-thinking.py            # re-apply now
python3 ~/.claude/patches/realtime-thinking.py --revert   # undo (restore original)
cat ~/.claude/patches/realtime-thinking.log               # what the auto-agent did
launchctl print gui/$(id -u)/com.user.claude-realtime-thinking | grep -E 'state|last exit'
```

## Key limits
The hard limit is the missing renderer above — nothing in stock Claude Code
paints live thinking (upstream request: anthropics/claude-code#30660); the live
reasoning view exists only in cat-code (native) and the desktop Claude app.
Wire facts remain true: Anthropic frontier models expose only *summarized*
reasoning (`thinking.display` = summarized/omitted/null — no raw), and on
Fable 5 (2026-07-27 stream-json capture) the summary genuinely streams in
~50–80-char multi-token chunks every ~200ms; true token-by-token raw reasoning
is GPT/Codex-only. Installed 2026-07-18 on Claude Code v2.1.214.
See the canonical README for the full derivation and the correction record.
