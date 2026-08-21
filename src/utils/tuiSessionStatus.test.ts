import { describe, expect, test } from 'bun:test'
import type { LocalAgentTaskState } from '../tasks/LocalAgentTask/LocalAgentTask.js'
import type { InProcessTeammateTaskState } from '../tasks/InProcessTeammateTask/types.js'
import type { RemoteAgentTaskState } from '../tasks/RemoteAgentTask/RemoteAgentTask.js'
import type { TaskState } from '../tasks/types.js'
import {
  type DelegatedTaskFacts,
  type FocusedInputDialog,
  type FocusedInputDialogFacts,
  type TuiWaitingReason,
  deriveDelegatedTaskStatus,
  deriveFocusedInputDialog,
  deriveHasOperationalWork,
  deriveLocalWaitingReason,
  deriveTuiSessionStatus,
  deriveTuiWaitingDetail,
  getDialogWaitingReason,
} from './tuiSessionStatus.js'

// -- Dialog fixtures

const NO_DIALOGS: FocusedInputDialogFacts = {
  isExiting: false,
  hasExitFlow: false,
  isMessageSelectorVisible: false,
  suppressInterruptDialogs: false,
  allowDialogsWithAnimation: true,
  hasSandboxPermission: false,
  hasToolPermission: false,
  hasPrompt: false,
  hasWorkerSandboxPermission: false,
  hasElicitation: false,
  hasCostDialog: false,
  hasIdleReturn: false,
  hasResumePausedGoal: false,
  hasUltraplanChoice: false,
  hasUltraplanLaunch: false,
  hasIdeOnboarding: false,
  hasModelSwitchCallout: false,
  hasUndercoverCallout: false,
  hasEffortCallout: false,
  hasRemoteCallout: false,
  hasLspRecommendation: false,
  hasPluginHint: false,
  hasDesktopUpsell: false,
}

/**
 * Which fact makes each dialog eligible. Total over `FocusedInputDialog`, so a
 * new member cannot be added without being covered here.
 */
const FACT_FOR_DIALOG: Record<
  FocusedInputDialog,
  keyof FocusedInputDialogFacts
> = {
  'message-selector': 'isMessageSelectorVisible',
  'sandbox-permission': 'hasSandboxPermission',
  'tool-permission': 'hasToolPermission',
  prompt: 'hasPrompt',
  'worker-sandbox-permission': 'hasWorkerSandboxPermission',
  elicitation: 'hasElicitation',
  cost: 'hasCostDialog',
  'idle-return': 'hasIdleReturn',
  'resume-paused-goal': 'hasResumePausedGoal',
  'ultraplan-choice': 'hasUltraplanChoice',
  'ultraplan-launch': 'hasUltraplanLaunch',
  'ide-onboarding': 'hasIdeOnboarding',
  'model-switch': 'hasModelSwitchCallout',
  'undercover-callout': 'hasUndercoverCallout',
  'effort-callout': 'hasEffortCallout',
  'remote-callout': 'hasRemoteCallout',
  'lsp-recommendation': 'hasLspRecommendation',
  'plugin-hint': 'hasPluginHint',
  'desktop-upsell': 'hasDesktopUpsell',
}

/** Highest priority first. This is the contract REPL's render branches assume. */
const PRIORITY_ORDER: readonly FocusedInputDialog[] = [
  'message-selector',
  'sandbox-permission',
  'tool-permission',
  'prompt',
  'worker-sandbox-permission',
  'elicitation',
  'cost',
  'idle-return',
  'resume-paused-goal',
  'ultraplan-choice',
  'ultraplan-launch',
  'ide-onboarding',
  'model-switch',
  'undercover-callout',
  'effort-callout',
  'remote-callout',
  'lsp-recommendation',
  'plugin-hint',
  'desktop-upsell',
]

function factsFor(
  dialogs: readonly FocusedInputDialog[],
  overrides: Partial<FocusedInputDialogFacts> = {},
): FocusedInputDialogFacts {
  const facts = { ...NO_DIALOGS }
  for (const dialog of dialogs) {
    facts[FACT_FOR_DIALOG[dialog]] = true
  }
  return { ...facts, ...overrides }
}

describe('deriveFocusedInputDialog: membership', () => {
  test('covers exactly the 19 live dialogs', () => {
    expect(PRIORITY_ORDER).toHaveLength(19)
    expect(new Set(PRIORITY_ORDER).size).toBe(19)
    expect(Object.keys(FACT_FOR_DIALOG).sort()).toEqual(
      [...PRIORITY_ORDER].sort(),
    )
  })

  test('does not contain the dead init-onboarding member', () => {
    // Type-level, not a runtime check on a test-local array: asserting that an
    // array literal lacks a string the test author never wrote into it cannot
    // fail. This reads the production union instead. REPL has no producer and
    // no render branch for init-onboarding.
    type HasInitOnboarding = 'init-onboarding' extends FocusedInputDialog
      ? true
      : false
    const noInitOnboarding: HasInitOnboarding = false
    expect(noInitOnboarding).toBe(false)
  })

  test('no dialog facts yields no focused dialog', () => {
    expect(deriveFocusedInputDialog(NO_DIALOGS)).toBeUndefined()
  })

  for (const dialog of PRIORITY_ORDER) {
    test(`${dialog} is selected when it is the only eligible dialog`, () => {
      expect(deriveFocusedInputDialog(factsFor([dialog]))).toBe(dialog)
    })
  }
})

describe('deriveFocusedInputDialog: priority', () => {
  // Setting every dialog from index i downward must still pick index i. Run
  // over all indices, this pins the full order, not just adjacent pairs.
  PRIORITY_ORDER.forEach((dialog, index) => {
    test(`${dialog} outranks every lower-priority dialog`, () => {
      expect(
        deriveFocusedInputDialog(factsFor(PRIORITY_ORDER.slice(index))),
      ).toBe(dialog)
    })
  })

  test('every dialog set at once resolves to the highest priority', () => {
    expect(deriveFocusedInputDialog(factsFor(PRIORITY_ORDER))).toBe(
      'message-selector',
    )
  })

  test('local sandbox outranks the tool permission queue', () => {
    expect(
      deriveFocusedInputDialog(
        factsFor(['sandbox-permission', 'tool-permission']),
      ),
    ).toBe('sandbox-permission')
  })

  test('local sandbox ignores the toolJSX animation gate', () => {
    // A network prompt has to reach the user even while a tool owns the frame.
    expect(
      deriveFocusedInputDialog(
        factsFor(['sandbox-permission'], { allowDialogsWithAnimation: false }),
      ),
    ).toBe('sandbox-permission')
  })

  test('the animation gate suppresses every dialog below local sandbox', () => {
    const belowSandbox = PRIORITY_ORDER.filter(
      d => d !== 'message-selector' && d !== 'sandbox-permission',
    )
    expect(
      deriveFocusedInputDialog(
        factsFor(belowSandbox, { allowDialogsWithAnimation: false }),
      ),
    ).toBeUndefined()
  })

  test('the message selector ignores the animation gate', () => {
    expect(
      deriveFocusedInputDialog(
        factsFor(['message-selector'], { allowDialogsWithAnimation: false }),
      ),
    ).toBe('message-selector')
  })
})

describe('deriveFocusedInputDialog: exit and typing suppression', () => {
  test('isExiting suppresses every dialog', () => {
    expect(
      deriveFocusedInputDialog(factsFor(PRIORITY_ORDER, { isExiting: true })),
    ).toBeUndefined()
  })

  test('hasExitFlow suppresses every dialog', () => {
    expect(
      deriveFocusedInputDialog(factsFor(PRIORITY_ORDER, { hasExitFlow: true })),
    ).toBeUndefined()
  })

  test('exit outranks the message selector', () => {
    expect(
      deriveFocusedInputDialog(
        factsFor(['message-selector'], { hasExitFlow: true }),
      ),
    ).toBeUndefined()
  })

  test('typing suppression hides interrupt dialogs', () => {
    expect(
      deriveFocusedInputDialog(
        factsFor(['tool-permission'], { suppressInterruptDialogs: true }),
      ),
    ).toBeUndefined()
  })

  test('typing suppression hides even the local sandbox prompt', () => {
    expect(
      deriveFocusedInputDialog(
        factsFor(['sandbox-permission'], { suppressInterruptDialogs: true }),
      ),
    ).toBeUndefined()
  })

  test('the message selector beats typing suppression', () => {
    expect(
      deriveFocusedInputDialog(
        factsFor(['message-selector', 'tool-permission'], {
          suppressInterruptDialogs: true,
        }),
      ),
    ).toBe('message-selector')
  })

  test('re-running with suppression off yields the dialog typing is hiding', () => {
    // This is exactly how REPL derives the prospective dialog: same selector,
    // one fact flipped. No second priority list.
    const typing = factsFor(['sandbox-permission', 'tool-permission'], {
      suppressInterruptDialogs: true,
    })
    expect(deriveFocusedInputDialog(typing)).toBeUndefined()
    expect(
      deriveFocusedInputDialog({ ...typing, suppressInterruptDialogs: false }),
    ).toBe('sandbox-permission')
  })

  test('the prospective re-run still honours exit', () => {
    const typing = factsFor(['tool-permission'], {
      suppressInterruptDialogs: true,
      isExiting: true,
    })
    expect(
      deriveFocusedInputDialog({ ...typing, suppressInterruptDialogs: false }),
    ).toBeUndefined()
  })
})

describe('getDialogWaitingReason', () => {
  const EXPECTED: Record<FocusedInputDialog, TuiWaitingReason | undefined> = {
    'sandbox-permission': 'sandbox-request',
    'worker-sandbox-permission': 'sandbox-request',
    'tool-permission': 'tool-approval',
    prompt: 'input-needed',
    elicitation: 'input-needed',
    cost: 'dialog-open',
    'idle-return': 'dialog-open',
    'ide-onboarding': 'dialog-open',
    'resume-paused-goal': 'input-needed',
    'ultraplan-choice': 'input-needed',
    'ultraplan-launch': 'input-needed',
    'message-selector': undefined,
    'model-switch': undefined,
    'undercover-callout': undefined,
    'effort-callout': undefined,
    'remote-callout': undefined,
    'lsp-recommendation': undefined,
    'plugin-hint': undefined,
    'desktop-upsell': undefined,
  }

  for (const dialog of PRIORITY_ORDER) {
    test(`${dialog} maps to ${String(EXPECTED[dialog])}`, () => {
      expect(getDialogWaitingReason(dialog)).toBe(EXPECTED[dialog])
    })
  }

  test('no dialog maps to no reason', () => {
    expect(getDialogWaitingReason(undefined)).toBeUndefined()
  })

  test('voluntary navigation and suggestions are never waiting', () => {
    const nonWaiting = PRIORITY_ORDER.filter(
      d => getDialogWaitingReason(d) === undefined,
    )
    expect(nonWaiting).toEqual([
      'message-selector',
      'model-switch',
      'undercover-callout',
      'effort-callout',
      'remote-callout',
      'lsp-recommendation',
      'plugin-hint',
      'desktop-upsell',
    ])
  })
})

// -- Local waiting

const NO_LOCAL_WAITING = {
  focusedInputDialog: undefined as FocusedInputDialog | undefined,
  isExiting: false,
  hasExitFlow: false,
  allowDialogsWithAnimation: true,
  hasToolPermission: false,
  hasPrompt: false,
  hasPendingWorkerRequest: false,
  hasPendingSandboxRequest: false,
  isShowingLocalJsxCommand: false,
}

describe('deriveLocalWaitingReason', () => {
  test('nothing pending is not waiting', () => {
    expect(deriveLocalWaitingReason(NO_LOCAL_WAITING)).toBeUndefined()
  })

  test('an observed blocking dialog reports its mapped reason', () => {
    expect(
      deriveLocalWaitingReason({
        ...NO_LOCAL_WAITING,
        focusedInputDialog: 'tool-permission',
      }),
    ).toBe('tool-approval')
  })

  test('a visible voluntary dialog does not report a queue it outranks', () => {
    // The tool queue lost the priority contest to the message selector, which
    // is what focusedInputDialog reports. It is behind the selector, so the
    // session is not waiting on it.
    expect(
      deriveLocalWaitingReason({
        ...NO_LOCAL_WAITING,
        focusedInputDialog: 'message-selector',
        hasToolPermission: true,
      }),
    ).toBeUndefined()
  })

  test('a voluntary dialog does NOT mask a request rendered beside it', () => {
    // WorkerPendingPermission renders outside the focused-dialog switch, so it
    // is on screen next to the selector rather than behind it. Reporting idle
    // here let goal continuation fire while a worker was blocked on the leader.
    expect(
      deriveLocalWaitingReason({
        ...NO_LOCAL_WAITING,
        focusedInputDialog: 'message-selector',
        hasPendingWorkerRequest: true,
      }),
    ).toBe('worker-request')
  })

  test('a non-blocking callout does not mask a pending sandbox request', () => {
    expect(
      deriveLocalWaitingReason({
        ...NO_LOCAL_WAITING,
        focusedInputDialog: 'desktop-upsell',
        hasPendingSandboxRequest: true,
      }),
    ).toBe('sandbox-request')
  })

  test('a non-blocking callout does not mask a visible local JSX command', () => {
    expect(
      deriveLocalWaitingReason({
        ...NO_LOCAL_WAITING,
        focusedInputDialog: 'lsp-recommendation',
        isShowingLocalJsxCommand: true,
      }),
    ).toBe('dialog-open')
  })

  test('a blocking dialog still wins over every fallback', () => {
    expect(
      deriveLocalWaitingReason({
        ...NO_LOCAL_WAITING,
        focusedInputDialog: 'tool-permission',
        hasPendingWorkerRequest: true,
        isShowingLocalJsxCommand: true,
      }),
    ).toBe('tool-approval')
  })

  test('a pending worker request reports worker-request when no dialog is observed', () => {
    expect(
      deriveLocalWaitingReason({
        ...NO_LOCAL_WAITING,
        hasPendingWorkerRequest: true,
      }),
    ).toBe('worker-request')
  })

  test('a pending sandbox request reports sandbox-request when no dialog is observed', () => {
    expect(
      deriveLocalWaitingReason({
        ...NO_LOCAL_WAITING,
        hasPendingSandboxRequest: true,
      }),
    ).toBe('sandbox-request')
  })

  test('a visible local JSX command is the final fallback', () => {
    expect(
      deriveLocalWaitingReason({
        ...NO_LOCAL_WAITING,
        isShowingLocalJsxCommand: true,
      }),
    ).toBe('dialog-open')
  })

  test('a pending worker request outranks the local JSX fallback', () => {
    expect(
      deriveLocalWaitingReason({
        ...NO_LOCAL_WAITING,
        hasPendingWorkerRequest: true,
        isShowingLocalJsxCommand: true,
      }),
    ).toBe('worker-request')
  })

  test('a queue hidden by the toolJSX animation gate still reports waiting', () => {
    // A tool owns the frame with shouldContinueAnimation unset, so no dialog
    // can render and none is observed, but the queued approval still blocks
    // the session. Producers: computerUse/wrapper.tsx and processBashCommand.tsx.
    expect(
      deriveLocalWaitingReason({
        ...NO_LOCAL_WAITING,
        allowDialogsWithAnimation: false,
        hasToolPermission: true,
      }),
    ).toBe('tool-approval')
  })

  test('a prompt hidden by the animation gate reports input needed', () => {
    expect(
      deriveLocalWaitingReason({
        ...NO_LOCAL_WAITING,
        allowDialogsWithAnimation: false,
        hasPrompt: true,
      }),
    ).toBe('input-needed')
  })

  test('an ungated queue that simply lost to a dialog does not double-report', () => {
    // Gate open: the queue is representable, so the dialog selector owns it and
    // the direct queue check must stay quiet.
    expect(
      deriveLocalWaitingReason({
        ...NO_LOCAL_WAITING,
        allowDialogsWithAnimation: true,
        hasToolPermission: true,
      }),
    ).toBeUndefined()
  })

  test('the animation-gated queue does not outrank a visible request', () => {
    expect(
      deriveLocalWaitingReason({
        ...NO_LOCAL_WAITING,
        allowDialogsWithAnimation: false,
        hasToolPermission: true,
        hasPendingWorkerRequest: true,
      }),
    ).toBe('worker-request')
  })

  test('exit suppresses a queue hidden by the animation gate', () => {
    expect(
      deriveLocalWaitingReason({
        ...NO_LOCAL_WAITING,
        hasExitFlow: true,
        allowDialogsWithAnimation: false,
        hasToolPermission: true,
      }),
    ).toBeUndefined()
  })

  test('exit suppresses every pending queue', () => {
    expect(
      deriveLocalWaitingReason({
        ...NO_LOCAL_WAITING,
        focusedInputDialog: 'tool-permission',
        hasExitFlow: true,
        hasPendingWorkerRequest: true,
        hasPendingSandboxRequest: true,
        isShowingLocalJsxCommand: true,
      }),
    ).toBeUndefined()
  })

  test('isExiting suppresses every pending queue', () => {
    expect(
      deriveLocalWaitingReason({
        ...NO_LOCAL_WAITING,
        isExiting: true,
        hasPendingWorkerRequest: true,
        hasPendingSandboxRequest: true,
        isShowingLocalJsxCommand: true,
      }),
    ).toBeUndefined()
  })
})

describe('deriveTuiWaitingDetail', () => {
  test('no reason yields no detail', () => {
    expect(deriveTuiWaitingDetail({ reason: undefined })).toBeUndefined()
  })

  test('tool approval names the tool', () => {
    expect(
      deriveTuiWaitingDetail({ reason: 'tool-approval', toolName: 'Bash' }),
    ).toBe('approve Bash')
  })

  test('tool approval without a live request degrades to input needed', () => {
    expect(deriveTuiWaitingDetail({ reason: 'tool-approval' })).toBe(
      'input needed',
    )
  })

  test.each([
    ['worker-request', 'worker request'],
    ['sandbox-request', 'sandbox request'],
    ['dialog-open', 'dialog open'],
    ['input-needed', 'input needed'],
  ] as const)('%s reads as %s', (reason, detail) => {
    expect(deriveTuiWaitingDetail({ reason })).toBe(detail)
  })
})

// -- Delegated tasks

/**
 * Compile-time anchor for the five fields the classifier reads off real task
 * rows. `TaskState` widens to `any` (src/tasks/types.ts imports two modules
 * that do not exist on disk), so nothing else in the repo checks these names:
 * a rename in an owning module would silently reclassify every task as working
 * with this whole suite still green.
 *
 * Two separate assertions, because they catch different mistakes:
 *
 * 1. Key presence. Assignability alone does NOT catch a rename here, since
 *    every field is optional on DelegatedTaskFacts and a source type that
 *    lacks an optional property stays assignable. Verified by experiment:
 *    renaming handoffStatus in LocalAgentTask.tsx produced no error from the
 *    assignment below, and does produce one from this table.
 * 2. Type compatibility, for a field that keeps its name but changes shape
 *    (e.g. ultraplanPhase gaining a third phase).
 */
type HasKey<T, K extends string> = K extends keyof T ? true : false

const _delegatedFieldNamesExist: [
  HasKey<LocalAgentTaskState, 'handoffStatus'>,
  HasKey<InProcessTeammateTaskState, 'awaitingPlanApproval'>,
  HasKey<InProcessTeammateTaskState, 'isIdle'>,
  HasKey<RemoteAgentTaskState, 'ultraplanPhase'>,
  HasKey<RemoteAgentTaskState, 'isLongRunning'>,
] = [true, true, true, true, true]
void _delegatedFieldNamesExist

const _delegatedFieldTypesMatch: DelegatedTaskFacts = {} as
  | LocalAgentTaskState
  | RemoteAgentTaskState
  | InProcessTeammateTaskState
void _delegatedFieldTypesMatch

type TaskFixture = Record<string, unknown>

function tasksOf(...fixtures: TaskFixture[]): Record<string, TaskState> {
  const out: Record<string, TaskState> = {}
  fixtures.forEach((task, index) => {
    out[`t${index}`] = task as TaskState
  })
  return out
}

const TERMINAL_STATUSES = ['completed', 'failed', 'killed'] as const
const NONTERMINAL_STATUSES = ['pending', 'running'] as const

const localAgent = (extra: TaskFixture = {}): TaskFixture => ({
  type: 'local_agent',
  status: 'running',
  ...extra,
})
const remoteAgent = (extra: TaskFixture = {}): TaskFixture => ({
  type: 'remote_agent',
  status: 'running',
  ...extra,
})
const teammate = (extra: TaskFixture = {}): TaskFixture => ({
  type: 'in_process_teammate',
  status: 'running',
  awaitingPlanApproval: false,
  isIdle: false,
  ...extra,
})

describe('deriveDelegatedTaskStatus: working states', () => {
  test('no tasks is neither working nor waiting', () => {
    expect(deriveDelegatedTaskStatus({})).toEqual({
      hasWorkingDelegatedTask: false,
    })
  })

  for (const status of NONTERMINAL_STATUSES) {
    test(`a ${status} local agent is working`, () => {
      expect(deriveDelegatedTaskStatus(tasksOf(localAgent({ status })))).toEqual(
        { hasWorkingDelegatedTask: true },
      )
    })
  }

  test('a backgrounded main session is working', () => {
    // Backgrounded main sessions run as local_agent with agentType main-session.
    expect(
      deriveDelegatedTaskStatus(
        tasksOf(localAgent({ agentType: 'main-session', isBackgrounded: true })),
      ),
    ).toEqual({ hasWorkingDelegatedTask: true })
  })

  test('a local agent with a done handoff is still working', () => {
    expect(
      deriveDelegatedTaskStatus(tasksOf(localAgent({ handoffStatus: 'done' }))),
    ).toEqual({ hasWorkingDelegatedTask: true })
  })

  test('a running remote agent is working', () => {
    expect(deriveDelegatedTaskStatus(tasksOf(remoteAgent()))).toEqual({
      hasWorkingDelegatedTask: true,
    })
  })

  test('an active teammate is working', () => {
    expect(deriveDelegatedTaskStatus(tasksOf(teammate()))).toEqual({
      hasWorkingDelegatedTask: true,
    })
  })

  test('a running local workflow is working', () => {
    expect(
      deriveDelegatedTaskStatus(
        tasksOf({ type: 'local_workflow', status: 'running' }),
      ),
    ).toEqual({ hasWorkingDelegatedTask: true })
  })
})

describe('deriveDelegatedTaskStatus: waiting states', () => {
  // KNOWN GAP, verified against source 2026-08-21: production cannot currently
  // reach the nonterminal-blocked state this branch is written for.
  // completeAgentTask (src/tasks/LocalAgentTask/LocalAgentTask.tsx:538) is the
  // ONLY writer of handoffStatus and always sets status:'completed' in the same
  // literal, so handoffStatus==='blocked' implies terminal and the terminal
  // guard returns 'none' first. The footer pill (src/tasks/pillLabel.ts:117)
  // does NOT gate on terminal status, so it shows "needs input" while session
  // status says idle. Do not delete these two tests without deciding that
  // question: the first pins what production actually produces today, the
  // second pins the branch contract if a nonterminal blocked row ever exists.
  test('a blocked local agent as production writes it is excluded, not waiting', () => {
    expect(
      deriveDelegatedTaskStatus(
        tasksOf(localAgent({ status: 'completed', handoffStatus: 'blocked' })),
      ),
    ).toEqual({ hasWorkingDelegatedTask: false })
  })

  test('a nonterminal blocked local agent would be waiting, not working', () => {
    expect(
      deriveDelegatedTaskStatus(
        tasksOf(localAgent({ handoffStatus: 'blocked' })),
      ),
    ).toEqual({ hasWorkingDelegatedTask: false, waitingReason: 'input-needed' })
  })

  test('a teammate awaiting plan approval is waiting, not working', () => {
    expect(
      deriveDelegatedTaskStatus(
        tasksOf(teammate({ awaitingPlanApproval: true })),
      ),
    ).toEqual({ hasWorkingDelegatedTask: false, waitingReason: 'input-needed' })
  })

  test('ultraplan needs_input is waiting, not working', () => {
    expect(
      deriveDelegatedTaskStatus(
        tasksOf(remoteAgent({ isUltraplan: true, ultraplanPhase: 'needs_input' })),
      ),
    ).toEqual({ hasWorkingDelegatedTask: false, waitingReason: 'input-needed' })
  })

  test('ultraplan plan_ready is waiting, not working', () => {
    expect(
      deriveDelegatedTaskStatus(
        tasksOf(remoteAgent({ isUltraplan: true, ultraplanPhase: 'plan_ready' })),
      ),
    ).toEqual({ hasWorkingDelegatedTask: false, waitingReason: 'input-needed' })
  })

  test('an ultraplan attention phase outranks the long-running exclusion', () => {
    expect(
      deriveDelegatedTaskStatus(
        tasksOf(
          remoteAgent({ isLongRunning: true, ultraplanPhase: 'needs_input' }),
        ),
      ),
    ).toEqual({ hasWorkingDelegatedTask: false, waitingReason: 'input-needed' })
  })
})

describe('deriveDelegatedTaskStatus: excluded states', () => {
  test('an idle teammate is neither', () => {
    expect(
      deriveDelegatedTaskStatus(tasksOf(teammate({ isIdle: true }))),
    ).toEqual({ hasWorkingDelegatedTask: false })
  })

  test('a deliberately long-running remote agent is neither', () => {
    expect(
      deriveDelegatedTaskStatus(tasksOf(remoteAgent({ isLongRunning: true }))),
    ).toEqual({ hasWorkingDelegatedTask: false })
  })

  test.each(['local_bash', 'monitor_mcp', 'dream'] as const)(
    'a running %s task is neither',
    type => {
      expect(
        deriveDelegatedTaskStatus(tasksOf({ type, status: 'running' })),
      ).toEqual({ hasWorkingDelegatedTask: false })
    },
  )

  for (const status of TERMINAL_STATUSES) {
    test(`every task type is excluded when ${status}`, () => {
      expect(
        deriveDelegatedTaskStatus(
          tasksOf(
            localAgent({ status }),
            localAgent({ status, handoffStatus: 'blocked' }),
            remoteAgent({ status }),
            remoteAgent({ status, ultraplanPhase: 'needs_input' }),
            teammate({ status }),
            teammate({ status, awaitingPlanApproval: true }),
            { type: 'local_workflow', status },
            { type: 'local_bash', status },
            { type: 'monitor_mcp', status },
            { type: 'dream', status },
          ),
        ),
      ).toEqual({ hasWorkingDelegatedTask: false })
    })
  }
})

describe('deriveDelegatedTaskStatus: mixed sets', () => {
  test('one active agent among excluded rows still reports working', () => {
    expect(
      deriveDelegatedTaskStatus(
        tasksOf(
          localAgent({ status: 'completed' }),
          teammate({ isIdle: true }),
          remoteAgent({ isLongRunning: true }),
          { type: 'local_bash', status: 'running' },
          localAgent(),
        ),
      ),
    ).toEqual({ hasWorkingDelegatedTask: true })
  })

  test('a blocked agent alone is waiting without work', () => {
    expect(
      deriveDelegatedTaskStatus(
        tasksOf(localAgent({ handoffStatus: 'blocked' })),
      ),
    ).toEqual({ hasWorkingDelegatedTask: false, waitingReason: 'input-needed' })
  })

  test('ultraplan needs_input alongside a running agent reports both facts', () => {
    // Losing either fact is a real bug: dropping working lets the machine
    // sleep mid-run, dropping waiting reports busy while a task is stalled.
    expect(
      deriveDelegatedTaskStatus(
        tasksOf(remoteAgent({ ultraplanPhase: 'needs_input' }), localAgent()),
      ),
    ).toEqual({ hasWorkingDelegatedTask: true, waitingReason: 'input-needed' })
  })

  test('a long-running remote plus an idle teammate reports neither', () => {
    expect(
      deriveDelegatedTaskStatus(
        tasksOf(remoteAgent({ isLongRunning: true }), teammate({ isIdle: true })),
      ),
    ).toEqual({ hasWorkingDelegatedTask: false })
  })
})

// -- Session status and sleep policy

describe('deriveTuiSessionStatus', () => {
  const base = {
    isLoading: false,
    hasWorkingDelegatedTask: false,
    localWaitingReason: undefined as TuiWaitingReason | undefined,
    delegatedWaitingReason: undefined as 'input-needed' | undefined,
  }

  test('nothing active is idle', () => {
    expect(deriveTuiSessionStatus(base)).toBe('idle')
  })

  test('loading alone is busy', () => {
    expect(deriveTuiSessionStatus({ ...base, isLoading: true })).toBe('busy')
  })

  test('delegated work alone is busy, not idle', () => {
    expect(
      deriveTuiSessionStatus({ ...base, hasWorkingDelegatedTask: true }),
    ).toBe('busy')
  })

  test('local waiting outranks loading', () => {
    expect(
      deriveTuiSessionStatus({
        ...base,
        isLoading: true,
        localWaitingReason: 'tool-approval',
      }),
    ).toBe('waiting')
  })

  test('local waiting outranks delegated work', () => {
    expect(
      deriveTuiSessionStatus({
        ...base,
        hasWorkingDelegatedTask: true,
        localWaitingReason: 'dialog-open',
      }),
    ).toBe('waiting')
  })

  test('delegated waiting outranks busy', () => {
    expect(
      deriveTuiSessionStatus({
        ...base,
        isLoading: true,
        hasWorkingDelegatedTask: true,
        delegatedWaitingReason: 'input-needed',
      }),
    ).toBe('waiting')
  })

  test('delegated waiting alone is waiting', () => {
    expect(
      deriveTuiSessionStatus({ ...base, delegatedWaitingReason: 'input-needed' }),
    ).toBe('waiting')
  })
})

describe('deriveHasOperationalWork', () => {
  const base = {
    isLoading: false,
    hasWorkingDelegatedTask: false,
    localWaitingReason: undefined as TuiWaitingReason | undefined,
  }

  test('nothing active is no work', () => {
    expect(deriveHasOperationalWork(base)).toBe(false)
  })

  test('a running local turn is work', () => {
    expect(deriveHasOperationalWork({ ...base, isLoading: true })).toBe(true)
  })

  test('a local turn blocked on the user is not work', () => {
    // Existing behavior: caffeinate must not be held for a parked prompt.
    expect(
      deriveHasOperationalWork({
        ...base,
        isLoading: true,
        localWaitingReason: 'tool-approval',
      }),
    ).toBe(false)
  })

  test('delegated work keeps work true while the user is asked something', () => {
    expect(
      deriveHasOperationalWork({
        ...base,
        isLoading: true,
        hasWorkingDelegatedTask: true,
        localWaitingReason: 'tool-approval',
      }),
    ).toBe(true)
  })

  test('delegated work alone is work', () => {
    expect(
      deriveHasOperationalWork({ ...base, hasWorkingDelegatedTask: true }),
    ).toBe(true)
  })
})

describe('session status and sleep policy together', () => {
  function derive(args: {
    isLoading: boolean
    hasWorkingDelegatedTask: boolean
    localWaitingReason: TuiWaitingReason | undefined
    delegatedWaitingReason: 'input-needed' | undefined
  }) {
    return {
      status: deriveTuiSessionStatus(args),
      work: deriveHasOperationalWork(args),
    }
  }

  type PrecedenceCase = {
    name: string
    args: Parameters<typeof derive>[0]
    status: 'busy' | 'waiting' | 'idle'
    work: boolean
  }

  const CASES: readonly PrecedenceCase[] = [
    {
      name: 'loading only',
      args: { isLoading: true, hasWorkingDelegatedTask: false, localWaitingReason: undefined, delegatedWaitingReason: undefined },
      status: 'busy',
      work: true,
    },
    {
      name: 'working delegated only',
      args: { isLoading: false, hasWorkingDelegatedTask: true, localWaitingReason: undefined, delegatedWaitingReason: undefined },
      status: 'busy',
      work: true,
    },
    {
      name: 'local waiting plus loading',
      args: { isLoading: true, hasWorkingDelegatedTask: false, localWaitingReason: 'tool-approval', delegatedWaitingReason: undefined },
      status: 'waiting',
      work: false,
    },
    {
      name: 'local waiting plus working delegated',
      args: { isLoading: false, hasWorkingDelegatedTask: true, localWaitingReason: 'tool-approval', delegatedWaitingReason: undefined },
      status: 'waiting',
      work: true,
    },
    {
      name: 'delegated waiting plus loading',
      args: { isLoading: true, hasWorkingDelegatedTask: false, localWaitingReason: undefined, delegatedWaitingReason: 'input-needed' },
      status: 'waiting',
      work: true,
    },
    {
      name: 'delegated waiting only',
      args: { isLoading: false, hasWorkingDelegatedTask: false, localWaitingReason: undefined, delegatedWaitingReason: 'input-needed' },
      status: 'waiting',
      work: false,
    },
    {
      name: 'delegated waiting plus working delegated',
      args: { isLoading: false, hasWorkingDelegatedTask: true, localWaitingReason: undefined, delegatedWaitingReason: 'input-needed' },
      status: 'waiting',
      work: true,
    },
    {
      name: 'nothing active',
      args: { isLoading: false, hasWorkingDelegatedTask: false, localWaitingReason: undefined, delegatedWaitingReason: undefined },
      status: 'idle',
      work: false,
    },
  ]

  for (const testCase of CASES) {
    test(testCase.name, () => {
      expect(derive(testCase.args)).toEqual({
        status: testCase.status,
        work: testCase.work,
      })
    })
  }
})

// -- Integration facts REPL depends on

describe('REPL integration facts', () => {
  // Deliberately absent: tests that recompute REPL's own fact conversion
  // (`exitFlow != null`, `!isLoading && showCostDialog`) in the test body and
  // then assert on the result. They pass whatever REPL does, so they would give
  // false confidence in exactly the wiring this module cannot see. Verifying
  // those conversions needs a REPL-level render test, which does not exist yet.

  test('visible local sandbox plus a tool queue reports sandbox waiting', () => {
    const dialog = deriveFocusedInputDialog(
      factsFor(['sandbox-permission', 'tool-permission']),
    )
    expect(
      deriveLocalWaitingReason({ ...NO_LOCAL_WAITING, focusedInputDialog: dialog }),
    ).toBe('sandbox-request')
  })

  test('typing-suppressed sandbox plus a tool queue prospectively reports sandbox', () => {
    const facts = factsFor(['sandbox-permission', 'tool-permission'], {
      suppressInterruptDialogs: true,
    })
    const visible = deriveFocusedInputDialog(facts)
    const prospective =
      visible === undefined
        ? deriveFocusedInputDialog({ ...facts, suppressInterruptDialogs: false })
        : visible
    expect(visible).toBeUndefined()
    expect(
      deriveLocalWaitingReason({
        ...NO_LOCAL_WAITING,
        focusedInputDialog: prospective,
      }),
    ).toBe('sandbox-request')
  })

  test('a visible message selector does not report the hidden tool queue', () => {
    const dialog = deriveFocusedInputDialog(
      factsFor(['message-selector', 'tool-permission']),
    )
    expect(dialog).toBe('message-selector')
    expect(
      deriveLocalWaitingReason({ ...NO_LOCAL_WAITING, focusedInputDialog: dialog }),
    ).toBeUndefined()
  })

  test('visible dialog priority and exported status agree', () => {
    const facts = factsFor(['tool-permission'])
    const dialog = deriveFocusedInputDialog(facts)
    const localWaitingReason = deriveLocalWaitingReason({
      ...NO_LOCAL_WAITING,
      focusedInputDialog: dialog,
    })
    expect(dialog).toBe('tool-permission')
    expect(
      deriveTuiSessionStatus({
        isLoading: true,
        hasWorkingDelegatedTask: false,
        localWaitingReason,
        delegatedWaitingReason: undefined,
      }),
    ).toBe('waiting')
    expect(
      deriveTuiWaitingDetail({ reason: localWaitingReason, toolName: 'Bash' }),
    ).toBe('approve Bash')
  })

  test('exit plus every pending queue reports no waiting and no detail', () => {
    const facts = factsFor(PRIORITY_ORDER, { hasExitFlow: true })
    const dialog = deriveFocusedInputDialog(facts)
    const reason = deriveLocalWaitingReason({
      ...NO_LOCAL_WAITING,
      focusedInputDialog: dialog,
      hasExitFlow: true,
      hasPendingWorkerRequest: true,
      hasPendingSandboxRequest: true,
      isShowingLocalJsxCommand: true,
    })
    expect(dialog).toBeUndefined()
    expect(reason).toBeUndefined()
    expect(deriveTuiWaitingDetail({ reason })).toBeUndefined()
    expect(
      deriveTuiSessionStatus({
        isLoading: false,
        hasWorkingDelegatedTask: false,
        localWaitingReason: reason,
        delegatedWaitingReason: undefined,
      }),
    ).toBe('idle')
  })

  test('goal continuation stays blocked while delegated work runs', () => {
    // REPL gates continuation on sessionStatus === 'idle'.
    const { hasWorkingDelegatedTask, waitingReason } = deriveDelegatedTaskStatus(
      tasksOf(localAgent()),
    )
    expect(
      deriveTuiSessionStatus({
        isLoading: false,
        hasWorkingDelegatedTask,
        localWaitingReason: undefined,
        delegatedWaitingReason: waitingReason,
      }),
    ).not.toBe('idle')
  })

  test('goal continuation stays blocked while a delegated task needs input', () => {
    const { hasWorkingDelegatedTask, waitingReason } = deriveDelegatedTaskStatus(
      tasksOf(localAgent({ handoffStatus: 'blocked' })),
    )
    expect(
      deriveTuiSessionStatus({
        isLoading: false,
        hasWorkingDelegatedTask,
        localWaitingReason: undefined,
        delegatedWaitingReason: waitingReason,
      }),
    ).not.toBe('idle')
  })

  test('goal continuation is allowed once only excluded task rows remain', () => {
    const { hasWorkingDelegatedTask, waitingReason } = deriveDelegatedTaskStatus(
      tasksOf(
        localAgent({ status: 'completed' }),
        teammate({ isIdle: true }),
        remoteAgent({ isLongRunning: true }),
      ),
    )
    expect(
      deriveTuiSessionStatus({
        isLoading: false,
        hasWorkingDelegatedTask,
        localWaitingReason: undefined,
        delegatedWaitingReason: waitingReason,
      }),
    ).toBe('idle')
  })
})
