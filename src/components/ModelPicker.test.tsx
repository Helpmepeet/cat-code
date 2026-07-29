import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { PassThrough } from 'stream'
import * as React from 'react'
import {
  getInitialMainLoopModel,
  getMainLoopModelOverride,
  getSessionProvider,
  setInitialMainLoopModel,
  setMainLoopModelOverride,
  setSessionProvider,
} from '../bootstrap/state.js'
import { render, ThemeProvider } from '../ink.js'
import { AppStateProvider, getDefaultAppState } from '../state/AppState.js'

// The picker listed the same model twice. Its "current model is not offered,
// append it" fallback compared RAW strings, so a saved canonical id
// (`claude-sonnet-5`, what a Codex session persists) failed to match the row
// that already offers it under the family alias (`sonnet`, what the first-party
// tier lists carry) and a second, identically labelled row was appended.

// A first-party Max fixture: isClaudeAISubscriber/isMaxSubscriber are the only
// auth reads getModelOptionsBase branches on for this tier, and real OAuth
// tokens are not available in a test process. Every override passes through to
// the real implementation while `tier` is null, so the module registration
// bun leaves behind after this file cannot change behavior for other suites.
let tier: 'max' | null = null

const previous = {
  override: getMainLoopModelOverride(),
  initial: getInitialMainLoopModel(),
  provider: getSessionProvider(),
  userType: process.env.USER_TYPE,
  apiKey: process.env.ANTHROPIC_API_KEY,
}

// `mock.module` MUTATES the namespace object a prior `import` returned, so a
// pass-through written as `actual.isCodexSubscriber()` calls the mock itself and
// recurses forever the moment `tier` is null. Capture the implementations before
// registering anything.
const actual = await import('../utils/auth.js')
const real = {
  isClaudeAISubscriber: actual.isClaudeAISubscriber,
  isMaxSubscriber: actual.isMaxSubscriber,
  isTeamPremiumSubscriber: actual.isTeamPremiumSubscriber,
  isCodexSubscriber: actual.isCodexSubscriber,
  hasCodexTokens: actual.hasCodexTokens,
  hasAnthropicCredentials: actual.hasAnthropicCredentials,
}

beforeEach(async () => {
  await mock.module('src/utils/auth.js', () => ({
    ...actual,
    isClaudeAISubscriber: () =>
      tier === null ? real.isClaudeAISubscriber() : true,
    isMaxSubscriber: () => (tier === null ? real.isMaxSubscriber() : true),
    isTeamPremiumSubscriber: () =>
      tier === null ? real.isTeamPremiumSubscriber() : false,
    isCodexSubscriber: () => (tier === null ? real.isCodexSubscriber() : false),
    hasCodexTokens: () => (tier === null ? real.hasCodexTokens() : false),
    hasAnthropicCredentials: () =>
      tier === null ? real.hasAnthropicCredentials() : true,
  }))
  tier = 'max'
  delete process.env.USER_TYPE
  // Unmocked auth reads throw under NODE_ENV=test without a credential env var.
  process.env.ANTHROPIC_API_KEY = 'test-anthropic-api-key'
  setSessionProvider('firstParty')
  // getModelOptions has its own append-the-current-model fallback keyed off
  // these; clearing them leaves the picker's own fallback as the only one under
  // test.
  setMainLoopModelOverride(null)
  setInitialMainLoopModel(null)
})

afterEach(() => {
  tier = null
  setMainLoopModelOverride(previous.override)
  setInitialMainLoopModel(previous.initial)
  setSessionProvider(previous.provider)
  if (previous.userType === undefined) delete process.env.USER_TYPE
  else process.env.USER_TYPE = previous.userType
  if (previous.apiKey === undefined) delete process.env.ANTHROPIC_API_KEY
  else process.env.ANTHROPIC_API_KEY = previous.apiKey
})

/** Strip the cursor/colour escapes ink writes so the frame can be read as text. */
const ANSI = new RegExp(String.fromCharCode(27) + '\\[[0-9;?]*[a-zA-Z]', 'g')

async function renderPicker(initial: string | null): Promise<string> {
  const { ModelPicker } = await import('./ModelPicker.js')

  const stdout = new PassThrough() as unknown as NodeJS.WriteStream & {
    columns: number
  }
  stdout.columns = 120
  let buffer = ''
  stdout.on('data', chunk => {
    buffer += String(chunk)
  })
  // Ink refuses to mount its input handling on a non-TTY stdin and renders a
  // loud error block into the frame; these stubs keep the frame readable.
  const stdin = new PassThrough() as unknown as NodeJS.ReadStream & {
    isTTY: boolean
    setRawMode: (mode: boolean) => void
  }
  stdin.isTTY = true
  stdin.setRawMode = () => {}
  stdin.ref = () => stdin
  stdin.unref = () => stdin
  const stderr = new PassThrough() as unknown as NodeJS.WriteStream

  const instance = await render(
    <ThemeProvider>
      <AppStateProvider initialState={getDefaultAppState()}>
        <ModelPicker
          initial={initial}
          onSelect={() => {}}
          isStandaloneCommand
        />
      </AppStateProvider>
    </ThemeProvider>,
    { stdout, stdin, stderr, exitOnCtrlC: false, patchConsole: false },
  )
  await new Promise(resolve => setTimeout(resolve, 120))
  instance.unmount()

  // Ink redraws the whole frame on every render and the buffer keeps them all,
  // so read only the last one — counting rows across frames counts each row
  // once per render.
  const plain = buffer.replace(ANSI, '')
  const lastFrame = plain.lastIndexOf('Select model')
  return lastFrame === -1 ? plain : plain.slice(lastFrame)
}

/** Numbered option rows, e.g. `❯ 3. Sonnet 5 ✔   Sonnet 5 · Best for …`. */
function optionRows(frame: string): { label: string; description: string }[] {
  const rows: { label: string; description: string }[] = []
  for (const line of frame.split('\n')) {
    const match = /^\s*\S?\s*\d+\.\s+(.+?)\s{2,}(.*?)\s*$/.exec(line)
    if (match?.[1] !== undefined) {
      rows.push({ label: match[1], description: match[2] ?? '' })
    }
  }
  return rows
}

function labelCount(frame: string, label: string): number {
  return optionRows(frame).filter(row => row.label.startsWith(label)).length
}

describe('ModelPicker current-model fallback', () => {
  test('a canonical model id already offered under its alias does not add a second row', async () => {
    const frame = await renderPicker('claude-sonnet-5')

    // The Max tier offers Sonnet 5 as the alias `sonnet`; the saved setting is
    // the canonical id. Exactly one row, and it is the offered one.
    expect(labelCount(frame, 'Sonnet 5')).toBe(1)
    expect(optionRows(frame).map(row => row.description)).not.toContain(
      'Current model',
    )
  })

  test('the surviving row is the marked and focused one', async () => {
    const frame = await renderPicker('claude-sonnet-5')

    // Select marks and focuses by plain string equality, so dropping the
    // duplicate must not leave the picker opening on Default with nothing
    // marked. `[>❯]` / `[✔√]` cover the non-unicode figure fallbacks.
    expect(frame).toMatch(/[>❯]\s*\d+\.\s+Sonnet 5\s+[✔√]/)
  })

  test('opusplan keeps its own row even though it resolves to the Sonnet default', async () => {
    const frame = await renderPicker('opusplan')

    // The trap: opusplan resolves to Sonnet, since Opus applies in plan mode
    // only. Folding it into the Sonnet row would lose the setting.
    expect(
      optionRows(frame).filter(row => row.description === 'Current model'),
    ).toHaveLength(1)
    expect(labelCount(frame, 'Sonnet 5')).toBe(1)
  })

  test('best keeps its own row even though it resolves to Fable', async () => {
    const frame = await renderPicker('best')

    expect(
      optionRows(frame).filter(row => row.description === 'Current model'),
    ).toHaveLength(1)
    expect(labelCount(frame, 'Fable 5')).toBe(1)
  })

  test('an unrelated pinned model still gets its own row', async () => {
    const frame = await renderPicker('claude-3-5-haiku-20241022')

    // A pinned id no offered row resolves to still needs its own row, and it
    // is the marked one.
    expect(
      optionRows(frame).filter(row => row.description === 'Current model'),
    ).toHaveLength(1)
    expect(labelCount(frame, 'claude-3-5-haiku-20241022')).toBe(1)
    expect(labelCount(frame, 'Haiku 4.5')).toBe(1)
  })
})
