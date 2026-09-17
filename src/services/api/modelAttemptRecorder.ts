import { randomUUID } from 'node:crypto'
import type { AgentId } from '../../types/agent.js'
import type { APIProvider } from '../../utils/model/providers.js'
import {
  recordModelAttemptEnd,
  recordModelAttemptFirstText,
  recordModelAttemptStart,
  type ModelAttemptMode,
  type ModelAttemptOutcome,
} from '../../utils/sessionStorage.js'

type AttemptSink = {
  start: typeof recordModelAttemptStart
  firstText: typeof recordModelAttemptFirstText
  end: typeof recordModelAttemptEnd
}

export type ModelAttempt = {
  readonly callId: string
  readonly attemptId: string
  readonly attemptIndex: number
  noteFirstText(text: string): void
  end(outcome: ModelAttemptOutcome): void
  isEnded(): boolean
}

export type ModelCallRecorder = {
  readonly callId: string
  startAttempt(input: {
    model: string
    provider: APIProvider
    mode: ModelAttemptMode
  }): ModelAttempt
}

const defaultSink: AttemptSink = {
  start: recordModelAttemptStart,
  firstText: recordModelAttemptFirstText,
  end: recordModelAttemptEnd,
}

const boundedDuration = (start: number, now: number): number =>
  Math.max(0, Math.min(Number.MAX_SAFE_INTEGER, Math.round(now - start)))

/**
 * One recorder per logical model call. Attempts use monotonic elapsed time and
 * persist no prompt, response, error, credential, or provider account data.
 */
export function createModelCallRecorder(options: {
  agentId?: AgentId
  monotonicNow?: () => number
  id?: () => string
  sink?: AttemptSink
} = {}): ModelCallRecorder {
  const monotonicNow = options.monotonicNow ?? (() => performance.now())
  const id = options.id ?? randomUUID
  const sink = options.sink ?? defaultSink
  const callId = id()
  let attemptIndex = 0

  const safely = (write: () => void): void => {
    try {
      write()
    } catch {
      // Measurement must never change provider execution or cancellation.
    }
  }

  return {
    callId,
    startAttempt({ model, provider, mode }) {
      const attemptId = id()
      const index = ++attemptIndex
      const started = monotonicNow()
      let ended = false
      let firstTextRecorded = false
      const identity = {
        schema_version: 1 as const,
        call_id: callId,
        attempt_id: attemptId,
      }
      safely(() =>
        sink.start(
          {
            ...identity,
            attempt_index: index,
            provider,
            model,
            mode,
          },
          options.agentId,
        ),
      )
      return {
        callId,
        attemptId,
        attemptIndex: index,
        noteFirstText(text) {
          if (
            mode !== 'streaming' ||
            ended ||
            firstTextRecorded ||
            text.length === 0
          ) {
            return
          }
          firstTextRecorded = true
          const duration_ms = boundedDuration(started, monotonicNow())
          safely(() =>
            sink.firstText({ ...identity, duration_ms }, options.agentId),
          )
        },
        end(outcome) {
          if (ended) return
          ended = true
          const duration_ms = boundedDuration(started, monotonicNow())
          safely(() =>
            sink.end({ ...identity, outcome, duration_ms }, options.agentId),
          )
        },
        isEnded: () => ended,
      }
    },
  }
}
