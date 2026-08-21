import { describe, expect, test } from 'bun:test'
import type { TaskState } from '../tasks/types.js'
import {
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
    // REPL has no producer and no render branch for it.
    expect(PRIORITY_ORDER).not.toContain('init-onboarding' as FocusedInputDialog)
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

  test('a visible voluntary dialog does not report hidden tool waiting', () => {
    expect(
      deriveLocalWaitingReason({
        ...NO_LOCAL_WAITING,
        focusedInputDialog: 'message-selector',
        hasPendingWorkerRequest: true,
      }),
    ).toBeUndefined()
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

  test('exit suppresses every pending queue', () => {
    expect(
      deriveLocalWaitingReason({
        focusedInputDialog: 'tool-permission',
        isExiting: false,
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
        focusedInputDialog: undefined,
        isExiting: true,
        hasExitFlow: false,
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
  test('a blocked local agent is waiting, not working', () => {
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
  test('exitFlow is a null check, not a truthiness check', () => {
    // exitFlow is a ReactNode; an empty-string or 0 flow still means exiting.
    const exitFlow: unknown = ''
    expect(
      deriveFocusedInputDialog(
        factsFor(['tool-permission'], { hasExitFlow: exitFlow != null }),
      ),
    ).toBeUndefined()
  })

  test('the cost dialog uses the already-gated showingCostDialog fact', () => {
    // showingCostDialog is `!isLoading && showCostDialog`; the raw flag must
    // not reach the selector while a turn is running.
    const isLoading = true
    const showCostDialog = true
    const showingCostDialog = !isLoading && showCostDialog
    expect(
      deriveFocusedInputDialog({ ...NO_DIALOGS, hasCostDialog: showingCostDialog }),
    ).toBeUndefined()
  })

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
      focusedInputDialog: dialog,
      isExiting: false,
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
