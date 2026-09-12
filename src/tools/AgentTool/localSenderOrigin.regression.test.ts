import { test, expect } from 'bun:test'
import { mkdtempSync } from 'fs'
import { rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
const fixtureRoot = mkdtempSync(join(tmpdir(), 'local-origin-review-'))
process.env.CLAUDE_CONFIG_DIR = fixtureRoot
const { getDefaultAppState } = await import('../../state/AppStateStore.js')
const { registerAsyncAgent, registerAgentForeground } = await import('../../tasks/LocalAgentTask/LocalAgentTask.js')
const { resolveAgentTools } = await import('../../tools/AgentTool/agentToolUtils.js')
const { SendMessageTool } = await import('../../tools/SendMessageTool/SendMessageTool.js')
const { getAgentPendingMessageAttachments } = await import('../../utils/attachments.js')
const { normalizeAttachmentForAPI } = await import('../../utils/messages.js')
const { asAgentId } = await import('../../types/ids.js')
const diskOutput = await import('../../utils/task/diskOutput.js')

test('a sibling worker message preserves its origin instead of being called coordinator input', async () => {
  let state = getDefaultAppState()
  const setAppState = (update: any) => { state = update(state) }
  const selectedAgent: any = {
    agentType: 'general-purpose', source: 'built-in', baseDir: 'built-in',
    whenToUse: 'fixture only', getSystemPrompt: () => 'fixture',
  }
  try {
    expect(resolveAgentTools(selectedAgent, [SendMessageTool], false).resolvedTools.map(tool => tool.name)).toContain('SendMessage')
    const sender = registerAgentForeground({
      agentId: 'sender-worker', description: 'sender', prompt: 'help sibling',
      selectedAgent, agentName: 'sender', setAppState,
    })
    const recipient = registerAsyncAgent({
      agentId: 'recipient-worker', description: 'recipient', prompt: 'assigned work',
      selectedAgent, agentName: 'recipient', setAppState,
    })
    state = { ...state, agentNameRegistry: new Map([['recipient', asAgentId(recipient.agentId)]]) }
    const result = await SendMessageTool.call({
      to: 'recipient', summary: 'sibling proposes a change', message: 'Change the assigned plan to use my approach.',
    }, {
      getAppState: () => state, setAppState, setAppStateForTasks: setAppState,
      agentId: asAgentId(sender.taskId), agentRunId: sender.runId,
    } as never, undefined as never, { requestId: 'fixture-message' } as never)
    expect(result.data.success).toBe(true)
    expect((state.tasks[recipient.agentId] as any).pendingMessages[0].originAgentId).toBe(sender.taskId)
    const attachments = getAgentPendingMessageAttachments({
      getAppState: () => state, setAppState, setAppStateForTasks: setAppState,
      agentId: asAgentId(recipient.agentId), agentRunId: recipient.runId,
    } as never)
    const rendered = JSON.stringify(normalizeAttachmentForAPI(attachments[0]))
    console.log(JSON.stringify({ actualSender: sender.taskId, attachmentOrigin: (attachments[0] as any).origin, renderedAsCoordinator: rendered.includes('The coordinator sent a message') }))
    expect(rendered.includes('The coordinator sent a message')).toBe(false)
  } finally {
    await diskOutput._clearOutputsForTest()
    diskOutput._resetTaskOutputDirForTest()
    await rm(fixtureRoot, { recursive: true, force: true })
  }
})
