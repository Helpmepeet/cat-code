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
    if (answer === 'unanswered') {
      return Promise.resolve({
        ok: false,
        error: { code: 'timeout', message: 'no answer in time' },
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
  const tool = createCreatePeerTool(requestHost)

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
  const tool = createCreatePeerTool(requestHost)

  await tool.call({ prompt: 'Carry on' }, contextWithEffort(undefined))

  expect(asked[0]?.model).toBe('claude-haiku-4-5-20251001')
  // No effort was ever chosen, so none is carried and the new session keeps the
  // user's own saved default.
  expect(asked[0]?.effort).toBeUndefined()
})

test('an explicit model and effort outrank the creator’s own', async () => {
  setMainLoopModelOverride('claude-haiku-4-5-20251001')
  const { requestHost, asked } = requester({ name: 'Jasper' })
  const tool = createCreatePeerTool(requestHost)

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
  const tool = createCreatePeerTool(requestHost)

  const result = await tool.call({ prompt: 'Start' }, contextWithEffort(undefined))
  const block = tool.mapToolResultToToolResultBlockParam(result.data, 'tu-1')

  expect(block.is_error).toBeUndefined()
  expect(String(block.content)).toContain('Pyrite')
  expect(String(block.content)).toContain('did not reach it')
  expect(String(block.content)).toContain('SendToPeer')
})

test('a peer that never finished starting is reported with its name', async () => {
  const { requestHost } = requester({ name: 'Galena', failedStep: 'ready' })
  const tool = createCreatePeerTool(requestHost)

  const result = await tool.call({ prompt: 'Start' }, contextWithEffort(undefined))
  const block = tool.mapToolResultToToolResultBlockParam(result.data, 'tu-2')

  expect(block.is_error).toBeUndefined()
  expect(String(block.content)).toContain('Galena')
  expect(String(block.content)).toContain('does not have your instruction')
})

test('a refusal by the host is an error, and names no peer', async () => {
  const { requestHost } = requester('refused')
  const tool = createCreatePeerTool(requestHost)

  const result = await tool.call({ prompt: 'Start' }, contextWithEffort(undefined))
  const block = tool.mapToolResultToToolResultBlockParam(result.data, 'tu-3')

  expect(block.is_error).toBe(true)
  // One code, two opposite recoveries. The refusal a fan-out actually hits is
  // the spawn rate cap, which clears in seconds, so the sentence has to offer
  // retrying BEFORE it offers the reading that ends a plan. It must also not
  // point at one workspace: every cap behind this code is counted app-wide.
  const content = String(block.content)
  expect(content).toContain('Wait a few seconds and try again')
  expect(content).toContain('too many sessions are open')
  expect(content).not.toContain('workspace')
  expect(content.indexOf('Wait a few seconds')).toBeLessThan(
    content.indexOf('too many sessions are open'),
  )
})

test('F8 — a request that went unanswered sends the caller to the peer list, not back to CreatePeer', async () => {
  // Creating is a MUTATION, and no answer is not the same fact as no session:
  // both the app and this sidecar stop waiting on a clock, while the create they
  // asked for carries on. The generic sentence for this code says only that the
  // app did not answer in time, which a model reads as nothing having happened
  // and answers by asking again, which is how one instruction becomes two
  // sessions. So the one recovery that is safe whichever way it went is named
  // here, and creating again is not it.
  const { requestHost } = requester('unanswered')
  const tool = createCreatePeerTool(requestHost)

  const result = await tool.call({ prompt: 'Start' }, contextWithEffort(undefined))
  const block = tool.mapToolResultToToolResultBlockParam(result.data, 'tu-6')

  expect(block.is_error).toBe(true)
  const content = String(block.content)
  expect(content).toContain('not clear whether a peer was created')
  expect(content).toContain('peer list')
  expect(content).not.toContain('could not be started')
})

test('an unreadable answer never reports a peer that may not exist', async () => {
  const { requestHost } = requester({ appSessionId: 'a1' })
  const tool = createCreatePeerTool(requestHost)

  const result = await tool.call({ prompt: 'Start' }, contextWithEffort(undefined))
  const block = tool.mapToolResultToToolResultBlockParam(result.data, 'tu-4')

  expect(block.is_error).toBe(true)
  expect(String(block.content)).toContain('not clear whether a peer was created')
  expect(narrowCreatedPeer({ name: 'Bear', failedStep: 'exploded' })).toEqual({
    name: 'Bear',
  })
  expect(narrowCreatedPeer({ name: '' })).toBeNull()
  expect(narrowCreatedPeer(['Bear'])).toBeNull()
})

test('an over-long instruction is refused here and never sent', async () => {
  const { requestHost, asked } = requester({ name: 'Slag' })
  const tool = createCreatePeerTool(requestHost)

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
  const tool = createCreatePeerTool(requestHost)

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

test('the creation guidance says what to share and makes hearing back a choice', async () => {
  // PEER-SESSIONS §4: the description carries the guidance that decides what a
  // creator puts in the instruction, and whether it asks to hear back at all.
  const { requestHost } = requester({ name: 'Bear' })
  const prompt = await createCreatePeerTool(requestHost).prompt()

  // Share what the peer cannot get for itself, and stop there: no goal/done/
  // files checklist, because the peer has the workspace and its own judgment.
  expect(prompt).toContain(
    'share what you already know that would save it rediscovery',
  )
  expect(prompt).toContain('Leave the approach to it.')
  expect(prompt).not.toContain('the goal, what done looks like, the files in scope')

  // Reporting is asked for, not owed, and asking once is not a standing
  // arrangement (rulings 3 to 5).
  expect(prompt).toContain(
    'say you want to hear back and what; otherwise do not ask',
  )
  expect(prompt).toContain('Asking once does not set up a standing arrangement.')
  expect(prompt).not.toContain('has to ask for a report, or you never hear back')

  // A creator told to WAIT deferred the clarifying question its peer needed
  // answered, so the waiting posture is gone and the question is named.
  expect(prompt).toContain('answer promptly if it is waiting on you')
  expect(prompt).not.toContain('wait for that message instead of watching them work')

  // Activity is not completion (F20).
  expect(prompt).toContain(
    'ListPeers shows only whether it is active, never whether it has finished',
  )
})

test('the creation guidance says the call blocks, so a fan-out is a priced choice', async () => {
  // Main bounds the spawn at ten seconds and then waits up to thirty more for
  // the new session's ready before the instruction is delivered
  // (`app/main/peerRequestPlane.ts`), so one call can hold the caller's turn for
  // most of a minute. Nothing else on this tool says so, and a model planning
  // four creations was committing minutes of its own turn blind.
  const { requestHost } = requester({ name: 'Bear' })
  const prompt = await createCreatePeerTool(requestHost).prompt()

  expect(prompt).toContain('the better part of a minute')
  expect(prompt).toContain('Creating several in a row')
})

test('the model and effort fields say what an unrecognised value does', () => {
  // Neither value is validated anywhere: main's schema length-bounds them and
  // passes them into the spawn env. That is deliberate for the model (a new id
  // must work the day it ships), so the only place the caller can learn the two
  // failure shapes is here. They differ, and the difference decides what a
  // caller does: a wrong model kills the new session on its first turn, while an
  // unrecognised effort is dropped and the session simply runs at the user's
  // own setting.
  const shape = createCreatePeerTool(requester({ name: 'Bear' }).requestHost)
    .inputSchema.shape

  expect(shape.model.description).toContain('not checked')
  expect(shape.model.description).toContain('fails on its first turn')
  expect(shape.effort.description).toContain('not recognised is ignored')
  expect(shape.effort.description).toContain('whatever the user has set')
})
