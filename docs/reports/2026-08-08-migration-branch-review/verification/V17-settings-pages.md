# V17 adversarial validation: settings scope / misc renderer state (A17) + renderer page surfaces (A18)

> **Verification provenance:** Claude Opus 5, high effort. Source review of every
> cited `file:line` across both reports (~120 citations checked), plus the layers
> behind them (`app/sidecar/settingsDomain.ts`, `app/main/main.ts`,
> `app/main/mainDecisions.ts`, `src/utils/settings/constants.ts`,
> `src/bootstrap/state.ts`, `app/renderer/src/App.tsx`,
> `app/renderer/src/TranscriptView.tsx`, `app/renderer/src/main.tsx`). Three
> standalone scratch scripts importing the REAL repo modules, run under Bun from
> outside the repo. One focused test file
> (`bun test app/renderer/src/fastRefreshBoundaries.test.ts` — 1 pass / 0 fail).
> No GUI, no app launch, no full suite, no repo edits, no git writes.
> Branch `migration` at `a1012b1`.

## Overall verdict

Both reports are substantially right, and their citation accuracy is high (I
found six line numbers off by 1–3 and one range that ends 18 lines short; nothing
mis-located). Of 30 findings, **22 are CONFIRMED, 5 PARTIALLY CONFIRMED, 1
OVERSTATED, 2 DUPLICATE, 0 INVALID.** Both HIGH claims reproduce at runtime
against the real modules: `agentTypeMeta("toString")` genuinely **throws** rather
than rendering garbage (the prompt's decisive question), and there is no root
error boundary, so the whole window blanks; and Enter on an empty tag query
really does write the alphabetically-first tag to every selected live session.
**The thing that most deserves action is A17's HIGH** — it is a one-line fix for
a render-path throw from model-supplied text, which is exactly what the repo's
"display = degrade gracefully" rule exists to forbid.

The one claim that does not survive is **A17's settings-precedence divergence.**
I proved the engine's `getEnabledSettingSources()` returns a byte-identical order
to `SETTING_SOURCES` in any process that never calls `setAllowedSettingSources`,
and **nothing under `app/` can call it** — the sidecar is spawned with
`['--feature=TRANSCRIPT_CLASSIFIER', 'run', <entry>]` and parses no argv. The
desktop copy diverges only in which constant it names. Three other findings are
narrower than written: `settingsProjectBinding`'s "the bug it exists to prevent is
live" (the picker has one entry and the full cwd renders beside it), A17's
popover-over-popover Escape race (unreachable — every popover ships a full-screen
backdrop), and A18's `EmptyState` duplication (the two components have different
APIs, and A18's own F15 praises the difference).

## Summary

### A17 — settings scope, agent identity, theming, misc renderer state

| # | Sev | Finding (short) | Verdict | One-line reason |
|---|-----|-----------------|---------|-----------------|
| A17-F1 | HIGH | `agentTypeMeta` prototype-chain index crashes the transcript | **CONFIRMED** | Scratch script: throws for 6 prototype keys; no root error boundary in `main.tsx` |
| A17-F2 | MED | Setting precedence duplicated, diverges from engine effective order | **OVERSTATED** | `getEnabledSettingSources()` === `SETTING_SOURCES` in every sidecar process; `app/` cannot change it |
| A17-F3 | MED | `settingsProjectBinding.ts` unwired, bug it prevents is live | **PARTIALLY CONFIRMED** | Dead: exact. "Live": no — one-entry picker never collides, and `SettingsShell.tsx:435` shows the full cwd |
| A17-F4 | MED | `usePopoverFocus` discards the restore target | **CONFIRMED** | Cleanup at `:387-390` ignores `unregister()`; two MORE backdrop sites the report missed |
| A17-F5 | MED | Stack arbitrates modal-over-popover only | **PARTIALLY CONFIRMED** | (b) exact; (a) unreachable — every popover has a full-screen backdrop |
| A17-F6 | LOW | `AgentTypeMeta` hex/rgba fields dead | **CONFIRMED** | Zero readers of all four; the 3 unmapped type hexes verified against `TASK_COLOR_CLASS` |
| A17-F7 | LOW | `goalMemoryState` lifecycle arm missing the guard | **CONFIRMED** | `:40-44` unguarded; all seven siblings spot-checked |
| A17-F8 | LOW | `bannerStackModel.ts` entirely dead | **DUPLICATE** | `V31-dead-code-wiring.md` F3; deletion already PARKED at `2026-07-28-bug-catalogue.md:427` |
| A17-F9 | LOW | `accountHealthBanner` ids/action key unenforced | **PARTIALLY CONFIRMED** | Export surplus real; the ids' documented dismissal-signature role is TRUE, not decorative |
| A17-F10 | LOW | Assorted exports with no consumer | **CONFIRMED** | All three verified; two are duplicates of `V31` F13/F8 |
| A17-F11 | LOW | `settingsScope.ts` god file | **CONFIRMED** | 1,133 lines, seven jobs, 1,715-line colocated test |

### A18 — renderer page surfaces

| # | Sev | Finding (short) | Verdict | One-line reason |
|---|-----|-----------------|---------|-----------------|
| A18-F1 | HIGH | Enter on empty tag query silently writes a tag | **CONFIRMED** | Reproduced against real selectors; bulk path fans out to 3 rows then clears selection |
| A18-F2 | MED | Direct-connect details render one frame then vanish | **CONFIRMED** | `setConnecting(false)` is a real state change, so render N+1 recomputes `matched` false |
| A18-F3 | MED | Two page files with zero importers | **CONFIRMED** | 131 + 93 lines, no importer; backtick bug exact. Deletion collides with a recorded PARK |
| A18-F4 | MED | `SettingsShell` accepts four props it discards | **CONFIRMED** | Type `:173-181`, all four passed live at `App.tsx:3219-3238` |
| A18-F5 | MED | `selectWritableSelection` dead, rule re-derived 3× | **DUPLICATE** | `V15` F9 and `V31` F7; `V31` already showed the proposed fix is wrong for 2 of 3 sites |
| A18-F6 | MED | Session rows are `role="button"` with nested buttons | **CONFIRMED** | Comment at `:753-755` and `role` at `:758`; four nested controls verified |
| A18-F7 | MED | Three unreachable `embedded={false}` layouts | **CONFIRMED** | `SettingsShell` is the sole importer of all three and always passes `embedded` |
| A18-F8 | MED | `PathCopyButton` + `EmptyState` duplicated | **PARTIALLY CONFIRMED** | `PathCopyButton` exact (one `font-sans`); `EmptyState` claim is wrong and contradicts A18-F15 |
| A18-F9 | MED | `StartupOAuth` switch has no exhaustiveness tripwire | **CONFIRMED** | Four `if (view.phase === …)`, bare fallthrough to the provider chooser |
| A18-F10 | MED | Welcome Codex table has seven unlabeled columns | **CONFIRMED** | Grid is 7 columns, no header row, last cell hardcoded `""` at `:582` |
| A18-F11 | MED | Welcome usage meters hardcode pink | **PARTIALLY CONFIRMED** | Hexes exact, but flat pink is DOCUMENTED prototype parity at `:588-590`; needs an operator ruling |
| A18-F12 | MED | Internal vocabulary rendered to users | **CONFIRMED** | All four strings verbatim on screen; the counter-example at `:682` is exact |
| A18-F13 | MED | `CodeThemePreview` duplicates the plugin config | **CONFIRMED** | Byte-identical to `TranscriptView.tsx:629-632`, still module-private |
| A18-F14 | LOW | Alias input's only accessible name is its placeholder | **CONFIRMED** | No `aria-label`/`<label>` at `:373-380` or `:304-309`; siblings do it right |
| A18-F15 | LOW | `GoalsPage` renders a goal id, conflates loading with empty | **CONFIRMED** | `{goal.goalId}` at `:63`; `snapshot === null` is the only non-goal branch |
| A18-F16 | LOW | `PathCopyButton`'s reset timer is never cleared | **CONFIRMED** | Bare `setTimeout` outside any effect at both sites |
| A18-F17 | LOW | Relative timestamps freeze until an unrelated re-render | **CONFIRMED** | Zero `setInterval` across all 17 files |
| A18-F18 | LOW | Dead exports `SessionsPageAnchor`, `RemoteRolePill` | **CONFIRMED** | Both verified; `SessionsPageAnchor` duplicates `V31` F14, `RemoteRolePill` is ledgered |
| A18-F19 | LOW | `AgentsPage` renders a constant dressed as data | **CONFIRMED** | `['Provider', 'runtime-selected']` at `:358`, exact |

---

## Per finding — A17

### A17-F1 — [HIGH] `agentTypeMeta` indexes an object literal with model-supplied text

- **Verdict**: **CONFIRMED**. It throws; it does not render garbage.
- **Cited location holds?**: Yes. `agentIdentity.ts:244-256` is `agentTypeMeta`,
  with the bare index at `:247`
  (`AGENT_TYPE_META[type as AgentTypeKey] ?? { …neutral fallback… }`).
  `AGENT_TYPE_META` is a plain object literal at `:70-120` (`satisfies Record<…>`,
  no null prototype). `agentIdentity.ts:316` — off by one; `firstString(data.agentType,
  data.role, data.subagent_type)` is at **`:315`**. `TranscriptView.tsx:1663` is
  `const subagentType = str('subagent_type')` ✅. `TranscriptView.tsx:1801-1803` is
  the `typeTone` ternary ✅. **`TranscriptView.tsx:1856` is wrong** — the
  `${typeTone.text}` interpolation is at **`:1859`**; `:1856` is the `identity.name`
  ternary. `AgentChrome.tsx:62-64` (`AgentRoleDot`) and `:92-97` (`AgentTypeChip`)
  are exact.
- **Reachable in production?**: Yes, with nothing in the way. `input` is the raw
  block: `transcriptProjector.ts:1845` is
  `input: isRecord(block.input) ? block.input : {}`, and
  `ToolUseNestedRow.input` is typed `Record<string, unknown>` (`:108`). No
  normalisation, no allowlist, no env gate, no feature flag. `AgentToolCard`
  renders on any `Agent`/`Task` tool_use row. **There is no root error boundary**:
  `app/renderer/src/main.tsx` wraps `<App/>` in `StrictMode` + four theme/toast
  providers and nothing else; the only boundary in the renderer is
  `MarkdownErrorBoundary` (`TranscriptView.tsx:689-706`), which wraps markdown
  content, not the Agent card. With React 18 `createRoot`, an uncaught render
  throw unmounts the entire tree, so **A01's compounding claim is confirmed: the
  window blanks.**
- **Trigger**: a model turn emitting `Agent(subagent_type: "toString")` — or
  `"constructor"`, `"valueOf"`, `"hasOwnProperty"`, `"isPrototypeOf"`, `"__proto__"`.
  A user can trigger it deliberately by asking for it.
- **Counter-arguments considered**:
  1. *Does the `??` really fail to fire?* Confirmed at runtime: `typeof meta` is
     `"function"` for five keys and `"object"` for `__proto__`. Never nullish.
  2. *Does it degrade instead of throwing?* **No.** `vocab.type` is truthy, so the
     ternary at `:1801` takes the truthy branch, `AGENT_TYPE_TONE_CLASS[undefined]`
     is `undefined`, and `${typeTone.text}` at `:1859` throws. Same for
     `AgentRoleDot` (`tone.dot`) and `AgentTypeChip` (`tone.text`). This settles
     the prompt's decisive question **against** the "silently renders garbage"
     reading, which would have dropped the severity sharply.
  3. *Does the engine reject an unknown `subagent_type` first?* Irrelevant — the
     `tool_use` block is already in the assistant message and therefore in the
     transcript regardless of what the tool does with it afterwards.
  4. *Are all consumers fatal?* No — `workerInspection.ts:73` and
     `orchestratorState.ts:317` read `meta?.label ?? role`, which yields the raw
     string harmlessly. Only the three tone-map consumers throw. That narrows the
     blast radius to the transcript/chrome path, which is the one the report names.
- **True consequence**: `TypeError: undefined is not an object (reading 'text')`
  inside `AgentToolCard`'s render, uncaught, unmounting the whole React root. The
  window goes blank until relaunch.
- **Evidence**: `/private/tmp/claude-501/…/scratchpad/v17/f1-agenttypemeta.ts`:
  ```
  {"key":"toString","typeofMeta":"function","toneClassFound":false,"consequence":"THROW: undefined is not an object (evaluating '….text')"}
  {"key":"__proto__","typeofMeta":"object","toneClassFound":false,"consequence":"THROW: …"}
  {"key":"unknown-real-agent","typeofMeta":"object","label":"unknown-real-agent","tone":"neutral","consequence":"rendered class -> … text-zinc-400"}
  toString vocab.type = function label= undefined tone= undefined
     THROW at TranscriptView.tsx:1803/1856 -> undefined is not an object (evaluating 'typeTone.text')
  ```
  Control row shows an ordinary unknown type still degrades correctly.
- **Disposition**: Apply the report's fix. `Object.hasOwn(AGENT_TYPE_META, type)`
  is the minimal correct guard and keeps the existing neutral fallback intact.
  Prefer it over `Object.create(null)`, which would silently change
  `AGENT_TYPE_META`'s inferred type surface. Add a unit test asserting
  `agentTypeMeta('toString').tone === 'neutral'`. **Also worth doing separately,
  but do not bundle it into this fix:** the absence of a root error boundary is
  A01's finding, and this defect is the argument for it — a renderer that
  degrades gracefully by rule should not have a single uncaught throw able to
  blank the window.

### A17-F2 — [MED] Setting precedence duplicated and does not match the engine's *effective* merge order

- **Verdict**: **OVERSTATED**. The duplication is real; the divergence is not
  reachable from the desktop, and the report's own verdict paragraph ("already
  structurally divergent, not merely at risk") contradicts its own finding body
  ("latent rather than live").
- **Cited location holds?**: Yes, every citation.
  `settingsState.ts:145-151` is `SETTING_SOURCE_PRECEDENCE` (report said
  `:141-151`; `:141-144` is its doc comment, so the range is fine).
  `settingsScope.ts:554-558` is `rank()` and is its only consumer.
  `src/utils/settings/constants.ts:7-22` is `SETTING_SOURCES` ascending.
  `getEnabledSettingSources()` is at `:159-168`. `src/bootstrap/state.ts:328-334`
  is the default `allowedSettingSources`. `app/sidecar/settingsDomain.ts:360-372`
  is the doc comment + `for (const source of SETTING_SOURCES)` loop, and its
  comment names the policy-before-flag quirk verbatim.
- **Reachable in production?**: **No.** Three independent reasons:
  1. `setAllowedSettingSources` has exactly one caller repo-wide —
     `src/main.tsx:501`, inside `loadSettingSourcesFromFlag`, reached only from
     `eagerParseCliFlag('--setting-sources')` at `:525-527`.
  2. The sidecar never runs that path. It is spawned as
     `sidecarArgs: [...SIDECAR_RUNTIME_ARGS, SIDECAR_ENTRY]` (`app/main/main.ts:640`)
     with `SIDECAR_RUNTIME_ARGS = ['--feature=TRANSCRIPT_CLASSIFIER', 'run']`
     (`app/main/mainDecisions.ts:41-44`), and `app/sidecar/index.ts` reads no
     `process.argv`. Zero `setAllowedSettingSources` / `--setting-sources`
     references anywhere under `app/`.
  3. Therefore `getAllowedSettingSources()` is always the default five-element
     canonical array, and because `getEnabledSettingSources()` builds a `Set` from
     it before `add`-ing policy and flag (which are already members at positions
     4 and 5), the `add` calls are no-ops and **insertion order is preserved
     identically**.
  A fourth reason makes it doubly moot: there is never a `flagSettings` layer at
  all. `flagSettingsPath` / `flagSettingsInline` default to `undefined`/`null`
  with no setter under `app/`, and `readSettingsSnapshotOnce` drops any layer with
  no keys (`settingsDomain.ts:375`).
- **Trigger**: none from the desktop. Under a hypothetical
  `--setting-sources local,user` the orders genuinely diverge in two places
  (flag beats policy, user beats local) — I ran it — but that flag reaches only
  the CLI.
- **Counter-arguments considered**: I looked for a second entry point that could
  seed bootstrap state in the sidecar (`app/sidecar/initializeRuntime.ts`,
  `sessionController.ts`, `runControlsDomain.ts` all import
  `src/bootstrap/state.js` but none touches setting sources); for an env-var
  override (none exists); and for a path where the renderer's `rank()` could
  contradict the sidecar's own layer order (it cannot — the sidecar builds
  `layers[]` ascending from `SETTING_SOURCES`, which is exactly
  `[...SETTING_SOURCE_PRECEDENCE].reverse()`, so the two desktop copies agree by
  construction). I also checked whether `resolved`'s winner is computed by the
  renderer — it is not; `buildSettingsSnapshot` (`settingsDomain.ts:179-207`)
  walks high→low and keeps the first hit, so `rank()` only drives the annotation
  grammar, not the winner.
- **True consequence**: two hand-maintained copies of one ordering with no
  compile-time tie, both currently correct and unable to become incorrect from
  any `app/` input. A maintenance hazard, not a behaviour divergence.
- **Evidence**: `/private/tmp/claude-501/…/scratchpad/v17/a17-f2-precedence.ts`:
  ```
  SETTING_SOURCES (engine canonical ascending): ["userSettings","projectSettings","localSettings","flagSettings","policySettings"]
  renderer SETTING_SOURCE_PRECEDENCE reversed : ["userSettings","projectSettings","localSettings","flagSettings","policySettings"]
  identical? true
  getAllowedSettingSources() : [… canonical five …]
  getEnabledSettingSources() : [… canonical five …]
  engine effective order === SETTING_SOURCES? true
  ```
- **Disposition**: Take only the report's **"at minimum"** half — a test-level
  assertion that `SETTING_SOURCE_PRECEDENCE` equals `[...SETTING_SOURCES].reverse()`.
  That is three lines and closes the real hazard. **Do not** apply the primary fix
  (have `rank()` read the layer index off the snapshot): `layers[]` omits every
  source with no keys, so the index would shift whenever a layer happens to be
  empty and `rank()` would start returning different answers for the same source
  on different sessions. That would introduce the divergence the finding
  incorrectly claims already exists. Re-file as LOW.

### A17-F3 — [MED] `settingsProjectBinding.ts` is entirely unwired, and the bug it exists to prevent is live

- **Verdict**: **PARTIALLY CONFIRMED**. The deadness is exact; "the bug it exists
  to prevent is live" is overstated.
- **Cited location holds?**: Yes, all of it. `settingsProjectBinding.ts:89-107` is
  `selectSettingsProjectBinding`; the doc block naming the operator-reported
  2026-07-26 `/Users/pt/cat-code/app` vs `/Users/pt/PTClove/app` collision is at
  `:109-136`. `SettingsShell.tsx:156-163` declares `projectBinding`/`projects`;
  `App.tsx:3218-3239` passes neither. `SettingsShell.tsx:203-206` is off by two —
  `known = projects ?? (projectBinding?.bound ? … : undefined)` is at **`:201-205`**.
  `settingsScope.ts:159-163` is `settingsProjectLabel` ✅.
  `SETTINGS_PROJECT_UNBOUND_NOTE` is indeed referenced only by a comment, at
  `sessionInspectorState.ts:111` ✅ exactly.
- **Reachable in production?**: The module is not reachable — that is the finding.
  The only importer of `selectSettingsProjectBinding` is its own test.
- **Trigger for the *consequence* claim**: with both props undefined,
  `selectSettingsProjects(undefined, activeCwd)` (`settingsScope.ts:181-206`)
  returns **exactly one** choice, labelled `settingsProjectLabel(active)` — the
  bare last segment. The scope tab at `SettingsShell.tsx:254-256` therefore reads
  `Project: app`.
- **Counter-arguments considered**: **The collision cannot occur on screen.** The
  documented bug is *two adjacent labels both reading `app`*; a one-element picker
  has no second label to collide with. And the disambiguating information is
  present anyway: `ProjectScopeControls` renders `{selected.cwd}` at
  `SettingsShell.tsx:435`, and `scopeFile` (the full settings-file path) renders at
  `:287` whenever the engine is live and settings were read. I also checked
  whether wiring the binding would even change the label with `projects` still
  undefined — it would: `resolveWorkspaceName` groups over the **full merged
  roster** (its doc at `:123-133` is explicit that a one-element set would
  collapse to depth 1), so the binding alone is enough. So the fix is right; the
  urgency is not.
- **True consequence**: a 149-line module plus 175 lines of tests describing
  behaviour the app does not have, and a scope tab that names a project by bare
  basename while the full path sits one line below it.
- **Evidence**: citations above; `settingsScope.ts:202`
  (`name: known?.name ?? settingsProjectLabel(active)`).
- **Disposition**: Apply the one-line wiring — it is genuinely one line and the
  module is already tested. But **note this is a third sighting, not a new
  finding**: it is on record at `docs/migration/reviews/2026-08-03-week-code-review/lane3-settings.md:89-98`
  and again at `X02b-dead-code-wiring.md:299-300`. Under the repo's two-strikes
  rule (`.claude/rules/migration.md`) it now needs a named owner session or a
  recorded waive in STATUS, not a fourth report. Re-file as LOW severity with a
  process action attached.

### A17-F4 — [MED] `usePopoverFocus` throws away the restore target, so outside-click dismissal drops focus to `<body>`

- **Verdict**: **CONFIRMED** (source-level; the DOM step is standard focus
  semantics, not executed — see counter-arguments).
- **Cited location holds?**: Yes. `overlayFocus.ts:387-390` is the popover
  cleanup, `cancelAnimationFrame(frame); modalFocusStack.unregister(owner)` with
  the return value discarded. `:304-310` is the modal cleanup, which does
  `if (restoreOnCloseRef.current && removal.shouldRestore) restoreFocus(removal.restoreTarget)`.
  `unregister`'s reparenting loop is at `:167-175` and
  `resolveConnectedRestoreTarget` at `:127-141`, both as described.
  `SessionActionsMenu.tsx:88-96` is off by one — the backdrop `div` with
  `onClick={onClose}` and `onContextMenu` is at **`:89-97`**. `Sidebar.tsx:1135-1140`
  is exact. `overlayFocus.ts:369-372` (`if (!open) { triggerFocusRef.current = null; return }`)
  is exact.
- **Reachable in production?**: Yes. Six live `usePopoverFocus` call sites
  (`Sidebar.tsx:1116`, `SessionActionsMenu.tsx:71` and `:171`, `PlanPanel.tsx:322`,
  `SessionsPage.tsx:134` and `:1031`, plus `composerPopover.ts:36`). All mount in
  production; no env gate.
- **Trigger**: open a session/project ⋮ menu (focus lands inside via
  `focusFirst(container, MENU_ITEM_SELECTOR, false)` at `:384-386`), click the
  backdrop. The backdrop is a non-focusable `div` with no `tabIndex`, so the click
  moves `document.activeElement` to `<body>`; `onClose()` unmounts the popover;
  the cleanup unregisters without restoring. Next Tab restarts from the document
  top.
- **Counter-arguments considered**:
  1. *Is there a global focus restorer?* No. Every `restoreTriggerFocus()` call
     site is an explicit item/Escape handler
     (`SessionActionsMenu.tsx:126,136,217,221`, `Sidebar.tsx:1157`,
     `PlanPanel.tsx:349,365`, `SessionsPage.tsx:1038,1083,315`,
     `composerPopover.ts:43`). Not one backdrop calls it.
  2. *Does the shared stack rescue it?* No — `unregister` computes
     `shouldRestore: wasTop` and a correct `restoreTarget`, and the popover simply
     drops both on the floor. The work is done and thrown away, exactly as claimed.
  3. *Is the `!open` half of the fix load-bearing?* Only at
     `SessionsPage.tsx:134`, the one call site that passes a variable `open`
     (`open: sortOpen`). The other five pass `open: true` and unmount instead, so
     the `!open` branch never runs for them. The report presents this as a general
     correction; it is a one-site one.
  4. *Did I execute it?* No. jsdom/happy-dom do not emulate blur-on-click-of-a-
     non-focusable-element, so a headless run would not be decisive either way.
     The claim rests on Chromium's documented behaviour (clicking a non-focusable
     region blurs the active element to `body`), which is why the report's own
     "settled in seconds by an operator" note is the right escalation.
- **True consequence**: after any outside-click dismissal of a popover, keyboard
  focus is at `<body>` and the next Tab restarts from the top of the document. Item
  clicks and Escape both restore correctly, so the inconsistency only appears on
  dismissal.
- **Evidence**: line citations above.
- **Disposition**: Apply, and **widen it** — the report names two backdrop sites;
  there are four. Add `SessionActionsMenu.tsx:191-195` (the rename popover's
  backdrop, `onClick={onCancel}`) and `SessionsPage.tsx:296-300` (the sort menu's
  `fixed inset-0 z-40` backdrop, `onClick={() => setSortOpen(false)}`). Fixing the
  hook once covers all four, which is the argument for fixing the hook rather than
  the call sites. Keep the `!open` change too, but describe it accurately as
  affecting only `SessionsPage.tsx:134`.

### A17-F5 — [MED] The overlay stack arbitrates modal-over-popover but not popover-over-popover or popover-inside-modal

- **Verdict**: **PARTIALLY CONFIRMED**. Half (b) is exact and verifiable; half (a)
  is not reachable.
- **Cited location holds?**: Yes. `overlayFocus.ts:185-194` is `isTop`
  (filtered to `kind === 'modal'`) and `isBlockedByModal` (looks only for
  `kind === 'modal'` above). There is no `isBlockedByPopover`. `:407` is the
  keydown effect's dep array `[onEscape, open, restoreTriggerFocus]` ✅.
  `PlanPanel.tsx:110-115` is `useModalFocus({ …, escapeEnabled: !showApprove && !revising, … })`
  ✅ exact, and `PlanPanel.tsx:322` is the `usePopoverFocus` it compensates for.
  `overlayFocus.ts:88-97` is the type doc presenting the shared registry ✅.
- **Reachable in production?**: **(a) no.** I enumerated every `usePopoverFocus`
  consumer and each renders a full-screen dismissal backdrop directly above its
  panel — `SessionActionsMenu.tsx:89-97` and `:191-195` (`z-[70]`),
  `Sidebar.tsx:1135-1139` (`z-[70]`), `SessionsPage.tsx:296-300` (`z-40`) and
  `:1052` (`z-[70]`). Any click that would open a second popover lands on the
  first's backdrop and closes it instead. I found no state where two are
  registered simultaneously, which matches the report's own admission. Under the
  contract, an unreachable defect is refuted. **(b) yes**, as a design fact:
  `isBlockedByPopover` genuinely does not exist and `PlanPanel` genuinely carries
  the compensation in a prop.
- **Trigger**: none for (a). For (b) the compensation is currently correct, so
  there is no user-visible defect — the cost is that the next modal+popover pairing
  must rediscover `escapeEnabled`.
- **Counter-arguments considered**: whether `popoverKeyAction`'s
  `defaultPrevented` gate would arbitrate correctly anyway if two were open (it
  would not — first-listener-wins, and the dep array makes listener order unstable
  because `onEscape` is an inline closure at most sites; I verified this is true of
  `SessionsPage.tsx:137` `onEscape: () => setSortOpen(false)`); and whether `V29`'s
  finding that three of four keydown surfaces already extract pure tested modules
  covers this (it does not — `overlayEscapeAction`/`modalKeyAction` are the *key
  decision*; the arbitration query and the focus restore are a different seam).
- **True consequence**: one consumer prop is load-bearing for arbitration the
  shared stack advertises that it owns. No user impact today.
- **Evidence**: citations above; backdrop z-indices listed above.
- **Disposition**: Do only the cheap half. Add `isBlockedByPopover` (or the
  report's unified `topmostOverlay(owner)`) and gate `modalKeyAction` on it, so
  `PlanPanel`'s `escapeEnabled` becomes redundant rather than required. **Do not**
  add popover-vs-popover `isTop` arbitration: there is no reachable state that
  needs it, and adding a second z-ordering concept to a stack that currently has
  one is how this class of bug gets created. Re-file as LOW.

### A17-F6 — [LOW] `AgentTypeMeta`'s hex/rgba fields are dead

- **Verdict**: **CONFIRMED**, including the subtle half.
- **Cited location holds?**: Yes. `agentIdentity.ts:20-28` declares
  `color`/`soft`/`line`/`compressedFrom`; `:70-120` populates them for all six
  entries, with `compressedFrom` only on `agent-mode-coding-worker` (`:118`).
- **Reachable in production?**: The fields are carried; nothing reads them. A
  repo-wide grep for `meta.color` / `meta.soft` / `meta.line` / `.compressedFrom`
  outside tests returns exactly one hit — `AgentChrome.tsx:97` — and that is
  `tone.soft` / `tone.line` off `AGENT_TYPE_TONE_CLASS`, not off the meta.
- **Counter-arguments considered**: whether the *state* metas' identically-named
  `color` is also dead (it is not — `TasksDialog.tsx:803` `taskColorClass(state.color).text`
  and `:817` `<StatusMarker … color={state.color}/>`, both exact as cited), which
  is precisely what makes the finding worth filing. And whether the three
  unmapped type hexes claim holds: `TASK_COLOR_CLASS` (`tasksState.ts:238-250`)
  has eleven keys and **`#93c5fd`, `#7dd3fc`, `#a78bfa` are absent** while
  `#5eead4` and `#c4b5fd` are present — exactly three of six, as claimed.
- **True consequence**: four dead fields on six literals that look identical to a
  live paint path one file away, with a documented fallback (`FALLBACK_TASK_COLOR_CLASS`)
  that would silently swallow three of them if a reader took the wrong route.
- **Disposition**: Apply as written. Dropping the four fields is contained (one
  type + six literals) and removes the trap. Worth doing when `agentIdentity.ts` is
  next touched rather than as a standalone change.

### A17-F7 — [LOW] `goalMemoryState`'s lifecycle arm is the one domain reducer without the untracked-session guard

- **Verdict**: **CONFIRMED**.
- **Cited location holds?**: Yes, exactly. `goalMemoryState.ts:40-44` is the
  `lifecycle` branch with no `in` guard and an unconditional rebuild of both
  records. I spot-checked three of the seven named siblings —
  `settingsState.ts:50`, `extensionsState.ts:49`, `agentConfigState.ts:33` — and
  all three carry the identical `if (!(frame.sessionId in state.sessions)) return state`
  with the same preceding comment.
- **Reachable in production?**: Yes. `App.tsx:602-603` holds this in a
  `useReducer`, and every frame reaches every store via `applyServerFrameBatch`,
  so a lifecycle frame for any session hits it.
- **Trigger**: any `lifecycle` frame for a session that never emitted a
  `thread-goal.snapshot` or `memory.snapshot`.
- **Counter-arguments considered**: whether the unconditional
  `return { goals: nextGoals, memory: nextMemory }` also drops sibling fields —
  it cannot today, because `GoalMemoryState` has exactly those two fields
  (`:9-12`), so this is latent only. And whether the re-render is actually
  observable: `selectThreadGoalSnapshot`/`selectMemorySnapshot` both `?? null`, so
  consumers see no value change; the cost is the reducer identity change alone.
- **True consequence**: one wasted key per dead session in each of two maps, and a
  guaranteed no-op re-render of every goal/memory consumer per unrelated lifecycle
  frame.
- **Disposition**: Apply as written — the guard must check both `state.goals` and
  `state.memory` and return `state` when neither tracks the session, which is what
  the report says. Two lines.

### A17-F8 — [LOW] `bannerStackModel.ts` is entirely dead

- **Verdict**: **DUPLICATE** — `V31-dead-code-wiring.md` F3 (which itself files it
  as a duplicate of `docs/migration/reviews/…/lane2-shell-overlays.md:194`).
- **Cited location holds?**: Yes; the three exports have no non-test importer, and
  `App.tsx:1375-1396` hand-rolls the same job with a
  `dismissedAccountHealthId` string plus a one-element array (verified verbatim).
- **Counter-arguments considered**: whether A17 adds anything the earlier reports
  did not — it does not; `V31` additionally established that `useBannerStack` has
  *no* importer at all (not even a test) and that the delete-fix collides with
  `docs/migration/backlog/phase4.md:4274`.
- **Disposition**: Do nothing here. **Deletion is already PARKED** at
  `docs/reports/2026-07-28-bug-catalogue.md:427-430`, which lists `BannerStack`
  among "Four orphaned surfaces" with "**Deletion parked** — the docs still treat
  them as live work". Re-reporting it a fourth time without resolving that park is
  the failure mode the two-strikes rule names.

### A17-F9 — [LOW] `accountHealthBanner`'s exported ids and action key are a contract nothing enforces

- **Verdict**: **PARTIALLY CONFIRMED**.
- **Cited location holds?**: Yes. `accountHealthBanner.ts:38-43` declares all
  three; the only importers are `accountHealthBanner.test.ts:4-6`.
  `App.tsx:3399-3401` is exact: `banners={accountHealthBanners}`,
  `onAction={() => setActiveView('accounts')}` (no `key` parameter read),
  `onDismiss={banner => setDismissedAccountHealthId(banner.id)}`.
- **What survives**: `ACCOUNT_HEALTH_ACTION_KEY` is genuinely decorative — it is
  minted at `:77` and consumed by nothing, so changing its value changes nothing.
  The `export` on all three is surplus.
- **What does not survive**: "the constant lies about why" is false for the two
  ids. The doc at `:34-38` claims the id "doubles as the dismissal signature …
  dismissing one variant never suppresses the other", and that is **true and
  load-bearing**: `App.tsx:1394` compares `accountHealthBanner.id !== dismissedAccountHealthId`
  and `:1388-1392` clears the dismissal the moment the id changes, so an escalation
  from capacity to signin re-shows. The ids are used at `:82` and `:95`; changing
  their *values* would change real behaviour. Only the export is unused, not the
  constant.
- **Reachable in production?**: n/a (convention).
- **Counter-arguments considered**: whether some other module consumes the ids by
  type (no importer exists), and whether `BannerStack` reads `actions[].key`
  (`App.tsx` passes `onAction` with no key parameter, so no).
- **True consequence**: one genuinely decorative constant and three surplus
  `export` keywords. The documented id contract is accurate.
- **Disposition**: Drop the `export` on all three (they are single-module
  constants) and either wire `onAction` to dispatch on the key or delete
  `ACCOUNT_HEALTH_ACTION_KEY` and the `key` field's implied contract from the doc.
  **Do not** rewrite the id doc comment — it is correct.

### A17-F10 — [LOW] Assorted exports with no consumer

- **Verdict**: **CONFIRMED** for all three, with two of them already on record.
- **Cited location holds?**: Yes. `settingsScope.ts:75` `isSettingsScopeKind` —
  zero references repo-wide, including inside its own file and test.
  `settingsState.ts:76-82` `selectSettingField` with the doc "the lookup every
  `Field` in a panel makes" — no panel calls it. `settingsReadState.ts:28-32`
  `selectSettingsReadState` — reachable only through `settingsWereRead` (`:35-37`),
  whose four production consumers are `MetadataInspector.tsx:396` and
  `SettingsShell.tsx:280,952,973`.
- **Reachable in production?**: none of the three.
- **Counter-arguments considered**: whether `selectSettingField`'s deadness means
  resolution is not surfaced — it does not, and `V31` F8 already rated that
  stronger claim OVERSTATED (`selectSettingsRow` surfaces it, source-scoped). A17
  does **not** make that stronger claim; its narrower "the doc asserts a call
  pattern that does not exist" is accurate and survives. Also whether
  `SettingResolution` (`settingsState.ts:60`) rides along dead — it does not, it is
  the return type of the live `selectManagedFields`.
- **True consequence**: three surplus exports, one of which carries a doc comment
  that will send a reader looking for panel code that was never written.
- **Disposition**: Unexport `isSettingsScopeKind` and `selectSettingsReadState`
  (or delete the former outright — `V31` F13 confirmed it has zero references
  anywhere). For `selectSettingField`, **fix the doc comment rather than wiring
  it**: `V31` F8 established that routing panels through it would reintroduce a
  recorded bug, because it is the source-blind winner-only lookup that
  `selectSettingsRow`'s source-scoped `layerValue` was written to replace.

### A17-F11 — [LOW] `settingsScope.ts` is a god file with seven unrelated jobs

- **Verdict**: **CONFIRMED**.
- **Cited location holds?**: Yes. `wc -l` = **1,133** exactly. The seven ranges
  land within a few lines of the real export boundaries: scope vocabulary
  `:66-141`, project picker `:146-231`, rail catalog `:235-478`, row grammar
  `:483-724`, destructive-value declarations `:879-962`, int-field commit
  `:972-1011`, annotation/write-target copy `:1021-1133`. One nit: the row-grammar
  range stops at `:724`, but `selectPermissionDefaultModeRow` (`:742-836`) is the
  same job and sits outside it, which strengthens the point rather than weakening
  it. The colocated test is **1,715 lines**, so "correspondingly enormous" is
  understated if anything.
- **Reachable in production?**: n/a (design).
- **Counter-arguments considered**: whether the rail catalog genuinely shares
  nothing with the row grammar — it does not; the only coupling is
  `SettingsRailItemId` appearing in neither direction of the row model.
- **True consequence**: the subtlest, highest-consequence code in this scope sits
  behind ~450 lines of static tables.
- **Disposition**: Apply the report's narrow split (`selectSettingsRail` +
  `selectSettingsRailItem` + `railItemSearchText` + the catalog into
  `settingsRail.ts`) **only when that file is next touched for another reason**.
  A 450-line move across a package with import-extension conventions is churn on a
  shared tree with no failing behaviour behind it; splitting the 1,715-line test
  alongside it doubles the conflict surface.

---

## Per finding — A18

### A18-F1 — [HIGH] Enter on an empty tag query silently writes a tag to the engine

- **Verdict**: **CONFIRMED**, including the bulk fan-out.
- **Cited location holds?**: Yes, precisely. `SessionsPage.tsx:1075-1085` is the
  `onKeyDown`, with `else if (matches[0]) apply(matches[0])` at **`:1080`** exactly
  as cited. `sessionsPageState.ts:264-268` is `resolveTagCommit`'s body
  (`if (normalized.length === 0) return null`). `:276-278` is `selectMatchingTags`
  (`tag.toLowerCase().includes(normalized)`). `selectKnownTags` sorts with
  `localeCompare` at `:213`. `resolveTagCommit`'s doc "an empty query does nothing"
  is at `:255-258`.
- **Reachable in production?**: Yes, with no gate. `query` is initialised to `''`
  at `:1029` and the input is `autoFocus` at `:1072`, so the popover opens in
  exactly the state that triggers it. `onApply={applyTag}` at `:474`;
  `applyTag` at `:229-240`; `onTagRows` at `App.tsx:3284-3301` mints a real
  `requestId` and calls `sendSessionActionVerb(row.appSessionId, { type: 'session.tag', … })`
  per row. No upstream guard blocks an empty query from reaching the handler —
  I looked for one specifically.
- **Trigger**: any workspace where at least one session already carries a tag.
  Click `+ tag` (or the bulk bar's **Tag**), press Enter.
- **Counter-arguments considered**:
  1. *Is the bulk bar's Tag button disabled in the state that matters?* It is
     disabled only on `writableCount === 0` (`:969`), which is orthogonal.
  2. *Does `applyTag` re-filter?* It does (`:236` `row.live && row.appSessionId != null`),
     which limits the blast radius to live rows but does not prevent the write.
  3. *Is the write invisible afterwards?* Partly. The report says "the user cannot
     see what was just changed" — the selection is cleared (`:238`), so *which*
     rows were hit is lost, but the rows themselves do render the new `#tag` once
     the echo lands, and "Remove tag" reverses it. So "silently" is right at the
     moment of action and slightly strong afterwards.
  4. *Does a zero-tag workspace trigger it?* No — `matches[0]` is `undefined`,
     control case verified.
- **True consequence**: one keystroke overwrites the tag of every selected live
  session with the alphabetically-first existing tag, clears the selection, and
  offers no confirmation or undo affordance beyond re-tagging.
- **Evidence**: `/private/tmp/claude-501/…/scratchpad/v17/a18-f1-empty-tag.ts`,
  importing the real `sessionsPageState.ts`:
  ```
  knownTags (sorted): ["alpha","mid","zeta"]
  resolveTagCommit(""): null
  selectMatchingTags(""): ["alpha","mid","zeta"]
  => Enter applies tag: "alpha"
  bulk writable rows that receive session.tag: [
    {"sessionId":"s1","appSessionId":"a1","oldTag":"zeta"},
    {"sessionId":"s2","appSessionId":"a2","oldTag":"alpha"},
    {"sessionId":"s3","appSessionId":"a3","oldTag":null}]
    each gets tag = "alpha"
  selection after applyTag: []
  CONTROL no-tags-yet: known = [] matches[0] = undefined
  ```
- **Disposition**: Apply the report's fix exactly — delete the `else if (matches[0])`
  arm at `:1080`. It is the whole bug and `resolveTagCommit` already owns the
  decision. Add a regression test at the **caller** level; `sessionsPageState.test.ts:209`
  pins `resolveTagCommit('  ', known) === null` and stops there, which is precisely
  why a green suite did not catch this. Consider also removing the now-provably-dead
  third clause from `resolveTagCommit`'s doc comment while you are in the file —
  that is `V15` F17, already CONFIRMED.

### A18-F2 — [MED] Direct-connect success details render for one frame, then vanish

- **Verdict**: **CONFIRMED**.
- **Cited location holds?**: Yes. `RemoteSettingsPage.tsx:278-281` computes
  `matched` in the render body from `pendingRequestId.current`; `:283-288` is the
  effect that nulls the ref and calls `setConnecting(false)`; `:290` is
  `const connected = matched && lastResult?.ok ? lastResult.directConnect : undefined`.
  The consumers are `:308` (`<RemoteRolePill/>`) and `:328-333` (the
  "Session … is reachable at …" paragraph). `BridgePanel`'s correct shape is at
  `:123-141` (the report said 123-134; the effect runs to `:141`).
- **Reachable in production?**: Yes. `RemoteSettingsPage` is mounted by
  `SettingsShell.tsx:614`; no env gate.
- **Trigger**: submit a valid server URL. `submit` (`:292-299`) sets
  `pendingRequestId.current = requestId` and `setConnecting(true)`. When the
  result frame lands, render N has `matched === true` and paints both. The effect
  then sets `pendingRequestId.current = null` **and** `setConnecting(false)` —
  and because `connecting` was `true`, that is a real state change, forcing render
  N+1 in which `matched` recomputes `false` and both unmount.
- **Counter-arguments considered**:
  1. *Is `setConnecting(false)` actually a change?* Yes — `connecting` is `true`
     for the whole pending window, so React does not bail out. This is the load-
     bearing step and the report does not state it; without it there would be no
     second render and the content would persist.
  2. *Does the toast carry the URL?* No — `toast(lastResult.message, …)` at `:287`
     shows the sidecar's own message, not `directConnect.wsUrl`.
  3. *Does the user get the URL elsewhere?* No other surface in the file renders
     `directConnect`.
  4. *Would React skip painting render N?* Passive effects are normally flushed
     after paint, so one frame is typically visible — but a ~16 ms flash is not a
     readable or copyable string either way, so the consequence stands regardless.
- **True consequence**: the only artifact the panel exists to deliver flashes for
  roughly one frame and is then unmounted permanently for that request.
- **Evidence**: `RemoteSettingsPage.tsx:274-299, 308, 328-333`; `:123-141`.
- **Disposition**: Apply the report's fix (hold the matched result in state,
  set it inside the effect alongside `setConnecting(false)`). Better still, adopt
  `BridgePanel`'s shape wholesale so the file has one idiom rather than two —
  match inside the effect, never derive a correlation from a ref during render.

### A18-F3 — [MED] Two page files in scope have zero importers

- **Verdict**: **CONFIRMED** (with a disposition correction).
- **Cited location holds?**: Yes. `DiagnosticsSection.tsx` is **131** lines,
  `WorkspaceTrustSection.tsx` **93**, 224 total — exact. A repo-wide grep returns
  only their own definitions, `docs/` prose, and one comment at
  `MetadataInspector.tsx:527` that names `DiagnosticsSection` while explaining why
  it is *not* reused. No colocated tests.
  `WorkspaceTrustSection.tsx:72-73` is verbatim:
  ``Directories outside the workspace tools may access (`--add-dir` and`` /
  `` `permissions.additionalDirectories`). `` — literal backticks in JSX text,
  plus two internal config key names. `SettingsShell.tsx`'s Law 1 header is at
  **`:15-19`** ✅. `docs/reports/2026-07-28-bug-catalogue.md:427` ✅.
- **Reachable in production?**: Neither file is.
- **Counter-arguments considered**: whether the data is genuinely unreachable to
  the user — it is not, and this is where `V31` F2 corrects the framing: the same
  data renders in the mounted `MetadataInspector`, so the *surface* is dead but
  the *information* is not. Whether the backtick bug is therefore user-visible —
  it is not, since the file never mounts, which downgrades it from "a live
  rendering bug" to "a bug that would appear the moment anyone mounts it".
- **True consequence**: 224 lines carried through every typecheck, lint and review
  pass while rendering nothing, one of them containing markup that would render
  literal backticks if it were ever mounted.
- **Evidence**: `wc -l`; greps above; `MetadataInspector.tsx:527`.
- **Disposition**: **Do not just "delete both files".** `WorkspaceTrustSection` is
  one of the four surfaces whose deletion is explicitly **PARKED** at
  `2026-07-28-bug-catalogue.md:427-430` ("the docs still treat them as live work,
  and one holds the only implementation of data that currently renders nowhere"),
  and `V31` F2 records the same adjudication. The correct action is to resolve the
  park — a STATUS decision that these two are superseded by `MetadataInspector` —
  and delete under that decision, not under a review finding. This is now a third
  sighting for `WorkspaceTrustSection`; the two-strikes rule applies.

### A18-F4 — [MED] `SettingsShell` accepts four props it never renders

- **Verdict**: **CONFIRMED**.
- **Cited location holds?**: Yes, exactly. `SettingsShell.tsx:173-181` is the
  comment block plus the four optional props
  (`additionalWorkingDirectories`, `permissionContext`, `diagnosticsSnapshot`,
  `workspaceTrustSnapshot`), with the comment saying verbatim "Accepted but no
  longer rendered here" and "drop them from App's call site and from here in the
  same later change". `App.tsx:3219-3238` passes all four, each through a live
  selector call — `selectAdditionalWorkingDirectories` (`:3219`),
  `selectPermissionContext` (`:3223`), `selectDiagnosticsSnapshot` (`:3226`),
  `selectWorkspaceTrustSnapshot` (`:3235`).
- **Reachable in production?**: Yes — the `settings` view renders on every visit.
- **Trigger**: n/a (waste, not a defect).
- **Counter-arguments considered**: whether the props are read anywhere in the
  file (they are destructured into the signature and never referenced in the
  body); whether the selectors are memoised (they are not — all four are bare
  calls in JSX, re-running on every `App` render); and whether the deferral note is
  still valid ("while it is mid-edit in another session") — `App.tsx` is not dirty
  in the working tree at `a1012b1`, so the stated blocker has expired.
- **True consequence**: four selector calls per `App` render producing values
  destructured into nothing, and a prop type that misrepresents what the component
  consumes.
- **Disposition**: Apply as written — remove from both sides in one edit. This is
  the cleanest fix in either report: the comment already specifies it, the blocker
  is gone, and it mechanically removes the class of confusion that let A18-F3's
  two orphans go unnoticed.

### A18-F5 — [MED] `selectWritableSelection` is dead, and its rule is re-derived inline three times

- **Verdict**: **DUPLICATE** — `V15-renderer-session-state.md` F9 (CONFIRMED) and
  `V31-dead-code-wiring.md` F7 (PARTIALLY CONFIRMED).
- **Cited location holds?**: Yes; I re-verified independently.
  `sessionsPageState.ts:191-201` is the selector, its only importer is
  `sessionsPageState.test.ts`, and the inline copies are at `SessionsPage.tsx:236`,
  `:443`, `:604`. `V15` F9 additionally found a **fourth** copy at `App.tsx:3309`
  that A18 misses.
- **Counter-arguments considered**: whether A18 adds anything — the "security-
  adjacent gate" framing is new, and it is fair (the predicate does decide which
  sessions a bulk write reaches), but the defect is the same one.
- **Disposition**: Follow `V15` F9's and `V31` F7's disposition, not A18's.
  A18 proposes "have `SessionsPage` call `selectWritableSelection`", but the
  selector returns `SessionId[]` while `:236` needs the writable **rows** (to pass
  to `onTagRows`) and `App.tsx:3308-3315` needs rows (to read `row.title`). Add a
  `selectWritableRows` returning rows, define the id selector in terms of it, then
  delete the four copies. A18's alternative — export a single `isSessionWritable(row)`
  predicate — is actually the cleaner of its two suggestions and works at all four
  sites.

### A18-F6 — [MED] Session rows are `role="button"` while containing three nested buttons

- **Verdict**: **CONFIRMED** (one wording nuance).
- **Cited location holds?**: Yes, every line. `SessionsPage.tsx:753-755` is the
  comment "A div, not a button: the row now nests its own controls (checkbox, tag,
  ⋯), and a button may not contain buttons." `:758` is
  `role={openable ? 'button' : undefined}` and `:759` the matching `tabIndex`.
  The nested controls are at `:628` (checkbox `<button>` with `aria-pressed`),
  `:657` (rename `<input aria-label="Session name">`), `:703` (`<TagControl>`),
  `:713` (⋯ `<button>`). The title `<span>` is at `:676`.
- **Reachable in production?**: Yes, on every openable row.
- **Trigger**: any openable session row read by assistive tech.
- **Counter-arguments considered**: whether ARIA actually flattens the subtree —
  yes: `role="button"` is defined with *presentational children* in ARIA 1.2, so
  conforming AT presents descendants as text. The nuance is that the claim "the
  rename input becomes unreachable **by role**" is stronger than what real screen
  readers do in practice: focusable descendants generally remain reachable via
  focus mode even when presentational, so the accurate statement is that they lose
  their roles and accessible names in the reading order, not that they become
  unreachable. Also checked whether `openable` is usually false (it is not — most
  rows are openable), and whether the nested controls `stopPropagation` (they do,
  at `:631` and `:661`, which fixes pointer behaviour but not the ARIA tree).
- **True consequence**: on openable rows, four labelled controls are presented as
  flat text inside a single button, undoing the ARIA correctness the comment one
  line above was written to achieve.
- **Disposition**: Apply the report's first option — move `role`/`tabIndex` off the
  container and onto the title element at `:676`. Its second option ("keep the div
  as a plain `listitem`") is worse: the rows are not inside a `role="list"`, so
  `listitem` would be an orphaned role, and adding an explicit "Open" control per
  row is a visible parity change that needs an operator ruling.

### A18-F7 — [MED] `AgentsPage`, `MemoryPage`, `RemoteSettingsPage` each carry an unreachable standalone layout

- **Verdict**: **CONFIRMED**.
- **Cited location holds?**: Yes. `AgentsPage.tsx:86-100` is the `embedded`
  ternary (report said 90-100 — the ternary opens at `:86`) and `:148-153` is
  `if (embedded) return body` plus the `<div>` wrapper. `MemoryPage.tsx:51-79`
  covers `if (embedded) return body` (`:51`), the `<main>` wrapper (`:53-60`) and
  `MemoryHeader` (`:63-79`) ✅. `RemoteSettingsPage.tsx:50-73` likewise ✅.
  `SettingsShell.tsx:599` (`<MemoryPage embedded …/>`), `:603` (`<AgentsPage embedded …/>`),
  `:614-615` (`<RemoteSettingsPage embedded …/>`) ✅.
- **Reachable in production?**: `SettingsShell.tsx` is the **sole** importer of all
  three (verified by grep for `from './AgentsPage.js'` etc.), and it always passes
  `embedded`. The `embedded === false` branches are therefore unreachable.
- **Trigger**: none — that is the finding.
- **Counter-arguments considered**: whether `counts.active` renders elsewhere — it
  does, at `AgentsPage.tsx:113` (`<SummaryCard label="Active" …/>`), which is
  exactly the exception the report states ("outside the summary card"), so the
  claim is precise. Whether a future standalone route is planned — nothing in
  `docs/migration/backlog/` reserves one, but I did not exhaustively check the
  parity ledger for a `standalone Memory page` row.
- **True consequence**: three dead layouts, three dead headings, and a second copy
  of each page title, invisible to tests because the suites render the components
  directly rather than through `SettingsShell`.
- **Disposition**: Apply, but sequence it: delete the `embedded` prop **and** the
  standalone branches in one change, so the intermediate state never has a prop
  with one value. Check each page's `PARITY-LEDGER.md` rows first — deleting a
  rendered `<h1>` is a parity-visible change even when it never renders today, and
  §9's silent-parity-cut rule wants it flagged rather than dropped.

### A18-F8 — [MED] `PathCopyButton` and `EmptyState` are each duplicated verbatim across two files

- **Verdict**: **PARTIALLY CONFIRMED**. `PathCopyButton` is exactly as claimed;
  the `EmptyState` half is wrong and contradicts A18's own F15.
- **Cited location holds?**: `PathCopyButton` — yes, precisely.
  `AgentsPage.tsx:417-454` and `MemoryPage.tsx:326-363` are character-identical
  (same clipboard guard, same two toast strings, same 1200 ms reset, same
  `aria-label` shape) except for one token: `font-sans` in the `AgentsPage`
  `className` at `:442`, absent at `MemoryPage.tsx:351`. `EmptyState` — the markup
  citation holds (`AgentsPage.tsx:167-174` vs `SessionsPage.tsx:900-905`, identical
  down to `py-14 text-center`, `mb-1 text-sm font-medium text-text-subtle`,
  `text-xs text-text-subtle/75`).
- **What does not survive**: "only the prop names differ (`title`/`hint` vs
  `headline`/`subtext`)". `SessionsPage`'s `EmptyState` takes
  `{ catalogLoaded, searching, tagged }` (`:877-885`) and *derives* `headline` and
  `subtext` as locals from three booleans (`:886-899`) — including the deliberate
  "no subtext while loading" rule documented at `:893-894`. `headline`/`subtext`
  are not props. The two components are not interchangeable, and **A18-F15 praises
  exactly this difference** ("`SessionsPage`'s `EmptyState` takes a `catalogLoaded`
  flag (lines 877-899)"), so the report contradicts itself.
- **Reachable in production?**: both duplicates render.
- **Counter-arguments considered**: whether the `font-sans` divergence is
  deliberate (nothing in either file says so, and the surrounding rows in both
  drawers use the same type scale, so "the same button in a different typeface on
  two settings panes" is fair); whether a shared `EmptyState` is still worth
  extracting (it is, as a *presentational* leaf — but that is a smaller change than
  "move both into a shared module").
- **True consequence**: one genuine verbatim duplicate already drifting by one
  class, and one six-line markup overlap between two components with different
  responsibilities.
- **Disposition**: Extract `PathCopyButton` to a shared module and import from
  both sites — straightforward and correct. For `EmptyState`, extract only the
  presentational shell `({ headline, subtext })` and have `SessionsPage` keep its
  three-boolean wrapper that computes them; **do not** collapse the two into one
  component, which would either lose the loading/empty distinction A18-F15 wants
  copied elsewhere or push three page-specific booleans into `AgentsPage`.

### A18-F9 — [MED] `StartupOAuth` switches over a closed union with no exhaustiveness tripwire

- **Verdict**: **CONFIRMED**.
- **Cited location holds?**: Yes. `StartupSurfaces.tsx:238-243` is the five-variant
  `StartupOAuthView` union. The renderer runs `:409-522` as four
  `if (view.phase === …) return …` guards — `waiting` (`:409`), `success` (`:426`),
  `alias` (`:443`), `error` (`:447`) — with no `'ready'` guard and no `default`
  assigning to `never`; the provider-chooser at `:500-522` is the bare
  fallthrough. `SettingsEditors.tsx:525-528` is the correct in-package
  counter-example (`default: { const exhaustive: never = decision; return exhaustive }`)
  ✅ exact.
- **Reachable in production?**: The component renders on every OAuth flow; the
  *defect* is latent until a sixth phase is added.
- **Trigger**: adding a sixth variant to `StartupOAuthView`. It compiles clean and
  silently renders the provider chooser mid-flow, after the browser is already open.
- **Counter-arguments considered**: whether `tsc` would catch it another way — no;
  `view` is never narrowed to `never`, so nothing forces a case. Whether the union
  is genuinely closed — yes, a five-member literal union with no index signature.
  Whether `CLAUDE.md` §7 actually mandates the tripwire — it does ("Closed unions
  get compile-time exhaustiveness tripwires (`default` case assigning to `never`)").
- **True consequence**: a convention violation with a specific, plausible future
  failure and a correct example seven files away.
- **Disposition**: Apply as written. `switch (view.phase)` with `'ready'` in its
  own case and the `never` default. Cheap, mechanical, and the file already has
  the pattern to copy from.

### A18-F10 — [MED] The Welcome screen's Codex table has seven unlabeled columns

- **Verdict**: **CONFIRMED**.
- **Cited location holds?**: Yes. `WelcomeScreen.tsx:557-585` is `CodexRow`; the
  grid at `:562` is `grid-cols-[1.4fr_1.6fr_0.5fr_0.6fr_1.6fr_0.5fr_0.6fr]` —
  seven columns. `UsageBar` (`:592-604`) renders a bare `<div>`; `UsagePct`
  (`:608-619`) renders `{p}%` with no context; `ResetCell` (`:623-629`) renders a
  bare string. The last cell is `<ResetCell value="" />` at **`:582`**, always
  empty by design per the comment at `:579-581`. There is no header row — the
  container at `:546-552` maps rows directly with only a count/health summary above
  at `:528-542`. `AccountsPage`'s labelled equivalent is at `:599-605`
  (`<HeadroomBar label="5h" …/>` and `label="wk"`) ✅ exact.
- **Reachable in production?**: Yes; the Welcome screen is the startup surface.
- **Trigger**: any user with one or more Codex accounts.
- **Counter-arguments considered**: whether a legend exists elsewhere on the
  screen (no — the only text is `N accounts · N healthy`); whether the columns are
  self-evident from ordering (they are not — two identical bar/pct pairs with no
  distinguishing mark); whether the empty seventh cell is a bug (it is documented
  as deliberate at `:579-581`, so the finding correctly treats it as design).
- **True consequence**: four bars and four percentages per screen with no legend,
  and for assistive tech a row that reads as an undifferentiated sequence of
  numbers.
- **Disposition**: Apply the `aria-label` half unconditionally — it is invisible
  and closes the AT gap. The visible header row is a **parity change**: the
  prototype (`Welcome.jsx`) has no header, so adding one needs a ledger row and an
  operator ruling per §9. Ship the labels now, propose the header separately.

### A18-F11 — [MED] The Welcome screen's usage meters hardcode pink and ignore the accent theme

- **Verdict**: **PARTIALLY CONFIRMED**. The mechanism is exact; the framing omits
  that the flat pink is a documented parity decision, which changes the fix from a
  bug fix into a design proposal.
- **Cited location holds?**: Yes. `WelcomeScreen.tsx:599` is
  `bg-gradient-to-r from-[#f9a8d4] to-[#ec4899]`; `:614` is
  `p >= 100 ? 'text-[#ec4899]' : 'text-[#f9a8d4]'`. These are static arbitrary
  values, so Tailwind does generate them — the report is right that this is not the
  dynamic-class trap. `accentTheme.ts:11-19` is quoted accurately, including "so
  one attribute repaints all of them".
- **Reachable in production?**: Yes. `ACCENT_KEYS` ships five accents (`:32`) and
  `AccentThemeProvider` is mounted above everything at `main.tsx`.
- **Trigger**: pick Blue in Settings ▸ This app ▸ Appearance. Every `--accent`-
  derived surface retints; these three classes do not.
- **Counter-arguments considered**: **the decisive one the report buries in its
  uncertainty section.** The comment at `WelcomeScreen.tsx:588-590` states the
  prototype's `MiniUsageBar` (`Welcome.jsx:121`) uses "ONE flat pink gradient fill
  for every account regardless of percentage — NOT the threshold red/green/amber of
  the AccountsPage meter", and `:606-607` repeats it for the percentage. So the
  literal pink is deliberate prototype parity, deliberately distinguishing this
  surface from `AccountsPage`. Applying `from-accent-soft to-accent` under a
  non-pink accent would erase that distinction. I also checked whether
  `--accent-soft` would even reproduce the same two-stop gradient (it would not —
  the accent pairs a Tailwind 400 with its own 300, whereas `#f9a8d4`/`#ec4899` are
  pink-300/pink-500).
- **True consequence**: two of the five accents' worth of visual inconsistency on
  one panel of the startup screen, arising from a decision that was made on
  purpose for a different reason.
- **Disposition**: **Do not apply as a fix.** Raise it as a §0 parity question
  for the operator: "should the Welcome usage meters follow the accent, at the cost
  of the deliberate flat-pink distinction from AccountsPage?" If the answer is yes,
  the change is three classes; if no, add one sentence to the `:588-590` comment
  saying the pink is accent-independent on purpose, so the next reviewer does not
  re-file this. Re-file as LOW pending that ruling.

### A18-F12 — [MED] Internal vocabulary and unbuilt-feature explanations rendered to users

- **Verdict**: **CONFIRMED**, all four.
- **Cited location holds?**: Yes, with two small drifts.
  1. `StartupSurfaces.tsx:417-418` ✅ — the rendered text is provider-conditional
     (`Your {provider === 'anthropic' ? 'Anthropic' : 'Codex'} account appears once
     the engine captures the callback.`), so the report's quote is slightly
     narrower than the source, but "the engine captures the callback" is verbatim.
  2. `SettingsExtensions.tsx:300-302` — the sentence spans **`:299-302`**;
     "(toggling is deferred to a settings writer)" is verbatim at `:302`.
  3. `AgentsPage.tsx:375-376, 390` ✅ exact — `'present, withheld'` (`:375`),
     `'present, payload withheld'` (`:376`), `'present, config withheld'` (`:390`).
  4. `SettingsShell.tsx:283-292` ✅ exact.
  The counter-example is exact too: `SettingsShell.tsx:682`
  `desc="The mode a session starts in. Change it from the CLI."`.
- **Reachable in production?**: All four render on live surfaces (OAuth waiting
  screen, Extensions pane, agent detail grid, every settings pane header).
- **Trigger**: opening those surfaces.
- **Counter-arguments considered**: whether "withheld" is defensible as a security
  statement (it is accurate but it is boundary vocabulary, and §7 bars exactly that
  register — the user reads it as an error); whether the Extensions sentence is a
  legitimate limitation note (§7 is explicit: "Tell the user what to DO … not why
  we have not built it"); whether any of the four is a code comment rather than
  rendered text (none is — all four are inside JSX text or a `desc` prop).
- **True consequence**: four user-readable strings that name our plumbing or our
  backlog on three shipped surfaces.
- **Disposition**: Apply the report's rewrites. One refinement: for the agent grid,
  `"Set, not shown here."` is better than the report's own suggestion for
  `hasHooks`/`hasMcpServers` too, so use one phrase for all three rather than three
  variants — the current three-way split ("withheld" / "payload withheld" /
  "config withheld") is itself the drift.

### A18-F13 — [MED] `CodeThemePreview` duplicates the plugin config it exists to stay in sync with

- **Verdict**: **CONFIRMED**.
- **Cited location holds?**: Yes. `CodeThemePreview.tsx:41-52` is the PLUGIN
  CONFIG comment plus `PREVIEW_REHYPE_PLUGINS` (`:49-52`), and the comment concedes
  the duplication and names the fix verbatim ("the drift-free form is to import it,
  which costs one word (`export const REHYPE_PLUGINS`)"). `TranscriptView.tsx:629-632`
  is the module-private `REHYPE_PLUGINS`, and the two are **byte-identical**:
  `[[rehypeHighlight, { detect: false, ignoreMissing: true }]]` with the same tuple
  type annotation. The file header's "MUST BE THE TRANSCRIPT'S OWN CODE BLOCK, NOT
  A LOOKALIKE" argument is at `:6-14` ✅.
- **Reachable in production?**: Yes — the preview heads Settings ▸ This app ▸
  Appearance.
- **Trigger**: changing `detect` or `ignoreMissing` in `TranscriptView.tsx`. The
  preview would then advertise highlighting behaviour the transcript no longer has,
  with no test or type error.
- **Counter-arguments considered**: whether the stated reason still holds —
  `TranscriptView.tsx` is **not** dirty in the working tree at `a1012b1`, so "its
  file was under concurrent edit" has expired exactly as the report says. Whether
  `remark-gfm`'s deliberate absence is a second divergence — it is not; the comment
  at `:45-47` gives a sound reason (a fenced block cannot contain tables,
  autolinks, or strikethrough).
- **True consequence**: a one-line drift vector inside the one component whose
  entire stated purpose is to not drift.
- **Disposition**: Apply as written — `export const REHYPE_PLUGINS` in
  `TranscriptView.tsx`, import it here, delete `PREVIEW_REHYPE_PLUGINS` and the
  PLUGIN CONFIG comment's first two sentences. One caution: `TranscriptView.tsx` is
  a Fast-Refresh-boundary file, but a `const` export is a value export from a
  `.tsx` module, which `lint:fast-refresh` flags. Move the constant to an adjacent
  `.ts` module (e.g. beside `codeTheme.ts`) and import it from both, or the fix
  will fail the boundary gate.

### A18-F14 — [LOW] The alias input's only accessible name is its placeholder

- **Verdict**: **CONFIRMED**.
- **Cited location holds?**: Yes. `StartupSurfaces.tsx:373-380` is `AliasForm`'s
  input: `autoFocus` (with an `eslint-disable-next-line jsx-a11y/no-autofocus` at
  `:374`), `placeholder="work · personal · team-a"`, no `aria-label`, no `<label>`.
  `PasteCodeFallback`'s input at `:304-309` likewise has only
  `placeholder="Paste authorization code"`. `SessionsPage.tsx:271-276` is the
  search input, `placeholder="Search sessions…"`, no label.
  `AccountsPage.tsx:321` is `aria-label="New alias"` ✅.
  `RemoteSettingsPage.tsx:310-320` is the real `<label htmlFor="remote-server-url">`
  ✅. `SettingsShell`'s search input carries `aria-label="Search settings"` at
  **`:302`** (report said 303).
- **Reachable in production?**: Yes, all three.
- **Trigger**: any screen-reader user reaching the field; the computed name is the
  example values, not the field.
- **Counter-arguments considered**: whether a placeholder is an acceptable
  accessible name (it is a documented last-resort fallback in the accname spec, and
  the disable-comment at `:374` shows the file already runs `jsx-a11y`, so the
  omission is an oversight not a policy); whether `AliasForm` has a visible heading
  that AT would associate (it does not — the surrounding `<h1>` is not linked by
  `aria-labelledby`).
- **True consequence**: three inputs whose accessible names describe examples or
  nothing, on surfaces whose siblings do it correctly.
- **Disposition**: Apply as written. Three one-line `aria-label` additions.

### A18-F15 — [LOW] `GoalsPage` renders an internal goal id and conflates loading with empty

- **Verdict**: **CONFIRMED**.
- **Cited location holds?**: Yes. `GoalsPage.tsx:32` is
  `{!snapshot ? <EmptyGoal /> : <GoalCard goal={snapshot} />}` — the only non-goal
  branch. `:62-64` is `<span className="font-mono text-[11px] text-text-subtle">{goal.goalId}</span>`
  beside `<StatusBadge>`. `goalId` is typed `string` at `shared/protocol.ts:913`,
  an engine-minted identifier with no rendered meaning. The comparison surfaces are
  exact: `SessionsPage.tsx:877-899` (`catalogLoaded` ✅),
  `AccountsPage.tsx:677` (`WaitingState` ✅), `MemoryPage`/`SettingsExtensions`
  both carry `WaitingState`/`WaitingRow`.
- **Reachable in production?**: Yes; `GoalsPage` renders at `App.tsx:3241-3248`
  whenever `activeView === 'goals'`.
- **Trigger**: open Goals on a session that *does* have a goal — for the window
  before `thread-goal.snapshot` lands, `snapshot` is null and the page asserts "No
  active thread goal" and tells the user to run `/goal`.
- **Counter-arguments considered**: whether §7 actually bars the id (it bars
  "session ids" and "engineering notes"; a goal id is the same register, and the
  neighbouring pages all avoid it); whether the loading window is too short to see
  (it is not — the snapshot arrives on a session frame, and the page can be opened
  before a session is attached at all, in which case the false claim is permanent).
- **True consequence**: an identifier with no user meaning in mono beside the
  status, plus a page that states "there is no goal" during a window in which it
  does not know.
- **Disposition**: Apply both halves. The loading half is the one that matters and
  the house pattern is right next door — `AccountsPage.tsx:677`'s `WaitingState`
  with its comment at `:672-675` explaining why the copy carries no internal
  vocabulary is the exact template to copy.

### A18-F16 — [LOW] `PathCopyButton`'s reset timer is never cleared

- **Verdict**: **CONFIRMED** (one arithmetic overstatement).
- **Cited location holds?**: Yes. `AgentsPage.tsx:431` and `MemoryPage.tsx:340` are
  both `setTimeout(() => setCopied(false), 1200)` inside the clipboard `.then()`,
  outside any `useEffect`, with no handle stored and no cleanup.
- **Reachable in production?**: Yes — one button per instruction file and per
  auto-memory row.
- **Trigger**: copy a path in `AgentInspectDrawer`, then press Escape within
  1.2 s; the drawer unmounts and the timer still calls `setCopied` on an unmounted
  component.
- **Counter-arguments considered**: whether React 18 warns (it does not — the
  `setState on unmounted component` warning was removed in 18, so the report is
  right that this is a stray timer rather than a console signal). Whether the "a
  page with 30 rows holds 30 independent uncancelled timers" figure is right — it
  is an overstatement: each button holds at most one *pending* timer at a time and
  only while it is within 1.2 s of a click, so 30 simultaneous timers requires 30
  clicks inside 1.2 s. The defect is real; the volume is not.
- **True consequence**: a short-lived stray timer per copy click, with a no-op
  state write if the component unmounts first. No user-visible symptom.
- **Disposition**: Apply, but fold it into the F8 extraction rather than fixing it
  twice — extract `PathCopyButton` to a shared module first, then add the ref +
  `useEffect` cleanup once. Fixing it in both copies is the duplication F8 is
  about.

### A18-F17 — [LOW] Relative timestamps freeze until an unrelated re-render

- **Verdict**: **CONFIRMED**.
- **Cited location holds?**: Yes, all four. `SessionsPage.tsx:147`
  (`const now = Date.now()` in the render body), `MemoryPage.tsx:230` (same, inside
  `AutoMemories`), `WelcomeScreen.tsx:650` (`formatResetCompact` reads `Date.now()`
  at call time, invoked from `CodexRow` at `:560`), `accountsPageModel.ts:154`
  (`formatResetLabel(sec, now = Date.now())`).
- **Reachable in production?**: Yes, on four live surfaces.
- **Trigger**: leave any of the four pages open. Nothing schedules a re-render.
- **Counter-arguments considered**: **is there a ticker anywhere?** I grepped
  `setInterval` across all seventeen files in scope — **zero hits**. So the claim
  is airtight, not merely likely. Also checked whether frame traffic incidentally
  re-renders these pages: the Sessions page re-renders on catalog delivery
  (`:153-155`), which is bounded by the catalog refresh interval, and the Accounts
  page re-renders on pool refresh — so the strings do update *eventually* on those
  two, just not on a clock. `WelcomeScreen` and `MemoryPage` have no such driver.
- **True consequence**: "2m ago" and "Resets in 4h 12m" are correct at first paint
  and then drift silently. On Accounts the string is the answer to "when can I use
  this account again", on a page users park on while waiting.
- **Disposition**: Apply the report's fix, but only where it earns its keep: one
  30–60 s `now` state on `AccountsPage` (the load-bearing case) and on
  `WelcomeScreen`'s Codex panel. `SessionsPage` and `MemoryPage` already re-render
  on data delivery frequently enough that a dedicated interval on an always-on app
  is a worse trade — the repo has a recorded idle-CPU investigation, and four
  independent intervals is exactly the kind of thing it was about.

### A18-F18 — [LOW] Dead exports: `SessionsPageAnchor`, `RemoteRolePill`

- **Verdict**: **CONFIRMED** (with provenance corrections on both halves).
- **Cited location holds?**: Yes. `sessionsPageState.ts:28` is
  `export type SessionsPageAnchor = { top: number; left: number }` with zero
  references repo-wide outside `docs/`; `SessionsPage` imports
  `SessionActionsAnchor` from `SessionActionsMenu.js` instead.
  `RemoteSettingsPage.tsx:88` is `export function RemoteRolePill()`, used only at
  `:308` in its own file, by no test.
- **Reachable in production?**: `SessionsPageAnchor` is unreachable (type-only,
  unreferenced). `RemoteRolePill` **is** reachable — it renders on a successful
  direct-connect; only its `export` is surplus.
- **Counter-arguments considered**: whether either is documentary-wired.
  `SessionsPageAnchor`: no — `V31` F14 already confirmed it as one of three
  zero-reference exported types. `RemoteRolePill`: **yes, partly** —
  `docs/migration/PARITY-LEDGER.md:1841-1845` carries four ledger rows for it,
  recording the Control variant as ✅ rendered at `:320` and the viewer variant as
  ✂️ cut per `decisions/PAIRED-DEVICES.md` §3/§6. So it is not an unexplained
  orphan; it is a ledgered, deliberately-narrowed component. Note the ledger says
  `:320` while the current call site is `:308`, so the ledger row is stale by
  twelve lines.
- **True consequence**: one dead type and one surplus `export` keyword.
- **Disposition**: Delete `SessionsPageAnchor` (this is now a second sighting —
  `V31` F14 has it — so it should ride that finding's fix rather than a new one).
  Dropping `export` from `RemoteRolePill` is fine, but do it as part of the same
  edit that refreshes the stale `PARITY-LEDGER.md:1841` line reference, or the next
  reviewer will re-derive the same orphan claim from a ledger that points at the
  wrong line.

### A18-F19 — [LOW] `AgentsPage` renders a constant dressed as data

- **Verdict**: **CONFIRMED**.
- **Cited location holds?**: Yes, exactly. `AgentsPage.tsx:358` is
  `['Provider', 'runtime-selected']`, a hardcoded tuple sitting between
  `['Model', definition.model ?? 'inherit']` (`:357`) and
  `['Tools', toolsLabel(definition.tools)]` (`:359`) — every neighbour is real
  engine data, and the grid styles them identically.
- **Reachable in production?**: Yes, in every agent detail drawer.
- **Trigger**: open any agent's detail.
- **Counter-arguments considered**: whether `'runtime-selected'` is meaningful
  (it is true — provider is resolved per request from the model string,
  `src/utils/model/providers.ts` — but it is invariant across every agent, so it
  carries zero information in a per-agent grid); whether the row could become
  variable (only if agent definitions gained a provider field, which
  `AgentConfigSnapshot` does not have).
- **True consequence**: a labelled row a user reasonably reads as this agent's
  configured provider, which never varies.
- **Disposition**: Apply — remove the row. If the invariant is worth stating at
  all, it belongs once in the pane's header prose, not once per agent.

---

## Clean bills — re-derived

Both reports' praise sections are as falsifiable as their findings, so I recounted
mechanically over the seventeen A18 files
(`/private/tmp/claude-501/…/scratchpad/v17/a18files.txt`).

- **"Zero interpolated arbitrary-value Tailwind in 7,695 lines" — TRUE, and the
  line count is exact.** `xargs wc -l` reports **7,695 total**. `rg '\[[^]"]*\$\{'`
  returns one hit, `SettingsExtensions.tsx:187` — and it is
  `['installed', \`Installed · ${installedCount}\`]`, a label tuple, not a Tailwind
  class. Zero genuine interpolated arbitrary values.
- **"Zero user-visible em dashes across seventeen files" — TRUE.** There are
  **122** em-dash hits (the report says "60+", which is true but understated by
  half). Filtering out lines beginning with `*`, `//`, `/*` or `{/*` leaves exactly
  one: `WelcomeScreen.tsx:581`, which is the continuation line of a `{/* … */}`
  JSX comment opened at `:579`. Zero reach a screen.
- **"Fast Refresh boundary clean in all 17 files, with both theme providers keeping
  their contexts in adjacent `.ts` files" — TRUE, and now proven rather than
  reasoned.** `bun test app/renderer/src/fastRefreshBoundaries.test.ts` → **1 pass
  / 0 fail**. `AccentThemeProvider.tsx` and `CodeThemeProvider.tsx` each export
  exactly one symbol (the component); `createContext` lives in `accentTheme.ts:26`
  and `codeTheme.ts`.
- **A17's "no interpolated arbitrary-value class exists anywhere in this scope" and
  "no tone maps to a colour that contradicts its name" — TRUE** for the maps I
  checked (`AGENT_TYPE_TONE_CLASS`, `AGENT_STATE_TONE_CLASS`, `TASK_COLOR_CLASS`,
  `ACCENT_SWATCH_CLASS`), all of which are static literal maps with explicit
  fallbacks.
- **A17's one named text outlier is exact.** `accountsPageModel.ts:146` is
  `'1–32 chars · letters, numbers, - or _'` — an en dash (U+2013) and a middle dot,
  and the only such string in that scope. Worth noting it is an **en** dash, so the
  §7 em-dash sweep (`rg -n '—'`) does not see it; that is a gap in the check, not
  just in the string.

## Findings the original reports missed

### [MED] Two more outside-click backdrops drop focus, and one of them is the only site where A17-F4's second fix half applies

A17-F4 names two backdrop sites. There are four. In addition to
`SessionActionsMenu.tsx:89-97` and `Sidebar.tsx:1135-1139`:

- `SessionActionsMenu.tsx:191-195` — `SessionRenamePopover`'s backdrop,
  `onClick={onCancel}`, with no `restoreTriggerFocus()`. Its Enter and Escape
  handlers (`:217`, `:221`) both restore correctly, so this is the same
  choose-vs-dismiss asymmetry.
- `SessionsPage.tsx:296-300` — the sort menu's `fixed inset-0 z-40` backdrop,
  `onClick={() => setSortOpen(false)}`. Its item handler at `:315` restores; the
  backdrop does not. **This is also the only `usePopoverFocus` call site that
  passes a variable `open`** (`open: sortOpen`, `:135`), which means it is the only
  place A17-F4's second recommendation — dropping `triggerFocusRef.current = null`
  from the `!open` branch at `overlayFocus.ts:369-372` — has any effect at all. The
  report presents that as a general correction; it is a one-site one.

This does not change A17-F4's verdict, but it changes the argument for its fix:
with four sites and rising, fixing the hook once is clearly right and patching
call sites clearly wrong.

### [LOW] The §7 em-dash sweep cannot see the en dash it is meant to catch

`CLAUDE.md` §7 prescribes `rg -n '—' app/renderer/src --glob '!*.test.*'` as the
check. A17 correctly flags `accountsPageModel.ts:146`
(`'1–32 chars · letters, numbers, - or _'`) as a stylistic outlier, but does not
note that the prescribed command **cannot find it**: `–` is U+2013 (en dash) and
the pattern matches U+2014 only. Any future en dash in user-visible text passes the
documented gate silently. The cheap fix is to widen the documented sweep to
`rg -n '[—–]'`.

## Working-tree state

Every file cited by either report is under `app/`, so all are branch-new relative
to `main`. **None of the files cited by A17 or A18 is dirty at `a1012b1`.** The
dirty renderer files are `ComposerActionsBar.tsx/.test.tsx`,
`PermissionModeChip.tsx/.test.tsx`, `PermissionRulesEditor.tsx/.test.tsx`,
`contextBreakdownState.ts`, `contextUsage.ts`, `planState.ts/.test.ts`,
`sdkMessageFixtures.ts`, `transcriptProjector.test.ts`; outside the renderer,
`app/main/main.ts`, `app/scripts/dev.ts`, `app/sidecar/permissionDomain.ts`,
`app/sidecar/sessionController.ts/.test.ts`. Two of these are adjacent to my own
verification work but not to any finding: I read `app/main/main.ts:639-645` for
A17-F2's sidecar-args evidence and `app/renderer/src/transcriptProjector.ts`
(clean) for A17-F1's input path. `app/main/main.ts` being dirty does not affect
the A17-F2 conclusion — the `SIDECAR_RUNTIME_ARGS` constant it consumes lives in
the clean `app/main/mainDecisions.ts:41-44`, and the decisive fact (no
`setAllowedSettingSources` caller under `app/`) is a repo-wide absence.

## Uncertainty

- **A17-F4's DOM step is not executed.** The mechanism (cleanup discards
  `unregister()`'s computed restore target) is proven by source; the step from
  "backdrop click" to "`document.activeElement === body`" rests on Chromium's
  documented focus behaviour. jsdom/happy-dom do not emulate blur-on-click of a
  non-focusable element, so a headless run would be neither confirmation nor
  refutation. The operator check is: open a session ⋮ menu, click empty space,
  press Tab.
- **A18-F6's assistive-technology behaviour is spec-derived, not tested.** ARIA 1.2
  defines `role="button"` with presentational children; what a specific screen
  reader does with a focusable descendant varies by AT and mode. The role/tabIndex
  placement is wrong regardless.
- **I did not audit whether a standalone route is planned** for `AgentsPage` /
  `MemoryPage` / `RemoteSettingsPage` (A18-F7) beyond confirming no importer and no
  backlog reservation; a `PARITY-LEDGER.md` row could still reserve one.
- **A18's own uncertainty about `session.tag` sidecar re-resolution** (whether the
  sidecar re-validates the target for a tag verb the way T6 does for account verbs)
  I did not settle — it is outside both reports' scope and does not affect the F1
  verdict, since the renderer dispatches the write either way.
