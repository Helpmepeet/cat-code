# Synthesis, verification log, and fix plan

Companion to `README.md`. The 30 scope reports hold the findings; this file holds
what only the review lead saw: what was verified first-hand, what was corrected
mid-review, which findings compound with each other, which agreements are real
corroboration versus anchoring, and what order to fix things in.

Read this before acting on any individual report.

---

## 1. Verification log — claims checked first-hand in source

Every scope report is an agent's work. These specific claims were re-verified by
the lead by reading source or running a command, and can be treated as fact
rather than as a report to be trusted.

### 1.1 Credential vault is world-readable

```
$ ls -ld ~/claude-vault ~/claude-vault/accounts
drwxr-xr-x@ 3 pt  staff  /Users/pt/claude-vault
drwxr-xr-x@ 4 pt  staff  /Users/pt/claude-vault/accounts
$ ls -l ~/claude-vault/accounts
-rw-r--r--@ 1 pt staff 1014 6261be8f-….json
-rw-r--r--@ 1 pt staff 1015 d8853123-….json
```

The vault lives at `~/claude-vault` (`DEFAULT_VAULT_PATH`,
`claudeAccountPool.ts:58`), **not** under `~/.cat-code`. The files hold
`tokens.access_token` and `tokens.refresh_token` per `saveClaudeTokenToVault`.
Mode `0644` in a `0755` directory means any process not running as the owner can
read live refresh tokens. Nothing was modified.

### 1.2 Plan-mode permission bypass — all three legs

The diff (uncommitted at review time):

```diff
-    // PERMISSION-BOUNDARY.md §3: bypass is only grantable from a TRUSTED
-    // surface. ... Read here at session construction — NEVER from a renderer
-    // frame — so a browser-like renderer cannot self-escalate. Off by default;
-    isBypassPermissionsModeAvailable:
-      process.env.CATCODE_ALLOW_BYPASS === '1',
+    // Bypass is an explicit session mode in the desktop app. The engine's own
+    // bypass killswitch remains authoritative when the mode is applied.
+    isBypassPermissionsModeAvailable: true,
```

The engine consumer, `src/utils/permissions/permissions.ts:1286`:

```ts
const shouldBypassPermissions =
  appState.toolPermissionContext.mode === 'bypassPermissions' ||
  (appState.toolPermissionContext.mode === 'plan' &&
    appState.toolPermissionContext.isBypassPermissionsModeAvailable)
if (shouldBypassPermissions) return { behavior: 'allow', ... }
```

And `rg 'ypassPermission' app/ --glob '!*.test.*'` returns only the hardcode
itself, a snapshot passthrough at `sidecarServer.ts:3982`, protocol type
definitions, and renderer display labels. **No killswitch call exists in
`app/`** — the compensating control named in the replacement comment is not
there.

### 1.3 Socket directory

`supervisor.ts:191-195` — `/tmp/catcode-${process.pid}`, `mkdirSync(dir,
{recursive:true})` with no `mode`, guarded by `existsSync`. On this machine all
99 `/tmp/catcode-*` directories are `drwxr-xr-x`. The count itself is evidence
that `shutdown()`'s `rmSync` routinely does not run (see §3.2).

### 1.4 `persistNextQuarantineProbe`'s missing guard

`codexTokenRefresh.ts:892` — the sole guard is
`if (refreshState.state === 'reauth_required') return`. It does not skip
`in_flight`. The comment immediately above it describes the function as "an
unlocked read-modify-write that overwrites `state` and `reason`" and reasons
about clobbering a concurrent process's verdict. The author identified the
hazard and guarded one state short of the destructive case.

### 1.5 `agentTypeMeta` prototype index

`agentIdentity.ts:244` — `AGENT_TYPE_META[type as AgentTypeKey] ?? {…}` where
`type` is a model-supplied `subagent_type`. For `constructor`, `toString`,
`valueOf`, `hasOwnProperty` the index resolves to an `Object.prototype` member,
which is truthy, so `??` never fires and the caller receives a function where it
expects `{label, color, tone}`. The `as AgentTypeKey` cast is what suppresses the
compile error that would otherwise catch this.

### 1.6 Settings stale-array merge (peer session's HIGH)

`Config.tsx:508` passes `{ permissions: { ...settingsData?.permissions,
defaultMode } }` — a render-time snapshot. The object branch of
`updateSettingsForSource` merges with a customizer whose own comment reads *"For
arrays, always replace with the provided array — This puts the responsibility on
the caller to compute the desired final state."* Four lines above, the updater
branch carries a comment naming this exact hazard. The object form is the
historical `persistPermissionUpdates` lost-update reachable through a different
call form.

### 1.7 Batteries

`bun test app/` 2799/0 · `bun run --cwd app typecheck` clean ·
`typecheck:sidecar` clean (5560 upstream ignored) · `test:hardening` 19/19.
All green before and independent of every finding in this review — which is
itself the most important fact in `X01-test-quality.md`.

---

## 2. Correction log

Claims that were stated during the review and then corrected. Recorded because
they calibrate how much to trust the rest, and because two of them changed where
a bug actually lives.

| Original claim | Correction | Caught by |
|---|---|---|
| The context-breakdown throw fails for every Codex-only user | The throw at `auth.ts:284` is gated behind `CI \|\| NODE_ENV === 'test'`. It fires in test runs, not production, where `isCodexSubscriber()` short-circuits first. The floor-disarm finding stands on its own mechanism. | A13 agent |
| The context gauge diverges desktop-vs-engine | Wrong attribution. The desktop gauge **matches** `/context`. The divergence is engine-internal: `/context` disagrees with `StatusLine` and `TokenWarning`. Three denominators, two numerators, ~1% vs ~44% on a cached turn. | S07 agent |
| `spawnMultiAgent.ts` is a near-total rewrite (+537/-535) — find what it removed | Not a rewrite. ~500 lines are re-indentation from wrapping handlers in `try { … } catch { tombstone; throw }`. Only two helpers were removed, both correctly superseded. The lead's premise came from numstat and anchored the prompt; the agent refused it. | S03 agent |
| `app.abort` has no reject-direction boundary test | It does — `sidecarServer.test.ts:381`, and the test's comment records that gap in past tense. Relayed from A06 without checking. | X01 agent |
| `attachments.ts` +212 needs a path-traversal and NUL audit | That +212 is entirely teammate-mailbox work; there are no changes to attachment path handling. NUL introduction is a **verified negative** — every write path goes through `JSON.stringify`, which escapes U+0000. | S07 agent |
| Renderer self-escalation via `permission.setMode` follows from the bypass diff | Caught before reporting. Neither `handleSetMode` nor `permissionDomain.setMode` gates on the flag at all, so that gap is **pre-existing and independent** of the diff. It also means the removed comment's own claim ("handleSetMode reads this same context flag") was already inaccurate. | lead, pre-report |

Pattern worth noting: four of six corrections were the lead over-reading, and
the agents caught them. One was the lead catching itself. None were an agent
inventing a finding.

---

## 3. Compounding chains

Findings that are individually rated MED/HIGH but interact. No single scope
report can see these, and the interaction changes the priority.

### 3.1 Transcript performance — A05 × A04

`A05`: a user frame projecting no visible rows (every `tool_result` carrier —
most user frames in a tool-heavy session) is never recorded in `seenFrameIds`, so
a replayed copy re-folds its correlation, mints a fresh `ToolResultProjection`,
replaces the session slice and **drops every read cache**.

`A04`: every slice change rebuilds rows via `attachChildren = row => ({...row,
children})`, minting new objects, so `React.memo(TranscriptRowView)` misses for
the **entire** history and every `AssistantProse` re-runs remark/rehype.

Together: A05 drops the caches far more often than intended, and A04 makes each
drop cost a full-transcript markdown re-parse. On a 300-row session with 30 tool
cards, during a live turn. Fix either and the other is survivable; fix A04 first
(the WeakMap idiom already exists at `TranscriptView.tsx:1366` with a measured
comment: 37 ms for two 40k-line members).

### 3.2 Sidecar orphaning — A20 × A10 × A08

`A20` found the mechanism: `hardening-smoke.ts` and `harness-demo-driver.ts` end
with a bare `app.exit()`, which Electron documents as skipping `before-quit` —
and `before-quit` is the only place `main.ts` tears down spawned sidecars.

`A10` found the symptom independently: 99 `/tmp/catcode-*` directories, 97 with a
dead owning pid.

`A08`/`A10` found the aggravator: supervisor teardown is SIGTERM-only with no
SIGKILL escalation and drops the child handle immediately, so even the
non-harness path can leak.

Net: the security gate leaks ~230 MB per green run, and the general teardown path
cannot recover it.

### 3.3 Crash to blank window — A17 × A01

`A17`: `agentTypeMeta` throws on a model-supplied `subagent_type` matching an
`Object.prototype` key.

`A01`: there is **no root error boundary** — `main.tsx` wraps `<App/>` in five
providers and nothing else, and the only `getDerivedStateFromError` in the
renderer is scoped to markdown.

So a model emitting an unusual agent-type string does not degrade one row; it
unmounts the tree. Blank window, no message, no reload affordance, diagnostics
only in a devtools console a packaged build cannot open. This directly violates
the repo's stated "display = degrade gracefully" asymmetry.

### 3.4 Quota decisions made against wiped state — S01 × S05

`S01`: the deferred-continuation eligibility check calls `buildCodexStatus` →
`loadPoolForObservation()`, which replaces the live in-process pool.

`S05`: because Codex cap state is memory-only, that wipe makes every capped
account read `healthy`, so the verdict **inverts** — `/continue-after-limit`
reports a usable account to a fully-exhausted user, and the host REPL's routing
state is destroyed as a side effect.

The naming is doing damage here: nothing about `loadPoolForObservation()` warns a
caller that it mutates global state.

### 3.5 Deferred-continuation lock leak — S01 × X02b

`S01` rated the deferred-continuation locking and claim protocol as genuinely
good and re-entrancy as closed.

`X02b` found `abandonForegroundDeferredAttempt`
(`deferredContinuationRunner.ts:460`) has **zero production call sites** — and
its own comment says it exists to prevent a cross-process lock leak.

So the guard was written, tested, and never wired. `S01`'s "re-entrancy closed"
should be read as "closed on the paths that call the claim protocol; the
abandonment path is unguarded."

### 3.6 Rejection invisibility — A06 × A03 × A15

Four layers, each individually defensible:
- `A06`: `ErrorFrame.requestId` is optional and unset at sidecar rejection sites,
  while all 22 app-owned verbs carry a mandatory `requestId`.
- `A03`: ~40 `sendError` call sites write real user-facing prose.
- `A15`/`A03`: `connectionState.ts:261-272` handles three connection codes and
  returns state unchanged for the rest; `reduceSessionActionRuntimeState` ignores
  `kind:'error'` entirely.

Mitigating detail found late (`A15`): **main already copies `requestId` onto the
error frame** on some paths. So a renderer-side fix alone closes real ground —
this is not a four-layer rewrite. `permissionState.ts:161` next door already
demonstrates the correlation pattern to copy.

---

## 4. Convergence map — what is independent corroboration

This matters for confidence. Wave 1 agents ran with no shared context. From wave
2 onward the lead fed confirmed findings into later prompts, which made them
faster but means later agreement is partly anchoring.

**Independent (wave 1, no cross-feeding):**
- socket path / peer authentication — A02 (HIGH) and A10 (MED), different planes
- context-breakdown cost floor disarmed on the null path — A02 and A03
- `dispatch` missing its `never` tripwire — A02 and A03
- `CH_RESTART` unbounded — A08 and A09 reached it from main-IPC and registry
  sides; A10 had already noted the preload guard is the only thing in front of it

**Independent across sessions (strongest in the set):**
- The peer session's `S06` had none of this review's context and independently
  concluded the same systemic problem — unsafe shared-file writes — from a scope
  never covered here, and independently named `atomicWriteJson` from
  `codexTokenRefresh.ts` as the fix pattern. Its tautological-test finding is
  also the same shape `X01` found repeatedly.

**Cross-fed (treat as blast-radius confirmation, not discovery):**
- the plan-mode bypass (A13 then A12)
- `loadPoolForObservation` (S01 then S05)
- everything the later prompts explicitly seeded

---

## 5. Fix plan

Ordered by a combination of blast radius, reversibility of the damage, and cost.

### Tier 0 — do first, minutes each

1. **Vault permissions.** Stopgap:
   `chmod 700 ~/claude-vault ~/claude-vault/accounts && chmod 600 ~/claude-vault/accounts/*.json`.
   Durable: create with `mode: 0o600`/`0o700` at the writer, or the next rewrite
   reverts it.
2. **Plan-mode bypass** — restore the `CATCODE_ALLOW_BYPASS` gate, or wire a real
   killswitch. This is another session's uncommitted work; coordinate before
   touching it.
3. **`persistNextQuarantineProbe`** — extend the guard to
   `|| refreshState.state === 'in_flight'`. One line. Removes the destructive
   case; the strictly-correct fix (take `lock(vaultFilePath)` for the backoff
   write) can follow.
4. **`liveCount()`** — filter dead tombstones. One line, unlocks the app after
   ~32 parks.
5. **Empty tag query** — delete the `else if (matches[0]) apply(matches[0])` arm.

### Tier 1 — the atomic-write set

One pattern (`atomicWriteJson`: temp → fsync → rename → dir-fsync), six
applications: `saveClaudeTokenToVault`, `sessionStorage.ts` (plus un-poison the
flush queue), `teammateMailbox`, `updateSettingsForSource` object form (or reject
collection-bearing object patches outright), the plugin registry, and
`settingsSync`'s lock bypass. Do `sessionStorage` first — it is the one that
loses user transcripts and the one the branch just made load-bearing via
`flushCurrentTranscriptDurably`.

### Tier 2 — correctness with user-visible symptoms

`buildCodexStatus` state wipe (and rename `loadPoolForObservation`) ·
`primeCodexEvents` iterator abandonment (10-minute WS deadlock) · zombie
teammates (move the launch after the last fallible step, or make the catch stop
what it started) · root error boundary · `AskQuestionFlow` keydown guard (reuse
`permissionKeysAreLive`) · bulk-export hang (`sessionActionRuntimeState` error
branch + unconditional lifecycle branch — closes three symptoms at once) ·
context denominator unification.

### Tier 3 — structural, schedule deliberately

DOM test harness (this is the force multiplier — it is what would have caught two
of the shipped bugs above, and it unblocks testing 77 effects and ~274 handlers)
· socket directory `mkdtempSync` + `0700` · orphan reaper driven from registry
pids · harness `app.exit()` → proper quit · god-file extraction (`App.tsx`,
`sidecarServer.ts` — both reports name concrete seams) · the six
engine-function-imported-but-hand-rolled duplications, which are delete-and-call
fixes rather than ports.

---

## 6. What a next session should do first

1. **Provenance pass.** Only two `src/` findings were tagged branch-new vs
   pre-existing. `git blame` the remaining `src/` finding lines to split "this
   branch broke it" from "this branch inherited it". `persistNextQuarantineProbe`
   is already known pre-existing-and-amplified. This changes what belongs in a
   ship-blocking list.
2. **Adversarial second pass on the ~10 HIGHs you intend to fix.** Nothing in
   this review was re-reviewed by a second agent. That is the cheapest available
   confidence upgrade, far cheaper than re-running scopes.
3. **The one unrun scope**: engine prompts/policy (`src/constants/prompts.ts`,
   `corePolicy.ts`, `systemPromptSections.ts`, `promptStyles/`) — provider
   keying against `resolveRequestProvider`, prompt-cache stability (this project
   measured ~19M excess uncached tokens from warm-cache busts), and whether
   `corePolicy.ts` is wired and internally consistent.
