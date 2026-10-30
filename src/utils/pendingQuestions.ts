import { createHash } from 'node:crypto'
import { z } from 'zod/v4'
import { isSubmitImageBase64, MAX_SUBMIT_IMAGE_BYTES, MAX_SUBMIT_IMAGES, MAX_SUBMIT_TOTAL_IMAGE_BYTES } from '../app-runtime/appSubmitLimits.js'

export const questionReplyImageSchema = z.strictObject({
  type: z.literal('image'),
  source: z.strictObject({
    type: z.literal('base64'),
    media_type: z.enum(['image/jpeg', 'image/png', 'image/gif', 'image/webp']),
    data: z.string().max(MAX_SUBMIT_IMAGE_BYTES).refine(isSubmitImageBase64),
  }),
})
export type QuestionReplyImage = z.infer<typeof questionReplyImageSchema>

export const questionReferenceSchema = z.strictObject({
  toolUseId: z.string().min(1).max(256),
  questionIndex: z.number().int().min(0).max(3),
})
export const questionAnswerSchema = z.strictObject({
  optionIndices: z.array(z.number().int().min(0).max(3)).max(4),
  other: z.string().max(20_000).optional(),
  notes: z.array(z.strictObject({
    optionIndex: z.number().int().min(0).max(3),
    text: z.string().max(20_000),
  })).max(4).optional(),
})
export const questionReplySchema = questionReferenceSchema.extend({
  answer: questionAnswerSchema,
  images: z.array(questionReplyImageSchema).max(MAX_SUBMIT_IMAGES).optional(),
})
export const questionReplyBatchSchema = z.strictObject({
  requestId: z.string().min(1).max(256),
  replies: z.array(questionReplySchema).min(1).max(256),
})
export const questionDismissSchema = questionReferenceSchema.extend({ requestId: z.string().min(1).max(256) })
export type QuestionReference = { toolUseId: string; questionIndex: number }
export type QuestionAnswer = z.infer<typeof questionAnswerSchema>
export type QuestionReply = z.infer<typeof questionReplySchema>
export type QuestionReplyBatch = z.infer<typeof questionReplyBatchSchema>
export type QuestionDismiss = z.infer<typeof questionDismissSchema>
export type PendingQuestionSpec = {
  question: string
  options: { label: string; description: string; preview?: string }[]
  multiSelect: boolean
}
export type PendingQuestion = QuestionReference & PendingQuestionSpec & { sourceMessageUuid: string }
export type ResolvedQuestion = PendingQuestion & {
  state: 'answered' | 'dismissed'
  answer?: string
  notes?: string
  selectedPreview?: string
}
export type ResolvedQuestionSnapshot = Omit<ResolvedQuestion, 'options' | 'multiSelect' | 'selectedPreview'>
export type QuestionReplyDelivery = {
  uuid: string
  batchId: string
  questions: QuestionReference[]
  content: string
  images?: QuestionReplyImage[]
}
/** This journal is display/runtime state, never a model message or summary. */
export type QuestionJournalEntry =
  | { type: 'question-lifecycle'; version: 1; operation: 'asked'; toolUseId: string; sourceMessageUuid: string; questions: PendingQuestionSpec[] }
  | { type: 'question-lifecycle'; version: 1; operation: 'resolved'; requestId: string; fingerprint: string; resolutions: ResolvedQuestion[]; delivery?: QuestionReplyDelivery }
export type QuestionSnapshot = { pending: PendingQuestion[]; resolved: ResolvedQuestionSnapshot[] }

export function questionKey(ref: QuestionReference): string {
  return JSON.stringify([ref.toolUseId, ref.questionIndex])
}

function reconstructAnswer(question: PendingQuestion, answer: QuestionAnswer): { answer: string; notes?: string; selectedPreview?: string } {
  const indices = [...answer.optionIndices].sort((a, b) => a - b)
  if (new Set(indices).size !== indices.length || indices.some(index => !question.options[index])) {
    throw new Error('Invalid option selection')
  }
  const other = answer.other?.trim() ?? ''
  if (indices.length + (other ? 1 : 0) === 0 || !question.multiSelect && indices.length + (other ? 1 : 0) > 1) {
    throw new Error('Invalid answer cardinality')
  }
  const notes = [...(answer.notes ?? [])].sort((a, b) => a.optionIndex - b.optionIndex)
  if (new Set(notes.map(note => note.optionIndex)).size !== notes.length || notes.some(note => !indices.includes(note.optionIndex))) {
    throw new Error('Notes must refer to distinct selected options')
  }
  const text = [...indices.map(index => question.options[index]!.label), ...(other ? [other] : [])].join(', ')
  const noteText = notes.filter(note => note.text.trim()).map(note => `${question.options[note.optionIndex]!.label}: ${note.text.trim()}`).join('\n')
  const preview = !question.multiSelect && indices.length === 1 ? question.options[indices[0]!]!.preview : undefined
  return { answer: text, ...(noteText ? { notes: noteText } : {}), ...(preview ? { selectedPreview: preview } : {}) }
}

/**
 * A serial durable outbox: the single resolution record commits both the picks
 * and the future message. Publication is after fsync. The caller may enqueue a
 * delivery repeatedly by its stable UUID, but must not run it twice.
 */
export class PendingQuestionRegistry {
  private pending = new Map<string, PendingQuestion>()
  private resolved = new Map<string, ResolvedQuestion>()
  private receipts = new Map<string, Extract<QuestionJournalEntry, { operation: 'resolved' }>>()
  private listeners = new Set<() => void>()
  private lane: Promise<unknown> = Promise.resolve()
  private snapshot: QuestionSnapshot = { pending: [], resolved: [] }
  private turnRevision = 0
  private readonly askedThisTurn = new Set<string>()
  private writeFailure: Error | null = null

  constructor(private readonly appendDurably: (entry: QuestionJournalEntry) => Promise<void>,
    private readonly maxSnapshotBytes = 8 * 1024 * 1024) {}

  private snapshotOf(pending: PendingQuestion[], resolved: ResolvedQuestion[]): QuestionSnapshot {
    return { pending, resolved: resolved.map(({ toolUseId, questionIndex, sourceMessageUuid, question, state, answer, notes }) => ({
      toolUseId, questionIndex, sourceMessageUuid, question, state,
      ...(answer !== undefined ? { answer } : {}), ...(notes !== undefined ? { notes } : {}),
    })) }
  }
  private checkSnapshot(pending: PendingQuestion[], resolved: ResolvedQuestion[]): void {
    if (new TextEncoder().encode(JSON.stringify(this.snapshotOf(pending, resolved))).byteLength > this.maxSnapshotBytes) {
      throw new Error('Question state exceeds the publication budget')
    }
  }

  needsRecovery(): boolean { return this.writeFailure !== null }
  private async persist(entry: QuestionJournalEntry): Promise<void> {
    if (this.writeFailure) throw new Error('Question persistence recovery is required', { cause: this.writeFailure })
    try { await this.appendDurably(entry) }
    catch (error) {
      // A failed fsync can leave a complete record. Do not accept a different
      // request until the owner has re-read and certified that journal.
      this.writeFailure = error instanceof Error ? error : new Error(String(error))
      throw this.writeFailure
    }
  }
  beginTurn(): void { this.turnRevision++; this.askedThisTurn.clear() }
  displayReferences(refs: QuestionReference[]): QuestionReference[] {
    return refs.filter(ref => !this.askedThisTurn.has(ref.toolUseId))
  }
  async waitForWrites(): Promise<void> {
    let pending: Promise<unknown>
    do { pending = this.lane; await pending } while (pending !== this.lane)
  }
  getSnapshot = (): QuestionSnapshot => this.snapshot
  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }
  private publish(): void {
    this.snapshot = this.snapshotOf([...this.pending.values()], [...this.resolved.values()])
    for (const listener of this.listeners) listener()
  }
  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.lane.then(operation)
    this.lane = next.catch(() => {})
    return next
  }
  /** Active IDs must come from the full selected conversation, including its compacted ancestry. */
  restore(entries: readonly QuestionJournalEntry[], activeToolUseIds: ReadonlySet<string>, preserveTurn = false, activeSources?: ReadonlyMap<string, string>): void {
    if (!preserveTurn) this.beginTurn()
    this.pending.clear()
    this.resolved.clear()
    this.receipts.clear()
    for (const entry of entries) {
      if (entry.operation === 'asked') {
        if (!activeToolUseIds.has(entry.toolUseId) || activeSources && activeSources.get(entry.toolUseId) !== entry.sourceMessageUuid) continue
        entry.questions.forEach((question, questionIndex) => {
          const value = { ...question, toolUseId: entry.toolUseId, questionIndex, sourceMessageUuid: entry.sourceMessageUuid }
          const key = questionKey(value)
          if (!this.resolved.has(key)) this.pending.set(key, value)
        })
      } else {
        const resolutions = entry.resolutions.filter(ref => activeToolUseIds.has(ref.toolUseId) &&
          (!activeSources || activeSources.get(ref.toolUseId) === ref.sourceMessageUuid))
        if (!resolutions.length) continue
        this.receipts.set(entry.requestId, { ...entry, resolutions,
          ...(resolutions.length !== entry.resolutions.length ? { delivery: undefined } : {}) })
        for (const resolution of resolutions) {
          const key = questionKey(resolution)
          this.pending.delete(key)
          this.resolved.set(key, resolution)
        }
      }
    }
    this.writeFailure = null
    this.publish()
  }
  ask(toolUseId: string, sourceMessageUuid: string, questions: PendingQuestionSpec[]): Promise<void> {
    const turnRevision = this.turnRevision
    return this.serialize(async () => {
      const previous = [...this.pending.values(), ...this.resolved.values()].filter(ref => ref.toolUseId === toolUseId).sort((a, b) => a.questionIndex - b.questionIndex)
      if (previous.length) {
        const spec = (value: PendingQuestionSpec) => JSON.stringify([value.question, value.multiSelect,
          value.options.map(option => [option.label, option.description, option.preview ?? null])])
        if (previous.length !== questions.length || previous.some((value, index) => value.sourceMessageUuid !== sourceMessageUuid ||
          spec(value) !== spec(questions[index]!))) throw new Error('Question call id was reused')
        return
      }
      if (!toolUseId || !sourceMessageUuid || questions.length < 1 || questions.length > 4) throw new Error('Invalid question call')
      const entry: QuestionJournalEntry = { type: 'question-lifecycle', version: 1, operation: 'asked', toolUseId, sourceMessageUuid, questions: structuredClone(questions) }
      this.checkSnapshot([...this.pending.values(), ...entry.questions.map((question, questionIndex) => ({ ...question, toolUseId, sourceMessageUuid, questionIndex }))], [...this.resolved.values()])
      await this.persist(entry)
      if (this.turnRevision === turnRevision) this.askedThisTurn.add(toolUseId)
      entry.questions.forEach((question, questionIndex) => {
        const value = { ...question, toolUseId, sourceMessageUuid, questionIndex }
        this.pending.set(questionKey(value), value)
      })
      this.publish()
    })
  }
  reply(raw: QuestionReplyBatch): Promise<QuestionReplyDelivery> {
    return this.serialize(async () => {
      const batch = questionReplyBatchSchema.parse(raw)
      const fingerprint = createHash('sha256').update(JSON.stringify(batch)).digest('hex')
      const previous = this.receipts.get(batch.requestId)
      if (previous) {
        if (previous.fingerprint !== fingerprint || !previous.delivery) throw new Error('Question request id was reused')
        return previous.delivery
      }
      const seen = new Set<string>()
      const images = batch.replies.flatMap(reply => reply.images ?? [])
      if (images.length > MAX_SUBMIT_IMAGES || images.reduce((bytes, image) => bytes + image.source.data.length, 0) > MAX_SUBMIT_TOTAL_IMAGE_BYTES) throw new Error('Question reply images exceed the message budget')
      const resolutions: ResolvedQuestion[] = batch.replies.map(reply => {
        const key = questionKey(reply)
        const question = this.pending.get(key)
        if (!question || seen.has(key)) throw new Error('Question is not pending')
        seen.add(key)
        const answer = reply.images?.length && !reply.answer.optionIndices.length && !reply.answer.other?.trim()
          ? { ...reply.answer, other: '(Image attached)' } : reply.answer
        return { ...question, state: 'answered', ...reconstructAnswer(question, answer) }
      })
      // Keep engine-authored text quoted, so a question or note cannot break its framing.
      const content = JSON.stringify(resolutions.map(({ toolUseId, questionIndex, question, answer, notes, selectedPreview }, index) => ({ toolUseId, questionIndex, question: question.slice(0, 4096), answer, ...(notes ? { notes } : {}), ...(selectedPreview ? { selectedPreview } : {}), ...(batch.replies[index]?.images?.length ? { imageCount: batch.replies[index]!.images!.length } : {}) })))
      // A failed fsync can leave a complete record on disk. Retrying in the
      // same process must produce the same delivery identity in that case.
      const hash = createHash('sha256').update(fingerprint).update(JSON.stringify(resolutions.map(ref => ref.sourceMessageUuid))).digest('hex')
      const uuid = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-a${hash.slice(17, 20)}-${hash.slice(20, 32)}`
      const delivery: QuestionReplyDelivery = { uuid, batchId: batch.requestId, questions: resolutions.map(({ toolUseId, questionIndex }) => ({ toolUseId, questionIndex })), content, ...(images.length ? { images } : {}) }
      await this.commit({ type: 'question-lifecycle', version: 1, operation: 'resolved', requestId: batch.requestId, fingerprint, resolutions, delivery })
      return delivery
    })
  }
  dismiss(raw: QuestionDismiss): Promise<void> {
    return this.serialize(async () => {
      const request = questionDismissSchema.parse(raw)
      const fingerprint = JSON.stringify(request)
      const previous = this.receipts.get(request.requestId)
      if (previous) {
        if (previous.fingerprint !== fingerprint || previous.delivery) throw new Error('Question request id was reused')
        return
      }
      const question = this.pending.get(questionKey(request))
      if (!question) throw new Error('Question is not pending')
      await this.commit({ type: 'question-lifecycle', version: 1, operation: 'resolved', requestId: request.requestId, fingerprint, resolutions: [{ ...question, state: 'dismissed' }] })
    })
  }
  private async commit(entry: Extract<QuestionJournalEntry, { operation: 'resolved' }>): Promise<void> {
    const keys = new Set(entry.resolutions.map(questionKey))
    this.checkSnapshot([...this.pending.values()].filter(question => !keys.has(questionKey(question))),
      [...this.resolved.values()].filter(question => !keys.has(questionKey(question))).concat(entry.resolutions))
    await this.persist(entry)
    this.receipts.set(entry.requestId, entry)
    for (const resolution of entry.resolutions) {
      this.pending.delete(questionKey(resolution))
      this.resolved.set(questionKey(resolution), resolution)
    }
    this.publish()
  }
  undelivered(acceptedMessageUuids: ReadonlySet<string>): QuestionReplyDelivery[] {
    return [...this.receipts.values()].flatMap(entry => entry.delivery && !acceptedMessageUuids.has(entry.delivery.uuid) ? [entry.delivery] : [])
  }
}
