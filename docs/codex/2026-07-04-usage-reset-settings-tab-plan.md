# Usage-reset redemption — Settings "Reset" tab rework (implementation plan)

- Date: 2026-07-04
- Status: approved plan, ready to implement. Supersedes the `/usage reset` entry UX of
  [2026-07-04-usage-reset-design.md](2026-07-04-usage-reset-design.md) (rev 2) — see §7 for the rev-3 addendum you must add there.
- Provenance: the feature itself (API/pool/machine/dialog) is DONE and sits uncommitted in the working tree,
  integration-reviewed and fixed on 2026-07-04. This plan only re-houses the UI entry point per user decision,
  and was itself adversarially reviewed (12 findings adjudicated below).

## 0. Hard constraints (unchanged from the feature)

- **NEVER call live OpenAI/Codex endpoints.** A real POST to `wham/rate-limit-reset-credits/consume` burns a
  limited real credit. All verification uses tests and mocked fetch.
- The branch `migration` carries unrelated uncommitted work (everything under `app/`, plus `docs/maps/*.md`,
  `docs/reports/`). **Do not commit, stash, revert, or clean anything.** Preserve every unrelated diff.
- The working tree already contains the feature's uncommitted diff (see §1). You will modify/delete some of
  those files; you must NOT lose the integration-review fixes listed in §1.3.
- Surgical changes only. No new abstractions, no speculative features. Match neighboring code style.

## 1. Current state (verified in source; trust this over older docs)

### 1.1 What exists uncommitted
- API: `consumeUsageLimitReset` + `resetCreditsAvailable` parse in `src/services/api/codexUsage.ts` (+tests). Done, keep as-is.
- Pool: `applyRedeemedUsageReset`, `redeemedAt` lag guard, `getRedemptionEligibility` in
  `src/services/api/codexAccountPool.ts` (+tests). Done, keep as-is.
- Pre-flight: `refreshPoolAccountForRedeem` in `src/codex-core/accounts.ts` (+test in `accounts.test.ts`). Done, keep as-is.
- Machine: `src/commands/usage/redeemResetMachine.ts` (+test) — React-free state logic, copy, targeting, UUID
  lifetime, outcome mapping. Moves in this rework (§4).
- Dialog: `src/commands/usage/RedeemReset.tsx` — standalone dialog reached by typing `/usage reset`
  (dispatch in `src/commands/usage/usage.tsx`, `argumentHint` in `src/commands/usage/index.ts`). **This UX is
  rejected**; the dialog is deleted and its flow re-housed (§3).
- Settings render fix: `src/components/Settings/Usage.tsx` gates the Codex section on `hasAnyPoolAccount()`. Keep.

### 1.2 User decisions driving this rework
1. The redeem flow becomes a dedicated **"Reset" tab** in Settings (`src/components/Settings/Settings.tsx`),
   after the Usage tab, **hidden when no Codex accounts exist**.
2. `/usage reset` typed dispatch is **removed entirely**. Plain `/usage` keeps opening Settings on the Usage tab.
   Command availability stays `['claude-ai', 'openai']`.
3. The Usage tab's per-account cards additionally show each account's available reset-credit count
   (`AccountUsage.resetCreditsAvailable`) — the user explicitly asked for per-account reset visibility, since a
   capped account can never be made active (`switchToAccount` refuses capped accounts) and redemption targets it
   directly through the picker.

### 1.3 Integration-review fixes that must survive
- `refreshPoolAccountForRedeem` writes raw-branch token rotations back into the in-memory pool
  (`src/codex-core/accounts.ts`, appendAccount block) — regression test
  `accounts.test.ts` "writes a raw-branch rotation back". Untouched by this rework.
- The consume-time pre-flight surfaces a `reauth` outcome as the re-login message instead of POSTing a dead
  token, and success is shown on-screen before any close — both live in `RedeemReset.tsx` today and **must
  carry over into the new tab component** (§3.4, §3.5).
- `parseWindowsReset` typeof narrowing in `codexUsage.ts`. Untouched.

### 1.4 Design invariants that must survive (design doc §5–§9)
- Confirm step always names the target and defaults to **Cancel**.
- Consuming state is non-dismissible (verified: tab nav only works from the header; no Select is mounted during
  consuming, so ←/→/Tab cannot fire; only global Ctrl-C escapes — same as today).
- Idempotency UUID: minted when a confirmation view is built, reused only by "Try again", regenerated on
  re-entry. Tab switching unmounts content (`Tab` renders null unless selected), so re-entry re-runs the flow
  and mints a fresh UUID — the lifetime holds with no extra code.
- Post-success order: `applyRedeemedUsageReset(accountId)` → `invalidateUsageCache()` →
  `fetchPoolUsage({ forceRefresh: true })` **without** `updateRoutingHints`; refresh failure → bare
  "Usage reset." (never a stale count). `no_credit` → `invalidateUsageCache()` + zero the candidate.
- Default target = first enabled `capped/usage_cap` account, falling back to the active account, then first enabled.

## 2. Settings.tsx — decompile, prune, add the tab

`src/components/Settings/Settings.tsx` is React-Compiler output (`_c(25)` memo cells). Its **exact original
source is embedded in its `sourceMappingURL` footer** (`sourcesContent`). Reviewer verified the embedded source
is faithful to compiled behavior (onClose copy, contentHeight math, initialHeaderFocused, Esc gate) with ONE
divergence you must resolve:

- The embedded source has an ant-only Gates tab branch (`..."external" === 'ant' ? [<Tab key="gates">…<Gates/>…] : []`)
  but **no `Gates` import** (stripped by the ANT-ONLY marker step; compiled file carries it as dead
  `false ? … : []` with an unresolved `Gates` identifier). **Drop the branch and its dead companions**: the
  `gatesOwnsEsc` state, the `'Gates'` clause in the Esc gate, and `'Gates'` in the `defaultTab` union (no caller
  passes it). Leave a one-line comment noting the ant-only Gates tab was stripped. Do NOT try to preserve dead
  code that fails lint — the repo's lint only runs on changed files, and this rewrite makes the file a changed file.

Procedure: decode the footer's base64 `sourcesContent`, use it as the new file body (precedent:
`src/commands/usage/usage.tsx` was decompiled the same way by this feature), drop the sourcemap footer, apply
the Gates pruning, then add:

```tsx
// state
const [resetOwnsEsc, setResetOwnsEsc] = useState(false)
// Accumulated audit lines from the Reset tab; emitted on close (§3.5).
const [redeemedLines, setRedeemedLines] = useState<string[]>([])

// Esc gate gains:  && !(selectedTab === 'Reset' && resetOwnsEsc)

// close routine (used by handleEscape AND threaded to the Reset tab):
const closeSettings = () => {
  onClose(
    redeemedLines.length > 0 ? redeemedLines.join('\n') : 'Status dialog dismissed',
    { display: 'system' },
  )
}
// handleEscape keeps its tabsHidden guard and calls closeSettings().

// tabs array, after the Usage tab:
...(hasAnyPoolAccount()
  ? [
      <Tab key="reset" title="Reset">
        <Reset
          onOwnsEscChange={setResetOwnsEsc}
          onRedeemed={(line) => setRedeemedLines((prev) => [...prev, line])}
          onRequestClose={closeSettings}
        />
      </Tab>,
    ]
  : []),
```

Notes:
- `hasAnyPoolAccount()` inline and non-reactive is the accepted repo pattern (same gate as Usage.tsx's Codex
  section). Pool initializes at startup (`src/entrypoints/init.ts` → `void initAccountPool()`); a pool that
  initializes while Settings is open surfaces the tab on the next state-driven re-render. Acceptable.
- `defaultTab` union stays `'Status' | 'Config' | 'Usage'` — nothing deep-links to Reset.
- Beware stale closures: `closeSettings`/`handleEscape` must see current `redeemedLines` (plain function reads
  state each render; if you memoize, include deps).

## 3. New `src/components/Settings/Reset.tsx` — the flow as tab content

Re-house `src/commands/usage/RedeemReset.tsx`'s logic (then delete that file). No design-system `Dialog`
wrapper — render as plain tab content like `Usage.tsx` (bold `<Text>` section titles, dim hints).

### 3.1 Props
```ts
type ResetProps = {
  onOwnsEscChange: (owns: boolean) => void   // true only while consuming
  onRedeemed: (transcriptLine: string) => void
  onRequestClose: () => void                 // Settings' close routine (emits audit lines)
}
```

### 3.2 Phases (tab-local type — deliberate; see §4 for the machine exports you delete)
`checking → check_failed | no_eligible | picker | confirm → consuming → result` — including the two paths the
dialog already has: **skip the picker when exactly one enabled candidate**, and `check_failed` when the
availability read throws. Carry over `describeCandidate`, the effects order (pre-flight all accounts via
`refreshPoolAccountForRedeem` → `fetchPoolUsage({ forceRefresh: true })` → `buildCandidates` → route), the
`cancelled`/mounted guards, and the whole `consume()` body from RedeemReset.tsx **including the reauth
surfacing and the same-UUID retry payload**.

### 3.3 Focus & keyboard (the fiddly part — follow existing tab precedents)
- Selects (picker, confirm, retry, and every single-option Close) use the `useTabHeaderFocus()` pattern from
  `src/components/design-system/Tabs.tsx:296` docstring: `isDisabled={headerFocused}`,
  `onUpFromFirstItem={focusHeader}`. **Split subcomponents so the hook is only called where a Select actually
  renders** (the docstring's early-return caveat). Working examples:
  `src/components/sandbox/SandboxOverridesTab.tsx`, `src/components/permissions/rules/WorkspaceTab.tsx`.
- **No `onCancel` on any Select.** Settings owns Esc; a Select `onCancel` would register a competing
  `select:cancel` Esc handler that never wins (Settings' earlier-mounted handler takes it) — dead at best.
- Terminal states (check_failed, no_eligible, result) render the message + a **single-option `[Close]` Select**
  whose `onChange` → `onRequestClose()`. This mirrors today's MessageDialog UX and avoids a focus trap: with no
  Select mounted, content focus can never return to the header and arrows die. ↑ from Close hands focus back to
  the tab row so the user can also just tab away.
- Consuming: render `<LoadingState message={COPY.consuming} />`, call `onOwnsEscChange(true)` on entry and
  `false` when leaving (useEffect on phase; also reset on unmount). While consuming, register a no-op
  `useKeybinding('confirm:no', noop, { context: 'Settings', isActive: consuming })` as a belt-and-braces Esc
  swallow (reviewer verified nothing dangerous catches Esc anyway; this mirrors the dialog's `onCancel={() => {}}`).

### 3.4 Confirm & consume semantics (carry over verbatim from RedeemReset.tsx)
- Confirm: subtitle `confirmSubtitle(count)` when count known; description `confirmDescription(...)`; always
  names the target (`Account: {label}`); Select options `[Use a reset, Cancel]` with
  `defaultFocusValue="cancel"`. Cancel → back to the **picker** if it was shown, else `onRequestClose()`.
  (Dialog-land exited entirely; tab-land returning to the picker is the natural equivalent. Either way a NEW
  confirm view mints a NEW UUID — the §6 lifetime requires exactly that.)
- consume(): re-resolve pool account → `refreshPoolAccountForRedeem` → **if `reauth`, show its message as a
  terminal result** → re-resolve token from pool → `consumeUsageLimitReset(account, redeemRequestId)` →
  `mapConsumeOutcome`. Error result keeps `retry: { target, redeemRequestId }` → `[Try again, Close]`,
  Try again re-enters consume() with the SAME UUID.

### 3.5 Success (auditability — reviewer finding, do not skip)
On success: post-success order per §1.4, compute `leftCount`, then
1. `onRedeemed(redeemedTranscript(target.label, leftCount))` — Settings emits accumulated lines through its
   existing `onClose(result)` plumbing when Settings closes, replacing the generic "Status dialog dismissed".
   This preserves the design's transcript record for a credit-spending action.
2. Show the in-page success message (`successMessage(...)` → "Usage reset. You have N usage limit reset(s)
   left." / bare fallback) + `[Close]` Select.

### 3.6 Accepted costs (record in rev-3, don't "fix")
- Selecting the Reset tab in the header (even arrowing onto it) mounts content and fires the pre-flight +
  `forceRefresh` usage read. Accepted: pools are small (1–4 accounts), reads are GETs, token refreshes only
  fire near expiry, and the design requires a fresh availability read on entry.

## 4. Machine module move & pruning

- Move `src/commands/usage/redeemResetMachine.ts` and `.test.ts` → `src/components/Settings/` (fix relative
  imports: `../../services/…` stays the same depth — verify).
- Delete now-dead exports **and their tests**: `RedeemPhase`, `isPhaseDismissible` (the tab derives ownsEsc
  from its own phase — a one-line check; keeping spec-only exports wired to nothing is false coverage), and
  `COPY.noAccounts` (the tab is hidden instead; the copy is unreachable).
- **Keep `redeemedTranscript`** and its tests — it's used by §3.5.
- Update the module header docstring ("for the `/usage reset` redeem dialog" → the Settings Reset tab) and the
  COPY comment's design-doc pointer.

## 5. Usage tab — per-account reset counts

In `CodexPoolUsageSection` (`src/components/Settings/Usage.tsx` — this component is plain React, safe to edit),
inside the non-free `acct.usage` branch after the LimitBars, when `acct.usage.resetCreditsAvailable !== undefined`:

```tsx
<Text dimColor>
  {acct.usage.resetCreditsAvailable} usage limit reset{acct.usage.resetCreditsAvailable === 1 ? '' : 's'} available
  {acct.usage.resetCreditsAvailable > 0 ? ' · Reset tab to redeem' : ''}
</Text>
```

Hide when `undefined` (free plans / older backends — "unknown" on every card is noise; the picker still shows
"reset availability unknown" where the user makes the targeting choice).

## 6. Removals / reverts

- Delete `src/commands/usage/RedeemReset.tsx`.
- `src/commands/usage/usage.tsx` → back to plain (keep the clean decompiled style, drop dispatch + imports):
  ```tsx
  import * as React from 'react'
  import { Settings } from '../../components/Settings/Settings.js'
  import type { LocalJSXCommandCall } from '../../types/command.js'

  export const call: LocalJSXCommandCall = async (onDone, context) => {
    return <Settings onClose={onDone} context={context} defaultTab="Usage" />
  }
  ```
- `src/commands/usage/index.ts`: delete the `argumentHint: '[reset]'` line. KEEP
  `availability: ['claude-ai', 'openai']` (Codex sessions must be able to open `/usage` at all;
  `src/utils/fastMode.test.ts` asserts this — leave that test alone).

## 7. Design doc rev-3 addendum (required)

Append a `## 15. Rev 3 — Settings Reset tab (2026-07-04)` section to
`2026-07-04-usage-reset-design.md` (bump the Status line to rev 3) recording:
1. User rejected the `/usage reset` typed entry; placement is now a dedicated Settings tab. This re-adjudicates
   §3: option A was rejected for lacking a selection model *inside the Usage tab* — a dedicated tab IS a page
   with its own selection model, so the old objection doesn't apply. `/usage reset` dispatch removed.
2. Exposure expansion: Settings also opens via `/config` and `/status`, so console API-key sessions holding a
   codex pool can now reach redemption — deliberately reversing the §4/§13 accepted edge (those pools cap too).
3. Transcript: the §9 `onDone` line is now emitted through Settings' close (`onClose(result)`), accumulated
   across redemptions in one Settings session.
4. Accepted cost: tab selection fires pre-flight + forced usage read (§3.6 above).
5. Discoverability: with zero codex accounts the tab is hidden and nothing points at redemption (the old
   no-accounts message is gone). Accepted.
6. Slice 4 realized: Usage cards show per-account reset counts (§5 above).

## 8. Verification contract (run all; report failures verbatim)

1. `bun test src/components/Settings/redeemResetMachine.test.ts src/services/api/codexUsage.test.ts src/services/api/codexAccountPool.test.ts src/utils/fastMode.test.ts src/codex-core/accounts.test.ts`
2. Broader: `bun test src/services/api/ src/commands/ src/components/Settings/ src/codex-core/`
3. Typecheck: `bunx tsc --noEmit 2>&1 | rg "components/Settings|commands/usage|codexUsage|codexAccountPool|codex-core/accounts"` —
   must produce **zero new lines**. (Repo has ~1.9k pre-existing errors elsewhere; one pre-existing hit at
   `codexUsage.ts` ~line 383 `sortPoolUsageDisplayAccounts` statusOrder is NOT yours — leave it.)
4. Lint the touched files explicitly (the repo `lint` script only diffs committed files):
   `bunx eslint --suppressions-location eslint-suppressions.json --suppress-rule react-hooks/rules-of-hooks --suppress-rule react-hooks/exhaustive-deps --suppress-rule custom-rules/prefer-use-terminal-size <touched files>`
5. `bun run build:dev:full`
6. Smoke: `bun -e "const s = await import('./src/components/Settings/Settings.tsx'); const r = await import('./src/components/Settings/Reset.tsx'); console.log(typeof s.Settings, typeof r.Reset)"`
7. Stale-reference sweep: `rg -n "usage reset|RedeemReset|redeemResetMachine|argumentHint|isPhaseDismissible|RedeemPhase|noAccounts" src/ docs/codex/` — every hit must be intentional.
   `src/commands/reset-limits/` is unrelated live-imported Anthropic legacy — do not touch it.

## 9. Out of scope

- Any change to the API/pool/pre-flight layers (§1.1 first three bullets).
- Committing. The feature ships later, on main, as: this rework + the existing feature diff + the four
  `docs/codex/2026-07-04-usage-reset-*.md` files (design, upstream-facts, recon, this plan).
- The one live redemption acceptance test — user-gated, never run it.
