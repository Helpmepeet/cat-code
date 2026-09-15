import { expect, test } from 'bun:test'
import { createSidecarMcpLifecycleStartGate } from './mcpLifecycleStartGate.js'

test('an untrusted session waits for sidecar trust before starting MCP', () => {
  let starts = 0
  const gate = createSidecarMcpLifecycleStartGate({
    isWorkspaceTrusted: false,
    start: () => {
      starts++
    },
  })

  gate.onSocketReady()
  expect(starts).toBe(0)

  gate.onWorkspaceTrusted()
  gate.onWorkspaceTrusted()
  expect(starts).toBe(1)
})

test('an initially trusted session waits for socket readiness before starting MCP', () => {
  let starts = 0
  const gate = createSidecarMcpLifecycleStartGate({
    isWorkspaceTrusted: true,
    start: () => {
      starts++
    },
  })

  expect(starts).toBe(0)
  gate.onSocketReady()
  gate.onSocketReady()
  expect(starts).toBe(1)
})
