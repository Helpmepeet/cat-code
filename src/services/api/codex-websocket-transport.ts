/**
 * Codex WebSocket Transport
 *
 * Maintains a persistent WebSocket connection to the Codex backend
 * (wss://chatgpt.com/backend-api/codex/responses) and sends each turn as an
 * incremental request with `previous_response_id`, allowing the server to
 * chain KV-cache across turns instead of re-matching from scratch each time.
 *
 * Without this, the server can only cache the stable `instructions` prefix
 * (~13,824 tokens). With it, the cached prefix grows with the conversation.
 */

import { createHash } from 'crypto'
import type { IncomingMessage } from 'http'
import WSNode from 'ws'
import { isEnvTruthy } from '../../utils/envUtils.js'
import { logForDebugging, TURN_LOCK_STALL_PREFIX } from '../../utils/debug.js'

// Optional callback invoked when a stale previous_response_id is detected and
// the turn is retried as a full send. Registered by the fetch adapter so that
// promptCacheBreakDetection can label the resulting cache drop correctly.
let onStaleResponseIdRetry: ((conversationId: string) => void) | null = null

export function registerStaleResponseIdCallback(cb: (conversationId: string) => void): void {
  onStaleResponseIdRetry = cb
}

// Optional callback invoked at response.completed to record the send-path
// decision and timing to the session JSONL. Registered by the fetch adapter.
type SendPathEntry = {
  mode: 'incremental' | 'full' | 'prewarm' | 'stale_retry'
  prev_response_id_prefix: string | null
  sent_items: number
  prev_sent_items: number
  instructions_hash: string
  effort: string | null
  prompt_cache_key_prefix: string | null
  session_id_prefix: string | null
  account_id_prefix: string | null
  ttfb_ms?: number
  total_stream_ms?: number
  cached_tokens?: number
  input_tokens?: number
  route_headers?: Record<string, string>
}
let onSendPathComplete: ((entry: SendPathEntry) => void) | null = null

export function registerSendPathLogger(cb: (entry: SendPathEntry) => void): void {
  onSendPathComplete = cb
}

// Canonicalizer for recorded response output items. Registered by the fetch
// adapter (canonicalizeCodexItem) so that the shape we RECORD at response time
// matches the shape translateMessages REPLAYS on the next turn, keeping
// reconcileCanonicalDelta's incremental path alive on unchanged history. The
// transport cannot import the adapter (the adapter imports the transport), so
// the dependency is injected here.
let canonicalizeOutputItem:
  | ((item: Record<string, unknown>) => Record<string, unknown>)
  | null = null

export function registerOutputItemCanonicalizer(
  cb: (item: Record<string, unknown>) => Record<string, unknown>,
): void {
  canonicalizeOutputItem = cb
}

const CODEX_WS_URL = 'wss://chatgpt.com/backend-api/codex/responses'

// OpenAI-Beta header value required for WebSocket transport (different from HTTP).
const WS_BETA_HEADER = 'responses_websockets=2026-02-06'

const IDLE_TIMEOUT_MS =
  parseInt(process.env.CLAUDE_STREAM_IDLE_TIMEOUT_MS || '', 10) || 90_000

// Server-side 60-minute WS connection limit.
const WS_CONNECTION_LIMIT_CODE = 'websocket_connection_limit_reached'
const WS_OPEN = 1

type WebSocketLike = {
  readonly readyState: number
  close(): void
  send(data: string): void
  on(event: 'open', listener: () => void): void
  on(event: 'upgrade', listener: (res: IncomingMessage) => void): void
  on(event: 'message', listener: (data: Buffer | string) => void): void
  on(event: 'error', listener: (error?: unknown) => void): void
  on(event: 'close', listener: (code?: number, reason?: Buffer) => void): void
  off(event: 'message', listener: (data: Buffer | string) => void): void
  off(event: 'error', listener: (error?: unknown) => void): void
  off(event: 'close', listener: (code?: number, reason?: Buffer) => void): void
}

type WebSocketFactory = (
  url: string,
  options: { headers: Record<string, string> },
) => WebSocketLike

let webSocketFactory: WebSocketFactory = (url, options) =>
  new WSNode(url, options) as unknown as WebSocketLike
let webSocketFactoryIsTest = false

export function _setWebSocketFactoryForTest(factory: WebSocketFactory | null): void {
  webSocketFactoryIsTest = factory !== null
  webSocketFactory = factory ?? ((url, options) =>
    new WSNode(url, options) as unknown as WebSocketLike)
}

interface WsSession {
  ws: WebSocketLike
  accountId: string | null
  // x-codex-turn-state: sticky routing token received in the WebSocket upgrade
  // response headers. Used for diagnostics; request echo is handled at connect
  // time via headers, not as a response.create body field.
  turnState: string | null
  lastResponseId: string | null
  // Stringified request body without input[]. Upstream only allows
  // previous_response_id reuse when all non-input request fields are unchanged.
  lastRequestSignature: string | null
  // Exact input[] sent with the previous completed request.
  lastRequestInput: Array<Record<string, unknown>>
  // Final output items from the previous completed response. These are part of
  // the continuation baseline and must not be resent.
  lastResponseOutputItems: Array<Record<string, unknown>>
}

// One session per conversationId. Reused across turns until the connection
// is closed (error, 60-min limit, or explicit clear).
const sessions = new Map<string, WsSession>()
const sessionOpenVersions = new Map<string, number>()

interface PendingOpenSession {
  accountId: string | null
  promise: Promise<WsSession>
}

const openingSessions = new Map<string, PendingOpenSession>()

interface ConversationTurnQueue {
  tail: Promise<void>
  pending: number
}

// Serialize in-flight websocket turns per conversationId. Different
// conversations still run in parallel; only overlapping turns that share the
// same Codex session are queued.
const conversationTurnQueues = new Map<string, ConversationTurnQueue>()

// How long a turn may wait for the per-conversation lock before the wait is
// reported. The wait itself stays UNBOUNDED: this is a diagnostic only, and
// bounding it is a separate decision
// (docs/reports/2026-08-10-overnight-turn-hang-investigation.md, candidate 2).
const LOCK_WAIT_WARN_MS = 30_000

// Injection seam so the report can be driven in tests without a 30s wall-clock
// wait. Production values only here.
type LockWaitHooks = {
  now: () => number
  setTimer: (fn: () => void, ms: number) => unknown
  clearTimer: (handle: unknown) => void
  report: (conversationIdPrefix: string, waitedMs: number) => void
}

const defaultLockWaitHooks: LockWaitHooks = {
  now: () => Date.now(),
  setTimer: (fn, ms) => {
    const timer = setTimeout(fn, ms)
    // A pending report must never be the reason the process stays alive.
    timer.unref?.()
    return timer
  },
  clearTimer: handle => clearTimeout(handle as ReturnType<typeof setTimeout>),
  // `turn_lock_stall` is in debug.ts's ALWAYS_LOG_PREFIXES: a stalled lock
  // writes nothing anywhere else, and by definition it only fires when a turn
  // has already been stuck for 30s.
  report: (conversationIdPrefix, waitedMs) => {
    // Called from a bare timer callback, where nothing upstack can catch: the
    // debug writer's `appendFileSync` is unguarded, so an unwritable
    // `--debug-file` would raise `uncaughtException` and kill the very process
    // this record exists to keep sampleable. A diagnostic never alters control
    // flow, least of all by ending the run it is describing.
    try {
      logForDebugging(
        `${TURN_LOCK_STALL_PREFIX} conv=${conversationIdPrefix} waited_ms=${waitedMs} ` +
        `threshold_ms=${LOCK_WAIT_WARN_MS}`,
        { level: 'warn' },
      )
    } catch {}
  },
}

let lockWaitHooks: LockWaitHooks = defaultLockWaitHooks

export function _setLockWaitHooksForTest(
  hooks: Partial<LockWaitHooks> | null,
): void {
  lockWaitHooks = hooks ? { ...defaultLockWaitHooks, ...hooks } : defaultLockWaitHooks
}

async function acquireConversationTurn(
  conversationId: string,
  signal?: AbortSignal,
): Promise<() => void> {
  if (signal?.aborted) {
    throw createWebSocketAbortError(signal)
  }
  const queue = conversationTurnQueues.get(conversationId) ?? {
    tail: Promise.resolve(),
    pending: 0,
  }
  queue.pending += 1

  let releaseGate!: () => void
  const gate = new Promise<void>(resolve => {
    releaseGate = resolve
  })
  const priorTail = queue.tail
  queue.tail = priorTail.finally(() => gate)
  conversationTurnQueues.set(conversationId, queue)

  if (queue.pending > 1) {
    logForDebugging(
      `[codex-ws] turn queued for ${conversationId.slice(0, 8)} pending=${queue.pending}`,
    )
  }

  let onAbort: (() => void) | undefined
  const aborted = signal
    ? new Promise<never>((_, reject) => {
        onAbort = () => reject(createWebSocketAbortError(signal))
        signal.addEventListener('abort', onAbort, { once: true })
      })
    : null

  // This wait is the one stretch of a turn no watchdog covers: the stream idle
  // timeout arms only after ws.send, so a turn parked here is silent and
  // indistinguishable from one that was never started. Report it; the wait can
  // still block forever by design.
  let waitTimer: unknown
  try {
    // Armed INSIDE the try. By this point `queue.pending` is incremented and
    // `queue.tail` is chained on `gate`, so a throw before the catch would skip
    // `releaseGate()` and park every later turn on this conversation forever:
    // the diagnostic manufacturing the exact hang it was added to detect.
    const waitStartedAt = lockWaitHooks.now()
    waitTimer = lockWaitHooks.setTimer(() => {
      lockWaitHooks.report(
        conversationId.slice(0, 8),
        lockWaitHooks.now() - waitStartedAt,
      )
    }, LOCK_WAIT_WARN_MS)
    await (aborted ? Promise.race([priorTail, aborted]) : priorTail)
  } catch (error) {
    // Resolve this queued turn's gate without bypassing priorTail: queue.tail
    // still waits for the active turn before it observes the already-resolved
    // gate, so later turns remain correctly serialized.
    queue.pending -= 1
    releaseGate()
    if (
      queue.pending === 0 &&
      conversationTurnQueues.get(conversationId) === queue
    ) {
      conversationTurnQueues.delete(conversationId)
    }
    throw error
  } finally {
    // Every exit from the wait lands here: acquired, aborted, or thrown. The
    // guard covers the one path where the timer was never armed.
    if (waitTimer !== undefined) lockWaitHooks.clearTimer(waitTimer)
    if (onAbort) signal?.removeEventListener('abort', onAbort)
  }

  let released = false
  return () => {
    if (released) return
    released = true
    queue.pending -= 1
    releaseGate()
    if (queue.pending === 0) {
      conversationTurnQueues.delete(conversationId)
    }
  }
}

export function clearWebSocketSession(conversationId: string): void {
  sessionOpenVersions.set(
    conversationId,
    (sessionOpenVersions.get(conversationId) ?? 0) + 1,
  )
  const session = sessions.get(conversationId)
  if (session) {
    try { session.ws.close() } catch { /* ignore */ }
    sessions.delete(conversationId)
    logForDebugging(`[codex-ws] session cleared for ${conversationId.slice(0, 8)}`)
  }
  openingSessions.delete(conversationId)
}

/**
 * Closes the physical socket for a conversation while KEEPING the continuation
 * baseline (lastResponseId / lastRequestInput / lastResponseOutputItems) in the
 * sessions map. Used on transient error and abort paths (Item 3 rules 2a & 5):
 *
 *   - The open socket must die because `onMessage` has no response-id
 *     correlation — an aborted or errored turn's late events would otherwise
 *     bleed into the next turn's handler and poison the baseline.
 *   - The baseline is still valid to chain from (a failed/aborted attempt never
 *     commits state — that only happens on response.completed), so the next
 *     turn should reconnect and reuse it rather than pay a full send + prewarm.
 *
 * Marking the socket closed here makes the next getOrOpenSession() take the
 * reconnect-preserve branch, which reopens a fresh socket and carries the
 * baseline across it — reusing the existing socket-swap pattern instead of
 * duplicating it.
 */
export function closeSocketPreservingState(conversationId: string): void {
  const session = sessions.get(conversationId)
  if (!session) {
    // No session to preserve; fall back to the full teardown so any pending
    // open is invalidated.
    clearWebSocketSession(conversationId)
    return
  }
  // Invalidate any in-flight open() so a racing connect resolves to a closed
  // socket instead of a live one attached to the errored turn.
  sessionOpenVersions.set(
    conversationId,
    (sessionOpenVersions.get(conversationId) ?? 0) + 1,
  )
  try { session.ws.close() } catch { /* ignore */ }
  openingSessions.delete(conversationId)
  logForDebugging(
    `[codex-ws] socket closed, continuation preserved for ${conversationId.slice(0, 8)}`,
  )
}

/**
 * Opens a new WebSocket connection for the given conversationId.
 * x-codex-turn-state arrives in the upgrade response headers, which requires
 * the `ws` package because Bun's native WebSocket does not expose them.
 */
async function openSession(
  conversationId: string,
  authHeaders: Record<string, string>,
  signal?: AbortSignal,
): Promise<WsSession> {
  return new Promise((resolve, reject) => {
    const openVersion = sessionOpenVersions.get(conversationId) ?? 0
    const ws = webSocketFactory(CODEX_WS_URL, {
      headers: {
        ...authHeaders,
        'OpenAI-Beta': WS_BETA_HEADER,
        session_id: conversationId,
        'x-client-request-id': conversationId,
      },
    })

    let capturedTurnState: string | null = null

    // Bun's ws compatibility layer currently warns on `upgrade` listeners.
    // Keep capture active for Node-style ws runtimes and injected tests; Bun
    // production still connects with headers but cannot observe this response
    // header until the runtime exposes the upgrade event.
    if (typeof Bun === 'undefined' || webSocketFactoryIsTest) {
      ws.on('upgrade', (res: IncomingMessage) => {
        const header = res.headers['x-codex-turn-state']
        if (typeof header === 'string') {
          capturedTurnState = header
        } else if (Array.isArray(header) && typeof header[0] === 'string') {
          capturedTurnState = header[0]
        }
      })
    }

    let settled = false
    let timeout: ReturnType<typeof setTimeout>
    const cleanup = () => {
      clearTimeout(timeout)
      signal?.removeEventListener('abort', onAbort)
    }
    const rejectOpen = (error: Error, closeSocket = false) => {
      if (settled) return
      settled = true
      cleanup()
      if (closeSocket) {
        try { ws.close() } catch { /* ignore */ }
      }
      reject(error)
    }
    const onAbort = () => {
      rejectOpen(createWebSocketAbortError(signal!), true)
    }

    timeout = setTimeout(() => {
      rejectOpen(new Error('WebSocket connect timeout'), true)
    }, 15_000)
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) {
      onAbort()
    }

    ws.on('open', () => {
      if (settled) {
        try { ws.close() } catch { /* ignore */ }
        return
      }
      if ((sessionOpenVersions.get(conversationId) ?? 0) !== openVersion) {
        rejectOpen(new Error('WebSocket session cleared before open'), true)
        return
      }
      settled = true
      cleanup()
      const session: WsSession = {
        ws,
        accountId: authHeaders['chatgpt-account-id'] ?? null,
        turnState: capturedTurnState,
        lastResponseId: null,
        lastRequestSignature: null,
        lastRequestInput: [],
        lastResponseOutputItems: [],
      }
      sessions.set(conversationId, session)
      logForDebugging(
        `[codex-ws] connected for ${conversationId.slice(0, 8)}` +
        (capturedTurnState
          ? ` turn_state=${capturedTurnState.slice(0, 12)}...`
          : ' turn_state=none'),
      )
      resolve(session)
    })

    ws.on('error', () => {
      rejectOpen(new Error('WebSocket connect error'))
    })
  })
}

function waitForSessionWithSignal(
  promise: Promise<WsSession>,
  signal?: AbortSignal,
): Promise<WsSession> {
  if (!signal) return promise
  if (signal.aborted) return Promise.reject(createWebSocketAbortError(signal))

  return new Promise((resolve, reject) => {
    const onAbort = () => {
      cleanup()
      reject(createWebSocketAbortError(signal))
    }
    const cleanup = () => signal.removeEventListener('abort', onAbort)
    signal.addEventListener('abort', onAbort, { once: true })
    promise.then(
      session => {
        cleanup()
        resolve(session)
      },
      error => {
        cleanup()
        reject(error)
      },
    )
  })
}

/**
 * Returns existing open session or opens a new one.
 */
async function getOrOpenSession(
  conversationId: string,
  authHeaders: Record<string, string>,
  signal?: AbortSignal,
): Promise<WsSession> {
  const requestedAccountId = authHeaders['chatgpt-account-id'] ?? null
  const existing = sessions.get(conversationId)
  if (
    existing &&
    existing.ws.readyState === WS_OPEN &&
    existing.accountId === requestedAccountId
  ) {
    return existing
  }
  const opening = openingSessions.get(conversationId)
  if (opening && opening.accountId === requestedAccountId) {
    return waitForSessionWithSignal(opening.promise, signal)
  }
  // Stale/closed session — remove and reconnect
  if (existing) {
    // Report 6.1 instrumentation: an account mismatch mid-conversation means
    // the lease manager rotated accounts between turns. A close-before-
    // response.completed that lines up with this event is evidence of
    // account/session churn being the physical close reason.
    const oldAcct = existing.accountId ? existing.accountId.slice(0, 8) : 'none'
    const newAcct = authHeaders['chatgpt-account-id']
      ? authHeaders['chatgpt-account-id'].slice(0, 8)
      : 'none'
    // Item 3 rule 4: account rotation is NOT a transient reconnect. `sessions`
    // is keyed by conversationId only, so preserving lastResponseId here would
    // make the new account's first request chain the OLD account's
    // previous_response_id (which that account/node never saw) — a guaranteed
    // "not found" full send at best, a mis-chain at worst. Only preserve the
    // continuation baseline when the account is unchanged (a pure socket swap).
    const accountChanged = existing.accountId !== requestedAccountId
    const reason =
      existing.ws.readyState !== WS_OPEN
        ? `ws_readyState=${existing.ws.readyState}`
        : `account_changed old=${oldAcct} new=${newAcct}`
    logForDebugging(
      `[codex-ws] reconnecting conv=${conversationId.slice(0, 8)} ${reason}`,
      { level: 'warn' },
    )
    const preserved = accountChanged
      ? null
      : {
          lastResponseId: existing.lastResponseId,
          lastRequestSignature: existing.lastRequestSignature,
          lastRequestInput: existing.lastRequestInput,
          lastResponseOutputItems: existing.lastResponseOutputItems,
        }
    try { existing.ws.close() } catch { /* ignore */ }
    sessions.delete(conversationId)
    const fresh = await openTrackedSession(conversationId, authHeaders, signal)
    if (preserved) {
      fresh.lastResponseId = preserved.lastResponseId
      fresh.lastRequestSignature = preserved.lastRequestSignature
      fresh.lastRequestInput = preserved.lastRequestInput
      fresh.lastResponseOutputItems = preserved.lastResponseOutputItems
      logForDebugging(
        `[codex-ws] continuation preserved across reconnect ` +
        `conv=${conversationId.slice(0, 8)} ` +
        `response_id=${preserved.lastResponseId?.slice(0, 16) ?? 'none'}`,
      )
    } else {
      logForDebugging(
        `[codex-ws] continuation dropped on account rotation ` +
        `conv=${conversationId.slice(0, 8)} old=${oldAcct} new=${newAcct}`,
        { level: 'warn' },
      )
    }
    return fresh
  }
  return openTrackedSession(conversationId, authHeaders, signal)
}

function openTrackedSession(
  conversationId: string,
  authHeaders: Record<string, string>,
  signal?: AbortSignal,
): Promise<WsSession> {
  const requestedAccountId = authHeaders['chatgpt-account-id'] ?? null
  const opening = openingSessions.get(conversationId)
  if (opening && opening.accountId === requestedAccountId) {
    return waitForSessionWithSignal(opening.promise, signal)
  }

  const promise = openSession(conversationId, authHeaders, signal).finally(() => {
    if (openingSessions.get(conversationId)?.promise === promise) {
      openingSessions.delete(conversationId)
    }
  })
  openingSessions.set(conversationId, {
    accountId: requestedAccountId,
    promise,
  })
  return promise
}

/**
 * Eagerly opens (or reuses) a WebSocket session for the given conversationId.
 * Throws if the connection cannot be established — caller should fall back to HTTP.
 * Must be awaited before calling streamTurnViaWebSocket so connect errors are catchable.
 */
export async function ensureWebSocketSession(
  conversationId: string,
  authHeaders: Record<string, string>,
  signal?: AbortSignal,
): Promise<void> {
  await getOrOpenSession(conversationId, authHeaders, signal)
}

/**
 * Runs one logical websocket turn under a per-conversation lock so background
 * requests cannot interleave with the main turn on the same Codex session.
 * The lock spans connection setup and the streamed response.
 *
 * Item 3 rule 1: there is no longer a per-request prewarm. Upstream codex-rs
 * prewarms once at session startup, not per turn; cat-code's per-request
 * schedulePrewarm re-fired on every session-clearing event (report R2 measured
 * up to 156 prewarms in one conversation, ≈ one per turn), and because the real
 * request awaited it, prewarm never warmed anything ahead of time — it just
 * double-billed the prefix back-to-back with the real send. The first real call
 * seeds the prefix the prewarm used to seed, so the only cost of removal is that
 * the first turn's prefix isn't warmed a few hundred ms early.
 */
export async function* streamTurnViaWebSocketLocked(
  conversationId: string,
  codexBody: Record<string, unknown>,
  authHeaders: Record<string, string>,
  fullInputLength: number,
  signal?: AbortSignal,
): AsyncGenerator<Record<string, unknown>> {
  const releaseTurn = await acquireConversationTurn(conversationId, signal)
  try {
    if (signal?.aborted) {
      throw createWebSocketAbortError(signal)
    }
    await ensureWebSocketSession(conversationId, authHeaders, signal)
    if (signal?.aborted) {
      closeSocketPreservingState(conversationId)
      throw createWebSocketAbortError(signal)
    }
    yield* streamTurnViaWebSocket(
      conversationId,
      codexBody,
      authHeaders,
      fullInputLength,
      signal,
    )
  } finally {
    releaseTurn()
  }
}

// Sentinel thrown internally when previous_response_id is rejected so the
// generator can retry as a full send without surfacing an error to the user.
class StaleResponseIdError extends Error {
  constructor() { super('stale_response_id') }
}

function cloneJsonValue<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function createRequestSignature(codexBody: Record<string, unknown>): string {
  const { input: _ignoredInput, ...nonInputFields } = codexBody
  return JSON.stringify(nonInputFields)
}

function responseItemsEqual(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right)
}

function findReplacedToolResult(
  currentInput: Array<Record<string, unknown>>,
  previousInput: Array<Record<string, unknown>>,
): string | null {
  for (let i = 0; i < previousInput.length; i++) {
    const previous = previousInput[i]!
    const current = currentInput[i]
    if (
      previous.type === 'function_call_output' &&
      current?.type === 'function_call_output' &&
      previous.call_id === current.call_id &&
      !responseItemsEqual(
        { output: previous.output },
        { output: current.output },
      )
    ) {
      return `tool_result_replaced index=${i} call_id=${String(previous.call_id ?? 'unknown')}`
    }
  }
  return null
}

/**
 * Diagnoses why two Codex items differ, categorizing common normalization
 * drift patterns so logs are actionable rather than opaque.
 */
function diagnoseMismatch(
  baseline: Record<string, unknown>,
  current: Record<string, unknown>,
): string {
  const bType = String(baseline.type ?? 'unknown')
  const cType = String(current.type ?? 'unknown')
  if (bType !== cType) return `type_mismatch baseline=${bType} current=${cType}`

  const bStr = JSON.stringify(baseline)
  const cStr = JSON.stringify(current)

  if (bType === 'message') {
    const bLen = Array.isArray(baseline.content) ? (baseline.content as unknown[]).length : -1
    const cLen = Array.isArray(current.content) ? (current.content as unknown[]).length : -1
    if (bLen !== cLen) return `message_content_count baseline=${bLen} current=${cLen}`
    return `message_content_drift len_delta=${cStr.length - bStr.length}`
  }

  // [id:...] snip-tool tag injected into user content
  if (cStr.includes('[id:') && !bStr.includes('[id:')) return `id_tag_injected`

  // Tool loaded. boundary sibling injected
  if (cStr.includes('Tool loaded.') && !bStr.includes('Tool loaded.')) return `tool_loaded_injected`

  // Tool input normalization (canonicalization of arguments / input field)
  if (bType === 'function_call' || bType === 'custom_tool_call') {
    const bArgs = JSON.stringify((baseline.arguments ?? baseline.input) ?? null)
    const cArgs = JSON.stringify((current.arguments ?? current.input) ?? null)
    if (bArgs !== cArgs) return `tool_input_drift`
  }

  return `unknown_drift len_delta=${cStr.length - bStr.length}`
}

/**
 * Returns the incremental delta (items beyond the canonical baseline) if the
 * freshly translated input is a strict prefix extension of the canonical
 * baseline, or null with a diagnostic reason string if it is not.
 *
 * The comparison uses JSON.stringify equality so that field-order and
 * whitespace differences in the freshly translated items are caught.
 */
function getIncrementalInputDelta(
  currentInput: Array<Record<string, unknown>>,
  previousInput: Array<Record<string, unknown>>,
  previousOutputItems: Array<Record<string, unknown>>,
): { delta: Array<Record<string, unknown>>; mismatchReason: null } | { delta: null; mismatchReason: string } {
  const baseline = previousInput.concat(previousOutputItems)
  if (currentInput.length < baseline.length) {
    return {
      delta: null,
      mismatchReason: `input shorter: current=${currentInput.length} baseline=${baseline.length}`,
    }
  }
  for (let i = 0; i < baseline.length; i++) {
    const baselineItem = baseline[i]!
    const currentItem = currentInput[i]!
    if (!responseItemsEqual(currentItem, baselineItem)) {
      const hint = diagnoseMismatch(baselineItem, currentItem)
      return {
        delta: null,
        mismatchReason: `first_mismatch index=${i} ${hint}`,
      }
    }
  }
  return { delta: currentInput.slice(baseline.length), mismatchReason: null }
}

/**
 * Reconcile the freshly translated input[] against the canonical continuation
 * baseline using a hybrid strategy:
 *
 *   - previousInput portion  → trust by length except for same-call tool-result
 *     content replacement (these are otherwise the items we
 *     originally sent, which normalizeMessagesForAPI can structurally rewrite
 *     across turns via tool_reference injection, [id:...] tags, assistant-block
 *     merging, etc. — the drift is harmless to KV-cache continuity because the
 *     server already processed these items last turn). Aggregate tool-result
 *     budgeting and time-based microcompaction intentionally replace output
 *     content in place; those semantic changes require a full send so the server
 *     does not retain the unreduced context behind previous_response_id.
 *
   *   - previousOutputItems portion → verify by strict JSON equality, except
   *     that omitted reasoning items are tolerated. Reasoning is provider-managed
   *     state already anchored by previous_response_id; message/tool output still
   *     has to line up before we send a delta.
 *
   * ASSUMPTION: non-reasoning previousOutputItems appear exactly in the next
   * turn's input[]. Reasoning items may be replayed as hidden thinking.signature
   * blocks or omitted from local replay entirely.
 *
 * Returns the new-items delta (may be empty []) on success, or null with a
 * diagnostic reason when a full send is required.
 */
export function reconcileCanonicalDelta(
  currentInput: Array<Record<string, unknown>>,
  previousInput: Array<Record<string, unknown>>,
  previousOutputItems: Array<Record<string, unknown>>,
): { delta: Array<Record<string, unknown>>; mismatchReason: null } | { delta: null; mismatchReason: string } {
  const minBaselineLength =
    previousInput.length +
    previousOutputItems.filter(item => item.type !== 'reasoning').length
  if (currentInput.length < minBaselineLength) {
    return {
      delta: null,
      mismatchReason: `input shorter than canonical baseline: current=${currentInput.length} baseline=${minBaselineLength}`,
    }
  }

  const replacedToolResult = findReplacedToolResult(currentInput, previousInput)
  if (replacedToolResult) {
    return { delta: null, mismatchReason: replacedToolResult }
  }

  // Verify the output-items portion strictly, with one Codex-specific escape
  // hatch: reasoning items are provider-managed continuation state. Some local
  // transcript paths preserve them as hidden thinking.signature blocks, while
  // others replay only the paired message/tool-call item. Because
  // previous_response_id already anchors the server to the prior response,
  // omitted reasoning items should not force a full resend as long as the next
  // non-reasoning output item still lines up.
  const outputItemsStart = previousInput.length
  let currentIndex = outputItemsStart
  let skippedReasoningItems = 0
  for (let i = 0; i < previousOutputItems.length; i++) {
    const expected = previousOutputItems[i]!
    const actual = currentInput[currentIndex]
    if (
      expected.type === 'reasoning' &&
      (!actual || actual.type !== 'reasoning')
    ) {
      skippedReasoningItems++
      continue
    }
    if (!actual || !responseItemsEqual(actual, expected)) {
      const hint = actual
        ? diagnoseMismatch(expected, actual)
        : `missing_current_item expected=${String(expected.type ?? 'unknown')}`
      return {
        delta: null,
        mismatchReason:
          `output_item_mismatch index=${currentIndex} ${hint} ` +
          `prev_input=${previousInput.length} prev_output=${previousOutputItems.length} ` +
          `skipped_reasoning=${skippedReasoningItems}`,
      }
    }
    currentIndex++
  }

  if (skippedReasoningItems > 0) {
    logForDebugging(
      `[codex-ws] canonical skipped_reasoning=${skippedReasoningItems} ` +
      `prev_input=${previousInput.length} prev_output=${previousOutputItems.length} ` +
      `full=${currentInput.length} delta=${currentInput.length - currentIndex}`,
    )
  }

  return { delta: currentInput.slice(currentIndex), mismatchReason: null }
}

function normalizeCompletedOutputItem(
  item: Record<string, unknown>,
): Record<string, unknown> {
  // The adapter registers canonicalizeCodexItem, which produces the single
  // canonical shape that translateMessages replays on the next turn (dropping
  // volatile fields like logprobs and re-normalizing tool arguments through the
  // real tool pipeline). Always prefer it so record-time and replay-time shapes
  // are identical.
  if (canonicalizeOutputItem) {
    return canonicalizeOutputItem(item)
  }

  // Fallback for callers that never load the adapter (unit tests that exercise
  // the transport in isolation). Mirrors the canonical message/reasoning/tool
  // shapes so the transport is self-consistent, minus the tool-argument
  // re-normalization that requires the adapter's tool registry.
  if (item.type === 'message') {
    const parts = Array.isArray(item.content) ? item.content : []
    return {
      type: 'message',
      role: item.role,
      content: parts.map(part => {
        const p = part as Record<string, unknown>
        return {
          type: 'output_text',
          text: p.text,
          annotations: Array.isArray(p.annotations) ? p.annotations : [],
        }
      }),
      status: 'completed',
    }
  }

  if (item.type === 'function_call') {
    return {
      type: 'function_call',
      call_id: item.call_id,
      name: item.name,
      arguments: item.arguments,
    }
  }

  if (item.type === 'custom_tool_call') {
    return {
      type: 'custom_tool_call',
      call_id: item.call_id,
      name: item.name,
      input: item.input,
    }
  }

  if (item.type === 'reasoning') {
    return {
      type: 'reasoning',
      summary: [],
      encrypted_content: item.encrypted_content,
    }
  }

  return cloneJsonValue(item)
}

// Sentinel thrown when the server hits the 60-min WS connection limit so the
// outer wrapper can reconnect and retry the turn transparently.
class ConnectionLimitError extends Error {
  constructor() { super('websocket_connection_limit_reached') }
}

export class CodexWebSocketUsageLimitError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CodexWebSocketUsageLimitError'
  }
}

export class CodexWebSocketAuthError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'CodexWebSocketAuthError'
  }
}

export class CodexWebSocketIdleTimeoutError extends Error {
  constructor(
    public readonly timeoutMs: number,
  ) {
    super('idle timeout waiting for websocket')
    this.name = 'CodexWebSocketIdleTimeoutError'
  }
}

export class CodexWebSocketClosedBeforeCompletedError extends Error {
  constructor(
    public readonly closeCode?: number,
    public readonly closeReason: string = 'none',
  ) {
    const codeSuffix =
      closeCode !== undefined ? ` (code=${closeCode} reason=${closeReason})` : ''
    super(`websocket closed by server before response.completed${codeSuffix}`)
    this.name = 'CodexWebSocketClosedBeforeCompletedError'
  }
}

function createWebSocketAbortError(signal: AbortSignal): Error {
  const reason = signal.reason
  if (reason instanceof Error) {
    return reason
  }
  const error = new Error('The operation was aborted.')
  error.name = 'AbortError'
  return error
}

function isUsageLimitRejection(code: string, message: string): boolean {
  return (
    code.toLowerCase().includes('usage_limit') ||
    message.toLowerCase().includes('usage limit has been reached')
  )
}

// Local mirror of the adapter's CODEX_ACCOUNT_AUTH_ERROR_CODES: this module
// cannot import the adapter (the adapter imports it), so — exactly as
// isUsageLimitRejection mirrors the adapter's cap detection — the WS `type:error`
// auth codes are matched here and normalized to CodexAccountAuthError adapter-side.
// Keep this list in sync with CODEX_ACCOUNT_AUTH_ERROR_CODES.
function isAuthTokenRejection(code: string): boolean {
  const normalized = code.toLowerCase()
  return (
    normalized === 'token_invalidated' ||
    normalized === 'token_expired' ||
    normalized === 'token_revoked' ||
    normalized === 'invalid_token'
  )
}

export async function* streamTurnViaWebSocket(
  conversationId: string,
  codexBody: Record<string, unknown>,
  authHeaders: Record<string, string>,
  fullInputLength: number,
  signal?: AbortSignal,
): AsyncGenerator<Record<string, unknown>> {
  let retryingAfterStaleResponseId = false
  // Allow up to 2 retries:
  //   attempt 0 → normal (may use previous_response_id)
  //   attempt 1 → after StaleResponseIdError: full send on same connection
  //   attempt 2 → after ConnectionLimitError: reconnect + full send
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      if (signal?.aborted) {
        throw createWebSocketAbortError(signal)
      }
      yield* _streamTurnAttempt(
        conversationId,
        codexBody,
        authHeaders,
        fullInputLength,
        retryingAfterStaleResponseId,
        signal,
      )
      return
    } catch (err) {
      if (err instanceof StaleResponseIdError && attempt === 0) {
        retryingAfterStaleResponseId = true
        logForDebugging(
          `[codex-ws] retrying turn as full send after stale previous_response_id`,
          { level: 'warn' },
        )
        continue
      }
      if (err instanceof ConnectionLimitError && attempt <= 1) {
        logForDebugging(
          `[codex-ws] reconnecting after 60-min connection limit, retrying turn`,
          { level: 'warn' },
        )
        // Session already cleared by the handler; openSession on next attempt.
        continue
      }
      throw err
    }
  }
}

async function* _streamTurnAttempt(
  conversationId: string,
  codexBody: Record<string, unknown>,
  authHeaders: Record<string, string>,
  fullInputLength: number,
  retryingAfterStaleResponseId?: boolean,
  signal?: AbortSignal,
): AsyncGenerator<Record<string, unknown>> {
  const session = await getOrOpenSession(conversationId, authHeaders, signal)
  if (signal?.aborted) {
    closeSocketPreservingState(conversationId)
    throw createWebSocketAbortError(signal)
  }

  // Build request: wrap in response.create envelope, apply incremental fields.
  const requestBody: Record<string, unknown> = {
    type: 'response.create',
    ...codexBody,
  }
  const fullInput = Array.isArray(codexBody.input)
    ? (codexBody.input as Array<Record<string, unknown>>)
    : []
  const requestSignature = createRequestSignature(codexBody)
  const completedOutputItems: Array<Record<string, unknown>> = []

  const instructions = typeof codexBody.instructions === 'string' ? codexBody.instructions : ''
  const instructionsHash = createHash('sha1').update(instructions).digest('hex').slice(0, 8)
  const currentEffort = (codexBody.reasoning as { effort?: string } | undefined)?.effort ?? null

  // Send-path mode for JSONL diagnostic entry.
  let sendMode: 'incremental' | 'full' | 'prewarm' | 'stale_retry' =
    retryingAfterStaleResponseId ? 'stale_retry' : 'full'
  const prevResponseIdAtSend = session.lastResponseId
  const prevSentItemsAtSend = session.lastRequestInput.length

  let continuationReason: string | null = null
  if (!session.lastResponseId) {
    continuationReason = 'no prior response_id'
  } else if (session.lastRequestSignature !== requestSignature) {
    continuationReason = 'non-input request fields changed'
  } else {
    // Phase 2 fix: use canonical-length reconciliation to decide the delta.
    // This trusts that the items stored in lastRequestInput/lastResponseOutputItems
    // are the exact items the server saw, and sends only the new items appended
    // beyond that baseline — without requiring the freshly translated prefix to
    // match byte-for-byte (normalizeMessagesForAPI introduces harmless structural
    // drift on every turn that would otherwise cause a false full-send).
    const { delta, mismatchReason } = reconcileCanonicalDelta(
      fullInput,
      session.lastRequestInput,
      session.lastResponseOutputItems,
    )

    if (delta !== null) {
      requestBody.previous_response_id = session.lastResponseId
      requestBody.input = delta
      sendMode = 'incremental'

      // Also run the strict equality check purely for diagnostics — this shows
      // what the old path would have said without using it to block the send.
      // Skip on zero-delta turns: if we sent nothing new, strict and canonical
      // agree by definition (the prefix check would also have passed).
      if (delta.length > 0) {
        const strictResult = getIncrementalInputDelta(
          fullInput,
          session.lastRequestInput,
          session.lastResponseOutputItems,
        )
        const baselineLen = session.lastRequestInput.length + session.lastResponseOutputItems.length
        if (strictResult.delta === null) {
          logForDebugging(
            `[codex-ws] incremental (canonical) prev_resp=${session.lastResponseId.slice(0, 16)} ` +
            `delta=${delta.length} items (full=${fullInputLength}, baseline=${baselineLen}) ` +
            `strict_check=would_have_failed mismatch=${strictResult.mismatchReason}`,
          )
        } else {
          logForDebugging(
            `[codex-ws] incremental prev_resp=${session.lastResponseId.slice(0, 16)} ` +
            `delta=${delta.length} items (full=${fullInputLength}, baseline=${baselineLen})`,
          )
        }
      } else {
        logForDebugging(
          `[codex-ws] incremental (zero-delta) prev_resp=${session.lastResponseId.slice(0, 16)} ` +
          `full=${fullInputLength} baseline=${session.lastRequestInput.length + session.lastResponseOutputItems.length}`,
        )
      }
    } else {
      continuationReason = mismatchReason
    }
  }

  if (continuationReason) {
    if (session.lastResponseId && continuationReason !== 'no prior response_id') {
      session.lastResponseId = null
      session.lastRequestSignature = null
      session.lastRequestInput = []
      session.lastResponseOutputItems = []
    }
    logForDebugging(
      `[codex-ws] full send input=${fullInputLength} items` +
      (continuationReason ? ` (${continuationReason})` : ''),
      continuationReason === 'non-input request fields changed'
        ? { level: 'warn' }
        : undefined,
    )
  }

  // Set up message queue so we can yield events as they arrive.
  type QueueItem = { event: Record<string, unknown> } | { error: Error } | { done: true }
  const queue: QueueItem[] = []
  let resolve: (() => void) | null = null

  const enqueue = (item: QueueItem) => {
    queue.push(item)
    resolve?.()
    resolve = null
  }

  const waitForItem = (): Promise<void> =>
    new Promise(r => { resolve = r })

  // Diagnostic state for close/error reporting. Captured in handler closures so
  // that a mid-stream close can surface enough context for postmortem analysis
  // (see docs/reports/2026-04-30-session-10c4f510-review-impl-subagent-runtime-investigation.md).
  let eventCount = 0
  let lastEventType: string | null = null
  let lastEventAtMs: number | null = null
  const streamStartTs = Date.now()

  // Attach message handler for this turn only.
  const onMessage = (data: Buffer | string) => {
    const text = typeof data === 'string' ? data : data.toString('utf8')

    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(text)
    } catch {
      return
    }

    if (typeof parsed.type === 'string') {
      lastEventType = parsed.type
      lastEventAtMs = Date.now()
      eventCount += 1
    }

    // Detect WebSocket-wrapped error events.
    if (parsed.type === 'error') {
      const err = parsed.error as Record<string, unknown> | undefined
      const code = typeof err?.code === 'string' ? err.code : ''
      const msg = typeof err?.message === 'string' ? err.message : String(parsed)

      if (code === WS_CONNECTION_LIMIT_CODE) {
        // 60-min server limit reached. Clear and reconnect on retry so the
        // next attempt opens a fresh connection (matching real client behaviour
        // of ApiError::Retryable which triggers reconnect + retry).
        clearWebSocketSession(conversationId)
        enqueue({ error: new ConnectionLimitError() })
        return
      }

      if (isUsageLimitRejection(code, msg)) {
        enqueue({ error: new CodexWebSocketUsageLimitError(msg) })
        return
      }

      if (isAuthTokenRejection(code)) {
        // Revoked/superseded token surfaced over WS. Normalized to
        // CodexAccountAuthError adapter-side so withRetry runs auth recovery.
        enqueue({ error: new CodexWebSocketAuthError(msg) })
        return
      }

      if (msg.includes('not found') && session.lastResponseId) {
        // The server no longer has the chained response ID (TTL expiry or
        // server restart). Reset so the retry sends a full input[].
        // Emit a detectable marker so promptCacheBreakDetection can label this
        // accurately instead of falling through to "likely server-side".
        logForDebugging(
          `[codex-ws] previous_response_id ${session.lastResponseId.slice(0, 16)} expired — stale_response_id retry as full send`,
          { level: 'warn' },
        )
        logForDebugging(`[codex-cache] stale_response_id_retry conv=${conversationId.slice(0, 8)}`, { level: 'warn' })
        onStaleResponseIdRetry?.(conversationId)
        session.lastResponseId = null
        session.lastRequestSignature = null
        session.lastRequestInput = []
        session.lastResponseOutputItems = []
        enqueue({ error: new StaleResponseIdError() })
        return
      }

      // Item 3 rule 2b: ANY other server error on a chained request must reset
      // the continuation baseline, not just the 'not found' TTL case. Otherwise
      // a server rejection of this previous_response_id chain becomes a generic
      // WS error → sticky HTTP fallback → the baseline is never reset → the next
      // WS turn (after the sticky window) re-sends the same poisoned incremental
      // and degrades again. Dropping the baseline here forces the next send to
      // be a clean full send. (The response never completed, so no good baseline
      // is being discarded.)
      if (session.lastResponseId) {
        logForDebugging(
          `[codex-ws] server error on chained request — resetting continuation baseline ` +
          `conv=${conversationId.slice(0, 8)} prev_resp=${session.lastResponseId.slice(0, 16)} msg="${msg}"`,
          { level: 'warn' },
        )
        session.lastResponseId = null
        session.lastRequestSignature = null
        session.lastRequestInput = []
        session.lastResponseOutputItems = []
      }
      // A terminal server error ends this physical stream. onMessage has no
      // response-id correlation, so late events from the rejected turn must not
      // be allowed onto a socket reused by the next turn. The reset baseline
      // above remains reset across the reconnect, making that next turn full-send.
      failStream(new Error(`Codex WS error: ${msg}`), { closeSocket: true })
      return
    }

    if (parsed.type === 'response.output_item.done') {
      const item = parsed.item
      if (item && typeof item === 'object' && !Array.isArray(item)) {
        completedOutputItems.push(
          normalizeCompletedOutputItem(item as Record<string, unknown>),
        )
      }
    }

    enqueue({ event: parsed })
  }

  const buildDiagContext = (): string => {
    const convPrefix = conversationId.slice(0, 8)
    const acct = session.accountId ? session.accountId.slice(0, 8) : 'none'
    const prevResp = prevResponseIdAtSend ? prevResponseIdAtSend.slice(0, 16) : 'none'
    const sinceStart = Date.now() - streamStartTs
    const sinceLast = lastEventAtMs !== null ? Date.now() - lastEventAtMs : null
    return (
      `conv=${convPrefix} account=${acct} mode=${sendMode} ` +
      `prev_resp=${prevResp} events=${eventCount} last_event=${lastEventType ?? 'none'} ` +
      `ttle=${sinceLast ?? 'n/a'}ms since_start=${sinceStart}ms ` +
      `ready_state=${session.ws.readyState}`
    )
  }

  // Tracks whether any events were yielded before the WS closed. A zero-event
  // close is ambiguous (auth rejection, transport failure, or server-side close),
  // so it remains a transport close unless an explicit usage-limit error event
  // was observed.
  let eventsYielded = false
  let terminalError: Error | null = null

  const failStream = (
    error: Error,
    options?: {
      // Item 3 rule 2a: transient socket errors must still KILL the physical
      // socket (onMessage has no response-id correlation, so an open socket
      // would bleed this aborted turn's late events into the next turn's
      // handler and poison the baseline) while KEEPING the continuation
      // baseline (a mid-stream failure never committed state — that only
      // happens on response.completed — so the previous good baseline is still
      // valid to chain from next turn). Closing the socket makes the next
      // getOrOpenSession take the reconnect-preserve branch.
      closeSocket?: boolean
    },
  ) => {
    if (terminalError) {
      return
    }
    terminalError = error
    if (options?.closeSocket) {
      closeSocketPreservingState(conversationId)
    }
    enqueue({ error })
  }

  const onError = (ev?: unknown) => {
    const evRec = ev as Record<string, unknown> | undefined
    const detail =
      (typeof evRec?.message === 'string' && evRec.message) ||
      (evRec?.error instanceof Error && evRec.error.message) ||
      'no detail'
    logForDebugging(
      `[codex-ws] onerror ${buildDiagContext()} detail=${detail}`,
      { level: 'warn' },
    )
    failStream(new Error(`WebSocket error during stream (${detail})`), {
      closeSocket: true,
    })
  }

  const onAbort = () => {
    failStream(createWebSocketAbortError(signal!), { closeSocket: true })
  }

  const onClose = (code?: number, reason?: Buffer) => {
    const closeCode = typeof code === 'number' ? code : undefined
    const rawReason = reason?.toString('utf8') ?? ''
    const closeReason = rawReason.length > 0 ? rawReason : 'none'
    const wasClean = closeCode !== undefined && closeCode >= 1000 && closeCode < 1100

    const diag = buildDiagContext()
    logForDebugging(
      `[codex-ws] onclose ${diag} close_code=${closeCode ?? 'n/a'} ` +
      `close_reason=${closeReason} was_clean=${wasClean ?? 'n/a'}`,
      { level: 'warn' },
    )

    if (terminalError) {
      logForDebugging(
        `[codex-ws] onclose suppressed terminal_error=${terminalError.name} conv=${conversationId.slice(0, 8)}`,
        { level: 'warn' },
      )
      return
    }

    // A close before response.completed is an error, not a clean finish.
    // The real client returns Err("websocket closed by server before response.completed").
    failStream(
      new CodexWebSocketClosedBeforeCompletedError(
        closeCode,
        eventsYielded ? closeReason : `zero_events:${closeReason}`,
      ),
    )
  }

  session.ws.on('message', onMessage)
  session.ws.on('error', onError)
  session.ws.on('close', onClose)

  // Set up idle timeout.
  let idleTimer: ReturnType<typeof setTimeout> | null = null
  const resetIdle = () => {
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = setTimeout(() => {
      // Bonus instrumentation: idle timeouts look identical to mid-stream
      // closes in parent transcripts. Log the same diag context so a
      // postmortem can tell them apart.
      logForDebugging(
        `[codex-ws] idle_timeout ${buildDiagContext()} timeout_ms=${IDLE_TIMEOUT_MS}`,
        { level: 'warn' },
      )
      // Match upstream behavior: surface the terminal timeout immediately
      // instead of letting the subsequent close handshake mask it.
      failStream(new CodexWebSocketIdleTimeoutError(IDLE_TIMEOUT_MS), {
        closeSocket: true,
      })
    }, IDLE_TIMEOUT_MS)
  }
  const clearIdle = () => {
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null }
  }

  // Send the request.
  const sendTs = Date.now()
  let firstEventTs: number | null = null
  if (signal?.aborted) {
    session.ws.off('message', onMessage)
    session.ws.off('error', onError)
    session.ws.off('close', onClose)
    closeSocketPreservingState(conversationId)
    throw createWebSocketAbortError(signal)
  }
  try {
    session.ws.send(JSON.stringify(requestBody))
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) {
      onAbort()
    }
    resetIdle()
  } catch (err) {
    session.ws.off('message', onMessage)
    session.ws.off('error', onError)
    session.ws.off('close', onClose)
    // Item 3 rule 2a: a send throw means the socket is unusable, but nothing
    // was committed this turn — kill the socket and keep the baseline so the
    // next turn reconnects and continues instead of paying a full send.
    closeSocketPreservingState(conversationId)
    throw err
  }

  // Tracks whether the generator reached a terminal disposition (completed,
  // failed, done, or a thrown error whose handler already decided the socket's
  // fate). If the generator's finally runs WITHOUT this — i.e. the consumer
  // abandoned iteration mid-stream (Esc-abort) — the socket is still open and
  // the server is still streaming the dead turn. Item 3 rule 5: close that
  // socket (preserving the baseline) so the dead turn's late response.completed
  // cannot bleed into the next turn's handler and poison the baseline. onMessage
  // has no response-id correlation, so an open socket is the whole hazard.
  let reachedTerminalDisposition = false

  // Yield events until response.completed, error, or close.
  try {
    while (true) {
      // Drain the queue first.
      while (queue.length > 0) {
        const item = queue.shift()!
        if ('error' in item) {
          reachedTerminalDisposition = true
          clearIdle()
          throw item.error
        }
        if ('done' in item) {
          reachedTerminalDisposition = true
          clearIdle()
          return
        }
        const event = item.event
        if (firstEventTs === null) firstEventTs = Date.now()
        eventsYielded = true
        resetIdle()
        yield event

        // After yielding response.completed, record state and stop.
        if (event.type === 'response.completed') {
          reachedTerminalDisposition = true
          const response = event.response as Record<string, unknown> | undefined
          const responseId = typeof response?.id === 'string' ? response.id : null
          if (responseId) {
            session.lastResponseId = responseId
            session.lastRequestSignature = requestSignature
            session.lastRequestInput = cloneJsonValue(fullInput)
            session.lastResponseOutputItems = cloneJsonValue(completedOutputItems)
            logForDebugging(
              `[codex-ws] recorded response_id=${responseId.slice(0, 16)} input_len=${fullInputLength} ` +
              `effort=${currentEffort} instructions_hash=${instructionsHash} output_items=${completedOutputItems.length}`,
            )
          }

          // Record send-path and timing to session JSONL.
          if (onSendPathComplete) {
            const nowTs = Date.now()
            const usage = (response?.usage as Record<string, unknown> | undefined)
            const inputDetails = (usage?.input_tokens_details ?? usage?.prompt_tokens_details) as Record<string, number> | undefined
            const cachedTokens = inputDetails?.cached_tokens ?? 0
            const rawInputTokens = typeof usage?.input_tokens === 'number' ? usage.input_tokens : undefined
            const ttfbMs = firstEventTs !== null ? firstEventTs - sendTs : undefined
            const totalStreamMs = nowTs - sendTs

            // Cold-turn full dump (behind CODEX_CACHE_COLD_DIAG=1)
            if (
              isEnvTruthy(process.env['CODEX_CACHE_COLD_DIAG']) &&
              cachedTokens === 0 &&
              (rawInputTokens ?? 0) > 20_000
            ) {
              logForDebugging(
                `[codex-cache] COLD_DIAG response.completed conv=${conversationId.slice(0, 8)} ` +
                `mode=${sendMode} prev_resp=${prevResponseIdAtSend?.slice(0, 16) ?? 'none'} ` +
                `input=${rawInputTokens} cached=0 ttfb=${ttfbMs}ms total=${totalStreamMs}ms ` +
                `instructions_hash=${instructionsHash} effort=${currentEffort}`,
                { level: 'warn' },
              )
            }

            onSendPathComplete({
              mode: sendMode,
              prev_response_id_prefix: prevResponseIdAtSend ? prevResponseIdAtSend.slice(0, 16) : null,
              sent_items: fullInputLength,
              prev_sent_items: prevSentItemsAtSend,
              instructions_hash: instructionsHash,
              effort: currentEffort,
              prompt_cache_key_prefix: conversationId.slice(0, 8),
              session_id_prefix: conversationId.slice(0, 8),
              account_id_prefix: session.accountId?.slice(0, 8) ?? null,
              ttfb_ms: ttfbMs,
              total_stream_ms: totalStreamMs,
              cached_tokens: cachedTokens,
              input_tokens: rawInputTokens,
            })
          }

          clearIdle()
          return
        }

        // response.failed: the attempt produced no committed baseline (state is
        // only recorded on response.completed above), so the PREVIOUS good
        // baseline is still valid to chain from. Item 3 rule 3: kill the socket
        // (its late events must not bleed into the next turn) but keep the
        // continuation baseline. Account-cap response.failed events are
        // reclassified upstream (createCodexResponseFailedError → clear +
        // CodexAccountCapError) so rotation still drops state where it must.
        if (event.type === 'response.failed') {
          reachedTerminalDisposition = true
          closeSocketPreservingState(conversationId)
          clearIdle()
          return
        }
      }

      // Wait for more messages.
      await waitForItem()
    }
  } finally {
    signal?.removeEventListener('abort', onAbort)
    session.ws.off('message', onMessage)
    session.ws.off('error', onError)
    session.ws.off('close', onClose)
    clearIdle()
    // Item 3 rule 5: if we exit without a terminal disposition and no error
    // handler already closed the socket (terminalError is set by failStream on
    // onError/idle/close), the consumer abandoned iteration mid-turn (Esc-abort).
    // The socket is still open and the server keeps streaming the dead turn — no
    // response.cancel is sent — so close it now (keeping the baseline) to stop
    // late events from poisoning the next turn.
    if (!reachedTerminalDisposition && !terminalError) {
      logForDebugging(
        `[codex-ws] turn abandoned mid-stream — closing socket, preserving baseline ` +
        `conv=${conversationId.slice(0, 8)}`,
        { level: 'warn' },
      )
      closeSocketPreservingState(conversationId)
    }
  }
}
