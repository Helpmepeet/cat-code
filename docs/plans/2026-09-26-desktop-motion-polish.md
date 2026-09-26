# Desktop motion polish: implementation spec

Date: 2026-09-26. Status: approved for implementation by the operator. Visual acceptance is operator-only.

Inputs, in order of authority:
1. This spec.
2. The comparison page `docs/design-html/2026-09-26-motion-audit-before-after.html`. Every item below has a demo there; the PROPOSED side is the target. Where the page and this spec disagree, this spec wins.
3. `docs/reports/2026-09-06-desktop-animation-opportunities.md` for background reasoning.

The prototype under `~/catcode_prototype` is not a reference for motion.

## Vocabulary

Defined once as custom properties on `:root` in `app/renderer/src/theme.css`, and used through static classes.

| Token | Value | Use |
|---|---|---|
| `--motion-fast` | 120ms | Colour and state changes, anchored popovers, scrim fades |
| `--motion-arrive` | 180ms | Something new arriving that the reader should notice |
| `--motion-panel` | 200ms | Side drawers |
| `--motion-value` | 400ms | A continuous value changing (gauge) |
| `--motion-land` | 900ms | Colour-only "you landed here" highlight |
| `--ease-enter` | `cubic-bezier(0.2, 0, 0, 1)` | Entrances |
| `--ease-standard` | `cubic-bezier(0.4, 0, 0.2, 1)` | In-place changes |

Existing `animate-sa-pop` (130ms), `animate-toast-in` (180ms) and `animate-token-warn-in` keep their current definitions.

## Rules

1. State is immediate. Motion never delays input, focus, keyboard navigation, dismissal, or approve/deny.
2. Prefer CSS transitions for state changes: they do not fire on mount, so remounts and reloads cost nothing.
3. A keyframe entrance plays only for something that appeared while the component, or the pane, was already mounted and live. Each chat pane remounts on every tab switch (`WorkspacePanels.tsx` keys panels by session), and a reload renders the whole transcript in one commit. An entrance keyed on mount alone is a defect.
4. No transform on transcript row wrappers or any measured root (`transcriptScrollMemory.ts`, `BoundedChildList`). Opacity and colour only there.
5. Exits stay instant, everywhere in scope.
6. Reduced motion: every new keyframe class joins the existing `animation: none` block and the pinned selector list in `codeTheme.test.ts`. Transitions of transform, size, or opacity get `transition-duration: 0s` in a second reduced-motion block; the guard test must pin that block too. Colour-only changes (including the landing highlight) may stay.
7. Static class strings only. No `style={{}}` and no interpolated arbitrary values (they silently never emit in this Tailwind setup).
8. Nothing rewrites a stored transcript row; all gating is read-time or render-time.

## Wave 0: foundation (sole owner of `theme.css` and `codeTheme.test.ts`)

- F1. Tokens above.
- F2. New classes, each with its keyframe:
  - `animate-arrive`: opacity 0 to 1, `--motion-arrive`, `--ease-enter`. Must coexist with an element that already carries `opacity-55` (no `both` fill that overrides it).
  - `animate-pop-up`: opacity 0 to 1, translateY(3px) to 0, scale 0.97 to 1, `--motion-fast`, `--ease-enter`, origin bottom. For panels that open upward.
  - `animate-drawer-in`: opacity 0 to 1, translateX(16px) to 0, `--motion-panel`, `--ease-enter`.
  - `animate-scrim-in`: opacity 0 to 1, `--motion-fast`.
  - `animate-settle`: opacity 0.6 to 1, scale 0.96 to 1, `--motion-arrive`, `--ease-enter`. It must compose with a parent that is centred by translate.
  - `animate-land`: background from accent at 10% to transparent, `--motion-land`, `--ease-standard`.
  - `animate-tab-in`: opacity 0 to 1, translateY(-3px) to 0, `--motion-arrive`, `--ease-enter`.
- F3. Both reduced-motion blocks (rule 6) and the guard test.
- F4. Compaction sweeps: `catcode-compact-sweep-left/right` animate `left`/`right`. Rewrite them with transform, keeping the parked rest state hidden under reduced motion.
- F5. A shared freshness helper in a `.ts` module (renderer TSX files export components only). At minimum: a hook that reports whether a watched value changed while the component was mounted (false on first render and after a remount), so a caller can apply an entrance class for exactly one render cycle. Lanes build any pane-level arrival tracking on top of it.

## Wave 1: three parallel lanes, disjoint files

### Lane A: transcript
Owns `TranscriptView.tsx`, `toolCardExpansion.ts`, `toolCardStyle.ts`, `transcriptViewModel.ts`, `agentIdentity.ts`, and new `.ts` modules. Page demos: Tool card run resolves, Live turn group, Tool card without a result.

- A1. Tool status dot fades between colours (`--motion-fast`, colour only) at `ToolCardShell` and `ToolRunRow` (the `STATE_STYLE` dot spans).
- A2. Result lands: when a card goes from pending to resolved while mounted, the newly shown collapsed peek, error body, or image body gets `animate-arrive`. Error auto-expansion is unchanged in layout.
- A3. Live row arrival: rows whose row id is first seen after the pane's first commit, during a live turn, and not during restore get `animate-arrive` on the row wrapper, opacity only, with no stagger (a burst fades as one). A grouped item takes its first member's arrival time, so a lone card turning into a run keeps its fade. Never key freshness on the display key. Excluded: streaming answer rows, load-earlier inserts, the history boundary.
- A4. A new reasoning step inside an existing block gets `animate-arrive`; the head stays instant.
- A5. A pending tool card or agent face pulses only while its session's turn is live. A tool call with no result in a finished transcript shows a still dot. If turn liveness is not reachable from inside the transcript without editing `SessionPane.tsx`, stop and report instead of editing it.
- A6. Full-output inspector (`ToolInspectorOverlay`): scrim `animate-scrim-in`, panel `animate-drawer-in`. The blur does not tween.

### Lane B: composer and dock
Owns `SessionPane.tsx`, `PermissionPrompt.tsx`, `PermissionQueue.tsx`, `ComposerActionsBar.tsx`, `PermissionModeChip.tsx`, `ContextGauge.tsx`, `SlashCommandPicker.tsx`, `MentionPicker.tsx`, `PlanPanel.tsx`. Page demos: Slash picker, Context warning glyph, Permission card (both), Composer popover, Latest button, Context gauge.

- B1. Slash and mention picker rows: the keyboard-cursor highlight changes instantly. Hover can keep its fade.
- B2. The context-warning glyph pops only when the warning newly appears while the pane is mounted, never on a tab switch.
- B3. A permission or question card that arrives while the pane is mounted gets `animate-toast-in`. A restored or remounted card does not.
- B4. After approve or deny, the card dims to 55% opacity (`--motion-fast`) until it resolves. It returns to full if the submission fails.
- B5. Composer popovers that open upward (model/effort, account, context, token warning, permission mode) get `animate-pop-up`. Closing stays instant, and focus return order is unchanged.
- B6. Context gauge: arc length and tone colour transition over `--motion-value`.
- B7. Latest button: colour transition (`--motion-arrive`) between running, waiting, and idle. When the run ends while the reader is scrolled up, the label gets `animate-settle` once. Make `jumpToBottom` scroll explicitly instant, which matches today's effective behaviour.
- B8. Plan dialog: scrim `animate-scrim-in`, card `animate-sa-pop`; approve menu `animate-sa-pop`. Remove the no-op `transition-transform` on the approve chevron.

### Lane C: shell
Owns `TabBar.tsx`, `CommandPalette.tsx`, `MetadataInspector.tsx`, `AgentsPage.tsx`, `SettingsShell.tsx`, `SettingsField.tsx`. Page demos: Tab close button, Opening a session with many tabs, Command palette, Right drawer, Settings search.

- C1. Tab close button: `transition-all` becomes a transition of opacity, background, and colour only. Width snaps.
- C2. A tab that becomes active is scrolled into view (`inline: 'nearest'`; smooth, or instant under reduced motion). This is a bug fix: today a new tab can open off-screen. A tab added after the initial roster hydration gets `animate-tab-in`. Startup and hydration animate nothing.
- C3. Command palette: scrim `animate-scrim-in`, card `animate-sa-pop`.
- C4. `MetadataInspector` and the `AgentsPage` drawer: `animate-toast-in` becomes `animate-drawer-in`.
- C5. Settings search: when a result is opened, the destination `[data-setting-key]` row gets `animate-land` once. Scroll stays instant.

## Wave 2: after wave 1 lands

- P. Streaming prose arrival (`AssistantProse` in `TranscriptView.tsx`, `proseArrivalMark.ts`). Two suspected defects:
  - Each word's fade is cut off by the next commit, because a word is marked for exactly one commit and keyless children are reused by index.
  - A remount mid-answer replays the fade over the whole answer (`renderedLengthRef` starts at 0).

  Measure the real commit rate first. The operator should see it live before the fix is judged. Page demo: Streaming prose.
- S. Sidebar reveal: render at final width and reveal with clip-path, instead of animating `width` under a blur. Start only after the in-flight `Sidebar.tsx` work from another session is committed. Page demo: Sidebar expand.

## Not in scope

- Operator decisions pending: the working line's 30px jump at turn start and end, and the Tasks pill pulse ("Decide" group on the page).
- Deferred: queued-message colour settle, worker roster lead fade, menu entrances on the Sessions, Accounts, and Welcome pages, flip-aware `sa-pop`, banners, toast exit, bulk bar, question step advance, snoozed strip, Stop pending state, usage bars, sidebar pin highlight, appearance-switch transition suppression.
- Non-motion findings, to be filed separately: "Thinking" never shows during silent reasoning; the working-line verb churns between tools within about 300ms.

## Verification (every lane)

- `bun test app/`, `bun run --cwd app typecheck`, `bun run --cwd app typecheck:sidecar`, `bun run --cwd app renderer:build`.
- Discriminating tests through the DOM harness (`createDomTestHarness()`). An entrance class is present for a fresh arrival and absent on first mount, on remount, and on a replayed or reloaded transcript. Each test must fail with the gate removed.
- No Electron launch and no dev app driving. Leave operator acceptance steps that name the matching page demo.
