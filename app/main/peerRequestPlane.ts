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
  PROTOCOL_VERSION,
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
  MAX_HOST_REQUEST_ARG_CHARS,
  MAX_HOST_REQUEST_BYTES,
  MAX_HOST_REQUEST_FRAMES_PER_WINDOW,
  MAX_PEER_DELIVERY_ATTEMPTS,
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
  /** Does a sidecar record still EXIST for this row, live or in between? */
  isLive: (appSessionId: SessionId) => boolean
  /**
   * Can this row take a frame right now? A different question from `isLive`,
   * and the delivery path needs this one. A row that is spawning, connecting or
   * disconnected still EXISTS, so `isLive` says yes, but its socket will refuse
   * the frame; treating that as live skips the wake entirely and the send is
   * lost with nothing left to retry it.
   *
   * REQUIRED, with no fallback to `isLive`, and that is the point. It shipped
   * optional with exactly that fallback, main never passed it, and the fix was
   * inert for a day behind a fully green battery: an optional dependency can be
   * forgotten silently, a required one cannot, because the compiler refuses the
   * build. The stricter readiness answer is one only the composer can give, so
   * there is no honest default for it to fall back to.
   */
  isReady: (appSessionId: SessionId) => boolean
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
  /**
   * One metadata-only operational line per routed message (PEER-SESSIONS §10).
   *
   * The `appSessionId` is always the SENDER's, whatever the outcome. The line
   * exists to answer "which session caused this", and a delivered message
   * attributed to its recipient while a refused one is attributed to its sender
   * makes that answer depend on how the message ended, which is the one thing
   * the reader is trying to find out.
   */
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
  /**
   * How long to wait for one host call (`restoreSession`, `createSessionInWorkspace`)
   * before giving up on it. See `PEER_HOST_CALL_TIMEOUT_MS`.
   */
  hostCallTimeoutMs?: number
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
  // Every ServerFrame may carry the metadata-only delivery envelope
  // (`protocol.ts` `ServerFrame`), and `host.request` is one: the sidecar stamps
  // it at its single outbound send path and the supervisor merges it back onto
  // the frame as a top-level key. Omitting it here refused EVERY peer request
  // that crossed a real socket. It is ACCEPTED and then IGNORED — nothing below
  // reads it, and nothing on this plane may: it is not identity (HR2 — the
  // requester is the connection), not authority, and never routing input.
  'deliveryTrace',
])

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

/**
 * The correlation id off an UNVALIDATED frame, for answering a refusal that
 * happens before validation (a flood, an oversize payload). It is echoed back
 * and nothing else; it names no work and authorizes none.
 */
function readRequestId(frame: unknown): string | null {
  if (!isPlainObject(frame)) return null
  const value = frame.requestId
  return typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_HOST_REQUEST_ARG_CHARS
    ? value
    : null
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
    rawId.length > MAX_HOST_REQUEST_ARG_CHARS
  ) {
    return { ok: false, requestId: null, error: fail('bad_request', 'missing requestId') }
  }
  const requestId = rawId
  for (const key of Object.keys(frame)) {
    if (!FRAME_KEYS.has(key)) {
      return { ok: false, requestId, error: fail('bad_request', `unexpected key "${key}"`) }
    }
  }
  // F9 — every other validated surface on this wire checks the envelope version,
  // and this one admitted the key without ever comparing it. A frame from a
  // future protocol must be refused here rather than interpreted under this
  // one's field meanings.
  if (
    frame.protocolVersion !== undefined &&
    frame.protocolVersion !== PROTOCOL_VERSION
  ) {
    return {
      ok: false,
      requestId,
      error: fail('bad_request', 'unsupported protocolVersion'),
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
    } else if (value.length > MAX_HOST_REQUEST_ARG_CHARS) {
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

/**
 * The bound on ONE host call made while a `host.request` is outstanding.
 *
 * The sidecar settles its caller after `HOST_REQUEST_TIMEOUT_MS` (45 s) and
 * forgets the id, so anything main takes longer than that over is work whose
 * answer nobody will ever read: for `peer.create` that means main goes on to
 * spawn a session the caller was told it did not get, and a retry spawns a
 * second one. `limits.ts` reasons that the 30 s ready wait is the longest main
 * can legitimately take, but a restore or a spawn runs BEFORE that wait and was
 * unbounded, so the two ran back to back and the total could pass 45 s with
 * both steps behaving normally. Ten seconds plus the 30 s wait keeps main's
 * worst case under the sidecar's cap with room to answer.
 *
 * It lives here rather than in `limits.ts` because it bounds a call this module
 * makes, not a value that crosses the wire.
 */
const PEER_HOST_CALL_TIMEOUT_MS = 10_000

type Bucket = { tokens: number; lastRefillAt: number }
/**
 * One record of a hop main routed toward `recipient` from `sender`. `viaRefusal`
 * marks a hop that was REFUSED rather than delivered — see `buildHops` for why
 * those two are stored together but inherited differently.
 *
 * `chain` and `pairHops` are two DIFFERENT quantities and answer two different
 * questions; `buildHops` derives both and explains why they had to be split.
 */
type ChainRecord = {
  chain: SessionId[]
  /** Hops this pair has exchanged, counting both directions of the exchange. */
  pairHops: number
  viaRefusal: boolean
  at: number
}
type PendingMessage = {
  messageId: string
  toAppSessionId: SessionId
  message: PeerDeliverMessage
  fromName: string
  toName: string
  kind: 'request' | 'creation'
  outcome: PeerDeliverOutcome
  /**
   * How many times this message has been handed to the recipient's process,
   * counting the first. Bounded by `MAX_PEER_DELIVERY_ATTEMPTS` so a message the
   * recipient REJECTS rather than drops cannot be re-sent on every subsequent
   * ready forever, holding a pending slot for the life of the window.
   */
  attempts: number
}
type ReadyWaiter = { resolve: (ready: boolean) => void; timer: unknown }

/** Live → parked → closed, then most recent first (PEER-SESSIONS §3). */
const STATUS_ORDER: Record<PeerStatus, number> = { live: 0, parked: 1, closed: 2 }

/**
 * What a row's own engine says it is running (`RunControlsSnapshot`), reduced to
 * the two fields `peers.list` reports. Null is the engine's own "could not
 * resolve", and never reaches a descriptor.
 */
export type PeerRunControls = { model: string | null; effort: string | null }

export type PeerRequestPlane = {
  /** One decoded `host.request` from `sessionId`'s socket. */
  handleRequest: (sessionId: SessionId, frame: unknown) => Promise<void>
  /** The row's latest `activity`. */
  recordActivity: (sessionId: SessionId, presence: ActivityPresence) => void
  /**
   * The row's latest `run-controls.snapshot`, reduced to the two fields the
   * roster reports. Main passes the engine's OWN resolved values; nulls mean the
   * engine could not resolve one, and are stored as "unknown", not as a value.
   */
  recordRunControls: (sessionId: SessionId, controls: PeerRunControls) => void
  /** That row announced itself. Releases wake waiters and redelivers unacked. */
  onReady: (sessionId: SessionId) => void
  /**
   * The row's process ended. Presence is a live-only fact and goes; the model
   * and effort stay, because a parked row still runs on them (`runControls`).
   */
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
  const hostCallTimeoutMs = deps.hostCallTimeoutMs ?? PEER_HOST_CALL_TIMEOUT_MS
  const isReady = deps.isReady
  const setTimer = deps.setTimer ?? ((fn: () => void, ms: number) => setTimeout(fn, ms))
  const clearTimer =
    deps.clearTimer ?? ((handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>))

  /**
   * HR1 — the MODEL's allowance, charged only for model-facing verbs. An ack is
   * main-induced bookkeeping and is deliberately not charged here (F4): senders
   * would otherwise spend the recipient's budget and starve it off the plane.
   */
  const verbWindow = new Map<SessionId, number[]>()
  /**
   * HR1 / A6 — the flood bound, charged on EVERY frame before it is parsed or
   * serialized, valid or not, ack or not.
   */
  const frameWindow = new Map<SessionId, number[]>()
  /** Presence, per LIVE row only (§4 step 4a). */
  const presence = new Map<SessionId, ActivityPresence>()
  /**
   * Model + effort, per row that has announced one this run.
   *
   * Unlike `presence` this SURVIVES the row's process ending: a parked row's
   * engine is gone, so nothing can move its model while it is parked, and the
   * value is what a caller deciding whom to wake needs. It is reported only for
   * a row that is not closed (`describe`), and it goes with the row on reap.
   */
  const runControls = new Map<SessionId, PeerRunControls>()
  /** Per `(from, to)` token bucket (§4 step 3). */
  const buckets = new Map<string, Bucket>()
  /** Identical body → same sender, same recipient, inside the dedup window (§4 step 3). */
  const recentBodies = new Map<string, number>()
  /**
   * Hop chains, keyed by the ORDERED pair `recipient|sender`.
   *
   * Keyed by pair, not by recipient alone, because a single slot per recipient is
   * shared mutable state that any peer can write: an unrelated message overwrites
   * a live conversation's chain, and a refusal writes onto a key an uninvolved
   * pair then inherits. Both are exploitable; see `buildHops`.
   */
  const chains = new Map<string, ChainRecord>()
  /** Messages main is holding: forwarded but not yet acked. */
  const pending = new Map<SessionId, PendingMessage[]>()
  /** Pending slots claimed by a delivery that is still waking its recipient. */
  const reservations = new Map<SessionId, number>()
  /** Callers parked on a row's next `ready`. */
  const readyWaiters = new Map<SessionId, ReadyWaiter[]>()
  /**
   * F11 — when each row last announced itself.
   *
   * `awaitReady` can only register AFTER the host call it is waiting behind
   * resolves, and `onReady` is fire-once with no memory, so a `ready` that lands
   * in that gap used to be missed entirely: the caller then waited out the full
   * wake timeout and reported `failedStep: 'ready'` or `refused:wake_failed` for
   * a session that was fine. A one-entry-per-row timestamp closes it without a
   * state machine — a waiter registering just after a ready resolves at once.
   */
  const lastReadyAt = new Map<SessionId, number>()

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
    // A closed row carries no model: the reader cannot act on it, rows from an
    // earlier launch have no observation at all, and a field present on some
    // closed rows and absent on others reads as a difference between the
    // sessions rather than between what main happened to see.
    const running = status === 'closed' ? undefined : runControls.get(row.appSessionId)
    return {
      name: row.name,
      appSessionId: row.appSessionId,
      engineSessionId: row.engineSessionId,
      status,
      ...(live !== undefined ? { presence: live } : {}),
      ...(running?.model ? { model: running.model } : {}),
      ...(running?.effort ? { effort: running.effort } : {}),
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

  function charge(
    window: Map<SessionId, number[]>,
    sessionId: SessionId,
    cap: number,
  ): boolean {
    const at = now()
    const seen = (window.get(sessionId) ?? []).filter(
      stamp => at - stamp < HOST_REQUEST_WINDOW_MS,
    )
    if (seen.length >= cap) {
      window.set(sessionId, seen)
      return false
    }
    seen.push(at)
    window.set(sessionId, seen)
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

  /**
   * Keyed by the SENDER too, not by recipient and body alone. Without the
   * sender, two different peers reporting the same short body to one parent
   * inside the window collide, and the second is told its message already
   * arrived and to wait for a reply to something the recipient never got. The
   * per-pair bucket is what bounds a single sender; two senders saying the same
   * thing to one recipient is ordinary orchestration and has to go through.
   */
  function isDuplicate(from: SessionId, to: SessionId, text: string): boolean {
    const at = now()
    for (const [key, stamp] of recentBodies) {
      if (at - stamp >= PEER_DEDUP_WINDOW_MS) recentBodies.delete(key)
    }
    // The body is a map KEY held in memory for the dedup window and nothing
    // else: it is never written anywhere, and the operational line records the
    // id and the outcome, never this (PEER-SESSIONS §10, "Content never").
    const key = `${from}|${to}|${text}`
    if (recentBodies.has(key)) return true
    recentBodies.set(key, at)
    return false
  }

  /**
   * H2 — undo the record above.
   *
   * The check records the body BEFORE the message is delivered, because two
   * identical sends racing each other have to be caught by the first one that
   * arrives. That makes every refusal below the check a lie by default: the
   * message went nowhere, and the sender retrying it inside the window was told
   * `refused:duplicate`, which says the peer already has it and to wait for a
   * reply that is never coming. So every path below the check that ends in a
   * refusal gives the body back, and only a message main is actually holding
   * leaves a record standing.
   */
  function forgetBody(from: SessionId, to: SessionId, text: string): void {
    recentBodies.delete(`${from}|${to}|${text}`)
  }

  /** The ordered-pair key: a hop routed toward `recipient` from `sender`. */
  function chainKey(recipient: SessionId, sender: SessionId): string {
    return `${recipient}|${sender}`
  }

  /**
   * §4 step 2. Two things are deliberate here and both are flagged deviations
   * from the decision text, with the derivations.
   *
   * ONE — the loop predicate. The decision says a send inherits "the chain last
   * delivered TO the requester" and that main refuses a send "whose chain
   * already contains the recipient". Taken literally those cannot both hold: a
   * chain delivered to A by B always ENDS with B, so A's reply to B is refused
   * as a loop, every reply is, and `MAX_PEER_HOPS` becomes unreachable dead code
   * while §6 owes a test in which two peers answering each other stop AT that
   * cap. So the rule is: a loop is the recipient being in the inherited chain
   * AND NOT its last entry. The last entry is by construction the peer being
   * answered, so a reply is never a loop; reaching PAST it to someone earlier is
   * what closes a cycle.
   *
   *   A→B, B→A, A→B, …   the recipient is always the chain's last entry: the
   *                      chain grows one per hop and stops at MAX_PEER_HOPS.
   *   A→B, B→C, C→A      inherited [A, B], last is B, recipient A present and
   *                      not last: hop_loop, on the hop that closes the cycle.
   *   A→B, B→C, C→B      recipient IS last: allowed. This is the report-back R2
   *                      makes the delivery model for, one rung down the R8
   *                      ladder; refusing it breaks the primary workflow.
   *   A→B, B→C, C→B, …   a two-party sub-exchange, bounded by MAX_PEER_HOPS.
   *   A→C after A↔B      first contact with a NEW peer: allowed, whatever the
   *                      A↔B exchange has spent. See THREE.
   *
   * TWO — what a send inherits, and this is where the STORE shape matters. The
   * records are per ORDERED PAIR, but a send inherits the LONGEST chain among
   * every pair that has delivered to the requester, because a chain has to
   * travel across pairs or a ring is invisible to it. Refusal records are the
   * exception: they are inherited only by their own pair.
   *
   * That combination is what it is because a single slot per recipient — the
   * first shape this had — is shared mutable state any peer can write, and two
   * separate exploits fall straight out of it:
   *
   *   - A third peer sending one message to either party of a long exchange
   *     overwrote that pair's chain with a chain of one, resetting `hop_runaway`
   *     on demand, forever. Inheriting the LONGEST chain rather than the most
   *     recent one closes it: a fresh short conversation cannot shorten a live
   *     long one.
   *   - A refusal wrote onto the recipient's slot, so `A→B, B→C, C→A` (correctly
   *     refused) then made an unrelated `A→B` refuse `hop_loop` for the whole
   *     window. A prompt-injected peer triggers that deliberately with one
   *     message it never needed delivered. Keeping refusal records pair-local
   *     closes it: they are inherited only by the pair they belong to.
   *
   * Refusal records still have to EXIST, because a refusal must advance the pair
   * or the stop leaks: without one, the two directions' chains drift by one, the
   * capped direction refuses while the other still holds a shorter chain, and
   * the exchange leaks a message every other attempt forever.
   *
   * ACCEPTED COST, stated plainly rather than left for a later reader to find: a
   * ring of three or more (A→B→C→A→…) is DETECTED and refused once per lap, not
   * killed. The refusing hop's record is pair-local, so the next lap starts from
   * a fresh chain. Killing a ring outright needs refusals to be visible across
   * pairs, which is exactly the second exploit above. A throttled ring is a
   * worse outcome than a dead one and a better outcome than an uninvolved pair
   * being silenced by a peer that only had to send one message to do it, and the
   * per-pair token bucket and dedup window still apply to every lap.
   *
   * THREE — loop detection and the runaway budget are now two quantities, and
   * this is the correction to the shape TWO describes rather than a replacement
   * for it. Both of the above still hold for LOOPS.
   *
   * One quantity was doing both jobs: the length of the inherited chain was both
   * the ring evidence and the budget. Cross-pair inheritance is required for the
   * first and is wrong for the second, and the two collided on the ladder the
   * design exists to permit. After eight legitimate A↔B round trips the pair's
   * chain is sixteen long; A's FIRST EVER message to C inherited it, the hop
   * count came to seventeen, and C was refused `hop_runaway` — the sender told
   * its back-and-forth with C had run too long when the two had exchanged
   * nothing, and told it again for as long as A↔B kept the record fresh.
   *
   * So:
   *
   *   - LOOPS keep cross-pair inheritance exactly as TWO describes it. A ring is
   *     only visible in a chain that travelled across pairs.
   *   - RUNAWAY is a count carried forward from THIS pair's own record, the last
   *     hop the recipient routed toward the sender, and compared to
   *     `MAX_PEER_HOPS`. A pair that has never spoken starts at zero however long
   *     anyone else's conversation is, which is the whole point.
   *
   * The five shapes, and what each one now does:
   *
   *   A↔B sustained         count 1, 2, 3, … refused on hop MAX_PEER_HOPS + 1,
   *                         and it STAYS refused: a refusal advances the pair.
   *   A→B, B→C, C→A         hop_loop on the closing hop (A is in the inherited
   *                         chain and is not its last entry).
   *   A→B, B→C, C→B         allowed: B IS the last entry, so it is the
   *                         report-back, and the (B, C) count is 2.
   *   B↔C sustained below A allowed and bounded: no hop is a loop, and the
   *                         (B, C) count reaches the cap on its own.
   *   A→C after A↔B saturated  allowed: the (A, C) count is zero, and the long
   *                         inherited chain contains no C.
   *
   * Nothing here reads anything the sending sidecar wrote: the chain is main's
   * own record, so a compromised sidecar cannot launder a loop by shortening
   * what it never held, nor escape a guard by omitting a field it never sends.
   */
  function inheritedChain(from: SessionId, to: SessionId): SessionId[] {
    const at = now()
    let longest: SessionId[] = []
    for (const [key, record] of [...chains.entries()]) {
      if (at - record.at > PEER_CHAIN_WINDOW_MS) {
        chains.delete(key)
        continue
      }
      const [recipient, sender] = key.split('|')
      if (recipient !== from) continue
      // A refusal is evidence about ONE pair, never about the requester's other
      // conversations. Inheriting it across pairs is the second exploit above.
      if (record.viaRefusal && sender !== to) continue
      if (record.chain.length > longest.length) longest = record.chain
    }
    return longest
  }

  /** A record only if it is still inside the chain window. */
  function freshRecord(key: string): ChainRecord | undefined {
    const record = chains.get(key)
    if (record === undefined) return undefined
    if (now() - record.at > PEER_CHAIN_WINDOW_MS) {
      chains.delete(key)
      return undefined
    }
    return record
  }

  /**
   * THREE — hops this pair has already spent, read off the ONE record that says
   * so: the last hop `to` routed toward `from`. It is the count carried by the
   * message being answered, so a back-and-forth advances it by one each turn
   * whichever way the turn goes, and a pair that has never answered anything
   * starts at zero.
   *
   * Only `to` can write that key, which is what keeps the count honest: no third
   * peer can reset it, and the sender cannot either by talking to someone else.
   * Reading the other direction as well would count a one-way stream of sends as
   * a runaway conversation, which it is not; that is the pending cap's and the
   * token bucket's job, and both still apply.
   */
  function pairHopsSoFar(from: SessionId, to: SessionId): number {
    return freshRecord(chainKey(from, to))?.pairHops ?? 0
  }

  function buildHops(
    from: SessionId,
    to: SessionId,
  ): { hops: SessionId[]; pairHops: number } | { refusal: 'hop_loop' | 'hop_runaway' } {
    if (from === to) return { refusal: 'hop_loop' }
    const inherited = inheritedChain(from, to)
    const hops = [...inherited, from]
    const pairHops = pairHopsSoFar(from, to) + 1
    const answersLastSender = inherited[inherited.length - 1] === to
    const refusal =
      inherited.includes(to) && !answersLastSender
        ? ('hop_loop' as const)
        : pairHops > MAX_PEER_HOPS
          ? ('hop_runaway' as const)
          : null
    if (refusal !== null) {
      chains.set(chainKey(to, from), { chain: hops, pairHops, viaRefusal: true, at: now() })
      return { refusal }
    }
    return { hops, pairHops }
  }

  /** Record a hop main actually delivered toward `to` from `from`. */
  function recordDelivered(
    from: SessionId,
    to: SessionId,
    hops: SessionId[],
    pairHops: number,
  ): void {
    chains.set(chainKey(to, from), { chain: hops, pairHops, viaRefusal: false, at: now() })
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

  /**
   * M2 — claim one of the recipient's pending slots for the whole wake.
   *
   * The cap used to be read once, before the restore and the ready wait, and the
   * message was held after them. Every delivery that arrived during a wake read
   * the same pre-await count, so the cap bounded nothing on the path it exists
   * to bound: eighty messages were held against a limit of fifty. Reading it
   * again just before `hold` is not the fix either, since by then the frame has
   * been handed to the recipient and refusing the sender says nothing true. So
   * the slot is CLAIMED at the check and given back on every refusal below it,
   * which makes concurrent deliveries see each other.
   */
  function reserveSlot(to: SessionId): boolean {
    const claimed = (pending.get(to)?.length ?? 0) + (reservations.get(to) ?? 0)
    if (claimed >= MAX_PENDING_PEER_MESSAGES) return false
    reservations.set(to, (reservations.get(to) ?? 0) + 1)
    return true
  }

  function releaseSlot(to: SessionId): void {
    const left = (reservations.get(to) ?? 0) - 1
    if (left > 0) reservations.set(to, left)
    else reservations.delete(to)
  }

  /**
   * M4 — one host call, bounded, so main's worst case stays under the sidecar's
   * request timeout. See `PEER_HOST_CALL_TIMEOUT_MS`. A rejection still
   * propagates: an unexpected throw is `handleRequest`'s to answer, and swallowing
   * it here would report a failure main never had.
   */
  function bounded<T>(work: Promise<T>, onTimeout: () => T): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      let settled = false
      const timer = setTimer(() => {
        if (settled) return
        settled = true
        resolve(onTimeout())
      }, hostCallTimeoutMs)
      work.then(
        value => {
          if (settled) return
          settled = true
          clearTimer(timer)
          resolve(value)
        },
        error => {
          if (settled) return
          settled = true
          clearTimer(timer)
          reject(error)
        },
      )
    })
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

  function awaitReady(sessionId: SessionId, since: number): Promise<boolean> {
    // F11 — a ready that landed while the caller was awaiting the host counts.
    // `since` is read before that call, so this can only match a ready that
    // arrived after the caller committed to waiting for one.
    const announced = lastReadyAt.get(sessionId)
    if (announced !== undefined && announced >= since) return Promise.resolve(true)
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
    // F5 — PEER-SESSIONS §2 says every LIVE session is named, and the recipient's
    // schema requires a non-empty `from`. Defaulting a missing name to '' built a
    // frame the recipient rejects at every ready forever; a broken invariant has
    // to surface as a typed answer, not as a silent permanent retry.
    const fromName = requesterRow.name
    if (fromName === undefined || fromName.length === 0) {
      return {
        ok: false,
        error: fail('internal_error', 'this session cannot address peers yet'),
      }
    }
    const readySince = now()
    // M4 — bounded, because the ready wait below runs AFTER it and the sidecar's
    // own timeout covers both. A spawn that outruns the caller's patience must
    // fail here rather than succeed into an answer nobody is left to read.
    const created = await bounded(
      deps.createSessionInWorkspace(sessionId, {
        createdBy: sessionId,
        ...(request.model !== undefined ? { model: request.model } : {}),
        ...(request.effort !== undefined ? { effort: request.effort } : {}),
        // HR4 — opt in. The rule exists for the one caller that can
        // create-park-create at machine speed; a person clicking "+" cannot, and
        // refusing them a tab because 256 rows are parked would be a regression.
        enforceRegistryChurnLimit: true,
      }),
      () => ({
        ok: false as const,
        error: { code: 'spawn_failed', message: 'the new session did not start in time' },
      }),
    )
    if (!created.ok) {
      return { ok: false, error: fail(mapHostErrorCode(created.error.code), created.error.message) }
    }
    const appSessionId = created.value.appSessionId
    // F5 again, on the other end of the create. `''` is a value the recipient's
    // own `peer.create` schema rejects, so defaulting to it turned a session
    // that WAS created into an internal error at the boundary, with nothing
    // saying which of the two things went wrong. A broken §2 invariant answers
    // for itself instead.
    const name = created.value.name
    if (name === undefined || name === null || name.length === 0) {
      return {
        ok: false,
        error: fail('internal_error', 'the new session started but cannot be addressed yet'),
      }
    }

    // §2 — await the new row's ready, then deliver the creation prompt. Both
    // failures KEEP the row: it is a real session the operator can see, and the
    // caller can send it the prompt itself.
    const ready = await awaitReady(appSessionId, readySince)
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
      attempts: 1,
    })
    recordDelivered(sessionId, appSessionId, [sessionId], 1)
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
    // F5 — see `handlePeerCreate`: a live session without a name is a broken
    // §2 invariant, and it must answer rather than mint a frame its recipient
    // will reject on every ready for the rest of the window.
    const fromName = requesterRow.name
    if (fromName === undefined || fromName.length === 0) {
      return {
        ok: false,
        error: fail('internal_error', 'this session cannot address peers yet'),
      }
    }
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
    const toName = target.name
    const messageId = newId()
    // M1 — READINESS, not existence. A row that is spawning, connecting or
    // disconnected exists, so the existence test called it live and this path
    // skipped the wake block, the restore and the ready wait, then handed the
    // frame to a socket that refused it. For a disconnected row that repeated
    // forever, because nothing on this path ever tried to wake it.
    const live = isReady(target.appSessionId)

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
    if (isDuplicate(sessionId, target.appSessionId, request.text)) {
      return refuse('refused:duplicate')
    }

    // H2/M2 — past the dedup check the body is RECORDED and, once the slot is
    // claimed, one of the recipient's fifty is spoken for. A refusal from here
    // on has to hand both back: the message reached nobody, and a sender told
    // `refused:duplicate` for a message that was never delivered is told to wait
    // for a reply to something the peer never got.
    let slotHeld = false
    const refuseAfterHolds = (outcome: PeerDeliverOutcome) => {
      forgetBody(sessionId, target.appSessionId, request.text)
      if (slotHeld) {
        releaseSlot(target.appSessionId)
        slotHeld = false
      }
      return refuse(outcome)
    }

    if (!reserveSlot(target.appSessionId)) return refuseAfterHolds('refused:queue_full')
    slotHeld = true

    const message: PeerDeliverMessage = {
      type: 'peer.deliver',
      messageId,
      from: fromName,
      fromSessionId: sessionId,
      text: request.text,
    }

    if (!live) {
      // §4 step 5 — main's OWN deliver-after-ready. `already restoring` and
      // `already live` both currently answer `session_not_found`, and neither is
      // a missing row: treat them as pending and wait for the row's next ready.
      const readySince = now()
      // M4 — bounded: this runs BEFORE the ready wait, and the two together are
      // what the sidecar's request timeout has to cover.
      const restored = await bounded(deps.restoreSession(target.appSessionId), () => ({
        ok: false as const,
        error: { code: 'wake_timeout', message: 'the peer did not wake in time' },
      }))
      if (!restored.ok && restored.error.code !== 'session_not_found') {
        return refuseAfterHolds('refused:wake_failed')
      }
      // Never `session_not_found` from here on: HR3 reserves that code for a row
      // the caller may not name, and this one it may.
      if (!(await awaitReady(target.appSessionId, readySince))) {
        return refuseAfterHolds('refused:wake_failed')
      }
    }

    // F7 — a live recipient was never woken, so `wake_failed` would tell the
    // sending model its peer is unreachable while the peer is sitting there
    // running. The two failures are different facts and get different reasons.
    if (!forwarded(target.appSessionId, message)) {
      return refuseAfterHolds(live ? 'refused:delivery_failed' : 'refused:wake_failed')
    }

    const outcome: PeerDeliverOutcome = live ? 'queued_live' : 'queued_wake'
    releaseSlot(target.appSessionId)
    slotHeld = false
    hold({
      messageId,
      toAppSessionId: target.appSessionId,
      message,
      fromName,
      toName,
      kind: 'request',
      outcome,
      attempts: 1,
    })
    recordDelivered(sessionId, target.appSessionId, chain.hops, chain.pairHops)
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
      // The SENDER, not this acking recipient. See `logRouted`: attribution that
      // changes with the outcome cannot answer the question the line is for.
      deps.logRouted(entry.message.fromSessionId, {
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
    // HR1 / A6 — the flood bound FIRST, before the frame is parsed, serialized
    // or measured. Charging only what survives validation bounded nothing that
    // mattered: an invalid or unknown-verb request answered and returned without
    // touching any budget, and each one still cost a `JSON.stringify` on a
    // payload the channel bounds only at 32 MiB. The cheapest flood to send was
    // the one nothing counted.
    //
    // The requestId is read directly rather than through the validator, because
    // answering has to work for a frame that will not validate; it is only ever
    // echoed back, and it authorizes nothing.
    const echoId = readRequestId(frame)
    if (!charge(frameWindow, sessionId, MAX_HOST_REQUEST_FRAMES_PER_WINDOW)) {
      log(`[peer-plane] flood-refused host.request from ${sessionId}`)
      if (echoId !== null) {
        answer(sessionId, echoId, {
          ok: false,
          error: fail('rate_limited', 'too many requests; try again shortly'),
        })
      }
      return
    }

    // HR1 — main's OWN size bound, on the serialized request, at the consumer.
    let serialized: string | undefined
    try {
      serialized = JSON.stringify(frame)
    } catch {
      serialized = undefined
    }
    if (serialized === undefined || utf8Bytes(serialized) > MAX_HOST_REQUEST_BYTES) {
      log(`[peer-plane] refused oversize host.request from ${sessionId}`)
      if (echoId !== null) {
        answer(sessionId, echoId, {
          ok: false,
          error: fail('too_large', 'request is too large'),
        })
      }
      return
    }

    const validated = validateHostRequest(frame)
    if (!validated.ok) {
      log(`[peer-plane] rejected host.request from ${sessionId}: ${validated.error.message}`)
      if (validated.requestId !== null) {
        answer(sessionId, validated.requestId, { ok: false, error: validated.error })
      }
      return
    }

    // F4 — the model's own allowance, charged for model-facing verbs only. An
    // ack is work main asked the recipient to do; billing it to the recipient
    // lets senders exhaust a session's budget on its behalf.
    if (
      validated.request.verb !== 'peer.ack' &&
      !charge(verbWindow, sessionId, MAX_HOST_REQUESTS_PER_WINDOW)
    ) {
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
    // F11 — remembered so a waiter that registers moments later resolves at once
    // instead of sitting out the wake timeout for a session that is already up.
    lastReadyAt.set(sessionId, now())
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
      // F5 — bounded. The redelivery exists for a recipient that DIED before
      // acking; a recipient that REJECTS the frame acks nothing either, and
      // without a counter it is re-sent on every ready for the life of the
      // window while holding one of the fifty pending slots. Give up loudly
      // after a few tries rather than retrying something already refused.
      if (entry.attempts >= MAX_PEER_DELIVERY_ATTEMPTS) {
        release(sessionId, entry.messageId)
        // The sender's id, same as every other line about this message.
        deps.logRouted(entry.message.fromSessionId, {
          from: entry.fromName,
          to: entry.toName,
          kind: entry.kind,
          messageId: entry.messageId,
          outcome: 'refused:delivery_failed',
        })
        log(
          `[peer-plane] gave up redelivering a peer message to ${sessionId} after ${entry.attempts} attempts`,
        )
        continue
      }
      // Count a hand-off that HAPPENED. The counter exists to stop re-sending a
      // frame the recipient rejects, and a send the supervisor never took is not
      // that: charging it spent the allowance on failures the recipient never
      // saw, so two transient ones plus one real rejection dropped the message.
      if (!forwarded(sessionId, entry.message)) continue
      entry.attempts += 1
    }
  }

  return {
    handleRequest,
    recordActivity: (sessionId, next) => {
      presence.set(sessionId, next)
    },
    recordRunControls: (sessionId, controls) => {
      runControls.set(sessionId, controls)
    },
    onReady,
    onSessionDown: sessionId => {
      presence.delete(sessionId)
    },
    onSessionRemoved: sessionId => {
      presence.delete(sessionId)
      runControls.delete(sessionId)
      pending.delete(sessionId)
      reservations.delete(sessionId)
      verbWindow.delete(sessionId)
      frameWindow.delete(sessionId)
      // The module header says every store is cleared on reap, and this one was
      // not: a reaped row's ready timestamp outlived it, so a later row reusing
      // the id would have resolved a wake it never announced.
      lastReadyAt.delete(sessionId)

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
        const [from, to] = key.split('|')
        if (from === sessionId || to === sessionId) recentBodies.delete(key)
      }
      // Every chain the reaped row is either end of. The key carries both, so
      // a reused NAME can never inherit the previous row's chain.
      for (const key of [...chains.keys()]) {
        const [recipient, sender] = key.split('|')
        if (recipient === sessionId || sender === sessionId) chains.delete(key)
      }
    },
    pendingFor: sessionId => (pending.get(sessionId) ?? []).map(entry => entry.messageId),
    presenceOf: sessionId => presence.get(sessionId),
  }
}
