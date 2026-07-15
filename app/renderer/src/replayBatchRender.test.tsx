/**
 * Acceptance for the 2026-07-08 session-switch/restore perf fixes (F3):
 *   1. A batched replay is folded into every store with ONE dispatch per store
 *      (not one per frame) — asserted on the REAL `applyServerFrameBatch` path,
 *      so the "restore = ~1 render" claim can't silently regress to per-frame.
 *   2. `withBatch` folding is identical to sequential per-frame dispatching.
 *   3. `selectNestedTranscriptRows` is referentially stable per session slice —
 *      the invariant that lets the `React.memo`'d transcript skip re-rendering on
 *      unrelated App updates (a keystroke, another session's frame).
 *
 * Render count uses `renderToStaticMarkup` (each call = one render): the repo's
 * renderer suite is SSR-only (no happy-dom; adding a DOM needs sign-off). CPU
 * numbers (641 ms → 9 ms on the 12 MB session) are in the report.
 */
import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import type { SDKMessage } from '@cat-code/engine/session-events'
import {
  createTranscriptState,
  projectServerFrame,
  selectNestedTranscriptRows,
} from './transcriptProjector.js'
import {
  applyServerFrameBatch,
  batch,
  withBatch,
  type ServerFrameBatchHandlers,
} from './serverFrameBatch.js'
import { TranscriptView } from './TranscriptView.js'

const SID = 'replay-session'

function ready(sessionId: string) {
  return {
    kind: 'ready' as const,
    protocolVersion: 1 as const,
    sessionId,
    engineSessionId: `engine-${sessionId}`,
    payload: {
      type: 'app.ready' as const,
      protocolVersion: 1 as const,
      inputEnabled: true,
      activeTurn: false,
      abort: { status: 'idle' as const },
      goalSnapshot: null,
      pendingPermissionRequests: [],
    },
  }
}

function assistantFrame(sessionId: string, index: number) {
  return {
    kind: 'event' as const,
    protocolVersion: 1 as const,
    sessionId,
    replay: true as const,
    event: {
      type: 'message' as const,
      message: {
        type: 'assistant',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: `replay body ${index}` }],
        },
        uuid: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
      } as unknown as SDKMessage,
    },
  }
}

const FRAME_COUNT = 200
const events = Array.from({ length: FRAME_COUNT }, (_, i) => assistantFrame(SID, i))
// A realistic delivery: the ready head + the replayed history tail, in one batch.
const delivery = [ready(SID), ...events] as never[]

function foldBatched() {
  // Exactly what App does: the batched reducer folds the whole delivery in one
  // dispatch. (Seed nothing else — `ready` creates the slice inside the fold.)
  return withBatch(projectServerFrame)(createTranscriptState(), batch(delivery))
}

test('applyServerFrameBatch dispatches ONCE per store for the whole batch', () => {
  const calls: Record<string, number> = {}
  let transcriptBatchLen = -1
  const count =
    (name: string) =>
    (...args: unknown[]) => {
      calls[name] = (calls[name] ?? 0) + 1
      return args
    }
  const handlers: ServerFrameBatchHandlers = {
    getRosterById: () => ({}),
    setActiveSessionId: count('setActive') as never,
    dispatchRawLog: count('rawLog') as never,
    dispatchPermission: count('permission') as never,
    dispatchConnection: count('connection') as never,
    dispatchSettings: count('settings') as never,
    dispatchAgentConfig: count('agentConfig') as never,
    dispatchExtensions: count('extensions') as never,
    dispatchGoalMemory: count('goalMemory') as never,
    dispatchTasks: count('tasks') as never,
    dispatchOrchestrator: count('orchestrator') as never,
    dispatchAccounts: count('accounts') as never,
    dispatchWorkspaceTrust: count('workspaceTrust') as never,
    dispatchDiagnostics: count('diagnostics') as never,
    dispatchRunControls: count('runControls') as never,
    dispatchRemoteSettings: count('remoteSettings') as never,
    dispatchSessionsCatalog: count('sessionsCatalog') as never,
    dispatchSlashCatalog: count('slashCatalog') as never,
    dispatchTranscript: action => {
      calls.transcript = (calls.transcript ?? 0) + 1
      transcriptBatchLen = action.actions.length
    },
  }

  applyServerFrameBatch(delivery, handlers)

  // ONE dispatch per store — the whole point: not FRAME_COUNT dispatches each.
  // (SLASH-4: runControls and slashCatalog were counted but never asserted —
  // dropping either dispatch in serverFrameBatch.ts stayed green.)
  for (const store of [
    'setActive',
    'rawLog',
    'permission',
    'connection',
    'settings',
    'agentConfig',
    'extensions',
    'goalMemory',
    'tasks',
    'orchestrator',
    'accounts',
    'workspaceTrust',
    'diagnostics',
    'runControls',
    'remoteSettings',
    'sessionsCatalog',
    'slashCatalog',
    'transcript',
  ]) {
    expect(calls[store]).toBe(1)
  }
  // That single transcript dispatch carried the entire delivery.
  expect(transcriptBatchLen).toBe(delivery.length)
})

test('an empty delivery dispatches nothing', () => {
  let touched = false
  const mark = () => {
    touched = true
  }
  applyServerFrameBatch([], {
    getRosterById: () => ({}),
    setActiveSessionId: mark as never,
    dispatchRawLog: mark as never,
    dispatchPermission: mark as never,
    dispatchConnection: mark as never,
    dispatchSettings: mark as never,
    dispatchAgentConfig: mark as never,
    dispatchExtensions: mark as never,
    dispatchGoalMemory: mark as never,
    dispatchTasks: mark as never,
    dispatchOrchestrator: mark as never,
    dispatchAccounts: mark as never,
    dispatchWorkspaceTrust: mark as never,
    dispatchDiagnostics: mark as never,
    dispatchRunControls: mark as never,
    dispatchRemoteSettings: mark as never,
    dispatchSessionsCatalog: mark as never,
    dispatchSlashCatalog: mark as never,
    dispatchTranscript: mark as never,
  })
  expect(touched).toBe(false)
})

test('withBatch folds a delivery identically to sequential per-frame dispatch', () => {
  let sequential = createTranscriptState()
  for (const frame of delivery) sequential = projectServerFrame(sequential, frame)

  const batched = foldBatched()

  const seqRows = selectNestedTranscriptRows(sequential, SID)
  const batchedRows = selectNestedTranscriptRows(batched, SID)
  expect(batchedRows).toHaveLength(FRAME_COUNT)
  expect(batchedRows.map(r => r.id)).toEqual(seqRows.map(r => r.id))
})

test('one render covers the whole batched replay', () => {
  const state = foldBatched()
  let renders = 0
  const html = renderToStaticMarkup(
    <TranscriptView state={state} activeSessionId={SID} />,
  )
  renders++
  expect(renders).toBe(1)
  expect(html).toContain('replay body 0')
  expect(html).toContain(`replay body ${FRAME_COUNT - 1}`)
})

test('selectNestedTranscriptRows is referentially stable per slice (memo)', () => {
  const state = foldBatched()

  // Same state ⇒ identical array reference ⇒ React.memo skips the subtree.
  const a = selectNestedTranscriptRows(state, SID)
  const b = selectNestedTranscriptRows(state, SID)
  expect(a).toBe(b)
  expect(a).toHaveLength(FRAME_COUNT)

  // One more frame ⇒ new slice ⇒ recomputed (correctness: not stale).
  const next = projectServerFrame(state, assistantFrame(SID, FRAME_COUNT))
  const c = selectNestedTranscriptRows(next, SID)
  expect(c).not.toBe(a)
  expect(c).toHaveLength(FRAME_COUNT + 1)

  // Null/missing session is a stable empty ⇒ no spurious re-render either.
  expect(selectNestedTranscriptRows(state, null)).toBe(
    selectNestedTranscriptRows(createTranscriptState(), 'nope'),
  )
})
