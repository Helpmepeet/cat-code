/**
 * `CreatePeer` — PEER-SESSIONS §4, R7, R8.
 *
 * Creates an ordinary session in this workspace and gives it a first
 * instruction. Everything that makes it a peer rather than a child is main's
 * (name allocation, the spawn, the untagged opening prompt); this tool supplies
 * the prompt and the two run defaults, and reports what happened plainly enough
 * that the model never believes a peer got a message it did not get.
 *
 * Model and effort DEFAULT to the creator's own current values (R7), read from
 * the live session state rather than from anything captured at spawn: a `/model`
 * or `/effort` change during the session moves them, and a peer created after
 * that change must follow it. Permission mode is neither an argument nor
 * inherited (§0a): the new session starts at the settings default like any new
 * tab, and the user sets it there.
 */

// By path, not by package name: `app/node_modules/zod` shadows the engine's own
// copy for every module under `app/`, and two copies whose version strings
// differ are two type identities, which makes `tsc` exhaust its heap rather
// than report an error. See the same note in `listPeersTool.ts` for the full
// reason.
import { z } from '../../node_modules/zod/v4'
import { buildTool, type ToolDef, type ToolUseContext } from '../../src/Tool.js'
import { lazySchema } from '../../src/utils/lazySchema.js'
import { EFFORT_LEVELS, type EffortLevel } from '../../src/utils/effort.js'
import { getMainLoopModel } from '../../src/utils/model/model.js'
import { MAX_PEER_TEXT_BYTES } from '../shared/limits.js'
import {
  describeHostRequestError,
  readPeerIdentity,
  requestPeerHost,
  type PeerHostRequester,
} from './peerHostRequester.js'

export const CREATE_PEER_TOOL_NAME = 'CreatePeer'

const inputSchema = lazySchema(() =>
  z.strictObject({
    prompt: z
      .string()
      .min(1)
      .describe('The first instruction the new session receives'),
    model: z
      .string()
      .optional()
      // Nothing validates this id, at any layer, and that is deliberate: the
      // engine passes unrecognised ids through so a new model works the day it
      // ships. The cost lands on the caller, which is told the session started
      // and only later finds it dead, so the description carries the warning the
      // absent check cannot.
      .describe(
        'Model for the new session. Defaults to the one you are on. The id is not checked, and a wrong one means the new session fails on its first turn, so leave it out unless you are sure of the id',
      ),
    effort: z
      .string()
      .optional()
      // Same shape, softer failure: an unrecognised level is accepted here and
      // at main, then dropped at the child in favour of the user's saved setting
      // (`readSpawnEffort` in `sessionController.ts`).
      .describe(
        'Reasoning effort for the new session. Defaults to the one you are on. A level that is not recognised is ignored, and the new session runs at whatever the user has set',
      ),
  }),
)

type InputSchema = ReturnType<typeof inputSchema>
type Input = z.infer<InputSchema>

export type CreatePeerOutput =
  | { ok: true; name: string; failedStep?: 'ready' | 'prompt' }
  | { ok: false; message: string }

/**
 * The creator's own reasoning effort, as a value the child can boot on.
 *
 * `effortValue` is `EffortLevel | number`, and a numeric value is a
 * model-specific token budget (`src/utils/effort.ts` `reconcileEffortForModel`).
 * A peer may be created on a different model, where such a budget means nothing
 * and would be dropped anyway, so only the named levels are inherited and a
 * numeric one leaves the new session on the user's saved default.
 */
export function inheritedEffort(value: unknown): EffortLevel | undefined {
  return EFFORT_LEVELS.find(level => level === value)
}

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, 'utf8')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The failed steps `peer.create` can report, closed here as well as at main. */
const FAILED_STEPS: readonly ('ready' | 'prompt')[] = ['ready', 'prompt']

/**
 * Narrow one `peer.create` answer, or reject it.
 *
 * The name is the whole point of the result: it is how the caller addresses the
 * new session afterwards, and how the operator recognises the tab. So an answer
 * without a readable name is rejected outright rather than reported as a success
 * nobody can act on. An unrecognised `failedStep` is dropped instead of being
 * passed through, which is the safe direction: the caller is told the prompt
 * landed only when nothing said otherwise, and the session list is the check the
 * result already points at.
 */
export function narrowCreatedPeer(
  value: unknown,
): { name: string; failedStep?: 'ready' | 'prompt' } | null {
  if (!isRecord(value)) return null
  const { name, failedStep } = value
  if (typeof name !== 'string' || name === '') return null
  const known = FAILED_STEPS.find(candidate => candidate === failedStep)
  return { name, ...(known !== undefined ? { failedStep: known } : {}) }
}

export function createCreatePeerTool(
  requestHost: PeerHostRequester = requestPeerHost,
  /** This session's own name, used only to write the return channel example. */
  selfName: string | null = readPeerIdentity().name,
) {
  const returnChannelExample =
    selfName === null
      ? 'when finished, send a message back to the session that created you, saying what changed'
      : `when finished, send ${selfName} a message saying what changed`

  return buildTool({
    name: CREATE_PEER_TOOL_NAME,
    searchHint: 'start another session in this workspace',
    maxResultSizeChars: 10_000,
    userFacingName: () => CREATE_PEER_TOOL_NAME,
    get inputSchema(): InputSchema {
      return inputSchema()
    },
    isReadOnly() {
      return false
    },
    /**
     * What makes this tool VISIBLE to the auto-mode classifier, and nothing
     * more. A tool left on the default `''` is read as having no security
     * relevance and permitted without evaluation (`src/Tool.ts:764`,
     * `src/utils/permissions/yoloClassifier.ts` around the empty-action guard),
     * so the whole prompt is projected here, along with any model or effort the
     * caller named.
     *
     * OUTSIDE auto mode there is no gate on this tool at all: it declares no
     * `checkPermissions`, and the engine's default for a tool that declares none
     * is to allow (`src/Tool.ts:772`). That is the same effect `AgentTool`
     * reaches deliberately, by auto-approving in every mode but auto
     * (`src/tools/AgentTool/AgentTool.tsx:2258-2273`), so it is the intended
     * shape rather than a missing check.
     */
    toAutoClassifierInput(input: Input) {
      return {
        prompt: input.prompt,
        ...(input.model !== undefined ? { model: input.model } : {}),
        ...(input.effort !== undefined ? { effort: input.effort } : {}),
      }
    },
    async description() {
      return 'Start another session in this workspace and give it a first instruction'
    },
    async prompt() {
      return [
        'Start another session in this workspace and give it a first instruction. It becomes a peer, not a worker of yours: it has its own tab, its own transcript and its own permissions, and the user can see it and talk to it.',
        '',
        // The ask-for-a-report line LEADS, and is a sentence of its own. As the
        // fourth item of a four-item list it read as one more thing a careful
        // instruction states, and a session that left it out then sat reading
        // its peer in a loop waiting for an answer nobody had asked for.
        'The instruction has to ask for a report, or you never hear back: ' +
          returnChannelExample +
          '. Then wait for that message instead of watching the session. Say the rest plainly too: the goal, what done looks like, the files in scope.',
        '',
        'The new session starts on your model and reasoning effort unless you name others. It starts with the permission setting the user chose as their default, not yours, so it may stop and ask the user about work you take for granted.',
        '',
        'Each call waits for the new session to start and take your instruction, which can hold up your own turn for the better part of a minute. Creating several in a row costs that each time.',
        '',
        'Create a session only when the user or your instructions ask for one. Never on your own judgment.',
      ].join('\n')
    },
    async call(
      input: Input,
      context: ToolUseContext,
    ): Promise<{ data: CreatePeerOutput }> {
      if (utf8Bytes(input.prompt) > MAX_PEER_TEXT_BYTES) {
        return {
          data: {
            ok: false,
            message:
              'That instruction is too long to send. Shorten it and try again.',
          },
        }
      }

      // R7 — the creator's CURRENT values, from the same places the composer's
      // own model and effort controls read: the model resolver the query engine
      // uses per turn, and the live session state the engine reads per request.
      // Not a value captured when this process started.
      const model = input.model ?? getMainLoopModel()
      const effort =
        input.effort ?? inheritedEffort(context.getAppState().effortValue)

      const outcome = await requestHost('peer.create', {
        prompt: input.prompt,
        ...(model !== undefined ? { model } : {}),
        ...(effort !== undefined ? { effort } : {}),
      })
      if (!outcome.ok) {
        // F8 — `timeout` means nobody answered, which for a MUTATION is not the
        // same fact as nothing happening: the app bounds its own call to the
        // host, this sidecar bounds its wait for the app, and the create carries
        // on past both. The shared sentence for this code says only that the app
        // did not answer in time, and a model reads that as a failed call and
        // answers it by calling again, which is how one instruction becomes two
        // sessions. The new session is named and visible from the moment it
        // exists, so looking is the recovery that is right whichever way it went.
        if (outcome.error.code === 'timeout') {
          return {
            data: {
              ok: false,
              message:
                'The app did not answer in time, so it is not clear whether a session was started. Look at the session list before creating another one.',
            },
          }
        }
        return {
          data: { ok: false, message: describeHostRequestError(outcome.error) },
        }
      }
      // Read back through `unknown` and narrowed a SECOND time, after the
      // boundary's own per-verb schema check. The local check stays because the
      // name is what the caller addresses the new session by afterwards, and a
      // value that becomes an address is worth confirming where it is used: a
      // creation whose answer cannot be read must NOT report a peer that may not
      // exist, and must not claim the prompt landed.
      const value: unknown = outcome.value
      const created = narrowCreatedPeer(value)
      if (created === null) {
        return {
          data: {
            ok: false,
            message:
              'The answer to that request came back unreadable, so it is not clear whether a session was started. Check the session list before trying again.',
          },
        }
      }
      return { data: { ok: true, ...created } }
    },
    mapToolResultToToolResultBlockParam(data: CreatePeerOutput, toolUseID) {
      if (!data.ok) {
        return {
          tool_use_id: toolUseID,
          type: 'tool_result',
          content: data.message,
          is_error: true,
        }
      }
      // The row is KEPT when a later step fails, so this must never read as a
      // failure to create: the session exists and the user can see it. What the
      // caller has to know is that the instruction did not arrive, so it can
      // send it itself (HOST-REQUEST-PLANE §2).
      if (data.failedStep === 'ready') {
        return {
          tool_use_id: toolUseID,
          type: 'tool_result',
          content: `Created the session ${data.name}, but it did not finish starting in time, so it does not have your instruction. Check whether it is running, then send it the instruction with SendToPeer.`,
        }
      }
      if (data.failedStep === 'prompt') {
        return {
          tool_use_id: toolUseID,
          type: 'tool_result',
          content: `Created the session ${data.name}, but your instruction did not reach it. Send it the instruction with SendToPeer.`,
        }
      }
      return {
        tool_use_id: toolUseID,
        type: 'tool_result',
        content: `Created the session ${data.name} and sent it your instruction. It answers you by messaging you back, not by returning a result here.`,
      }
    },
    renderToolUseMessage() {
      return null
    },
  } satisfies ToolDef<InputSchema, CreatePeerOutput>)
}
