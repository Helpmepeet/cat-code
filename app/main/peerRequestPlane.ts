/**
 * The host request plane's consumer (decisions/HOST-REQUEST-PLANE.md §5).
 *
 * A sidecar sends `host.request`; this module validates it, does the bounded
 * thing, and answers with `host.result`. It is the whole trust story of the
 * inversion — everything WHO-MAY-ASK-WHOM-FOR-WHAT lives here — so it is
 * deliberately Electron-free and dependency-injected: main wires the real host,
 * registry and forwarder, tests wire fakes, and nothing in here can reach a
 * window, a file or a process on its own.
 *
 * The rules it implements, by their numbers, so a review can cite them:
 *
 *  - HR1 fail closed. Closed verb allowlist, strict top-level keys, per-verb arg
 *    validation, a typed error for every refusal and NEVER a throw into main,
 *    plus main's OWN size and rate bounds. The channel's 32 MiB decoder bound is
 *    a sanity bound, not a policy gate, and nothing here relies on it.
 *  - HR2 identity is the connection. The requester is the sessionId the
 *    supervisor read off the socket; a `from` inside a request is not a field
 *    this module has, let alone reads.
 *  - HR3 scope is the requester's own registry row. Every verb resolves only
 *    rows whose cwd equals the requester's, and `peer.create` sources its cwd
 *    from that row the same way the renderer's per-workspace "+" does. No path
 *    is ever authored by the model (HC1).
 *  - HR4 spawning stays bounded by HC4 and by the registry churn rule, both of
 *    which live in the host — this module opts into the churn rule and
 *    reimplements neither.
 *  - HR6 no file contents and no path cross the plane in either direction.
 *  - HR7 is the sidecar's `send` (secretGuard on every outbound frame).
 *
 * Every store here is IN-MEMORY and dies with the window (SESSION-LIFETIME L1),
 * and every one is cleared when a row is reaped.
 */

import {
  HOST_REQUEST_VERBS,
  type ActivityPresence,
  type HostRequestError,
  type HostRequestErrorCode,
  type HostRequestValues,
  type HostRequestVerb,
  type PeerDeliverMessage,
  type PeerDeliverOutcome,
  type PeerDescriptor,
  type PeerStatus,
  type SessionId,
  type SidecarClientMessage,
} from '../shared/protocol.js'
import {
  HOST_REQUEST_WINDOW_MS,
  MAX_HOST_REQUESTS_PER_WINDOW,
  MAX_HOST_REQUEST_BYTES,
  MAX_PEER_HOPS,
  MAX_PEER_TEXT_BYTES,
  MAX_PENDING_PEER_MESSAGES,
  PEER_CHAIN_WINDOW_MS,
  PEER_DEDUP_WINDOW_MS,
  PEER_SEND_BURST,
  PEER_SEND_REFILL_MS,
  PEER_WAKE_TIMEOUT_MS,
} from '../shared/limits.js'

/* ------------------------------------------------------------------------- *
 * Injected dependencies — the narrowest slice of each collaborator, so this
 * module can be driven without a Host, a registry file or a supervisor.
 * ------------------------------------------------------------------------- */

/** The registry row fields this plane reads. Nothing writes through here. */
export type PeerRegistryRow = {
  appSessionId: string
  engineSessionId: string | null
  cwd: string
  title?: string
  name?: string
  createdBy?: string
  peerWakeBlocked?: boolean
  lastAttachedAt: number
  lastMessageSentAt: number | null
  shutdown: 'clean' | 'crashed' | 'parked' | null
}

/** A named row, after the `peersOf` predicate has proven it has a name. */
type NamedRow = PeerRegistryRow & { name: string }

export type PeerRequestPlaneDeps = {
  /** Every current registry row, live and dead alike. Read-only. */
  rows: () => readonly PeerRegistryRow[]
  /** Is a sidecar process live for this row right now? */
  isLive: (appSessionId: SessionId) => boolean
  /**
   * HR4 — the host's own create path, with the peer options it already exposes.
   * Not reimplemented here: the HC4 caps and the churn rule are the host's, and
   * a second copy of either is a second thing to keep true.
   */
  createSessionInWorkspace: (
    fromAppSessionId: SessionId,
    peer: {
      createdBy: SessionId
      model?: string
      effort?: string
      enforceRegistryChurnLimit: true
    },
  ) => Promise<
    | { ok: true; value: { appSessionId: string; name?: string | null } }
    | { ok: false; error: { code: string; message: string } }
  >
  /** §4 step 5 — main's share of the wake. */
  restoreSession: (
    appSessionId: SessionId,
  ) => Promise<
    { ok: true } | { ok: false; error: { code: string; message: string } }
  >
  /**
   * Hand a message to the supervisor. Main's `forward` answers `null` when the
   * message was handed over and a closed error code when it was not.
   */
  forward: (appSessionId: SessionId, message: SidecarClientMessage) => unknown
  /** One metadata-only operational line per routed message (PEER-SESSIONS §10). */
  logRouted: (
    appSessionId: SessionId,
    fields: {
      from: string
      to: string
      kind: 'request' | 'creation'
      messageId: string
      outcome: string
    },
  ) => void
  log?: (line: string) => void
  now?: () => number
  newId?: () => string
  /**
   * How long to wait for a woken row's `ready`. Injected so a test does not have
   * to sit through `PEER_WAKE_TIMEOUT_MS`.
   */
  wakeTimeoutMs?: number
  /** Schedule the wake timeout. Injected for the same reason. */
  setTimer?: (fn: () => void, ms: number) => unknown
  clearTimer?: (handle: unknown) => void
}

/* ------------------------------------------------------------------------- *
 * Validation (HR1)
 *
 * Hand-written rather than Zod for one reason: Electron main has no Zod in its
 * graph today, and pulling a runtime dependency into the main process to check
 * four object shapes is a worse trade than writing them out. The CONTRACT the
 * decision asks for is what matters and is kept exactly — closed verb allowlist,
 * strict keys (an extra key is REJECTED, never stripped), per-verb field types,
 * a typed error out and never a throw. The SIDECAR still validates every inbound
 * result and delivery with its own local Zod schemas, so the trust boundary that
 * SECURITY-MINIMUM names is unchanged; this is the consumer's own gate on
 * model-authored input, which is a different check in a different direction.
 * ------------------------------------------------------------------------- */

const VERB_ARG_KEYS: Record<
  HostRequestVerb,
  { required: readonly string[]; optional: readonly string[] }
> = {
  'peers.list': { required: [], optional: [] },
  'peer.create': { required: ['prompt'], optional: ['model', 'effort'] },
  'peer.deliver': { required: ['to', 'text'], optional: [] },
  'peer.ack': { required: ['messageId'], optional: [] },
}

const FRAME_KEYS = new Set([
  'kind',
  'protocolVersion',
  'sessionId',
  'requestId',
  'verb',
  'args',
])

/** Bounds every free-form string arg that is NOT a message body. */
const MAX_ARG_CHARS = 256

/** The args whose size is governed by `MAX_PEER_TEXT_BYTES` instead. */
const BODY_ARGS = new Set(['text', 'prompt'])

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function utf8Bytes(value: string): number {
  return new TextEncoder().encode(value).byteLength
}

function fail(code: HostRequestErrorCode, message: string): HostRequestError {
  return { code, message }
}

/** The validated request, narrowed to one verb and its own arg shape. */
export type ValidatedHostRequest =
  | { verb: 'peers.list' }
  | { verb: 'peer.create'; prompt: string; model?: string; effort?: string }
  | { verb: 'peer.deliver'; to: string; text: string }
  | { verb: 'peer.ack'; messageId: string }

export type HostRequestValidation =
  | { ok: true; requestId: string; request: ValidatedHostRequest }
  | { ok: false; requestId: string | null; error: HostRequestError }

/**
 * Validate one decoded `host.request`. Returns the narrowed verb and args, or
 * the typed error to answer with. Never throws.
 */
export function validateHostRequest(frame: unknown): HostRequestValidation {
  if (!isPlainObject(frame)) {
    return {
      ok: false,
      requestId: null,
      error: fail('bad_request', 'request must be an object'),
    }
  }
  const rawId = frame.requestId
  if (
    typeof rawId !== 'string' ||
    rawId.length === 0 ||
    rawId.length > MAX_ARG_CHARS
  ) {
    return { ok: false, requestId: null, error: fail('bad_request', 'missing requestId') }
  }
  const requestId = rawId
  for (const key of Object.keys(frame)) {
    if (!FRAME_KEYS.has(key)) {
      return { ok: false, requestId, error: fail('bad_request', `unexpected key "${key}"`) }
    }
  }
  const verb = frame.verb
  if (
    typeof verb !== 'string' ||
    !(HOST_REQUEST_VERBS as readonly string[]).includes(verb)
  ) {
    return { ok: false, requestId, error: fail('unknown_verb', `unknown verb ${String(verb)}`) }
  }
  const args = frame.args ?? {}
  if (!isPlainObject(args)) {
    return { ok: false, requestId, error: fail('bad_request', 'args must be an object') }
  }

  // Read the shape by the verb STRING (the union narrowing comes from the switch
  // at the end), so the key allowlist and the type checks run once for all four.
  const shape = VERB_ARG_KEYS[verb as HostRequestVerb]
  for (const key of Object.keys(args)) {
    if (!shape.required.includes(key) && !shape.optional.includes(key)) {
      return { ok: false, requestId, error: fail('bad_request', `unexpected arg "${key}"`) }
    }
  }
  const strings: Record<string, string> = {}
  for (const key of shape.required) {
    const value = args[key]
    if (typeof value !== 'string' || value.length === 0) {
      return {
        ok: false,
        requestId,
        error: fail('bad_request', `${key} must be a non-empty string`),
      }
    }
    strings[key] = value
  }
  for (const key of shape.optional) {
    const value = args[key]
    if (value === undefined) continue
    if (typeof value !== 'string') {
      return { ok: false, requestId, error: fail('bad_request', `${key} must be a string`) }
    }
    strings[key] = value
  }
  for (const [key, value] of Object.entries(strings)) {
    if (BODY_ARGS.has(key)) {
      if (utf8Bytes(value) > MAX_PEER_TEXT_BYTES) {
        return { ok: false, requestId, error: fail('too_large', `${key} is too long`) }
      }
    } else if (value.length > MAX_ARG_CHARS) {
      return { ok: false, requestId, error: fail('bad_request', `${key} is too long`) }
    }
  }

  switch (verb) {
    case 'peers.list':
      return { ok: true, requestId, request: { verb } }
    case 'peer.create':
      return {
        ok: true,
        requestId,
        request: {
          verb,
          prompt: strings.prompt as string,
          ...(strings.model !== undefined ? { model: strings.model } : {}),
          ...(strings.effort !== undefined ? { effort: strings.effort } : {}),
        },
      }
    case 'peer.deliver':
      return {
        ok: true,
        requestId,
        request: { verb, to: strings.to as string, text: strings.text as string },
      }
    case 'peer.ack':
      return {
        ok: true,
        requestId,
        request: { verb, messageId: strings.messageId as string },
      }
    default:
      return { ok: false, requestId, error: fail('unknown_verb', `unknown verb ${verb}`) }
  }
}

/* ------------------------------------------------------------------------- *
 * The plane
 * ------------------------------------------------------------------------- */

type Bucket = { tokens: number; lastRefillAt: number }
type ChainRecord = { chain: SessionId[]; fromAppSessionId: SessionId; at: number }
type PendingMessage = {
  messageId: string
  toAppSessionId: SessionId
  message: PeerDeliverMessage
  fromName: string
  toName: string
  kind: 'request' | 'creation'
  outcome: PeerDeliverOutcome
}
type ReadyWaiter = { resolve: (ready: boolean) => void; timer: unknown }

/** Live → parked → closed, then most recent first (PEER-SESSIONS §3). */
const STATUS_ORDER: Record<PeerStatus, number> = { live: 0, parked: 1, closed: 2 }

export type PeerRequestPlane = {
  /** One decoded `host.request` from `sessionId`'s socket. */
  handleRequest: (sessionId: SessionId, frame: unknown) => Promise<void>
  /** The row's latest `activity`. */
  recordActivity: (sessionId: SessionId, presence: ActivityPresence) => void
  /** That row announced itself. Releases wake waiters and redelivers unacked. */
  onReady: (sessionId: SessionId) => void
  /** The row's process ended. Presence is a live-only fact. */
  onSessionDown: (sessionId: SessionId) => void
  /** The row left the registry. Every per-row and per-pair store goes with it. */
  onSessionRemoved: (sessionId: SessionId) => void
  /** What main is still holding for a recipient (unacked message ids). */
  pendingFor: (sessionId: SessionId) => readonly string[]
  /** The presence main last heard from a row, for `peers.list` and for tests. */
  presenceOf: (sessionId: SessionId) => ActivityPresence | undefined
}

export function createPeerRequestPlane(deps: PeerRequestPlaneDeps): PeerRequestPlane {
  const now = deps.now ?? (() => Date.now())
  const newId = deps.newId ?? (() => globalThis.crypto.randomUUID())
  const log = deps.log ?? (() => {})
  const wakeTimeoutMs = deps.wakeTimeoutMs ?? PEER_WAKE_TIMEOUT_MS
  const setTimer = deps.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms))
  const clearTimer =
    deps.clearTimer ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>))

  /** HR1 — per requesting session, all verbs together. */
  const requestWindow = new Map<SessionId, number[]>()
  /** Presence, per LIVE row only (§4 step 4a). */
  const presence = new Map<SessionId, ActivityPresence>()
  /** Per `(from, to)` token bucket (§4 step 3). */
  const buckets = new Map<string, Bucket>()
  /** Identical body → same recipient, inside the dedup window (§4 step 3). */
  const recentBodies = new Map<string, number>()
  /**
   * The chain of the last message main delivered TO each row, and who sent it.
   * Keyed by recipient because that is what a send reads: the requester inherits
   * the chain last delivered to IT (§4 step 2).
   */
  const lastChainTo = new Map<SessionId, ChainRecord>()
  /** Messages main is holding: forwarded but not yet acked. */
  const pending = new Map<SessionId, PendingMessage[]>()
  /** Callers parked on a row's next `ready`. */
  const readyWaiters = new Map<SessionId, ReadyWaiter[]>()

  function rowFor(appSessionId: string): PeerRegistryRow | undefined {
    return deps.rows().find(row => row.appSessionId === appSessionId)
  }

  function statusOf(row: PeerRegistryRow): PeerStatus {
    if (deps.isLive(row.appSessionId)) return 'live'
    return row.shutdown === 'parked' ? 'parked' : 'closed'
  }

  function nameKey(value: string): string {
    return value.trim().toLowerCase()
  }

  function isNamed(row: PeerRegistryRow): row is NamedRow {
    return typeof row.name === 'string' && row.name.length > 0
  }

  /**
   * HR3 — the addressable set, from the REQUESTER's own row: every named row in
   * the same workspace, minus the requester itself. A row outside it is not
   * "denied", it is invisible, and naming one answers `session_not_found`, the
   * HC2 answer for an id the caller may not name.
   */
  function peersOf(requesterRow: PeerRegistryRow): NamedRow[] {
    return deps
      .rows()
      .filter(
        (row): row is NamedRow =>
          row.appSessionId !== requesterRow.appSessionId &&
          row.cwd === requesterRow.cwd &&
          isNamed(row),
      )
  }

  function describe(row: NamedRow): PeerDescriptor {
    const status = statusOf(row)
    const creatorId = row.createdBy
    const creator =
      creatorId === undefined
        ? undefined
        : {
            appSessionId: creatorId,
            // Resolved at READ time, and null when the creator's row is gone:
            // names are released on reap and reused, ids are not, so a stored
            // name could silently come to mean a different session.
            name: rowFor(creatorId)?.name ?? null,
          }
    const live = status === 'live' ? presence.get(row.appSessionId) : undefined
    return {
      name: row.name,
      appSessionId: row.appSessionId,
      engineSessionId: row.engineSessionId,
      status,
      ...(live !== undefined ? { presence: live } : {}),
      ...(creator !== undefined ? { createdBy: creator } : {}),
      title: row.title ?? null,
      lastActivity: row.lastMessageSentAt ?? row.lastAttachedAt,
    }
  }

  function answer(
    sessionId: SessionId,
    requestId: string,
    result:
      | { ok: true; value: HostRequestValues[HostRequestVerb] }
      | { ok: false; error: HostRequestError },
  ): void {
    deps.forward(sessionId, {
      type: 'host.result',
      requestId,
      ...(result.ok
        ? { ok: true, value: result.value }
        : { ok: false, error: result.error }),
    })
  }

  function withinRate(sessionId: SessionId): boolean {
    const at = now()
    const seen = (requestWindow.get(sessionId) ?? []).filter(
      stamp => at - stamp < HOST_REQUEST_WINDOW_MS,
    )
    if (seen.length >= MAX_HOST_REQUESTS_PER_WINDOW) {
      requestWindow.set(sessionId, seen)
      return false
    }
    seen.push(at)
    requestWindow.set(sessionId, seen)
    return true
  }

  /** §4 step 3 — one token per send, per ordered pair. */
  function takeToken(from: SessionId, to: SessionId): boolean {
    const key = `${from}|${to}`
    const at = now()
    const bucket = buckets.get(key) ?? { tokens: PEER_SEND_BURST, lastRefillAt: at }
    const refilled = Math.floor((at - bucket.lastRefillAt) / PEER_SEND_REFILL_MS)
    if (refilled > 0) {
      bucket.tokens = Math.min(PEER_SEND_BURST, bucket.tokens + refilled)
      bucket.lastRefillAt += refilled * PEER_SEND_REFILL_MS
    }
    if (bucket.tokens <= 0) {
      buckets.set(key, bucket)
      return false
    }
    bucket.tokens -= 1
    buckets.set(key, bucket)
    return true
  }

  function isDuplicate(to: SessionId, text: string): boolean {
    const at = now()
    for (const [key, stamp] of recentBodies) {
      if (at - stamp >= PEER_DEDUP_WINDOW_MS) recentBodies.delete(key)
    }
    // The body is a map KEY held in memory for the dedup window and nothing
    // else: it is never written anywhere, and the operational line records the
    // id and the outcome, never this (PEER-SESSIONS §10, "Content never").
    const key = `${to}|${text}`
    if (recentBodies.has(key)) return true
    recentBodies.set(key, at)
    return false
  }

  /**
   * §4 step 2, with the one reading of its two guard sentences that leaves both
   * guards alive. This is a flagged deviation, and here is the derivation.
   *
   * The decision says main keeps one chain per `(from, to)` pair, that a send
   * inherits "the chain last delivered TO the requester", and that main refuses a
   * send "whose chain already contains the recipient". Taken literally those
   * sentences cannot both hold. A chain delivered to A by B always ENDS with B,
   * so under the literal test A's reply to B is refused as a loop — every reply
   * is, on the very first one — and `MAX_PEER_HOPS` becomes unreachable dead
   * code, while §6 owes a test in which two sessions answering each other stop
   * AT that cap.
   *
   * The rule implemented is: a send is a loop when the recipient is ALREADY IN
   * the inherited chain AND IS NOT ITS LAST ENTRY. The last entry is, by
   * construction, the peer who just wrote to the requester, so answering it is
   * never a loop however many times the two have gone back and forth; reaching
   * PAST it to someone earlier in the chain is the thing that closes a cycle.
   *
   *   A→B, B→A, A→B, …   the recipient is always the chain's last entry, so the
   *                      chain grows one per hop and the exchange stops at
   *                      MAX_PEER_HOPS (hop_runaway), never at hop_loop.
   *   A→B, B→C, C→A      inherited [A, B], last is B, recipient A is present and
   *                      is not last: hop_loop, on the hop that closes the cycle.
   *   A→B, B→C, C→B      inherited [A, B], last is B, recipient IS last: allowed.
   *                      This is the report-back R2 makes the delivery model for
   *                      ("when done, message Alex") one rung down the R8 ladder,
   *                      and refusing it would break the feature's primary
   *                      workflow with a loop refusal the model did not cause.
   *   A→B, B→C, C→B, …   a two-party sub-exchange between B and C, each hop
   *                      answering the last sender: bounded by MAX_PEER_HOPS.
   *
   * A self-send is a loop of one and is refused the same way. Nothing here reads
   * anything the sending sidecar wrote: the chain is main's own record, so a
   * compromised sidecar cannot launder a loop by shortening what it never held,
   * and it cannot escape either guard by omitting a field it never sends.
   */
  function buildHops(
    from: SessionId,
    to: SessionId,
  ): { hops: SessionId[] } | { refusal: 'hop_loop' | 'hop_runaway' } {
    if (from === to) return { refusal: 'hop_loop' }
    const record = lastChainTo.get(from)
    const inherited =
      record !== undefined && now() - record.at <= PEER_CHAIN_WINDOW_MS ? record.chain : []
    const hops = [...inherited, from]
    const answersLastSender = inherited[inherited.length - 1] === to
    const refusal =
      inherited.includes(to) && !answersLastSender
        ? ('hop_loop' as const)
        : hops.length > MAX_PEER_HOPS
          ? ('hop_runaway' as const)
          : null
    if (refusal !== null) {
      // A refused hop still ADVANCES the pair, and it has to, or the stop is not
      // a stop. Without this the two directions' chains drift by one: A is
      // refused at the cap while B still holds the shorter chain it was last
      // delivered, so B sends, A is refused again, B sends again — one message
      // every other attempt, forever. Recording the over-cap chain against the
      // recipient makes the next hop in EITHER direction inherit it, so the
      // exchange stops dead on the hop after the cap instead of leaking.
      lastChainTo.set(to, { chain: hops, fromAppSessionId: from, at: now() })
      return { refusal }
    }
    return { hops }
  }

  /**
   * §4 step 6 — main holds a forwarded message until the recipient acks that it
   * reached the engine command queue. A recipient that exits with it unacked
   * gets it again after its next `ready`.
   */
  function hold(entry: PendingMessage): void {
    const list = pending.get(entry.toAppSessionId)
    if (list) list.push(entry)
    else pending.set(entry.toAppSessionId, [entry])
  }

  function release(sessionId: SessionId, messageId: string): PendingMessage | undefined {
    const list = pending.get(sessionId)
    if (!list) return undefined
    const index = list.findIndex(entry => entry.messageId === messageId)
    if (index === -1) return undefined
    const entry = list[index]
    list.splice(index, 1)
    if (list.length === 0) pending.delete(sessionId)
    return entry
  }

  function awaitReady(sessionId: SessionId): Promise<boolean> {
    return new Promise<boolean>(resolve => {
      const waiter: ReadyWaiter = {
        resolve,
        timer: setTimer(() => {
          const list = readyWaiters.get(sessionId)
          if (list) {
            const index = list.indexOf(waiter)
            if (index !== -1) list.splice(index, 1)
            if (list.length === 0) readyWaiters.delete(sessionId)
          }
          resolve(false)
        }, wakeTimeoutMs),
      }
      const list = readyWaiters.get(sessionId)
      if (list) list.push(waiter)
      else readyWaiters.set(sessionId, [waiter])
    })
  }

  /* --------------------------------------------------------------------- *
   * Verbs
   * --------------------------------------------------------------------- */

  function handlePeersList(requesterRow: PeerRegistryRow): HostRequestValues['peers.list'] {
    const peers = peersOf(requesterRow)
      .map(describe)
      .sort(
        (a, b) =>
          STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || b.lastActivity - a.lastActivity,
      )
    return { peers }
  }

  async function handlePeerCreate(
    sessionId: SessionId,
    requesterRow: PeerRegistryRow,
    request: Extract<ValidatedHostRequest, { verb: 'peer.create' }>,
  ): Promise<
    | { ok: true; value: HostRequestValues['peer.create'] }
    | { ok: false; error: HostRequestError }
  > {
    const created = await deps.createSessionInWorkspace(sessionId, {
      createdBy: sessionId,
      ...(request.model !== undefined ? { model: request.model } : {}),
      ...(request.effort !== undefined ? { effort: request.effort } : {}),
      // HR4 — opt in. The rule exists for the one caller that can
      // create-park-create at machine speed; a person clicking "+" cannot, and
      // refusing them a tab because 256 rows are parked would be a regression.
      enforceRegistryChurnLimit: true,
    })
    if (!created.ok) {
      return { ok: false, error: fail(mapHostErrorCode(created.error.code), created.error.message) }
    }
    const appSessionId = created.value.appSessionId
    const name = created.value.name ?? ''
    const fromName = requesterRow.name ?? ''

    // §2 — await the new row's ready, then deliver the creation prompt. Both
    // failures KEEP the row: it is a real session the operator can see, and the
    // caller can send it the prompt itself.
    const ready = await awaitReady(appSessionId)
    if (!ready) {
      return { ok: true, value: { name, appSessionId, failedStep: 'ready' } }
    }

    const messageId = newId()
    const message: PeerDeliverMessage = {
      type: 'peer.deliver',
      messageId,
      from: fromName,
      fromSessionId: sessionId,
      text: request.prompt,
      hops: [sessionId],
      // PEER-SESSIONS §5 — the one message that is not framed as peer-sent.
      untagged: true,
    }
    if (!forwarded(appSessionId, message)) {
      deps.logRouted(sessionId, {
        from: fromName,
        to: name,
        kind: 'creation',
        messageId,
        outcome: 'refused:wake_failed',
      })
      return { ok: true, value: { name, appSessionId, failedStep: 'prompt' } }
    }
    hold({
      messageId,
      toAppSessionId: appSessionId,
      message,
      fromName,
      toName: name,
      kind: 'creation',
      outcome: 'queued_wake',
    })
    lastChainTo.set(appSessionId, {
      chain: [sessionId],
      fromAppSessionId: sessionId,
      at: now(),
    })
    return { ok: true, value: { name, appSessionId } }
  }

  async function handlePeerDeliver(
    sessionId: SessionId,
    requesterRow: PeerRegistryRow,
    request: Extract<ValidatedHostRequest, { verb: 'peer.deliver' }>,
  ): Promise<
    | { ok: true; value: HostRequestValues['peer.deliver'] }
    | { ok: false; error: HostRequestError }
  > {
    // §4 step 1 — resolve the name inside the requester's own workspace.
    const target = peersOf(requesterRow).find(
      row => nameKey(row.name) === nameKey(request.to),
    )
    if (!target) {
      return {
        ok: false,
        error: fail('session_not_found', `no session named ${request.to} in this workspace`),
      }
    }
    const fromName = requesterRow.name ?? ''
    const toName = target.name
    const messageId = newId()
    const live = deps.isLive(target.appSessionId)

    // Every refusal is typed AND logged: §4 step 3, "nothing is dropped
    // silently". It is reported as a successful REQUEST carrying a refused
    // OUTCOME, not as an error, because the send did happen and the model needs
    // to read why it went nowhere.
    const refuse = (outcome: PeerDeliverOutcome) => {
      deps.logRouted(sessionId, {
        from: fromName,
        to: toName,
        kind: 'request',
        messageId,
        outcome,
      })
      return { ok: true as const, value: { messageId, outcome } }
    }

    // §6 — the wake block is about REOPENING, so a live row ignores it.
    if (!live && target.peerWakeBlocked === true) return refuse('refused:user_stopped')

    const chain = buildHops(sessionId, target.appSessionId)
    if ('refusal' in chain) return refuse(`refused:${chain.refusal}`)
    if (!takeToken(sessionId, target.appSessionId)) return refuse('refused:rate')
    if (isDuplicate(target.appSessionId, request.text)) return refuse('refused:duplicate')
    if ((pending.get(target.appSessionId)?.length ?? 0) >= MAX_PENDING_PEER_MESSAGES) {
      return refuse('refused:queue_full')
    }

    const message: PeerDeliverMessage = {
      type: 'peer.deliver',
      messageId,
      from: fromName,
      fromSessionId: sessionId,
      text: request.text,
      hops: chain.hops,
    }

    if (!live) {
      // §4 step 5 — main's OWN deliver-after-ready. `already restoring` and
      // `already live` both currently answer `session_not_found`, and neither is
      // a missing row: treat them as pending and wait for the row's next ready.
      const restored = await deps.restoreSession(target.appSessionId)
      if (!restored.ok && restored.error.code !== 'session_not_found') {
        return refuse('refused:wake_failed')
      }
      // Never `session_not_found` from here on: HR3 reserves that code for a row
      // the caller may not name, and this one it may.
      if (!(await awaitReady(target.appSessionId))) return refuse('refused:wake_failed')
    }

    if (!forwarded(target.appSessionId, message)) return refuse('refused:wake_failed')

    const outcome: PeerDeliverOutcome = live ? 'queued_live' : 'queued_wake'
    hold({
      messageId,
      toAppSessionId: target.appSessionId,
      message,
      fromName,
      toName,
      kind: 'request',
      outcome,
    })
    lastChainTo.set(target.appSessionId, {
      chain: chain.hops,
      fromAppSessionId: sessionId,
      at: now(),
    })
    return { ok: true, value: { messageId, outcome } }
  }

  /**
   * §4 step 6 — "on ack main writes the metadata-only operational-log line and
   * forgets the message". So a delivered message writes its ONE line here, with
   * the outcome it was routed under; a refused one wrote its line at the refusal
   * and never reaches this path. Exactly one line per message, either way.
   */
  function handlePeerAck(
    sessionId: SessionId,
    request: Extract<ValidatedHostRequest, { verb: 'peer.ack' }>,
  ):
    | { ok: true; value: HostRequestValues['peer.ack'] }
    | { ok: false; error: HostRequestError } {
    const entry = release(sessionId, request.messageId)
    if (entry) {
      deps.logRouted(sessionId, {
        from: entry.fromName,
        to: entry.toName,
        kind: entry.kind,
        messageId: entry.messageId,
        outcome: entry.outcome,
      })
    }
    // A second ack for a message already forgotten is the ordinary shape of a
    // crash-window duplicate, not an error the caller can act on.
    return { ok: true, value: { messageId: request.messageId } }
  }

  /** True when the supervisor took the message (main's `forward` answers null). */
  function forwarded(appSessionId: SessionId, message: SidecarClientMessage): boolean {
    const failure = deps.forward(appSessionId, message)
    return failure === null || failure === undefined
  }

  function mapHostErrorCode(code: string): HostRequestErrorCode {
    switch (code) {
      case 'session_limit':
      case 'invalid_cwd':
      case 'spawn_failed':
      case 'session_not_found':
        return code
      default:
        return 'internal_error'
    }
  }

  /* --------------------------------------------------------------------- *
   * Entry points
   * --------------------------------------------------------------------- */

  async function handleRequest(sessionId: SessionId, frame: unknown): Promise<void> {
    const validated = validateHostRequest(frame)

    // HR1 — main's OWN size bound, on the serialized request, at the consumer.
    // Measured before anything is done with the request and after the requestId
    // is known, so an oversize frame is still ANSWERED rather than dropped.
    let serialized: string | undefined
    try {
      serialized = JSON.stringify(frame)
    } catch {
      serialized = undefined
    }
    if (serialized === undefined || utf8Bytes(serialized) > MAX_HOST_REQUEST_BYTES) {
      log(`[peer-plane] refused oversize host.request from ${sessionId}`)
      if (validated.requestId !== null) {
        answer(sessionId, validated.requestId, {
          ok: false,
          error: fail('too_large', 'request is too large'),
        })
      }
      return
    }
    if (!validated.ok) {
      log(`[peer-plane] rejected host.request from ${sessionId}: ${validated.error.message}`)
      if (validated.requestId !== null) {
        answer(sessionId, validated.requestId, { ok: false, error: validated.error })
      }
      return
    }
    if (!withinRate(sessionId)) {
      answer(sessionId, validated.requestId, {
        ok: false,
        error: fail('rate_limited', 'too many requests; try again shortly'),
      })
      return
    }

    // HR2/HR3 — everything below is scoped by the REQUESTER's own row, resolved
    // from the connection's sessionId. There is no `from` on the wire to read.
    const requesterRow = rowFor(sessionId)
    if (!requesterRow) {
      answer(sessionId, validated.requestId, {
        ok: false,
        error: fail('session_not_found', 'this session has no workspace'),
      })
      return
    }

    const request = validated.request
    try {
      switch (request.verb) {
        case 'peers.list':
          answer(sessionId, validated.requestId, {
            ok: true,
            value: handlePeersList(requesterRow),
          })
          return
        case 'peer.create':
          answer(
            sessionId,
            validated.requestId,
            await handlePeerCreate(sessionId, requesterRow, request),
          )
          return
        case 'peer.deliver':
          answer(
            sessionId,
            validated.requestId,
            await handlePeerDeliver(sessionId, requesterRow, request),
          )
          return
        case 'peer.ack':
          answer(sessionId, validated.requestId, handlePeerAck(sessionId, request))
          return
        default: {
          // Closed-union tripwire: a verb added to `HOST_REQUEST_VERBS` and to
          // `ValidatedHostRequest` without a case here fails to compile rather
          // than falling through to silence.
          const exhaustive: never = request
          answer(sessionId, validated.requestId, {
            ok: false,
            error: fail('unknown_verb', `unhandled verb ${JSON.stringify(exhaustive)}`),
          })
          return
        }
      }
    } catch (error) {
      // HR1 — never a throw into main.
      log(
        `[peer-plane] ${request.verb} failed for ${sessionId}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      )
      answer(sessionId, validated.requestId, {
        ok: false,
        error: fail('internal_error', 'the request could not be completed'),
      })
    }
  }

  function onReady(sessionId: SessionId): void {
    const waiters = readyWaiters.get(sessionId)
    if (waiters) {
      readyWaiters.delete(sessionId)
      for (const waiter of waiters) {
        clearTimer(waiter.timer)
        waiter.resolve(true)
      }
    }
    // §4 step 6 — anything this row never acked is redelivered now, over the
    // same store and the same path a parked row's message took. A `ready` that
    // follows the ORIGINAL forward (the create path waits for exactly that one)
    // finds nothing held yet, so this cannot double-send the message it is
    // waiting for.
    const held = pending.get(sessionId)
    if (!held || held.length === 0) return
    for (const entry of [...held]) {
      deps.forward(sessionId, entry.message)
    }
  }

  return {
    handleRequest,
    recordActivity: (sessionId, next) => {
      presence.set(sessionId, next)
    },
    onReady,
    onSessionDown: sessionId => {
      presence.delete(sessionId)
    },
    onSessionRemoved: sessionId => {
      presence.delete(sessionId)
      pending.delete(sessionId)
      requestWindow.delete(sessionId)
      lastChainTo.delete(sessionId)
      const waiters = readyWaiters.get(sessionId)
      if (waiters) {
        readyWaiters.delete(sessionId)
        for (const waiter of waiters) {
          clearTimer(waiter.timer)
          waiter.resolve(false)
        }
      }
      for (const key of [...buckets.keys()]) {
        if (key.startsWith(`${sessionId}|`) || key.endsWith(`|${sessionId}`)) {
          buckets.delete(key)
        }
      }
      for (const key of [...recentBodies.keys()]) {
        if (key.startsWith(`${sessionId}|`)) recentBodies.delete(key)
      }
      for (const [to, record] of [...lastChainTo.entries()]) {
        if (record.fromAppSessionId === sessionId) lastChainTo.delete(to)
      }
    },
    pendingFor: sessionId => (pending.get(sessionId) ?? []).map(entry => entry.messageId),
    presenceOf: sessionId => presence.get(sessionId),
  }
}
