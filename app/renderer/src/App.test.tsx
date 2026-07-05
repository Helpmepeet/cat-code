import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  App,
  ConnectionRecovery,
  SessionPane,
  buildDebugExport,
  sendPermissionResponse,
} from './App.js'
import { createTranscriptState } from './transcriptProjector.js'

test('renders the shell frame (TabBar + empty state) before any session exists', () => {
  // SSR runs no effects, so the host list never resolves — the shell mounts
  // with an empty roster. The frame is still whole: the TabBar chrome and a
  // new-session affordance are present, and the empty state invites the first
  // session (HC1 — created only via the picker, never a typed path).
  const html = renderToStaticMarkup(<App />)

  expect(html).toContain('role="tablist"')
  expect(html).toContain('aria-label="Sessions"')
  expect(html).toContain('aria-label="New session"')
  expect(html).toContain('No sessions open.')
  // No active-session pane chrome without a session.
  expect(html).not.toContain('aria-label="Prompt"')
  expect(html).not.toContain('Transcript (projected)')
})

test('the active session pane renders the P2 transcript spine + prompt unchanged', () => {
  const html = renderToStaticMarkup(
    <SessionPane
      activeConnection={{ status: 'ready', inputEnabled: true }}
      activeDescriptor={{
        appSessionId: 'session-1',
        engineSessionId: 'engine-1',
        cwd: '/tmp/project',
        title: null,
        status: 'ready',
        restorable: false,
        createdAt: 0,
        lastAttachedAt: 0,
      }}
      activeLog={{
        inputEnabled: true,
        messages: [],
        retainedBytes: 0,
        truncated: false,
        error: null,
        messageBytes: [],
      }}
      activeSessionId="session-1"
      allowPermission={() => {}}
      copyForLlm={() => {}}
      denyPermission={() => {}}
      partialCount={0}
      permissionContext={null}
      permissionQueue={[]}
      prompt=""
      restorePermission={() => {}}
      setPermissionMode={() => {}}
      setPrompt={() => {}}
      submit={() => {}}
      transcript={createTranscriptState()}
      transportError={null}
    />,
  )

  expect(html).toContain('aria-label="Prompt"')
  expect(html).toContain('Copy for LLM')
  expect(html).toContain('Permissions')
  expect(html).toContain('Transcript (projected)')
  expect(html).toContain('<pre')
  expect(html).toContain('Raw SDKMessage events')
  // The pane surfaces the active session's cwd in its header.
  expect(html).toContain('/tmp/project')
})

test('debug export explicitly marks lossy raw-message retention', () => {
  const text = buildDebugExport([], {
    inputEnabled: true,
    messages: [{ type: 'result', subtype: 'success' }],
    retainedBytes: 42,
    truncated: true,
    error: null,
    messageBytes: [42],
  })

  expect(text).toContain('Raw retention: TRUNCATED')
  expect(text).toContain('"type": "result"')
})

test('renders a restart control only for a terminal session state', () => {
  const terminal = renderToStaticMarkup(
    <ConnectionRecovery
      connection={{ status: 'disconnected', inputEnabled: false }}
      sessionId="session-1"
    />,
  )
  const ready = renderToStaticMarkup(
    <ConnectionRecovery
      connection={{ status: 'ready', inputEnabled: true }}
      sessionId="session-1"
    />,
  )

  expect(terminal).toContain('Restart')
  expect(ready).not.toContain('Restart')
})

test('permission bridge failures are returned to the caller for reducer recovery', () => {
  const error = sendPermissionResponse(
    {
      respondPermission() {
        throw new Error('renderer IPC rate limit exceeded')
      },
    },
    'session-1',
    'perm-1',
    { behavior: 'allow', updatedInput: {} },
  )

  expect(error).toBe('renderer IPC rate limit exceeded')
})
