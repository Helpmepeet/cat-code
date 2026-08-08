# Triage — what is worth doing

## Decision (2026-08-08) — start here next session

**At the time of this decision, no repo fixes had been applied.** One thing was
changed outside the repo: the operator ran `chmod 700` on both vault directories
and `chmod 600` on the seven token files. Verified: zero group- or world-readable
JSON remains in `~/claude-vault` or `~/codex-vault`.

### Remediation log

#### 2026-08-08 — first safe stabilization wave (`b8d9c6e`)

Committed six confirmed, verified-safe findings from Group B:

1. `run-hardening-smoke.ts` now fails if Electron's `spawnSync` reports an
   error, including `ETIMEDOUT`.
2. `.gitignore` now anchors `/cli` and `/cli-dev`, so `src/cli/**` is not ignored.
3. `liveCount()` excludes terminal supervisor tombstones from the live-session cap.
4. An empty tag query no longer writes the first matching tag.
5. `primeCodexEvents` closes its source iterator after an initial
   `response.failed`, releasing the queued WebSocket turn.
6. `AskQuestionFlow` ignores key events from `contentEditable` composer targets.

Evidence: `bun test app/` (2,802 pass), both app typechecks, renderer build,
the focused Codex adapter suite (70 pass), and `bun run build:dev:full` all
passed. `bun run --cwd app test:hardening` remains GUI-gated and was not run.

**Agreed scope for the fix session: everything that survived verification, except
LOW — filtered on verdict and fix-safety, not on the severity label.**

Two filters per finding, both already answered in `verification/V*.md`:

1. **Did it survive?** CONFIRMED or PARTIALLY CONFIRMED — not INVALID,
   OVERSTATED, or DUPLICATE.
2. **Is the fix safe as written?** Not one of the ten in
   `02-verification-results.md`.

That admits roughly **~210 of the 242 HIGH+MED**, plus ~15 LOW one-liners that
meet the operator's criteria, and excludes ~40 that are dead or harmful.

**Why not cut on severity alone**: the labels were assigned by 31 different
agents with no shared standard, ~31 findings are already dead across all
severities, and the ten dangerous fixes are spread through HIGH and MED — so a
severity cut keeps every one of them.

### Operator's stated criteria for "interesting"

Asked directly. In priority order:

1. **Confidently wrong output** — the system states something false with no
   error. This is the top category and it is the one **logs cannot catch**: the
   gate prints green, the gauge shows 84%, the pool says `healthy`, the spawn
   tool says "Spawned successfully". Nothing crashes, so nothing is logged.
2. **Destroys something** — transcripts, credentials, plugins, messages.
3. **Cheap and closes a hole** — one or two lines, verifiable.

Explicitly **not** a criterion: "teaches me something about the system." Insight
for its own sake is out. That removes the naming collisions, the dead
`TeammateExecutor` layer, the god-file splits, and the perf chains.

Context that shapes the cut: **nobody is hitting any of this yet** (pre-release,
no user pain today), and the operator does not read the code directly — agents
review it for them. **So four items matter more than their severity suggests,
because they are the operator's tooling lying to their agents**: the hardening
gate that prints green while hanging, the registry test that asserts a lost
update is fine, the three comments claiming a bypass gate that does not exist,
and the "Spawned successfully" string on a failed delivery.

### The one thing still missing

An **ordered wave plan**. Selection is settled; sequence is not. Four known traps
where fixing A before B makes things worse:

- mailbox atomicity before the ack guard → widens duplicate delivery ~10 s → ~60 s
- raising the stale-lock threshold before the ack guard → same
- the export-slot fix without its inverse → breaks nearly every session
- credential `{mode}` alone → no-op on the in-place writer; looks fixed, is not

At 200+ fixes across a tree three sessions write to, expect more that only appear
in sequence. Batch in waves, gate each on `bun test app/` + both typechecks +
hardening, **commit per wave**, and bind paired fixes into single units.

---

409 findings, ~424 verification verdicts. Nobody is fixing all of them, and most
should never be fixed. This file groups them by **whether the work pays for
itself**, not by severity label.

Everything below is CONFIRMED or better in `verification/`. Anything the
verification pass killed, narrowed to nothing, or flagged as a dangerous fix is
in Group F at the bottom — deliberately, so it does not get quietly re-adopted.

Rule for anyone acting on this: **read the finding's `verification/V*.md` entry,
not just the scope report's "Fix" line.** Ten proposed fixes would have caused
harm as written.

---

## Group A — Merge blockers (3)

Only these three are branch-new *and* consequential. Everything else in this
review is inherited from `main`.

| # | What | Fix |
|---|---|---|
| A1 | **Plan mode is a full permission bypass.** `sessionController.ts:163` hardcodes `isBypassPermissionsModeAvailable: true`, replacing a `PERMISSION-BOUNDARY.md` §3 trusted-surface gate. Proven with real `BashTool`/`FileWriteTool`: `curl … \| sh` returns `allow`, `prompted=false`. **Defeats managed `disableBypassPermissionsMode: "disable"` policy** — the engine computes `false` and the sidecar overwrites it. | Two lines: call the existing `checkAndDisableBypassPermissionsIfNeeded` (`bypassPermissionsKillswitch.ts:19`, plain async, not React-only), or restore the env gate. **Coordinate — this is another session's uncommitted edit.** |
| A2 | **`buildCodexStatus` inverts its own verdict.** `loadPoolForObservation()` replaces the live pool; cap state is memory-only, so every capped account reads `healthy` and `/continue-after-limit` tells an exhausted user an account is available. Reproduced: `wait`/`schedule` → `delegate`/`run_now`, emitted JSON says `routing_state=candidate` beside `usage.allowed=false`. | Explicit `loadPool: false` at the two in-process callers. **Not** the report's `pool.initialized` gate — racy, because `init()` fires `void initAccountPool()`. |
| A3 | **The seven desktop `D-` findings** in `X02a`, branch-new by construction. Chief among them D1, the context-gauge divisor (see C3). | Per-finding; see `V30`. |

---

## Group B — One-liners worth doing immediately (6)

Highest value per minute in the whole review. Each is a single line or a deleted
branch, each CONFIRMED, each with a verified-safe fix.

1. **`run-hardening-smoke.ts:77-84` never checks `spawnSync`'s `error`.** A
   timeout leaves `status: 0` with `error: ETIMEDOUT`, so your security gate
   **hangs 20 s and still prints green.** This is why the sidecar leak never
   announced itself. → add `|| smoke.error`.
2. **`.gitignore:3`'s bare `cli`** makes `rg` silently skip all of `src/cli/**`
   during traversal and hides new files from `git status`. Same shape as the old
   NUL-byte blind spot that produced a wrong answer twice. → anchor to `/cli`
   and `/cli-dev`.
3. **`liveCount()` counts dead tombstones.** Reproduced: 32 parks, zero live
   engines, and `createSession`, `restoreSession` **and**
   `createSessionInWorkspace` all return `session_limit`. → filter tombstones.
   (Correction to the source report: closing one session frees a slot, so it is
   not "relaunch only".)
4. **Enter on an empty tag query writes a tag**, and on the bulk bar to every
   selected session, then clears the selection. → delete the
   `else if (matches[0])` arm; `resolveTagCommit` already encodes the decision.
5. **`primeCodexEvents` abandons its iterator on `response.failed`**, wedging the
   per-conversation WS turn queue until a 10-minute timeout. Verified: the
   one-line `iterator.return()` makes turn 2 resolve. (`main` is worse — no
   `AbortSignal` at all.)
6. **`AskQuestionFlow` guards `INPUT`/`TEXTAREA` by tag name** while the composer
   is `contentEditable`. Reproduced in a real DOM: Escape denies the request,
   Enter sends the answer, typing `ok 2 jobs` **loses five of nine characters**.
   → use `isContentEditable`, or better, extract a pure key module (see E1).

---

## Group C — Real, but the fix needs design (6)

Do these deliberately. In each case the obvious fix is wrong, and verification
says why.

- **C1 — Credential file modes.** Directories are now `0700` (done, durable).
  Files still revert to `0644` whenever `saveCodexTokenToVault` writes. Six
  writers across both pools plus `accountsDomain.ts:277`. **The report's `{mode}`
  fix is a no-op on the in-place writer** — needs a real create-with-mode or a
  chmod-on-load.
- **C2 — Mailbox atomicity.** Real, but corruption currently **self-heals** via
  the lenient read. Adding temp+rename *without* a rename-aside **creates** the
  permanent brick. Also: raising the stale-lock threshold before adding the ack
  guard widens the duplicate-delivery storm from ~10 s to ~60 s. Measured: 11
  deliveries of one message in 14 s; past ~668 ms the ack fails permanently.
- **C3 — Context percentages.** Eleven surfaces, three denominators, two
  numerators. Reproduced: donut 84% beside a glyph reading "0% left" at 167k on a
  200k model. `A16`'s premise is false twice over, and its third citation sits
  behind flags absent from `scripts/build.ts` (compiled out). The fix breaks
  `runControlsDomain.test.ts:393-407` and cannot reach the preview donut.
  **Unify deliberately, with the full table in `V14`.**
- **C4 — Bulk-export hang** (reproduced) and its **inverse** (a stale `null` slot
  settles a live leg as FAILED mid-flight, writing a wrong file). `A15-F1`'s
  proposed fix **generalises the inverse bug**. Fix both together or neither.
- **C5 — Registry lost update.** Proven: 25 rows written, all of writer B's lost,
  and **every existing assertion still passes with the advisory lock replaced by
  a no-op.** The lock does not do what the test implies. Needs read-merge, not
  more locking.
- **C6 — `sessionStorage` silent loss.** A failed append silently discards a
  batch. ("Permanent poisoning" was narrowed — `scheduleDrain` recovers.) Still a
  silent write-loss on the user's transcript, reachable via EACCES/EROFS/EDQUOT.

---

## Group D — Safety and hygiene, not urgent (4)

- **D1 — The orphan reaper.** `--marker bun` — its own documented override —
  selects **15 processes to SIGTERM**, including `powerd`, four
  `containermanagerd`, Spotlight, and another session's live `bun test`. `bun` is
  a substring of `bundle`. → drive from registry pids; the correct pattern is at
  `registry.ts:531-543`. Nobody is running this by accident, hence not Group B,
  but the blast radius is the worst in the review.
- **D2 — `handleSetMode` never enforces `isBypassPermissionsModeAvailable`**
  despite three HEAD comments claiming it does. Independent of A1; fix both.
- **D3 — `updateActiveClaudeAccountTokens` writes to `pool.activeIndex`** at call
  time, not the account whose token was spent — one account's rotated credentials
  land in another's vault. Pre-existing, multi-account only. → take an explicit
  `accountUuid`.
- **D4 — Harness `app.exit()` orphans a 282 MB sidecar** (self-exits at the
  15-min idle TTL, so bounded). Fix alongside B1, which is what makes it visible.

---

## Group E — Structural investments (3)

These change the slope rather than fixing a point. Worth scheduling; not worth
doing reactively.

- **E1 — Pure key-decision modules.** The suite executes **zero** events: 77
  effects, 12 global listeners and ~274 handlers never run. But the fix is *not*
  the DOM harness the report prescribes — **three of four keydown surfaces
  already extract pure tested modules** (`permissionKeyIntent`,
  `tasksDialogKeyAction`, `overlayEscapeAction`). The two that keep it inline
  (`AskQuestionFlow`, `App.tsx:2325`) are exactly the two shipped bugs. Apply the
  existing in-repo pattern; no dependency, no sign-off.
- **E2 — `hardening-smoke` covers no sidecar boundary.** 19/19 is
  renderer/CSP/navigation only, and 5 of its checks can report PASS vacuously.
  Stop citing it as evidence for boundary changes; add sidecar frame cases.
- **E3 — God files.** `App.tsx` (3,033-line function, 146 hooks, 17
  responsibilities) and `sidecarServer.ts` (4,262 lines, ~1,900 with an existing
  home). **Stage these** — `V01` warns the proposed one-shot move shortens the
  file but not `App()` itself.

---

## Group F — Batchable to agents (most of the remaining ~310)

**An earlier draft of this file said "do not do" here. That was wrong** — it
priced the work in human hours. With agent capacity the marginal cost of a small
fix is near zero, and this review's own evidence refutes dismissing LOWs
wholesale: `.gitignore`'s bare `cli` and the `spawnSync` error check are both
small findings with outsized effect.

**The binding constraint is not effort. It is detectability.** ~10 proposed fixes
would have caused harm, 7% of findings were invalid, the renderer suite
dispatches zero events, and the hardening gate prints green while hanging. So the
question per finding is not "is it worth the time" but **"if an agent gets this
wrong, does anything tell us?"**

Group by oracle strength, then batch.

### F1 — Strong oracle, batch freely

A wrong fix fails a check that already exists. Send these to agents in waves,
gate each wave on `bun run --cwd app typecheck` + `bun test app/` +
`bun run --cwd app typecheck:sidecar`, and commit per wave.

- **Dead-export and dead-file removal.** The oracle is the typecheck itself —
  verification proved it works, by catching `describeSuggestion` (claimed dead,
  actually live, deletion breaks the build). Trust the compiler, not the grep.
- **Type tightening**: `as` casts, `any`, non-null `!`, missing `never`
  exhaustiveness tripwires. Compiler-checked by construction.
- **User-visible text**: em dashes, engineering vocabulary, raw ids and internal
  plane words rendered to users. Mechanically greppable, visually checkable.
- **Missing reject-invalid boundary tests** for inbound frame kinds. The new test
  *is* the oracle. Note `A06`'s audit table is INVALID as a blanket claim, so
  derive the gap list from source, not from that table.
- **Duplication extraction** where the affected code already has tests: the ten
  byte-identical snapshot senders, the seven near-identical snapshot domains, the
  ~12 copy-pasted verb-dispatch try/catch blocks.
- **Naming and convention drift**: `create/reduce/select` outliers,
  `createSidecar<X>Domain` non-conformance, Fast Refresh boundary violations
  (`lint:fast-refresh` is the oracle).

### F2 — Weak oracle, one at a time with a written argument

Nothing in this repo will catch a wrong fix here. Agent effort is still fine —
agent *autonomy* is not. Require a repro before and after, and treat the absence
of a failing test as the default state rather than a reason to proceed.

- Anything touching concurrency or shared-file state (the suite cannot see a lost
  update — proven: every assertion passes with the lock replaced by a no-op).
- Anything interaction-shaped: keyboard, focus, scroll, effect ordering. **Zero
  events are dispatched anywhere in the package.**
- Anything permission-, credential-, or policy-related.
- Any finding whose proposed fix verification flagged as wrong — Groups C and F3.

### F3 — Genuinely do not do (~41)

- **The ten dangerous fixes** in `02-verification-results.md`. Three create the
  exact bug they were meant to prevent.
- **Everything verification killed**: `persistNextQuarantineProbe` vault death,
  the desktop N-writers amplification, `settingsSync` (dead behind an unregistered
  feature flag), `A06`'s rejection-invisibility HIGH and its inbound audit table,
  the `describeSuggestion` deletion, and the rest of the ~31 INVALID/OVERSTATED.

Before batching anything from a scope report, check its `verification/V*.md`
entry first — that is where the ~41 are marked.

---

## The one-line summary

**Do Group A before merging. Do Group B this week — six lines, two user-visible
bugs, one lying test gate. Schedule C and E. Batch F1 to agents in oracle-gated
waves. Hand-hold F2. Skip the ~41 in F3.**

Most of this review is inherited debt from `main`, not a verdict on the branch.
