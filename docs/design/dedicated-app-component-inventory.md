# Dedicated App Component Inventory

## Status

Claude Design export is not present yet.

This is the expected component inventory scaffold for productionizing the Cat Code dedicated app design.

Update this after the Claude Design export is added.

## Existing shell files

Inspect these before changing the dedicated app shell:

- `src/dedicated-app/DedicatedAppShell.tsx`
- `src/dedicated-app/placeholderState.ts`
- `src/dedicated-app/renderDocument.ts`
- `src/dedicated-app/host.ts`
- `src/app-runtime/dedicatedAppState.ts`

## Generic UI primitives

Needed after design productionization:

- Button
- IconButton
- Card
- Panel
- Badge
- StatusBadge
- Dialog
- Input
- Textarea
- Tabs
- ScrollArea
- Divider
- Tooltip
- EmptyState
- ErrorState
- LoadingState

## Layout components

- DedicatedAppShell
- Sidebar
- TopBar
- MainPanel
- RightPanel
- SplitPane
- PageHeader
- StatusRail
- InspectorPanel

## Workspace/session components

- WorkspaceSummaryCard
- ProjectList
- ProjectCard
- SessionList
- SessionCard
- SessionStatusBadge
- ActiveSessionHeader
- SessionLaneList
- SessionLaneCard

## Agent/runtime components

- MessagePanel
- MessageBubble
- RunStatusBar
- TaskTimeline
- ToolCallCard
- EventLog
- AgentThinkingIndicator
- RuntimeStatusCard
- GoalCard
- AbortStatusCard

## Permission/safety components

- PermissionPanel
- PermissionDialog
- PermissionRequestCard
- RiskBadge
- ApprovalActions
- PermissionHistoryItem

## File/diff components

- FileChangeList
- FileChangeItem
- DiffViewer
- FileStatusBadge
- FileSummaryCard

## Agents/workers components

- AgentList
- AgentCard
- WorkerStatusBadge
- WorkerAssignmentCard
- WorkerTimeline
- WorkerOwnershipBadge

## Settings/account components

- SettingsPanel
- SettingsSection
- SettingRow
- AccountStatusCard
- ProviderRouteCard
- ModelRouteCard

## Required states

Important components should support:

- default
- selected
- hover
- focus
- disabled
- loading
- empty
- error
- runtime-not-ready
- waiting-permission
- attention
- completed
- blocked

## Productionization rule

Use generic primitives before creating app-specific variants.

Do not create a new card, button, badge, or dialog style for every screen.

If a component is created only once, check whether it should be:

1. a generic primitive,
2. an app-specific component,
3. or just local markup inside a larger component.

## Current placeholder mapping

The current placeholder app already has these conceptual surfaces:

- workspace summary
- sessions
- navigation
- goal
- runtime status
- panels
- chat surface
- workspace surface
- permissions
- agents
- accounts
- settings

After Claude Design export, map each visible screen/component back to these surfaces or explicitly document why a new surface is needed.
