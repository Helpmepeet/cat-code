# Terminal UI And State Routing Map

Last refreshed: 2026-07-01

Purpose: route terminal UI work to the right owners. Keep this focused on
where behavior lives, not on full call-by-call walkthroughs.

## Start Here

1. `docs/maps/WORKSPACE_MAP.md`
2. `src/screens/REPL.tsx`
3. The focused owner surface for the area you are changing below

Use `docs/maps/tasks-workers.md` for task lifecycle details and
`docs/maps/tools-permissions.md` for approval and permission routing.

## Routing Table

| Area | Inspect first | Then inspect | Routing notes |
|---|---|---|---|
| REPL session loop | `src/screens/REPL.tsx` | `src/replLauncher.tsx`, `src/main.tsx` | `REPL.tsx` owns the main screen assembly, local session state, query lifecycle, displayed transcript selection, and modal priority. |
| Startup splash / logo | `src/components/LogoV2/LogoV2.tsx` | `src/components/LogoV2/AccountsPanel.tsx`, `src/components/LogoV2/LogoV2.test.tsx` | Startup header and account-status rendering lives under `LogoV2/`; REPL decides when the logo shows. |
| Shared terminal/app state | `src/state/AppStateStore.ts` | `src/state/AppState.tsx`, `src/state/store.ts`, `src/state/onChangeAppState.ts` | Shared state shape lives in `AppStateStore.ts`; selector subscriptions and store access live in `AppState.tsx`. |
| Derived routing for viewed agents | `src/state/selectors.ts` | `src/state/teammateViewHelpers.ts`, `src/screens/REPL.tsx` | `getActiveAgentForInput()` decides whether input targets the leader, a viewed teammate, or a named local agent. |
| Query and prompt submission | `src/screens/REPL.tsx` | `src/utils/handlePromptSubmit.ts`, `src/query.ts`, `src/utils/processUserInput/` | `REPL.tsx` handles immediate command paths, queue handoff, history/paste preparation, and main-thread query start. |
| Prompt input shell | `src/components/PromptInput/PromptInput.tsx` | `src/components/PromptInput/PromptInputFooter.tsx`, `src/components/PromptInput/`, `src/hooks/useCommandQueue.ts`, `src/state/selectors.ts` | Owns prompt composition, footer pills, stash/queued-command UX, history-search entry, and submit routing to leader or viewed agent. |
| Footer notifications and transient task notices | `src/components/PromptInput/Notifications.tsx` | `src/components/tasks/taskStatusUtils.tsx`, `src/tasks/LocalAgentTask/LocalAgentTask.tsx`, `src/state/AppStateStore.ts` | Notifications now surface terminal local-agent outcomes when you are not viewing that agent, including blocked handoffs and verification verdicts. |
| Status line, model picker, and footer status | `src/components/StatusLine.tsx` | `src/components/ModelPicker.tsx`, `src/state/AppStateStore.ts`, `src/tools/AgentTool/built-in/statuslineSetup.ts`, `src/services/tools/ptcloveToolStatus.ts` | Status line composes per-turn state, connection/runtime status, current-model/tool affordances, and fast-mode state. Agent Tool can install per-worker statusline behavior; ptclove tool tracking updates `ptcloveCurrentTool` for UI/bridge. |
| Plain text editing | `src/hooks/useTextInput.ts` | `src/components/TextInput.tsx`, `src/components/PromptInput/inputModes.ts` | Readline-like editing lives here: cursor movement, multiline submit behavior, kill/yank, double-Esc clear, Ctrl+C/D exit handling. |
| Vim editing | `src/hooks/useVimInput.ts` | `src/vim/transitions.ts`, `src/vim/operators.ts`, `src/vim/motions.ts`, `src/vim/textObjects.ts` | `useVimInput.ts` wraps base text editing and owns INSERT/NORMAL transitions and replay; `src/vim/` owns the command engine. |
| Message rendering | `src/components/Messages.tsx` | `src/components/MessageRow.tsx`, `src/components/Message.tsx`, `src/components/messages/` | `Messages.tsx` owns normalization, grouping, virtualization, brief-mode filtering, streaming adornments, and transcript search plumbing. |
| Transcript/fullscreen layout | `src/components/FullscreenLayout.tsx` | `src/components/VirtualMessageList.tsx`, `src/components/ScrollKeybindingHandler.tsx`, `src/ink/components/ScrollBox.tsx` | Fullscreen layout owns sticky prompt state, unseen-message divider/pill, modal slot, prompt overlay portal, and scroll anchoring. |
| Ink renderer and input dispatch | `src/ink/ink.tsx` | `src/ink/components/App.tsx`, `src/ink/hooks/use-input.ts` | Ink runtime owns rendering, selection, search highlight, alt-screen behavior, and stdin event dispatch. `use-input.ts` preserves handler order. |
| Keybinding system | `src/keybindings/defaultBindings.ts` | `src/keybindings/resolver.ts`, `src/keybindings/parser.ts`, `src/keybindings/match.ts`, `src/keybindings/useKeybinding.ts` | Defaults, parsing, context resolution, and action dispatch live here; matched bindings stop propagation through Ink input listeners. |
| User keybinding validation | `src/keybindings/validate.ts` | `src/keybindings/loadUserBindings.ts`, `src/keybindings/reservedShortcuts.ts` | Validation owns parse errors, reserved shortcuts, context checks, and command-binding restrictions. |
| REPL/global shortcut behavior | `src/hooks/useGlobalKeybindings.tsx` | `src/hooks/useCommandKeybindings.tsx`, `src/hooks/useCancelRequest.ts`, `src/hooks/useBackgroundTaskNavigation.ts` | Hooks map resolved actions into REPL behavior: transcript toggles, slash-command launch, cancel/interrupt, and teammate/task navigation. |
| Dialog and overlay focus | `src/screens/REPL.tsx` | `src/components/design-system/Dialog.tsx`, `src/context/overlayContext.tsx`, `src/context/promptOverlayContext.tsx` | `getFocusedInputDialog()` in `REPL.tsx` is the priority owner for blocking UI such as message selector, permissions, prompts, cost/idle dialogs, onboarding, and callouts. |
| Resume picker presentation | `src/screens/ResumeConversation.tsx` | `src/utils/sessionStorage.ts`, `src/components/LogSelector.tsx`, `src/types/logs.ts`, `src/screens/REPL.tsx` | The picker sorts enriched logs and displays session title/prompt/time. Session storage owns progressive enrichment and timestamp/name fallback data; REPL re-appends current metadata before opening the picker. |
| Prompt/message/task local JSX | `src/screens/REPL.tsx` | `src/components/PromptInput/PromptInputQueuedCommands.tsx`, `src/components/TaskListV2.tsx`, slash-command implementations | REPL controls whether local JSX renders inline, in the fullscreen modal slot, or while hiding prompt input. |
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

For blocking UI, inspect `getFocusedInputDialog()` in `src/screens/REPL.tsx`
before changing any individual dialog. That function decides when prompt typing
suppresses dialogs and the order among:

- message selector
- sandbox/tool/worker permissions
- prompt queue and MCP elicitation
- cost and idle-return dialogs
- paused-goal resume prompt
- onboarding and callout surfaces
- ultraplan dialogs

## Validation And Tests

Use focused checks first:

| Area | Check |
|---|---|
| Docs-only sanity | `git diff --check -- docs/maps/terminal-ui-state.md` |
| Map path sanity | `rg -n "\\[[^]]+\\]\\(([^)#]+)" docs/maps/terminal-ui-state.md` |
| Ink rendering core | `bun test src/ink/output.test.ts` |
| Query/message-adjacent behavior | `bun test src/query.test.ts src/utils/providerPromptRegressions.test.ts` |
| Task/view switching adjacency | `bun test src/tasks/LocalAgentTask/LocalAgentTask.test.ts src/tasks/RemoteAgentTask/RemoteAgentTask.test.ts` |
| Goal/dialog local JSX adjacency | `bun test src/commands/goal/goal.test.ts` |
| Full documented build | `bun run build:dev:full` |

Component-level TUI coverage is sparse. For terminal UI changes, source
inspection and manual REPL verification are still normal.

## Common Footguns

- Do not change shared state from `REPL.tsx` without checking
  `src/state/AppStateStore.ts`.
- Do not assume leader messages are what the user is seeing; viewed-agent mode
  swaps transcript ownership.
- Do not add raw `useInput` handlers without checking listener ordering and key
  propagation.
- Do not move Escape/Ctrl+C behavior in only one layer; text input, vim,
  dialogs, transcript mode, and cancel handling each have special cases.
- Do not bypass `FullscreenLayout.tsx` when changing fullscreen transcript
  behavior; sticky prompt, unseen pill, modal placement, and prompt overlay
  positioning are coupled there.
