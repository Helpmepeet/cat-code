# Lane 7: Terminal engine (src/, scripts/)

## Scope reviewed

Committed range `2f4278d..7c6959f`, `src/**` + `scripts/**` only (working-tree edits ignored; every citation is against `git show 7c6959f:<path>`). The week did four things in this lane: (1) landed the Claude 5 model family and retired Claude 4.6 (`configs.ts`, `model.ts`, `modelOptions.ts`, new `migrations/migrateRetiredClaude46ModelsToClaude5.ts`, `effort.ts`); (2) rebuilt session-provider resolution so an explicit model selection can cross provider families and a restored transcript locks the family (`providers.ts` +116, `main.tsx`, `commands/model/model.tsx`, `switch-account.ts`, `bootstrap/state.ts` lock); (3) consolidated the safety/provenance/authority/reporting rules into a new `constants/corePolicy.ts` interpolated by both prompt styles, and keyed the system-prompt section cache by captured inputs (`systemPromptSections.ts`); (4) hardened the Codex WebSocket transport with abort plumbing and correlated refresh verdicts by refresh-token hash (`codexAccountPool.ts`, `codexTokenRefresh.ts`, `withRetry.ts`). Test churn was heavy and mostly good: `corePolicy.test.ts` (+304), `providers.test.ts` (+126), `modelOptions.test.ts` (+225), `codexAccountPool.test.ts` (+204) are all new.

No HIGH findings. I could not construct a scenario where a `gpt-*` model reaches the Anthropic client or a Claude model reaches the Codex adapter, and I found no removed or weakened locking in the account machinery.

## Migration wiring check

`migrateRetiredClaude46ModelsToClaude5` — all four steps present:

| Step | Status | Location |
|---|---|---|
| File exists | present | `/Users/pt/cat-code/src/migrations/migrateRetiredClaude46ModelsToClaude5.ts` (64 lines) |
| Import in `main.tsx` | present | `src/main.tsx:189` — `import { migrateRetiredClaude46ModelsToClaude5 } from './migrations/migrateRetiredClaude46ModelsToClaude5.js';` |
| Called inside `runMigrations()` | present | `src/main.tsx:347`, between `migrateRetiredGptModelsToGpt56()` and `migrateSonnet45ToSonnet46()` |
| `CURRENT_MIGRATION_VERSION` bump | present | `src/main.tsx:337` — `13` → `14` |

A source-text tripwire test also pins the import and the call (`migrateRetiredClaude46ModelsToClaude5.test.ts:150-165`), though it does **not** pin the version bump.

Logic: idempotent for the cases it covers (re-running produces no second write — asserted at `migrateRetiredClaude46ModelsToClaude5.test.ts:110`). A partially-migrated `modelOverrides` is handled correctly (`modelOverrides[replacement] ??= override` preserves an already-present Claude 5 override, `:35`). Unrecognized model ids pass through untouched via `replacement ?? model`. Two defects in its guard/matching are below (M1, M2).

## Findings

### [MEDIUM] The Claude 4.6 retirement migration permanently no-ops for anyone whose last session used Codex — CONFIRMED

**Location:** `src/migrations/migrateRetiredClaude46ModelsToClaude5.ts:22-58` via `src/utils/model/model.ts:101-103`; ordering at `src/main.tsx:1003` vs `src/main.tsx:2152`

**Defect:** `remapRetiredClaude46Model()` returns early unless `getAPIProvider() === 'firstParty'`, but `runMigrations()` runs at the Commander `preAction` hook — long before `setSessionProvider()` — so `getAPIProvider()` falls back to `getEnvAPIProvider()`, which resolves to `'openai'` from the *persisted* `lastUsedProvider` preference. The migration then does nothing, yet `runMigrations()` still bumps `migrationVersion` to 14, so it never runs again.

**Failure scenario:** User picks `gpt-5.6-terra` in `/model` once. `persistStartupProviderPreference('openai')` writes `lastUsedProvider: 'openai'` to global config (`src/commands/model/model.tsx:96`). Later they launch cat-code with `~/.cat-code/settings.json` holding `{"model":"claude-opus-4-6","availableModels":["claude-sonnet-4-6","claude-opus-4-6"],"modelOverrides":{"claude-opus-4-6":"my-endpoint-id"}}`. At `main.tsx:1003` the migration reads provider `'openai'` (`providers.ts:38-41`: `getStartupProviderPreference() === 'openai' ? 'openai' : 'firstParty'`), remaps nothing, writes nothing. `saveGlobalConfig` then sets `migrationVersion: 14` (`main.tsx:357-360`). The user switches back to Anthropic the next day; the migration is version-gated shut forever. `settings.model` is masked at runtime by `parseUserSpecifiedModel`'s remap, but `availableModels` and `modelOverrides` have no runtime remap — the allowlist keeps two dead 4.6 entries and `applyModelOverrides` (`modelStrings.ts:66-74`) never applies `my-endpoint-id` to the Opus 5 key.

**Evidence:**
```ts
// model.ts:101
export function remapRetiredClaude46Model(model: ModelName): ModelName {
  if (getAPIProvider() !== 'firstParty') {
    return model
  }
```
The GPT precedent this file was copied from — `migrateRetiredGptModelsToGpt56.ts` / `remapRetiredGptModel` (`model.ts:83-88`) — has **no** provider guard, which is why the same ordering never bit it. `migrateSonnet45ToSonnet46.ts:30` does guard on provider, but that one is a pure no-op-if-wrong-provider with nothing else to migrate. The `provider` mock in `migrateRetiredClaude46ModelsToClaude5.test.ts:11` is only ever flipped to `'bedrock'` for `parseUserSpecifiedModel` (`:137`), never for the migration function itself, so the case is untested.

---

### [MEDIUM] The 4.6 remap matches by substring, so it rewrites namespaced/proxy model ids on disk — CONFIRMED

**Location:** `src/utils/model/model.ts:105-110`, resolving through `firstPartyNameToCanonical` at `src/utils/model/model.ts:307-341`

**Defect:** `remapRetiredClaude46Model` canonicalizes with `firstPartyNameToCanonical(base)`, which matches with `name.includes('claude-sonnet-4-6')` rather than exact equality. Any first-party-shaped model id that merely *contains* the retired id is rewritten to the bare Claude 5 id, and the migration persists that rewrite to `settings.json`.

**Failure scenario:** A user on the default provider (`getAPIProvider() === 'firstParty'` — no `CLAUDE_CODE_USE_*` set) pointing `ANTHROPIC_BASE_URL` at a gateway that namespaces models, with `~/.cat-code/settings.json` = `{"model":"anthropic/claude-sonnet-4-6"}`. `firstPartyNameToCanonical('anthropic/claude-sonnet-4-6')` returns `'claude-sonnet-4-6'` (`model.ts:333`), so the migration writes `{"model":"claude-sonnet-5"}` — dropping the `anthropic/` namespace the gateway routes on. Every request now 404s at the gateway and the original pin is gone from disk with no undo. `isFirstPartyAnthropicBaseUrl()` already exists in this repo (`src/utils/model/providers.ts:210-224`) and is not consulted.

**Evidence:** the sibling GPT remap it was modelled on uses exact-key lookup:
```ts
// model.ts:86 — remapRetiredGptModel
const base = model.trim().replace(/\[1m\]$/i, '').toLowerCase()
return RETIRED_GPT_MODEL_REPLACEMENTS[base] ?? model
```
vs
```ts
// model.ts:108 — remapRetiredClaude46Model
const replacement = RETIRED_CLAUDE_46_MODEL_REPLACEMENTS[firstPartyNameToCanonical(base)]
```
Substring canonicalization is the right call for dated snapshot ids (`claude-opus-4-6-20260101`), so this is not a request to revert it — but the write-to-disk path needs to be narrower than the read-time remap.

---

### [MEDIUM] Startup resolves the model string under the old provider, then flips the provider — hooks and the deprecation banner name a model the session never uses — CONFIRMED

**Location:** `src/main.tsx:2142` (`resolvedInitialModel`) vs `src/main.tsx:2151-2158` (`resolveStartupProvider` / `setSessionProvider`)

**Defect:** `resolvedInitialModel = parseUserSpecifiedModel(...)` is computed *before* `setSessionProvider`, so alias resolution runs against the pre-flip provider. `getDefaultOpusModel()` / `getDefaultSonnetModel()` branch on `getAPIProvider() !== 'firstParty'` and return the 4.5/4.6-era strings for that branch. The provider is then flipped to `firstParty` by `resolveStartupProvider`, but `resolvedInitialModel` is not recomputed — and it is consumed by four downstream callers.

**Failure scenario:** `lastUsedProvider: 'openai'` (any prior Codex session). User runs `cat-code --model opus`.
1. `getEnvAPIProvider()` → `'openai'` (`providers.ts:38-41`).
2. `parseUserSpecifiedModel('opus')` → `getDefaultOpusModel()` → `getAPIProvider() !== 'firstParty'` → `getModelStrings().opus46` → `'claude-opus-4-6'` (`model.ts:184-195`, `configs.ts:80-86`).
3. `resolveStartupProvider('claude-opus-4-6', true, 'openai')` → `resolveModelSelectionProvider` sees `startsWith('claude-')` → returns `'firstParty'` (`providers.ts:104-114`, `:170-179`).
4. Session provider is now `firstParty`, and actual requests re-resolve the stored alias `'opus'` to `claude-opus-5` — correct.
5. But `resolvedInitialModel` is still `'claude-opus-4-6'` and is passed to: SessionStart hooks (`main.tsx:2530` — `model: resolvedInitialModel`), `getModelDeprecationWarning(resolvedInitialModel)` (`:2988`), `getInitialFastModeSetting(resolvedInitialModel)` (`:3146`), and `modelSupportsAdvisor(resolvedInitialModel)` (`:2208`).

So a user-authored SessionStart hook that branches on `model` branches on a retired id, the launch banner can warn about deprecating a model this session will never send, and fast-mode defaults are seeded from the wrong model. The advisor gate can reject `--advisor` for a model combination that would actually be valid.

**Evidence:** the block is deliberately ordered — `main.tsx:2144-2150` documents why the provider decision comes after the model — but nothing re-derives `resolvedInitialModel` from the settled provider. This divergence is new: before the diff, `setSessionProvider(getProviderForModel(resolvedInitialModel))` stored `null` for a Claude id, so the session stayed on `openai` and `resolvedInitialModel` matched what would actually be sent.

---

### [LOW] The proactive assembly carries no anti-loop rule, and coordinator mode carries no policy core at all — CONFIRMED (both feature-gated off in `dev-full`)

**Location:** `src/constants/prompts.ts:746-750` (proactive), `src/utils/systemPrompt.ts:77-90` → `src/coordinator/coordinatorMode.ts:118` (coordinator)

**Defect:** `corePolicy.ts:75-88` documents `retryRule` as "on only when doing-tasks was dropped for a reason unrelated to the retry budget". The proactive assembly drops doing-tasks and calls bare `getCorePolicySection()` (defaults `retryRule: false`), so the *most autonomous* variant is the one with no retry budget. Separately, coordinator mode replaces the entire default assembly with `getCoordinatorSystemPrompt()`, which contains none of the eight core rules — no cyber policy, no `TOOL_OUTPUT_IS_DATA_RULE`, no `PROMPT_INJECTION_RULE`, no `PROJECT_INSTRUCTION_AUTHORITY_RULE`, no `OUTCOME_REPORTING_RULE`.

**Failure scenario:** under `CLAUDE_CODE_COORDINATOR_MODE=1`, the coordinator's own prompt tells it that worker results and `subscribe_pr_activity` events arrive as user-role messages (`coordinatorMode.ts:141,152`). With no tool-output-is-data rule in that assembly, an imperative instruction embedded in a GitHub PR review comment is delivered to the coordinator as a user message with no rule distinguishing it from the operator.

**Why LOW:** neither `COORDINATOR_MODE` nor `PROACTIVE`/`KAIROS` is in the `dev-full` bundle list (`scripts/build.ts:13-49`), so both branches compile out of the build this repo actually ships. This is a latent gap in an explicitly-enumerated invariant, not a live one. `corePolicy.test.ts:75-92` covers four variants (default Claude/GPT × normal/Agent Mode) and neither of these two.

---

### [LOW] `getBestModel()` lost its 3P lag branch — CONFIRMED

**Location:** `src/utils/model/model.ts:178-180`

**Defect:** `getBestModel()` changed from `getDefaultOpusModel()` (which has an explicit `getAPIProvider() !== 'firstParty'` branch acknowledging that 3P availability lags) to an unconditional `getModelStrings().fable5`.

**Failure scenario:** a Bedrock user with an agent definition specifying `model: 'best'` (a documented value — `src/utils/model/agent.ts:15`) now resolves to `us.anthropic.claude-fable-5-v1` (`configs.ts:114-118`) on day one of the Claude 5 launch, before that inference profile exists in their account, and the spawn fails at the API. Every other family alias keeps a 3P-lag branch; `best` is the only one that does not.

Flagging this as LOW rather than a bug because `modelOptions.ts:195` deliberately offers `getModelStrings().fable5` to 3P users too, so it may be an intentional "best means best" call — but if so, the surrounding `@[MODEL LAUNCH]` comments that say "3P providers may lag so keep defaults unchanged" are now inconsistent with it.

## Coverage gaps

- **Migration under a non-first-party provider.** `migrateRetiredClaude46ModelsToClaude5.test.ts` mocks `getAPIProvider` (`:51-54`) and flips it to `'bedrock'` only for `parseUserSpecifiedModel` (`:137`). The migration function itself is never invoked with a non-`firstParty` provider, which is exactly the state M1 describes. Concrete cost: M1 shipped.
- **The migration version bump has no tripwire.** The source-text test (`:150-165`) pins the import and the `runMigrations()` call but not `CURRENT_MIGRATION_VERSION`. A future migration added without a bump would pass this test and never run for existing users — the exact class of failure the test exists to prevent.
- **`resolveStartupProvider` has no test that pairs a settings-file model with a conflicting `CLAUDE_CODE_USE_OPENAI`.** `providers.test.ts` (+126) covers the function, but the precedence claim in the `main.tsx:2144-2150` comment ("`{"model":"sonnet"}` must not silently pull a `CLAUDE_CODE_USE_OPENAI=1` session onto Anthropic") is asserted only at the unit level, not against the real `main.tsx` wiring that computes `hasExplicitStartupModel`.
- **`resolvedInitialModel` consumers.** No test asserts that the model handed to SessionStart hooks matches the model the session will actually send (M3).
- **Proactive and coordinator prompt assemblies** have no policy-core coverage (see LOW above).

## Clean

Checked and found sound:

- **Provider routing precedence.** `resolveRequestProvider` is unchanged (`providers.ts:186-191`): `getProviderForModel(model) ?? baseProvider`, and `getProviderForModel` still returns `'openai'` for every `gpt-` prefix. I traced all four new entry points — `resolveModelSelectionProvider`, `canApplyModelSelection`, `resolveStartupProvider`, `getConfiguredAnthropicProvider` — and every one checks the model implication *first*, before any flag. `getConfiguredAnthropicProvider()` deliberately cannot return `'openai'` (its return type excludes it), so no path can route a Claude selection into the Codex adapter. I found no way for a `gpt-*` model to reach the Anthropic client or vice versa. Mid-session crossing is blocked at both mutation callsites (`model.tsx:83-95`, `:245-257`) and both switch-account callsites (`switch-account.ts:145-151`, `:184-190`), not just in the picker catalog.
- **Provider-switch lock is fully wired** (CLAUDE.md §8 mistake #7). `hasProviderBoundHistory` is armed from the terminal engine (`sessionRestore.ts:720`) *and* the desktop sidecar (`sessionController.ts:561-563`), and consumed at `providers.ts:130`, `modelOptions.ts:359,602`, `switch-account.ts:147,187`, `runControlsDomain.ts:208,489`. Both sides exist.
- **Codex account pool locking.** No locking was removed or simplified. `saveCodexTokenToVault` now writes its temp file beside the *target* rather than the configured vault (`codexAccountPool.ts:711-716,763`), which fixes a cross-directory rename, and resets `refresh` to `{state:'idle'}` only when the refresh token actually changed (`:746-754`). `correlateRefreshVerdict` (`:1140-1156`) fails closed on both a missing/malformed hash *and* a non-string current token, and the `'uncorrelatable'` branch quarantines rather than resurrecting. `persistNextQuarantineProbe` now refuses to touch a terminal verdict (`codexTokenRefresh.ts:884-892`), closing an unlocked read-modify-write that could downgrade `reauth_required` to `unknown`. The new stale-token check at `codexTokenRefresh.ts:313-326` correctly correlates the *rotated* token's hash rather than the caller's. `src/codex-core/accounts.ts` maintains a separate durable ledger keyed by its own `refreshTokenHash` (`:468`), so the vault reset cannot desync it.
- **Cap handling / terminal codes.** `withRetry.ts:167-190` now distinguishes `quota.exhausted` (fully capped) from `account.pool.unavailable` / `auth.missing`, and `terminalCodeForCodexExhaustion` keeps the durable code aligned with the emitted diagnostic — a genuine fix to the "wait for a reset that will never help" shape.
- **Prompt assembly containers.** Each of the eight `corePolicy` rules has exactly one container per assembled prompt in every live variant. Agent Mode *replaces* rather than appends (`systemPrompt.ts:68-73`), so the two assemblies never concatenate. `corePolicy.test.ts:113-137` enforces at-most-once for every rule the module owns against real built assemblies, which is a stronger guard than eyeballing. `getSystemRemindersSection()` (the only other container for the four provenance rules) is proactive-only and that assembly has no `# System` section. GPT/Claude keying is correct: both styles interpolate the same constants, and the GPT-only extras (`PROACTIVE EXECUTION`, `INVESTIGATION DISCIPLINE`, `READ DISCIPLINE`, ownership transfer) are documented as deliberate calibration at `promptStyles/gpt.ts:11-16`.
- **Section cache keying.** `sectionCacheKey` length-prefixes the name and encodes inputs unambiguously (`systemPromptSections.ts:57-83`), and `resolveSystemPromptSections` no longer writes from a `cacheBreak` section — which closes the collision where a cached section registered later under the same name and `NO_SECTION_INPUTS` would land on the volatile section's key.
- **WebSocket transport.** The abort plumbing is correct end to end. `acquireConversationTurn`'s abort path resolves its own gate without bypassing `priorTail` and only deletes the queue entry when `pending` hits 0, so later turns stay serialized (`codex-websocket-transport.ts:176-199`). `openSession` has a single `settled` latch so timeout/abort/error/open cannot double-settle, and always clears both the timer and the abort listener. `waitForSessionWithSignal` lets a waiter abort without killing the shared `openingSessions` promise. The abort listener in `_streamTurnAttempt` is added after `send` with an immediate re-check for the race window, and removed in the outer `finally`. No unbounded buffering or listener leak found. Changing the WS-error path from `enqueue({error})` to `failStream(..., {closeSocket: true})` is the right call given `onMessage` has no response-id correlation.
- **Feature gates.** `scripts/build.ts` is unchanged this week and no new `feature('NAME')` call sites were introduced — the only `feature()` line in the diff is the relocated `COORDINATOR_MODE` block in `main.tsx`. Nothing to verify on the both-sides rule.
- **Tool-alias handling.** `PROVIDER_FILE_EDIT_TOOL_ALIASES` denies both names when a role disallows either (`agentToolUtils.ts:241-251`), so a provider swap cannot grant a read-only role write access; and a definition naming `Edit` resolves to `Apply_patch` on the OpenAI pool (`:296-307`). `validTools` keeps the original spec string, but it is only used for display (`AgentDetail.tsx:78`) and validation, never as a permission key, so the spec/tool-name divergence is harmless.
- **Typing.** No new `as` casts in projector-style code, no new unsafe narrowing introduced by the diff. I did not attempt to reason about the known-red root `typecheck` baseline.
