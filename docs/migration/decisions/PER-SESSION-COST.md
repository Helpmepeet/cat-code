# Per-session cost — evaluation + shared-engine spike

**Status: EVALUATION / tracked spike, 2026-07-14. Does NOT reopen a locked
decision.** N-process (one engine process per session, `TRANSPORT.md` §P0-4)
stays as-is. This records *what a session actually costs*, *why it costs that*,
what is reducible without reopening, and the criteria under which reopening
N-process would be justified — so the question is not re-litigated from scratch
each time the "sessions feel heavy" instinct recurs.

Prompted by the operator (2026-07-14): "cost per session should not be this
much" — raised while discussing auto-reconnect-on-launch (parked; see the
reframe below for why the two are linked).

## TL;DR

- A live session is **~200 MB+ RSS** and **~1–3 s to spawn**, dominated by a
  **~189 MB engine-code load paid independently by every process** (the
  N-process tax). Measured, not estimated (method below).
- That floor is **inherent to N-process** and **not reducible by worker
  threads** (each worker re-imports the graph). The only lever that moves it is
  a **shared engine** — which means **reopening P0-4**, blocked by the engine's
  process-global mutable state (the working directory in `src/utils/Shell.ts` —
  module-level `cwd` + `setCwd` at :447 — and the session id in
  `src/bootstrap/state.ts`), the exact "out-of-scope engine refactor" P0-4 cited
  as *why* N-process was chosen. (Note: P0-4's own `state.ts:435` anchor has
  since drifted — no `src/state.ts` exists; the verified anchors are here.)
- **The current model is already cheap at rest:** an idle/restorable session is
  a registry row with **zero process cost**. You pay only for sessions with a
  *live* process. So the real cost knob is **concurrency (how many are live at
  once)**, not per-session bloat — and that is why aggressive auto-load is the
  wrong trade (it converts free cold rows into ~200 MB live ones).
- **Recommendation:** keep N-process; manage concurrency (a live-session cap +
  the existing CC-3 idle-TTL); do the cheap startup wins if launch latency
  bites. Treat the shared-engine refactor as a real but major engine project
  behind an explicit P0-4 reopening, never a drive-by.

## Measured data

Loading the engine graph a sidecar imports to build a session
(`app/sidecar/sessionController.ts` → `createNormalSidecarQueryEngineConfig`),
imports only — no socket, no turn, no account/network:

| | RSS |
|---|---|
| Bun runtime baseline | 21 MB |
| + engine graph (`AppSessionController` + `createRuntimeBackedWebAppSession` + `tools` + `commands`) | 210 MB |
| **→ engine code alone** | **~189 MB**, ~311 ms to parse/compile |

For scale: the **entire app shell** is Electron main ~135 MB + renderer ~70 MB.
**One session's engine code outweighs the whole UI**; the 3rd live session
outweighs main + renderer combined.

This ~189 MB is a **floor**. On top of it a real spawn adds runtime state +
eager startup IO that `createNormalSidecarQueryEngineConfig` `await`s per
session: `getCommands` (skills/plugins off disk), agent defs, the extensions
snapshot, the **cross-workspace sessions-catalog enumeration**
(`createSidecarSessionsCatalogDomain`), workspace-trust, diagnostics. Realistic
live RSS **~250–350 MB**, spawn **~1–3 s**.

**Method / caveats.** Measured on the dev (non-compiled) engine via a throwaway
Bun process that imports the four modules above and diffs
`process.memoryUsage().rss` (script: session scratchpad, not committed). It is
the *import* floor (parse + compile + resident code), so live RSS is higher and
the compiled binary may differ somewhat; the order of magnitude (~200 MB/live
session) is the load-bearing fact, and it matches the CC-3 field evidence (42
orphaned sidecars ≈ 2.5 GB → ~60 MB *idle-after-GC* each, consistent with a
~200–350 MB working set that shrinks when quiet).

## Why it costs that — and why N-process makes it irreducible

It is a **code** cost, not a data cost: N-process means every session process
independently imports and JIT-compiles the *whole engine*, so the ~189 MB is
paid **N times**.

- **Worker threads do not help.** A Bun/Node worker gets its own module realm →
  re-imports the graph → still ~189 MB/worker. Only *true sharing* (one engine
  instance, session context passed per call) pays it once.
- **True sharing = reopening P0-4.** P0-4 already found why single-process is
  blocked: the engine keeps its "current" context in **process-global mutable
  state** — the working directory as a module-level `cwd` in `src/utils/Shell.ts`
  (`setCwd` at :447) and the session id in `src/bootstrap/state.ts` — and mutates
  it **per submit** (`src/QueryEngine.ts:245` calls `setCwd(cwd)`). One process
  cannot safely run N concurrent sessions while "current cwd / session" is a
  process global; fixing it means threading session context through the engine
  instead — a large, cross-cutting refactor. That refactor being out of scope is
  *the reason* N-process was chosen; the cost only quantifies the prize, it does
  not change the calculus. (P0-4's recorded `state.ts:435` anchor has drifted —
  no `src/state.ts` today; the anchors above are re-verified from source.)

## The reframe that actually matters (cold-at-rest)

The current design is already cost-smart for the common case:

- A **restorable/dead** session is a durable registry row + on-disk transcript —
  **0 process cost**. Twenty old sessions cost nothing until clicked.
- You pay ~200 MB **only for a session with a live process**.
- Therefore the cost is entirely a function of **how many sessions are live
  simultaneously**, not of any per-session waste we can trim away.

This is why **auto-reconnect-on-launch** (the discussion that surfaced this) is
the wrong default: it trades the free cold rows for N × ~200 MB of live ones +
N usage polls + a multi-second launch stampede. The lazy "cold until you click"
model is the right default; convenience there should be *bounded concurrency*,
not eager mass-spawn.

## Reducible WITHOUT reopening N-process (cheap wins, ranked)

These cut **startup latency** and some memory; they do **not** touch the
~189 MB code floor.

1. **Load the sessions-catalog once** in host/main and pass it in, instead of
   every sidecar re-enumerating every workspace's transcripts
   (`createSidecarSessionsCatalogDomain` runs per spawn today — redundant heavy
   IO × N).
2. **Lazy-load cold subsystems** (MCP, `codex-core`, rarely-used tools) until
   first use, so a session that never touches them never pays their import.
3. **Bytecode / compiled bundle** to cut the ~311 ms parse per spawn
   (`bun build --compile`; P0-1 already proved a runnable ~159 MB binary).
4. **Cap concurrent live sessions** — a soft LRU that idle-TTLs the
   least-recently-used. CC-3 already does the reaping; this makes a *cap* the
   policy (and is the safe enabler for a *bounded* auto-reconnect later).

## When reopening N-process WOULD be justified (reopen criteria)

Reopen P0-4 only if ALL hold:

1. **Cheap many-live-sessions becomes strategically required** — e.g. the
   always-on vision needs, say, 10+ genuinely-live sessions at once, and the
   cap+idle-TTL policy above is demonstrably insufficient for the workflow.
2. The cheap wins (§ above) have shipped and the **floor** (not startup IO) is
   the proven bottleneck.
3. There is appetite for the **`STATE`-threading engine refactor** as its own
   project (spike → migration lane), with the P0-4 isolation evidence re-run.

Absent those, N-process is the correct call and this doc is the standing answer
to "why is a session so heavy."

## Cross-references

- `TRANSPORT.md` §P0-4 (N-process decision + the `STATE` singleton evidence).
- `SESSION-LIFETIME.md` (die-with-window L2; the lifetime model this cost lives under).
- `STATUS.md` CC-3 (idle-TTL + reap — the existing concurrency-cleanup mechanism).
- `STATUS.md` CC-4 (this doc's tracking row).
- `app/sidecar/sessionController.ts` `createNormalSidecarQueryEngineConfig` (the eager per-spawn load path).
