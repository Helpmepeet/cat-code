import { expect, test } from 'bun:test'
import type { Attachment } from '../../src/utils/attachments.js'
import type {
  HostRequestArgs,
  HostRequestVerb,
  PeerDescriptor,
} from '../shared/protocol.js'
import type {
  HostRequestOptions,
  HostRequestOutcome,
} from './sidecarServer.js'
import {
  createPeerCompactContext,
  MAX_PEER_COMPACT_CONTEXT_PEERS,
  PEER_COMPACT_CONTEXT_TIMEOUT_MS,
} from './peerCompactContext.js'
import type { PeerHostRequester } from './peerHostRequester.js'

function peer(
  name: string,
  createdByAppSessionId: string | undefined,
  status: PeerDescriptor['status'] = 'live',
  presence?: PeerDescriptor['presence'],
): PeerDescriptor {
  return {
    name,
    appSessionId: `app-${name}`,
    engineSessionId: `engine-${name}`,
    status,
    ...(presence !== undefined ? { presence } : {}),
    ...(createdByAppSessionId !== undefined
      ? { createdBy: { appSessionId: createdByAppSessionId, name: 'Alex' } }
      : {}),
    title: null,
    lastActivity: 0,
  }
}

function requester(
  peers: PeerDescriptor[],
  calls: Array<{ options?: { timeoutMs?: number } }>,
): PeerHostRequester {
  return async <V extends HostRequestVerb>(
    verb: V,
    _args: HostRequestArgs[V],
    options?: HostRequestOptions,
  ): Promise<HostRequestOutcome<V>> => {
    calls.push({ options })
    if (verb !== 'peers.list') {
      return {
        ok: false,
        error: { code: 'unknown_verb', message: 'unexpected test verb' },
      } as HostRequestOutcome<V>
    }
    return { ok: true, value: { peers } } as HostRequestOutcome<V>
  }
}

test('restores only peers directly created by this app session', async () => {
  const calls: Array<{ options?: { timeoutMs?: number } }> = []
  const getAttachments = createPeerCompactContext({
    appSessionId: 'app-alex',
    requestHost: requester(
      [
        peer('Bear', 'app-alex', 'live', 'running'),
        peer('Coral', 'app-alex', 'parked'),
        peer('Quartz', 'app-other', 'live', 'idle'),
        peer('Onyx', undefined, 'closed'),
      ],
      calls,
    ),
  })

  const attachments = await getAttachments({ preservedMessages: [] })

  expect(calls).toEqual([{ options: { timeoutMs: PEER_COMPACT_CONTEXT_TIMEOUT_MS } }])
  expect(attachments).toHaveLength(1)
  const snapshot = attachments[0] as Extract<
    Attachment,
    { type: 'peer_coordination_state' }
  >
  expect(snapshot.peers).toEqual([
    { name: 'Bear', status: 'live', presence: 'running' },
    { name: 'Coral', status: 'parked' },
  ])
  expect(snapshot).not.toHaveProperty('appSessionId')
  expect(JSON.stringify(snapshot)).not.toContain('engine-')
  expect(JSON.stringify(snapshot)).not.toContain('createdBy')
})

test('does not request peer state for a subagent', async () => {
  let calls = 0
  const getAttachments = createPeerCompactContext({
    appSessionId: 'app-alex',
    requestHost: async () => {
      calls++
      return { ok: true, value: { peers: [] } } as never
    },
  })

  expect(
    await getAttachments({
      preservedMessages: [],
      agentId: 'agent-child' as never,
    }),
  ).toEqual([])
  expect(calls).toBe(0)
})

test('fails soft when the host cannot list peers', async () => {
  const getAttachments = createPeerCompactContext({
    appSessionId: 'app-alex',
    requestHost: async () => ({
      ok: false,
      error: { code: 'timeout', message: 'timed out' },
    }) as never,
  })

  expect(await getAttachments({ preservedMessages: [] })).toEqual([])
})

test('bounds the restored peer roster and records omitted rows', async () => {
  const calls: Array<{ options?: { timeoutMs?: number } }> = []
  const peers = Array.from({ length: MAX_PEER_COMPACT_CONTEXT_PEERS + 5 }, (_, i) =>
    peer(`Peer-${i}`, 'app-alex', 'closed'),
  )
  const getAttachments = createPeerCompactContext({
    appSessionId: 'app-alex',
    requestHost: requester(peers, calls),
  })

  const attachments = await getAttachments({ preservedMessages: [] })
  const snapshot = attachments[0] as Extract<
    Attachment,
    { type: 'peer_coordination_state' }
  >

  expect(snapshot.peers).toHaveLength(MAX_PEER_COMPACT_CONTEXT_PEERS)
  expect(snapshot.omittedCount).toBe(5)
  expect(JSON.stringify(snapshot).length).toBeLessThan(8 * 1024)
})
