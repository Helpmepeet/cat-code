import { open, readFile } from 'fs/promises'
import type { UUID } from 'crypto'
import type { ToolUseContext } from '../../Tool.js'
import type { Message } from '../../types/message.js'
import { getSessionId, isSessionPersistenceDisabled } from '../../bootstrap/state.js'
import { getAgentTranscriptPath, recordSidechainTranscript, flushSessionStorage } from '../../utils/sessionStorage.js'
import { logError } from '../../utils/log.js'
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
  const persistedReceipts = new WeakSet<Message>()
  const recordingFinished = new Promise<void>(resolve => { finish = resolve })
  const lease = owner.attach(async (message, isCurrent) => {
    await recordingFinished
    if (!isCurrent() || getSessionId() !== sessionId) throw new Error('Agent receipt owner changed')
    if (!isSessionPersistenceDisabled() && !persistedReceipts.has(message)) {
      const history = options.getHistory?.()
      const snapshot = history && !historySeeded
        ? [...history.filter(row => row.uuid !== message.uuid), message]
        : [message]
      await recordSidechainTranscript(
        snapshot,
        agentId, history && !historySeeded ? undefined : options.getParent(),
      )
      await flushSessionStorage()
      if (message.type === 'user' && message.sourceToolAssistantUUID) {
        const rows = (await readFile(path, 'utf8')).split('\n').filter(Boolean).map(line => JSON.parse(line))
        if (!rows.some(row => row.uuid === message.sourceToolAssistantUUID)) throw new Error('The original agent tool request is unavailable')
      }
      const handle = await open(path, 'r+')
      try { await handle.sync() } finally { await handle.close() }
      historySeeded = true
      persistedReceipts.add(message)
    }
    if (!isCurrent() || getSessionId() !== sessionId) throw new Error('Agent receipt owner changed')
    await options.publish?.(message)
    options.setParent(message.uuid as UUID)
  })
  context.interruptedToolRun = owner
  return {
    owner,
    async finish(cleanup: () => void | Promise<void> = () => {}): Promise<void> {
      finish()
      await codeModeHost.close()
      const release = async () => { try { await cleanup() } finally { lease.dispose() } }
      if (owner.ownPending) void owner.whenSettled().then(release).catch(logError)
      else await release()
    },
  }
}
