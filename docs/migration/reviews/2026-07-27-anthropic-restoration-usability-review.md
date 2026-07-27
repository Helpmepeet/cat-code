# Anthropic restoration — cold usability and integration review

**Date:** 2026-07-27
**Scope:** CC-17, the restored Anthropic provider across engine routing, authentication,
account selection, desktop model/effort/Fast controls, recovery, and resume.
**Verdict:** **PASS for headless engine + desktop integration; operator GUI acceptance pending.**

## User outcome reviewed

A signed-in user must be able to:

1. add an Anthropic subscription without weakening the existing Codex path;
2. see which provider/account the active session will use;
3. select a Claude or GPT model before the first turn, including provider-local Default;
4. select only effort levels the current model can actually apply;
5. enable Fast only when the model and account/runtime allow it;
6. submit and resume on the intended provider;
7. recover from expired/missing Anthropic credentials using accurate instructions; and
8. receive a correlated visible failure when a stale control write is rejected.

The review was performed against source and tests in the shared dirty `migration` tree. It did
not launch the Electron application; the migration rule requires explicit authorization for each
GUI run.

## Evidence of the real provider path

After the operator completed Anthropic login, the real CLI path was exercised with Haiku and the
real `Read` tool:

```text
./cli-dev -p --model haiku --tools Read --allowedTools Read \
  --no-session-persistence --max-turns 3 \
  --output-format stream-json --verbose …
```

The session initialized as `claude-haiku-4-5-20251001`, emitted a real `Read` request for this
repository's `package.json`, consumed the returned file content, and completed successfully in two
turns with no permission denial. This is provider execution evidence, not an OAuth mock or a
renderer fixture.

## Findings closed in this pass

### 1. OAuth could report failure after already committing a disallowed managed-org token

**Severity:** high
**Fix:** split token organization validation from installed-token validation and run
`validateForceLoginOrgForToken(tokens.accessToken)` before `installOAuthTokens(tokens)`.
Wrong-org tests prove the installer is never called.

### 2. Successful login refreshed the account roster but left an open model picker stale

**Severity:** high
**Fix:** OAuth success and other pool mutations now re-broadcast both `accounts.snapshot` and
`run-controls.snapshot`. Newly available Claude/GPT options appear without respawning a session.

### 3. Desktop startup could route an explicit Claude model through the OpenAI provider

**Severity:** high
**Fix:** the sidecar resolves explicit-vs-implicit startup provider state before QueryEngine
construction. Explicit Claude models cross to the configured Anthropic route; an implicit
provider default preserves environment/startup precedence.

### 4. Resume restored transcript messages but not the transcript's model route

**Severity:** high
**Fix:** sidecar session construction finds the latest assistant model in restored messages and
seeds model/provider state from it before QueryEngine construction. A Claude transcript therefore
does not resume on today's OpenAI default (and GPT transcripts retain their GPT route).

### 5. Model controls omitted Default and could label rows with the wrong provider

**Severity:** high
**Fix:** `model.set` and the wire now accept `null` as provider-local Default. The picker includes
the engine's Default option, and every option carries its resolved request route
(`anthropic`, `openai`, `bedrock`, `vertex`, or `foundry`) rather than a guessed family tag.

### 6. Provider switching could race the first request

**Severity:** high
**Fix:** the sidecar locks provider-family changes when the first submit is accepted, before the
turn starts, and repeats the rule at the domain boundary. Cross-family rows disable in the picker.
Rejected writes return a correlated `run-control.result` and are shown by the existing failure
toast consumer.

### 7. Effort UI and `/effort` could claim a level the request path omitted or clamped

**Severity:** high
**Fix:** `/effort` now rejects models without effort and levels outside
`getSupportedEffortLevels(model)`. The desktop snapshot separates raw selection from effective
applied effort after env/session/default precedence. The face shows the effective tier; the
popover checkmark still truthfully represents Auto or the explicit selection.

### 8. Fast mode was visually gated but the sidecar mutation boundary trusted the renderer

**Severity:** medium
**Fix:** `setFast(true)` rechecks both model support and live account/runtime availability.
Turning Fast off remains allowed. Stale or forged enable requests fail with the engine's real
unavailable reason.

### 9. Composer showed the Codex account on an Anthropic-routed session

**Severity:** high
**Fix:** the composer selects the active account by the run-control snapshot's authoritative
provider. Claude routes show the active redacted Anthropic alias/email; OpenAI routes retain the
Codex account switcher.

### 10. Anthropic accounts were display-only in the desktop

**Severity:** high for multi-account users
**Fix in this pass:** healthy non-active Anthropic rows now expose Switch. The verb carries
`provider:'anthropic'`, is strict-key/Zod validated, re-resolves the UUID in the live Claude pool,
syncs keychain/config, clears auth caches, and re-broadcasts accounts + model options.

**Residual:** rename/delete/logout row actions are still CLI-only; see Known gaps.

### 11. `/switch-account <alias>` claimed cross-provider support without changing runtime route

**Severity:** high
**Fix:** a pre-turn cross-provider switch changes session provider and model together, persists
the startup provider preference, and turns off incompatible Fast state. Cross-provider switching
after the first turn is rejected.

### 12. Recovery copy incorrectly claimed `/login` only adds OpenAI accounts

**Severity:** high during an auth failure
**Fix:** every stale recovery string found under `src/` now directs the user to run `/login` and
choose Anthropic subscription.

### 13. Retrying Add account could strand the OAuth flow without an owning surface

**Severity:** medium
**Fix:** desktop OAuth now has an explicit `add-account` context covering the optimistic start,
waiting/manual-code, alias, error, retry, and success dwell. Retry retains that owner instead of
misclassifying the attempt as first-run and hiding it on a populated account pool.

### 14. API-key and cloud routes looked unconfigured on the Accounts page

**Severity:** medium
**Fix:** an available Anthropic route with no subscription-pool rows now shows `route configured`
and accurately names API-key/cloud-provider routing. Unhealthy active subscription rows also show
their failure state instead of letting the active decoration or plan label hide it.

### 15. Synthetic local-command output could override the real model on resume

**Severity:** high
**Fix:** resume now selects the latest real assistant model, excluding the `<synthetic>` model and
API-error rows. A regression with a real Claude assistant followed by synthetic `/cost`-style
output preserves the Claude model.

### 16. Older/crashed restored sessions could reopen provider switching

**Severity:** high
**Fix:** provider-family safety is now explicit session state seeded from restored provider-bound
history, not merely inferred from restored cost counters. The desktop domain, model catalog,
`/model`, and `/switch-account` share the lock even when restored token cost is zero.

### 17. First-run provider cards authenticated but did not activate the chosen provider

**Severity:** high
**Fix:** first-run login carries a strict-schema `activateProvider:true` intent. Only after the
chosen runner commits credentials does the sidecar atomically activate that provider's runtime
route/default and persist its startup preference. Ordinary Add-account flows remain non-activating.

### 18. Cloud/API-key requests could display an unrelated Claude subscription identity

**Severity:** medium
**Fix:** the redacted accounts snapshot identifies whether the active first-party credential is
actually the Claude subscription pool. The composer shows a Claude account only for that case;
Bedrock, Vertex, Foundry, and external API-key/token routes omit the unrelated subscription face.

### 19. An unsupported raw effort selection survived a model switch

**Severity:** medium
**Fix:** model/provider changes reconcile a raw effort tier unsupported by the next model back to
Auto. The effective face and checked popover row can no longer disagree.

### 20. `/switch-account` discovery copy still described a Codex-only command

**Severity:** low
**Fix:** slash discovery now advertises switching between Claude and Codex accounts, with a pinned
provider-neutral description test.

## Current user flow

- First run offers Anthropic and Codex subscription sign-in cards.
- The Anthropic OAuth runner owns tokens and commits only after policy validation.
- A successful first-run sign-in activates the chosen provider's runtime route/default; adding an
  extra account later does not unexpectedly change the active session.
- OAuth success refreshes the redacted account roster and credential-dependent model catalog.
- Before turn one, the model picker can cross between credentialed Claude and GPT families.
- Default stays within the current provider. Claude choices route through first-party Anthropic or
  the configured Bedrock/Vertex/Foundry route; GPT choices route through OpenAI.
- The effort picker is present only for effort-capable models and exposes only supported levels.
- The Fast toggle is hidden/disabled according to engine support and repeats those gates server-side.
- The first accepted prompt freezes the provider family but still permits same-provider model and
  effort changes.
- Resume retains the latest real transcript model/provider, ignores synthetic command output, and
  preserves the provider lock even when restored cost accounting is absent.
- The composer reports the active subscription account only when that pool authenticates the route;
  external API-key and cloud routes do not borrow an unrelated account identity.

## Known gaps (not hidden)

1. **Desktop Claude lifecycle is incomplete.** Switch and Add are built, but rename, delete, and
   logout row actions remain available only through `/rename-account`, `/delete-account`, and
   `/logout`. This does not block a normal single-account Anthropic user, but it is a real desktop
   parity gap.
2. **Already-running sidecars do not receive cross-process account-pool invalidation.** Cat Code's
   locked N-process topology gives each live session its own in-memory pool. A mutation in one
   sidecar writes shared keychain/config/vault state, but another already-running sidecar may retain
   its old pool snapshot until restarted or locally refreshed.
3. **OAuth progress is session-scoped, not request/provider-tagged.** One in-flight attempt per
   sidecar is enforced, so the current UI is usable, but explicit request/provider correlation
   would make retry/supersession diagnostics stronger.
4. **GUI and boundary hardening acceptance remain pending.** No Electron launch or hardening smoke
   was run in this pass because explicit per-run authorization has not been given.
5. **Third-party route resume is inferred from the restored model plus current configured
   Bedrock/Vertex/Foundry environment.** The transcript does not persist a provider field. Normal
   configured-cloud resumes are correct; changing cloud-provider environment between runs can
   intentionally change the route for an otherwise ambiguous custom model.

## Verification record

Focused integration battery after the fixes:

- `bun run --cwd app typecheck` — clean.
- 326 focused tests across accounts, run controls, sidecar boundary, startup/resume, renderer
  account/control surfaces, `/effort`, `/model` provider locking, and `/switch-account` —
  **326 pass / 0 fail**.
- Search for the retired `"login adds OpenAI accounts only"` recovery copy — **0 matches**.

Full verification:

- `bun test app/` — **1,567 pass / 0 fail** across 135 files.
- `bun run --cwd app typecheck` — clean.
- `bun run --cwd app typecheck:sidecar` — scoped sidecar typecheck passed
  (5,546 upstream diagnostics ignored, 0 owned diagnostics).
- `bun run --cwd app renderer:build` — production renderer build succeeded (590 modules).
- `bun run build:dev:full` — maps lint passed (8 existing recommendations), engine bundle built,
  and `./cli-dev --version` printed `2.1.87-dev.20260727.t090004.sha2320f73e`.
- Post-build live Haiku rerun — **success**, real `Read`, 2 turns, `cat-code 2.1.87`,
  0 permission denials.

`bun run --cwd app test:hardening` was not run because it launches Electron and this session has
no explicit app-launch authorization. GUI-only acceptance remains explicitly pending.
