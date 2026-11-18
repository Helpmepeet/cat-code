import { open } from 'fs/promises'
import type { UUID } from 'crypto'
import type { ToolUseContext } from '../../Tool.js'
import type { Message } from '../../types/message.js'
import { getSessionId, isSessionPersistenceDisabled } from '../../bootstrap/state.js'
import { getAgentTranscriptPath, recordSidechainTranscript, flushSessionStorage, loadTranscriptFile } from '../../utils/sessionStorage.js'
import { logError } from '../../utils/log.js'
import { isENOENT } from '../../utils/errors.js'
import { getInterruptedToolRun, UNRESOLVED_TOOL_MESSAGE } from './interruptedToolRun.js'
import { CodeModeHost } from '../../tools/REPLTool/codeModeHost.js'

/** A child owns its sidechain and cleanup even after its foreground generator returns. */
export function createAgentInterruptedTools(context: ToolUseContext, options: {
  getParent: () => UUID | null
  setParent: (uuid: UUID) => void
  publish?: (message: Message) => void | Promise<void>
  getHistory?: () => Message[]
}) {
  if (!context.agentId) throw new Error('Interrupted child tools require an agent identity')
  const sessionId = getSessionId()
  const codeModeHost = new CodeModeHost()
  context.codeModeHost = codeModeHost
  context.onCodeModeAudit = undefined
  context.getCodeModeDispatchFence = undefined
  context.codeModeModelEpoch = undefined
  context.codeModeBackgroundCell = false
  context.publishCodeModeActivity = options.publish
  const agentId = context.agentId
  const path = getAgentTranscriptPath(agentId)
  const owner = getInterruptedToolRun(sessionId, agentId)
  if (owner.ownPending) throw new Error(UNRESOLVED_TOOL_MESSAGE)
  let finish!: () => void
  let historySeeded = false
  let recordedRows: Map<string, Message['type']> | undefined
  const appendingReceipts = new Set<string>()
  const recordingFinished = new Promise<void>(resolve => { finish = resolve })
  const lease = owner.attach(async (message, isCurrent) => {
    await recordingFinished
    if (!isCurrent() || getSessionId() !== sessionId) throw new Error('Agent receipt owner changed')
    if (!isSessionPersistenceDisabled()) {
      try {
        // The query loop may already have appended one or more of these UUIDs.
        // Only new rows can move the recording tip; reparenting existing rows
        // at worker shutdown can make the original chain cyclic.
        if (!recordedRows) {
          await flushSessionStorage()
          recordedRows = new Map()
          try {
            const loaded = await loadTranscriptFile(path, { keepAllLeaves: true, keepCompactedHistory: true, strict: true })
            if (loaded.sourceTruncated) throw new Error('The agent transcript is incomplete')
            for (const row of loaded.messages.values()) {
              if (row.isSidechain && row.sessionId === sessionId && row.agentId === agentId) {
                recordedRows.set(row.uuid, row.type)
              }
            }
          } catch (error) { if (!isENOENT(error)) throw error }
        }
        const history = !historySeeded ? options.getHistory?.() : undefined
        const seed = history?.filter(row => row.uuid !== message.uuid && !recordedRows!.has(row.uuid)) ?? []
        if (message.type === 'user' && message.sourceToolAssistantUUID &&
            recordedRows.get(message.sourceToolAssistantUUID) !== 'assistant' &&
            !seed.some(row => row.type === 'assistant' && row.uuid === message.sourceToolAssistantUUID)) {
          throw new Error('The original agent tool request is unavailable')
        }
        if (!recordedRows.has(message.uuid)) {
          appendingReceipts.add(message.uuid)
          const snapshot = [...seed, message]
          const parent = history && recordedRows.size === 0 ? undefined : options.getParent()
          await recordSidechainTranscript(snapshot, agentId, parent)
          await flushSessionStorage()
          for (const row of snapshot) recordedRows.set(row.uuid, row.type)
        }
        const handle = await open(path, 'r+')
        try { await handle.sync() } finally { await handle.close() }
        historySeeded = true
      } catch (error) {
        // A failed flush or sync can still leave the row on disk.
        recordedRows = undefined
        throw error
      }
    }
    if (!isCurrent() || getSessionId() !== sessionId) throw new Error('Agent receipt owner changed')
    if (appendingReceipts.delete(message.uuid)) options.setParent(message.uuid as UUID)
    await options.publish?.(message)
  })
  context.interruptedToolRun = owner
  return {
    owner,
    async finish(cleanup: () => void | Promise<void> = () => {}): Promise<void> {
      finish()
      const release = async () => { try { await cleanup() } finally { lease.dispose() } }
      try { await codeModeHost.close() }
      catch (error) {
        logError(error)
        void codeModeHost.whenBackgroundDelivered().then(() => owner.whenSettled()).then(release).catch(logError)
        return
      }
      if (owner.ownPending) void owner.whenSettled().then(release).catch(logError)
      else await release()
    },
  }
}
