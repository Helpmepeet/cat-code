import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import type { Command } from '../commands.js'
import type { Message } from '../types/message.js'

// Mocked at the module boundary before the subject is imported. The real module
// is spread because this specifier is shared with unrelated importers in this
// process. Spreading is not enough on its own: bun installs mock.module during
// the import phase of every file in an invocation and never restores it, so a
// stub that is always live also rewrites behaviour other suites assert on. Each
// stub is therefore gated on this file's own tests being in flight; every other
// file in the same run gets the real function. The real implementation must be
// captured into a local binding BEFORE the mock is installed, because
// mock.module rewrites the live namespace object and reading it back off the
// namespace afterwards yields the stub.
let prepareCalls = 0
let stubsActive = false

beforeEach(() => {
  stubsActive = true
})

afterEach(() => {
  stubsActive = false
})

const actualStore = await import('../services/deferredContinuation.js')
const realPrepareHumanPrompt =
  actualStore.prepareHumanPromptAgainstDeferredContinuation
const realTakeNotice = actualStore.takeDeferredContinuationNotice
mock.module('../services/deferredContinuation.js', () => ({
  ...actualStore,
  prepareHumanPromptAgainstDeferredContinuation: async (
    ...args: Parameters<typeof realPrepareHumanPrompt>
  ) => {
    if (!stubsActive) return realPrepareHumanPrompt(...args)
    prepareCalls++
    // Blocking returns early, which keeps this test on the decision and off the
    // rest of the submit pipeline.
    return { action: 'block' as const, notice: 'blocked for test' }
  },
  takeDeferredContinuationNotice: async (
    ...args: Parameters<typeof realTakeNotice>
  ) => (stubsActive ? null : realTakeNotice(...args)),
}))

const actualState = await import('../bootstrap/state.js')
const realGetSessionId = actualState.getSessionId
mock.module('../bootstrap/state.js', () => ({
  ...actualState,
  getSessionId: () =>
    stubsActive ? '22222222-2222-4222-8222-222222222222' : realGetSessionId(),
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

// F1: the immediate path is entered ONLY because another submission already
// holds the guard, so `dispatching` there is never ours. `getToolUseContext`
// reports `queryGuard.isRunning` — correct for the serialized path, which
// reserves the guard for itself — but false during another submission's
// arbitrarily long `dispatching` window (a slow UserPromptSubmit hook, an
// awaited BashTool call). A command trusting it would conclude no turn is in
// flight and act against a live one.
describe('handlePromptSubmit immediate dispatch', () => {
  function immediateCommandSeeing(seen: { isQueryActive?: boolean }): Command {
    return {
      type: 'local-jsx',
      name: 'continue-after-limit',
      description: 'immediate local command',
      immediate: true,
      // isCommandEnabled() calls this; the suite's other fixtures never reach
      // the immediate lookup, so they get away with a bare boolean.
      isEnabled: () => true,
      isHidden: false,
      userFacingName: () => 'continue-after-limit',
      load: async () => ({
        call: async (
          _onDone: unknown,
          context: { isQueryActive: boolean },
        ) => {
          seen.isQueryActive = context.isQueryActive
          return null
        },
      }),
    } as unknown as Command
  }

  test('reports the in-flight turn it interrupted, even mid-dispatch', async () => {
    const seen: { isQueryActive?: boolean } = {}
    await handlePromptSubmit({
      input: '/continue-after-limit',
      commands: [immediateCommandSeeing(seen)],
      messages: [],
      // The guard is held by another submission that has reserved but not yet
      // started its turn — exactly the window `isRunning` cannot see.
      queryGuard: { isActive: true, isRunning: false },
      // Stands in for REPL's builder, which reports `queryGuard.isRunning`.
      getToolUseContext: () => ({ isQueryActive: false }),
      setToolJSX: () => {},
      createAbortController: () => new AbortController(),
      helpers: {
        setCursorOffset: () => {},
        clearBuffer: () => {},
        resetHistory: () => {},
      },
      onInputChange: () => {},
      setPastedContents: () => {},
      setMessages: () => {},
    } as never)

    expect(seen.isQueryActive).toBe(true)
  })
})
