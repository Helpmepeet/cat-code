import { expect, test } from 'bun:test'
import type { SessionDescriptor } from '../../shared/hostApi.js'
import { createConnectionState } from './connectionState.js'
import { createPermissionState, type PermissionState } from './permissionState.js'
import {
  createShellState,
  reduceShellState,
  type ShellState,
} from './shellState.js'
import { buildDebugShellStateSnapshot } from './debugStateReport.js'
import { parseDebugSnapshot } from '../../main/devHarness.js'
import { sessionDescriptorFixture } from '../../shared/sessionDescriptor.fixture.js'

test('a full registry roster exports an accepted sidebar sample retaining the active session', () => {
  for (const [count, activeIndex] of [
    [128, 0], [129, 0], [241, 0], [256, 0], [256, 255], [256, null],
  ] as const) {
    let shell = createShellState()
    const activeSessionId = activeIndex === null
      ? null
      : `00000000-0000-4000-8000-${activeIndex.toString(16).padStart(12, '0')}`
    for (let index = 0; index < count; index++) {
      shell = reduceShellState(shell, {
        type: 'session-added',
        session: sessionDescriptorFixture({
          appSessionId: `00000000-0000-4000-8000-${index.toString(16).padStart(12, '0')}`,
          cwd: '/tmp/work',
          createdAt: index,
          restorable: index !== 0,
          status: index === 0 ? 'ready' : 'exited',
        }),
      })
    }
    const snapshot = buildDebugShellStateSnapshot({
      shell,
      connection: createConnectionState(),
      permissions: createPermissionState(),
      activeSessionId,
      now: () => 123,
    })

    const parsed = parseDebugSnapshot(snapshot)
    expect(parsed.ok ? 'accepted' : parsed.error).toBe('accepted')
    expect(snapshot.rendererStateAt).toBe(123)
    expect(snapshot.renderer.activeSessionId).toBe(activeSessionId)
    expect(snapshot.renderer.sidebar).toHaveLength(128)
    const lastIndex = activeIndex === 0 ? 0 : count - 128
    expect(snapshot.renderer.sidebar.at(-1)?.appSessionId).toBe(
      `00000000-0000-4000-8000-${lastIndex.toString(16).padStart(12, '0')}`,
    )
    if (activeSessionId !== null) {
      expect(snapshot.renderer.sidebar.some(row => row.appSessionId === activeSessionId)).toBe(true)
    }
    expect(snapshot.renderer.sidebar[0]?.appSessionId).toBe(
      `00000000-0000-4000-8000-${(count - 1).toString(16).padStart(12, '0')}`,
    )
    expect(snapshot.renderer.tabs.map(tab => tab.appSessionId)).toEqual([
      '00000000-0000-4000-8000-000000000000',
    ])
    expect(shell.order).toHaveLength(count)
  }
})

const sessionA: SessionDescriptor = {
  appSessionId: '00000000-0000-4000-8000-0000000000aa',
  engineSessionId: 'engine-a',
  cwd: '/Users/pt/catcode-gui-scratch',
  title: 'Scratch',
  forked: false,
  name: null,
  createdBy: null,
  peerWakeBlocked: false,
  titleUpdatedAt: null,
  status: 'ready',
  restorable: false,
  parked: false,
  createdAt: 1,
  lastAttachedAt: 2,
  lastMessageSentAt: null,
}

const sessionB: SessionDescriptor = {
  ...sessionA,
  appSessionId: '00000000-0000-4000-8000-0000000000bb',
  engineSessionId: 'engine-b',
  cwd: '/Users/pt/other',
  title: null,
  status: 'disconnected',
  restorable: true,
  parked: false,
  createdAt: 3,
  lastAttachedAt: 9,
}

test('debug snapshot mirrors tab/sidebar selectors and visible permission strings', () => {
  let shell: ShellState = createShellState()
  shell = reduceShellState(shell, { type: 'session-added', session: sessionA })
  shell = reduceShellState(shell, { type: 'session-added', session: sessionB })

  const permissions: PermissionState = {
    sessions: {
      [sessionA.appSessionId]: {
        pending: [{
        requestId: 'perm-1',
        request: {
          subtype: 'can_use_tool',
          tool_name: 'Bash',
          display_name: 'Shell',
          title: 'Run command?',
          input: { command: 'date' },
          tool_use_id: 'toolu-1',
          permission_suggestions: [
            {
              type: 'addRules',
              behavior: 'allow',
              destination: 'userSettings',
              rules: [{ toolName: 'Bash', ruleContent: 'date' }],
            },
            {
              type: 'addRules',
              behavior: 'deny',
              destination: 'session',
              rules: [{ toolName: 'Bash', ruleContent: 'rm:*' }],
            },
          ],
        },
      }],
        dismissedRequestIds: [],
        submittedRequestIds: [],
        context: null,
        lastMode: null,
      },
    },
  }
  const connection = createConnectionState()

  const snapshot = buildDebugShellStateSnapshot({
    shell,
    connection,
    permissions,
    activeSessionId: sessionA.appSessionId,
    now: () => 123,
  })

  expect(snapshot.debugStateVersion).toBe(1)
  expect(snapshot.rendererStateAt).toBe(123)
  expect(snapshot.renderer.activeSessionId).toBe(sessionA.appSessionId)
  expect(snapshot.renderer.tabs).toEqual([
    {
      appSessionId: sessionA.appSessionId,
      title: 'Scratch',
      // Unified status vocabulary (audit §I.2): a ready tab reads as `live`.
      label: 'live',
      tone: 'live',
      restartable: false,
      needsAttention: false,
    },
  ])
  // Sidebar rows order by lastMessageSentAt→createdAt DESC (sidebarState.ts):
  // sessionB (createdAt 3) sorts ahead of sessionA (createdAt 1), so B is
  // sidebar[0]; lastAttachedAt never drives order.
  expect(snapshot.renderer.sidebar[0]).toMatchObject({
    appSessionId: sessionB.appSessionId,
    title: 'other',
    subtitle: 'other',
    kind: 'restorable',
    label: 'crashed',
    tone: 'dead',
    restorable: true,
  })
  expect(snapshot.renderer.permissions[sessionA.appSessionId]).toEqual({
    mode: 'default',
    pending: [
      {
        requestId: 'perm-1',
        toolName: 'Bash',
        displayTitle: 'Run command?',
        toolDisplayName: 'Shell',
        suggestionLabels: [
          "Yes, and don't ask again for Bash(date) · User settings",
          'Yes, and always block Bash(rm:*) · This session',
        ],
      },
    ],
  })
})
