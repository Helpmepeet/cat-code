# Week code review: 2026-07-27 to 2026-08-03

Read-only review of the week's committed work. No fixes applied.

- **Range:** `2f4278d` (parent of the week's first commit) .. `7c6959f`
- **Volume:** 232 commits, 464 files, +56,244 / -5,221
- **Method:** 8 parallel review agents, one per file-ownership slice, each required to
  produce a concrete failure scenario per finding and a CONFIRMED / PLAUSIBLE confidence
  mark. Findings without a reproducible scenario were discarded.
- **Anchoring:** the working tree carries 85 dirty entries belonging to concurrent
  sessions, so every finding is anchored to committed content (`git show 7c6959f:<path>`).
  Uncommitted work is out of scope.

## Battery at review time

Run against the working tree, so these numbers include concurrent sessions' edits:

| Command | Result |
|---|---|
| `bun test app/` | 2333 pass / 0 fail, 170 files, 27.55s |
| `bun run --cwd app typecheck` | clean (includes `lint:fast-refresh`) |
| `bun run --cwd app typecheck:sidecar` | passed, 5560 upstream diagnostics ignored |
| `bun run --cwd app test:hardening` | 19/19 |

Every gate is green. **Every HIGH finding below is invisible to all four of them.** That
is the single most important sentence in this report, and section "Why the battery cannot
see this" explains why.

## Status: fixed

All five HIGHs and five MEDIUMs were fixed after verification, by eight agents on exclusive
file sets. Post-fix battery is at the bottom of this section.

| Finding | Fix |
|---|---|
| HIGH 1 settings lost update | `deleteCachedParsedFile(filePath)` under the lock in `updateSettingsForSource`, so both the merge form and the `SettingsUpdater` form see disk. Covers `persistPermissionUpdate` and `addPermissionRulesToSettings` without touching them. |
| HIGH 2 Stop fires the queue | `stopTurn` releases the parked submit before aborting, restoring the text to the composer. New `shouldReleasePendingSubmitOnStop` predicate. |
| HIGH 3 permission focus steal | The focus grab is skipped when an editable element has focus; `keysLive` is re-derived through the same `permissionKeysAreLive` the listener uses, so the key hint stays honest. |
| HIGH 4 probe reads real vaults | The probe redirects `HOME` and a new `assertHermeticHome` throws if any of the three derived vault paths could collide with the real ones. The claim is now an enforced invariant, not a comment. |
| HIGH 5 credential resurrection | New `loadClaudePoolForObservation()` in the engine, mirroring the Codex `loadPoolForObservation` precedent. `initClaudeAccountPool` now calls it then performs its own write, so existing callers are unchanged. |
| MED settings borrowed value | All three affected branches use the source-scoped `layerValue`; corrected note copy; empty-draft int guard. |
| MED migration no-op | New `remapRetiredClaude46ModelForMigration`, gated on `getConfiguredAnthropicProvider()` + `isFirstPartyAnthropicBaseUrl()` rather than the ordering-sensitive session provider. |
| MED `session.tag` sanitization | Imports the engine's own `recursivelySanitizeUnicode`, matching `/tag`'s exact order. |
| MED popover steals Escape | Popovers now register in `modalFocusStack` with a `kind` tag; `isTop` filters to modal-kind so modal-vs-modal is byte-identical. New pure `isBlockedByModal` / `popoverKeyAction`. |
| MED sidebar unhide-all | Wired the previously-uncalled `reduceWorkspaceShown` via a new `reduceHiddenWorkspacesShown`, so the label and the action always agree. |

Also fixed: the `inert` reverse-focus regression, the 33rd-pin truncation direction, the
modifier+Tab branch, the permission shortcuts firing on non-chat views, app-global transport
errors, and three false doc comments.

**One regression was caught and corrected mid-flight.** The first HIGH 5 fix simply deleted
the `initClaudeAccountPool()` call, which stopped the write but left the worker emitting
`anthropicAccounts: []`. Since `selectGlobalAccountsSnapshot` **prefers** the pool snapshot
over the session's (`accountsState.ts:152-156`) and the snapshot was non-null, `AccountsPage.tsx:840`
would have rendered the empty state permanently for a signed-in user. The engine-side
observation-only loader replaced it.

### Post-fix battery

| Command | Before | After |
|---|---|---|
| `bun test app/` | 2333 pass / 0 fail | **2356 pass / 0 fail** (+23 tests) |
| `bun run --cwd app typecheck` | clean | clean |
| `bun run --cwd app typecheck:sidecar` | passed | passed (5560 upstream ignored) |
| `bun run --cwd app test:hardening` | 19/19 | **19/19** |
| `bun test src/services/api/claudeAccountPool.test.ts` | n/a | 12 pass / 0 fail |
| `bun test src/migrations/migrateRetiredClaude46ModelsToClaude5.test.ts` | n/a | 8 pass / 0 fail |
| `bun test src/utils/model/` | n/a | 50 pass / 0 fail |
| `bun test src/utils/settings/` | n/a | 1 pass / 0 fail |

Every fix was proven fail-before / pass-after, except the three noted under "Needs an operator
GUI pass" below.

### Needs an operator GUI pass

These fixes are correct by source trace but cannot be executed by the SSR-only suite. They are
the same structural gap that let four of the five HIGHs ship:

1. **Permission focus steal (HIGH 3)** — ships with **no executable coverage**; its test file is
   owned by another live session. Check: type in the composer mid-turn, let a permission card
   arrive, confirm the caret stays in the composer and the key hint does not appear.
2. **Sidebar reverse-Tab (`inert`)** — collapse the rail, Shift+Tab backward onto it, confirm
   focus lands on the Settings icon and a further Shift+Tab moves to Accounts, not to `<body>`.
3. **Popover vs modal Escape** — open a composer popover, press ⌘K, press Escape once, confirm
   the palette closes and its search input had focus.
4. **Per-session transport error** — in a split workspace, confirm session A's pane no longer
   shows session B's error.

## Adversarial verification

Every HIGH, plus the two most consequential MEDIUMs, was re-examined by a second agent
instructed to **refute** it and to default to REFUTED when uncertain.

**All seven survived. None was downgraded.** Three were strengthened, and three of my
statements were corrected:

| Claim | Verdict | What changed |
|---|---|---|
| HIGH 1 settings lost update | UPHELD, understated | Repeatable, and it erases always-allow rules through ordinary per-turn permission behavior, not just two Settings tabs |
| HIGH 2 Stop fires the queue | UPHELD | `abort.status` frames *are* on the wire but unconsumed, so the fix is renderer-local |
| HIGH 3 permission focus steal | UPHELD | My "typed message is gone" was **wrong**; the draft survives |
| HIGH 4 probe reads real vault | UPHELD | Also reads the real **Anthropic** vault; the keychain, however, genuinely *is* isolated |
| HIGH 5 credential resurrection | UPHELD | Root defect is an **engine-side** incomplete delete; the app escalates cadence, not correctness |
| MED settings borrowed value | UPHELD, broader | Three live triggers, not one; `model: ""` is likelier than the numeric case |
| MED migration no-op | UPHELD | Ordering and provider resolution both confirmed by running the real modules |

Method notes worth keeping: HIGH 2 was settled by driving the real `reduceConnectionState`
+ `resolvePendingSubmit` with an abort frame sequence and showing the resulting snapshot is
byte-identical to a natural turn end. HIGH 1 was independently re-reproduced with probes
written from scratch. HIGH 4 was verified **statically on purpose** — running it is the bug.

## Findings by severity

| # | Sev | Finding | Lane | Conf |
|---|---|---|---|---|
| 1 | HIGH | A settings write silently erases a concurrent session's write | Settings | CONFIRMED (reproduced) |
| 2 | HIGH | Stop does not cancel a queued prompt, it fires it | Composer | CONFIRMED |
| 3 | HIGH | A permission card steals composer focus mid-turn, so Enter allows the tool | Permissions | CONFIRMED |
| 4 | HIGH | The accounts probe test reads the real Codex vault and calls chatgpt.com on every `bun test app/` | Accounts | CONFIRMED |
| 5 | HIGH | The accounts worker can re-create a deleted Anthropic credential file within 60s | Accounts | CONFIRMED |

Plus 19 MEDIUM and 32 LOW across the eight lanes, detailed in the per-lane reports.
56 findings total from 8 agents over 464 files.

**The security boundary itself came back clean** — see "The boundary held" below. None of
the five HIGHs is a boundary bypass.

---

## HIGH 1 — A settings write silently erases a concurrent session's write

**CONFIRMED by reproduction.** `src/utils/settings/settings.ts:512` (via `:348-351`),
`src/utils/settings/settingsCache.ts:45-58`, `app/sidecar/settingsDomain.ts:98-103`

`updateSettingsForSource` takes a cross-process lockfile and then does a deliberately
uncached read to compute the next file. But `getSettingsForSourceUncached` only bypasses
`perSourceCache`; it lands in the **cached** `parseSettingsFile`, and `parseFileCache` is a
bare `Map` with no mtime check. Its only invalidator, `resetSettingsCache()`, is
process-local.

The engine compensates with a chokidar watcher, but `settingsChangeDetector.initialize()`
is called from exactly one place, `src/main.tsx:436`, and the sidecar bootstrap
(`app/sidecar/initializeRuntime.ts:38-41`) is `init()` only. **A sidecar process never
learns that a settings file changed underneath it.** The staleness window is not a race; it
is everything since that process's own last read.

Reproduced against a temp `CLAUDE_CONFIG_DIR`, with the other process simulated by a direct
`writeFileSync` (indistinguishable from another process's syscall, since the cache is
per-process and the lock is released between writes):

```
after B wrote:  {"respectGitignore": true, "fastMode": true}
A write result: {"ok":true,"message":"Updated alwaysThinkingEnabled.","changed":true}
final on disk:  {"respectGitignore":true,"alwaysThinkingEnabled":false}
fastMode survived? undefined
```

`runVerb` returns `ok:true`. No toast, no error, no trace.

Two things make this worse than a normal bug:

- **`app/sidecar/settingsDomain.ts:100-102` asserts the opposite in a doc comment** ("the
  engine writer is the cross-process single writer … so this cannot lose a concurrent
  update"), which is why nothing downstream guards it.
- **Blast radius exceeds settings.** `persistPermissionUpdate`
  (`src/utils/permissions/PermissionUpdate.ts:247`) uses the same updater form on the same
  files. An always-allow rule saved in session B can be erased by an unrelated toggle in
  session A.

This is the same lost-update class the repo already recorded once (the `persistPermissionUpdates`
stale-view full write, P3-5a/DR-2). The lock and the updater form fixed the caller and left
the reader. The cheapest correct fix is at the reader: make the under-lock read use an
uncached parse, or drop the path-cache entry before reading.

The existing test cannot see it. `app/sidecar/settingsDomain.test.ts:346` ("two sequential
writes read-modify-write under lock, no lost update") runs both writes through the same
domain in the same process, where the cache is reset between them. Defeating it requires an
*external* writer.

## HIGH 2 — Stop does not cancel a queued prompt, it fires it

**CONFIRMED.** `app/renderer/src/App.tsx:1903-1922` (drain), `:3475-3483` (`stopTurn`),
`:3856-3868` (the Queued row)

`stopTurn` aborts the turn but leaves `pendingSubmits` armed. The abort makes the controller
run `finally { this.setActiveTurn(false) }`, which broadcasts `turn.status(activeTurn:false)`;
the renderer flips `inputEnabled` true; the drain effect immediately submits the parked
prompt as a **new turn**.

Scenario: a turn is running. The user types "also delete the old migration", presses Enter,
sees it park as "Queued … Sends when this response finishes." They then notice the agent
going the wrong way and click Stop. The turn aborts, and within one socket round-trip the
queued prompt starts a fresh turn with tools at the session cwd.

There is no way out. The Queued row is a bare `role="status"` div with no control, and
Escape is gated on `generating` (`App.tsx:3658`), so it is inert the instant the turn ends.
`resolvePendingSubmit` (`composerState.ts:533`) reads only `status`/`inputEnabled` — an abort
is indistinguishable from a natural turn end.

The terminal REPL this feature cites as its parity anchor drains after a cancel too, **but it
also gives the user a queue pop**: `useCancelRequest.ts:104-110` makes a second Escape call
`popCommandFromQueue()`. The desktop shipped the drain without the pop.

## HIGH 3 — A permission card steals composer focus mid-turn, so Enter allows the tool

**CONFIRMED.** `app/renderer/src/PermissionPrompt.tsx:104-124`, with `App.tsx:2059-2094`

```ts
const previous = document.activeElement
const timer = setTimeout(() => {
  node.focus()                       // unconditional; `previous` is never consulted
  setKeysLive(document.activeElement === node)
}, 0)
```

`previous` is captured only to hand focus *back* on unmount. Nothing checks whether the user
is currently typing.

Scenario: a turn is running. Since `4394086` (this same range) the composer is editable
mid-turn and the send button is replaced by Stop, so **Enter is the only submit path**. The
user starts typing a follow-up. The agent hits a gated `Bash` call; the card renders with
`keyboardTarget` true and grabs focus mid-word. The user finishes the sentence and presses
Enter. Focus is on the card's `<section>`, which carries `PERMISSION_KEY_HOST_ATTR`, so
`permissionKeysAreLive` returns true, `permissionActionForKey` returns `'allow'`, and the
tool runs unread. A follow-up containing the letter `n` denies instead.

**Correction (adversarial verification):** an earlier draft of this report said "the typed
message is gone". That is wrong. The textarea is controlled by `promptDrafts`, so the
pre-steal draft survives and the cleanup hands focus back. The harm is the **unread allow**,
not lost text.

**Neither change is wrong alone.** Before `4394086` the mid-turn composer was `readOnly`, so
there was nothing to steal focus from. P4-43 (`2df63f8`, Jul 31) predates the composer change
(Aug 2) by two days. This is a collision, not a defect in either commit — which is exactly the
class a per-session review cannot catch.

## HIGH 4 — The accounts probe reads the real Codex vault on every `bun test app/`

**CONFIRMED — and this review triggered it.** `app/sidecar/accountsPoolWorker.probe.test.ts:45-76`
(isolation claim at `:14-19`), worker at `app/sidecar/accountsPoolWorker.ts:71-86`

The probe's isolation is `CLAUDE_CONFIG_DIR=<tempdir>`. But the Codex vault path is derived
from `homedir()`, not from `CLAUDE_CONFIG_DIR`:

```ts
// src/services/api/codexAccountPool.ts:91-92
const DEFAULT_VAULT_PATH = join(homedir(), 'codex-vault')
const CODEX_NOOTP_CONFIG = join(homedir(), '.codex-nootp', 'config.toml')
```

`readVaultPath()` (`:913-926`) consults only those two. There is no env override, and the
probe passes `...process.env`, so `HOME` is the operator's own. The spawned worker therefore
loads the real vault accounts with real access tokens, then unconditionally runs
`await fetchPoolUsage({ updateRoutingHints: true })` (`accountsPoolWorker.ts:80`), whose
module-level cache is empty in a fresh process — firing one authenticated
`GET https://chatgpt.com/backend-api/wham/usage` per account.

The test asserts nothing about any of this and passes either way. Its own header says
"ISOLATION — nothing here reads the operator's real credentials", and the commit that added
it (`26c8875`) is titled "test(app): prove the disposable workers do not touch live accounts."
Both claims are true for the *Anthropic* config profile and false for the Codex vault, which
is where the tokens actually are.

Harm is bounded to reads: the usage endpoint is a GET, with no rotation, no vault write and
no completion spend. It is ranked HIGH because the standard documented battery performs an
action CLAUDE.md §10 explicitly gates ("any action on live accounts/credentials"), and
because the false isolation claim is the part that propagates — the next session extending
this probe will trust it.

**Disclosure:** the `bun test app/` run at the top of this report did exactly this. Verified
independently: `~/codex-vault` exists, `~/.codex-nootp/config.toml` exists, and the worker
has no early exit before `fetchPoolUsage`.

**Verification corrections:** the probe **also** reads the real **Anthropic** vault
(`~/claude-vault/accounts`) through the same `homedir()` derivation, so "reads the operator's
real credentials" is true of both providers. Conversely, the macOS keychain genuinely **is**
isolated, by a `sha256(configDir)` suffix on the service name — this report's earlier framing
did not credit that. Every escape route was closed: no early exit exists (`initClaudeAccountPool`
swallows all errors so it cannot abort), `--bare`/`CLAUDE_CODE_SIMPLE` have zero hits in the
three pool/usage modules, and the probe forces `NODE_ENV=development`, which disables the test
guards that do exist.

## HIGH 5 — The accounts worker can re-create a deleted Anthropic credential file

**CONFIRMED.** `app/sidecar/accountsPoolWorker.ts:76`; engine
`src/services/api/claudeAccountPool.ts:74-99` (write at `:86-89`)

The worker takes the observation-only entry point for the Codex pool
(`loadPoolForObservation()`), and its doc comment at `:14-25` explains at length why full
`init()` is unacceptable on a 60s timer. For the Anthropic pool it calls the full
`initClaudeAccountPool()`, which is **not** observation-only:

```ts
if (configAccount && !byUuid.has(configAccount.accountUuid)) {
  saveClaudeTokenToVault(configAccount)
```

`saveClaudeTokenToVault` (`:567-606`) is a bare `writeFileSync` of `access_token` +
`refresh_token`, with no lock and no atomic tmp+rename.

Scenario: the operator runs `/delete-account <alias> --confirm` in the terminal.
`removeClaudeAccount()` unlinks the vault file but leaves the keychain blob and
`config.oauthAccount` intact, and takes the memory-only `clearOAuthTokenCache()` branch.
Within 60s the desktop app's accounts worker runs, `loadConfigAccount()` reconstructs the
deleted account from keychain + config, and `saveClaudeTokenToVault` re-writes the
credential file. The account the operator deleted is back on disk and back on the Accounts
page, with no user action, while the app is idle.

The incomplete delete is a pre-existing engine gap (any `cat-code` start resurrects it too,
via `src/entrypoints/init.ts:96`). What is new is that the desktop app converts "resurrects
at next engine start" into "resurrects unattended within 60s, from a process whose stated job
is to observe". The worker's own contract line (`:74` "Both pool loads are disk-only … Neither
refreshes a token") states a weaker guarantee that reads as read-only.

**Verification note on ownership:** the app-side fix stops the escalation but **leaves the
engine hole open**. `/delete-account` genuinely leaves both the keychain blob and
`config.oauthAccount` intact (only `/logout`'s `performLogout` clears them), and
`loadConfigAccount()` needs exactly the two things the delete does not remove. Track the
engine-side incomplete delete separately.

---

## The boundary held

The security-critical lane was the one most likely to produce a HIGH, and it produced none.
Traced rather than assumed:

- **Exactly one new inbound kind this week** (`session.tag`), verified by diffing the
  `z.literal` set between the two commits. It has all three of CLAUDE.md §6's requirements:
  sidecar-local schema, accept **and** reject boundary tests, and a decision doc-comment.
  The four field widenings (`account.switch/login.provider`, `settings.setValue.value: null`,
  `model.set.model: null`) each carry accept and reject tests too.
- **The closed-allowlist property is intact.** `checkStrictKeys` runs before every dispatch
  branch and resolves the type through `Map.get` — deliberately not `key in obj`, so
  `constructor`/`toString` cannot masquerade as a type. `dispatch()` has no permissive
  default anywhere in the chain.
- **T4/T5a/T6/T6b are byte-identical to the range start.** The response-key allowlist is
  still `{behavior, updatedInput, message, applySuggestions}`; `updatedPermissions` and
  `deny.interrupt` are still rejected.
- **Directional limits are correct.** `MAX_FRAME_BYTES` (128 KiB) is used at exactly one
  site, the inbound decoder; `MAX_OUTBOUND_FRAME_BYTES` (32 MiB) at exactly two. No swap,
  no unification.
- **No new frame carries token material.** `hasVaultProfile` is `Boolean(vaultFilePath)`,
  never the path.

Two boundary-adjacent items worth an owner rather than a fix:

**`remoteSettings.directConnect` validates URL shape but admits any host.** The week's fix
is real and closed the worse half (a length-only bound previously admitted `file:`, `data:`,
embedded `user:pass@`). What remains is stated in the code's own comment: no host policy
exists. A T1-compromised renderer can make the privileged sidecar POST `{cwd}` to
`https://attacker.example/sessions` and read the reply back off `remote.result` — renderer-driven
egress of the session working directory plus a same-machine request oracle, the class
SECURITY-MINIMUM T3 relies on `connect-src 'self'` to deny. Flagged here so the deferral gets
a named owner instead of a third silent pass.

**`session.tag` drops the Unicode sanitization `/tag` applies** (the lane's one MEDIUM).
The engine normalizes with `recursivelySanitizeUnicode(tagName).trim()`; the sidecar applies
`.trim()` only. A tag of `prod‮gnimaerts` is written verbatim and renders with the RTL
override live on the Sessions page and in the terminal. Zero-width variants make two
byte-different, visually identical tags into two filter tabs. `src/utils/sanitization.ts:1-23`
documents this as a deliberate mitigation (HackerOne #3086545), not a tidy-up. This is
CLAUDE.md §8 rule 1 — the sidecar building something the engine also builds, from a different
source. Fix is one import plus one call; impact is display integrity, and no path feeds the
catalog tag into a prompt.

---

## Cross-cutting themes

These matter more than any individual finding, because each one produced several.

### 1. The mid-turn composer collided with two features that landed days earlier

Three of the five HIGHs live in one 4-day window, and two of them are collisions rather than
defects:

- `2df63f8` (Jul 31) made the permission card take focus and own the keyboard.
- `151bb19` (Aug 2) moved Stop into the composer send slot.
- `4394086` (Aug 2) made the composer editable mid-turn, making **Enter the only submit path**.

Each is correct in isolation. Together they produce HIGH 2 (Stop fires the queue) and HIGH 3
(the card eats the user's Enter). Nothing in the process looked at the intersection — and
the two commits are a day apart with neither test file mentioning the other's state.

### 2. The SSR-only renderer suite structurally cannot see this class of bug

Every lane reported this independently. `app/renderer` tests use `renderToStaticMarkup`; no
jsdom or happy-dom is a dependency. **React effects never run.** So the following ship with
zero executable coverage:

- Both new focus hooks in `overlayFocus.ts` — the `document` listener add/remove, the rAF
  initial focus and its `isTop` guard, the Tab trap, and the modal-vs-popover Escape
  interaction that is Lane 2's MEDIUM.
- The entire mid-turn queue drain (HIGH 2 is invisible to every test in the package).
- The whole of P4-43, a feature that **is** keyboard and focus behaviour (HIGH 3).
- Every sidebar drag handler; both keyboard refocus paths; autoscroll; `ToastHost` timers.

`bun test app/` reporting 2333 pass is accurate and does not mean what it looks like it
means.

### 3. Source-text greps are being counted as tests

A recurring pattern across four lanes: `readFileSync('./App.tsx')` + `expect(source).toContain(...)`.
`App.test.tsx:791`, `:1486`, `:1853`, `:1891` and
`migrateRetiredClaude46ModelsToClaude5.test.ts:150-165` are all of this shape.

These pin the *spelling of the source*, not behaviour. A behaviour-preserving reformat fails
them; a behaviour break that keeps the strings passes them. Several of the test files say so
honestly in their own comments, which is the right disclosure — but the count still lands in
the green number at the top of this report.

### 4. Built, tested, and never called — three times in one week

- `reduceWorkspaceShown` (per-project unhide) — 149 lines + full tests, **zero call sites**.
  This is the direct cause of Lane 1's MEDIUM: clear-all is the only route back, so the
  "Show 1 hidden project" button must un-hide all of them.
- `settingsProjectBinding.ts` — 149 lines + 175 lines of tests, **no production caller**.
  This makes the entire `engine: 'absent'` grammar unreachable in the shipped app, and means
  the Project scope silently follows the focused session (Lane 3 MEDIUM).
- `bannerStackModel.ts` — four green tests for a stacking model that never runs.

In each case the suite reports green tests for behaviour the app does not have.

### 5. Doc comments asserting the opposite of the code

Load-bearing false claims, each of which stopped someone from checking:

- `app/sidecar/settingsDomain.ts:100-102` — "this cannot lose a concurrent update" (HIGH 1).
- `accountsPoolWorker.probe.test.ts:14-19` — "nothing here reads the operator's real
  credentials" (HIGH 4).
- `app/sidecar/accountsPoolWorker.ts:74` — "Both pool loads are disk-only" (HIGH 5).
- `PermissionModeChip.tsx:94-97` — claims `bypassPermissions` is off the wire allowlist. It
  is on it (`protocol.ts:99-105`).
- `accountsPoolRunner.ts:33-37` — justifies the 60s cadence with a cache that is
  process-local and therefore always cold in a disposable worker.
- `protocol.ts:22-31` — a header paragraph added **this week** asserts that new facts "never
  repurpose a field". In the same range, `RunControlsSnapshot.effort.current` changed meaning
  from the raw session selection to the precedence-resolved tier (the raw value moved to a new
  `effort.selected`), under an unchanged `PROTOCOL_VERSION`. The renderer was updated in
  lockstep so nothing is broken today. Three `notes` fields were also removed in the range
  without a bump or a header note; no reader consumes them, so the cost is likewise zero
  today. Both are discipline findings in the one file where the discipline is the point.

The pattern is consistent enough to be worth naming: **in this codebase a confident doc
comment is currently a signal to check, not a reason not to.** Four of the five HIGHs sit
directly under one.

---

## What is genuinely clean

Stated explicitly, because a report this long otherwise reads as "everything is broken".

- **The permission boundary holds.** C1 is index-only and request-bound; no rule object is
  ever constructed renderer-side. `updatedInput` is literally `{}`. T5a double-answer guards
  hold, and a late answer for a superseded request cannot be attributed to a new one. The
  sidecar re-attaches its own pending entry's objects.
- **No credential exposure in the new inspectors.** `MetadataInspector` prints key *names*
  for every resolved key but *values* only for the closed `EDITABLE_SETTINGS` allowlist.
  Nothing in the lane reads env vars, tokens or auth headers.
- **Codex cross-process safety holds.** The primary hypothesis (an app-side vault
  read-modify-write bypassing the codex-core lock) is **not** present. The Codex path is
  genuinely observation-only, honours the advisory lock, and never reaches the rotation
  machinery. The Anthropic path is where the discipline was not applied (HIGH 5).
- **Provider routing is sound.** No path routes a `gpt-*` model to the Anthropic client or a
  Claude model to the Codex adapter. All four new entry points check the model implication
  before any flag. Mid-session crossing is blocked at all four mutation callsites, not just
  the picker catalog.
- **No account-pool locking was removed or weakened**, and several real fixes landed
  (cross-directory rename in `saveCodexTokenToVault`, `correlateRefreshVerdict` failing
  closed, `persistNextQuarantineProbe` refusing to downgrade a terminal verdict).
- **Projector invariants intact.** No in-place row mutation anywhere; status joined at read
  time; the read-time caches are keyed on the session slice rather than `rows`, which is
  subtle and correct. Exhaustiveness tripwires present and real at all three sites, with
  `sdkMessageFixtures.ts` in sync.
- **Migration wiring complete** — all four steps for `migrateRetiredClaude46ModelsToClaude5`
  (file, import at `main.tsx:189`, call at `:347`, version bump 13→14 at `:337`).
- **The sidebar storage boundary is genuinely defensive.** A corrupt, absent, wrong-version
  or junk-laden store degrades to empty and never throws or blanks the rail.
- **`prepare-dev-electron.ts` honours the `app.isPackaged` constraint** — executable stays
  named `electron`, only the Info.plist display keys are rewritten, with a test asserting it.
- **Project text rules held.** Zero em dashes in user-visible strings across all eight lanes
  (every `—` hit is inside a comment). No Tailwind dynamic-class trap anywhere. Fast Refresh
  boundary holds. `userVisibleText.test.ts` now enforces this repo-wide.

---

## Suggested triage order

Not applied — this review changed no code.

1. **HIGH 4** first: it is a one-line scope fix and it is firing on every test run today.
2. **HIGH 1**: fix at the reader (uncached parse under the lock). It silently loses
   permission rules, and the doc comment that says it cannot needs to go with it.
3. **HIGH 2 and HIGH 3** together: they are the same collision. Either Stop clears
   `pendingSubmits` and the card skips the focus grab when an editable element has focus, or
   the queue gets a visible remove control.
4. **HIGH 5**: give the Anthropic half the observation-only discipline the Codex half has.
5. The MEDIUMs, per-lane. Lane 3's borrowed-value row and Lane 7's migration no-op are the
   two with silent wrong-data consequences.

Before any of that: **the SSR-only suite is the reason four of these five shipped.** A DOM
harness for `app/renderer` would have caught HIGH 2 and HIGH 3 directly, and is the highest
-leverage item on this list.

## Per-lane reports

Full detail, including all 19 MEDIUM and 32 LOW findings with failure scenarios, in
`2026-08-03-week-code-review/`:

| Lane | Scope | H/M/L |
|---|---|---|
| 1 | Sidebar and session organization | 0 / 2 / 6 |
| 2 | App shell, overlays, focus, toasts | 0 / 2 / 5 |
| 3 | Settings surfaces | 1 / 3 / 5 |
| 4 | Transcript, composer, in-turn activity | 1 / 5 / 3 |
| 5 | Sidecar boundary, protocol, permission domain | 0 / 1 / 5 |
| 6 | Accounts pool worker and Electron main | 2 / 1 / 3 |
| 7 | Terminal engine (`src/`, `scripts/`) | 0 / 3 / 2 |
| 8 | Permission UI, inspectors, theming | 1 / 2 / 3 |
</content>
</invoke>
