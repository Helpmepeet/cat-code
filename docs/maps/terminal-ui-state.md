# Terminal UI And State Routing Map

Last refreshed: 2026-09-06

Purpose: route terminal UI work to the right owners. Keep this focused on
where behavior lives, not on full call-by-call walkthroughs.

## First Files To Inspect

1. `src/screens/REPL.tsx` for terminal session assembly and query ownership.
2. `src/utils/handlePromptSubmit.ts` and `src/utils/immediateCommand.ts` for submission and command dispatch.
3. `src/commands/continue-after-limit/continue-after-limit.tsx` and `src/services/deferredContinuationRunner.ts` for deferred continuation UX and execution.
4. `src/utils/sessionRestore.ts` and `src/utils/sessionStorage.ts` for resume/adoption and transcript persistence.
5. `src/components/PromptInput/` and `src/hooks/useCommandQueue.ts` for input-shell behavior.
6. `src/state/AppStateStore.ts` and `src/state/selectors.ts` for shared state and active-agent input routing.

Use `docs/maps/tasks-workers.md` for task lifecycle details and
`docs/maps/tools-permissions.md` for approval and permission routing.

## Routing Table

| Area | Inspect first | Then inspect | Routing notes |
|---|---|---|---|
| REPL session loop | `src/screens/REPL.tsx` | `src/replLauncher.tsx`, `src/main.tsx` | `REPL.tsx` owns the main screen assembly, local session state, query lifecycle, displayed transcript selection, and modal priority. |
| Startup splash / logo | `src/components/LogoV2/LogoV2.tsx` | `src/components/LogoV2/AccountsPanel.tsx`, `src/components/LogoV2/LogoV2.test.tsx` | Startup header and account-status rendering lives under `LogoV2/`; REPL decides when the logo shows. |
| Shared terminal/app state | `src/state/AppStateStore.ts` | `src/state/AppState.tsx`, `src/state/store.ts`, `src/state/onChangeAppState.ts` | Shared state shape lives in `AppStateStore.ts`; selector subscriptions and store access live in `AppState.tsx`. |
| Derived routing for viewed agents | `src/state/selectors.ts` | `src/state/teammateViewHelpers.ts`, `src/screens/REPL.tsx` | `getActiveAgentForInput()` decides whether input targets the leader, a viewed teammate, or a named local agent. |
| Query and prompt submission | `src/screens/REPL.tsx` | `src/utils/handlePromptSubmit.ts`, `src/utils/immediateCommand.ts`, `src/query.ts`, `src/utils/processUserInput/` | `REPL.tsx` handles immediate command paths, queue handoff, history/paste preparation, runtime-model prompt selection, and main-thread query start. Immediate local-JSX commands have an owner-scoped slot, re-check availability at dispatch, and repin the transcript when their panel opens or closes. |
| Durable goal continuation | `src/utils/threadGoalScheduler.ts` | `src/utils/{threadGoal,threadGoalAttempt,threadGoalEvidence,threadGoalWorkspace}.ts`, `src/screens/REPL.tsx`, `src/commands/goal/goal.tsx` | The scheduler is the sole continuation decision point: it charges completed attempts, requires criterion-linked evidence before completion, stops repetition, and starts the next turn. REPL provides the interactive runtime adapter; keep it aligned with the headless and app-runtime adapters rather than recreating goal-loop policy locally. |
| Continue after a confirmed Codex limit | `src/commands/continue-after-limit/continue-after-limit.tsx` | `src/services/deferredContinuationPresentation.ts`, `src/hooks/useDeferredContinuation.ts`, `src/services/deferredContinuationRunner.ts`, `src/screens/REPL.tsx`, `src/utils/handlePromptSubmit.ts`, `src/utils/sessionRestore.ts` | The command owns schedule/status/cancel/background UX. The hook only wakes due work; the runner owns the fsync-backed queue, locks, and result policy. Only model-turn human input cancels a pending job; a resume probes the per-session lock without canceling it, while an owned attempt blocks the resume. Unreadable pending records fail closed but `cancel` can discard one under that session lock. |
| Codex reasoning display | `src/utils/reasoningDisplay.ts` | `src/utils/messages.ts`, `src/components/Messages.tsx`, `src/components/Message.tsx` | Normalization preserves provider raw-reasoning availability across a turn. The display setting selects summary, raw, or neither; raw blocks without content remain hidden, and the message list selects the latest visible thinking block. |
| Prompt input shell | `src/components/PromptInput/PromptInput.tsx` | `src/components/PromptInput/PromptInputFooter.tsx`, `src/components/PromptInput/`, `src/hooks/useCommandQueue.ts`, `src/state/selectors.ts` | Owns prompt composition, footer pills, stash/queued-command UX, history-search entry, and submit routing to leader or viewed agent. |
| Footer notifications and transient task notices | `src/components/PromptInput/Notifications.tsx` | `src/components/tasks/taskStatusUtils.tsx`, `src/tasks/LocalAgentTask/LocalAgentTask.tsx`, `src/state/AppStateStore.ts` | Notifications now surface terminal local-agent outcomes when you are not viewing that agent, including blocked handoffs and verification verdicts. |
| Status line, model picker, and footer status | `src/components/StatusLine.tsx` | `src/components/ModelPicker.tsx`, `src/utils/model/{model,modelOptions}.ts`, `src/state/AppStateStore.ts`, `src/tools/AgentTool/built-in/statuslineSetup.ts`, `src/services/tools/ptcloveToolStatus.ts` | Status line composes per-turn state, connection/runtime status, current-model/tool affordances, and fast-mode state. The picker normalizes aliases before deciding whether a persisted custom model already has a canonical option, so it does not render duplicate model rows. Agent Tool can install per-worker statusline behavior; ptclove tool tracking updates `ptcloveCurrentTool` for UI/bridge. |
| Plain text editing | `src/hooks/useTextInput.ts` | `src/components/TextInput.tsx`, `src/components/PromptInput/inputModes.ts` | Readline-like editing lives here: cursor movement, multiline submit behavior, kill/yank, double-Esc clear, Ctrl+C/D exit handling. |
| Vim editing | `src/hooks/useVimInput.ts` | `src/vim/transitions.ts`, `src/vim/operators.ts`, `src/vim/motions.ts`, `src/vim/textObjects.ts` | `useVimInput.ts` wraps base text editing and owns INSERT/NORMAL transitions and replay; `src/vim/` owns the command engine. |
| Message rendering and origin attribution | `src/components/Messages.tsx` | `src/components/{MessageSelector,MessageRow,Message}.tsx`, `src/components/messages/{UserPeerMessage,UserTextMessage}.tsx`, `src/utils/{messages,messages/mappers,messages/origins}.ts`, `src/types/message.ts` | `Messages.tsx` owns normalization, grouping, virtualization, brief-mode filtering, streaming adornments, and transcript search plumbing. The closed message-origin union keeps peer input distinct from operator text through transcript selection, compaction, SDK projection, and rendering; peer creation prompts are session instructions, while later peer input is explicitly non-user input. |
| Terminal Markdown and link rendering | `src/utils/markdown.ts` | `src/utils/hyperlink.ts`, `src/ink/supports-hyperlinks.ts`, `src/utils/markdown.test.ts` | Markdown formatting owns OSC 8 links in terminal output. Absolute filesystem targets are converted to `file:` URLs before emission; relative and web targets retain their supplied hrefs. |
| Transcript/fullscreen layout | `src/components/FullscreenLayout.tsx` | `src/components/VirtualMessageList.tsx`, `src/components/ScrollKeybindingHandler.tsx`, `src/ink/components/ScrollBox.tsx` | Fullscreen layout owns sticky prompt state, unseen-message divider/pill, modal slot, prompt overlay portal, and scroll anchoring. |
| Ink renderer and input dispatch | `src/ink/ink.tsx` | `src/ink/components/App.tsx`, `src/ink/hooks/use-input.ts` | Ink runtime owns rendering, selection, search highlight, alt-screen behavior, and stdin event dispatch. `use-input.ts` preserves handler order. |
| Keybinding system | `src/keybindings/defaultBindings.ts` | `src/keybindings/resolver.ts`, `src/keybindings/parser.ts`, `src/keybindings/match.ts`, `src/keybindings/useKeybinding.ts` | Defaults, parsing, context resolution, and action dispatch live here; matched bindings stop propagation through Ink input listeners. |
| User keybinding validation | `src/keybindings/validate.ts` | `src/keybindings/loadUserBindings.ts`, `src/keybindings/reservedShortcuts.ts` | Validation owns parse errors, reserved shortcuts, context checks, and command-binding restrictions. |
| REPL/global shortcut behavior | `src/hooks/useGlobalKeybindings.tsx` | `src/hooks/useCommandKeybindings.tsx`, `src/hooks/useCancelRequest.ts`, `src/hooks/useBackgroundTaskNavigation.ts` | Hooks map resolved actions into REPL behavior: transcript toggles, slash-command launch, cancel/interrupt, and teammate/task navigation. |
| Dialog and overlay focus | `src/utils/tuiSessionStatus.ts` | `src/screens/REPL.tsx`, `src/components/design-system/Dialog.tsx`, `src/context/overlayContext.tsx`, `src/context/promptOverlayContext.tsx` | `deriveFocusedInputDialog()` owns the `FocusedInputDialog` type and the priority order for blocking UI: message selector, permissions, prompts, cost/idle dialogs, onboarding, and callouts. `REPL.tsx` only assembles the facts and calls it, including the second call that reveals the dialog typing is hiding. |
| Live session status (busy/waiting/idle) | `src/utils/tuiSessionStatus.ts` | `src/screens/REPL.tsx`, `src/ink/hooks/use-tab-status.ts`, `src/services/preventSleep.ts`, `src/utils/concurrentSessions.ts` | `deriveTuiSessionStatus()` is the only `waiting > busy > idle` implementation; `deriveHasOperationalWork()` is the separate sleep-prevention primitive. Delegated task classification is `deriveDelegatedTaskStatus()`. REPL derives all of it below `focusedInputDialog` and feeds title animation, `caffeinate`, goal continuation, OSC, and the feature-gated `claude ps` record from primitives. |
| Resume picker presentation | `src/screens/ResumeConversation.tsx` | `src/utils/sessionStorage.ts`, `src/components/LogSelector.tsx`, `src/types/logs.ts`, `src/screens/REPL.tsx` | The picker sorts enriched logs and displays session title/prompt/time. Session storage owns progressive enrichment and timestamp/name fallback data; REPL re-appends current metadata before opening the picker. |
| Prompt/message/task local JSX | `src/screens/REPL.tsx` | `src/utils/immediateCommand.ts`, `src/components/PromptInput/PromptInputQueuedCommands.tsx`, `src/components/TaskListV2.tsx`, slash-command implementations | REPL controls whether local JSX renders inline, in the fullscreen modal slot, or while hiding prompt input. It restores the live viewport across local-panel visibility changes so a completed response is not left off-screen. |
| Theme and design system | `src/utils/theme.ts` | `src/components/design-system/ThemeProvider.tsx`, `src/components/design-system/`, `src/components/ThemePicker.tsx` | Concrete palette tokens live in `theme.ts`; themed primitives and dialogs live under `design-system/`. |

## Important Owner Splits

- `src/screens/REPL.tsx` is the orchestrator, not the place to redefine shared
  state shape. Check `src/state/AppStateStore.ts` first for shared fields.
- `src/state/AppState.tsx` expects stable selector slices. Do not return new
  objects from `useAppState(...)` selectors.
- `src/components/StatusLine.tsx` and
  `src/tools/AgentTool/built-in/statuslineSetup.ts` share a contract. If you
  change status-line JSON fields such as `fast_mode_state`, update both the UI
  producer and the statusline command instructions together.
- `messagesRef` in `REPL.tsx` is the synchronous source of truth during
  streaming and queue processing; React state alone is not the whole story.
- Prompt editing behavior is split on purpose:
  - `useTextInput.ts` for generic terminal editing
  - `useVimInput.ts` plus `src/vim/` for vim semantics
  - `PromptInput.tsx` for prompt-specific shell, pills, suggestions, and submit
    routing
- Fullscreen transcript behavior is split on purpose:
  - `Messages.tsx` decides what renders
  - `VirtualMessageList.tsx` handles transcript virtualization
  - `FullscreenLayout.tsx` owns sticky prompt, unseen pill, modal placement,
    and prompt overlay positioning
- Key ownership is layered:
  - Ink `use-input.ts` preserves listener order
  - `keybindings/` resolves configured shortcuts
  - REPL hooks such as `useCancelRequest.ts` and
    `useBackgroundTaskNavigation.ts` turn actions into behavior
  - Some text-level Escape behavior remains intentionally outside configurable
    keybindings in `useTextInput.ts` and `useVimInput.ts`

## Dialog And Overlay Priority

For blocking UI, inspect `deriveFocusedInputDialog()` in
`src/utils/tuiSessionStatus.ts` before changing any individual dialog. That
function decides when prompt typing suppresses dialogs and the order among:

- message selector
- sandbox/tool/worker permissions
- prompt queue and MCP elicitation
- cost and idle-return dialogs
- paused-goal resume prompt
- onboarding and callout surfaces
- ultraplan dialogs

Two rules keep this from drifting again:

- There is one `FocusedInputDialog` type and one priority function. `REPL.tsx`
  supplies facts; it must not rank queues itself. When typing suppresses
  dialogs, REPL re-calls the same selector with `suppressInterruptDialogs`
  flipped rather than keeping a second list.
- Every dialog member makes an explicit waiting/non-waiting choice in
  `WAITING_REASON_BY_DIALOG`. Voluntary navigation, callouts, recommendations,
  and the upsell own keyboard focus without the session waiting on anyone, so
  they map to no reason. A new member fails to compile until it decides.

`init-onboarding` was removed from the union in 2026-08: it had no producer and
no render branch.

## Tests And Validation

Use focused checks first:

| Area | Check |
|---|---|
| Docs-only sanity | `git diff --check -- docs/maps/terminal-ui-state.md` |
| Immediate command dispatch | `bun test src/utils/immediateCommand.test.ts src/commands/usage/usage.test.tsx` |
| Map path sanity | `rg -n "\\[[^]]+\\]\\(([^)#]+)" docs/maps/terminal-ui-state.md` |
| Ink rendering core | `bun test src/ink/output.test.ts` |
| Query/message-adjacent behavior | `bun test src/query.test.ts src/utils/providerPromptRegressions.test.ts` |
| Terminal Markdown link targets | `bun test src/utils/markdown.test.ts` |
| Task/view switching adjacency | `bun test src/tasks/LocalAgentTask/LocalAgentTask.test.ts src/tasks/RemoteAgentTask/RemoteAgentTask.test.ts` |
| Goal scheduler and runtime adapters | `bun test src/commands/goal/goal.test.ts src/utils/threadGoalScheduler.test.ts src/screens/REPL.goalScheduler.test.ts src/cli/headlessGoalLoop.test.ts src/app-runtime/attachThreadGoalScheduler.test.ts` |
| Dialog priority and session status | `bun test src/utils/tuiSessionStatus.test.ts` |
| Deferred continuation command, notices, runner, and foreground/background races | `bun test src/commands/continue-after-limit/continue-after-limit.test.ts src/services/deferredContinuationRunner.test.ts src/services/deferredContinuation.test.ts src/services/deferredContinuation.probe.test.ts` |
| Full documented build | `bun run build:dev:full` |

Component-level TUI coverage is sparse. For terminal UI changes, source
inspection and manual REPL verification are still normal.

## Traps And Stale Assumptions

- Do not change shared state from `REPL.tsx` without checking
  `src/state/AppStateStore.ts`.
- Do not add a second dialog priority list or a second `waiting > busy > idle`
  derivation. Both live in `src/utils/tuiSessionStatus.ts`; a local copy is how
  the exported status and the visible dialog disagreed before.
- Do not treat "a dialog is focused" as "the session is waiting". Only the
  members that map to a reason in `WAITING_REASON_BY_DIALOG` block; a callout
  or the message selector owns focus while the session waits on nobody. And a
  focused non-blocking dialog must not mask a worker or sandbox request, which
  renders outside the dialog switch and is therefore on screen beside it.
- Do not assume an unrenderable queue is an inactive one. When a tool owns the
  frame without `shouldContinueAnimation`, no dialog below the local sandbox
  prompt can render, so a queued approval is invisible and still blocking;
  `deriveLocalWaitingReason` re-checks the tool and prompt queues directly in
  that state.
- Do not make an effect depend on a freshly allocated derivation result.
  `deriveDelegatedTaskStatus()` returns an object; REPL destructures it into
  primitives before any dependency array sees it.
- Do not assume leader messages are what the user is seeing; viewed-agent mode
  swaps transcript ownership.
- Do not add raw `useInput` handlers without checking listener ordering and key
  propagation.
- Do not move Escape/Ctrl+C behavior in only one layer; text input, vim,
  dialogs, transcript mode, and cancel handling each have special cases.
- Do not bypass `FullscreenLayout.tsx` when changing fullscreen transcript
  behavior; sticky prompt, unseen pill, modal placement, and prompt overlay
  positioning are coupled there.
