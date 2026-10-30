import { expect, test } from 'bun:test'
import type { UUID } from 'node:crypto'
import { PendingQuestionRegistry } from './pendingQuestions.js'
import { questionReplyOrigin, questionReplyPrompt } from './pendingQuestionRuntime.js'
import { getQueuedCommandAttachments } from './attachments.js'
import { normalizeAttachmentForAPI, wrapCommandText } from './messages.js'
import type { QueuedCommand } from '../types/textInputTypes.js'
import { enqueue, resetCommandQueue } from './messageQueueManager.js'
import { processQueueIfReady } from './queueProcessor.js'
import { toSDKMessageOrigin } from './messages/mappers.js'

const question = { question: 'Which layout?', multiSelect: false, options: [{ label: 'Local', description: 'Disk', preview: '<div>Chosen layout</div>' }, { label: 'Remote', description: 'Server' }] }

test('a cleared conversation cannot consume an answer owned by the previous engine session', async () => {
  resetCommandQueue()
  const received: QueuedCommand[][] = []
  const origin = { kind: 'question-reply' as const, batchId: 'old', engineSessionId: 'previous-engine', questions: [{ toolUseId: 'old-call', questionIndex: 0 }] }
  enqueue({ mode: 'prompt', value: 'old answer', origin })
  enqueue({ mode: 'prompt', value: 'new task' })
  processQueueIfReady({ executeInput: async commands => { received.push(commands) } })
  expect(received.flat().map(command => command.value)).toEqual(['new task'])
  expect(toSDKMessageOrigin(origin)).not.toHaveProperty('engineSessionId')
  resetCommandQueue()
})

test('busy delivery displays only earlier-turn answers and has exactly the idle user-message framing', async () => {
  const registry = new PendingQuestionRegistry(async () => {})
  await registry.ask('earlier', 'old-source', [question])
  registry.beginTurn()
  await registry.ask('current', 'current-source', [question])
  const delivery = await registry.reply({ requestId: 'close', replies: [
    { toolUseId: 'earlier', questionIndex: 0, answer: { optionIndices: [0] } },
    { toolUseId: 'current', questionIndex: 0, answer: { optionIndices: [1] } },
  ] })
  const command: QueuedCommand = { mode: 'prompt', value: delivery.content, uuid: delivery.uuid as UUID, origin: questionReplyOrigin(delivery) }
  const attachment = (await getQueuedCommandAttachments([command], registry))[0]!
  expect(attachment.type).toBe('queued_command')
  if (attachment.type !== 'queued_command') throw new Error('Missing queued reply')
  expect(attachment.origin).toMatchObject({ displayQuestions: [{ toolUseId: 'earlier', questionIndex: 0 }] })
  expect(command.origin).not.toHaveProperty('displayQuestions')
  const input = normalizeAttachmentForAPI(attachment)[0]!
  expect(input.message.content).toBe(wrapCommandText(delivery.content, command.origin))
  expect(input.isMeta).toBeUndefined()
  expect(input.priorAssistantContext).toBeNull()
  expect(JSON.parse(delivery.content)[0].selectedPreview).toBe('<div>Chosen layout</div>')
})

test('image answers keep their question, image provenance and user-message privilege on the busy path', async () => {
  const registry = new PendingQuestionRegistry(async () => {})
  await registry.ask('image-question', 'source', [{ ...question, options: [] }])
  const image = { type: 'image' as const, source: { type: 'base64' as const, media_type: 'image/png' as const, data: 'AAAA' } }
  const delivery = await registry.reply({ requestId: 'image-close', replies: [{ toolUseId: 'image-question', questionIndex: 0, answer: { optionIndices: [] }, images: [image] }] })
  expect(JSON.parse(delivery.content)[0]).toMatchObject({ question: 'Which layout?', answer: '(Image attached)', imageCount: 1 })
  const attachment = (await getQueuedCommandAttachments([{ mode: 'prompt', value: questionReplyPrompt(delivery), uuid: delivery.uuid as UUID, origin: questionReplyOrigin(delivery) }], registry))[0]!
  const input = normalizeAttachmentForAPI(attachment)[0]!
  expect(input.message.content).toEqual([{ type: 'text', text: wrapCommandText(delivery.content, questionReplyOrigin(delivery)) }, image])
  expect(input.isMeta).toBeUndefined()
})
