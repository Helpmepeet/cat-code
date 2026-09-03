import { expect, test } from 'bun:test'
import type {
  HostRequestArgs,
  HostRequestVerb,
} from '../shared/protocol.js'
import type { HostRequestOutcome } from './sidecarServer.js'
import type { PeerHostRequester } from './peerHostRequester.js'
import {
  createListPeersTool,
  narrowPeerList,
  narrowPeerView,
} from './listPeersTool.js'

/**
 * The one cast in this file, and it is the point rather than a shortcut: the
 * result envelope is validated at the socket for its correlation id, ok flag and
 * error shape, but `value` crosses as unknown and the per-verb type only
 * DESCRIBES it. So a test that could not put a malformed value into that slot
 * could not exercise the narrowing the tool does. This helper is the socket's
 * own honesty gap, made available to a test.
 */
function hostAnswers<V extends HostRequestVerb>(
  value: unknown,
): HostRequestOutcome<V> {
  return { ok: true, value } as HostRequestOutcome<V>
}

type Asked = { verb: HostRequestVerb; args: unknown }

function requesterReturning(
  outcome: (verb: HostRequestVerb) => unknown,
): { requestHost: PeerHostRequester; asked: Asked[] } {
  const asked: Asked[] = []
  const requestHost: PeerHostRequester = <V extends HostRequestVerb>(
    verb: V,
    args: HostRequestArgs[V],
  ): Promise<HostRequestOutcome<V>> => {
    asked.push({ verb, args })
    const answer = outcome(verb)
    if (
      typeof answer === 'object' &&
      answer !== null &&
      'ok' in answer &&
      answer.ok === false
    ) {
      return Promise.resolve({
        ok: false,
        error: { code: 'rate_limited', message: 'slow down' },
      })
    }
    return Promise.resolve(hostAnswers<V>(answer))
  }
  return { requestHost, asked }
}

const liveRow = {
  name: 'Bear',
  appSessionId: 'a1',
  engineSessionId: 'e1',
  status: 'live',
  presence: 'needs_user',
  createdBy: { appSessionId: 'a0', name: 'Alex' },
  title: 'Fix the parser',
  lastActivity: 1_756_900_000_000,
}

const closedRow = {
  name: 'Onyx',
  appSessionId: 'a2',
  engineSessionId: null,
  status: 'closed',
  createdBy: { appSessionId: 'a9', name: null },
  title: null,
  lastActivity: 1_756_800_000_000,
}

test('ListPeers renders the host roster, and shows no presence for a row that is not live', async () => {
  // PEER-SESSIONS §3: presence is ABSENT for a row that is not live, and the
  // decision is explicit that absence is rendered as absence. A default filled
  // in here would tell a creator that a closed session is idle, which is the
  // one thing it must not say.
  const { requestHost, asked } = requesterReturning(() => ({
    peers: [liveRow, closedRow],
  }))
  const tool = createListPeersTool(requestHost)

  const result = await tool.call()
  const block = tool.mapToolResultToToolResultBlockParam(result.data, 'tu-1')

  expect(asked).toEqual([{ verb: 'peers.list', args: {} }])
  expect(block.is_error).toBeUndefined()
  const rows: unknown = JSON.parse(String(block.content))
  expect(rows).toEqual([
    {
      name: 'Bear',
      status: 'live',
      presence: 'needs_user',
      createdBy: 'Alex',
      title: 'Fix the parser',
      lastActivity: new Date(1_756_900_000_000).toISOString(),
    },
    {
      name: 'Onyx',
      status: 'closed',
      // A reaped creator resolves to `gone` (PEER-SESSIONS §2), never to a
      // fabricated name and never to the id.
      createdBy: 'gone',
      title: null,
      lastActivity: new Date(1_756_800_000_000).toISOString(),
    },
  ])
  // Addresses are not information to a model that acts by name.
  expect(String(block.content)).not.toContain('a1')
  expect(String(block.content)).not.toContain('e1')
})

test('ListPeers reports a refusal instead of an empty roster', async () => {
  // The failure mode this guards is a model concluding "nobody else is here"
  // from a request that was refused. An empty list and a refusal must not
  // render the same.
  const { requestHost } = requesterReturning(() => ({ ok: false }))
  const tool = createListPeersTool(requestHost)

  const result = await tool.call()
  const block = tool.mapToolResultToToolResultBlockParam(result.data, 'tu-2')

  expect(block.is_error).toBe(true)
  expect(String(block.content)).toContain('Too many requests')
})

test('ListPeers says plainly when no other session is open', async () => {
  const { requestHost } = requesterReturning(() => ({ peers: [] }))
  const tool = createListPeersTool(requestHost)

  const result = await tool.call()
  const block = tool.mapToolResultToToolResultBlockParam(result.data, 'tu-3')

  expect(block.is_error).toBeUndefined()
  expect(block.content).toBe('No other session is open on this workspace.')
})

test('a malformed row is dropped and the rest of the roster still lists', async () => {
  // Display degrades gracefully: `value` is unvalidated at the boundary, so one
  // bad row must cost that row and not the answer.
  const { requestHost } = requesterReturning(() => ({
    peers: [liveRow, { name: 'Nameless' }, { status: 'live' }, closedRow],
  }))
  const tool = createListPeersTool(requestHost)

  const result = await tool.call()

  expect(result.data.ok).toBe(true)
  if (!result.data.ok) throw new Error('expected a roster')
  expect(result.data.peers.map(peer => peer.name)).toEqual(['Bear', 'Onyx'])
})

test('a value that is not a peer list is not read as an empty roster', async () => {
  const { requestHost } = requesterReturning(() => ({ notPeers: true }))
  const tool = createListPeersTool(requestHost)

  const result = await tool.call()
  const block = tool.mapToolResultToToolResultBlockParam(result.data, 'tu-4')

  expect(block.is_error).toBe(true)
  expect(String(block.content)).toContain('unreadable')
})

test('narrowing rejects the fields it cannot trust', () => {
  expect(narrowPeerView({ ...liveRow, status: 'sleeping' })).toBeNull()
  expect(narrowPeerView({ ...liveRow, name: '' })).toBeNull()
  expect(narrowPeerView({ ...liveRow, lastActivity: 'yesterday' })).toBeNull()
  // An unknown presence is dropped, not passed through: the enum is closed and
  // a value main did not mint must not reach the model as a state.
  expect(narrowPeerView({ ...liveRow, presence: 'thinking' })?.presence).toBe(
    undefined,
  )
  expect(narrowPeerList(null)).toBeNull()
  expect(narrowPeerList({ peers: 'Bear' })).toBeNull()
})

test('ListPeers projects nothing to the auto-mode classifier, deliberately', () => {
  // PEER-SESSIONS §4: read-only tools project `''` on purpose. The classifier
  // reads `''` as "no security relevance" and skips the tool, which is right
  // here and wrong for CreatePeer. This asserts the choice was made rather than
  // inherited from the default.
  const tool = createListPeersTool(requesterReturning(() => ({ peers: [] })).requestHost)
  expect(tool.toAutoClassifierInput()).toBe('')
  expect(tool.isReadOnly()).toBe(true)
})
