import { expect, test } from 'bun:test'
import {
  createPermissionState,
  reducePermissionState,
  type PermissionRequest,
} from './permissionState.js'
import {
  EXIT_PLAN_MODE_TOOL_NAME,
  PLAN_APPROVE_OPTIONS,
  parsePlanSteps,
  selectNonPlanPermissionQueue,
  selectPlanReview,
} from './planState.js'

const PLAN_REQUEST: PermissionRequest = {
  requestId: 'perm-plan-1',
  request: {
    subtype: 'can_use_tool' as const,
    tool_name: EXIT_PLAN_MODE_TOOL_NAME,
    input: {
      plan: '1. Write the tests\n2. Wire the domain\n- Report back',
      planFilePath: '/config/plans/kind-otter.md',
      allowedPrompts: [
        { tool: 'Bash', prompt: 'run the test suite' },
        { tool: 'Bash' },
        'not an object',
      ],
    },
    tool_use_id: 'toolu-plan-1',
  },
}

const BASH_REQUEST: PermissionRequest = {
  requestId: 'perm-bash-1',
  request: {
    subtype: 'can_use_tool' as const,
    tool_name: 'Bash',
    input: { command: 'date' },
    tool_use_id: 'toolu-bash-1',
  },
}

function readyFrame(pendingPermissionRequests: PermissionRequest[], sessionId = 'session-1') {
  return {
    kind: 'ready' as const,
    protocolVersion: 1 as const,
    sessionId,
    engineSessionId: `engine-${sessionId}`,
    payload: {
      type: 'app.ready' as const,
      protocolVersion: 1 as const,
      inputEnabled: false,
      activeTurn: true,
      abort: { status: 'idle' as const },
      goalSnapshot: null,
      pendingPermissionRequests,
    },
  }
}

test('selectPlanReview returns null with no pending ExitPlanMode request', () => {
  const state = reducePermissionState(createPermissionState(), {
    type: 'frame',
    frame: readyFrame([BASH_REQUEST]),
  })

  expect(selectPlanReview(state, 'session-1')).toBeNull()
})

test('selectPlanReview narrows the real plan/file/allowedPrompts tool input', () => {
  const state = reducePermissionState(createPermissionState(), {
    type: 'frame',
    frame: readyFrame([BASH_REQUEST, PLAN_REQUEST]),
  })

  const review = selectPlanReview(state, 'session-1')

  expect(review?.request.requestId).toBe('perm-plan-1')
  expect(review?.submitted).toBe(false)
  expect(review?.data.plan).toContain('Write the tests')
  expect(review?.data.planFilePath).toBe('/config/plans/kind-otter.md')
  // Malformed entries (missing `prompt`, or not an object at all) are dropped,
  // never crash the narrowing — degrade gracefully, never fabricate a shape.
  expect(review?.data.allowedPrompts).toEqual([
    { tool: 'Bash', prompt: 'run the test suite' },
  ])
})

test('selectPlanReview returns null fields for a request with no plan input', () => {
  const bareRequest = {
    requestId: 'perm-plan-2',
    request: {
      subtype: 'can_use_tool' as const,
      tool_name: EXIT_PLAN_MODE_TOOL_NAME,
      input: {},
      tool_use_id: 'toolu-plan-2',
    },
  }
  const state = reducePermissionState(createPermissionState(), {
    type: 'frame',
    frame: readyFrame([bareRequest]),
  })

  const review = selectPlanReview(state, 'session-1')

  expect(review?.data.plan).toBeNull()
  expect(review?.data.planFilePath).toBeNull()
  expect(review?.data.allowedPrompts).toEqual([])
})

test('selectNonPlanPermissionQueue excludes ExitPlanMode — PlanBar/PlanPanel own it', () => {
  const state = reducePermissionState(createPermissionState(), {
    type: 'frame',
    frame: readyFrame([BASH_REQUEST, PLAN_REQUEST]),
  })

  const queue = selectNonPlanPermissionQueue(state, 'session-1')

  expect(queue).toHaveLength(1)
  expect(queue[0]?.request.requestId).toBe('perm-bash-1')
})

test('parsePlanSteps derives real numbered/bulleted top-level list items', () => {
  expect(
    parsePlanSteps('1. First step\n2) Second step\n- Third step\n* Fourth step\nplain text ignored'),
  ).toEqual(['First step', 'Second step', 'Third step', 'Fourth step'])
})

test('parsePlanSteps returns an empty list for null/empty/unstructured plans', () => {
  expect(parsePlanSteps(null)).toEqual([])
  expect(parsePlanSteps('')).toEqual([])
  expect(parsePlanSteps('Just a paragraph of prose with no list markers.')).toEqual([])
})

test('the plan approval menu never offers bypassPermissions — rejected at the boundary (C2)', () => {
  const modes = PLAN_APPROVE_OPTIONS.map(option => option.mode)
  expect(modes).toEqual(['acceptEdits', 'default'])
  expect(modes).not.toContain('bypassPermissions')
})
