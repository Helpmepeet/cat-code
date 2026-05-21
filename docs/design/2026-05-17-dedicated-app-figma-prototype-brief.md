# Dedicated App Figma Prototype Brief

**Status:** Design handoff
**Created:** 2026-05-17
**Audience:** Product design, UX design, UI design, and prototype reviewers

## Purpose

This brief translates the dedicated app migration inventory into a Figma-ready
prototype scope. It is intentionally focused on screens, workflows, interaction
states, and design acceptance criteria.

This is not an engineering API contract. Runtime details remain in
`docs/design/2026-05-17-dedicated-app-ui-requirements.md`.

## Source Documents

- `docs/design/2026-05-17-dedicated-app-ui-requirements.md`: ground-truth
  feature inventory and MVP/parity scope.
- `docs/design/2026-05-17-dedicated-app-ux-reinterpretation-rules.md`: rules
  for converting terminal patterns into app-native UX. Read this first; the
  requirements inventory tells you *what* to support, this doc tells you *how*
  to redesign the interaction model while preserving behavior.
- `docs/design/2026-05-03-dedicated-app-prototype-brief.md`: older visual
  reference from the existing prototype; use for direction, not feature parity.
- `docs/design/2026-05-17-dedicated-app-figma-screen-inventory.md`: required
  screen list and per-screen state expectations.
- `docs/design/2026-05-17-dedicated-app-figma-user-flows.md`: clickable
  prototype flows and interaction-state checklist.

## Prototype Goal

Design a dedicated Cat Code app experience that lets a user run normal agent
work without relying on the terminal UI. The prototype should make live chat,
tool activity, permissions, session state, model/account context, goals, and
background work visible in one coherent workspace.

The target experience is a dense local agent workspace, not a marketing site,
landing page, or terminal transcript embedded in a browser. The dedicated app
must preserve terminal behavior (safety, goal semantics, persistence, tool
meaning, auth, agent/task lifecycle, MCP/plugin/skill behavior, reconnect and
blocking states) while redesigning the interaction model. See
`docs/design/2026-05-17-dedicated-app-ux-reinterpretation-rules.md` for the
preserve-vs-redesign split and the terminal-to-app pattern mapping.

## Target Users

- Primary: power users who currently use the terminal UI for coding-agent work.
- Secondary: users who need better visibility into sessions, tools, permissions,
  accounts, and background agents than a terminal can comfortably provide.
- Internal reviewers: engineers who need to validate that the design can map to
  current Cat Code runtime behavior.

## Design Principles

- Prioritize active work. The first useful screen after trust/auth should be
  the workspace, not onboarding content.
- Keep the interface compact, scannable, and operational. Avoid oversized hero
  composition, decorative cards, and sparse marketing layouts.
- Show status near the point of action: model, account, goal, context, task,
  connection, and permission state should be visible where decisions happen.
- Treat tools as first-class work artifacts. Tool calls, outputs, diffs, errors,
  and permission decisions must be inspectable without losing chat context.
- Make long-running work navigable. Tasks and agents should be visible while the
  user continues chatting.
- Design for recovery. Disconnected, blocked, denied, paused, failed, and
  budget-limited states need explicit UI, not hidden text-only messages.
- Preserve terminal fallback semantics. The app prototype should not imply that
  every parity feature is required in the first MVP.
- Redesign the interaction model, do not clone it. Slash commands become
  visible controls, menus, pages, or palette entries. Modal Ink dialogs
  become app dialogs, drawers, or pages. Hidden status becomes persistent
  chips and banners. See the terminal-to-app mapping in
  `docs/design/2026-05-17-dedicated-app-ux-reinterpretation-rules.md`.

## MVP Prototype Scope

The MVP Figma prototype must cover these clickable areas:

1. First launch trust/auth gate.
2. Main workspace with sidebar, session list, active chat, prompt composer, and
   runtime status.
3. Streaming chat response with inspectable tool cards and jump-to-latest
   behavior.
4. Permission request dialog with allow once, deny, and always allow where
   supported.
5. Command palette as an accelerator for actions and session switching. Every
   MVP action must also be reachable from a visible control, menu, or page —
   the palette is not the primary entry point for any MVP capability.
6. Active goal status near the composer plus a goal detail panel with create,
   replace, pause, resume, and clear controls. Completion is shown as
   runtime/model evidence, not a user toggle.
7. Tasks and Agents pages with running/completed lists, inspect, and stop
   actions, plus in-chat indicators for active work.
8. Session sidebar/browser with new and resume actions for same-project
   sessions, including a cross-project warning before opening incompatible
   context.
9. Composer-adjacent controls for model, provider, effort, fast mode, and
   thinking.
10. Accounts page or menu with login, logout, switch, and visible auth state.
11. Status and notification surfaces as persistent chips, banners, and toasts
    for auth, rate limits, settings errors, active turn, reconnect, paused
    goal, budget-limited goal, and blocked send state.

## Parity Prototype Scope

Parity frames can be lower fidelity unless explicitly needed for review. Include
enough structure to show navigation and UI ownership for:

- Full palette/menu/page coverage of remaining commands. Parity does not mean
  surfacing every command as a slash-command row; it means every user-facing
  capability has an app-native home.
- Full session management: rename, tag, branch, rewind, search, export, and copy.
- Full Agent Mode worker roster and worker control as a live page.
- Complete task details for shell, local agent, remote agent, dream, workflow,
  monitor, and teammate work, in the Tasks/Agents pages and detail views.
- Settings pages for permissions, MCP, plugins, skills, hooks, privacy,
  keybindings, output style, language, and managed settings — organized by user
  intent, not by terminal command names.
- MCP form and URL elicitation as app dialogs anchored to the requesting
  session.
- IDE/LSP connection and diagnostics.
- Usage, cost, stats, doctor/status, and diagnostics pages.
- Remote/server reconnect and viewer/control modes.

## Non-Goals

- Do not design a landing page as the primary experience.
- Do not invent runtime behavior that is not in the migration inventory.
- Do not make completion of a goal a simple user button. The design may show
  completion state and runtime/model completion results, but completion has
  evidence and worker checks behind it.
- Do not clone the terminal UI. The current terminal UI defines capability and
  safety, not interaction design. Do not reproduce slash-command-first input,
  stacked Ink dialogs, scrollback-only status, or keyboard-chord-only
  navigation.
- Do not make every terminal command a first-screen control. Promote MVP
  actions to visible controls; parity-only commands live in palette, menus, or
  settings, not on the chat surface.
- Do not change preserved semantics (permissions, goal evidence, persistence,
  tool meaning, auth, agent/task lifecycle, MCP/plugin/skill behavior,
  reconnect/blocking rules). If a design idea would change these, escalate to
  engineering instead of putting it in the prototype.
- Do not design mobile/tablet as MVP unless the product scope changes.

## Figma Deliverables

The design team should deliver:

- Desktop MVP prototype at 1440x900.
- Narrow desktop prototype at 1024x768 for layout stress.
- Component set with variants for buttons, icon buttons, tabs, side navigation,
  command rows, message blocks, tool cards, permission dialogs, task rows,
  status chips, input states, and banners/toasts.
- Clickable prototype paths for each MVP flow in
  `docs/design/2026-05-17-dedicated-app-figma-user-flows.md`.
- Screen coverage matching
  `docs/design/2026-05-17-dedicated-app-figma-screen-inventory.md`.
- State annotations for loading, empty, streaming, blocked, denied, failed,
  paused, completed, disconnected, and reconnecting states.
- Design notes for anything intentionally deferred to parity or future scope.

## Visual Direction

Use the May 3 prototype as directional reference, but tighten it for production
review:

- Dark operational workspace with restrained contrast and clear hierarchy.
- Compact side navigation and session list.
- Tool output and code areas in a readable monospace treatment.
- Status colors reserved for actual state: success, warning, danger, active,
  disabled, and pending.
- Small, stable controls for high-frequency actions.
- Dialogs and drawers for decisions that interrupt active work.
- Avoid decorative gradients, oversized rounded cards, and brand-first hero
  treatments.

## Content Guidelines

- Navigation labels should be short and literal: Chat, Sessions, Goals, Tasks,
  Agents, Accounts, Settings.
- Permission copy must explain the action, target, and consequence before the
  user chooses.
- Empty states should offer direct actions, not product education.
- Error states should say what happened, what is blocked, and what action is
  available.
- Goal language should distinguish user controls from runtime completion.
- Background work labels should make task type and current state obvious.

## Review Checklist

A Figma prototype is acceptable for MVP review when:

- A reviewer can start at first launch and reach the active workspace.
- A reviewer can send a prompt, see streaming response state, inspect tool
  output, and respond to a permission request.
- A reviewer can reach session resume, goal controls, model controls, account
  controls, and running task status from visible navigation — not only via the
  command palette.
- Every required MVP screen has empty, active, loading, error, and blocked
  states where applicable.
- Parity-only areas are clearly marked as deferred and still have a known
  navigation destination.
- The design does not depend on terminal-only metaphors for core app workflows.
- The design preserves the semantics listed in
  `docs/design/2026-05-17-dedicated-app-ux-reinterpretation-rules.md` under
  "What Must Be Preserved."

