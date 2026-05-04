import type {
  DedicatedAppRuntimeController,
  DedicatedAppRuntimeState,
} from '../app-runtime/dedicatedAppState.js'

export function createDedicatedAppPlaceholderState(): DedicatedAppRuntimeState {
  return {
    boundaryPhase: 'placeholder',
    workspace: {
      name: 'Cat Code',
      localPathLabel: 'Local project runtime pending',
      focusModeLabel: 'Dense dedicated workspace',
    },
    sessions: [
      {
        id: 'session-current',
        title: 'Current workspace session',
        summary: 'Pinned local thread for the active project goal.',
        status: 'active',
        lastEventLabel: 'Runtime boundary scaffolded',
        unreadCount: 2,
      },
      {
        id: 'session-review',
        title: 'Review queue',
        summary: 'Placeholder lane for diffs, approvals, and follow-up work.',
        status: 'idle',
        lastEventLabel: 'Waiting for controller wiring',
      },
      {
        id: 'session-blocked',
        title: 'Blocked work',
        summary: 'Surface issues that require permission or runtime attention.',
        status: 'blocked',
        lastEventLabel: 'No runtime updates yet',
      },
    ],
    selectedSessionId: 'session-current',
    panels: [
      {
        id: 'panel-chat',
        label: 'Chat',
        detail: 'Conversation lane',
        status: 'selected',
      },
      {
        id: 'panel-workspace',
        label: 'Workspace',
        detail: 'Files, tasks, and notes',
        status: 'available',
      },
      {
        id: 'panel-runtime',
        label: 'Runtime',
        detail: 'Controllers and diagnostics',
        status: 'attention',
      },
    ],
    selectedPanelId: 'panel-chat',
    chatSurface: {
      title: 'Chat and execution surface',
      messages: [
        {
          id: 'msg-system',
          speaker: 'system',
          text: 'Dedicated app scaffold is rendering placeholder runtime state only.',
        },
        {
          id: 'msg-user',
          speaker: 'user',
          text: 'Goal and permission updates will appear here once the runtime controller is connected.',
        },
        {
          id: 'msg-assistant',
          speaker: 'assistant',
          text: 'No backend claims yet; this shell is waiting for real app-runtime wiring.',
        },
      ],
    },
    workspaceSurface: {
      title: 'Workspace area',
      summary: 'Local panels stay dense and visible before runtime integration.',
      items: [
        {
          id: 'item-task-plan',
          label: 'Goal plan',
          detail: 'Placeholder task list for the active session goal.',
          kind: 'task',
        },
        {
          id: 'item-note-runtime',
          label: 'Runtime handoff',
          detail: 'Selected session, panel, and permission queues come from app-runtime.',
          kind: 'note',
        },
        {
          id: 'item-diff-preview',
          label: 'Diff preview',
          detail: 'Reserved slot for file summaries or staged changes.',
          kind: 'diff',
        },
      ],
    },
    permissions: [
      {
        id: 'permission-write',
        title: 'Filesystem write approval',
        scopeLabel: 'workspace:write',
        summary: 'Placeholder queue item until permission events are connected.',
        urgency: 'routine',
      },
      {
        id: 'permission-exec',
        title: 'Command execution approval',
        scopeLabel: 'process:spawn',
        summary: 'Runtime surface should decide when command actions become available.',
        urgency: 'attention',
      },
    ],
    goal: {
      title: 'Current goal',
      summary: 'Waiting for app-runtime goal state.',
      progressLabel: 'Placeholder progress only',
    },
    runtime: {
      status: 'starting',
      summary: 'Runtime boundary scaffolded',
      detail: 'Controller actions are intentionally inert until real session wiring lands.',
      actionsReady: false,
    },
    agents: [
      {
        id: 'agent-planner',
        label: 'Planner agent',
        detail: 'Reserved placeholder for worker roster and ownership.',
        tone: 'muted',
      },
      {
        id: 'agent-reviewer',
        label: 'Review agent',
        detail: 'Use app-runtime wiring to expose lifecycle and assignment state.',
        tone: 'neutral',
      },
    ],
    accounts: [
      {
        id: 'account-default',
        label: 'Default account',
        detail: 'No account data loaded yet.',
        tone: 'muted',
      },
      {
        id: 'account-pool',
        label: 'Account pool',
        detail: 'Reserved slot for pool or alias selection.',
        tone: 'neutral',
      },
    ],
    settings: [
      {
        id: 'setting-profiles',
        label: 'Profiles',
        detail: 'Placeholder destination for runtime-backed profile settings.',
        tone: 'neutral',
      },
      {
        id: 'setting-permissions',
        label: 'Permissions',
        detail: 'Expose user choices from the shared permission surface.',
        tone: 'attention',
      },
      {
        id: 'setting-runtime',
        label: 'Runtime',
        detail: 'Show transport, health, and controller availability once connected.',
        tone: 'muted',
      },
    ],
  }
}

export function createDedicatedAppPlaceholderController(): DedicatedAppRuntimeController {
  return {
    openSession() {},
    selectPanel() {},
    reviewPermission() {},
    focusGoal() {},
    openAgents() {},
    openAccounts() {},
    openSettings() {},
  }
}

export const dedicatedAppPlaceholderState = createDedicatedAppPlaceholderState()

export const dedicatedAppPlaceholderController =
  createDedicatedAppPlaceholderController()
