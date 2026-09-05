import { expect, test } from 'bun:test'
import type {
  HostRequestArgs,
  HostRequestVerb,
} from '../shared/protocol.js'
import type { HostRequestOutcome } from './sidecarServer.js'
import type { PeerHostRequester } from './peerHostRequester.js'
import {
  boundClosedPeers,
  createListPeersTool,
  narrowPeerList,
  narrowPeerView,
  type PeerView,
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

  const result = await tool.call({})
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

  const result = await tool.call({})
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

  const result = await tool.call({})

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

  const result = await tool.call({})
  const block = tool.mapToolResultToToolResultBlockParam(result.data, 'tu-2')

  expect(block.is_error).toBe(true)
  expect(result.data.ok).toBe(false)
  const content = String(block.content)
  expect(content.trim().length).toBeGreaterThan(0)
  expect(content).not.toBe(
    'This workspace has no other peer, live, parked or closed.',
  )
  expect(content).not.toContain('rate_limited')
})

test('an empty roster says no peer exists, not that none is open', async () => {
  // A closed session still lists, so "no session is open" would be read as an
  // empty workspace by a model that had just been told closed rows appear. The
  // empty case has to deny the whole set, not the live part of it.
  const { requestHost } = requesterReturning(() => ({ peers: [] }))
  const tool = createListPeersTool(requestHost)

  const result = await tool.call({})
  const block = tool.mapToolResultToToolResultBlockParam(result.data, 'tu-3')

  expect(block.is_error).toBeUndefined()
  expect(block.content).toBe(
    'This workspace has no other peer, live, parked or closed.',
  )
})

test('the guidance says presence is activity and never an outcome', async () => {
  // Presence exists so a creator can tell busy from stuck, and nothing said
  // what its states do NOT establish. The `ReadPeer` prompt was routing
  // "whether it is done" here, which this tool cannot answer: a peer can go
  // idle having failed, and a running one says nothing about how far it is.
  const { requestHost } = requesterReturning(() => ({ peers: [] }))
  const guidance = (await createListPeersTool(requestHost).prompt()).replace(
    /\s+/g,
    ' ',
  )

  expect(guidance).toContain('What it shows is activity, never outcome')
  expect(guidance).toContain(
    "Whether work is done comes from the peer's own report or from the work itself",
  )
  // A peer stopped on a permission question cannot answer until the user does,
  // and the user is already looking at that prompt in its tab.
  expect(guidance).toContain('it cannot read or answer you until the user does')
  expect(guidance).toContain(
    'tell them only when the wait holds up something you owe them',
  )
})

test('a malformed row is dropped and the rest of the roster still lists', async () => {
  // Display degrades gracefully: whatever reaches the narrowing, one bad row
  // must cost that row and not the whole answer.
  const { requestHost } = requesterReturning(() => ({
    peers: [liveRow, { name: 'Nameless' }, { status: 'live' }, closedRow],
  }))
  const tool = createListPeersTool(requestHost)

  const result = await tool.call({})

  expect(result.data.ok).toBe(true)
  if (!result.data.ok) throw new Error('expected a roster')
  expect(result.data.peers.map(peer => peer.name)).toEqual(['Bear', 'Onyx'])
})

test('a value that is not a peer list is not read as an empty roster', async () => {
  const { requestHost } = requesterReturning(() => ({ notPeers: true }))
  const tool = createListPeersTool(requestHost)

  const result = await tool.call({})
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

test('a peer that says what it runs on renders it, including an id nobody recognises', () => {
  // Deliberately NOT matched against a known model set: the engine passes an
  // unrecognised id through so a new model works the day it ships, and a create
  // that mistyped one produces a session that boots and then dies on its first
  // request. Rendering the value verbatim is the only place that typo is
  // visible before the peer goes quiet.
  expect(
    narrowPeerView({
      ...liveRow,
      model: 'gpt-5.7-nova',
      effort: 'high',
    }),
  ).toMatchObject({ model: 'gpt-5.7-nova', effort: 'high' })
  expect(
    narrowPeerView({ ...liveRow, model: 'gtp-5.6-sol' })?.model,
  ).toBe('gtp-5.6-sol')
})

test('a model the roster cannot use costs the row its model, never the roster the row', () => {
  const noModel = { ...liveRow }
  expect(narrowPeerView(noModel)).not.toHaveProperty('model')
  // Wrong type, empty, and far longer than any model id: each is dropped and
  // the row still lists, because a roster is more use than a field.
  expect(narrowPeerView({ ...liveRow, model: 7 })).not.toHaveProperty('model')
  expect(narrowPeerView({ ...liveRow, model: '' })).not.toHaveProperty('model')
  expect(
    narrowPeerView({ ...liveRow, model: 'x'.repeat(129), effort: 'x'.repeat(129) }),
  ).toMatchObject({ name: 'Bear', status: 'live' })
  expect(
    narrowPeerView({ ...liveRow, model: 'x'.repeat(129) }),
  ).not.toHaveProperty('model')
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

/* ------------------------------------------------------------------------- *
 * The bounded default
 * ------------------------------------------------------------------------- */

/** A roster row as MAIN sends it, before the tool's own narrowing. */
function hostRow(
  name: string,
  status: 'live' | 'parked' | 'closed',
  lastActivity: number,
) {
  return {
    name,
    appSessionId: `a-${name}`,
    engineSessionId: null,
    status,
    title: null,
    lastActivity,
  }
}

/** Main's order: live, then parked, then closed, most recent first in each. */
function roster(live: number, parked: number, closed: number) {
  const rows = []
  let at = 1_756_900_000_000
  for (let i = 0; i < live; i += 1) rows.push(hostRow(`L${i}`, 'live', (at -= 1000)))
  for (let i = 0; i < parked; i += 1) rows.push(hostRow(`P${i}`, 'parked', (at -= 1000)))
  for (let i = 0; i < closed; i += 1) rows.push(hostRow(`C${i}`, 'closed', (at -= 1000)))
  return { peers: rows }
}

test('an ordinary call carries the whole live and parked roster and only the newest closed peers', async () => {
  // The point of the whole bound: the answer to "is anyone else working here"
  // must not be priced by how long this workspace has been used. Live and
  // parked stay complete because they are bounded by a process count and by
  // open tabs; the closed tail is the part that grows without limit.
  const { requestHost } = requesterReturning(() => roster(2, 1, 12))
  const tool = createListPeersTool(requestHost)

  const result = await tool.call({})
  const block = tool.mapToolResultToToolResultBlockParam(result.data, 'tu-6')

  if (!result.data.ok) throw new Error('expected a roster')
  expect(result.data.peers.map(peer => peer.name)).toEqual([
    'L0',
    'L1',
    'P0',
    'C0',
    'C1',
    'C2',
    'C3',
    'C4',
  ])
  expect(result.data.notListed).toBe(7)
  const answer = JSON.parse(String(block.content)) as { note?: string }
  expect(answer.note).toBe(
    '7 peers that closed earlier are not listed. Set all to true to see them.',
  )
})

test('all returns the roster whole', async () => {
  // The half that keeps the bound honest: a model that reads the note must be
  // able to see every name, or a closed peer it can still wake by name would
  // read as a peer that no longer exists.
  const { requestHost, asked } = requesterReturning(() => roster(2, 1, 12))
  const tool = createListPeersTool(requestHost)

  const result = await tool.call({ all: true })
  const block = tool.mapToolResultToToolResultBlockParam(result.data, 'tu-7')

  if (!result.data.ok) throw new Error('expected a roster')
  expect(result.data.peers).toHaveLength(15)
  expect(result.data.peers.map(peer => peer.name)).toContain('C11')
  expect(result.data.notListed).toBe(0)
  // Widening is the TOOL's own choice about what to render. Main is asked the
  // same question either way, so the verb keeps its empty args.
  expect(asked).toEqual([{ verb: 'peers.list', args: {} }])
  expect(JSON.parse(String(block.content))).not.toHaveProperty('note')
})

test('a roster small enough to fit says nothing about what was left out', async () => {
  // CLAUDE.md §7: say only what is surprising. A "nothing was omitted" line
  // would be paid for on every call in every workspace to report the ordinary
  // case, which is the cost this change exists to remove.
  const { requestHost } = requesterReturning(() => roster(1, 1, 3))
  const tool = createListPeersTool(requestHost)

  const result = await tool.call({})
  const block = tool.mapToolResultToToolResultBlockParam(result.data, 'tu-8')

  if (!result.data.ok) throw new Error('expected a roster')
  expect(result.data.notListed).toBe(0)
  const answer = JSON.parse(String(block.content)) as Record<string, unknown>
  expect(Object.keys(answer)).toEqual(['asOf', 'peers'])
})

test('a single left-out session is counted in the singular', async () => {
  const { requestHost } = requesterReturning(() => roster(0, 0, 6))
  const tool = createListPeersTool(requestHost)

  const result = await tool.call({})
  const block = tool.mapToolResultToToolResultBlockParam(result.data, 'tu-9')

  if (!result.data.ok) throw new Error('expected a roster')
  expect(result.data.notListed).toBe(1)
  expect(String(block.content)).toContain(
    '1 peer that closed earlier is not listed. Set all to true to see it.',
  )
})

test('the bound drops rows and never reorders them', () => {
  // Ordering is main's (`peerRequestPlane.ts:948`) and is deliberate. This
  // helper must be a filter, so a roster arriving in an order this file did not
  // predict still leaves in the order it arrived.
  const rows: PeerView[] = [
    { name: 'C0', status: 'closed', title: null, lastActivity: 'x' },
    { name: 'L0', status: 'live', title: null, lastActivity: 'x' },
    { name: 'C1', status: 'closed', title: null, lastActivity: 'x' },
    { name: 'P0', status: 'parked', title: null, lastActivity: 'x' },
    { name: 'C2', status: 'closed', title: null, lastActivity: 'x' },
  ]

  expect(boundClosedPeers(rows, 2)).toEqual({
    peers: [rows[0]!, rows[1]!, rows[2]!, rows[3]!],
    notListed: 1,
  })
  // Every live and parked row survives whatever the limit is.
  expect(boundClosedPeers(rows, 0).peers.map(peer => peer.name)).toEqual([
    'L0',
    'P0',
  ])
})
