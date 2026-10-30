import { z } from 'zod/v4'
import type { AppSessionController } from '../../src/app-runtime/AppSessionController.js'
import { MAX_QUESTION_ANSWER_CHARS } from '../shared/limits.js'

const reference = {
  toolUseId: z.string().min(1).max(256),
  questionIndex: z.number().int().min(0).max(3),
}
const answer = z.strictObject({
  optionIndices: z.array(z.number().int().min(0).max(3)).max(4),
  other: z.string().max(MAX_QUESTION_ANSWER_CHARS).optional(),
  notes: z.array(z.strictObject({ optionIndex: z.number().int().min(0).max(3), text: z.string().max(MAX_QUESTION_ANSWER_CHARS) })).max(4).optional(),
})

// Desktop selections carry indices, not labels, questions, previews, origins or images.
export const questionReplyMessageSchema = z.strictObject({
  type: z.literal('askUserQuestion.reply'),
  requestId: z.string().min(1).max(256),
  replies: z.array(z.strictObject({ ...reference, answer })).min(1).max(256),
})
export const questionDismissMessageSchema = z.strictObject({
  ...reference,
  type: z.literal('askUserQuestion.dismiss'), requestId: z.string().min(1).max(256),
})
export const questionVerbSchema = z.discriminatedUnion('type', [questionReplyMessageSchema, questionDismissMessageSchema])

export async function acceptQuestionVerb(controller: AppSessionController, raw: unknown): Promise<void> {
  const message = questionVerbSchema.parse(raw)
  if (message.type === 'askUserQuestion.reply') await controller.replyToQuestions({ requestId: message.requestId, replies: message.replies })
  else await controller.dismissQuestion({ requestId: message.requestId, toolUseId: message.toolUseId, questionIndex: message.questionIndex })
}
