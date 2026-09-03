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
// copy from the one `src/Tool.ts` sees. The two copies are structurally
// incompatible to the type checker (their `$ZodCheck` and `ParsePayload` types
// come from different files), so a schema built with the app copy does not
// satisfy the engine's `AnyObject` constraint and the whole tool stops being a
// `Tool` at all. Naming the path pins this file to the engine's copy, which also
// means one zod instance rather than two inside the engine's own tool pipeline.
// The durable fix is deduplicating the dependency; that is a package change, not
// this file's to make.
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

const inputSchema = lazySchema(() => z.strictObject({}))

type InputSchema = ReturnType<typeof inputSchema>

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
  createdBy?: string
  title: string | null
  lastActivity: string
}

/** What the tool hands back to the app, after the narrowing below. */
export type ListPeersOutput =
  | { ok: true; peers: PeerView[] }
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
 * Turn one entry of a `peers.list` answer into a row, or drop it.
 *
 * This is a real narrowing, not a formality: the result envelope is validated at
 * the socket boundary for its correlation id, its ok flag and its error shape,
 * but `value` itself arrives as unknown and is only DESCRIBED by the per-verb
 * type. So every field is checked here before it is read, and a row that fails
 * is dropped rather than rendered half-formed. Display degrades gracefully
 * (CLAUDE.md §7): one malformed row must not cost the model the whole roster.
 */
export function narrowPeerView(value: unknown): PeerView | null {
  if (!isRecord(value)) return null
  const { name, status, presence, createdBy, title, lastActivity } = value
  if (typeof name !== 'string' || name === '') return null
  const knownStatus = PEER_STATUSES.find(candidate => candidate === status)
  if (knownStatus === undefined) return null
  if (typeof lastActivity !== 'number' || !Number.isFinite(lastActivity)) {
    return null
  }
  const knownPresence = PRESENCES.find(candidate => candidate === presence)
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

export function createListPeersTool(
  requestHost: PeerHostRequester = requestPeerHost,
) {
  return buildTool({
    name: LIST_PEERS_TOOL_NAME,
    searchHint: 'list the other sessions in this workspace',
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
    // Read-only and takes no input, so there is nothing for the auto-mode
    // classifier to weigh. `''` is the documented "no security relevance"
    // value and is chosen here deliberately, not inherited by omission
    // (PEER-SESSIONS §4; the contract is at `src/Tool.ts:764`).
    toAutoClassifierInput() {
      return ''
    },
    async description() {
      return 'List the other sessions open on this workspace'
    },
    async prompt() {
      return [
        'List the other sessions working in this workspace, newest activity first.',
        '',
        'Each entry carries the session name, whether it is live, parked or closed, its title, when it was last active, and who created it. A live session also carries what it is doing right now: running a turn, waiting for the user to answer a permission question, or idle. A session that is not live has no such value, and none is shown.',
        '',
        'Use it to find out who else is working here before you message one of them, and to check whether a session you are waiting on is still working or has gone quiet. It reads nothing from disk and disturbs nobody.',
      ].join('\n')
    },
    async call(): Promise<{ data: ListPeersOutput }> {
      const outcome = await requestHost('peers.list', {})
      if (!outcome.ok) {
        return {
          data: { ok: false, message: describeHostRequestError(outcome.error) },
        }
      }
      // `value` is typed per verb but validated only as unknown at the socket,
      // so it is read back through `unknown` and narrowed rather than trusted.
      const value: unknown = outcome.value
      const peers = narrowPeerList(value)
      if (peers === null) {
        return {
          data: {
            ok: false,
            message: 'The list of sessions came back unreadable.',
          },
        }
      }
      return { data: { ok: true, peers } }
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
          content: 'No other session is open on this workspace.',
        }
      }
      return {
        tool_use_id: toolUseID,
        type: 'tool_result',
        content: jsonStringify(data.peers),
      }
    },
    renderToolUseMessage() {
      return null
    },
  } satisfies ToolDef<InputSchema, ListPeersOutput>)
}
