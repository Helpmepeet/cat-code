import { beforeEach, describe, expect, mock, test } from 'bun:test'
import type { Command } from '../commands.js'
import type { Message } from '../types/message.js'

// Mocked at the module boundary before the subject is imported. The real module
// is spread because this specifier is shared with unrelated importers in this
// process.
let prepareCalls = 0
const actualStore = await import('../services/deferredContinuation.js')
mock.module('../services/deferredContinuation.js', () => ({
  ...actualStore,
  prepareHumanPromptAgainstDeferredContinuation: async () => {
    prepareCalls++
    // Blocking returns early, which keeps this test on the decision and off the
    // rest of the submit pipeline.
    return { action: 'block' as const, notice: 'blocked for test' }
  },
  takeDeferredContinuationNotice: async () => null,
}))

const actualState = await import('../bootstrap/state.js')
mock.module('../bootstrap/state.js', () => ({
  ...actualState,
  getSessionId: () => '22222222-2222-4222-8222-222222222222',
}))

const { handlePromptSubmit, invalidatesDeferredContinuation } = await import(
  './handlePromptSubmit.js'
)

// F11: the deferred-continuation invalidation check was skipped for every
// slash-prefixed submission. Prompt commands (including prompt skills) invoke
// the model and change conversation direction, so a scheduled continuation
// stayed live underneath one and later replayed into a conversation the user
// had already moved on from.
const commands = [
  {
    type: 'prompt',
    name: 'review',
    aliases: ['pr-review'],
    description: 'prompt command',
    progressMessage: 'reviewing',
    contentLength: 0,
    source: 'builtin',
    isEnabled: true,
    isHidden: false,
    userFacingName: () => 'review',
  },
  {
    type: 'local-jsx',
    name: 'continue-after-limit',
    description: 'local command',
    isEnabled: true,
    isHidden: false,
    userFacingName: () => 'continue-after-limit',
  },
] as unknown as Command[]

describe('invalidatesDeferredContinuation', () => {
  test('plain text is human activity', () => {
    expect(invalidatesDeferredContinuation('carry on', commands, false)).toBe(true)
    expect(invalidatesDeferredContinuation('  spaced  ', commands, undefined)).toBe(true)
  })

  test('a prompt command is human activity, with or without arguments', () => {
    expect(invalidatesDeferredContinuation('/review', commands, false)).toBe(true)
    expect(invalidatesDeferredContinuation('/review the diff', commands, false)).toBe(true)
    expect(invalidatesDeferredContinuation('/pr-review', commands, false)).toBe(true)
  })

  test('inspecting a schedule never cancels it', () => {
    // The decisive case: /continue-after-limit status must be able to report on
    // a continuation without destroying it.
    expect(
      invalidatesDeferredContinuation('/continue-after-limit status', commands, false),
    ).toBe(false)
    expect(invalidatesDeferredContinuation('/continue-after-limit', commands, false)).toBe(false)
  })

  test('an unknown command never reaches the model, so it is not activity', () => {
    expect(invalidatesDeferredContinuation('/not-a-command', commands, false)).toBe(false)
  })

  test('remote text that merely looks like a command is human activity', () => {
    // skipSlashCommands means the text is sent to the model verbatim.
    expect(invalidatesDeferredContinuation('/review', commands, true)).toBe(true)
  })
})

// The helper above only matters if the submit path actually consults it. These
// drive handlePromptSubmit itself so the decision cannot be quietly bypassed at
// the call site.
describe('handlePromptSubmit deferred-continuation gate', () => {
  let messages: Message[] = []

  function submit(input: string): Promise<void> {
    return handlePromptSubmit({
      input,
      commands,
      messages: [],
      // Active: input that survives the gate is queued and returns, instead of
      // running the turn machinery this test has no business exercising.
      queryGuard: { isActive: true },
      helpers: {
        setCursorOffset: () => {},
        clearBuffer: () => {},
        resetHistory: () => {},
      },
      onInputChange: () => {},
      setPastedContents: () => {},
      setMessages: (updater: (prev: Message[]) => Message[]) => {
        messages = updater(messages)
      },
    } as never)
  }

  beforeEach(() => {
    prepareCalls = 0
    messages = []
  })

  test('a prompt command consults the scheduled continuation', async () => {
    await submit('/review the diff')

    expect(prepareCalls).toBe(1)
    expect(JSON.stringify(messages)).toContain('blocked for test')
  })

  test('plain text consults the scheduled continuation', async () => {
    await submit('carry on')

    expect(prepareCalls).toBe(1)
  })

  test('inspecting the schedule does not consult it', async () => {
    await submit('/continue-after-limit status')

    expect(prepareCalls).toBe(0)
  })
})
