# Codex render storm — investigation report

**Status:** In-progress. Instrumentation landed; UI state root cause not yet identified.
**Session under analysis:** `8eb4199c-b49a-404a-b22a-b4fdda4615e4` (2026-04-21 11:06, gpt-5.4 via Codex WebSocket)
**Prior related session:** `86b63fef-05ca-4621-97c4-2638aa03bbfb` (2026-04-21 10:57, same model/path)
**Branch:** `phase1` (uncommitted working tree)

---

## Context: how we got here

This investigation is a follow-up to the StructuredOutput silent-hang bug documented in
`docs/bug-structuredoutput-codex-silent-hang.md`. Two bugs were identified and fixed:

- **Bug 1 (fixed)** — `StructuredOutput` tool leaking into Codex requests:
  1. `src/services/api/codex-fetch-adapter.ts` — `translateMessages()` skips
     `StructuredOutput` tool_use blocks from history + their paired tool_results
     (via `skippedToolCallIds` set).
  2. `src/services/api/codex-fetch-adapter.ts` — `translateTools()` filters out
     `SYNTHETIC_OUTPUT_TOOL_NAME` before sending tool definitions to Codex.
  Root cause was the tool schema being sent in `codexBody.tools` on every request
  (not just from history replay as originally thought).

- **Bug 2 (fixed)** — silent infinite retry on unknown tool in `src/query.ts`:
  added `unknownToolConsecutiveCounts` map before the `while(true)` loop; aborts
  with visible error after 2 consecutive turns of the same unknown tool name.

Both fixes verified in debug log `86b63fef`: gpt-5.4 responded cleanly (11 output
tokens, no StructuredOutput) — but the **session still appeared broken**. A
"High write ratio" log storm followed the successful response. This report is
about that storm.

---

## Symptom

After a successful Codex API round-trip, the terminal UI becomes unresponsive —
or at least, from the user's perspective, no response appears on screen. Behind
the scenes, Ink emits a flood of `High write ratio: blit=0, write=2875 (100.0%
writes)` debug lines. Every frame is a full redraw with zero blit-cache reuse.

---

## Instrumentation added this session

**File:** `src/ink/output.ts` (lines 18–24, 529–544)
**Change:** when the `High write ratio` heuristic fires, also dump 6 sample rows
(top 2, middle, bottom 3) of the rendered screen as JSON strings, so we can see
**what content is actually on screen** during each storm frame.

```ts
logForDebugging(`High write ratio screen sample:\n${sampleRows.join('\n')}`)
```

Imported `cellAtIndex` from `./screen.js` to read cells.

Built with `bun run ./scripts/build.ts --dev --feature-set=dev-full` (skipped the
`bun run lint` step in `build:dev:full` — 56 pre-existing lint errors unrelated
to this change).

---

## Session 8eb4199c: what the data shows

### Timing

```
11:06:05.999  Initial render (startup welcome box)     — write=2290  (normal)
11:06:09.139  [codex-ws] connected
11:06:09.143  [codex-ws] prewarm start
11:06:09.568  [codex-ws] prewarm complete, full send input=1 items
11:06:09.607  Stream started - received first chunk
11:06:09.986  COLD cached=0/161, output=11              ← gpt-5.4 response complete
11:06:09.989  [useDeferredValue] Messages deferred by 1 (2→3)
11:06:10.017  .cat-code.json persisted (session state written)
11:06:10.022  [useDeferredValue] Messages deferred by 1 (2→3)
11:06:12.803  STORM BEGINS — write=2875
...           40 identical frames over ~3.8s
11:06:16.577  Last storm frame (end of log)
```

- **Response arrived successfully** at `11:06:09.986` — 11 output tokens, clean,
  no StructuredOutput, no tool calls, no retry loop. Bug 1 + Bug 2 fixes both
  working as intended.
- **No napi error in this session.** The `image-processor-napi` error that
  showed up in session 86b63fef is absent here. So the storm is **independent
  of the napi error**, contradicting the "napi cascade" theory in
  `bug-structuredoutput-codex-silent-hang.md`.

### The decisive observation: all storm frames are identical

Every one of the 40 `High write ratio screen sample` entries shows the exact
same content:

```
y=0:  ""
y=1:  "╭──────────────────────────────────────────────────────────────────────…"
y=27: "│                                                                          │"
y=51: "──────────────────────────────────────────────────────────────────────…"
y=52: "  pt@PT-3 | \~/cat-code |  phase1 | GPT 5.4 · high · 902073af-1c0 | ctx: 0%"
y=53: ""
```

That `y=1` … `y=27` … `y=51` shape is the **startup welcome box**.
It's what the user sees on a fresh launch with no messages.

**Every sampled frame — from 11:06:12.803 to 11:06:16.577 — still shows the
welcome box.** There is no user message, no assistant response, no rendered
content of any kind on screen during the storm. Just the welcome box being
redrawn identically ~40 times.

This means:
1. **The gpt-5.4 response was never visible to the user.**
2. **The user's own prompt was also never visible.**
3. The render pipeline is doing `write=2875` full-redraws with the **same content**
   every frame (byte-identical across 40 samples).
4. The blit cache is not helping (`blit=0` every frame) — this is a separate
   symptom; the primary issue is that the rendered tree isn't updating to
   reflect state changes.

### What "write=2875" means

From `src/ink/output.ts:273`: `writeCells` counts the total cells written by
`writeLineToScreen` in a single `get()` pass (one frame). The heuristic at
line 524 only fires when `totalCells > 1000 && writeCells > blitCells`.
`blit=0` means the blit-cache reuse path was not hit at all — every subtree
re-rendered from scratch.

So each of the 40 storm frames is a full-tree render producing identical
output. That's not a spinner ticking (which would change char at a known
position) — it's **React/Ink re-rendering the entire app at ~16-30ms cadence
for at least 3.8 seconds, producing identical output each time.**

---

## What we know about the pipeline

### `messages` → `deferredMessages` split (src/screens/REPL.tsx:1753)

```ts
const deferredMessages = useDeferredValue(messages);
const deferredBehind = messages.length - deferredMessages.length;
if (deferredBehind > 0) {
  logForDebugging(`[useDeferredValue] Messages deferred by ${deferredBehind} (${deferredMessages.length}→${messages.length})`);
}
```

At `11:06:09.989` we see `Messages deferred by 1 (2→3)` — so `messages.length`
did go from 2 to 3 (the new assistant response was appended to state). Good:
state update happened.

### Display selection (src/screens/REPL.tsx:5332–5335)

```ts
const usesSyncMessages = showStreamingText || !isLoading;
const displayedMessages = viewedAgentTask
  ? viewedAgentTask.messages ?? []
  : usesSyncMessages
    ? messages
    : deferredMessages;
```

- If `isLoading === true` and `showStreamingText === false` → uses
  `deferredMessages` (stale).
- Once `isLoading` flips to `false` → uses `messages` (fresh).

**Hypothesis A (not yet confirmed):** `isLoading` is stuck `true` after the
Codex response, so the REPL keeps rendering `deferredMessages` (length 2) —
and since `deferredMessages` hasn't caught up either, the display shows an
empty/stale state. But this doesn't explain why the welcome box is on screen —
`deferredMessages` at length 2 should include at least the user's prompt.

**Hypothesis B:** The REPL's `messages` state never actually gets the user
prompt either — we only see it at `length === 3` at the `useDeferredValue` log
line, but the two increments (0→?→3) might be two rapid batched assistant
appends, not user+assistant. Would need to instrument `setMessages` call sites
to confirm.

### No napi cascade this time

The prior session (86b63fef) had the napi error 13s after the initial storm
start, which muddied the signal. In this session, no napi error at all, and
the storm still fires → the napi error is a separate bug and not a trigger.

### Render cadence

40 frames in ~3.8s ≈ one frame per 95 ms average, but clustered:
- 14 frames in 170ms (`11:06:12.803`–`11:06:12.972`)
- 13 frames in 180ms (`11:06:13.164`–`11:06:13.484`)
- Trailing frames spaced 100–2000ms apart

This rate is consistent with React concurrent-mode scheduling catching up, not
a tight synchronous loop. Something is repeatedly scheduling re-renders of a
tree whose output hasn't changed.

---

## What is NOT the cause

- **Not the StructuredOutput bleed** — Bug 1 fix is working (verified by
  `output=11` and absence of any StructuredOutput reference in the log).
- **Not the unknown-tool retry loop** — Bug 2 fix is working (turn count
  stayed at `messages=1`, no tool errors).
- **Not the napi error** — this session has no napi error and still storms.
- **Not a spinner animation** — sampled content is byte-identical across
  frames; no changing character positions.
- **Not cumulative counter re-logging** — each `write=2875` is a fresh count
  from a fresh `get()` call; the screen really is being re-rendered each time.

---

## What IS likely happening (current best guess)

1. A component high in the tree is setting state (or receiving a context
   update) on every render, forcing React to commit a new frame.
2. The commit produces the same output — hence identical samples, hence
   `blit=0` (every cell is a "write" because the prev-frame check sees no
   change, but the blit-cache logic isn't reusing the prior frame either).
3. The loop is self-sustaining because whatever sets state is itself
   triggered by the commit (classic "setState during render" / "effect with
   wrong deps that fires every commit" pattern).
4. Meanwhile, `messages` state in REPL **never gets the assistant response
   applied to the displayed list** — either:
   - `isLoading` never flips false → `deferredMessages` is used but is also
     stale, OR
   - Some higher-level gate (e.g., `viewedAgentTask`, a dialog state, a
     mode flag) is forcing an alternate render branch that shows the
     welcome box regardless of `messages`.

The welcome box being on screen is actually the biggest clue we have and
**hasn't been investigated yet**. Something is rendering the "fresh launch"
UI instead of the message list.

---

## Next steps (when investigation resumes)

1. **Find what renders the welcome box.** Grep for the box-drawing characters,
   or for the welcome/splash component. Identify the condition under which
   it renders vs. the `<Messages>` component. That condition is probably
   stuck in the wrong state.
2. **Instrument `setMessages` call sites** to log length before/after on
   every update — confirm the assistant response actually lands in state.
3. **Instrument `isLoading` flips** — log every `setIsLoading(true|false)`
   to see if it's stuck.
4. **Add a component-level render log** (e.g., in the top-level REPL body or
   just below the welcome-vs-messages decision) that prints which branch was
   chosen and the state values that drove the choice. One log per render will
   tell us immediately whether it's "wrong branch" or "right branch, wrong
   state".
5. **Re-examine `AgentModeStatusHeader.tsx`** — it's in the uncommitted
   working tree (git status M) and has `setInterval`/tick state per
   `src/components/CoordinatorAgentStatus.tsx:47–63` pattern. Worth
   checking if AgentModeStatusHeader has an unconditional interval that
   ticks state even when agent mode is inactive.

---

## Files touched this session

- `src/ink/output.ts` — added screen-content sampling to the `High write
  ratio` debug log. Should be kept until the root cause is found; can be
  removed after.

## Files relevant to the investigation but not yet modified

- `src/screens/REPL.tsx` — owns `messages`, `deferredMessages`, `isLoading`,
  and the display-selection logic.
- `src/components/AgentModeStatusHeader.tsx` — uncommitted, possibly
  relevant to interval-driven re-renders.
- `src/ink/output.ts` — has the heuristic; sampling is in place.
- `src/ink/screen.ts` — provides `cellAtIndex` used by the sampler.

## Debug artifacts

- `/Users/pt/.cat-code/debug/8eb4199c-b49a-404a-b22a-b4fdda4615e4.txt`
  (574 lines, 40 storm frames, all sampling identical welcome-box content)
- `/Users/pt/.cat-code/debug/86b63fef-05ca-4621-97c4-2638aa03bbfb.txt`
  (354 lines, 60 storm frames, includes napi error at 10:58:06)

## Related docs

- `docs/bug-structuredoutput-codex-silent-hang.md` — original bug report
  (two bugs, both fixed). The "napi cascade" secondary-issue section is
  partially wrong: napi is a separate bug, not the storm trigger.
- `docs/codex-cache-drop2-context-truncation.md` — unrelated Codex cache work.
- `docs/codex-subagent-failure-swiss-cheese-report.md` — unrelated.

---

## Open questions

1. Why does the welcome box render instead of messages, after state has
   `messages.length === 3`? (Main question.)
2. What triggers the storm to start at `11:06:12.803` — **3 seconds after**
   the response completed at `11:06:09.986`? Something fires in that gap.
3. Why is `blit=0` on every frame even for subtrees that aren't changing?
   Separate from root cause, but suggests the blit cache is invalidated by
   something global (theme? stylePool migration? screen resize?).
4. Is the storm actually *blocking* user input, or just wasteful CPU? We
   have no evidence either way from the current logs; would need to test by
   sending input during a storm.
