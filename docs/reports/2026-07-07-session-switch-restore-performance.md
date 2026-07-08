# Session switch/restore performance — where the latency actually is

**Date:** 2026-07-07 · **Scope:** the desktop app's two "change session" paths — focusing a live
session and restoring a restorable one — traced end-to-end in source and measured with the
production resume path. Deliverable: latency ledger + prioritized fix strategy. No code changed.

## The two click paths (as built, P3-5/P3-6)

1. **Live switch** (tab or sidebar row of a running session): renderer-only. All per-session
   stores stay resident (`app/renderer/src/App.tsx:102-116`); the click sets `activeSessionId`
   and re-renders the pane. No IPC, no engine work.
2. **Restore** (sidebar restore-offer): `bridge.restoreSession(id)` → host validates the registry
   row and re-spawns a **new OS process** (`app/host/host.ts:233-306`, spawn = `bun run
   app/sidecar/index.ts`, `app/main/main.ts:126-135`) → sidecar boots the full engine (`init()`,
   settings/tools/commands, `resumeEngineSession` through the engine's real resume machinery,
   `app/sidecar/index.ts:89-139`) → on attach, history replays as up to **400 frames / 4 MiB**
   of `replay:true` event frames (`decisions/RESTORE-HISTORY.md`) → main forwards **each frame as
   its own `webContents.send`** (`app/main/main.ts:114-120`, `:310`) → the renderer folds each
   frame as its own dispatch set (`App.tsx:163-184`), i.e. one full React render per frame.

## Method

- Timed real cold sidecar boots via the production entrypoint (spawn → `[sidecar] READY`),
  fresh and resuming real transcripts from `~/.cat-code/projects/-Users-pt-cat-code/`.
- Simulated the renderer's per-frame work with the production modules
  (`resumeEngineSession` + `toSDKMessages` + `projectServerFrame` +
  `selectNestedTranscriptRows` + `renderToString(TranscriptRowsView)`), applying the real replay
  caps. Scripts: session scratchpad `time_sidecar.py`, `measure_replay_cost.ts`,
  `measure_render_cost.ts` (rebuildable from this report's numbers; not kept in-repo).
- Caveat: all numbers are **warm-cache, dev build** (`bun run` TS sidecar; renderer from the Vite
  dev server with the unminified React dev build, `app/main/main.ts:88-90,284-285`). Browser DOM
  layout cost is the one thing a headless run cannot measure; it is called out explicitly below.

## Measurements

| Step | Measured |
|---|---|
| Sidecar spawn → READY, fresh session | **0.45 s** |
| Sidecar spawn → READY, resuming the largest transcript on disk (20 MB) | **0.54 s** |
| `resumeEngineSession` alone (in-process) | 115–186 ms |
| `toSDKMessages` of a resumed transcript | ≤1 ms |
| Replay volume, 12 MB / 416-message session | 402 frames → capped to **178 frames / 3.28 MB** |
| Replay volume, 1.4 MB / 221-message session | **212 frames / 1.2 MB** (under cap) |
| Replay volume, 20 MB / 101-message session | 95 frames / 247 KB |
| Projector fold, all 178 frames | 4 ms total |
| `selectNestedTranscriptRows`, all 178 calls | 2 ms total |
| Full `TranscriptRowsView` render (react-markdown, 122 rows / 37 markdown) | **3 ms** (SSR CPU) |
| 178 × per-frame full re-render (today's pattern) | 0.28 s CPU (SSR proxy, **no DOM layout**) |
| One `JSON.stringify(rawLog, null, 2)` for the debug `<pre>` | 2.1 ms → **3.27 MB of text** |
| Cumulative per-frame stringify across one replay | 0.26 s CPU, **428 MB of text produced** |

## Findings (ranked)

### F1 — The engine/host side is NOT the bottleneck

Process spawn + full engine bootstrap + JSONL resume + socket attach is ~0.5 s warm, even for a
20 MB transcript. `init()` (`src/entrypoints/init.ts`) fires its slow parts (account pools, OAuth
populate, API preconnect) as fire-and-forget. Supervisor connect polls at 50 ms
(`app/supervisor/supervisor.ts:402`). Nothing here explains multi-second UX. Any fix effort spent
on warm sidecar pools or resume batching before fixing the renderer is misdirected.

### F2 — The diagnostic raw-JSON `<pre>` is the dominant DOM cost on every switch AND every frame

`SessionPane` renders `JSON.stringify(activeLog.messages, null, 2)` into a
`whitespace-pre-wrap` `<pre>` (`App.tsx:1091-1093`) — the retained raw log is capped at **512
messages / 8 MiB** (`rawMessageLog.ts:5-11`). Measured 3.27 MB of pretty JSON for a mid-size
session; live sessions also retain `stream_event` deltas, so a long-running session pushes toward
the full 8 MiB (→ ~20 MB pretty-printed). The stringify itself is cheap (~2 ms); the unmeasured
part — replacing and re-laying-out a multi-megabyte wrapped text block in the DOM — is the
classic multi-hundred-ms reflow, and it runs:

- **once per replay frame** during a restore (178× for the 12 MB session), and
- **once on every live tab switch**, and
- on every keystroke/connection frame/shell event (F3).

This is P1-2 debugging scaffolding ("Raw SDKMessage events"), not prototype parity. It is the
single highest-leverage deletion in the app.

### F3 — Per-frame IPC × zero memoization = quadratic renders (amplified in dev)

Each frame is one `webContents.send` → one renderer task → one full App render
(`main.ts:114-120` + `App.tsx:163-184`; React batches within a task, not across tasks). A restore
therefore commits 95–400 sequential full renders. Per render, everything recomputes:
`selectNestedTranscriptRows` rebuilds every row object (`transcriptProjector.ts:344-375`),
`TranscriptRowView` has no `React.memo`, every markdown row re-parses
(`TranscriptView.tsx:44-55`), and prompt-draft/connection/shell state all live in the same `App`
state so **typing re-renders the whole transcript**. Pure render CPU measured small (3 ms/render
SSR — real-DOM commit + the F2 reflow is the multiplier), and the dev renderer runs the
unminified React dev build off Vite (`main.ts:88,284-285`), a further 2–5× amplifier the packaged
build won't have.

### F4 — No restore affordance: the wait reads as a hang

`restoreSession` resolves at spawn-initiation (`host.ts:300-305`); the pane sits empty/
"connecting" through boot + replay with rows popping in as frames fold (`App.tsx:517-535`). Even
at ~1–2 s actual, the absence of a skeleton/progress state makes it feel broken. RESTORE-HISTORY
explicitly left the `replay:true` divider treatment to the renderer — unused so far.

### F5 — The caps already bound the worst case (keep them)

Replay is capped 400 frames / 4 MiB, strictly under main's 512 / 8 MiB replay-buffer budgets
(test-enforced, `historyReplayReload.test.ts`), with a visible truncation boundary. The 12 MB
session capped at 178 frames. No change needed; fixes below stay within these envelopes.

## Strategy (priority order)

| # | Fix | Effort | Expected effect |
|---|---|---|---|
| 1 | **Remove/gate the raw `<pre>`**: render nothing until a collapsed `<details>` is opened; cap to last ~20 messages when open | trivial | Removes the dominant reflow from every switch, frame, and keystroke |
| 2 | **Batch frame IPC**: `deliver()` already receives `frames[]` — send one message per batch (new `CH_SERVER_FRAMES` payload), fold the array in one dispatch per reducer | small | Replay = ~1 render instead of 95–400; also smooths live streaming deltas |
| 3 | **Memoize the transcript path**: cache `selectNestedTranscriptRows` per session-slice reference (reducer already returns identical state on no-change), `React.memo` on `TranscriptRowView`/`TranscriptView` | medium | Switch cost ∝ what changed; markdown parses once per content |
| 4 | **Isolate the composer**: move prompt drafts out of the transcript's render tree | small | Typing stops re-rendering the transcript |
| 5 | **Restore affordance**: focus the pane immediately, "Restoring session…" skeleton off the existing `connecting` state, render the `replay:true` boundary as a restored-history divider | small | Perceived latency; makes the residual ~1 s legible |
| 6 | Defer, measure-first: transcript virtualization / `content-visibility: auto`; warm sidecar pool; lighter markdown renderer | — | Only if 1–4 don't get switches <100 ms; boot is 0.5 s so pooling is likely never worth it |

Notes:
- 1–4 are renderer/main-internal — no socket/sidecar protocol change, no security-surface change
  (batching stays behind the same preload `subscribe`; frame validation is unchanged).
- Same-run reopen already dedupes replay by uuid (`rawMessageLog.ts:97-109`, projector
  `seenFrameIds`), so after #2/#3 a session closed and reopened in one app run should render
  effectively instantly from its resident store while replay no-ops.
- Fits one headless-verifiable work session (ANY-tagged), with #5's skeleton wanting one operator
  GUI glance. Suggested acceptance: scripted replay benchmark (fold+render a 200-frame replay in
  one batch, assert single-digit renders), plus before/after `performance.mark` numbers on a real
  restore of the 12 MB session in dev AND packaged profiles.

## Open caveats

- All boot numbers are warm-cache on an idle machine; first spawn after a rebuild (cold Bun
  transpile cache) will be slower. If restore still feels slow after the renderer fixes, add a
  one-line spawn→READY timing log to confirm.
- DOM layout cost of the F2 `<pre>` is inferred (headless can't measure browser reflow); it is
  deleted rather than optimized, so verification is the before/after profile in #5's GUI check.
