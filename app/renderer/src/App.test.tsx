import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  App,
  ConnectionRecovery,
  buildDebugExport,
  sendPermissionResponse,
} from './App.js'

test('renders the live prompt input, permission surface, projected transcript, and raw SDKMessage dump', () => {
  const html = renderToStaticMarkup(<App />)

  expect(html).toContain('aria-label="Prompt"')
  expect(html).toContain('Copy for LLM')
  expect(html).toContain('aria-label="Permission requests"')
  expect(html).toContain('Transcript (projected)')
  expect(html).toContain('<pre')
  expect(html).toContain('Raw SDKMessage events')
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
