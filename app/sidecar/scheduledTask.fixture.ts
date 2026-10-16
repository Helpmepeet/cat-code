// Transport fixture: the real controller and receiving boundary, without an account or model request.
;(globalThis as unknown as { MACRO: unknown }).MACRO = { VERSION: 'test', BUILD_TIME: '', PACKAGE_URL: '', FEEDBACK_CHANNEL: '' }
const { AppSessionController } = await import('../../src/app-runtime/AppSessionController.js')
const { SidecarServer } = await import('./sidecarServer.js')
const { randomUUID } = await import('node:crypto')
const { writeFileSync } = await import('node:fs')
const { join } = await import('node:path')
const sessionId = process.env.CATCODE_SIDECAR_SESSION_ID!
writeFileSync(join(process.cwd(), `.scheduled-controls-${sessionId}.json`), JSON.stringify({
  model: process.env.CATCODE_SIDECAR_MODEL, effort: process.env.CATCODE_SIDECAR_EFFORT, permissionMode: process.env.CATCODE_SIDECAR_PERMISSION_MODE,
}))
const controller = new AppSessionController({
  async *runTurn({ prompt, options, onPermissionRequest }) {
    await options?.onInputPersisted?.()
    const responses = await Promise.all(['scheduled-permission', 'scheduled-permission-two'].map(requestId =>
      onPermissionRequest({ requestId, request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'pwd' }, tool_use_id: requestId } })))
    yield { type: 'result', subtype: 'success', is_error: responses.some(response => response.behavior !== 'allow'), result: String(prompt), session_id: sessionId, uuid: randomUUID(), duration_ms: 1, duration_api_ms: 0, num_turns: 1, total_cost_usd: 0, usage: { input_tokens: 0, output_tokens: 0 }, modelUsage: {}, permission_denials: [] } as never
    // Result emission precedes the actual close of this controller turn.
    await Bun.sleep(30)
  },
})
const server = new SidecarServer({ sessionId, engineSessionId: randomUUID(), controller, log: () => {},
  workspaceTrust: { getSnapshot: () => ({ trusted: process.env.SCHEDULED_FIXTURE_TRUSTED === '1', detectedRepo: null, trustRoot: process.cwd() }), acceptTrust: () => ({ ok: false, changed: false, message: 'Fixture trust is fixed' }) } })
const connections = new Map<object, ReturnType<typeof server.addConnection>>()
Bun.listen({ unix: process.env.CATCODE_SIDECAR_SOCKET!, socket: {
  open(socket) { connections.set(socket, server.addConnection({ write(bytes, flushed) { socket.write(bytes); flushed?.() }, end() { socket.end() } })) },
  data(socket, bytes) { const connection = connections.get(socket); if (connection) server.handleData(connection, Buffer.from(bytes)) },
  close(socket) { const connection = connections.get(socket); if (connection) server.removeConnection(connection); connections.delete(socket) },
} })
