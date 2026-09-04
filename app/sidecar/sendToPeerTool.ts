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
  requestPeerHost,
  type PeerHostRequester,
} from './peerHostRequester.js'

export const SEND_TO_PEER_TOOL_NAME = 'SendToPeer'

const inputSchema = lazySchema(() =>
  z.strictObject({
    to: z
      .string()
      .min(1)
      .describe('Name of the session to message. Use ListPeers for the names.'),
    text: z
      .string()
      .min(1)
      .describe('What to say. Say everything you need in this one message.'),
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
  | 'text_too_large'
  | 'send_failed'

export type SendToPeerResult = {
  to: string
  delivered: boolean
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
        delivered: true,
        outcome: 'delivered',
        summary: `Delivered to ${to}. It is already working, so it reads this at its next step.`,
      }
    case 'queued_wake':
      return {
        to,
        delivered: true,
        outcome: 'delivered_on_start',
        summary: `Delivered to ${to}. It was not open, so it is starting up and reads this once it is running.`,
      }
    case 'refused:user_stopped':
      return {
        to,
        delivered: false,
        outcome: 'blocked_by_user',
        summary: `Not delivered. ${to} is closed and the user has turned off reopening it. Ask the user to open it, or carry on without it.`,
      }
    case 'refused:hop_loop':
      return {
        to,
        delivered: false,
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
        delivered: false,
        outcome: 'chain_too_long',
        summary: `Not delivered. The back and forth with ${to} has run too long. Finish the work yourself, or write the user what is still open.`,
      }
    case 'refused:rate':
      return {
        to,
        delivered: false,
        outcome: 'too_many_messages',
        // Seconds, not the minute the session-wide allowance is counted over:
        // this bucket is per recipient and refills continuously, so the two
        // refusals must not offer the same advice.
        summary: `Not delivered. Too many messages to ${to} in a short time. Wait a few seconds, then send one message that covers everything.`,
      }
    case 'refused:duplicate':
      return {
        to,
        delivered: false,
        outcome: 'already_sent',
        summary: `Not delivered. The same text went to ${to} a moment ago, so it already has it. Wait for a reply instead of sending again.`,
      }
    case 'refused:queue_full':
      return {
        to,
        delivered: false,
        outcome: 'peer_queue_full',
        summary: `Not delivered. Too many messages are already waiting to be handed to ${to}. Wait until those have gone through, then send again.`,
      }
    case 'refused:wake_failed':
      return {
        to,
        delivered: false,
        outcome: 'peer_did_not_start',
        summary: `Not delivered. ${to} did not finish starting, so nothing reached it. Check the peer list before trying again.`,
      }
    // Deliberately NOT worded as a wake failure. The peer was already running:
    // saying it could not be started would send the model looking for a session
    // that is sitting right there, and it would stop waiting on work that peer
    // may still be doing.
    case 'refused:delivery_failed':
      return {
        to,
        delivered: false,
        outcome: 'peer_did_not_take_it',
        summary: `Not delivered. ${to} is running but did not take the message. It is still working, so wait and send again rather than treating it as gone.`,
      }
  }
}

/**
 * A typed request-plane failure, rendered the same way: what happened, and what
 * to do about it. Nothing here is thrown, so a refusal never reaches the model
 * as a tool error it might read as a bug in its own call.
 */
function describeError(to: string, error: HostRequestError): SendToPeerResult {
  switch (error.code) {
    case 'session_not_found':
      return {
        to,
        delivered: false,
        outcome: 'no_such_peer',
        summary: `Not delivered. No session named ${to} exists in this workspace. Use ListPeers for the current names.`,
      }
    case 'too_large':
      return {
        to,
        delivered: false,
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
        delivered: false,
        outcome: 'too_many_messages',
        summary: `Not delivered. ${describeHostRequestError(error)}`,
      }
    case 'timeout':
      return {
        to,
        delivered: false,
        outcome: 'send_failed',
        summary: `Not confirmed. The message was not acknowledged in time, so treat it as not delivered. Check the peer list before sending again.`,
      }
    default:
      // Everything else borrows the plane's own one-sentence wording, with the
      // delivery fact in front of it: the model's next decision turns on
      // "did they get it", not on which code came back.
      return {
        to,
        delivered: false,
        outcome: 'send_failed',
        summary: `Not delivered. ${describeHostRequestError(error)}`,
      }
  }
}

export function createSendToPeerTool(
  requestHost: PeerHostRequester = requestPeerHost,
) {
  return buildTool({
    name: SEND_TO_PEER_TOOL_NAME,
    searchHint: 'message another named session in this workspace',
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
      return 'Send a message to another session working in this workspace'
    },

    async prompt() {
      return [
        'Send a message to another session in this workspace, by name.',
        '',
        'You already have the name when you are answering a message or writing to',
        'the session that created you. For any other name, use ListPeers first: a',
        'name you remember from earlier may now belong to a different session.',
        '',
        'Every message costs the other session a turn. If it is working it reads',
        'yours at its next step, if it is idle it starts a turn, and if it is not',
        'open it is started, which holds up your own turn for up to half a minute',
        'while that happens. So send one when it would change what you or they do',
        'next: you need something only they know, you finished something they are',
        'waiting on, or you are about to touch something they are working on. Say',
        'everything you need in one message.',
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
            delivered: false,
            outcome: 'text_too_large' as const,
            summary: `Not sent. The message is bigger than one message can carry. Send a shorter one, or split it in two.`,
          },
        }
      }

      const answer = await requestHost('peer.deliver', { to, text: input.text })
      if (!answer.ok) {
        return { data: describeError(to, answer.error) }
      }
      // Checked, not trusted: see `DELIVER_OUTCOMES`. An outcome outside the
      // closed list is reported as an unconfirmed send, never as a delivery.
      const outcome = DELIVER_OUTCOMES.get(String(answer.value.outcome))
      if (outcome === undefined) {
        return {
          data: {
            to,
            delivered: false,
            outcome: 'send_failed' as const,
            summary: `Not confirmed. The app did not say what happened to this message, so treat it as not delivered.`,
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
