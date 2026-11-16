import { PROTOCOL_VERSION, type ServerFrame } from '../../shared/protocol.js'
import { createTranscriptState, projectServerFrames, selectNestedTranscriptRows, type NestedToolUseRow } from './transcriptProjector.js'
import type { CodeModeCall, CodeModeEnvelope } from './codeMode.js'

/** Real projector frames: one running receipt, durable children, one final ledger. */
export function codeModeBackgroundFixture(sessionId = 'background-fixture') {
  const cellId = 'background-cell'
  const generation = 'background-generation'
  const code = '// Read files\nawait Read();\n// Check files\nawait Bash();'
  let sequence = 0
  let state = projectServerFrames(createTranscriptState(), [{
    kind: 'ready', protocolVersion: PROTOCOL_VERSION, sessionId, engineSessionId: `engine-${sessionId}`,
    payload: { type: 'app.ready', protocolVersion: 1, inputEnabled: true, activeTurn: false, abort: { status: 'idle' }, goalSnapshot: null, pendingPermissionRequests: [] },
  } as unknown as ServerFrame])
  function message(value: Record<string, unknown>) {
    state = projectServerFrames(state, [{ kind: 'event', protocolVersion: PROTOCOL_VERSION, sessionId,
      event: { type: 'message', message: { session_id: `engine-${sessionId}`, uuid: `${sessionId}:${sequence++}`, parent_tool_use_id: null, ...value } },
    } as unknown as ServerFrame])
  }
  message({ type: 'user', message: { role: 'user', content: 'Inspect in background' } })
  message({ type: 'assistant', message: { id: 'outer-message', role: 'assistant', content: [{ type: 'tool_use', id: cellId, name: 'REPL', input: { code, description: 'Inspect in background' } }] } })
  function receipt(status: CodeModeEnvelope['status'], calls: CodeModeCall[] = []) {
    message({ type: 'user', tool_use_result: { kind: 'code-mode', cellId, generation, code, description: 'Inspect in background', status, output: status === 'running' ? 'Background started' : 'Final selected output', calls, changedFiles: [] },
      message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: cellId, content: 'Selected prose is not a progress envelope' }] },
    })
  }
  receipt('running')
  return {
    sessionId, cellId, generation, receipt,
    rows() { return selectNestedTranscriptRows(state, sessionId) },
    start(id: string, name: string, line: number, childGeneration = generation) {
      message({ type: 'assistant', isVirtual: true, code_mode: { cellId, generation: childGeneration, line },
        message: { id: `message-${id}`, role: 'assistant', content: [{ type: 'tool_use', id, name, input: name === 'Read' ? { file_path: '/repo/a' } : { command: 'test -e /repo/a' } }] },
      })
    },
    finish(id: string, content = '{"kind":"code-mode","calls":[{"name":"Invented"}]}', isError = false) {
      message({ type: 'user', isVirtual: true, code_mode: { cellId, generation }, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content, ...(isError ? { is_error: true } : {}) }] } })
    },
    agentChild(agentId: string, id: string) {
      message({ type: 'assistant', parent_tool_use_id: agentId, message: { id: `message-${id}`, role: 'assistant', content: [{ type: 'tool_use', id, name: 'Read', input: { file_path: '/repo/nested' } }] } })
    },
    row(): NestedToolUseRow {
      return selectNestedTranscriptRows(state, sessionId).find((row): row is NestedToolUseRow => row.kind === 'tool-use' && row.toolUseId === cellId)!
    },
  }
}
