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
 * The one cast in this file, and it is the point rather than a shortcut. The
 * result value is schema-checked per verb at the trust boundary now, so no fake
 * obeying that schema could produce the malformed value the tool's own local
 * narrowing exists to absorb. This helper manufactures it.
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
  const answer = JSON.parse(String(block.content)) as {
    asOf: string
    peers: unknown
  }
  expect(answer.peers).toEqual([
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

test('the roster is stamped with the instant it was read', async () => {
  // The model has no clock: the engine injects a calendar date and no time of
  // day, so an ISO `lastActivity` on its own cannot answer "how long has this
  // peer been quiet". Both ends have to be in the result, and both absolute:
  // a rendered duration would be a lie on the next turn, since the result
  // stays in context long after the turn that fetched it.
  const before = Date.now()
  const { requestHost } = requesterReturning(() => ({ peers: [liveRow] }))
  const tool = createListPeersTool(requestHost)

  const result = await tool.call()
  const block = tool.mapToolResultToToolResultBlockParam(result.data, 'tu-5')

  if (!result.data.ok) throw new Error('expected a roster')
  const asOf = Date.parse(result.data.asOf)
  expect(Number.isNaN(asOf)).toBe(false)
  expect(asOf).toBeGreaterThanOrEqual(before)
  expect(asOf).toBeLessThanOrEqual(Date.now())
  expect(String(block.content)).toContain(result.data.asOf)
})

test('a live peer that has not reported in yet lists as live with no presence', async () => {
  // Reachable, and reachable exactly where a caller looks first: a session
  // that spawned but has not sent its first activity frame has a non-terminal
  // supervisor record, so main answers `live` while the presence map is still
  // empty for it (`app/main/peerRequestPlane.ts:546`). It is the state
  // CreatePeer sends the model here to check after "it did not finish
  // starting". The row must still list, and must not gain an invented
  // presence.
  const { requestHost } = requesterReturning(() => ({
    peers: [{ ...liveRow, presence: undefined }],
  }))
  const tool = createListPeersTool(requestHost)

  const result = await tool.call()

  if (!result.data.ok) throw new Error('expected a roster')
  expect(result.data.peers).toHaveLength(1)
  expect(result.data.peers[0]?.status).toBe('live')
  expect(result.data.peers[0]).not.toHaveProperty('presence')
})

test('ListPeers reports a refusal instead of an empty roster', async () => {
  // The failure mode this guards is a model concluding "nobody else is here"
  // from a request that was refused. An empty list and a refusal must not
  // render the same.
  //
  // Asserted as properties, not as a sentence. The refusal text belongs to
  // `describeHostRequestError`, so pinning its exact wording here made this
  // file fail for an edit in another one, which is not a fact about ListPeers.
  // What must hold is that the refusal is flagged, says something, is not the
  // empty-roster answer, and does not reach the model as the raw error code.
  const { requestHost } = requesterReturning(() => ({ ok: false }))
  const tool = createListPeersTool(requestHost)

  const result = await tool.call()
  const block = tool.mapToolResultToToolResultBlockParam(result.data, 'tu-2')

  expect(block.is_error).toBe(true)
  expect(result.data.ok).toBe(false)
  const content = String(block.content)
  expect(content.trim().length).toBeGreaterThan(0)
  expect(content).not.toBe(
    'This workspace has no other session, live, parked or closed.',
  )
  expect(content).not.toContain('rate_limited')
})

test('an empty roster says no session exists, not that none is open', async () => {
  // A closed session still lists, so "no session is open" would be read as an
  // empty workspace by a model that had just been told closed rows appear. The
  // empty case has to deny the whole set, not the live part of it.
  const { requestHost } = requesterReturning(() => ({ peers: [] }))
  const tool = createListPeersTool(requestHost)

  const result = await tool.call()
  const block = tool.mapToolResultToToolResultBlockParam(result.data, 'tu-3')

  expect(block.is_error).toBeUndefined()
  expect(block.content).toBe(
    'This workspace has no other session, live, parked or closed.',
  )
})

test('a malformed row is dropped and the rest of the roster still lists', async () => {
  // Display degrades gracefully: whatever reaches the narrowing, one bad row
  // must cost that row and not the whole answer.
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
