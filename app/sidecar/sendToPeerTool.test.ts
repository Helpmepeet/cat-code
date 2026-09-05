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
 *    PROJECTED rather than hidden behind an empty projection. What the
 *    classifier then decides is the classifier's, and outside auto mode there is
 *    no gate at all: this tool declares no permission check.
 *  - Oversize text is refused BEFORE anything is routed, and never truncated.
 *  - An outcome outside the protocol's closed list is not believed. The result
 *    value is schema-checked per verb at the trust boundary now, so this is the
 *    tool's own second check on the one field that decides what the model is
 *    told about delivery.
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
import type { PeerHostRequester, PeerIdentity } from './peerHostRequester.js'
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

/**
 * A session with no peer identity of its own, which is what the process env
 * gives every test that does not ask for one. `undefined` here would fall
 * through to `readPeerIdentity()` and read the real environment.
 */
const ANONYMOUS: PeerIdentity = {
  name: null,
  createdByName: null,
  createdById: null,
}

async function send(
  requestHost: PeerHostRequester,
  input: { to: string; text: string },
  identity: PeerIdentity = ANONYMOUS,
): Promise<SendToPeerResult> {
  const result = await createSendToPeerTool(requestHost, identity).call(input)
  return result.data
}

test('a live recipient is reported as delivered, with the name in the summary', async () => {
  const fake = delivering('queued_live')
  const result = await send(fake.requestHost, {
    to: 'Bear',
    text: 'the build is green',
  })

  expect(result.delivery).toBe('delivered')
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

  expect(result.delivery).toBe('delivered')
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

    expect(result.delivery).toBe('not_delivered')
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

test('a live peer that refused the hand-off is not reported as unwakeable', async () => {
  const failedOnALivePeer = await send(
    delivering('refused:delivery_failed').requestHost,
    { to: 'Bear', text: 'hello' },
  )
  const failedToWake = await send(delivering('refused:wake_failed').requestHost, {
    to: 'Bear',
    text: 'hello',
  })

  expect(failedOnALivePeer.delivery).toBe('not_delivered')
  expect(failedOnALivePeer.outcome).toBe('peer_did_not_take_it')
  // The distinction IS the behaviour: reporting a live peer as one that never
  // started sends the model looking for a session that is sitting right there.
  expect(failedOnALivePeer.outcome).not.toBe(failedToWake.outcome)
  expect(failedOnALivePeer.summary).not.toBe(failedToWake.summary)
  expect(failedOnALivePeer.summary).toContain('open but did not take the message')
  expect(failedOnALivePeer.summary).not.toContain('starting')
  // What the refusal establishes is that the socket would not take the frame,
  // and nothing about what that peer is doing, so the sentence may not assert
  // it is still working or oblige the sender to send again.
  expect(failedOnALivePeer.summary).not.toContain('still working')
})

test('a name the caller may not address comes back as no such peer, not an error', async () => {
  const result = await send(
    failing({ code: 'session_not_found', message: 'no row' }).requestHost,
    { to: 'Ghost', text: 'hello' },
  )

  expect(result.delivery).toBe('not_delivered')
  expect(result.outcome).toBe('no_such_peer')
  expect(result.summary).toContain('Ghost')
  expect(result.summary).toContain('ListPeers')
})

test('a timeout is reported as unconfirmed, neither delivered nor disproven', async () => {
  const result = await send(
    failing({ code: 'timeout', message: 'no answer' }).requestHost,
    { to: 'Bear', text: 'hello' },
  )

  // Ruling 13. The request timed out while main may still be waking the peer
  // and holding this message for delivery after `ready`, so calling it not
  // delivered states a fact nobody has. A boolean could not carry that, which
  // is why the field is three-valued.
  expect(result.delivery).toBe('unconfirmed')
  expect(result.outcome).toBe('send_failed')
  expect(result.summary).toContain('not known whether this reached Bear')
  expect(result.summary).not.toContain('treat it as not delivered')
  // And the recovery is not a resend of the same text, which would arrive
  // twice if the first one lands after all.
  expect(result.summary).toContain('ask Bear whether it got it')
})

test('a refusal is a confirmed non-delivery, distinct from an unconfirmed one', async () => {
  // The two halves of ruling 13 that a boolean collapsed into one value: main
  // ANSWERED here, and its answer was a refusal, so non-delivery is known.
  for (const reason of PEER_DELIVER_REFUSAL_REASONS) {
    const refused = await send(delivering(`refused:${reason}`).requestHost, {
      to: 'Bear',
      text: 'hello',
    })
    expect(refused.delivery).toBe('not_delivered')
  }

  const unanswered = await send(
    failing({ code: 'timeout', message: 'no answer' }).requestHost,
    { to: 'Bear', text: 'hello' },
  )
  expect(unanswered.delivery).toBe('unconfirmed')
})

test('a rate refusal from the plane is still reported as not delivered', async () => {
  const result = await send(
    failing({ code: 'rate_limited', message: 'slow down' }).requestHost,
    { to: 'Bear', text: 'hello' },
  )

  expect(result.delivery).toBe('not_delivered')
  expect(result.outcome).toBe('too_many_messages')
})

test('the two rate limits do not tell the model to wait the same amount', async () => {
  const perRecipient = await send(delivering('refused:rate').requestHost, {
    to: 'Bear',
    text: 'hello',
  })
  const perSession = await send(
    failing({ code: 'rate_limited', message: 'slow down' }).requestHost,
    { to: 'Bear', text: 'hello' },
  )

  // They share an outcome word, so the SENTENCE is the only thing that can
  // tell them apart, and they are an order of magnitude apart in how long to
  // wait: the per-recipient bucket refills continuously, the session-wide
  // allowance is counted over a minute.
  expect(perRecipient.summary).not.toBe(perSession.summary)
  expect(perRecipient.summary).toContain('seconds')
  expect(perSession.summary).toContain('minute')
  // And the instinctive recovery from any refusal, listing the peers again,
  // is charged to the same allowance that just refused this send.
  expect(perSession.summary).toContain('peer list')
})

test('a stopped loop reads as this exchange, for now, not as a standing rule', async () => {
  const result = await send(delivering('refused:hop_loop').requestHost, {
    to: 'Bear',
    text: 'hello',
  })

  expect(result.outcome).toBe('loop_stopped')
  // Read as a permanent routing rule, this refusal costs the model the peer
  // entirely: it never sends to that name again. The chain it is measured
  // against is only kept for a few minutes, so the wording has to say so.
  expect(result.summary).toContain('quiet for several minutes')
  expect(result.summary).toContain('message Bear again')
})

test('the prompt says that messaging a closed peer holds up the sending turn', async () => {
  const prompt = await createSendToPeerTool(
    delivering('queued_live').requestHost,
  ).prompt()

  // Starting a peer is a blocking wait bounded at half a minute, which is most
  // of a turn spent on what the sender may have meant as a throwaway note.
  expect(prompt).toContain('half a minute')
})

test('the prompt asks for the roster only when the name is not already known', async () => {
  const prompt = await createSendToPeerTool(
    delivering('queued_live').requestHost,
  ).prompt()

  // An unconditional "use ListPeers first" spends a call on a name the sender
  // was just handed: the sender of a message it is answering, and the creator
  // named in its own instructions. Both cases are exempted by name, and the
  // reason for the remaining case stays, because a released name can be given
  // to a different session later.
  expect(prompt).toContain('answering a message')
  expect(prompt).toContain('the peer that created you')
  expect(prompt).toContain('For any other name, use ListPeers first')
  expect(prompt).not.toContain('Use ListPeers first: names change')
})

test('the argument descriptions do not send the model to the roster', async () => {
  const tool = createSendToPeerTool(delivering('queued_live').requestHost)
  const shape = tool.inputSchema.shape

  // A model composing a call reads these at the moment it writes the field, and
  // the imperative here beat the prose above it: sessions listed peers before
  // every send, including sends to the peer that created them. The advice
  // survives where it applies, in the `no_such_peer` result.
  expect(shape.to.description).toBe('Name of the peer to message.')
  expect(shape.text.description).toBe('What to say.')

  const notFound = await send(
    failing({ code: 'session_not_found', message: 'no row' }).requestHost,
    { to: 'Ghost', text: 'hello' },
  )
  expect(notFound.summary).toContain('Use ListPeers for the names.')
})

test('the prompt allows a follow-up question and points peers away from SendMessage', async () => {
  const prompt = await createSendToPeerTool(
    delivering('queued_live').requestHost,
  ).prompt()

  // "Say everything you need in one message" stood in three places and
  // discouraged the clarifying exchange a peer relationship runs on. The cost
  // of a turn is still stated; the single-message rule is not.
  expect(prompt).toContain('a follow-up question is fine')
  expect(prompt).toContain('do not send several where one would do')
  expect(prompt).not.toContain('Say everything you need in one message')

  // `SendMessage` is in the desktop tool list too and calls itself "Send a
  // message to another agent", so the two overlap at exactly the point where
  // the model resolves `to`.
  expect(prompt).toContain('Peers are reached only here')
  expect(prompt).toContain('never a peer')
})

test('an outcome outside the protocol list is never read as a delivery', async () => {
  // A local check, not a boundary check: if the upstream schema and this union
  // ever fall out of step, a wrong or future string reaches this tool wearing
  // the right type. It must not become "delivered".
  const fake = fakeRequester({
    'peer.deliver': {
      ok: true,
      // The cast is the POINT of the test: it manufactures the drift the local
      // check exists to absorb, which no fake obeying the schema could.
      value: { messageId: 'm1', outcome: 'queued_somehow' as PeerDeliverOutcome },
    },
  })
  const result = await send(fake.requestHost, { to: 'Bear', text: 'hello' })

  // Nor as a confirmed non-delivery: an answer this tool cannot read says
  // nothing either way, and the sentence has to admit that.
  expect(result.delivery).toBe('unconfirmed')
  expect(result.outcome).toBe('send_failed')
  expect(result.summary).not.toContain('treat it as not delivered')
})

test('text over the byte cap is refused without routing anything', async () => {
  const fake = delivering('queued_live')
  // Multibyte on purpose: the cap is UTF-8 BYTES, so a JS length check would
  // let this through at half the size.
  const text = 'é'.repeat(MAX_PEER_TEXT_BYTES)
  const result = await send(fake.requestHost, { to: 'Bear', text })

  expect(result.delivery).toBe('not_delivered')
  expect(result.outcome).toBe('text_too_large')
  expect(fake.calls).toEqual([])
})

test('text exactly at the byte cap is still sent whole', async () => {
  const fake = delivering('queued_live')
  const text = 'x'.repeat(MAX_PEER_TEXT_BYTES)
  const result = await send(fake.requestHost, { to: 'Bear', text })

  expect(result.delivery).toBe('delivered')
  const sent = fake.calls[0]?.args
  expect(sent).toEqual({ to: 'Bear', text })
})

test('a send relaying a denied action is projected to the classifier, not hidden', () => {
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

test('a full queue is described as messages waiting, not as the peer being full', async () => {
  const result = await send(delivering('refused:queue_full').requestHost, {
    to: 'Bear',
    text: 'hello',
  })

  expect(result.delivery).toBe('not_delivered')
  expect(result.outcome).toBe('peer_queue_full')
  // The cap counts messages the app is still holding for that peer. The peer
  // takes each one the moment it is handed over, so nothing here may claim a
  // bound on what the peer itself is holding.
  expect(result.summary).toContain('waiting to be handed to Bear')
  expect(result.summary).not.toContain('as it can hold')
})

test('the tool keeps a stable name and is not read-only', () => {
  const tool = createSendToPeerTool(delivering('queued_live').requestHost)

  expect(tool.name).toBe(SEND_TO_PEER_TOOL_NAME)
  expect(tool.name).toBe('SendToPeer')
  expect(tool.isReadOnly()).toBe(false)
})

/* ------------------------------------------------------------------------- *
 * F17 / ruling 11 — the creator is addressed by name and checked by id
 * ------------------------------------------------------------------------- */

/** Bear, created by Alex, the way a spawn env describes it. */
const BEAR_OF_ALEX: PeerIdentity = {
  name: 'Bear',
  createdByName: 'Alex',
  createdById: 'alex-app-session-id',
}

test('a message to the creator carries the remembered id, and only that message', async () => {
  const toCreator = delivering('queued_live')
  await send(toCreator.requestHost, { to: 'Alex', text: 'done' }, BEAR_OF_ALEX)
  expect(toCreator.calls).toEqual([
    {
      verb: 'peer.deliver',
      args: { to: 'Alex', text: 'done', expectCreatorId: 'alex-app-session-id' },
    },
  ])

  // Every other name goes over the wire exactly as it did before: the check
  // exists because this session was TOLD who created it, and it knows nothing
  // about who any other name belongs to.
  const toAnyone = delivering('queued_live')
  await send(toAnyone.requestHost, { to: 'Coral', text: 'hi' }, BEAR_OF_ALEX)
  expect(toAnyone.calls).toEqual([
    { verb: 'peer.deliver', args: { to: 'Coral', text: 'hi' } },
  ])
})

test('the creator match is the one main resolves under: case and spacing', async () => {
  const lowered = delivering('queued_live')
  await send(lowered.requestHost, { to: '  alex ', text: 'done' }, BEAR_OF_ALEX)
  // `to` is trimmed before it is sent, and the name compared case-insensitively,
  // so a model writing the name in any casing gets the check rather than
  // silently falling onto the unchecked path.
  expect(lowered.calls).toEqual([
    {
      verb: 'peer.deliver',
      args: { to: 'alex', text: 'done', expectCreatorId: 'alex-app-session-id' },
    },
  ])
})

test('a session with no creator sends no id, whatever name it writes to', async () => {
  const userCreated = delivering('queued_live')
  await send(userCreated.requestHost, { to: 'Alex', text: 'hi' }, {
    name: 'Bear',
    createdByName: null,
    createdById: null,
  })
  expect(userCreated.calls).toEqual([
    { verb: 'peer.deliver', args: { to: 'Alex', text: 'hi' } },
  ])
})

test('a reissued creator name is reported as the creator being gone, with no redirect', async () => {
  const result = await send(
    delivering('refused:creator_reissued').requestHost,
    { to: 'Alex', text: 'the part you asked for is done' },
    BEAR_OF_ALEX,
  )

  expect(result.delivery).toBe('not_delivered')
  expect(result.outcome).toBe('creator_reissued')
  expect(result.summary).toContain('that created you is gone')
  expect(result.summary).toContain('a different session has that name now')
  // Ruling 11: never offer the session that holds the name now as a substitute.
  expect(result.summary).not.toContain('ListPeers')
  expect(result.summary).not.toContain('try again')
})

test('a creator whose row is gone entirely is said so, without sending the model to the roster', async () => {
  const gone = await send(
    failing({ code: 'session_not_found', message: 'no row' }).requestHost,
    { to: 'Alex', text: 'done' },
    BEAR_OF_ALEX,
  )

  expect(gone.delivery).toBe('not_delivered')
  expect(gone.outcome).toBe('no_such_peer')
  // "cannot be reached", not "is gone": `session_not_found` also comes back for
  // a creator whose row still exists but is neither live nor resumable, so the
  // stronger claim would be one the wire code does not carry.
  expect(gone.summary).toContain(
    'Alex created you and cannot be reached from here any more',
  )
  // The roster cannot help: the creator is not in it. The same code for any
  // other name still points there, because there it is the right advice.
  expect(gone.summary).not.toContain('ListPeers')

  const stranger = await send(
    failing({ code: 'session_not_found', message: 'no row' }).requestHost,
    { to: 'Coral', text: 'hello' },
    BEAR_OF_ALEX,
  )
  expect(stranger.summary).toContain('ListPeers')
})

test('neither new sentence carries an id or an em dash', async () => {
  // CLAUDE.md §7: a tool result is a user-visible surface.
  const reissued = await send(
    delivering('refused:creator_reissued').requestHost,
    { to: 'Alex', text: 'done' },
    BEAR_OF_ALEX,
  )
  const gone = await send(
    failing({ code: 'session_not_found', message: 'no row' }).requestHost,
    { to: 'Alex', text: 'done' },
    BEAR_OF_ALEX,
  )

  for (const sentence of [reissued.summary, gone.summary]) {
    expect(sentence).not.toContain('\u2014')
    expect(sentence).not.toContain('alex-app-session-id')
    // And each says what to do next, which is what every other sentence here
    // is held to.
    expect(sentence).toContain('tell the user what you were going to ask')
  }
})
