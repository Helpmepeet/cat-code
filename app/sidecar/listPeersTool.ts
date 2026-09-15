/**
 * `ListPeers` — PEER-SESSIONS §3/§4, the roster tool.
 *
 * Desktop only: it is appended to the engine's tool list inside the sidecar
 * (`sessionController.ts`), so the terminal never sees it. The membership rule,
 * the workspace scoping and the ordering (live, then parked, then closed, then
 * by last activity) all belong to main; this tool asks for the answer and
 * renders it for a model to read.
 *
 * Built through the engine's own `buildTool` (`src/Tool.ts:793`) so it carries
 * the same defaults every other tool does, rather than a second tool shape
 * inside `app/` (CLAUDE.md §8 rules 1 and 10).
 */

// Zod is imported by PATH, not by package name, and it has to be.
//
// `app/node_modules/zod` (4.4.3) shadows the repository's own `zod` (4.3.6) for
// every module under `app/`, so a bare `zod/v4` here resolves to a DIFFERENT
// copy from the one `src/Tool.ts` sees. TypeScript dedupes node_modules copies
// by package id, which carries the exact version STRING, so two different
// strings are two type identities and comparing zod's recursive conditional
// types across them exhausts the heap: `tsc` dies at ~4GB without printing a
// diagnostic. Byte-identical copies fail the same way once the version strings
// differ, and matching strings are fine, so this is version skew and not a 4.3
// versus 4.4 incompatibility. Naming the path pins this file to the engine's
// realpath, and it is that shared realpath, not a matching version, that keeps
// the two planes on one identity. The durable fix is deduplicating the
// dependency; that is a package change, not this file's to make.
import { z } from '../../node_modules/zod/v4'
import { buildTool, type ToolDef } from '../../src/Tool.js'
import { lazySchema } from '../../src/utils/lazySchema.js'
import { jsonStringify } from '../../src/utils/slowOperations.js'
import type { PeerDescriptor } from '../shared/protocol.js'
import {
  describeHostRequestError,
  requestPeerHost,
  type PeerHostRequester,
} from './peerHostRequester.js'

export const LIST_PEERS_TOOL_NAME = 'ListPeers'

const inputSchema = lazySchema(() =>
  z.strictObject({
    all: z
      .boolean()
      .optional()
      .describe(
        'List every peer, including ones that closed a while ago.',
      ),
  }),
)

type InputSchema = ReturnType<typeof inputSchema>
type Input = z.infer<InputSchema>

/**
 * How many CLOSED peers an ordinary call carries.
 *
 * The live and parked parts of a roster are bounded by things outside this
 * file: a live row costs a process (`MAX_LIVE_SESSIONS`) and the idle-park
 * driver holds the number far below that, and a parked row is a tab somebody
 * has open. The closed tail has no such bound. Names are write-once and a row
 * survives until the registry reaps at `MAX_REGISTRY_SESSIONS`, so on a
 * workspace that has been worked in for a while it is the whole cost of the
 * answer: measured against a real 53-row workspace, 52 rows of roster spent
 * about 1,500 tokens to say that nothing was open.
 *
 * Five keeps the ordinary answer the same order of size as the part that is
 * bounded anyway, and keeps the peers a caller might still be picking up from.
 * Older ones are not gone: the result says how many were left out and `all`
 * returns them, which is what keeps a bounded default from reading as a peer
 * that no longer exists.
 */
const CLOSED_PEERS_SHOWN = 5

/**
 * The model-facing view of one row, and the ONLY shape this tool passes on.
 *
 * Ids are deliberately dropped: a peer is addressed by NAME everywhere a model
 * can act, so an address in the result is tokens without a use. `presence` is
 * ABSENT for a row that is not live and stays absent here rather than being
 * filled with a value nobody measured (PEER-SESSIONS §3).
 */
export type PeerView = {
  name: string
  status: PeerDescriptor['status']
  presence?: PeerDescriptor['presence']
  /**
   * What the session runs on, when main has heard it say. Both are ABSENT for a
   * closed row and for one that has not announced yet — the `presence` rule
   * again — so a reader that needs the model of a peer it is about to address
   * finds it on exactly the rows it can address.
   */
  model?: string
  effort?: string
  createdBy?: string
  title: string | null
  lastActivity: string
}

/**
 * What the tool hands back to the app, after the narrowing below.
 *
 * `asOf` is the instant the roster was read, and it is here because the model
 * has no clock: the engine injects a calendar date and no time of day
 * (`src/context.ts:233`), so `lastActivity` alone cannot answer "how long has
 * this peer been quiet". Both ends are absolute instants on purpose. A rendered
 * duration would be correct once and then decay, because a tool result stays in
 * context for many turns after the turn that fetched it.
 *
 * `notListed` is how many closed rows the bound above cut, and it is a COUNT
 * rather than the sentence a model reads: the sentence is written once at
 * render time, so the number and its plural cannot drift apart. Zero on a call
 * that cut nothing, which is every call in a workspace small enough for the
 * question not to arise.
 */
export type ListPeersOutput =
  | { ok: true; asOf: string; peers: PeerView[]; notListed: number }
  | { ok: false; message: string }

const PEER_STATUSES: readonly PeerDescriptor['status'][] = [
  'live',
  'parked',
  'closed',
]
const PRESENCES: readonly NonNullable<PeerDescriptor['presence']>[] = [
  'running',
  'needs_user',
  'idle',
]

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * The longest a model id or an effort level may be here.
 *
 * The boundary already bounds both at the plane's general text limit, which is
 * a size cap rather than a statement about these two fields. This is the
 * statement: the longest id the engine offers is around thirty characters, so a
 * value many times that is not a model id however it got here, and the row is
 * better off without it than with a paragraph rendered where a name goes.
 */
const MAX_RUN_VALUE_CHARS = 128

function readShortText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  if (value === '' || value.length > MAX_RUN_VALUE_CHARS) return undefined
  return value
}

/**
 * Turn one entry of a `peers.list` answer into a row, or drop it.
 *
 * `host.result.value` IS now schema-checked per verb at the trust boundary, so
 * this is a SECOND, local check rather than the only one. It stays deliberately.
 * Two of the fields read here are closed vocabularies rendered straight to a
 * model as another session's state, and a lookup at the point of use costs a map
 * scan and does not depend on another module keeping its enums in step with the
 * ones below. A row that fails is dropped rather than rendered half-formed:
 * display degrades gracefully (CLAUDE.md §7), and one malformed row must not
 * cost the model the whole roster.
 */
export function narrowPeerView(value: unknown): PeerView | null {
  if (!isRecord(value)) return null
  const { name, status, presence, model, effort, createdBy, title, lastActivity } =
    value
  if (typeof name !== 'string' || name === '') return null
  const knownStatus = PEER_STATUSES.find(candidate => candidate === status)
  if (knownStatus === undefined) return null
  if (typeof lastActivity !== 'number' || !Number.isFinite(lastActivity)) {
    return null
  }
  const knownPresence = PRESENCES.find(candidate => candidate === presence)
  // Free-form on purpose, and length-checked rather than matched: a model id is
  // whatever the engine was handed, including one that ships tomorrow and one
  // the creator mistyped. An unusable value costs the row its model, never the
  // roster its row.
  const runsOn = readShortText(model)
  const runsAt = readShortText(effort)
  // A reaped creator keeps its id but loses its name, and `gone` is what
  // PEER-SESSIONS §2 says to show for it. An unreadable creator block is
  // treated the same way: the row still lists.
  let creator: string | undefined
  if (isRecord(createdBy)) {
    creator = typeof createdBy.name === 'string' ? createdBy.name : 'gone'
  }
  return {
    name,
    status: knownStatus,
    ...(knownPresence !== undefined ? { presence: knownPresence } : {}),
    ...(runsOn !== undefined ? { model: runsOn } : {}),
    ...(runsAt !== undefined ? { effort: runsAt } : {}),
    ...(creator !== undefined ? { createdBy: creator } : {}),
    title: typeof title === 'string' ? title : null,
    lastActivity: new Date(lastActivity).toISOString(),
  }
}

/** Narrow a whole `peers.list` value. A value that is not a peer list is null. */
export function narrowPeerList(value: unknown): PeerView[] | null {
  if (!isRecord(value) || !Array.isArray(value.peers)) return null
  const rows: PeerView[] = []
  for (const entry of value.peers) {
    const row = narrowPeerView(entry)
    if (row !== null) rows.push(row)
  }
  return rows
}

/**
 * Keep every live and parked row, and only the first `limit` closed ones.
 *
 * Iterating in the order main sent rather than filtering by status and
 * re-joining is what keeps the ordering main owns (`peerRequestPlane.ts:948`,
 * status then recency inside each group) intact here: this drops rows, it never
 * decides where one sits. That the closed rows kept are the most recent ones is
 * a consequence of main's sort, not a second sort agreeing with it.
 */
export function boundClosedPeers(
  peers: PeerView[],
  limit: number = CLOSED_PEERS_SHOWN,
): { peers: PeerView[]; notListed: number } {
  const kept: PeerView[] = []
  let shownClosed = 0
  let notListed = 0
  for (const peer of peers) {
    if (peer.status !== 'closed') {
      kept.push(peer)
      continue
    }
    if (shownClosed < limit) {
      shownClosed += 1
      kept.push(peer)
      continue
    }
    notListed += 1
  }
  return { peers: kept, notListed }
}

export function createListPeersTool(
  requestHost: PeerHostRequester = requestPeerHost,
) {
  return buildTool({
    name: LIST_PEERS_TOOL_NAME,
    searchHint: 'list the peer sessions in this workspace',
    maxResultSizeChars: 100_000,
    userFacingName: () => LIST_PEERS_TOOL_NAME,
    get inputSchema(): InputSchema {
      return inputSchema()
    },
    isReadOnly() {
      return true
    },
    isConcurrencySafe() {
      return true
    },
    // Read-only, and its one argument only widens what it reads, so there is
    // nothing for the auto-mode classifier to weigh. `''` is the documented
    // "no security relevance" value and is chosen here deliberately, not
    // inherited by omission (PEER-SESSIONS §4; the contract is at
    // `src/Tool.ts:764`).
    toAutoClassifierInput() {
      return ''
    },
    async description() {
      return 'List the peers in this workspace, live, parked or closed'
    },
    async prompt() {
      return [
        // The ordering is main's (`app/main/peerRequestPlane.ts:937`) and is a
        // status sort with a recency tiebreak inside each group, NOT a recency
        // sort. Stating it as "newest first" made the first row read as the
        // most recently active session, which it is not: a parked peer that
        // finished a minute ago sits below live ones idle since morning.
        'List the peers in this workspace. Live peers come first, then parked, then closed, and inside each of those groups the most recently active comes first.',
        '',
        'Each entry carries the name, whether that peer is live, parked or closed, its title, when it was last active, and who created it. The list is stamped with the time it was taken, so subtract to see how long ago that was. A live peer also carries what it is doing right now: running a turn, waiting for the user to answer a permission question, or idle. A live peer with no such value has not reported in yet and is still starting up, which is what a peer you just created looks like when the create said it did not finish starting. A peer that is not live never carries one.',
        '',
        // The model is reported because a create can SET one and nothing could
        // read it back, so a caller could neither route by model nor see that
        // the id it passed was a typo the session will die on. It says what the
        // session reported running, which is not always what its create asked
        // for: an effort level the session did not recognise was dropped in
        // favour of the user's own setting.
        'A peer that is live or parked also carries the model it is running and its reasoning effort, as that peer last reported them. Use them to send work to a peer already on the model you want it done by, and to check that a peer you created on a particular model really came up on it.',
        '',
        // Presence exists so a creator can tell busy from stuck (§0a), and
        // nothing said what its states do NOT establish. The `ReadPeer` prompt
        // was routing "is it done" here, which this tool cannot answer: it
        // reports activity, and a peer can go idle having failed.
        "Use it to find out who else is working here before you message one of them, and to check whether a peer you are waiting on is still working or has gone quiet. It reads nothing from disk and disturbs nobody. What it shows is activity, never outcome: idle, parked or closed says a peer is not running, not that its task succeeded, and running says nothing about how far it is. Whether work is done comes from the peer's own report or from the work itself. If you asked a peer to hear back and it has gone idle without answering, one message asking is reasonable. If it is waiting for the user to answer a permission question, it cannot read or answer you until the user does; the user has its tab and sees that prompt, so tell them only when the wait holds up something you owe them.",
      ].join('\n')
    },
    async call(input: Input): Promise<{ data: ListPeersOutput }> {
      const outcome = await requestHost('peers.list', {})
      if (!outcome.ok) {
        return {
          data: { ok: false, message: describeHostRequestError(outcome.error) },
        }
      }
      // Read back through `unknown` and narrowed again here rather than
      // trusted: see `narrowPeerView` for why the local check stays. An answer
      // that does not narrow is reported as unreadable, never as an empty
      // roster.
      const value: unknown = outcome.value
      const peers = narrowPeerList(value)
      if (peers === null) {
        return {
          data: {
            ok: false,
            message: 'The list of peers came back unreadable.',
          },
        }
      }
      const bounded =
        input.all === true
          ? { peers, notListed: 0 }
          : boundClosedPeers(peers)
      return {
        data: {
          ok: true,
          asOf: new Date().toISOString(),
          peers: bounded.peers,
          notListed: bounded.notListed,
        },
      }
    },
    mapToolResultToToolResultBlockParam(data: ListPeersOutput, toolUseID) {
      if (!data.ok) {
        return {
          tool_use_id: toolUseID,
          type: 'tool_result',
          content: data.message,
          is_error: true,
        }
      }
      if (data.peers.length === 0) {
        return {
          tool_use_id: toolUseID,
          type: 'tool_result',
          // Empty means no other row at all, not "none currently open": a
          // closed session still lists, so "no session is open" would read as
          // an empty workspace when the answer is that there has never been
          // another session here.
          content: 'This workspace has no other peer, live, parked or closed.',
        }
      }
      // The note is written only when rows were actually cut. A line saying
      // nothing was left out would be paid for on every call in every
      // workspace, to report the ordinary case, which is the cost this bound
      // exists to remove (CLAUDE.md §7: say only what is surprising).
      const note =
        data.notListed > 0
          ? {
              note:
                data.notListed === 1
                  ? '1 peer that closed earlier is not listed. Set all to true to see it.'
                  : `${data.notListed} peers that closed earlier are not listed. Set all to true to see them.`,
            }
          : {}
      return {
        tool_use_id: toolUseID,
        type: 'tool_result',
        content: jsonStringify({ asOf: data.asOf, peers: data.peers, ...note }),
      }
    },
    renderToolUseMessage() {
      return null
    },
  } satisfies ToolDef<InputSchema, ListPeersOutput>)
}
