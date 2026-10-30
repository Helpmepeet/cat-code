import type { AskUserQuestionAnswer, SessionId, PROTOCOL_VERSION } from './protocol.js'
export { MAX_NONBLOCKING_QUESTION_TEXT_CHARS } from './limits.js'
export type { PendingQuestion, QuestionSnapshot, ResolvedQuestion } from './engine-types.snapshot.js'

export type QuestionReplyMessage = {
  type: 'askUserQuestion.reply'
  requestId: string
  replies: { toolUseId: string; questionIndex: number; answer: AskUserQuestionAnswer }[]
}
export type QuestionDismissMessage = {
  type: 'askUserQuestion.dismiss'
  requestId: string
  toolUseId: string
  questionIndex: number
}
export type QuestionVerb = QuestionReplyMessage | QuestionDismissMessage
export type QuestionReplyBatch = Omit<QuestionReplyMessage, 'type'>
export type QuestionDismiss = Omit<QuestionDismissMessage, 'type'>
export type QuestionResultFrame = {
  kind: 'question.result'
  protocolVersion: typeof PROTOCOL_VERSION
  sessionId: SessionId
  requestId: string
  accepted: boolean
}
