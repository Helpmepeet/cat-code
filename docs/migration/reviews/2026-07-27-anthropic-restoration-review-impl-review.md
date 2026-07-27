# Anthropic restoration — review-impl cold review

**Date:** 2026-07-27  
**Method:** review-only `review-impl` pass with two independent reviewers, followed by
source validation and verification reruns.  
**Scope:** the isolated Anthropic-restoration patch against
`2320f73ed95309f68d0d05b33be4c8fa9aa73f46`, plus validation against the current shared
`migration` tree.  
**Verdict:** **RED — do not commit the Anthropic restoration unchanged.**

The core provider restoration is substantial and most model, routing, Fast, account, resume, and
renderer behavior is present. However, the review confirmed one managed-credential integrity bug,
two sidecar authorization/lifecycle bugs, three user-visible state/recovery gaps, and a
non-self-contained commit scope.

No implementation files were edited in this review.

## Contract and conformance

The acceptance contract was the user outcome and 20 closed findings recorded in
`docs/migration/reviews/2026-07-27-anthropic-restoration-usability-review.md`, with
`docs/migration/decisions/COMPOSER-RUN-CONTROLS.md` as the locked run-control design.

| Area | Result |
|---|---|
| Anthropic and Codex login availability | Partial — both are reachable, but first-run activation authority and terminal managed-org ordering are wrong |
| Provider/model/Default selection before turn one | Implemented |
| Provider-family lock after provider-bound history | Implemented |
| Effort selection | Partial — desktop reconciles incompatible state; terminal model/provider switches do not |
| Fast gating | Implemented headlessly; live GUI unverified |
| Active provider/account display | Partial — external API-key routing can still show a retained Claude subscription |
| Submit and resume routing | Implemented headlessly; GUI and cloud-environment changes remain unverified |
| Credential recovery | Partial — malformed desktop manual input cannot be corrected without restarting login |
| Correlated run-control failure | Implemented in domain/wire/reducer tests; live GUI visibility unverified |
| Self-contained patch verification | Failed — the isolated patch does not pass app typecheck |

## Validated findings

### F1 — High — Terminal Anthropic login commits a disallowed managed-organization token before validation

**Evidence:** `src/components/ConsoleOAuthFlow.tsx:343-346`,
`src/cli/handlers/auth.ts:260-266`, and `src/cli/handlers/auth.ts:344-349` call
`installOAuthTokens(...)` before `validateForceLoginOrg()`.
`src/utils/auth.ts:2134-2151` now provides the required pre-commit
`validateForceLoginOrgForToken(accessToken)` helper, but these terminal paths do not use it.

**Failure scenario:** `/login` now restores the Anthropic provider picker. On a managed machine
with `forceLoginOrgUUID`, signing into the wrong organization writes the token into
keychain/config/vault and the live Claude pool, then reports that the organization is invalid.
The refresh-token CLI fast path has the same ordering.

**Disposition:** validate the newly issued access token before every installation path. Add
regressions proving `installOAuthTokens` is never called after wrong-org validation.

### F2 — High — First-run provider activation trusts renderer-authored authority

**Evidence:** `app/shared/protocol.ts:244-251` and
`app/sidecar/sidecarServer.ts:3033-3038` accept an optional boolean
`activateProvider`. `app/sidecar/accountsDomain.ts:549-556` and
`app/sidecar/accountsDomain.ts:789-798` convert that renderer value directly into a pending
provider activation.

**Failure scenario:** a stale or forged pre-turn Add-account frame can set
`activateProvider:true`. After credentials persist, the sidecar switches the runtime provider and
persists that preference even though the login was not a server-established first-run flow.

**Disposition:** derive first-run eligibility from sidecar-owned account/route/session state.
Renderer context may select presentation, but it must not authorize runtime activation.

### F3 — High — The isolated Anthropic patch is not self-contained

**Evidence:** `app/shared/protocol.ts:1500-1527` adds required Anthropic fields to
`AccountsSnapshot`. The original 58-file patch omitted the `pool()` fixture in
`app/renderer/src/TranscriptView.test.tsx`; isolated `bun run --cwd app typecheck` fails with
TS2740. The current shared tree contains neutral values at
`app/renderer/src/TranscriptView.test.tsx:56-70`, but that hunk is mixed with another task and was
not present in the disclosed Anthropic scope.

The shared branch also moved Anthropic renderer helpers into
`app/renderer/src/accountsPageModel.ts` and `app/renderer/src/appModel.ts` after the isolated scope
was created. The eventual commit manifest must be recalculated against the current branch rather
than reusing the stale 58-file list.

**Failure scenario:** applying or committing only the isolated Anthropic patch leaves the desktop
package type-invalid even though the shared dirty tree happens to typecheck.

**Disposition:** include the neutral fixture update and every current refactor-owned Anthropic
hunk in an explicitly re-sliced commit; rerun the complete battery from that self-contained
state.

### F4 — Medium — External API-key requests can display an unrelated Claude subscription identity

**Evidence:** `app/sidecar/accountsDomain.ts:425-426` defines
`anthropicSubscriptionActive` as `getAuthTokenSource().source === 'claude.ai'`.
`src/utils/auth.ts:127-155` makes Claude subscription auth inactive when an external
`ANTHROPIC_API_KEY` owns requests, while `getAuthTokenSource()` can still fall through to the
retained `claude.ai` token at `src/utils/auth.ts:207-210`. The request client then selects the API
key at `src/services/api/client.ts:667-671`.

**Failure scenario:** a user retains a Claude OAuth account but starts Cat Code with an external
Anthropic API key. Requests use the API key, while the composer can display the Claude account and
subscription identity.

**Disposition:** derive the display gate from the same effective request-auth decision as the
client, not merely token-source presence. Add a test for external API key plus retained OAuth.

### F5 — Medium — A new login can supersede an attempt while its credential write is already running

**Evidence:** `app/sidecar/accountsDomain.ts:549-556` starts a new login unconditionally and
increments the generation. The earlier attempt may already be awaiting `login.persist()` at
`app/sidecar/accountsDomain.ts:580-582` or `app/sidecar/accountsDomain.ts:633-648`. The generation
check occurs only after the write completes.

**Failure scenario:** attempt A enters `persisting`; attempt B starts. Attempt A still writes its
credentials, but its success event is suppressed because the generation changed. The UI belongs
to attempt B while durable credential state may contain attempt A, with final state depending on
write order.

**Disposition:** reject new `account.login` requests while persistence is in progress, matching
the existing cancel guard, or make the credential commit abortable and generation-checked at the
atomic write boundary. Add an overlapping-login regression.

### F6 — Medium — Invalid Anthropic manual callback input consumes the only retry channel

**Evidence:** `app/sidecar/accountsDomain.ts:614-621` clears `resolveManualCode` before the
Anthropic runner parses the submitted value. The runner silently returns on a parse failure at
`app/sidecar/accountsDomain.ts:285-294`.

**Failure scenario:** the user pastes an incomplete callback URL once. The OAuth listener remains
pending, but a corrected submission receives “No sign-in is waiting for a code.” The only recovery
is cancelling and restarting the entire login.

**Disposition:** keep manual input repeatable until the runner accepts a valid code/state pair, and
surface an actionable invalid-input result. Add an invalid-then-valid regression.

### F7 — Medium — Terminal model/provider switches retain incompatible raw effort

**Evidence:** desktop model changes reconcile effort in
`app/sidecar/runControlsDomain.ts:92-101`, `app/sidecar/runControlsDomain.ts:116-129`, and
`app/sidecar/runControlsDomain.ts:155-168`. Terminal `/model` changes model/provider without
updating `effortValue` at `src/commands/model/model.tsx:74-81` and
`src/commands/model/model.tsx:240-247`. Cross-provider `/switch-account` changes
provider/model/Fast but not effort at `src/commands/switch-account/switch-account.ts:101-127`.

**Failure scenario:** a GPT-only raw effort tier such as `ultra` survives a terminal switch to a
Claude model. Request shaping may omit or normalize it, but stored state and user-facing status no
longer describe the applied selection truthfully.

**Disposition:** share the desktop effort-reconciliation rule with terminal model/provider
mutations and add `/model` plus `/switch-account` regression coverage.

## Finding validation

| # | Candidate | Verdict | Reason |
|---|---|---|---|
| 1 | Missing `AccountsSnapshot` fixture in isolated patch | VALID | Reproduced TS2740 from the isolated scope |
| 2 | Managed-org validation after token install | VALID | Direct call order in three restored terminal paths |
| 3 | Renderer controls first-run activation authority | VALID | Strict schema checks type only; domain trusts the boolean |
| 4 | External API key can show Claude subscription | VALID | Snapshot and request client use different effective-auth decisions |
| 5 | Superseded persisting login still writes | VALID | Generation is checked only after `persist()` |
| 6 | Invalid manual code consumes resolver | VALID | Resolver is cleared before parse/acceptance |
| 7 | Terminal effort state is not reconciled | VALID | Both terminal mutation paths leave `effortValue` unchanged |
| 8 | `fetchAccountUsage` export is missing | FALSE POSITIVE | Export exists; test passes 16/16 when run file-isolated |

## Verification rerun

Current shared tree:

- `bun test app/` — **1,642 pass / 0 fail** across 138 files.
- `bun run --cwd app typecheck` — clean.
- `bun run --cwd app typecheck:sidecar` — scoped pass, 5,546 upstream diagnostics ignored.
- `bun run --cwd app renderer:build` — success, 605 modules.
- Seven focused engine test files run in separate Bun processes — **33 pass / 0 fail**.
- `bun run build:dev:full` — success; `./cli-dev --version` printed
  `2.1.87-dev.20260727.t134715.sha5eb03114`.
- `git diff --check` — clean.

Isolated 58-file Anthropic scope:

- `bun test app/` — **1,566 pass / 0 fail** across 135 files.
- `bun run --cwd app typecheck` — **FAIL**, TS2740 in
  `app/renderer/src/TranscriptView.test.tsx`.
- `bun run --cwd app typecheck:sidecar` — scoped pass, 5,547 upstream diagnostics ignored.
- `bun run --cwd app renderer:build` — success, 590 modules.
- `bun test src/commands/switch-account/switch-account.test.ts` file-isolated —
  **16 pass / 0 fail**.

The current-tree green battery does not close F1–F7. It proves the shared tree builds; it does not
prove the original Anthropic patch is self-contained or the untested failure scenarios are safe.

## Explicitly unverified or accepted residual gaps

- `bun run --cwd app test:hardening` was not run because it launches Electron and no GUI launch
  was authorized for this review.
- Live Electron first-run, model/effort/Fast, manual-code, retry, and account-display behavior
  remains unverified.
- Cross-process account-pool invalidation remains an acknowledged multi-sidecar gap.
- OAuth progress remains session-scoped rather than request/provider-correlated.
- Third-party route resume remains dependent on the current cloud-provider environment.
- The previously successful real Haiku request was not repeated in this review.

## Required disposition

Do not commit the implementation unchanged. Fix F1–F7, rebuild a self-contained task scope against
the current branch, then rerun the complete verification battery and a new review pass. Electron
hardening and operator GUI acceptance remain separate final gates.

