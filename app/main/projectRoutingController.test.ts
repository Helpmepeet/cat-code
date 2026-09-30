import { expect, test } from 'bun:test'

import {
  ProjectRoutingController,
  type ProjectRoutingControllerOptions,
} from './projectRoutingController.js'
import type { ProjectRouteDecision } from '../shared/projectRouting.js'

const SESSION = '93ad8a93-bc68-4954-8c3e-92115798fcce'
const SUBMIT = '5b48eb57-5dc5-45ed-af3a-248863d962f2'
const SECOND_SUBMIT = '234d972d-aed9-4c24-9f15-326c2c54a817'

function submit(submitId = SUBMIT) {
  return {
    type: 'app.submit' as const,
    requestId: 'request-1',
    prompt: 'fix the issue',
    options: { submitId, isMeta: true },
  }
}

type FixtureOptions = {
  decision?: ProjectRouteDecision
  cwd?: string
  classify?: ProjectRoutingControllerOptions['classify']
  forward?: ProjectRoutingControllerOptions['forward']
  move?: ProjectRoutingControllerOptions['move']
}

function fixture(options: FixtureOptions = {}) {
  let cwd = options.cwd ?? '/workspace/chat'
  const calls: string[] = []
  const forwarded: unknown[] = []
  const refused: Array<[string, string]> = []
  const snapshots: Array<string | null> = []
  const classifyInputs: Array<[string, string, string[], string[]]> = []
  const controller = new ProjectRoutingController({
    eligible: () => true,
    currentCwd: () => cwd,
    classify: async (...args) => {
      classifyInputs.push(args)
      return options.classify === undefined
        ? options.decision ?? { kind: 'stay' }
        : options.classify(...args)
    },
    move: async (_sessionId, target) => {
      calls.push(`move:${target}`)
      cwd = target
      return { ok: true }
    },
    forward: (_sessionId, message) => {
      calls.push('forward')
      forwarded.push(message)
      return null
    },
    answerRefused: (_sessionId, submitId, code) => refused.push([submitId, code]),
    publish: (_sessionId, snapshot) => snapshots.push(snapshot?.phase ?? null),
    log: () => {},
    ...(options.move === undefined ? {} : { move: options.move }),
    ...(options.forward === undefined ? {} : { forward: options.forward }),
  })
  return {
    controller,
    calls,
    forwarded,
    refused,
    snapshots,
    classifyInputs,
    get cwd(): string { return cwd },
    set cwd(value: string) { cwd = value },
  }
}

test('auto moves before forwarding the held submit', async () => {
  const target = '/workspace/target'
  const state = fixture({
    decision: { kind: 'auto', cwd: target, name: 'target', explicit: true },
  })

  await state.controller.submit(SESSION, submit(), 'fix the issue')

  expect(state.calls).toEqual([`move:${target}`, 'forward'])
  expect(state.forwarded).toEqual([submit()])
  expect(state.controller.snapshots().at(0)?.phase).toBe('recovery')
})

test('ask stays in the source project and suppresses inferred target', async () => {
  const state = fixture({
    decision: { kind: 'ask', cwd: '/workspace/target', name: 'target', explicit: false },
  })
  await state.controller.submit(SESSION, submit(), 'fix the issue')
  expect(state.controller.snapshots().at(0)?.phase).toBe('ask')

  await state.controller.resolve({ appSessionId: SESSION, submitId: SUBMIT, choice: 'stay' })
  expect(state.calls).toEqual(['forward'])
  state.controller.onSubmitResult(SESSION, SUBMIT, true)

  await state.controller.submit(SESSION, submit(SECOND_SUBMIT), 'next issue')
  expect(state.controller.snapshots().at(0)?.phase).toBe('ask')
  expect(state.classifyInputs.at(-1)?.[2]).toEqual(['fix the issue'])
  expect(state.classifyInputs.at(-1)?.[3]).toEqual(['/workspace/target'])
})

test('a classifier error forwards through Chat', async () => {
  const state = fixture({
    decision: { kind: 'stay' },
    classify: async () => { throw new Error('worker failed') },
  })

  await state.controller.submit(SESSION, submit(), 'fix the issue')

  expect(state.calls).toEqual(['forward'])
  expect(state.controller.hasPending(SESSION)).toBe(true)
})

test('a changed source folder fails without moving or forwarding', async () => {
  let release!: (decision: ProjectRouteDecision) => void
  const state = fixture({
    decision: { kind: 'stay' },
    classify: () => new Promise(resolve => { release = resolve }),
  })
  const pending = state.controller.submit(SESSION, submit(), 'fix the issue')
  state.cwd = '/workspace/other'
  release({ kind: 'stay' })
  await pending

  expect(state.calls).toEqual([])
  expect(state.controller.snapshots().at(0)?.phase).toBe('failed')
})

test('a rejected move remains failed for cancellation', async () => {
  const state = fixture({
    decision: { kind: 'auto', cwd: '/workspace/target', name: 'target', explicit: true },
    move: async () => ({ ok: false as const, error: { message: 'Move failed.' } }),
  })

  await state.controller.submit(SESSION, submit(), 'fix the issue')

  expect(state.calls).toEqual([])
  expect(state.controller.snapshots().at(0)?.phase).toBe('failed')
  state.controller.cancel(SESSION)
  expect(state.refused).toEqual([[SUBMIT, 'bad_request']])
})

test('duplicate submit is ignored and another submit is refused', async () => {
  let release!: (decision: ProjectRouteDecision) => void
  const state = fixture({
    classify: () => new Promise(resolve => { release = resolve }),
  })
  const first = state.controller.submit(SESSION, submit(), 'fix the issue')
  await state.controller.submit(SESSION, submit(), 'fix the issue')
  await state.controller.submit(SESSION, submit(SECOND_SUBMIT), 'another issue')
  release({ kind: 'stay' })
  await first

  expect(state.calls).toEqual(['forward'])
  expect(state.refused).toEqual([[SECOND_SUBMIT, 'bad_request']])
})

test('submit results settle only their matching pending submit', async () => {
  const state = fixture()
  await state.controller.submit(SESSION, submit(), 'fix the issue')

  state.controller.onSubmitResult(SESSION, SECOND_SUBMIT, false)
  expect(state.controller.hasPending(SESSION)).toBe(true)
  state.controller.onSubmitResult(SESSION, SUBMIT, false)

  expect(state.controller.snapshots()[0]?.phase).toBe('unsent')
  expect(state.refused).toEqual([])
})

test('forwards the complete image prompt and options unchanged', async () => {
  const state = fixture()
  const imagePrompt = {
    type: 'app.submit' as const,
    requestId: 'request-image',
    prompt: [
      { type: 'text' as const, text: 'Inspect this image' },
      {
        type: 'image' as const,
        source: { type: 'base64' as const, media_type: 'image/png' as const, data: 'aGVsbG8=' },
      },
    ],
    options: { submitId: SUBMIT, isMeta: true, goalSnapshot: { goal: 'inspect' } },
  }

  await state.controller.submit(SESSION, imagePrompt, 'Inspect this image')

  expect(state.forwarded[0]).toBe(imagePrompt)
})

test('cancel clears checking and answers the held submit', async () => {
  let release!: (decision: ProjectRouteDecision) => void
  const state = fixture({
    classify: () => new Promise(resolve => { release = resolve }),
  })
  const pending = state.controller.submit(SESSION, submit(), 'fix the issue')
  state.controller.cancel(SESSION)
  release({ kind: 'stay' })
  await pending

  expect(state.controller.hasPending(SESSION)).toBe(false)
  expect(state.refused).toEqual([[SUBMIT, 'bad_request']])
  expect(state.calls).toEqual([])
})

test('cannot cancel after forwarding while awaiting submit acceptance', async () => {
  const state = fixture()
  await state.controller.submit(SESSION, submit(), 'fix the issue')

  state.controller.cancel(SESSION)

  expect(state.calls).toEqual(['forward'])
  expect(state.refused).toEqual([])
  expect(state.controller.snapshots().at(0)?.phase).toBe('recovery')
})
