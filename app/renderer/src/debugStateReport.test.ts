import { expect, test } from 'bun:test'
import type { SessionDescriptor } from '../../shared/hostApi.js'
import { createConnectionState } from './connectionState.js'
import type { PermissionState } from './permissionState.js'
import {
  createShellState,
  reduceShellState,
  type ShellState,
} from './shellState.js'
import { buildDebugShellStateSnapshot } from './debugStateReport.js'

const sessionA: SessionDescriptor = {
  appSessionId: '00000000-0000-4000-8000-0000000000aa',
  engineSessionId: 'engine-a',
  cwd: '/Users/pt/catcode-gui-scratch',
  title: 'Scratch',
  titleUpdatedAt: null,
  status: 'ready',
  restorable: false,
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
        suggestionLabels: ['Always allow: allow Bash(date) · User settings'],
      },
    ],
  })
})
