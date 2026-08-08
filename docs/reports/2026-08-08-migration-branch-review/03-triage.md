# Triage — what is worth doing

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

## Group F — Do not do

- **The ten dangerous fixes**, listed in `02-verification-results.md`. Three
  create the exact bug they were meant to prevent.
- **Anything killed by verification**: `persistNextQuarantineProbe` vault death,
  the desktop N-writers amplification, `settingsSync` (dead behind an
  unregistered feature flag), `A06`'s rejection-invisibility HIGH and its inbound
  audit table, and the "`describeSuggestion` is dead" deletion (it is live;
  deleting it breaks the typecheck).
- **The 167 LOW findings**, except where one happens to sit in a file you are
  already editing. They are real and they are not worth a pass of their own.
- **Most of the 181 MED**, for the same reason. Verification narrowed a large
  share of them, and the ones that mattered were promoted into Groups A–D above.

---

## The one-line summary

**Do Group A before merging. Do Group B this week — it is six lines and closes
two user-visible bugs plus a lying test gate. Schedule Group C and E. Leave the
rest.**

Most of this review is inherited debt from `main`, not a verdict on the branch.
