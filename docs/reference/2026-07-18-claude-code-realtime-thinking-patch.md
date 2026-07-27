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
Rewires the stock `claude` native binary's `thinking_delta` handler so the
`∴ Thinking…` block streams live as the model reasons, instead of appearing all
at once at the end. Display-only change (no effect on the model, requests,
tokens, cost); length-preserving in-place byte edit + ad-hoc re-sign. A launchd
agent re-applies it automatically after each Claude Code auto-update.

## When something's wrong — quick commands
```bash
python3 ~/.claude/patches/realtime-thinking.py --check    # patched?
python3 ~/.claude/patches/realtime-thinking.py            # re-apply now
python3 ~/.claude/patches/realtime-thinking.py --revert   # undo (restore original)
cat ~/.claude/patches/realtime-thinking.log               # what the auto-agent did
launchctl print gui/$(id -u)/com.user.claude-realtime-thinking | grep -E 'state|last exit'
```

## Key limits
Opus only exposes *summarized* reasoning (`thinking.display` = summarized/omitted/
null — no raw), so live text is a summary; true token-by-token raw reasoning is
GPT/Codex-only. Measured on Fable 5 (2026-07-27, stream-json capture): the summary
streams in ~50–80-char multi-token chunks every ~200ms — fluid enough to look
token-by-token, but still chunked. Installed 2026-07-18 on Claude Code v2.1.214.
See the canonical README for the full derivation and troubleshooting.
