# Effort cross-session statusline leak — findings for review

Date: 2026-06-17
Status: RESOLVED 2026-06-17 — fix applied (Option A, see below). Verified by
adversarial subagent review + build + StatusLine tests.

## Outcome

Independent review CONFIRMED the Problem 1 chain and Problem 2 (symptom of the
leak, not a separate bug). It CORRECTED the fix choice: Option B (gate to
`flagSettings`) is **dead code** — `flagSettings` is never watched
(changeDetector.ts:190-196) and never notified, and `applyFlagSettings` does not
exist (only a stale comment). So the chosen fix is **Option A: remove the effort
-propagation block** from `applySettingsChange.ts`. effortValue is now owned
solely by session-local writers (/effort, ModelPicker, EffortCallout, --effort).
Build passes; StatusLine tests pass; no test depended on the removed block.

## CORRECTION (post-investigation)

Two SEPARATE apps, sharing `~/.claude/statusline-command.sh`:
- **cat-code**: `~/.cat-code/settings.json` → `model: gpt-5.5`, `effortLevel: high`.
  Runs Codex (GPT-5.4/5.5), NOT Anthropic. → Problem 1 (cross-session leak).
- **Claude Code** (upstream, `/Users/pt/.local/share/claude/versions/2.1.178`):
  `~/.claude/settings.json` → `model: opus` (→ claude-opus-4-8), `effortLevel: xhigh`.
  → Problem 2.

Problem 2 was NOT a cat-code bug and NOT a max→high clamp (verified
`UvH('claude-opus-4-8')===true` in the CC binary, so max is NOT downgraded). It
was the SHARED statusline script: Claude Code emits effort as `.effort.level`
(schema line 428: "after any silent downgrade … CLAUDE_EFFORT env var"), but the
script only read `.effortLevel`/`.session.*`/`.agent.*` → empty → fell back to
`~/.cat-code/settings.json` → showed cat-code's GPT-5.5 effort `high`. So Claude
Code's statusline was literally displaying cat-code's effort. Fixed by (a) adding
`.effort.level` to the jq chain, (b) dropping the cross-app fallback (user choice)
so each app shows only its own payload effort.

## User report

1. **Leak**: With multiple cat-code terminal sessions open, running `/effort <x>`
   in one session updates the statusline effort indicator in the *other*
   sessions.
2. **Local mismatch**: After `/effort max`, the statusline still shows `high`
   in the reporting session.
3. User note: "the claude code statusline seems to share the same code as
   cat-code" — i.e. they suspect the custom statusLine hook is shared.

User environment (verified):
- `USER_TYPE` unset → **non-ant**.
- `CLAUDE_CODE_EFFORT_LEVEL` unset → no env override.
- `~/.claude/settings.json`: `model: "opus"`, `effortLevel: "xhigh"`.
- The `opus` alias resolves via `getDefaultOpusModel()` → `getModelStrings().opus46`
  → `claude-opus-4-6` (configs.ts:81-87). This build's highest Opus is 4.6;
  `opus-4-8` exists nowhere in source. (The live harness banner "Opus 4.8" is the
  model *I* run on, not what this forked build knows.)

## Problem 1 — the leak (CONFIRMED, primary fix target)

Statusline reads effort from **AppState** (`StatusLine.tsx:188`,
`s => s.effortValue`), which should be session-local. The leak is that a foreign
settings-file write gets pushed *into* this session's AppState:

### Write path (session A)
`/effort low|medium|high` → `effort.tsx:setEffortValue` →
`updateSettingsForSource('userSettings', { effortLevel })`. This writes the
**global** `~/.claude/settings.json` (effort.tsx:19-21).
- `toPersistableEffort` (effort.ts:107-117): `low|medium|high` persist for all
  users; `max` persists **only for ants**, else returns `undefined` (no disk
  write). So for this non-ant user, `/effort max` writes nothing → does NOT
  leak; `/effort low|medium|high` writes the global file → DOES leak.

### Propagation path (session B)
1. `changeDetector.ts` chokidar-watches the settings dir.
2. Session A's own write is marked internal and suppressed for A only
   (`consumeInternalWrite`, changeDetector.ts:284). **Session B never marked it
   internal**, so B's watcher fires → `fanOut(source)` → `applySettingsChange`.
3. `applySettingsChange.ts:74-89`:
   ```js
   const prevEffort = prev.settings.effortLevel
   const newEffort = newSettings.effortLevel
   const effortChanged = prevEffort !== newEffort
   ...
   ...(effortChanged && newEffort !== undefined ? { effortValue: newEffort } : {})
   ```
   B's `prev.settings.effortLevel` differs from A's new value → `effortChanged`
   true, `newEffort` defined → **B's `AppState.effortValue` is overwritten** with
   A's choice.
4. `StatusLine.tsx:292` detects `effortValue` changed → re-renders → B's
   statusline now shows A's effort.

### Why this is the same bug class already fixed for `/model`
`StatusLine.tsx:195-198` documents the twin bug: `/model` in another session
leaked because the statusline re-read settings.json; fixed by sourcing model from
AppState. Effort already reads from AppState, but `applySettingsChange` actively
*pushes* the shared-file value back into AppState — re-introducing the leak from
the other direction.

### Does the effort-sync block protect anything real here?
The block's stated purpose (applySettingsChange.ts:70-73) is to propagate effort
when the **IDE** pushes it via `applyFlagSettings`. Grep shows **no other source
in this fork writes effort via a flag/IDE path** — only the comment references
`applyFlagSettings`. The block appears vestigial for an upstream IDE flow while
actively causing the cross-session leak.

Also note: it overwrites `effortValue` even for a **same-session** internal IDE
push — but real /effort writes are suppressed as internal, so in practice the
only changes that reach this block for `userSettings` are FOREIGN (other-session)
writes. That is exactly what we must NOT propagate.

## Problem 2 — max shows as high (NOT reproduced analytically)

After `/effort max` (non-ant), `AppState.effortValue = 'max'` (the command stdout
confirms "Set effort level to max (this session only)"). Statusline computes
`getDisplayedEffortLevel(runtimeModel, 'max')`:
- `runtimeModel` = `claude-opus-4-6` (no `[1m]`, not opusplan → unchanged by
  `getRuntimeMainLoopModel`).
- `modelSupportsMaxEffort('claude-opus-4-6')` → **true** (effort.ts:65).
- So `resolveAppliedEffort` does NOT clamp → returns `'max'` → statusline should
  show `max`.

Therefore, analytically the reporting session should show `max`, not `high`. Most
likely explanation: the user was looking at the **leaked value in another
session** (which shows whatever was last persisted, e.g. `high`), OR a 300ms
debounce lag. **This is consistent with Problem 1, not a separate bug.** Reviewer:
please challenge this — is there a model string or code path where `opus-4-6`
would NOT support max, or where the statusline would read stale effort?

(Caveat: `effortLevel: "xhigh"` in settings parses to `undefined` via
`parseEffortValue` — `xhigh` is not in `EFFORT_LEVELS` and `parseInt('xhigh')` is
NaN. So it contributes nothing; AppState starts at `effortValue: undefined`. Not
the cause of Problem 2.)

## Proposed fix (for review)

**Primary (Problem 1):** Stop `applySettingsChange` from clobbering session-local
`effortValue` with foreign settings-file writes. Effort is session-scoped state
(like the model selection); other sessions must not mutate it.

Options:
- (A) **Remove the effort-propagation block** from `applySettingsChange.ts:70-89`
  entirely. AppState.effortValue stays owned by the /effort command and CLI flag.
  Risk: loses the (apparently unused) IDE flag-push propagation.
- (B) Keep the block but gate it to **`flagSettings`/IDE source only**, never
  `userSettings`/`projectSettings`/`localSettings`. Preserves IDE intent,
  eliminates the cross-session leak. More surgical.

Leaning (B): narrowest change, preserves the documented IDE intent, kills the
leak. Reviewer to confirm `flagSettings` is the right (and only) source that
should propagate effort, and that `flagSettings` is not itself shared across
sessions.

**Secondary (Problem 2):** Likely no code change — it's a manifestation of the
leak. Confirm during verification.

## Files
- `src/utils/settings/applySettingsChange.ts` (primary fix site)
- `src/commands/effort/effort.tsx` (write path; persists to userSettings)
- `src/utils/effort.ts` (toPersistableEffort, resolveAppliedEffort)
- `src/components/StatusLine.tsx` (reads effortValue from AppState; /model precedent)
- `src/utils/settings/changeDetector.ts` (internal-write suppression — per session)
