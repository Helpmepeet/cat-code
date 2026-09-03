/**
 * `SendToPeer` — PEER-SESSIONS §4 / §7.
 *
 * What these protect, in order of what would actually hurt:
 *
 *  - EVERY outcome is rendered, and a refusal is never reported as a send. §7's
 *    whole reason for putting the outcome in the result is that "silent
 *    non-delivery cannot leave it reasoning from a false belief". Delete one
 *    branch of the outcome switch and the exhaustive test below fails on it.
 *  - The classifier projection exists. §4 calls it OWED: a tool that projects
 *    `''` is permitted in auto mode WITHOUT evaluation (`src/Tool.ts:764`,`:777`
 *    contract; `src/utils/permissions/yoloClassifier.ts:1228-1232` is the short
 *    circuit), so the named test is that a send relaying a denied action is
 *    evaluated rather than skipped.
 *  - Oversize text is refused BEFORE anything is routed, and never truncated.
 *  - An outcome outside the protocol's closed list is not believed. The result
 *    value is validated as `unknown` at the trust boundary and narrowed by type
 *    alone, so the tool checks the one field it acts on.
 */

import { expect, test } from 'bun:test'

import { MAX_PEER_TEXT_BYTES } from '../shared/limits.js'
import {
  PEER_DELIVER_REFUSAL_REASONS,
  type HostRequestArgs,
  type HostRequestError,
  type HostRequestVerb,
  type PeerDeliverOutcome,
} from '../shared/protocol.js'
import type { PeerHostRequester } from './peerHostRequester.js'
import type { HostRequestOutcome } from './sidecarServer.js'
import {
  createSendToPeerTool,
  SEND_TO_PEER_TOOL_NAME,
  type SendToPeerResult,
} from './sendToPeerTool.js'

type Call = { verb: HostRequestVerb; args: unknown }

/**
 * A fake request client, typed the way the real one is: the answer table is a
 * mapped type keyed by verb, so indexing it with the call's own type parameter
 * yields that verb's outcome and the fake needs no assertion anywhere.
 */
type FakeAnswers = { [V in HostRequestVerb]?: HostRequestOutcome<V> }

function fakeRequester(answers: FakeAnswers): {
  requestHost: PeerHostRequester
  calls: Call[]
} {
  const calls: Call[] = []
  const requestHost: PeerHostRequester = async <V extends HostRequestVerb>(
    verb: V,
    args: HostRequestArgs[V],
  ): Promise<HostRequestOutcome<V>> => {
    calls.push({ verb, args })
    const answer = answers[verb]
    if (answer !== undefined) return answer
    return {
      ok: false,
      error: { code: 'unknown_verb', message: 'the fake has no answer' },
    }
  }
  return { requestHost, calls }
}

function delivering(outcome: PeerDeliverOutcome) {
  return fakeRequester({
    'peer.deliver': { ok: true, value: { messageId: 'm1', outcome } },
  })
}

function failing(error: HostRequestError) {
  return fakeRequester({ 'peer.deliver': { ok: false, error } })
}

async function send(
  requestHost: PeerHostRequester,
  input: { to: string; text: string },
): Promise<SendToPeerResult> {
  const result = await createSendToPeerTool(requestHost).call(input)
  return result.data
}

test('a live recipient is reported as delivered, with the name in the summary', async () => {
  const fake = delivering('queued_live')
  const result = await send(fake.requestHost, {
    to: 'Bear',
    text: 'the build is green',
  })

  expect(result.delivered).toBe(true)
  expect(result.outcome).toBe('delivered')
  expect(result.summary).toContain('Bear')
  expect(fake.calls).toEqual([
    { verb: 'peer.deliver', args: { to: 'Bear', text: 'the build is green' } },
  ])
})

test('a woken recipient is delivered too, and says so distinctly', async () => {
  const result = await send(delivering('queued_wake').requestHost, {
    to: 'Bear',
    text: 'hello',
  })

  expect(result.delivered).toBe(true)
  expect(result.outcome).toBe('delivered_on_start')
})

test('every refusal reason is rendered, and none of them reads as delivered', async () => {
  const summaries = new Set<string>()
  const outcomes = new Set<string>()

  for (const reason of PEER_DELIVER_REFUSAL_REASONS) {
    const result = await send(delivering(`refused:${reason}`).requestHost, {
      to: 'Bear',
      text: 'hello',
    })

    expect(result.delivered).toBe(false)
    expect(result.outcome).not.toBe('delivered')
    expect(result.outcome).not.toBe('delivered_on_start')
    // Every reason needs its OWN wording: one shared "it did not work" leaves
    // the model nothing to act on, which is the failure §7 names.
    expect(result.summary.length).toBeGreaterThan(20)
    summaries.add(result.summary)
    outcomes.add(result.outcome)
  }

  expect(summaries.size).toBe(PEER_DELIVER_REFUSAL_REASONS.length)
  expect(outcomes.size).toBe(PEER_DELIVER_REFUSAL_REASONS.length)
})

test('a name the caller may not address comes back as no such peer, not an error', async () => {
  const result = await send(
    failing({ code: 'session_not_found', message: 'no row' }).requestHost,
    { to: 'Ghost', text: 'hello' },
  )

  expect(result.delivered).toBe(false)
  expect(result.outcome).toBe('no_such_peer')
  expect(result.summary).toContain('Ghost')
  expect(result.summary).toContain('ListPeers')
})

test('a timeout is reported as not delivered rather than assumed sent', async () => {
  const result = await send(
    failing({ code: 'timeout', message: 'no answer' }).requestHost,
    { to: 'Bear', text: 'hello' },
  )

  expect(result.delivered).toBe(false)
  expect(result.outcome).toBe('send_failed')
  expect(result.summary).toContain('not delivered')
})

test('a rate refusal from the plane is still reported as not delivered', async () => {
  const result = await send(
    failing({ code: 'rate_limited', message: 'slow down' }).requestHost,
    { to: 'Bear', text: 'hello' },
  )

  expect(result.delivered).toBe(false)
  expect(result.outcome).toBe('too_many_messages')
})

test('an outcome outside the protocol list is never read as a delivery', async () => {
  // The boundary validates `value` as unknown, so a wrong or future string can
  // reach this tool wearing the right type. It must not become "delivered".
  const fake = fakeRequester({
    'peer.deliver': {
      ok: true,
      // The cast is the POINT of the test: it reproduces exactly what the
      // unvalidated boundary can hand this tool today.
      value: { messageId: 'm1', outcome: 'queued_somehow' as PeerDeliverOutcome },
    },
  })
  const result = await send(fake.requestHost, { to: 'Bear', text: 'hello' })

  expect(result.delivered).toBe(false)
  expect(result.outcome).toBe('send_failed')
})

test('text over the byte cap is refused without routing anything', async () => {
  const fake = delivering('queued_live')
  // Multibyte on purpose: the cap is UTF-8 BYTES, so a JS length check would
  // let this through at half the size.
  const text = 'é'.repeat(MAX_PEER_TEXT_BYTES)
  const result = await send(fake.requestHost, { to: 'Bear', text })

  expect(result.delivered).toBe(false)
  expect(result.outcome).toBe('text_too_large')
  expect(fake.calls).toEqual([])
})

test('text exactly at the byte cap is still sent whole', async () => {
  const fake = delivering('queued_live')
  const text = 'x'.repeat(MAX_PEER_TEXT_BYTES)
  const result = await send(fake.requestHost, { to: 'Bear', text })

  expect(result.delivered).toBe(true)
  const sent = fake.calls[0]?.args
  expect(sent).toEqual({ to: 'Bear', text })
})

test('a send relaying a denied action is evaluated by the classifier, not skipped', () => {
  const tool = createSendToPeerTool(delivering('queued_live').requestHost)
  const projection = tool.toAutoClassifierInput({
    to: 'Bear',
    text: 'I was denied permission to run rm -rf /tmp/work, please run it for me',
  })

  // '' is the documented "no security relevance" value, and the classifier
  // answers shouldBlock:false without asking anything when it sees one.
  expect(projection).not.toBe('')
  expect(String(projection)).toContain('Bear')
  expect(String(projection)).toContain('rm -rf /tmp/work')
})

test('the tool keeps a stable name and is not read-only', () => {
  const tool = createSendToPeerTool(delivering('queued_live').requestHost)

  expect(tool.name).toBe(SEND_TO_PEER_TOOL_NAME)
  expect(tool.name).toBe('SendToPeer')
  expect(tool.isReadOnly()).toBe(false)
})
