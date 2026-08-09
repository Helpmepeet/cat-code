# Migration-branch code review — 2026-08-08

Full-branch review of `migration`, run as 31 parallel scoped reviews (29 in one
session plus two dispatched to a separate session). Findings are correctness AND
code quality, weighted equally, per `00-review-contract.md`.

**Totals: 61 HIGH · 181 MED · 167 LOW across 31 scopes.**

Implementation progress after the review is tracked in
[04-fix-progress.md](./04-fix-progress.md). The original findings below remain
unchanged as the review record.

Branch size at review time: 710 commits vs `main`; `app/` is 146,289 insertions
/ 0 deletions (entirely new), `src/` is 39,774 / 4,651.

## Verification run by the review lead

| Battery | Result |
|---|---|
| `bun test app/` | 2799 pass / 0 fail |
| `bun run --cwd app typecheck` | clean |
| `bun run --cwd app typecheck:sidecar` | clean (5560 upstream ignored) |
| `bun run --cwd app test:hardening` | 19/19 |

All four were green **before** and independent of every finding below. See
`X01-test-quality.md` for what those numbers do and do not license.

## The systemic root cause

Six subsystems persist shared state unsafely. The repo owns the correct
technique in four places and applies it inconsistently; the durability of a
given write is decided by which implementation its author happened to see.

Consequences below are **post-verification**. Several were narrower than first
reported, and two pillars collapsed entirely — the thesis survives, weakened.

| Site | Defect | Consequence *after verification* |
|---|---|---|
| ~~`persistNextQuarantineProbe`~~ | — | **INVALID (`V24`).** The write spreads `...refreshState` so `attempt_id` survives, and it uses `atomicWriteJson`. Repro ends healthy with the new token committed. Residual: a clobbered verdict. MED. |
| ~~`settingsSync`~~ | — | **INVALID (`V30`).** Whole path sits behind `feature('DOWNLOAD_USER_SETTINGS')`, a name in neither list in `scripts/build.ts`. Dead in every build this repo can produce. |
| `saveClaudeTokenToVault` | truncate-then-write, error swallowed, returns `void` | **Narrowed (`V24`)**: keychain fallback re-adds the account and `initClaudeAccountPool` repairs the file. The real loss is the **alias**, not the account. |
| `sessionStorage.ts` | no atomic-write story | **Narrowed (`V27`)**: "permanent poisoning" is false — `scheduleDrain` recovers. The **silent batch loss is real** and proven on disk. |
| `teammateMailbox.ts` | lock + read + truncate-in-place | **Narrowed (`V22`)**: corruption **self-heals** via the lenient read. True cost is bounded loss of unread messages — *and* a worse bug underneath: a transient parse failure silently discards the whole mailbox. |
| `updateSettingsForSource` object form | stale nested arrays overwrite fresh state under the lock | See `V26`. The `persistPermissionUpdates` lost-update shape, via a different call form. |
| plugin registry | truncating write + catch-all loader | **Narrowed (`V30`)**: `migrateFromEnabledPlugins()` rebuilds on a later launch, so not permanent. Worse thing missed: the degraded-empty load makes the orphan sweeper **delete every cached plugin version** after 7 days. |
| **`app/host/registry.ts`** | atomic write, but last-writer-wins | **Proven (`V29`)**: 25 rows written, all of writer B's lost — and **every existing assertion passes with the advisory lock replaced by a no-op.** |

Correct references already in-tree: `codexAccountPool.ts:761`,
`atomicWriteJson` (`codexTokenRefresh.ts`), `setClaudeAccountAlias`,
`transactTeamFile` (`teamHelpers.ts`).

`app/` writes its own files correctly everywhere. Every unsafe write the desktop
is exposed to comes from engine modules the sidecar calls into.

## Highest priority

> ## ⚠ Read `02-verification-results.md` before acting on anything here
>
> **All 31 scopes have now been adversarially verified** (`verification/V*.md`).
> ~424 verdicts: roughly 66% confirmed, 24% narrowed, 7% dead.
>
> The findings below are substantially right. **The proposed fixes are not** —
> at least **ten would have caused harm if applied as written**, including three
> that would create the exact bug they were meant to prevent. Do not act on a
> scope report's "Fix" line without reading its verification counterpart.
>
> Overturned headlines: the `persistNextQuarantineProbe` "vault death" claim is
> **INVALID**; the desktop N-writers amplification is **INVALID**; `settingsSync`
> is **dead code behind an unregistered feature flag**; `A06`'s
> rejection-invisibility HIGH and its inbound audit table are **INVALID**.
> Verification also found **ten findings the original review missed**.

1. **Credential vault is world-readable.** `~/claude-vault/accounts/*.json` at
   `0644` inside a `0755` directory, holding live access and refresh tokens.
   Verified on the operator's machine at review time, and re-verified by `V24`
   (five files exposed across both vaults). The durable fix is creating them
   `mode: 0o600` / `0o700` at the writer, plus a chmod-on-load, or existing
   exposure is never repaired. (`X02a`, `V24` F6)
1b. **Rotated credentials were written to the wrong account.** This verified
   multi-account refresh defect was fixed in `9731197`: the refresh path now
   captures the source account UUID before awaiting the provider and writes
   returned credentials back to that UUID rather than to the current active
   index. (`V24`)
2. **Plan mode is a full permission bypass.** `app/sidecar/sessionController.ts`
   replaced a `PERMISSION-BOUNDARY.md` §3 trusted-surface gate
   (`CATCODE_ALLOW_BYPASS === '1'`, off by default, read from launch env so a
   renderer cannot self-escalate) with unconditional `true`. Via
   `src/utils/permissions/permissions.ts:1286`, plan mode then auto-allows every
   tool call with no prompt. The replacement comment cites a bypass killswitch
   that does not exist anywhere in `app/`. **Uncommitted at review time.**
   (`A13`, `A12`)
3. **The surviving atomic-write sites** — one pattern, ~five applications after
   verification killed two. **Order matters**: mailbox atomicity without a
   rename-aside *creates* the brick it prevents, and the credential `{mode}` fix
   is a no-op on the in-place writer. See `03-triage.md`.
4. **`buildCodexStatus` inverts its own verdict.** `loadPoolForObservation()`
   replaces the live in-process pool; Codex cap state is memory-only, so every
   capped account reads `healthy` and `/continue-after-limit` reports a usable
   account to a fully-exhausted user. Reproduced (`V25`): `wait`/`schedule`
   becomes `delegate`/`run_now`, and the emitted JSON says
   `routing_state=candidate` beside `usage.allowed=false`. **Branch-new** —
   `codexStatus.ts` does not exist on `main`. Fix is `loadPool: false` at the two
   in-process callers, **not** the report's racy `pool.initialized` gate.
5. **`--bare` bypasses the entire policy core.** `prompts.ts:696` early-returns
   identity + CWD + date, omitting prompt-injection handling, tool-output
   provenance, instruction authority, risky-action consent, and truthful outcome
   reporting. `corePolicy.test.ts:56` deletes `CLAUDE_CODE_SIMPLE` in its shared
   helper, so no policy test can reach the path. `CLAUDE.md` §12 makes this the
   documented GPT second-opinion path, piping diffs into it. (`S08`)

## Other HIGH findings by theme

**Process and lifetime** — sidecar socket has no peer authentication at a
predictable, pre-creatable `/tmp/catcode-<pid>` (99 leaked dirs observed);
orphan reaper kills by `ps` command-line substring rather than owned pid;
harness `app.exit()` skips `before-quit`, orphaning a ~230 MB sidecar per
hardening run; supervisor teardown is SIGTERM-only with no escalation; socket
filenames collide across supervisor generations. (`A02`, `A10`, `A20`, `A08`)

**Capacity and cost** — `liveCount()` counts dead tombstones, so ~32 parks lock
the app out of creating or restoring any session; `CH_RESTART` is the one
renderer-reachable spawn path with no rate cap (confirmed from four planes);
frame channels accept any `sessionId` string and permanently buffer it.
(`A09`, `A08`)

**Silent failure** — a rejected inbound frame is uncorrelatable and invisible
(`ErrorFrame.requestId` optional and unset; renderer handles three codes and
drops the rest; `sessionActionRuntimeState` ignores `kind:'error'` entirely);
bulk export hangs forever when a leg dies; every rejected session-action verb
strands its guard. (`A06`, `A03`, `A15`)

**Agents** — teammate processes start before the last fallible step and the
catch only tombstones, leaving an unaddressable zombie; the initial task prompt
goes through a legacy mailbox overload that swallows failures while the tool
result claims success; `abandonForegroundDeferredAttempt` exists to prevent a
cross-process lock leak and has zero production call sites. (`S03`, `X02b`)

**User-visible** — `AskQuestionFlow` guards `INPUT`/`TEXTAREA` by tag name while
the composer is `contentEditable`, so typing sends Escape→deny and
Enter→submit; Enter on an empty tag query writes the alphabetically-first tag to
every selected session; `agentTypeMeta` indexes an object literal with
model-supplied text so `subagent_type: "toString"` throws, and there is no root
error boundary; `/context` and the status line disagree ~1% vs ~44% on the same
conversation. (`A19`, `A18`, `A17`, `A01`, `S07`)

**Performance** — a replayed `tool_result` user frame is never marked seen, so
replay re-folds it and drops every read cache; `attachChildren` mints new row
objects so `React.memo` misses for the entire history and every assistant
message re-parses its markdown per frame. (`A05`, `A04`)

## Confidence

- **Verified in source by the lead**: the vault permissions, the plan-mode
  bypass (all three legs), the socket directory mode and leaked-dir count,
  `agentTypeMeta`'s prototype index, `persistNextQuarantineProbe`'s missing
  guard, the settings stale-array merge.
- **Proven at runtime by the reviewing agent**: the projector replay bug (scratch
  harness), the bulk-export hang, the sidecar-typecheck filter's
  non-vacuousness, the vault file permissions.
- **Single-source, source-cited, unverified by a second pass**: the remainder.
- Severity labels are each agent's own judgment and are **not calibrated across
  scopes**.
- Findings converged independently in wave 1 (socket path, context-breakdown
  floor, `CH_RESTART`, the bypass hardcode). From wave 2 onward, confirmed
  findings were fed into later prompts — so later agreement is partly anchoring,
  not independent discovery. The separate session's settings review (`S06`) had
  none of this context and is therefore the strongest corroboration in the set.

## Provenance caveat

Scope selection was driven by the branch diff, but agents reviewed whole files.
For `app/` these coincide exactly (146,289 insertions / 0 deletions — every line
is new). For `src/` they do not: some findings sit on code `main` already has.
Two spot checks: `saveClaudeTokenToVault` is branch-new;
`persistNextQuarantineProbe` is **pre-existing on `main`** — this branch
amplified it (every sidecar spawn boots full rotation machinery, so N sessions
become N concurrent 1 Hz probes on one vault) rather than introducing it. The
remaining `src/` findings are untagged.

## Method caveat on dead code

The dead-export sweep produced 475 raw candidates that collapsed to ~20 real
ones, with four false positives cleared only by reading (`engineTypeDriftCheck.ts`,
`vite-env.d.ts`, the `Action*Icon` components, the sidecar `createReal*`
factories). Referrer-greps also cannot see documentary wiring. Do not delete
from a grep.

## Files

`00-review-contract.md` is the shared brief every scope worked from.
`01-synthesis-and-verification.md` holds the cross-scope analysis: first-hand
verification log, correction log, compounding chains, convergence map, fix plan.
**`02-verification-results.md` is what survived adversarial re-testing.**
**`03-triage.md` is what is actually worth fixing — start there.** Read them
first.** `verification/V*.md` holds the per-scope verdicts.
`A*` = desktop app · `S*` = engine · `X*` = cross-cutting.
`S06-settings-reset-peer-session.md` and `S08-prompts-policy-peer-session.md`
came from a separate session; both had their HIGH re-verified by the lead.

Every planned scope has now been run. Outstanding follow-up work is listed in
`01-synthesis-and-verification.md` §6 (provenance tagging, and an adversarial
second pass on the HIGHs before fixing).
