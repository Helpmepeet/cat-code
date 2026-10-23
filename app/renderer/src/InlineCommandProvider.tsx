import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { inlineCommandSourceKey, type InlineCommandRequest, type InlineCommandRun, type InlineCommandSource } from '../../shared/inlineCommand.js'
import { getBridge } from './bridge.js'
import { InlineCommandContext } from './inlineCommandState.js'

type Pending = { requestId: string; generation: string; previousRunId?: string }
const createState = () => ({
  pending: new Map<string, Pending>(),
  latest: new Map<string, Pending>(),
  uncertain: new Map<string, Pending>(),
  errors: new Map<string, string>(),
  explainPending: null as { submitId: string; sourceKey: string } | null,
})
const retained = new Map<string, ReturnType<typeof createState>>()

export function InlineCommandProvider({ sessionId, engineSessionId, snapshot, results, blockedReason, explainBlockedReason, children }: {
  sessionId: string | null
  engineSessionId: string | null
  snapshot?: { generation: string; runs: InlineCommandRun[]; requests?: InlineCommandRequest[] }
  results?: InlineCommandRun[]
  blockedReason?: string
  explainBlockedReason?: string
  children: ReactNode
}) {
  const [, update] = useState(0)
  const stopRequests = useRef(new Map<string, string>())
  const state = useMemo(() => {
    if (!sessionId) return createState()
    let state = retained.get(sessionId)
    if (!state) {
      state = createState()
      retained.set(sessionId, state)
      if (retained.size > 64) retained.delete(retained.keys().next().value!)
    }
    return state
  }, [sessionId])
  const runs = useMemo(() => {
    const byId = new Map((results ?? []).map(run => [run.runId, run]))
    for (const run of snapshot?.runs ?? []) byId.set(run.runId, run)
    return [...byId.values()]
  }, [snapshot, results])
  useEffect(() => {
    if (!sessionId || !engineSessionId || !snapshot?.generation) return
    if (state.explainPending) {
      state.errors.set(state.explainPending.sourceKey, 'Outcome unknown. Check the conversation before requesting another explanation.')
      state.explainPending = null
      update(value => value + 1)
    }
    if (state.pending.size) {
      for (const [key, pending] of state.pending) {
        state.uncertain.set(key, pending)
        state.errors.set(key, 'Outcome unknown. The command may already have had effects.')
      }
      state.pending.clear()
      update(value => value + 1)
    }
    // Query only: reconnects and remounts must never resend a Start.
    getBridge().getInlineCommands(sessionId)
    return getBridge().subscribe(frames => {
      for (const frame of frames) {
        if (frame.sessionId !== sessionId) continue
        if (frame.kind === 'submit.result' && state.explainPending?.submitId === frame.submitId) {
          const pending = state.explainPending
          state.explainPending = null
          if (!frame.accepted) state.errors.set(pending.sourceKey, 'Could not request an explanation. Try again.')
          update(value => value + 1)
        }
        if (frame.kind === 'transcript.reset') {
          stopRequests.current.clear()
          for (const key of state.latest.keys()) {
            if (state.pending.has(key) || state.uncertain.has(key)) continue
            state.latest.delete(key)
            state.errors.delete(key)
          }
          update(value => value + 1)
          getBridge().getInlineCommands(sessionId)
        }
        if (frame.kind === 'ready') getBridge().getInlineCommands(sessionId)
        if (frame.kind === 'lifecycle') {
          if (state.explainPending) {
            state.errors.set(state.explainPending.sourceKey, 'Outcome unknown. Check the conversation before requesting another explanation.')
            state.explainPending = null
          }
          for (const [key, pending] of state.pending) {
            state.uncertain.set(key, pending)
            state.errors.set(key, 'Outcome unknown. The command may already have had effects.')
          }
          state.pending.clear()
          update(value => value + 1)
        }
        if (frame.kind !== 'error') continue
        const stopSource = frame.requestId ? stopRequests.current.get(frame.requestId) : undefined
        if (stopSource && frame.requestId) {
          stopRequests.current.delete(frame.requestId)
          state.errors.set(stopSource, frame.message)
          update(value => value + 1)
        }
        for (const [key, attempt] of state.latest) {
          if (attempt.requestId !== frame.requestId) continue
          state.pending.delete(key)
          state.uncertain.delete(key)
          state.errors.set(key, frame.message)
          update(value => value + 1)
        }
      }
    })
  }, [sessionId, engineSessionId, snapshot?.generation, state])
  useEffect(() => {
    if (!snapshot) return
    let changed = false
    const latest = new Map((snapshot.requests ?? []).map(request => [inlineCommandSourceKey(request.source), request]))
    for (const [key, request] of latest) {
      if (!request.error) continue
      const attempt = state.latest.get(key)
      if (attempt && (attempt.generation !== snapshot.generation || attempt.requestId !== request.requestId)) continue
      if (state.errors.get(key) === request.error) continue
      state.errors.set(key, request.error)
      changed = true
    }
    for (const [key, pending] of state.pending) {
      const request = snapshot.requests?.find(request => request.requestId === pending.requestId)
      const legacyRun = snapshot.requests === undefined
        ? [...runs].reverse().find(run => inlineCommandSourceKey(run.source) === key && run.runId !== pending.previousRunId)
        : undefined
      if (pending.generation !== snapshot.generation) {
        state.uncertain.set(key, pending)
        state.errors.set(key, 'Outcome unknown. The command may already have had effects.')
      } else if ((!request || request.status === 'accepted') && !legacyRun) continue
      state.pending.delete(key)
      changed = true
    }
    for (const [key, attempt] of state.uncertain) {
      if (attempt.generation !== snapshot.generation) continue
      const request = snapshot.requests?.find(request => request.requestId === attempt.requestId)
      if (!request || request.status === 'accepted') continue
      state.uncertain.delete(key)
      if (state.latest.get(key)?.requestId === attempt.requestId) {
        if (request.error) state.errors.set(key, request.error)
        else state.errors.delete(key)
      }
      changed = true
    }
    if (changed) update(value => value + 1)
  }, [snapshot, runs, state])
  const start = (source: InlineCommandSource) => {
    if (!sessionId || !snapshot || blockedReason || state.explainPending || state.pending.size || runs.some(run => run.status === 'running')) return
    const key = inlineCommandSourceKey(source)
    const requestId = crypto.randomUUID()
    state.errors.delete(key)
    state.uncertain.delete(key)
    const attempt = { requestId, generation: snapshot.generation, previousRunId: [...runs].reverse().find(run => inlineCommandSourceKey(run.source) === key)?.runId }
    state.latest.delete(key)
    state.latest.set(key, attempt)
    if (state.latest.size > 128) {
      const oldest = state.latest.keys().next().value!
      state.latest.delete(oldest)
      state.errors.delete(oldest)
      state.uncertain.delete(oldest)
    }
    state.pending.set(key, attempt)
    update(value => value + 1)
    try {
      if (getBridge().startInlineCommand(sessionId, { requestId, generation: snapshot.generation, source })) return
    } catch { /* A failed send is not retried automatically. */ }
    state.pending.delete(key)
    state.errors.set(key, 'Could not start command. Check the connection before trying again.')
    update(value => value + 1)
  }
  const stop = (run: InlineCommandRun) => {
    if (!sessionId || !snapshot) return
    const key = inlineCommandSourceKey(run.source)
    const requestId = crypto.randomUUID()
    stopRequests.current.set(requestId, key)
    if (stopRequests.current.size > 32) stopRequests.current.delete(stopRequests.current.keys().next().value!)
    try {
      if (getBridge().stopInlineCommand(sessionId, { requestId, generation: snapshot.generation, runId: run.runId })) return
    } catch { /* Preserve the visible running state on a failed Stop. */ }
    stopRequests.current.delete(requestId)
    state.errors.set(key, 'Could not stop command. Check the connection.')
    update(value => value + 1)
  }
  const explain = (run: InlineCommandRun) => {
    if (!sessionId || explainBlockedReason || blockedReason || state.explainPending ||
      state.pending.size || runs.some(value => value.status === 'running') || run.status === 'running') return
    const sourceKey = inlineCommandSourceKey(run.source)
    const submitId = crypto.randomUUID()
    state.errors.delete(sourceKey)
    state.explainPending = { submitId, sourceKey }
    update(value => value + 1)
    try {
      getBridge().submit(sessionId, `Explain the output of inline command run ${run.runId}.`, { submitId })
    } catch {
      state.explainPending = null
      state.errors.set(sourceKey, 'Could not request an explanation. Check the connection.')
      update(value => value + 1)
    }
  }
  const runBlockedReason = blockedReason ?? (state.explainPending ? 'Wait for the current request to finish.' : undefined)
  const explanationBlockedReason = explainBlockedReason ?? runBlockedReason ??
    (state.pending.size || runs.some(run => run.status === 'running') ? 'Wait for the current command to finish.' : undefined)
  return <InlineCommandContext.Provider value={{ engineSessionId, generation: snapshot?.generation, runs, requests: snapshot?.requests ?? [], pending: state.pending, errors: state.errors, blockedReason: runBlockedReason, explainBlockedReason: explanationBlockedReason, explain, start, stop }}>{children}</InlineCommandContext.Provider>
}
