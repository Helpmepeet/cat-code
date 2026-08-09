# A17 — settings scope, agent identity, theming, misc renderer state

## Verdict

The settings-scope layer is the strongest code in this scope: `selectSettingsRow`'s
branch order is a faithful, well-tested encoding of the spec's annotation priority,
`settingsRowNote` genuinely returns null for the ordinary case, and every value read
is source-scoped rather than a blind key lookup. The precedence order in
`settingsState.ts` agrees with the engine's today, but it is a hand-maintained
reversal with no compile-time tie to `SETTING_SOURCES`, and the engine's *effective*
merge order is `getEnabledSettingSources()` — not `SETTING_SOURCES` — so the two are
already structurally divergent, not merely at risk. The single most important thing
to fix is `agentIdentity.ts:247`: an unguarded object-literal index on a
model-supplied `subagent_type` returns `Object.prototype` members, defeats the `??`
fallback, and throws inside the transcript render path. Beyond that, three modules in
this scope are built, documented at length, and completely unwired.

## Findings

### [HIGH] `agentTypeMeta` indexes an object literal with model-supplied text, so `subagent_type: "toString"` crashes the transcript

- **Where**: `app/renderer/src/agentIdentity.ts:244-256`
- **Type**: correctness
- **What**: `AGENT_TYPE_META[type as AgentTypeKey] ?? { …neutral fallback… }` reads
  through the prototype chain. For any `Object.prototype` member name the lookup
  returns a truthy value (a function, or `Object.prototype` itself for `__proto__`),
  so `??` never fires and the caller receives an object with `label: undefined` and
  `tone: undefined`.
- **Trigger / why it matters**: `type` is `firstString(data.agentType, data.role,
  data.subagent_type)` (`agentIdentity.ts:316`), and `subagent_type` is lifted
  verbatim from the Agent tool's `input` at `TranscriptView.tsx:1663`. A model turn
  that calls `Agent(subagent_type: "toString", …)` — or `"constructor"`,
  `"valueOf"`, `"hasOwnProperty"`, `"__proto__"` — reaches
  `TranscriptView.tsx:1801-1803` (`AGENT_TYPE_TONE_CLASS[vocab.type.tone]` →
  `undefined`) and then `TranscriptView.tsx:1856` `${typeTone.text}` →
  `TypeError: Cannot read properties of undefined`. `AgentChrome.tsx:92-97`
  (`AgentTypeChip`) and `AgentChrome.tsx:62-64` (`AgentRoleDot`, reached from
  `TranscriptView.tsx:1851`) throw the same way. This is a render-path throw from
  untrusted input, which is exactly what the repo's "display = degrade gracefully"
  rule forbids; the whole transcript pane goes.
- **Fix**: gate the lookup on real ownership before the fallback —
  `const known = Object.hasOwn(AGENT_TYPE_META, type) ? AGENT_TYPE_META[type as AgentTypeKey] : undefined`
  (or build `AGENT_TYPE_META` with a null prototype). One line, and the existing
  neutral fallback then does its job.

### [MED] Setting precedence is duplicated in the renderer and does not match the engine's *effective* merge order

- **Where**: `app/renderer/src/settingsState.ts:141-151` (`SETTING_SOURCE_PRECEDENCE`),
  consumed only by `app/renderer/src/settingsScope.ts:554-558` (`rank`)
- **Type**: quality / design (duplication of engine machinery in `app/`)
- **What**: `SETTING_SOURCE_PRECEDENCE` is a hand-written reversal of the engine's
  `SETTING_SOURCES` (`src/utils/settings/constants.ts:7-22`, ascending: user,
  project, local, flag, policy). The two agree today — I checked element by element.
  But the engine does **not** merge in `SETTING_SOURCES` order: `getInitialSettings`
  iterates `getEnabledSettingSources()` (`src/utils/settings/settings.ts:778`), and
  that function (`src/utils/settings/constants.ts:159-168`) returns
  `Array.from(new Set([...allowed, 'policySettings', 'flagSettings']))` — caller order
  first, then policy, then flag. `parseSettingSourcesFlag`
  (`src/utils/settings/constants.ts:128-153`) preserves whatever order the operator
  typed and never emits flag/policy. So under any non-default `--setting-sources`
  (say `local,user`), the engine's real winner for a key is `userSettings`, and flag
  beats policy — while the desktop's row grammar keeps reporting the canonical order,
  because the sidecar deliberately walks `SETTING_SOURCES` instead
  (`app/sidecar/settingsDomain.ts:360-372`, whose own comment names the
  policy-before-flag quirk).
- **Trigger / why it matters**: they coincide today only because the default
  `allowedSettingSources` (`src/bootstrap/state.ts:328-334`) happens to be the
  canonical order and nothing in `app/` sets it (verified: no `allowedSettingSources`
  / `--setting-sources` reference anywhere under `app/`). The renderer would then
  tell the operator "Overridden by your private settings for this project" and route
  a write on that basis while the engine resolves the opposite way. Two copies of a
  precedence rule with no shared constant is the named recurring mistake in this repo.
- **Fix**: export the order from one place. The snapshot already carries
  `layers[]` in ascending precedence (`settingsDomain.ts:372-382`); have `rank()`
  read the layer index off the snapshot, falling back to a constant re-exported from
  `SETTING_SOURCES` rather than retyped. At minimum add a type-level or test-level
  assertion that `SETTING_SOURCE_PRECEDENCE` is `[...SETTING_SOURCES].reverse()`.

### [MED] `settingsProjectBinding.ts` is entirely unwired, and the bug it exists to prevent is live

- **Where**: `app/renderer/src/settingsProjectBinding.ts:89-107`
  (`selectSettingsProjectBinding`), `app/renderer/src/App.tsx:3218-3239`
- **Type**: dead-code / correctness
- **What**: the module's entry point has zero production callers (only its own test).
  `SettingsShell.tsx:156-163` accepts `projectBinding?: SettingsProjectBinding`, and
  the `<SettingsShell …>` call site at `App.tsx:3218-3239` passes neither
  `projectBinding` nor `projects`.
- **Trigger / why it matters**: with both undefined, `SettingsShell.tsx:203-206`
  computes `known = undefined` and `selectSettingsProjects(undefined, activeCwd)`
  labels the one entry with `settingsProjectLabel(active)` — the bare last path
  segment (`settingsScope.ts:159-163`). That is precisely the collision the module's
  own doc block (`settingsProjectBinding.ts:109-136`) says it was written to remove:
  two adjacent projects both reading `app`, `/Users/pt/cat-code/app` vs
  `/Users/pt/PTClove/app`, operator-reported 2026-07-26. The fix exists in source,
  fully reasoned and tested, and is not connected. `resolveWorkspaceName` and the
  three `SettingsProjectUnboundReason` sentences ride along unused
  (`SETTINGS_PROJECT_UNBOUND_NOTE` is referenced only by a comment in
  `sessionInspectorState.ts:111`).
- **Fix**: one line at the call site —
  `projectBinding={selectSettingsProjectBinding(mergedRows, activeSessionId)}` — or
  delete the module and its test if the binding is no longer wanted. Leaving it in
  the tree as documented-but-inert is the worst of the three.

### [MED] `usePopoverFocus` throws away the restore target the stack computed for it, so outside-click dismissal drops focus to `<body>`

- **Where**: `app/renderer/src/overlayFocus.ts:387-390` (cleanup ignores
  `unregister()`'s return), vs `overlayFocus.ts:304-310` where the modal honors it
- **Type**: correctness (keyboard accessibility)
- **What**: `unregister` returns `{ restoreTarget, shouldRestore }` and does real
  work to produce it — reparenting higher entries whose restore target lived inside
  the removed container (`overlayFocus.ts:167-175`) and walking disconnected targets
  (`resolveConnectedRestoreTarget`, `overlayFocus.ts:127-141`). The popover hook
  discards both. Focus restore therefore happens only where a consumer remembers to
  call `restoreTriggerFocus()` by hand.
- **Trigger / why it matters**: `SessionActionsMenu.tsx:88-96` and
  `Sidebar.tsx:1135-1140` both render a full-screen `fixed inset-0` backdrop whose
  `onClick`/`onContextMenu` call `onClose()` **without** `restoreTriggerFocus()`.
  The backdrop is a non-focusable `div`, so the click sets `document.activeElement`
  to `<body>`: open the session/project ⋮ menu, click anywhere outside, and the next
  Tab restarts from the top of the document instead of returning to the ⋮ trigger.
  Every item click on the same menus *does* restore, so the inconsistency is
  invisible until you dismiss rather than choose.
- **Fix**: have the popover's cleanup honor `shouldRestore` the way the modal does
  (`if (removal.shouldRestore) restoreFocus(removal.restoreTarget)`), and drop the
  `triggerFocusRef.current = null` in the `!open` branch (`overlayFocus.ts:369-372`)
  that makes a post-close `restoreTriggerFocus()` a silent no-op. Consumers then stop
  needing to remember.

### [MED] The overlay stack arbitrates modal-over-popover but not popover-over-popover or popover-inside-modal

- **Where**: `app/renderer/src/overlayFocus.ts:185-194` (`isTop` filters to
  `kind === 'modal'`; `isBlockedByModal` looks only for modals above)
- **Type**: design
- **What**: two asymmetries. (a) There is no `isTop` for popovers, so
  `popoverKeyAction` gates only on `defaultPrevented` — with two popovers registered,
  whichever attached its `document` keydown listener first consumes Escape and the
  other is left open. Listener order is not stable either: the keydown effect's deps
  include `onEscape` (`overlayFocus.ts:407`), which is an inline closure at most call
  sites, so the listener is torn down and re-added on every render. (b) There is no
  `isBlockedByPopover`, the mirror of `isBlockedByModal`, so a modal hosting a
  popover keeps responding to Escape while the popover is open. `PlanPanel.tsx:110-115`
  compensates by hand with `escapeEnabled: !showApprove && !revising` — correct
  today, but that is exactly the per-consumer bookkeeping the shared stack exists to
  eliminate, and the next modal+popover pairing has to rediscover it.
- **Trigger / why it matters**: today only PlanPanel pairs the two, and it guards
  correctly, so this is latent rather than broken. The cost is that the stack's own
  doc (`overlayFocus.ts:88-97`) presents the shared registry as the arbitration
  mechanism while half the arbitration lives in a consumer's prop.
- **Fix**: give the stack a single `topmostOverlay(owner)` query that treats both
  kinds as one z-ordered stack, and let `modalKeyAction`/`popoverKeyAction` both gate
  on it. `escapeEnabled` at PlanPanel then becomes redundant rather than load-bearing.

### [LOW] `AgentTypeMeta`'s hex/rgba fields are dead, and look exactly like the paint path they are not

- **Where**: `app/renderer/src/agentIdentity.ts:20-28` (`color`, `soft`, `line`,
  `compressedFrom`), populated for all six entries at `agentIdentity.ts:70-120`
- **Type**: dead-code
- **What**: no production module reads `AgentTypeMeta.color`, `.soft`, `.line`, or
  `.compressedFrom`. Every colour that reaches the DOM for an agent *type* comes from
  the static `AGENT_TYPE_TONE_CLASS` map in `agentChromeModel.ts:38-47`, keyed by
  `meta.tone`. `compressedFrom` has no reader anywhere except its own definition and
  a test asserting the literal.
- **Trigger / why it matters**: the paint path is correct — I verified every agent
  colour reaches the DOM as a literal Tailwind class through
  `AGENT_TYPE_TONE_CLASS` / `AGENT_STATE_TONE_CLASS` / `TASK_COLOR_CLASS`, so the
  documented Tailwind v4 dynamic-class trap is genuinely avoided. The cost is that
  the *state* metas' `color` field IS live (`TasksDialog.tsx:803` and `:817` route it
  through `taskColorClass`) while the *type* metas' identical-looking field is not.
  A future reader adding a type chip will reasonably reach for `meta.color` and
  write `text-[${meta.color}]`, which is the P4-9 colourless-badge bug returning.
  Note also that three of the type hexes (`#93c5fd`, `#7dd3fc`, `#a78bfa`) have no
  entry in `TASK_COLOR_CLASS`, so even the "correct" route would silently fall back.
- **Fix**: drop `color`/`soft`/`line`/`compressedFrom` from `AgentTypeMeta` and the
  six literals. `tone` is the only field that reaches paint.

### [LOW] `goalMemoryState`'s lifecycle arm is the one domain reducer without the untracked-session guard

- **Where**: `app/renderer/src/goalMemoryState.ts:40-44`
- **Type**: correctness / convention
- **What**: every sibling domain guards with `if (!(frame.sessionId in state.sessions)) return state`
  — `settingsState.ts:50`, `extensionsState.ts:49`, `agentConfigState.ts:33`,
  `accountsState.ts:95`, `diagnosticsState.ts:42`, `remoteSettingsState.ts:44`,
  `workspaceTrustState.ts:55`. `goalMemoryState` does not, and additionally rebuilds
  both records unconditionally.
- **Trigger / why it matters**: a `lifecycle` frame (status `disconnected` | `failed`
  | `exited`, `protocol.ts:2288-2297`) for a session that never emitted a
  `thread-goal.snapshot` or `memory.snapshot` still writes `null` into **both**
  records, permanently, and returns a fresh state object. Over a long-lived window
  the two maps accumulate one key per session that ever died, and every lifecycle
  frame changes reducer identity — `App.tsx:602-603` holds this in a `useReducer`, so
  each one is an avoidable re-render of every `selectThreadGoalSnapshot` /
  `selectMemorySnapshot` consumer. Bounded and small, but it is a divergence from a
  convention seven other files hold.
- **Fix**: add the same guard, checking both `state.goals` and `state.memory`, and
  return `state` when neither tracks the session.

### [LOW] `bannerStackModel.ts` is entirely dead

- **Where**: `app/renderer/src/bannerStackModel.ts:4-31`
- **Type**: dead-code
- **What**: all three exports — `upsertBanner`, `dismissBanner`, `useBannerStack` —
  have zero non-test importers.
- **Trigger / why it matters**: `App.tsx:1375-1396` hand-rolls the same job for the
  one banner that exists (a `dismissedAccountHealthId` string plus a one-element
  array). A future second banner source will either re-hand-roll it or resurrect this
  module; keeping an unused stack model around guarantees the two eventually diverge.
- **Fix**: delete the module and its test, or wire `App.tsx`'s banner state to it.

### [LOW] `accountHealthBanner`'s exported ids and action key are a contract nothing enforces

- **Where**: `app/renderer/src/accountHealthBanner.ts:38-43`
- **Type**: dead-code
- **What**: `ACCOUNT_HEALTH_CAPACITY_ID`, `ACCOUNT_HEALTH_SIGNIN_ID` and
  `ACCOUNT_HEALTH_ACTION_KEY` have no importer. The doc comment presents the id as
  "the dismissal signature (see `App.tsx`)" and the key as "the one action both
  variants offer", but `App.tsx:3399-3401` compares `banner.id` by value and ignores
  the action key entirely (`onAction={() => setActiveView('accounts')}`, no `key`
  parameter read).
- **Trigger / why it matters**: renaming `ACCOUNT_HEALTH_ACTION_KEY` changes nothing
  at all, which makes it read as a wired contract when it is decorative. The
  behaviour is right; the constant lies about why.
- **Fix**: have `App.tsx` dispatch on the action key, or drop the export and the
  `key` field's implied contract from the doc comment.

### [LOW] Assorted exports with no consumer

- **Where**: `app/renderer/src/settingsScope.ts:75` (`isSettingsScopeKind`, no reader
  at all, not even internal); `app/renderer/src/settingsState.ts:76-82`
  (`selectSettingField`, documented as "the lookup every `Field` in a panel makes",
  no panel calls it); `app/renderer/src/settingsReadState.ts:28-32`
  (`selectSettingsReadState`, reachable only through `settingsWereRead`)
- **Type**: dead-code
- **What**: exported, never imported outside their own module and tests.
- **Trigger / why it matters**: `selectSettingField` is the one that matters —
  its doc asserts a call pattern that does not exist, so a reader trusting it will
  look for panel code that was never written.
- **Fix**: unexport the internal-only helpers; delete or wire `selectSettingField`.

### [LOW] `settingsScope.ts` is a god file with seven unrelated jobs

- **Where**: `app/renderer/src/settingsScope.ts` (1133 lines)
- **Type**: design
- **What**: one module holds the scope vocabulary (66-141), the project picker
  (143-231), the rail catalog and its search index (233-478), the row grammar
  (480-724), the destructive-value declarations (861-962), the int-field commit state
  machine (964-1013), and the annotation/write-target copy (1015-1133). The rail
  catalog in particular shares nothing with the row grammar but a file.
- **Trigger / why it matters**: no behavioural cost today; the cost is that the row
  grammar — the subtle, high-consequence part, and the part with the strongest tests
  — is buried behind ~450 lines of static tables, and its colocated test file is
  correspondingly enormous.
- **Fix**: split the rail (catalog + `selectSettingsRail` + `selectSettingsRailItem`
  + `railItemSearchText`) into `settingsRail.ts`. The row grammar and the copy stay.

## What is good here

- **`selectSettingsRow`'s source-scoped reads.** `layerValue`
  (`settingsScope.ts:580-590`) answers "what does *my* layer say" rather than
  reusing the winner-only `selectEditableValue`, and every branch that cannot answer
  emits `{ kind: 'unreadable' }` instead of borrowing another layer's value. The
  four in-code comments naming the exact bug each branch was written against
  (`:634-638`, `:652-662`, `:680-683`, `:699-702`) are the most useful comments I
  read in this scope.
- **`settingsRowNote` actually obeys the surprising-only rule.**
  `settingsScope.ts:1074-1092` returns null for `set-here` / `unset-here` unless the
  value is unreadable, and `selectSettingsDestructiveWarning` (`:951-962`) is
  deliberately *not* folded into it with a stated reason — a data-loss warning must
  not be suppressed by a provenance rule. `codeTheme.ts:145-151` copies the same
  idiom correctly.
- **The colour-to-DOM discipline holds.** `tone.ts:44-99`, `agentChromeModel.ts`,
  `accentTheme.ts:50-56` and `tasksState.ts:238-266` are all literal static maps with
  explicit fallbacks; `accentTheme.ts:11-23` and `codeTheme.ts:13-20` route theming
  through a `data-*` attribute plus CSS rather than through classes at all, which is
  the right answer to the Tailwind v4 trap. No interpolated arbitrary-value class
  exists anywhere in this scope. No tone maps to a colour that contradicts its name.
- **`selectSettingsReset` and `selectSettingsIntCommit` collapse a precondition and
  its payload into one decision.** `settingsScope.ts:837-843` and `:978-1003` are
  pure and testable precisely because the SSR-only suite cannot press a button —
  the reasoning for that choice is stated, not assumed.
- **User-visible text is clean.** I swept every string in all 25 modules: zero em
  dashes outside code comments, zero engineering vocabulary (no `file.ts:123`, no
  session ids, no `MAX_*` names, no "sidecar"/"registry row"), and the copy
  consistently tells the operator what to do rather than why something is unbuilt
  (`settingsScope.ts:226-231`, `:913-928`; `settingsReadState.ts:45-63`). The one
  stylistic outlier is `accountsPageModel.ts:146` — `'1–32 chars · letters, numbers,
  - or _'` uses an en dash and a middle dot where nothing else in this scope does.

## Not reviewed / uncertain

- **`overlayFocus` behaviour under a real DOM.** The renderer suite is SSR-only, so
  every focus claim above is from source reading plus call-site inspection, not from
  execution. The backdrop-click focus-loss finding (MED #4) is derived from
  `document.activeElement` semantics for a click on a non-focusable `div`; it would
  be settled in seconds by an operator opening the ⋮ menu and pressing Tab after
  clicking away. The popover-vs-popover Escape ordering (MED #5) I could not prove
  reachable — I found no state where two `usePopoverFocus` overlays are open at once,
  because each carries its own outside-mousedown dismissal.
- **Whether `permissions.defaultMode`'s nested resolution can disagree with the
  top-level `resolved` model.** `buildSettingsSnapshot` reads only top-level
  `Object.keys` for `resolved`/`layers[].keys` while the engine deep-merges
  (`settingsMergeCustomizer`). Every key in `EDITABLE_SETTINGS`
  (`app/shared/settingsEditable.ts:162-305`) is a top-level scalar, so
  `selectSettingsRow` is never called with a nested key and I found no live
  divergence — but the sidecar's `readPermissionDefaultMode` axis is the only nested
  reader, and I did not trace whether a future nested editable key would need a
  parallel axis.
- **`--setting-sources` in practice.** I verified nothing under `app/` sets
  `allowedSettingSources` and that the default (`src/bootstrap/state.ts:328-334`) is
  the canonical order, so MED #2 is latent rather than live. I did not check whether
  a `flagSettings` path (`--settings`) can reach a desktop sidecar, which is the
  other input to that ordering.
- **`AGENT_STATE_META` colour coverage** is complete against `TASK_COLOR_CLASS`
  (all eight state hexes have entries); the type hexes are not, but nothing routes
  them, per LOW #1. I did not audit the other `TASK_COLOR_CLASS` consumers outside
  this scope.
- I ran no tests. Every claim is source-verified; the two I would most want a live
  run for are the `subagent_type: "toString"` crash (HIGH) and the backdrop focus
  loss (MED #4).
