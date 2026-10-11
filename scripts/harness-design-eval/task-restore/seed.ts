// Runs once per case before either arm. No provider can be called here.
globalThis.fetch = Object.assign(async () => { throw Error('Seed forbids network') }, { preconnect: () => {} }) as typeof fetch
import { randomUUID } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { fixture, investigation } from './fixtures.js'
import { switchSession } from '../../../src/bootstrap/state.js'
import { asSessionId } from '../../../src/types/ids.js'
import { createAssistantMessage, createUserMessage } from '../../../src/utils/messages.js'
import { recordTranscript, flushCurrentTranscriptDurably, markActiveConversationTip } from '../../../src/utils/sessionStorage.js'
import { releaseActiveTranscriptLease } from '../../../src/utils/transcriptLease.js'
import { TaskCreateTool } from '../../../src/tools/TaskCreateTool/TaskCreateTool.js'
import { createTask, getTaskListId, updateTask } from '../../../src/utils/tasks.js'
import { getDefaultAppState } from '../../../src/state/AppStateStore.js'
import type { ToolUseContext } from '../../../src/Tool.js'
import type { Message } from '../../../src/types/message.js'

const f = fixture(process.argv[2]!)
const id = process.argv[3]!
switchSession(asSessionId(id))
let state = getDefaultAppState()
const messages: Message[] = [createUserMessage({ content: f.request })]
const trackingIds: string[] = []
const context = { getAppState: () => state, setAppState: (fn: (s: typeof state) => typeof state) => { state = fn(state) }, abortController: new AbortController() } as ToolUseContext
async function toolRound(tool: typeof TaskCreateTool, input: any) {
  const call = randomUUID()
  const result = await tool.call(input, context as never)
  const assistant = createAssistantMessage({ content: [{ type: 'tool_use', id: call, name: tool.name, input }] })
  const output = createUserMessage({ content: [tool.mapToolResultToToolResultBlockParam(result.data as never, call)] })
  messages.push(assistant, output)
  trackingIds.push(call)
  return result.data
}
for (const subject of f.pending) await toolRound(TaskCreateTool, { subject, description: subject, activeForm: subject })
{
  // Real persisted counterexamples: completed work and work owned elsewhere.
  // Completion must win even when a successful tracked create is in the
  // summarized request. Unrelated unowned work tests evidence scoping without
  // relying on the foreign-owner filter to reject it.
  const completed = await toolRound(TaskCreateTool, { subject: 'Delete archive/ledger.csv', description: 'Obsolete cleanup', activeForm: 'Deleting obsolete archive' })
  await createTask(getTaskListId(), { subject: 'Unrelated unowned task', description: 'Another request', status: 'pending', blocks: [], blockedBy: [] })
  const foreign = await createTask(getTaskListId(), { subject: 'Replace invoice export with XML', description: 'Other agent request', status: 'pending', blocks: [], blockedBy: [], owner: 'other-agent' })
  await updateTask(getTaskListId(), completed.task.id, { status: 'completed' })
  await updateTask(getTaskListId(), foreign, { owner: 'other-agent' })
}
for (let i = 0; i < (f.long ? 24 : 2); i++) {
  const call = randomUUID()
  messages.push(createAssistantMessage({ content: [{ type: 'tool_use', id: call, name: 'Read', input: { file_path: `${process.cwd()}/investigation/batch-${i}.txt` } }] }),
    createUserMessage({ content: [{ type: 'tool_result', tool_use_id: call, content: investigation(i, f.id) }] }),
    createAssistantMessage({ content: `Batch ${i} inspected. ${f.observation}` }))
}
if (f.redirect) messages.push(createUserMessage({ content: f.correction }), createAssistantMessage({ content: 'The earlier repair is cancelled. I will perform the read-only review and preserve existing files.' }))
await recordTranscript(messages)
await markActiveConversationTip(messages.at(-1)!.uuid as never)
await flushCurrentTranscriptDurably()
writeFileSync(process.argv[4]!, JSON.stringify({ sessionId: id, trackingIds, messages: messages.length, mode: f.mode, reconstruction: true }))
await releaseActiveTranscriptLease()
process.exit(0)
