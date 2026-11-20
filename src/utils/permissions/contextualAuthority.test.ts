import { expect, test } from 'bun:test'
import type { ToolUseContext } from '../../Tool.js'
import { asAgentId } from '../../types/ids.js'
import type { Message } from '../../types/message.js'
import { createUserMessage } from '../messages.js'
import { readContextualAuthority, workerAssignment } from './contextualAuthority.js'

for (const tool of ['Agent', 'Task']) {
  test(`${tool} commit restriction keeps its sender and intended worker`, () => {
    const job = 'Fix the layout and commit the verified change.'
    const grant = createUserMessage({ content: job })
    const brief = 'Fix layout.ts. Do not commit. I will inspect and commit.'
    const request: Message = {
      type: 'assistant', uuid: 'dispatch', message: { role: 'assistant', content: [
        { type: 'tool_use', name: tool, id: 'launch', input: { prompt: brief } },
      ] },
    }
    const parent = { messages: [grant, request], abortController: new AbortController() } as ToolUseContext
    const lead = readContextualAuthority(parent)
    expect(lead.conversation).toContainEqual({
      id: 'launch', origin: 'assistant', actor: lead.actor, recipient: 'requested worker', text: brief,
    })
    expect(lead.assignment).toBeUndefined()

    const worker = readContextualAuthority({
      ...parent, agentId: asAgentId('worker-id'),
      contextualWorkerAssignment: workerAssignment(parent, parent.messages, brief),
    })
    expect(worker.assignment).toMatchObject({ origin: 'worker-launch', sender: lead.actor, actor: worker.actor, text: brief })
    expect(worker.assignment?.parent).toContainEqual({ origin: 'operator', id: grant.uuid, text: job })
    expect(worker.conversation).toEqual([])
    expect(readContextualAuthority({ ...parent, messages: [request] }).verifiedSource).toBe(false)
  })
}
