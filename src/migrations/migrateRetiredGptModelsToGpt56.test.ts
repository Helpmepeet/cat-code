import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { SettingsUpdater } from '../utils/settings/settings.js'
import type { SettingsJson } from '../utils/settings/types.js'

/**
 * TEST EVIDENCE
 * - Claim: every user-owned retired GPT setting and runtime override migrates
 *   without clobbering current/colliding values, and a second run is a no-op.
 * - Exact pre-fix failure: an early return left all legacy model surfaces stale.
 * - Production entry point: `migrateRetiredGptModelsToGpt56`;
 *   `runEngineMigrations` is covered by the source-string tripwire below.
 * - Test path: `src/migrations/migrateRetiredGptModelsToGpt56.test.ts`.
 * - Proof layer: helper/module-boundary functional; wiring tripwire is not it.
 * - Red/mutation evidence: an early-return mutation made three functional cases
 *   red while the source-string tripwire remained green; source was restored.
 * - Pairwise/adversarial cases: remap+dedupe, old/current override collision,
 *   unrelated override preservation, mixed state, runtime override, idempotence.
 * - UNVERIFIED: executable startup caller, real settings-file/process, DOM,
 *   GUI, credentialed-live.
 * - Commands and outcomes: focused suite passed 4/0; engine build passed.
 */

let userSettings: SettingsJson | null = null
let updateCalls: Array<Partial<SettingsJson>> = []
let mainLoopOverride: string | undefined
let mainLoopOverrideWrites: Array<string | undefined> = []
let updateError: Error | null = null

const actualSettings = await import('../utils/settings/settings.js')
mock.module('../utils/settings/settings.js', () => ({
  ...actualSettings,
  getSettingsForSource: () => userSettings,
  updateSettingsForSource: (
    _source: string,
    patch: SettingsJson | SettingsUpdater,
  ) => {
    if (updateError) return { error: updateError }
    if (typeof patch === 'function') {
      const next = patch(userSettings)
      if (next) {
        updateCalls.push(next)
        userSettings = next
      }
      return { error: null }
    }
    updateCalls.push(patch)
    if (userSettings) {
      const mergedOverrides = patch.modelOverrides
        ? Object.fromEntries(
            Object.entries({
              ...userSettings.modelOverrides,
              ...patch.modelOverrides,
            }).filter(([, value]) => value !== undefined),
          )
        : userSettings.modelOverrides
      userSettings = {
        ...userSettings,
        ...patch,
        ...(patch.modelOverrides ? { modelOverrides: mergedOverrides } : {}),
      }
    }
    return { error: null }
  },
}))

const actualState = await import('../bootstrap/state.js')
mock.module('../bootstrap/state.js', () => ({
  ...actualState,
  getMainLoopModelOverride: () => mainLoopOverride,
  setMainLoopModelOverride: (model: string | undefined) => {
    mainLoopOverrideWrites.push(model)
    mainLoopOverride = model
  },
}))

const { migrateRetiredGptModelsToGpt56 } = await import(
  './migrateRetiredGptModelsToGpt56.js'
)

beforeEach(() => {
  userSettings = null
  updateCalls = []
  mainLoopOverride = undefined
  mainLoopOverrideWrites = []
  updateError = null
})

afterEach(() => {
  mock.restore()
})

describe('migrateRetiredGptModelsToGpt56', () => {
  test('reports a settings-write error so startup keeps the migration pending', () => {
    userSettings = { model: 'gpt-5.4' }
    updateError = new Error('settings lock unavailable')

    expect(migrateRetiredGptModelsToGpt56()).toBe(updateError)
    expect(mainLoopOverrideWrites).toEqual([])
  })

  test('remaps every user-owned model surface and de-duplicates the resulting allowlist', () => {
    userSettings = {
      model: 'gpt-5.4',
      availableModels: [
        'gpt-5.6-luna',
        'gpt-5.4',
        'gpt-5.3-codex',
        'gpt-5.5',
        'gpt-5.6-terra',
        'custom-model',
      ],
      modelOverrides: {
        'gpt-5.4': 'legacy-luna-override',
        'gpt-5.5': 'legacy-terra-override',
        'gpt-5.6-terra': 'existing-terra-override',
        'custom-model': 'custom-override',
      },
    }

    migrateRetiredGptModelsToGpt56()

    expect(updateCalls).toEqual([
      {
        model: 'gpt-5.6-luna',
        availableModels: ['gpt-5.6-luna', 'gpt-5.6-terra', 'custom-model'],
        modelOverrides: {
          'gpt-5.6-luna': 'legacy-luna-override',
          'gpt-5.6-terra': 'existing-terra-override',
          'custom-model': 'custom-override',
        },
      },
    ])
    expect(userSettings).toEqual({
      model: 'gpt-5.6-luna',
      availableModels: ['gpt-5.6-luna', 'gpt-5.6-terra', 'custom-model'],
      modelOverrides: {
        'gpt-5.6-luna': 'legacy-luna-override',
        'gpt-5.6-terra': 'existing-terra-override',
        'custom-model': 'custom-override',
      },
    })
  })

  test('preserves mixed current settings while migrating the remaining retired values', () => {
    userSettings = {
      model: 'gpt-5.6-terra',
      availableModels: ['gpt-5.6-terra', 'gpt-5.5', 'gpt-5.4-mini', 'gpt-5.6-luna'],
      modelOverrides: {
        'gpt-5.6-luna': 'keep-current-luna',
        'gpt-5.4-mini': 'retired-luna',
        'custom-model': 'keep-custom',
      },
    }

    migrateRetiredGptModelsToGpt56()

    expect(updateCalls).toEqual([
      {
        model: 'gpt-5.6-terra',
        availableModels: ['gpt-5.6-terra', 'gpt-5.6-luna'],
        modelOverrides: {
          'gpt-5.6-luna': 'keep-current-luna',
          'custom-model': 'keep-custom',
        },
      },
    ])
    expect(userSettings).toEqual({
      model: 'gpt-5.6-terra',
      availableModels: ['gpt-5.6-terra', 'gpt-5.6-luna'],
      modelOverrides: {
        'gpt-5.6-luna': 'keep-current-luna',
        'custom-model': 'keep-custom',
      },
    })
  })

  test('migrates the runtime main-loop override and is idempotent on a second startup', () => {
    userSettings = {
      model: 'gpt-5.5',
      availableModels: ['gpt-5.5', 'gpt-5.6-terra'],
      modelOverrides: { 'gpt-5.5': 'legacy-terra-override' },
    }
    mainLoopOverride = 'gpt-5.4[1m]'

    migrateRetiredGptModelsToGpt56()
    migrateRetiredGptModelsToGpt56()

    expect(updateCalls).toEqual([
      {
        model: 'gpt-5.6-terra',
        availableModels: ['gpt-5.6-terra'],
        modelOverrides: {
          'gpt-5.6-terra': 'legacy-terra-override',
        },
      },
    ])
    expect(mainLoopOverrideWrites).toEqual(['gpt-5.6-luna'])
    expect(mainLoopOverride).toBe('gpt-5.6-luna')
  })
})

test('startup wiring tripwire keeps the migration owned by init', () => {
  const ownerSource = readFileSync(
    fileURLToPath(new URL('./runEngineMigrations.ts', import.meta.url)),
    'utf8',
  )
  const initSource = readFileSync(
    fileURLToPath(new URL('../entrypoints/init.ts', import.meta.url)),
    'utf8',
  )

  expect(ownerSource).toContain(
    "import { migrateRetiredGptModelsToGpt56 } from './migrateRetiredGptModelsToGpt56.js'",
  )
  expect(ownerSource).toContain('const retiredGptError = migrateRetiredGptModelsToGpt56()')
  expect(ownerSource).toContain('if (retiredGptError) return retiredGptError')
  expect(initSource).toContain('await runEngineMigrations()')
})
