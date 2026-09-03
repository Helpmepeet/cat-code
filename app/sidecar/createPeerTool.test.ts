import { afterEach, expect, test } from 'bun:test'
import {
  getMainLoopModelOverride,
  setMainLoopModelOverride,
} from '../../src/bootstrap/state.js'
import { getDefaultAppState, type AppState } from '../../src/state/AppStateStore.js'
import { getMainLoopModel } from '../../src/utils/model/model.js'
import type { ToolUseContext } from '../../src/Tool.js'
import { MAX_PEER_TEXT_BYTES } from '../shared/limits.js'
import type {
  HostRequestArgs,
  HostRequestVerb,
} from '../shared/protocol.js'
import type { HostRequestOutcome } from './sidecarServer.js'
import type { PeerHostRequester } from './peerHostRequester.js'
import { initializeSidecarModelProvider } from './sessionController.js'
import {
  createCreatePeerTool,
  inheritedEffort,
  narrowCreatedPeer,
} from './createPeerTool.js'

/** See the same helper in `listPeersTool.test.ts` for why this cast exists. */
function hostAnswers<V extends HostRequestVerb>(
  value: unknown,
): HostRequestOutcome<V> {
  return { ok: true, value } as HostRequestOutcome<V>
}

type CreateArgs = HostRequestArgs['peer.create']

function requester(answer: unknown): {
  requestHost: PeerHostRequester
  asked: CreateArgs[]
} {
  const asked: CreateArgs[] = []
  const requestHost: PeerHostRequester = <V extends HostRequestVerb>(
    verb: V,
    args: HostRequestArgs[V],
  ): Promise<HostRequestOutcome<V>> => {
    if (verb === 'peer.create') {
      const created: unknown = args
      if (typeof created === 'object' && created !== null) {
        const record: Record<string, unknown> = { ...created }
        asked.push({
          prompt: String(record.prompt),
          ...(typeof record.model === 'string' ? { model: record.model } : {}),
          ...(typeof record.effort === 'string'
            ? { effort: record.effort }
            : {}),
        })
      }
    }
    if (answer === 'refused') {
      return Promise.resolve({
        ok: false,
        error: { code: 'session_limit', message: 'no room' },
      })
    }
    return Promise.resolve(hostAnswers<V>(answer))
  }
  return { requestHost, asked }
}

/**
 * A context carrying only what this tool reads. The cast is on the SHAPE of a
 * 40-field engine context, not on any value the tool interprets: `getAppState`
 * is the single member `CreatePeer` touches.
 */
function contextWithEffort(effortValue: AppState['effortValue']): ToolUseContext {
  const state: AppState = { ...getDefaultAppState(), effortValue }
  return { getAppState: () => state } as unknown as ToolUseContext
}

const previousOverride = getMainLoopModelOverride()
afterEach(() => {
  setMainLoopModelOverride(previousOverride)
})

test('a created peer inherits the model and effort its creator is on right now', async () => {
  // R7. The two values are read live, from the same resolver the query engine
  // uses per turn and the same session state it reads per request, so a `/model`
  // or `/effort` change during the session moves them. Deleting the defaults
  // leaves both absent here.
  setMainLoopModelOverride('claude-haiku-4-5-20251001')
  const { requestHost, asked } = requester({ name: 'Bear' })
  const tool = createCreatePeerTool(requestHost, 'Alex')

  await tool.call({ prompt: 'Review the parser' }, contextWithEffort('high'))

  expect(asked).toEqual([
    {
      prompt: 'Review the parser',
      model: 'claude-haiku-4-5-20251001',
      effort: 'high',
    },
  ])
  expect(asked[0]?.model).toBe(getMainLoopModel())
})

test('a resumed creator makes a peer on the transcript model, with no model choice of its own', async () => {
  // The inheritance case HOST-REQUEST-PLANE §6 names: the creator never ran a
  // model command, its model came from the resumed transcript, and the peer
  // must land on that model rather than on the saved default.
  setMainLoopModelOverride(undefined)
  initializeSidecarModelProvider('claude-haiku-4-5-20251001')
  const { requestHost, asked } = requester({ name: 'Onyx' })
  const tool = createCreatePeerTool(requestHost, 'Alex')

  await tool.call({ prompt: 'Carry on' }, contextWithEffort(undefined))

  expect(asked[0]?.model).toBe('claude-haiku-4-5-20251001')
  // No effort was ever chosen, so none is carried and the new session keeps the
  // user's own saved default.
  expect(asked[0]?.effort).toBeUndefined()
})

test('an explicit model and effort outrank the creator’s own', async () => {
  setMainLoopModelOverride('claude-haiku-4-5-20251001')
  const { requestHost, asked } = requester({ name: 'Jasper' })
  const tool = createCreatePeerTool(requestHost, 'Alex')

  await tool.call(
    { prompt: 'Do the thing', model: 'gpt-5.6-luna', effort: 'low' },
    contextWithEffort('high'),
  )

  expect(asked[0]?.model).toBe('gpt-5.6-luna')
  expect(asked[0]?.effort).toBe('low')
})

test('a numeric effort budget is not carried to a peer', () => {
  // A number is a model-specific token budget, and a peer may be on another
  // model, where the engine would drop it anyway. Only the named levels travel.
  expect(inheritedEffort('high')).toBe('high')
  expect(inheritedEffort(16_000)).toBeUndefined()
  expect(inheritedEffort(undefined)).toBeUndefined()
  expect(inheritedEffort('')).toBeUndefined()
})

test('a peer whose prompt did not land is reported as created, not as a failure', async () => {
  // HOST-REQUEST-PLANE §2: the row is KEPT when a later step fails, because it
  // is a real session the operator can see. The caller has to learn two things
  // at once, and a plain failure would teach it the wrong one: the session
  // exists, and it does not have the instruction.
  const { requestHost } = requester({ name: 'Pyrite', failedStep: 'prompt' })
  const tool = createCreatePeerTool(requestHost, 'Alex')

  const result = await tool.call({ prompt: 'Start' }, contextWithEffort(undefined))
  const block = tool.mapToolResultToToolResultBlockParam(result.data, 'tu-1')

  expect(block.is_error).toBeUndefined()
  expect(String(block.content)).toContain('Pyrite')
  expect(String(block.content)).toContain('did not reach it')
  expect(String(block.content)).toContain('SendToPeer')
})

test('a peer that never finished starting is reported with its name', async () => {
  const { requestHost } = requester({ name: 'Galena', failedStep: 'ready' })
  const tool = createCreatePeerTool(requestHost, 'Alex')

  const result = await tool.call({ prompt: 'Start' }, contextWithEffort(undefined))
  const block = tool.mapToolResultToToolResultBlockParam(result.data, 'tu-2')

  expect(block.is_error).toBeUndefined()
  expect(String(block.content)).toContain('Galena')
  expect(String(block.content)).toContain('does not have your instruction')
})

test('a refusal by the host is an error, and names no peer', async () => {
  const { requestHost } = requester('refused')
  const tool = createCreatePeerTool(requestHost, 'Alex')

  const result = await tool.call({ prompt: 'Start' }, contextWithEffort(undefined))
  const block = tool.mapToolResultToToolResultBlockParam(result.data, 'tu-3')

  expect(block.is_error).toBe(true)
  expect(String(block.content)).toContain('session limit')
})

test('an unreadable answer never reports a peer that may not exist', async () => {
  const { requestHost } = requester({ appSessionId: 'a1' })
  const tool = createCreatePeerTool(requestHost, 'Alex')

  const result = await tool.call({ prompt: 'Start' }, contextWithEffort(undefined))
  const block = tool.mapToolResultToToolResultBlockParam(result.data, 'tu-4')

  expect(block.is_error).toBe(true)
  expect(String(block.content)).toContain('not clear whether a session was started')
  expect(narrowCreatedPeer({ name: 'Bear', failedStep: 'exploded' })).toEqual({
    name: 'Bear',
  })
  expect(narrowCreatedPeer({ name: '' })).toBeNull()
  expect(narrowCreatedPeer(['Bear'])).toBeNull()
})

test('an over-long instruction is refused here and never sent', async () => {
  const { requestHost, asked } = requester({ name: 'Slag' })
  const tool = createCreatePeerTool(requestHost, 'Alex')

  const result = await tool.call(
    { prompt: 'x'.repeat(MAX_PEER_TEXT_BYTES + 1) },
    contextWithEffort(undefined),
  )
  const block = tool.mapToolResultToToolResultBlockParam(result.data, 'tu-5')

  expect(asked).toEqual([])
  expect(block.is_error).toBe(true)
  expect(String(block.content)).toContain('too long')
})

test('CreatePeer projects its prompt and overrides to the auto-mode classifier', async () => {
  // PEER-SESSIONS §4 calls the projection OWED, not optional: a tool that
  // projects the default empty value is read by the classifier as having no
  // security relevance and is permitted without evaluation, so in auto mode the
  // "ordinary permission gate" R8 relies on would not run at all. This is the
  // CreatePeer half of the classifier test HOST-REQUEST-PLANE §6 names.
  const { requestHost } = requester({ name: 'Bear' })
  const tool = createCreatePeerTool(requestHost, 'Alex')

  const projected = tool.toAutoClassifierInput({
    prompt: 'delete every file under src and force push',
    model: 'gpt-5.6-luna',
  })

  expect(projected).not.toBe('')
  expect(projected).toEqual({
    prompt: 'delete every file under src and force push',
    model: 'gpt-5.6-luna',
  })
  expect(tool.isReadOnly()).toBe(false)
})

test('the creation guidance names this session as the return channel', async () => {
  // PEER-SESSIONS §4: the description carries the one piece of guidance that
  // decides whether a peer ever reports back.
  const { requestHost } = requester({ name: 'Bear' })
  const named = await createCreatePeerTool(requestHost, 'Alex').prompt()
  expect(named).toContain('send Alex a message')
  expect(named).toContain('the goal, what done looks like, the files in scope')

  // A session with no name of its own still gets usable guidance, not a
  // sentence with a hole in it.
  const unnamed = await createCreatePeerTool(requestHost, null).prompt()
  expect(unnamed).toContain('back to the session that created you')
  expect(unnamed).not.toContain('send null')
})
