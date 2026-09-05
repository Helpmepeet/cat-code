/**
 * `SendToPeer` — PEER-SESSIONS §4, build step 4's tool half
 * (decisions/PEER-SESSIONS.md §0a keeps it in v1; §4 gives its args and rules).
 *
 * This module is the SENDING side only, and it authors almost nothing. Main
 * mints the message id, stamps `from` off the connection (HR2), derives the hop
 * chain per pair, and applies every guard; this tool hands over a name and a
 * body and then reports, honestly, what came back. §7: "The send result tells
 * the sender what happened, so silent non-delivery cannot leave it reasoning
 * from a false belief" — so every refusal reason and every typed request-plane
 * failure gets its own sentence here, and none of them is swallowed into a
 * generic error.
 *
 * Built through the engine's own `buildTool` (`src/Tool.ts:793`) rather than a
 * hand-rolled tool object, so the defaults, the classifier contract and the
 * permission path are the engine runtime's own (CLAUDE.md §8 rule 1).
 */

// zod comes from the ENGINE'S copy, by path, on purpose. `app/` has a second,
// transitive zod (4.4.3) beside the engine's root one (4.3.6), and a bare
// `zod/v4` written in this directory resolves to the app copy. TypeScript
// dedupes two node_modules copies by package id, and that id carries the exact
// version STRING: one string means one type identity, two strings mean two,
// and comparing zod's recursive conditional types across two identities
// exhausts the heap. The symptom is `tsc` dying at ~4GB with no diagnostic,
// not a type error you can read. The path specifier resolves to the same
// realpath `src/` gets, so both planes share one identity whatever the
// versions say. At runtime the copies interoperate (a 4.4.3 schema converts
// and parses fine through 4.3.6); it is the typecheck that breaks.
import { z } from '../../node_modules/zod/v4'

import { buildTool, type ToolDef } from '../../src/Tool.js'
import { lazySchema } from '../../src/utils/lazySchema.js'
import { jsonStringify } from '../../src/utils/slowOperations.js'

import { MAX_PEER_TEXT_BYTES } from '../shared/limits.js'
import {
  PEER_DELIVER_REFUSAL_REASONS,
  type HostRequestError,
  type PeerDeliverOutcome,
} from '../shared/protocol.js'
import {
  describeHostRequestError,
  readPeerIdentity,
  requestPeerHost,
  type PeerHostRequester,
  type PeerIdentity,
} from './peerHostRequester.js'

export const SEND_TO_PEER_TOOL_NAME = 'SendToPeer'

const inputSchema = lazySchema(() =>
  z.strictObject({
    // No "use ListPeers for the names" here. A model composing a call reads the
    // argument description at the moment it writes `to`, and the imperative won
    // over the prose above it: sessions listed peers before every send,
    // including sends to the peer that created them, whose name they already
    // had. The `no_such_peer` result keeps the sentence, which is the moment the
    // advice applies.
    to: z.string().min(1).describe('Name of the peer to message.'),
    text: z.string().min(1).describe('What to say.'),
  }),
)

type InputSchema = ReturnType<typeof inputSchema>
type Input = z.infer<InputSchema>

/**
 * What the sending model reads. `outcome` is a small closed vocabulary in plain
 * words rather than the wire's own refusal tokens: the model needs to branch on
 * the result, and the transcript row needs to be readable.
 */
export type SendToPeerOutcome =
  | 'delivered'
  | 'delivered_on_start'
  | 'blocked_by_user'
  | 'loop_stopped'
  | 'chain_too_long'
  | 'too_many_messages'
  | 'already_sent'
  | 'peer_queue_full'
  | 'peer_did_not_start'
  | 'peer_did_not_take_it'
  | 'no_such_peer'
  | 'creator_reissued'
  | 'text_too_large'
  | 'send_failed'

/**
 * THREE facts, not two (ruling 13, 2026-09-06). A boolean cannot carry this
 * one: a request that times out at `HOST_REQUEST_TIMEOUT_MS` may still be
 * delivered afterwards, because main can still be waking the peer and holds the
 * message for delivery once it reports `ready`. Reporting that as `false` told
 * the sender a message had not arrived when nobody knew, and reporting it as
 * `true` would be worse. `unconfirmed` is the honest third value, and the wire
 * outcomes (`PeerDeliverOutcome`) are untouched by it.
 */
export type SendToPeerDelivery = 'delivered' | 'not_delivered' | 'unconfirmed'

export type SendToPeerResult = {
  to: string
  delivery: SendToPeerDelivery
  outcome: SendToPeerOutcome
  summary: string
}

/**
 * Every outcome the wire can actually carry, as a lookup rather than a type
 * assertion.
 *
 * `host.result.value` IS now schema-checked per verb at the trust boundary, so
 * this is a SECOND, local check rather than the only one. It stays deliberately.
 * This tool reads exactly one field off that value and that field decides what
 * the model is told about delivery, which is the one thing §7 says must never be
 * wrong; a check at the point of use costs a map lookup and does not depend on
 * another module keeping its schema in step with this union. Derived from
 * `PEER_DELIVER_REFUSAL_REASONS` so it cannot drift from the wire.
 */
const DELIVER_OUTCOMES = new Map<string, PeerDeliverOutcome>([
  ['queued_live', 'queued_live'],
  ['queued_wake', 'queued_wake'],
])
for (const reason of PEER_DELIVER_REFUSAL_REASONS) {
  DELIVER_OUTCOMES.set(`refused:${reason}`, `refused:${reason}`)
}

/** Every refusal main can answer with, each rendered as something to act on. */
function describeOutcome(
  to: string,
  outcome: PeerDeliverOutcome,
): SendToPeerResult {
  switch (outcome) {
    case 'queued_live':
      return {
        to,
        delivery: 'delivered',
        outcome: 'delivered',
        summary: `Delivered to ${to}. It is already working, so it reads this at its next step.`,
      }
    case 'queued_wake':
      return {
        to,
        delivery: 'delivered',
        outcome: 'delivered_on_start',
        summary: `Delivered to ${to}. It was not open, so it is starting up and reads this once it is running.`,
      }
    case 'refused:user_stopped':
      return {
        to,
        delivery: 'not_delivered',
        outcome: 'blocked_by_user',
        summary: `Not delivered. ${to} is closed and the user has turned off reopening it. Ask the user to open it, or carry on without it.`,
      }
    case 'refused:hop_loop':
      return {
        to,
        delivery: 'not_delivered',
        outcome: 'loop_stopped',
        // TEMPORAL, and it has to read that way. The chain this is measured
        // against is only kept for a few minutes past its last hop, so a model
        // that reads this as a standing rule about who it may talk to stops
        // messaging a peer it is free to message again.
        summary: `Not delivered. This message would send back around an exchange that already reached you. Answer what you were asked instead of passing it on. Only that exchange is blocked, and only while it is still live: once it has been quiet for several minutes you can message ${to} again.`,
      }
    case 'refused:hop_runaway':
      return {
        to,
        delivery: 'not_delivered',
        outcome: 'chain_too_long',
        summary: `Not delivered. The back and forth with ${to} has run too long. Finish the work yourself, or write the user what is still open.`,
      }
    case 'refused:rate':
      return {
        to,
        delivery: 'not_delivered',
        outcome: 'too_many_messages',
        // Seconds, not the minute the session-wide allowance is counted over:
        // this bucket is per recipient and refills continuously, so the two
        // refusals must not offer the same advice.
        summary: `Not delivered. Too many messages to ${to} in a short time. Wait a few seconds, then send one message that covers everything.`,
      }
    case 'refused:duplicate':
      return {
        to,
        delivery: 'not_delivered',
        outcome: 'already_sent',
        // It does NOT say the peer has the text: the earlier send is what the
        // duplicate window saw, and whether THAT one was delivered is not known
        // here. Nor does it impose waiting for a reply the original may never
        // have asked for.
        summary: `Not sent. The same text went to ${to} within the last half minute, so this copy was dropped; the earlier one stands. Carry on; if you need something different said, say it differently.`,
      }
    case 'refused:queue_full':
      return {
        to,
        delivery: 'not_delivered',
        outcome: 'peer_queue_full',
        summary: `Not delivered. Too many messages are already waiting to be handed to ${to}. Wait until those have gone through, then send again.`,
      }
    case 'refused:wake_failed':
      return {
        to,
        delivery: 'not_delivered',
        outcome: 'peer_did_not_start',
        summary: `Not delivered. ${to} did not finish starting, so nothing reached it. Check the peer list before trying again.`,
      }
    // Deliberately NOT worded as a wake failure. The peer was already running:
    // saying it could not be started would send the model looking for a session
    // that is sitting right there. What is actually known is narrower than the
    // old wording claimed: `forwarded()` answering false means the socket
    // refused the frame, so the row was ready and nothing else about what that
    // peer is doing is established.
    case 'refused:delivery_failed':
      return {
        to,
        delivery: 'not_delivered',
        outcome: 'peer_did_not_take_it',
        summary: `Not delivered. ${to} is open but did not take the message just now. Nothing reached it. You can try once more later or carry on without it.`,
      }
    // Only main can tell this apart from an ordinary send, and only because the
    // send carried the remembered creator id (F17, ruling 11). The sentence says
    // the creator is gone and stops there: offering to write to the session that
    // holds the name now would be the silent redirect the ruling forbids, and
    // that session knows nothing about this one's work.
    case 'refused:creator_reissued':
      return {
        to,
        delivery: 'not_delivered',
        outcome: 'creator_reissued',
        summary: `Not delivered. The session called ${to} that created you is gone, and a different session has that name now. Nothing was sent to it. Carry on without it, or tell the user what you were going to ask.`,
      }
  }
}

/**
 * A typed request-plane failure, rendered the same way: what happened, and what
 * to do about it. Nothing here is thrown, so a refusal never reaches the model
 * as a tool error it might read as a bug in its own call.
 */
function describeError(
  to: string,
  error: HostRequestError,
  /** True when `to` named this session's own creator: see `creatorIdFor`. */
  addressingCreator: boolean,
): SendToPeerResult {
  switch (error.code) {
    case 'session_not_found':
      // Two different facts behind one wire code, and the sender can tell them
      // apart because it knows who created it. A name that resolves to nothing
      // when it is the CREATOR's name means the creator's row is gone entirely
      // (F17, ruling 11): the roster cannot help, so the sentence does not send
      // the model there, and it needs no wire reason of its own.
      if (addressingCreator) {
        return {
          to,
          delivery: 'not_delivered',
          outcome: 'no_such_peer',
          summary: `Not delivered. ${to} created you and that session is gone now. Carry on without it, or tell the user what you were going to ask.`,
        }
      }
      return {
        to,
        delivery: 'not_delivered',
        outcome: 'no_such_peer',
        summary: `Not delivered. There is no peer called ${to} here. Use ListPeers for the names.`,
      }
    case 'too_large':
      return {
        to,
        delivery: 'not_delivered',
        outcome: 'text_too_large',
        summary: `Not sent. The message is bigger than one message can carry. Send a shorter one, or split it in two.`,
      }
    // A DIFFERENT limit from `refused:rate` above, and an order of magnitude
    // apart in how long to wait, so the sentence is borrowed from the plane
    // rather than written twice: one wording for this allowance everywhere it
    // is refused, whichever peer tool asked.
    case 'rate_limited':
      return {
        to,
        delivery: 'not_delivered',
        outcome: 'too_many_messages',
        summary: `Not delivered. ${describeHostRequestError(error)}`,
      }
    // The ONE unconfirmed case. The request timed out at
    // `HOST_REQUEST_TIMEOUT_MS` while main may still be waking the peer and
    // holding this message for delivery once it reports `ready`, so delivery is
    // unknown, not disproven, and `ListPeers` cannot say whether this message
    // arrived.
    case 'timeout':
      return {
        to,
        delivery: 'unconfirmed',
        outcome: 'send_failed',
        summary: `Not confirmed. The app did not answer in time, so it is not known whether this reached ${to}; it may still arrive when ${to} is running. If it matters, ask ${to} whether it got it, rather than sending the same text again.`,
      }
    default:
      // Everything else borrows the plane's own one-sentence wording, with the
      // delivery fact in front of it: the model's next decision turns on
      // "did they get it", not on which code came back.
      return {
        to,
        delivery: 'not_delivered',
        outcome: 'send_failed',
        summary: `Not delivered. ${describeHostRequestError(error)}`,
      }
  }
}

/** The same normalisation main resolves a name under (`peerRequestPlane.ts`). */
function nameKey(value: string): string {
  return value.trim().toLowerCase()
}

/**
 * The creator id to send with this message, or null to send none (F17, ruling 11
 * of 2026-09-06).
 *
 * It rides ONLY a message addressed to this session's own creator, by the same
 * case-insensitive name match main resolves under, so every other send crosses
 * the plane exactly as it did before. The model neither sees this id nor can
 * supply one: it comes from the spawn env, which only main writes.
 */
function creatorIdFor(to: string, identity: PeerIdentity): string | null {
  const { createdByName, createdById } = identity
  if (createdByName === null || createdById === null) return null
  return nameKey(to) === nameKey(createdByName) ? createdById : null
}

export function createSendToPeerTool(
  requestHost: PeerHostRequester = requestPeerHost,
  identity: PeerIdentity = readPeerIdentity(),
) {
  return buildTool({
    name: SEND_TO_PEER_TOOL_NAME,
    searchHint: 'message a peer session in this workspace by name',
    maxResultSizeChars: 10_000,

    get inputSchema(): InputSchema {
      return inputSchema()
    },

    userFacingName() {
      return SEND_TO_PEER_TOOL_NAME
    },

    isReadOnly() {
      return false
    },

    isConcurrencySafe() {
      return false
    },

    /**
     * §4 — the classifier projection is OWED, not optional. It is what makes
     * this tool VISIBLE to the auto-mode classifier, and nothing more: a tool
     * that projects nothing encodes to `''`, which the classifier reads as "no
     * security relevance" and permits WITHOUT evaluating it at all
     * (`src/Tool.ts:764` documents the contract, `:777` is the default, and
     * `src/utils/permissions/yoloClassifier.ts:1228-1232` is the short circuit).
     * The whole body is projected because the body is the action: a message that
     * relays an instruction the sender was denied is exactly what R6's
     * permission-laundering rule exists to catch.
     *
     * OUTSIDE auto mode there is no gate on this tool at all: it declares no
     * `checkPermissions`, and the engine's default for a tool that declares none
     * is to allow (`src/Tool.ts:772`). That is the same effect `AgentTool`
     * reaches deliberately, by auto-approving in every mode but auto
     * (`src/tools/AgentTool/AgentTool.tsx:2258-2273`).
     *
     * `request` is the only kind in v1 (the `notify` kind was designed and cut,
     * §0a); it is projected all the same so the classifier sees the same shape
     * if a second kind ever returns.
     */
    toAutoClassifierInput(input: Input) {
      return `request to ${input.to}: ${input.text}`
    },

    async description() {
      return 'Send a message to a peer in this workspace'
    },

    async prompt() {
      return [
        'Message a peer in this workspace, by name.',
        '',
        'You already have the name when you are answering a message or writing to',
        'the peer that created you. For any other name, use ListPeers first: a',
        'name you remember from earlier may now belong to a different peer.',
        '',
        'Every message costs that peer a turn. If it is working it reads',
        'yours at its next step, if it is idle it starts a turn, and if it is not',
        'open it is started, which holds up your own turn for up to half a minute',
        'while that happens. So send one when it would change what you or they do',
        'next: you need something only they know, you finished something they are',
        'waiting on, or you are about to touch something they are working on. Say',
        'what you need clearly; a follow-up question is fine, and a message costs',
        'the recipient a turn, so do not send several where one would do.',
        '',
        'Peers are reached only here; SendMessage reaches subagents you started',
        'and, with Agent Teams on, teammates, never a peer.',
        '',
        'The result says what actually happened. If it says the message was not',
        'delivered, it was not delivered: do not carry on as if they have it.',
      ].join('\n')
    },

    async call(input: Input) {
      const to = input.to.trim()
      // Measured in UTF-8 bytes, matching the bound main enforces, and refused
      // with a result rather than truncated: a silently shortened message is the
      // false belief §7 exists to prevent.
      if (Buffer.byteLength(input.text, 'utf8') > MAX_PEER_TEXT_BYTES) {
        return {
          data: {
            to,
            delivery: 'not_delivered',
            outcome: 'text_too_large' as const,
            summary: `Not sent. The message is bigger than one message can carry. Send a shorter one, or split it in two.`,
          },
        }
      }

      const expectCreatorId = creatorIdFor(to, identity)
      const answer = await requestHost('peer.deliver', {
        to,
        text: input.text,
        ...(expectCreatorId !== null ? { expectCreatorId } : {}),
      })
      if (!answer.ok) {
        return { data: describeError(to, answer.error, expectCreatorId !== null) }
      }
      // Checked, not trusted: see `DELIVER_OUTCOMES`. An outcome outside the
      // closed list is reported as an unconfirmed send, never as a delivery,
      // and never as a non-delivery either: nothing here knows which it was.
      const outcome = DELIVER_OUTCOMES.get(String(answer.value.outcome))
      if (outcome === undefined) {
        return {
          data: {
            to,
            delivery: 'unconfirmed' as const,
            outcome: 'send_failed' as const,
            summary: `Not confirmed. The app did not say what happened to this message, so it is not known whether it reached ${to}.`,
          },
        }
      }
      return { data: describeOutcome(to, outcome) }
    },

    mapToolResultToToolResultBlockParam(data, toolUseID) {
      return {
        tool_use_id: toolUseID,
        type: 'tool_result',
        content: jsonStringify(data),
      }
    },

    renderToolUseMessage() {
      return null
    },
  } satisfies ToolDef<InputSchema, SendToPeerResult>)
}
