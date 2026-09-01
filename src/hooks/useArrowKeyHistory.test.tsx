import { afterEach, beforeAll, describe, expect, mock, test } from 'bun:test'
import * as React from 'react'
import { PassThrough } from 'stream'
import { render } from '../ink.js'
import { AppStateProvider, getDefaultAppState } from '../state/AppState.js'
import type { HistoryEntry } from '../utils/config.js'
import type { HistoryMode } from './useArrowKeyHistory.js'

beforeAll(() => {
  ;(
    globalThis as typeof globalThis & { MACRO?: { VERSION: string } }
  ).MACRO ??= { VERSION: 'test-version' }
})

// Newest first, matching getHistory()'s order.
const HISTORY = ['third command', 'second command', 'first command']

type Composer = {
  value: string
  mode: HistoryMode
}

type Driver = {
  up: () => Promise<void>
  down: () => Promise<void>
  type: (value: string) => Promise<void>
  composer: () => Composer
}

/**
 * Mounts the hook inside a real render so its refs, async history load and
 * state updates behave as they do in the REPL. The driver awaits a tick after
 * every action because onHistoryUp finishes inside a promise.
 */
async function mountHistoryDriver(): Promise<{
  driver: Driver
  unmount: () => void
}> {
  await mock.module('../history.js', () => ({
    getHistory: async function* (): AsyncGenerator<HistoryEntry> {
      for (const display of HISTORY) {
        yield { display, pastedContents: {} }
      }
    },
  }))

  const { useArrowKeyHistory } = await import('./useArrowKeyHistory.js')

  let composer: Composer = { value: '', mode: 'prompt' }
  let onUp: () => void = () => {}
  let onDown: () => boolean = () => false
  let setValue: (value: string) => void = () => {}

  function Probe(): React.ReactNode {
    const [state, setState] = React.useState<Composer>({
      value: '',
      mode: 'prompt',
    })
    composer = state
    setValue = (value: string) =>
      setState(prev => ({ value, mode: prev.mode }))

    const history = useArrowKeyHistory(
      (value: string, mode: HistoryMode) => setState({ value, mode }),
      state.value,
      {},
      undefined,
      state.mode,
    )
    onUp = history.onHistoryUp
    onDown = history.onHistoryDown
    return null
  }

  const stdout = new PassThrough() as unknown as NodeJS.WriteStream & {
    columns: number
  }
  stdout.columns = 100
  const stdin = new PassThrough() as unknown as NodeJS.ReadStream
  const stderr = new PassThrough() as unknown as NodeJS.WriteStream

  const instance = await render(
    <AppStateProvider initialState={getDefaultAppState()}>
      <Probe />
    </AppStateProvider>,
    { stdout, stdin, stderr, exitOnCtrlC: false, patchConsole: false },
  )

  const settle = () => new Promise<void>(resolve => setTimeout(resolve, 25))
  await settle()

  return {
    driver: {
      up: async () => {
        onUp()
        await settle()
      },
      down: async () => {
        onDown()
        await settle()
      },
      type: async (value: string) => {
        setValue(value)
        await settle()
      },
      composer: () => composer,
    },
    unmount: () => instance.unmount(),
  }
}

afterEach(() => {
  mock.restore()
})

// Pressing Up, editing the recalled text, then pressing Up again discarded the
// edit: both handlers wrote the composer straight from historyCache and only
// index 0 (the draft) was ever saved back. Shell history keeps per-entry edits
// for the life of the navigation without touching the stored history.
describe('editing a recalled history entry', () => {
  test('an edit survives navigating up and back down', async () => {
    const { driver, unmount } = await mountHistoryDriver()
    try {
      await driver.up()
      expect(driver.composer().value).toBe('third command')

      await driver.type('third command EDITED')
      await driver.up()
      expect(driver.composer().value).toBe('second command')

      await driver.down()
      expect(driver.composer().value).toBe('third command EDITED')
    } finally {
      unmount()
    }
  })

  test('an edit survives navigating down and back up', async () => {
    const { driver, unmount } = await mountHistoryDriver()
    try {
      await driver.up()
      await driver.up()
      expect(driver.composer().value).toBe('second command')

      await driver.type('second command EDITED')
      await driver.down()
      expect(driver.composer().value).toBe('third command')

      await driver.up()
      expect(driver.composer().value).toBe('second command EDITED')
    } finally {
      unmount()
    }
  })

  test('edits to several entries are kept independently', async () => {
    const { driver, unmount } = await mountHistoryDriver()
    try {
      await driver.up()
      await driver.type('edit one')
      await driver.up()
      await driver.type('edit two')
      await driver.up()
      expect(driver.composer().value).toBe('first command')

      await driver.down()
      expect(driver.composer().value).toBe('edit two')
      await driver.down()
      expect(driver.composer().value).toBe('edit one')
    } finally {
      unmount()
    }
  })

  test('an unedited entry still shows the stored history text', async () => {
    const { driver, unmount } = await mountHistoryDriver()
    try {
      await driver.up()
      await driver.up()
      await driver.down()
      expect(driver.composer().value).toBe('third command')
      await driver.up()
      expect(driver.composer().value).toBe('second command')
    } finally {
      unmount()
    }
  })

  // The pre-existing index-0 behaviour must be untouched.
  test('the composer draft is still restored at the bottom of history', async () => {
    const { driver, unmount } = await mountHistoryDriver()
    try {
      await driver.type('my draft')
      await driver.up()
      expect(driver.composer().value).toBe('third command')

      await driver.down()
      expect(driver.composer().value).toBe('my draft')
    } finally {
      unmount()
    }
  })

  // Clearing a recalled entry records no edit, so the stored line comes back.
  test('emptying an entry restores the stored text on return', async () => {
    const { driver, unmount } = await mountHistoryDriver()
    try {
      await driver.up()
      await driver.type('')
      await driver.up()
      await driver.down()
      expect(driver.composer().value).toBe('third command')
    } finally {
      unmount()
    }
  })
})
