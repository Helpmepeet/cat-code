import type { ServerFrame } from '../shared/protocol.js'
import { PROTOCOL_VERSION } from '../shared/protocol.js'
import { createTranscriptState, projectServerFrames, selectNestedTranscriptRows, type NestedTranscriptRow } from '../renderer/src/transcriptProjector.js'
import { claimTurnRetry, retryableTurn } from '../renderer/src/turnFailure.js'

/** Retains only the latest prompt's retry facts, not a second transcript. */
export function createDesktopNotificationRetry() {
  let rows: NestedTranscriptRow[] = []
  const claimed = new Set<string>()
  let overflow = false
  let live = false
  let awaitingTurn = false
  const candidate = () => {
    const result = [...rows].reverse().find(row => row.kind === 'result')
    if (result?.kind !== 'result' || (result.subtype !== 'error_during_execution' && result.subtype !== 'error_auth_required')) return null
    const value = retryableTurn(rows)
    return value && !claimed.has(value.resultId) ? value : null
  }
  return {
    reset(liveTurn = true) { rows = []; overflow = false; live = liveTurn; awaitingTurn = false },
    startTurn() {
      // SidecarServer announces the new prompt before the controller starts.
      // Automatic turns have no announcement and must not reuse older input.
      if (!awaitingTurn) { rows = []; overflow = false }
      live = true
      awaitingTurn = false
    },
    observe(frame: ServerFrame, activeTurn = false) {
      if (frame.kind !== 'event' || frame.event.type !== 'message' || frame.recovered || (frame.replay && live)) return
      const message = frame.event.message
      if (message.parent_tool_use_id || (!frame.replay && 'isReplay' in message && message.isReplay)) return
      if (!frame.replay) live = true
      if (message.type !== 'user' && message.type !== 'result' && message.type !== 'assistant') return
      // A fresh projector transaction uses the production row IDs and origin/image
      // classification, without retaining tool output, images or streaming state.
      const ready: ServerFrame = {
        kind: 'ready', protocolVersion: PROTOCOL_VERSION, sessionId: frame.sessionId,
        engineSessionId: 'notification-observer', payload: { type: 'app.ready', protocolVersion: 1, inputEnabled: true, activeTurn: false, abort: { status: 'idle' }, goalSnapshot: null, pendingPermissionRequests: [] },
      }
      const projected = selectNestedTranscriptRows(projectServerFrames(createTranscriptState(), [ready, frame]), frame.sessionId)
      const facts = projected.filter(row => ['user-text', 'user-image', 'injected-turn', 'command-echo', 'turn-stopped', 'result', 'assistant-text'].includes(row.kind)).map(row =>
        row.kind === 'result'
          ? { ...row, result: undefined, errors: [], providerCode: undefined, providerMessage: undefined }
          : row,
      )
      if (message.type === 'user') {
        const content: unknown = message.message?.content
        const toolResult = Array.isArray(content) && content.some(block => typeof block === 'object' && block !== null && 'type' in block && block.type === 'tool_result')
        if (toolResult) return
        awaitingTurn = !frame.replay && !activeTurn
        rows = []; overflow = facts.length > 32
      }
      if (message.type === 'result') awaitingTurn = false
      if (overflow) return message.type === 'assistant' ? projected : undefined
      // Images and injected turns are barriers only. Never retain their payload.
      if (facts.some(row => row.kind === 'user-image' || row.kind === 'injected-turn' || row.kind === 'command-echo' || row.kind === 'turn-stopped')) { rows = []; overflow = true; return }
      if (message.type === 'assistant') {
        if (rows.some(row => row.kind === 'result') && facts.some(row => row.kind === 'assistant-text')) rows = []
        return projected
      }
      if (message.type === 'result') rows = rows.filter(row => row.kind !== 'result')
      rows.push(...facts)
      if (rows.length > 32) { rows = []; overflow = true }
    },
    candidate,
    claim(resultId: string) {
      const value = candidate()
      if (!value || value.resultId !== resultId || !claimTurnRetry(claimed, resultId)) return null
      return value
    },
  }
}
