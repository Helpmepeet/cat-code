# Permission prompt / queue / rules editor drift — prototype vs impl (2026-07-13)

**Our:** `app/renderer/src/PermissionPrompt.tsx`, `PermissionQueue.tsx`, `PermissionRulesEditor.tsx` (+ `permissionState.ts`, `App.tsx`, `PermissionModeChip.tsx`, `SettingsShell.tsx` as wiring context)
**Prototype:** `~/catcode_prototype/cat-app/Permissions.jsx` (601 lines), `PermissionRules.jsx` (318 lines)
**Built status:** `PermissionPrompt`/`PermissionQueue` — built and mounted (`App.tsx:2144`). `PermissionRulesEditor` — **built but currently UNMOUNTED anywhere in the app** (see H1); zero UI entry point exists today for the always-allow/deny/ask rules list.

## Scoreboard — H:1 M:1 L:1

## Findings (High → Low)

**[High] Rules-list view has zero mount point — a previously-built C3 surface silently disappeared.**
`PermissionRulesEditor.tsx` (allow/deny/ask rule groups + mode buttons + additional dirs — the closest
analog to prototype `PermissionRules.jsx`) is fully implemented and exported but is **not imported by
any other file in `app/`** except its own module (confirmed by repo-wide grep). It used to be mounted
inside a `<details>` "Permissions" disclosure in `App.tsx` (commit `010e8ba`, P2-4), but that mount was
**deleted** in the P4-24 reskin commit `f213c8c` (`app/renderer/src/App.tsx`, diff removes the
`<details>...<PermissionRulesEditor context={permissionContext} onSetMode={setPermissionMode}/></details>`
block) in favor of the new compact `PermissionModeChip` — which **only** renders the mode popover
(`app/renderer/src/PermissionModeChip.tsx:104-226`, read in full: no import of `PermissionRulesEditor`,
no rules list anywhere). `PermissionRulesEditor` did gain a `showModes` prop in that same commit whose
doc comment says "the `PermissionModeChip` owns mode switching and reuses this for the rules"
(`PermissionRulesEditor.tsx:31-33`) — but that reuse was never wired. Worse, `docs/migration/STATUS.md:286`
(P4-24 "EMPTY STATE & MODE CHIP" sub-entry) explicitly claims *"read-only rules tucked below (reuses
`PermissionRulesEditor` with a new `showModes={false}` prop)"* — false against current source; no test
(`PermissionModeChip.test.tsx` has zero references to `PermissionRulesEditor`) and no render path back
this up. Meanwhile `SettingsShell.tsx:69,109,130` lists a "Permissions" Settings category whose own
honesty-stub owner map says `permissions: 'the Permissions domain (P2-4 — rules editor)'` — i.e. it
already knows the component that should fill it — yet `SettingsShell.tsx:404` still falls through to
the generic `CategoryStub` ("coming soon"). Net effect: a user has **no way to see their always-allow /
always-deny / always-ask rules** in the running app at all (mode switching itself still works, via
`PermissionModeChip`). This is a real, unowned regression, not a `PARITY-LEDGER` tracked cut —
`PARITY-LEDGER.md:558-560,565` (last touched 2026-07-07, `git blame` confirms, pre-dating the
regression) still say ✅ built / mounted at a line (`App.tsx:1118`) that no longer exists.
Fix: wire `<PermissionRulesEditor context={selectPermissionContext(permissions, activeSessionId)}
onSetMode={setPermissionMode} showModes={true} />` into `SettingsShell.tsx`'s `category === 'permissions'`
branch (mirrors the prototype's own placement — `PermissionRules.jsx:206-207` "mounted by Settings
PermissionsPanel") — additional dirs are already duplicated correctly via `WorkspaceTrustSection`
(`SettingsShell.tsx:335-338`) so only the rule-group + mode display needs the new home. Alternatively,
if the composer-popover placement is preferred, actually embed `<PermissionRulesEditor showModes={false}>`
under `PermissionModeChip`'s popover as both the commit message and STATUS.md already (incorrectly)
claim was done.

**[Med] Rule-behavior color coding dropped without an owner note beyond "info preserved."**
Prototype's `RuleRow`/`BehaviorPill` colors every rule by its own behavior — allow `#4ade80` (green),
deny `#f87171` (red), ask `#fbbf24` (amber) — per-row, regardless of which group it's in
(`PermissionRules.jsx:14-18,29-39`, confirmed against `theme.css` — our `--tone-good`/`--tone-danger`/
`--tone-warn` tokens are exactly these three hexes, so the color vocabulary already exists in our
theme). Our `RuleGroup` (`PermissionRulesEditor.tsx:94-126`) only conveys behavior via the section
heading text ("Always allow"/"Always deny"/"Always ask") with plain `text-text-primary` rule rows —
no color at all. `PARITY-LEDGER.md:571` already tags this 🔁 adapted ("color chrome dropped, info
preserved"), so this is DEFERRED not new drift, but flagging because the fix is now trivial and cheap
given the tone tokens already resolve to the prototype's exact hexes: apply `text-tone-good`/
`text-tone-danger`/`text-tone-warn` to each `RuleGroup`'s heading (or a small leading dot) instead of
introducing a new badge component.

**[Low] "Manage rules →" footer affordance has no equivalent, and is now doubly stale.**
Prototype's queue card footer has a `Manage rules →` link that opens the rules editor
(`Permissions.jsx:590`, `onManageRules`). `PARITY-LEDGER.md:535` marks this 🔁 adapted, citing the
(now-deleted) `<details>` "Permissions" disclosure as the real-world equivalent. Since H1 removed that
disclosure entirely, there is currently no path — footer link, popover link, or otherwise — from either
`PermissionQueue.tsx` or `PermissionModeChip.tsx` to any rules view. Once H1's fix lands (a Settings
category), consider a lightweight cross-link (e.g. `PermissionModeChip`'s popover footer → open
Settings▸Permissions) so the affordance the prototype provides at the point of use isn't fully lost.

## Deferred / intentional (not drift)

- Per-lane accent colors + lane tags (bash=amber, file-edit=pink, sandbox=teal, etc.) — **DEFERRED**:
  `PARITY-LEDGER.md:505-507`, `specs/2026-07-03-S2-permission-update.md §7` ("MOCK-only lane
  vocabulary; real card uses one themeable accent"). Confirms the review-spec hint's "allow=green?
  deny=red?" question resolves the same way on both sides: neither the prototype's `Yes`/`No` select
  rows nor our `Allow`/`Deny` buttons are green/red-tinted (that vocabulary exists only in
  `PermissionRules.jsx`'s `BehaviorPill`, see Med finding above) — no drift here.
- Numbered keyboard select-list (1-9 pick, ↑/↓/j/k/⌃P/⌃N cursor, "don't ask again" as a list option) —
  **DEFERRED/INTENTIONAL**: `PARITY-LEDGER.md:527-529`. Real keyset is `Enter=allow · N/⌫=deny ·
  Esc=snooze` (`PermissionPrompt.tsx:14-22`), a deliberate reduction, not an oversight.
- Esc = snooze (stays pending, restorable) vs. prototype's Esc = reject — **INTENTIONAL**, restated in
  `PermissionQueue.tsx:4-12` doc comment and `PARITY-LEDGER.md:530`; matches the real protocol (S2 §2):
  there is no request timeout, so "keep pending" must be recoverable, not a reject.
  `permissionActionForKey` adds explicit `N`/`Backspace` deny keys the prototype didn't have
  (`PARITY-LEDGER.md:531`, real-added).
  Multiple simultaneously-visible cards vs. prototype's strict one-at-a-time head-of-queue —
  **INTENTIONAL/adapted**, `PARITY-LEDGER.md:504`, `permissionState.ts:9-12`: the real protocol allows
  N truly-parallel pending requests (parallel tool calls in one turn); the prototype's lane-priority
  single-card framing was UI policy mirroring the TUI, not a protocol constraint.
- No client-side `ruleImplication`/rule-guessing, no renderer-authored rule CRUD (add/edit/remove
  rule, tool-select, content input, destination-select, implication preview) — **INTENTIONAL, security
  boundary**: `decisions/PERMISSION-BOUNDARY.md` §2/§4 (C1/C3) — "no renderer byte ever becomes rule
  content, rule scope, or rule destination"; editing/removing a rule is exactly the T6b escalation the
  boundary rejects. `PARITY-LEDGER.md:578-590` tags every prototype editor control ✂️ cut against this
  decision. This is the single biggest structural difference from `PermissionRules.jsx` (full CRUD
  editor vs. our read-only view) and it is fully load-bearing, not an oversight.
  `bypassPermissions` mode is correctly shown-disabled-with-launch-flag-hint, but only in
  `PermissionModeChip.tsx:166-179` (already reviewed/out of scope) — `PermissionRulesEditor.tsx`'s own
  mode row (`showModes=true` path) has no such disabled/hint treatment for `bypassPermissions`; moot
  today since nothing renders that path (H1), but worth remembering when H1's fix lands.
- Denial tracker (consecutive/total bars), classifier & debugging toggles, per-tool grouping, add/edit
  rule row, Field-wrapper scaffolding (desc/source-badge/modified/reset) — **DEFERRED/CUT**,
  `PARITY-LEDGER.md:573-576,591-594` (per-tool grouping 🔁 adapted — axis changed to behavior-then-source
  because the wire snapshot is `Record<source,string[]>` per behavior, not per tool; denial tracker ✂️
  cut, session-only mock counters never migrated).
  Match-type label per rule (exact/prefix/wildcard) and "Managed-rules-only enforcement" toggle are
  already tracked ❓ missing-no-owner (`PARITY-LEDGER.md:577,593`) — pre-existing, not something this
  review adds.
- Per-variant icon/kicker/preview vocabulary (shield/edit/folder/globe/…, inline command title, file-edit
  diff hunks, sandbox network detail, AskUserQuestion rich flow) collapsing to one generic accent +
  raw-JSON `<pre>` card — **DEFERRED**, extensively tracked `PARITY-LEDGER.md:507-522,551` (including one
  ❓ missing-no-owner: AskUserQuestion has no dedicated keyboard handler, `PARITY-LEDGER.md:551`,
  pre-existing).

## Doc-drift notes

- `docs/migration/STATUS.md:286` (P4-24 "+ EMPTY STATE & MODE CHIP 2026-07-12" sub-entry) states the
  mode chip "reuses `PermissionRulesEditor` with a new `showModes={false}` prop" for a tucked-below
  rules view. Current source contradicts this: `PermissionModeChip.tsx` never imports or renders
  `PermissionRulesEditor`, and its own doc comment (`PermissionModeChip.tsx:19-21`) says the opposite —
  rules are explicitly NOT shown in this popover, deferred to "a future desktop page." Source wins;
  STATUS is wrong on this point (see H1).
- `docs/migration/PARITY-LEDGER.md:127,132,535,558-560,565` (all `git blame`-dated 2026-07-07, i.e.
  before the P4-24 `f213c8c` regression) cite `App.tsx:1108-1123`/`:1118`/`:1120` as the
  `PermissionRulesEditor` mount site and mark the C2 mode-switcher and C3 rules view/mode-pill ✅
  built via that mount. That code no longer exists (see H1) — these rows need re-verification/
  re-disposition, not a straight ✅ carry-forward.
