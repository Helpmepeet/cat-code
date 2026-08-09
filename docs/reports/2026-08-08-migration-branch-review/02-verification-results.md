# Verification results — what survived

Every one of the 31 scope reports was re-tested by an independent adversarial
agent instructed to **refute**, to default to REFUTED when uncertain, and to
prove reachability positively rather than accept a plausible chain. Reports are
in `verification/V*.md`.

**~424 verdicts. Roughly 66% CONFIRMED, 24% narrowed, 7% dead, plus 9
duplicates.** The reports were substantially right about *defects* and
substantially wrong about *fixes*.

## The headline: findings mostly real, fixes frequently dangerous

At least **ten** proposed fixes would have caused harm if applied as written.
This is the single most important output of the verification pass.

| Proposed fix | What it would have done |
|---|---|
| Mailbox atomicity without a rename-aside | **Creates** the "permanent brick" it was meant to prevent — corruption currently self-heals via the lenient read |
| Raise the stale-lock threshold first | Widens the duplicate-delivery storm from ~10 s to ~60 s |
| `A15-F1` export-slot fix | Generalises the *inverse* bug (a live leg settling FAILED mid-flight, writing a wrong file) to nearly every session |
| `A16` "delete `describeSuggestion`, it is dead" | It is **not** dead (`debugStateReport.ts:15,88`); deletion breaks the desktop typecheck |
| `A19` "both pickers offer bypass unconditionally" | Both **do** gate it at HEAD; the fix would revert another session's deliberate in-flight change |
| `X01-F1` build a DOM harness | Unnecessary as framed — three of four keydown surfaces already extract pure tested modules (`permissionKeyIntent`, `tasksDialogKeyAction`, `overlayEscapeAction`); that pattern needs no dependency |
| `X01-F2` inject a clock for the T7 test | False — 121 frames run in 4 ms and the cap fires deterministically with no production change |
| `X01-F11` assert an error frame on failed analysis | The `catch` only logs; the test would fail |
| `X02a-F1` pass `{mode}` to fix credential permissions | A **no-op** on the in-place writer |
| `S01`/`S05` gate on `pool.initialized` | Racy — `init()` fires `void initAccountPool()` fire-and-forget. Use explicit `loadPool: false` at the two in-process callers |

## Findings that died

- **`persistNextQuarantineProbe` vault death** (the review's most-repeated claim,
  including by the lead). Line 913 writes `{...refreshState, state:'unknown'}` —
  `attempt_id` survives the spread — and persists via `atomicWriteJson`. A repro
  of the exact interleaving ends **healthy with the new token committed**.
  Residual: a clobbered verdict from the unlocked RMW. MED.
- **`settingsSync` bypasses the settings lock.** The whole path sits behind
  `feature('DOWNLOAD_USER_SETTINGS')`, a name in **neither** list in
  `scripts/build.ts`; `feature()` proven false at runtime; its telemetry strings
  absent from the built `cli-dev` while 1,628 other `tengu_*` strings survive.
  Dead in every build this repo can produce.
- **Desktop N-writers amplification.** `touchAll()` never runs in a sidecar
  (`STATE.isInteractive` defaults false); the periodic refresh is a **4-hour**
  timer, not 1 s; the quarantine probe does **zero disk I/O** unless an account
  is already quarantined; N is capped at 4. Healthy state: **zero extra vault
  writers.**
- **`A06`'s rejection-invisibility HIGH.** A `bad_request` frame with no
  `requestId` is *not* invisible — `rawMessageLog.ts:116` consumes every error
  frame regardless, and `App.tsx:4305` paints it above that session's composer.
  Reproduced at runtime. 41 of 49 `sendError` sites already echo a real id.
- **`A06`'s inbound audit table**, as a blanket claim — its worst defect, because
  its purpose is to let a reviewer stop looking. `account.rename` and
  `account.touchAll` have no reject test; the one gap it confessed (`app.abort`)
  *is* covered; three cited test lines exercise a different verb than their row.
- Plus: double-stop, `resolveSystemSubagentName` leak, additional-working-dirs,
  and several smaller ones.

## Findings that got *worse* under scrutiny

- **The orphan reaper.** Dry run only: `--marker bun` — the file's own documented
  override — selects **15 processes to SIGTERM**, including `powerd`, four
  `containermanagerd`, `ctkahp`, `coreautha`, Spotlight, SafariBookmarks, and
  another session's live `bun test app/`. `bun` is a substring of `bundle`.
- **`CH_RESTART` survived a direct end-to-end attack.** Driving the real
  supervisor and real registry produced **121 real child processes, 120 real
  SIGTERMs, zero refusals from any layer**, 120 spawns in **20 ms (~6,000/sec)**.
  Measured, not inferred. (Note: this is the one four-way cross-scope agreement
  that held — agreement remains weak evidence, but it is not disproof.)
- **`liveCount()` lockout reproduces exactly** — 32 parks, zero live engines,
  and `createSession`, `restoreSession` **and** `createSessionInWorkspace` all
  returning `session_limit`. Correction: closing one session frees a slot, so
  "only relaunch recovers" is wrong.
- **The plan-mode bypass**, proven with the real `BashTool` and `FileWriteTool`:
  in plan mode `curl … | sh` and a file write both return `allow` with
  `prompted=false`. And with a managed `disableBypassPermissionsMode: "disable"`
  policy the engine computes `false` and **the sidecar overwrites it to `true`**
  — it defeats enterprise policy. A killswitch **does** exist
  (`bypassPermissionsKillswitch.ts:19`, plain async, not React-only) and is
  simply never called in `app/`. **Two-line fix.**
- **`AskQuestionFlow` keystroke hijack, reproduced in a real DOM.** The verifier
  built the harness the package lacks (happy-dom, real React 19 mount, real
  `KeyboardEvent`s): Escape in the composer denies the request, Enter sends the
  answer alongside the message, typing `ok 2 jobs` **loses five of nine
  characters**, and `o` moves focus out mid-sentence. Negative control passes; a
  real `<input>` is correctly ignored. Decisive: same element, `tagName` guard
  bails = false, `isContentEditable` guard bails = true.
- **The context gauge contradiction reproduced** — donut reading 84% beside a
  glyph reading "0% left" at 167k on a 200k model, reachable since blocking is
  177k.

## New findings the original review missed

Found only because verification went looking:

1. **`updateActiveClaudeAccountTokens` writes to `pool.activeIndex` at call
   time**, not the account whose refresh token was spent — one account's rotated
   credentials land in another's vault file and pool entry. Proven by repro.
2. **`handleSetMode` never enforces `isBypassPermissionsModeAvailable`** despite
   three HEAD comments asserting it does. At HEAD the only gate on
   `bypassPermissions` is the renderer's own `disabled` attribute.
3. **`run-hardening-smoke.ts:77-84` never checks `spawnSync`'s `error`.** A
   timeout leaves `status: 0` with `error: ETIMEDOUT`, so an orphaned sidecar
   makes the harness hang 20 s and **still print green**. One `|| smoke.error`
   is the highest-value line in that scope, and it explains why the leak never
   announced itself.
4. **An always-allow rule can be applied without the user seeing it selected** —
   with no hint and no highlight painted, ArrowDown + Enter fires `onAllow([0])`.
5. **Inverse export bug** — a stale `null` slot settles a *new* leg as FAILED
   while its export is in flight, writing a wrong file.
6. **`killOrphanedTeammatePanes` reads `members`**, which the failed spawn step
   never wrote, so a pane survivor escapes the leader's own SIGINT cleanup.
7. **A transient parse failure silently discards the whole mailbox** (the same
   lenient read that provides the self-healing).
8. **Degraded-empty plugin load** feeds `getInstalledVersionPaths()`, which
   returns an empty Set instead of null, so the orphan sweeper marks every cached
   plugin version orphaned and deletes it after 7 days.
9. **`.gitignore:3`'s bare `cli`** makes `rg` silently skip all of `src/cli/**`
   during traversal and hides new files from `git status` — the same shape as the
   old NUL-byte blind spot. Fix: anchor to `/cli` and `/cli-dev`.
10. **Raw sidecar diagnostics already render to the user** (`unexpected key "foo"
    on settings.setValue`) — a §7 violation that exists *because* `A06` inverted
    its own surfacing conclusion.

## Clean bills that did not survive

- **`A10`'s preload allowlist.** By mutation against the test's own regexes, an
  unguarded `ipcRenderer.send('catcode:exfiltrate', …)` and an unguarded
  literal-channel `invoke` both **pass**; the 29-occurrence pin fires only on a
  *guarded* addition. The real backstop is `hardening-smoke`'s 30-key bridge
  allowlist — a different command — and it misses an unguarded send added inside
  an existing method.
- **`A07`'s reference-identity claim**, refuted with four live counterexamples;
  two are uncompensated, so every mousedown inside the active panel mints a fresh
  layout object and re-renders the workspace.
- **`A09`'s registry lock.** A sibling **proved** the advisory lock does not
  prevent a lost update: 25 rows written, all of writer B's lost, and **every
  existing assertion still passes with the lock replaced by a no-op.**

## Clean bills that held

`A14`'s seven were attacked hardest and survive — main really never opens a
`.jsonl`, the main↔worker validator really is shared, parses really degrade
per-line (one phrasing broke: a renderer id does reach `join()`, behind
`canPreview` + `isUuid`). Provider routing is genuinely fixed. The v2 mailbox
authority layer fails closed across eight forgery scenarios with two positive
controls. `sidecar-typecheck`'s filter re-proven correct — 5,560 diagnostics,
zero absolute paths, an injected owned error drives `exit(1)` — so a green run
genuinely means zero owned diagnostics. `prepare-dev-electron` re-derives.

## Provenance — what actually blocks this branch

Verification tagged provenance per finding. **The large majority of `src/`
findings are pre-existing on `main`**: all 11 account-pool, all 13 atomic-write
sweep, 11/16 swarm, 4/6 mailbox writes, and the `--bare` policy branch (root
commit `86051a8`; only `corePolicy.ts` is branch-new).

**Branch-blocking, confirmed:**
1. The plan-mode permission bypass (`app/`, uncommitted) — defeats managed policy.
2. `buildCodexStatus` / `loadPoolForObservation` (`S05` HIGH#1) — `codexStatus.ts`,
   `deferredContinuation*.ts` and `continue-after-limit.tsx` do not exist on
   `main` (all from `44f45b1`). The only branch-blocking finding in that scope.
3. The seven desktop `D-` findings, branch-new by construction.

Everything else is inherited debt that this branch did not introduce.

## A correction the lead owes the record

The lead stated, repeatedly and with confidence, that `persistNextQuarantineProbe`
was "the headline finding of the entire review" and "the 2026-07-05 vault
destruction returning", and separately that the desktop turned it into
near-continuous exposure via N concurrent writers. **Both were wrong**, and the
error is instructive: every sub-link of the chain was independently true
(`touchAll` does not skip quarantined accounts, the probe does race init, the
single-flight is bypassed, the recovery arm's condition would be false), which is
exactly what made the false conclusion feel proven. A chain of true links ending
in a false conclusion is the failure mode this review most needs to guard against
— and it is why the verification pass paid for itself.

One further reconciliation: the lead observed no orphaned sidecar after running
`test:hardening` and treated that as evidence against `A20`. It was evidence of
nothing — **no Electron launch of this app happened that day** (zero `08-08`
`/tmp/catcode-*` directories; the app-support dir last touched `08-07 22:15`),
so that run never reached its Electron stage.
