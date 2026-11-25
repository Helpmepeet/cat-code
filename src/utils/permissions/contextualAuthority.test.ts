import { expect, test } from 'bun:test'
import type { ToolUseContext } from '../../Tool.js'
import { asAgentId } from '../../types/ids.js'
import type { Message } from '../../types/message.js'
import { createAssistantMessage, createUserMessage } from '../messages.js'
import { readContextualAuthority, workerAssignment } from './contextualAuthority.js'
import { buildContextualReview } from './contextualReviewer.js'
import { capturePriorAssistantContext } from './priorAssistantContext.js'

for (const tool of ['Agent', 'Task']) {
  test(`${tool} commit restriction appears only in the intended worker assignment`, () => {
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
    expect(lead.conversation).toEqual([{ id: grant.uuid, origin: 'operator', text: job }])
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

test('the release snapshot keeps full linked proposals and selected-option prose when the reviewer view does not', () => {
  const proposalText = 'Review option one first. ' + 'x'.repeat(2_000)
  const selectedText = 'I will review option one.'
  const proposal = createAssistantMessage({ content: proposalText })
  const selected = createAssistantMessage({ content: selectedText })
  proposal.message.model = selected.message.model = 'claude-sonnet-5-5'
  const reply = createUserMessage({
    content: 'Your choice.',
    priorAssistantContext: capturePriorAssistantContext([proposal]) ?? undefined,
  })
  const context = { messages: [proposal, reply, selected], abortController: new AbortController() } as ToolUseContext
  const authority = readContextualAuthority(context)
  const built = buildContextualReview({
    action: { tool: 'Bash', effect: 'Inspect fixture', input: {}, actor: 'main', cwd: '/fixture', attempt: 'call' },
    conversation: authority.conversation,
  }, { provider: 'openai', model: 'gpt-6-luna' })
  expect(JSON.parse(String(built?.options.messages[0]?.content)).conversation).toEqual([
    { origin: 'operator', id: reply.uuid, text: 'Your choice.',
      proposal: { id: proposal.uuid, text: 'x'.repeat(2_000), truncated: true } },
  ])
  expect(readContextualAuthority(context)).toEqual(authority)
  expect(authority.conversation).toEqual([
    { origin: 'operator', id: reply.uuid, text: 'Your choice.', proposal: { id: proposal.uuid, text: proposalText } },
    { origin: 'assistant', id: selected.uuid, actor: 'main', text: selectedText },
  ])
})
