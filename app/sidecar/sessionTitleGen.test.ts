import { describe, expect, test } from 'bun:test'
import {
  createSessionTitleGenerator,
  type SessionTitleDeps,
} from './sessionTitleGen.js'

/** A spy deps set: records calls + lets each test script the outcomes. */
function fakeDeps(
  overrides: Partial<{
    generateResult: string | null
    generateThrows: boolean
    hasExistingTitle: boolean
    persistThrows: boolean
  }> = {},
): {
  deps: SessionTitleDeps
  calls: { generate: string[]; persist: Array<[string, string]> }
} {
  const calls = { generate: [] as string[], persist: [] as Array<[string, string]> }
  const deps: SessionTitleDeps = {
    generate: async prompt => {
      calls.generate.push(prompt)
      if (overrides.generateThrows) throw new Error('boom')
      // `in` so an explicit `generateResult: null` is honoured (not coalesced).
      if ('generateResult' in overrides) return overrides.generateResult ?? null
      return 'Fix login button'
    },
    hasExistingTitle: () => overrides.hasExistingTitle ?? false,
    persist: (id, title) => {
      calls.persist.push([id, title])
      if (overrides.persistThrows) throw new Error('disk full')
    },
  }
  return { deps, calls }
}

describe('createSessionTitleGenerator', () => {
  test('fresh session: generates from first prompt, persists, surfaces live', async () => {
    const { deps, calls } = fakeDeps({ generateResult: 'Fix login button' })
    const gen = createSessionTitleGenerator({ engineSessionId: 'sess-1', resumed: false, deps })
    const titles: string[] = []
    await gen.maybeGenerate('  fix the login button please  ', t => titles.push(t))

    // Prompt is trimmed before generation.
    expect(calls.generate).toEqual(['fix the login button please'])
    expect(calls.persist).toEqual([['sess-1', 'Fix login button']])
    expect(titles).toEqual(['Fix login button'])
  })

  test('resumed session: never generates (continuation would mislabel it)', async () => {
    const { deps, calls } = fakeDeps()
    const gen = createSessionTitleGenerator({ engineSessionId: 'sess-1', resumed: true, deps })
    const titles: string[] = []
    await gen.maybeGenerate('some prompt', t => titles.push(t))

    expect(calls.generate).toEqual([])
    expect(calls.persist).toEqual([])
    expect(titles).toEqual([])
  })

  test('existing (custom) title: never clobbered', async () => {
    const { deps, calls } = fakeDeps({ hasExistingTitle: true })
    const gen = createSessionTitleGenerator({ engineSessionId: 'sess-1', resumed: false, deps })
    const titles: string[] = []
    await gen.maybeGenerate('a prompt', t => titles.push(t))

    expect(calls.generate).toEqual([])
    expect(titles).toEqual([])
  })

  test('a rename during generation prevents an AI title write or broadcast', async () => {
    let hasExistingTitle = false
    let resolveGeneration: (title: string | null) => void = () => {}
    const calls = { persist: [] as Array<[string, string]> }
    const gen = createSessionTitleGenerator({
      engineSessionId: 'sess-1',
      resumed: false,
      deps: {
        generate: () =>
          new Promise(resolve => {
            resolveGeneration = resolve
          }),
        hasExistingTitle: () => hasExistingTitle,
        persist: (id, title) => calls.persist.push([id, title]),
      },
    })
    const titles: string[] = []
    const generation = gen.maybeGenerate('a prompt', title => titles.push(title))

    hasExistingTitle = true
    resolveGeneration('Generated title')
    await generation

    expect(calls.persist).toEqual([])
    expect(titles).toEqual([])
  })

  test('empty / whitespace prompt: skipped, no generate call', async () => {
    const { deps, calls } = fakeDeps()
    const gen = createSessionTitleGenerator({ engineSessionId: 'sess-1', resumed: false, deps })
    await gen.maybeGenerate('   ', () => {})
    expect(calls.generate).toEqual([])
  })

  test('null generation result: no persist, no surface', async () => {
    const { deps, calls } = fakeDeps({ generateResult: null })
    const gen = createSessionTitleGenerator({ engineSessionId: 'sess-1', resumed: false, deps })
    const titles: string[] = []
    await gen.maybeGenerate('a prompt', t => titles.push(t))

    expect(calls.generate.length).toBe(1)
    expect(calls.persist).toEqual([])
    expect(titles).toEqual([])
  })

  test('null engineSessionId: disabled', async () => {
    const { deps, calls } = fakeDeps()
    const gen = createSessionTitleGenerator({ engineSessionId: null, resumed: false, deps })
    await gen.maybeGenerate('a prompt', () => {})
    expect(calls.generate).toEqual([])
  })

  test('runs at most once — a second turn never re-attempts', async () => {
    const { deps, calls } = fakeDeps({ generateResult: 'First topic' })
    const gen = createSessionTitleGenerator({ engineSessionId: 'sess-1', resumed: false, deps })
    const titles: string[] = []
    await gen.maybeGenerate('first prompt', t => titles.push(t))
    await gen.maybeGenerate('second prompt', t => titles.push(t))

    expect(calls.generate).toEqual(['first prompt'])
    expect(titles).toEqual(['First topic'])
  })

  test('run-once holds even when the first attempt was a no-op (existing title)', async () => {
    const { deps, calls } = fakeDeps({ hasExistingTitle: true })
    const gen = createSessionTitleGenerator({ engineSessionId: 'sess-1', resumed: false, deps })
    await gen.maybeGenerate('first prompt', () => {})
    await gen.maybeGenerate('second prompt', () => {})
    // attempted flipped on the first call, so the guard is one-shot regardless.
    expect(calls.generate).toEqual([])
  })

  test('generate throwing degrades to a no-op (never escapes the turn)', async () => {
    const { deps } = fakeDeps({ generateThrows: true })
    const gen = createSessionTitleGenerator({ engineSessionId: 'sess-1', resumed: false, deps })
    const titles: string[] = []
    await expect(gen.maybeGenerate('a prompt', t => titles.push(t))).resolves.toBeUndefined()
    expect(titles).toEqual([])
  })

  test('persist failure still surfaces the live title (best-effort durability)', async () => {
    const { deps } = fakeDeps({ generateResult: 'Live topic', persistThrows: true })
    const gen = createSessionTitleGenerator({ engineSessionId: 'sess-1', resumed: false, deps })
    const titles: string[] = []
    await gen.maybeGenerate('a prompt', t => titles.push(t))
    expect(titles).toEqual(['Live topic'])
  })
})
