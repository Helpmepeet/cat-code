import z from 'zod/v4'
import type { InlineCommandRequest, InlineCommandRun, InlineCommandSource } from '../shared/inlineCommand.js'

const requestId = z.string().min(1).max(128)
const source = z.object({
  engineSessionId: z.string().min(1).max(128),
  messageUuid: z.string().min(1).max(128),
  contentBlockIndex: z.number().int().min(0).max(100_000),
  fenceOrdinal: z.number().int().min(0).max(100_000),
}).strict()

// The renderer selects a source, never executable text or a working directory.
export const inlineCommandMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('inline-command.get'), requestId }).strict(),
  z.object({
    type: z.literal('inline-command.start'), requestId,
    generation: requestId, source,
  }).strict(),
  z.object({
    type: z.literal('inline-command.stop'), requestId,
    generation: requestId, runId: requestId,
  }).strict(),
])

const MAX_ACCEPTED_REQUESTS = 128
const MAX_VISIBLE_RUNS = 16

/** Retry protection belongs to the live process generation, not mounted UI. */
export class InlineCommandRequests {
  private readonly accepted = new Map<string, string>()
  private readonly runs = new Map<string, InlineCommandRun>()
  private readonly outcomes = new Map<string, InlineCommandRequest>()

  admit(requestId: string, source: InlineCommandSource): 'new' | 'retry' {
    const identity = JSON.stringify([
      source.engineSessionId, source.messageUuid,
      source.contentBlockIndex, source.fenceOrdinal,
    ])
    const existing = this.accepted.get(requestId)
    if (existing !== undefined) {
      if (existing !== identity) throw new Error('This Run request names a different code block.')
      return 'retry'
    }
    if (this.accepted.size >= MAX_ACCEPTED_REQUESTS) {
      throw new Error('The Run request limit was reached. Restart this session before running another command.')
    }
    this.accepted.set(requestId, identity)
    this.outcomes.set(requestId, { requestId, source: { ...source }, status: 'accepted' })
    return 'new'
  }

  has(requestId: string): boolean { return this.accepted.has(requestId) }

  update(requestId: string, run: InlineCommandRun): void {
    const request = this.outcomes.get(requestId)
    if (!request) throw new Error('Unknown Run request.')
    this.outcomes.set(requestId, {
      ...request, runId: run.runId, status: run.status === 'running' ? 'running' : 'completed',
    })
    this.runs.set(run.runId, run)
    // Result history lives in the ordinary transcript. Retiring its live preview
    // must never retire the accepted request key and make a retry executable.
    while (this.runs.size > MAX_VISIBLE_RUNS) {
      const retired = [...this.runs].find(([, value]) => value.status !== 'running')
      if (!retired) break
      this.runs.delete(retired[0])
    }
  }

  getRuns(): InlineCommandRun[] { return [...this.runs.values()] }

  retirePreviews(): void {
    this.runs.clear()
  }

  reject(requestId: string, error: string): void {
    const request = this.outcomes.get(requestId)
    if (!request) throw new Error('Unknown Run request.')
    this.outcomes.set(requestId, { ...request, status: 'rejected', error: error.slice(0, 2048) })
  }

  getRequests(): InlineCommandRequest[] { return [...this.outcomes.values()] }
}
