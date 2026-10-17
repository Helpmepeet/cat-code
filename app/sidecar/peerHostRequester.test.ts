import { expect, test } from 'bun:test'
import type { PeerDescriptor } from '../shared/protocol.js'
import { requestPeerRoster, type PeerHostRequester } from './peerHostRequester.js'
import { createReadPeerTool } from './readPeerTool.js'
import { createPeerCompactContext } from './peerCompactContext.js'

const target: PeerDescriptor = {
  name: 'Bear', appSessionId: 'app-b', engineSessionId: null, status: 'live',
  createdBy: { appSessionId: 'creator', name: 'Alex' }, title: null, lastActivity: 10000,
}
const unowned: PeerDescriptor = {
  name: 'Coral', appSessionId: 'app-a', engineSessionId: 'dddddddd-0000-4000-8000-000000000001',
  status: 'parked', title: null, lastActivity: 10000,
}

function pagedRequester() {
  const calls: unknown[] = []
  const request = (async (_verb: string, args: { cursor?: string }) => {
    calls.push(args)
    return { ok: true, value: args.cursor
      ? { peers: [target] }
      : { peers: [unowned], nextCursor: 'app-a', remainingPeers: 1 } }
  }) as PeerHostRequester
  return { request, calls }
}

test('ReadPeer resolves a known peer beyond the first roster page', async () => {
  const { request, calls } = pagedRequester()
  const result = await createReadPeerTool(request).call({ peer: 'Bear' })
  expect(result.data.status).toBe('nothing_to_read')
  expect(calls).toEqual([{}, { cursor: 'app-a' }])
})

test('post-compact peer context includes owned peers beyond the first page', async () => {
  const { request, calls } = pagedRequester()
  const attachments = await createPeerCompactContext({ appSessionId: 'creator', requestHost: request })({ preservedMessages: [] })
  expect(JSON.stringify(attachments)).toContain('Bear')
  expect(calls).toEqual([{}, { cursor: 'app-a' }])
})

test('a nonadvancing cursor fails explicitly instead of looping or returning partial peers', async () => {
  let calls = 0
  const result = await requestPeerRoster((async () => {
    calls++
    return { ok: true, value: { peers: [target], nextCursor: 'app-a', remainingPeers: 1 } }
  }) as PeerHostRequester)
  expect(result).toMatchObject({ ok: false, error: { code: 'internal_error' } })
  expect(calls).toBe(2)
})

test('a later-page failure is not degraded to an incomplete successful roster', async () => {
  let calls = 0
  const result = await requestPeerRoster((async () => ++calls === 1
    ? { ok: true, value: { peers: [target], nextCursor: 'app-a', remainingPeers: 1 } }
    : { ok: false, error: { code: 'rate_limited', message: 'fixture limit' } }
  ) as PeerHostRequester)
  expect(result).toMatchObject({ ok: false, error: { code: 'rate_limited' } })
})
