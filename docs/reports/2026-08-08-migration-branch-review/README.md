# Migration-branch code review — 2026-08-08

Full-branch review of `migration`, run as 30 parallel scoped reviews (29 in one
session plus one dispatched to a separate session). Findings are correctness AND
code quality, weighted equally, per `00-review-contract.md`.

**Totals: 60 HIGH · 180 MED · 165 LOW across 30 scopes.**

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

| Site | Defect | Consequence |
|---|---|---|
| `persistNextQuarantineProbe` (`codexTokenRefresh.ts`) | unlocked whole-vault RMW, guard skips `in_flight` | rotation lost → account permanently dead |
| `saveClaudeTokenToVault` (`claudeAccountPool.ts`) | truncate-then-write, error swallowed, returns `void` | account silently vanishes on next start |
| `sessionStorage.ts` | no atomic-write story | failed append discards entries **and** poisons every later flush for the process |
| `teammateMailbox.ts` | lock + read + truncate-in-place | one crash bricks the mailbox permanently; `clearMailbox` has zero call sites |
| `updateSettingsForSource` object form | stale nested arrays overwrite fresh state under the lock | the historical `persistPermissionUpdates` lost-update, via a different call form |
| plugin registry | truncating write + catch-all loader | one bad shutdown → silent total uninstall |

Correct references already in-tree: `codexAccountPool.ts:761`,
`atomicWriteJson` (`codexTokenRefresh.ts`), `setClaudeAccountAlias`,
`transactTeamFile` (`teamHelpers.ts`).

`app/` writes its own files correctly everywhere. Every unsafe write the desktop
is exposed to comes from engine modules the sidecar calls into.

## Highest priority

1. **Credential vault is world-readable.** `~/claude-vault/accounts/*.json` at
   `0644` inside a `0755` directory, holding live access and refresh tokens.
   Verified on the operator's machine at review time. The durable fix is
   creating them `mode: 0o600` / `0o700` at the writer; anything else reverts on
   the next rewrite. (`X02a-atomic-writes-duplication.md`)
2. **Plan mode is a full permission bypass.** `app/sidecar/sessionController.ts`
   replaced a `PERMISSION-BOUNDARY.md` §3 trusted-surface gate
   (`CATCODE_ALLOW_BYPASS === '1'`, off by default, read from launch env so a
   renderer cannot self-escalate) with unconditional `true`. Via
   `src/utils/permissions/permissions.ts:1286`, plan mode then auto-allows every
   tool call with no prompt. The replacement comment cites a bypass killswitch
   that does not exist anywhere in `app/`. **Uncommitted at review time.**
   (`A13`, `A12`)
3. **The six atomic-write sites above** — one pattern, six applications.
4. **`buildCodexStatus` inverts its own verdict.** `loadPoolForObservation()`
   replaces the live in-process pool; Codex cap state is memory-only, so every
   capped account reads `healthy` and `/continue-after-limit` reports a usable
   account to a fully-exhausted user. (`S05`, `S01`)

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
`A*` = desktop app · `S*` = engine · `X*` = cross-cutting.
`S06-settings-reset-peer-session.md` came from a separate session.

Two scopes were never run: engine prompts/policy (provider keying, prompt-cache
stability) and a second pass on `src/` provenance tagging.
