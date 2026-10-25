import { describe, expect, test } from 'bun:test'
import { PROTOCOL_VERSION, type ServerFrame } from '../../shared/protocol.js'
import {
  createQueuedPromptsState,
  reduceQueuedPromptsState,
  selectQueuedPrompts,
} from './queuedPromptsState.js'

const SESSION = 'session-1'

function snapshot(prompts: Array<{ id: string; text: string }>): ServerFrame {
  return {
    kind: 'queued-prompts.snapshot',
    protocolVersion: PROTOCOL_VERSION,
    sessionId: SESSION,
    prompts,
  }
}

function fold(frames: ServerFrame[]) {
  return frames.reduce(
    (state, frame) => reduceQueuedPromptsState(state, { type: 'frame', frame }),
    createQueuedPromptsState(),
  )
}

describe('messages waiting for the running response', () => {
  test('a session with no snapshot has nothing waiting', () => {
    expect(selectQueuedPrompts(createQueuedPromptsState(), SESSION)).toEqual([])
    expect(selectQueuedPrompts(createQueuedPromptsState(), null)).toEqual([])
  })

  test('the newest snapshot REPLACES the previous list', () => {
    // The sidecar publishes the whole list on every queue change, so folding
    // these as appends would show a delivered message forever.
    const state = fold([
      snapshot([{ id: 'a', text: 'first' }]),
      snapshot([
        { id: 'a', text: 'first' },
        { id: 'b', text: 'second' },
      ]),
      snapshot([{ id: 'b', text: 'second' }]),
    ])

    expect(selectQueuedPrompts(state, SESSION)).toEqual([
      { id: 'b', text: 'second' },
    ])
  })

  test('an empty snapshot retires every row', () => {
    const state = fold([snapshot([{ id: 'a', text: 'first' }]), snapshot([])])

    expect(selectQueuedPrompts(state, SESSION)).toEqual([])
  })

  test('a process reset drops the list rather than stranding it', () => {
    // The engine that held the queue is gone; a fresh one publishes its own.
    const state = fold([
      snapshot([{ id: 'a', text: 'first' }]),
      {
        kind: 'lifecycle',
        protocolVersion: PROTOCOL_VERSION,
        sessionId: SESSION,
        status: 'exited',
      },
    ])

    expect(selectQueuedPrompts(state, SESSION)).toEqual([])
  })

  test('one session’s snapshot never touches another’s', () => {
    const state = reduceQueuedPromptsState(
      fold([snapshot([{ id: 'a', text: 'first' }])]),
      {
        type: 'frame',
        frame: {
          kind: 'queued-prompts.snapshot',
          protocolVersion: PROTOCOL_VERSION,
          sessionId: 'session-2',
          prompts: [{ id: 'z', text: 'elsewhere' }],
        },
      },
    )

    expect(selectQueuedPrompts(state, SESSION)).toEqual([
      { id: 'a', text: 'first' },
    ])
    expect(selectQueuedPrompts(state, 'session-2')).toEqual([
      { id: 'z', text: 'elsewhere' },
    ])
  })
})


test('instant Focused queue reconciles by submit identity, never text, and refusal preserves later submits', () => {
  let state = createQueuedPromptsState()
  state = reduceQueuedPromptsState(state, { type: 'submitted', sessionId: SESSION, submitId: 'first', text: 'same text' })
  state = reduceQueuedPromptsState(state, { type: 'submitted', sessionId: SESSION, submitId: 'second', text: 'same text' })
  expect(selectQueuedPrompts(state, SESSION, true).map(item => item.id)).toEqual(['first', 'second'])
  expect(selectQueuedPrompts(state, SESSION)).toEqual([])
  state = reduceQueuedPromptsState(state, { type: 'frame', frame: { kind: 'submit.result', protocolVersion: PROTOCOL_VERSION, sessionId: SESSION, submitId: 'first', accepted: true, queued: true } })
  expect(selectQueuedPrompts(state, SESSION, true)).toHaveLength(2)
  state = reduceQueuedPromptsState(state, { type: 'frame', frame: { ...snapshot([]), prompts: [{ id: 'engine-first', submitId: 'first', text: 'same text' }] } as ServerFrame })
  expect(selectQueuedPrompts(state, SESSION, true).map(item => item.id)).toEqual(['engine-first', 'second'])
  state = reduceQueuedPromptsState(state, { type: 'frame', frame: { kind: 'submit.result', protocolVersion: PROTOCOL_VERSION, sessionId: SESSION, submitId: 'second', accepted: false, code: 'bad_request' } })
  expect(selectQueuedPrompts(state, SESSION, true).map(item => item.id)).toEqual(['engine-first'])
  state = reduceQueuedPromptsState(state, { type: 'frame', frame: snapshot([]) })
  expect(selectQueuedPrompts(state, SESSION, true)).toEqual([])
})
