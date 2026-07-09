/**
 * Server-frame batching (perf F3, 2026-07-08).
 *
 * A restore replays its history as one batched `ServerFrame[]` delivery (main
 * `deliver` → preload `subscribe`). This module folds that batch into ONE
 * dispatch per store, so a 400-frame restore is 9 dispatches (one per reducer),
 * not 400×9 — the "one dispatch per reducer" the strategy called for. React then
 * commits once. Extracted as a pure function so the batching is unit-tested on
 * the real path (see replayBatchRender.test.tsx), not left implicit in a React
 * callback that only works by automatic-batching happenstance.
 */
import type { ServerFrame, SessionId } from '../../shared/protocol.js'

/** Marker action folded by `withBatch`. Reserved: no real action uses this `type`. */
export type BatchAction<A> = { type: '__frameBatch'; actions: readonly A[] }

function isBatchAction<A>(action: A | BatchAction<A>): action is BatchAction<A> {
  return (
    typeof action === 'object' &&
    action !== null &&
    (action as { type?: unknown }).type === '__frameBatch'
  )
}

/** `batch([a,b,c])` → one action a `withBatch`-wrapped reducer folds in order. */
export function batch<A>(actions: readonly A[]): BatchAction<A> {
  return { type: '__frameBatch', actions }
}

/**
 * Wrap a per-action reducer so a `batch(...)` action folds every action through
 * it in one dispatch; any other action passes straight to the inner reducer
 * unchanged (a single live frame, a one-off `{type:'failed'}`, etc.).
 */
export function withBatch<S, A>(
  reducer: (state: S, action: A) => S,
): (state: S, action: A | BatchAction<A>) => S {
  return (state, action) =>
    isBatchAction(action) ? action.actions.reduce(reducer, state) : reducer(state, action)
}

/** The `{type:'frame'}` action the permission/settings/agent/goal/account reducers take. */
export type FrameReducerAction = { type: 'frame'; frame: ServerFrame }

/** The dispatchers `applyServerFrameBatch` drives — each called at most ONCE per batch. */
export type ServerFrameBatchHandlers = {
  getRosterById: () => Record<string, unknown>
  setActiveSessionId: (updater: (current: SessionId | null) => SessionId | null) => void
  dispatchRawLog: (action: BatchAction<ServerFrame>) => void
  dispatchConnection: (action: BatchAction<ServerFrame>) => void
  dispatchTranscript: (action: BatchAction<ServerFrame>) => void
  dispatchPermission: (action: BatchAction<FrameReducerAction>) => void
  dispatchSettings: (action: BatchAction<FrameReducerAction>) => void
  dispatchAgentConfig: (action: BatchAction<FrameReducerAction>) => void
  dispatchExtensions: (action: BatchAction<FrameReducerAction>) => void
  dispatchGoalMemory: (action: BatchAction<FrameReducerAction>) => void
  dispatchTasks: (action: BatchAction<FrameReducerAction>) => void
  dispatchOrchestrator: (action: BatchAction<FrameReducerAction>) => void
  dispatchAccounts: (action: BatchAction<FrameReducerAction>) => void
  dispatchWorkspaceTrust: (action: BatchAction<FrameReducerAction>) => void
  dispatchDiagnostics: (action: BatchAction<FrameReducerAction>) => void
  dispatchRemoteSettings: (action: BatchAction<FrameReducerAction>) => void
  dispatchSessionsCatalog: (action: BatchAction<FrameReducerAction>) => void
}

/**
 * Fold one delivered `ServerFrame[]` into every store with ONE dispatch each.
 * Semantics are identical to the old per-frame loop — a background frame never
 * steals focus from another live tab — only the dispatch COUNT changes
 * (per-batch, not per-frame).
 */
export function applyServerFrameBatch(
  frames: readonly ServerFrame[],
  h: ServerFrameBatchHandlers,
): void {
  if (frames.length === 0) return
  const frameActions: FrameReducerAction[] = frames.map(frame => ({
    type: 'frame',
    frame,
  }))

  h.setActiveSessionId(current => {
    const roster = h.getRosterById()
    return frames.reduce<SessionId | null>((cur, frame) => {
      if (cur === null) return frame.sessionId
      if (cur === frame.sessionId) return cur
      if (!roster[cur] && !roster[frame.sessionId]) return frame.sessionId
      return cur
    }, current)
  })

  h.dispatchRawLog(batch(frames))
  h.dispatchPermission(batch(frameActions))
  h.dispatchConnection(batch(frames))
  h.dispatchSettings(batch(frameActions))
  h.dispatchAgentConfig(batch(frameActions))
  h.dispatchExtensions(batch(frameActions))
  h.dispatchGoalMemory(batch(frameActions))
  h.dispatchTasks(batch(frameActions))
  h.dispatchOrchestrator(batch(frameActions))
  h.dispatchAccounts(batch(frameActions))
  h.dispatchWorkspaceTrust(batch(frameActions))
  h.dispatchDiagnostics(batch(frameActions))
  h.dispatchRemoteSettings(batch(frameActions))
  h.dispatchSessionsCatalog(batch(frameActions))
  h.dispatchTranscript(batch(frames))
}
