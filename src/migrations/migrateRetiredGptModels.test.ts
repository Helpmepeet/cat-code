import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { getClaudeConfigHomeDir } from '../utils/envUtils.js'
import {
  getSettingsForSource,
  updateSettingsForSource,
} from '../utils/settings/settings.js'
import { resetSettingsCache } from '../utils/settings/settingsCache.js'
import type { SettingsJson } from '../utils/settings/types.js'

/**
 * TEST EVIDENCE
 * - Claim: every user-owned retired GPT setting and runtime override migrates
 *   without clobbering current/colliding values, and a second run is a no-op.
 * - Exact pre-fix failure: GPT-6 Sol and GPT-5.6 Sol remained in persisted
 *   selection, allowlist, override, or main-loop values.
 * - Production entry point: `migrateRetiredGptModels`;
 *   `runEngineMigrations` is covered by the source-string tripwire below.
 * - Test path: `src/migrations/migrateRetiredGptModels.test.ts`.
 * - Proof layer: helper/module-boundary functional; wiring tripwire is not it.
 * - Red/mutation evidence: an early-return mutation made three functional cases
 *   red while the source-string tripwire remained green; source was restored.
 * - Pairwise/adversarial cases: remap+dedupe, old/current override collision,
 *   unrelated override preservation, mixed state, runtime override, idempotence.
 * - UNVERIFIED: executable startup caller, real settings-file/process, DOM,
 *   GUI, credentialed-live.
 * - Commands and outcomes: focused suite passed; engine build passed.
 */

let mainLoopOverride: string | undefined
let mainLoopOverrideWrites: Array<string | undefined> = []
let settingsDir: string
let originalConfigDir: string | undefined

const actualState = await import('../bootstrap/state.js')
mock.module('../bootstrap/state.js', () => ({
  ...actualState,
  getMainLoopModelOverride: () => mainLoopOverride,
  setMainLoopModelOverride: (model: string | undefined) => {
    mainLoopOverrideWrites.push(model)
    mainLoopOverride = model
  },
}))
const { migrateRetiredGptModels } = await import(
  './migrateRetiredGptModels.js'
)

beforeEach(() => {
  originalConfigDir = process.env.CLAUDE_CONFIG_DIR
  settingsDir = mkdtempSync(join(tmpdir(), 'retired-gpt-models-'))
  process.env.CLAUDE_CONFIG_DIR = settingsDir
  getClaudeConfigHomeDir.cache.clear()
  resetSettingsCache()
  mainLoopOverride = undefined
  mainLoopOverrideWrites = []
})

afterEach(() => {
  if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = originalConfigDir
  getClaudeConfigHomeDir.cache.clear()
  resetSettingsCache()
  rmSync(settingsDir, { recursive: true, force: true })
  mock.restore()
})

describe('migrateRetiredGptModels', () => {
  test('remaps every user-owned model surface and de-duplicates the resulting allowlist', () => {
    setUserSettings({
      model: 'gpt-5.6-sol',
      availableModels: [
        'gpt-6-sol',
        'gpt-5.6-sol',
        'gpt-5.6-luna',
        'gpt-5.4',
        'gpt-5.3-codex',
        'gpt-5.5',
        'gpt-5.6-terra',
        'custom-model',
      ],
      modelOverrides: {
        'gpt-6-sol': 'legacy-current-sol-override',
        'gpt-5.6-sol': 'legacy-sol-override',
        'gpt-5.4': 'legacy-luna-override',
        'gpt-5.5': 'legacy-terra-override',
        'gpt-5.6-terra': 'existing-terra-override',
        'custom-model': 'custom-override',
      },
    })

    migrateRetiredGptModels()

    expect(getSettingsForSource('userSettings')).toEqual({
      model: 'gpt-6.1-sol',
      availableModels: ['gpt-6.1-sol', 'gpt-6-luna', 'gpt-5.6-terra', 'custom-model'],
      modelOverrides: {
        'gpt-6.1-sol': 'legacy-current-sol-override',
        'gpt-6-luna': 'legacy-luna-override',
        'gpt-5.6-terra': 'existing-terra-override',
        'custom-model': 'custom-override',
      },
    })
  })

  test('preserves current successor overrides when colliding with retired model overrides', () => {
    setUserSettings({
      model: 'gpt-5.6-luna',
      availableModels: ['gpt-6-sol', 'gpt-6.1-sol', 'gpt-5.6-sol', 'gpt-6-luna', 'gpt-5.6-luna'],
      modelOverrides: {
        'gpt-6-sol': 'keep-current-sol',
        'gpt-6.1-sol': 'keep-current-sol-successor',
        'gpt-5.6-sol': 'retired-sol',
        'gpt-6-luna': 'keep-current-luna',
        'gpt-5.6-luna': 'retired-luna',
        'custom-model': 'keep-custom',
      },
    })

    migrateRetiredGptModels()

    expect(getSettingsForSource('userSettings')).toEqual({
      model: 'gpt-6-luna',
      availableModels: ['gpt-6.1-sol', 'gpt-6-luna'],
      modelOverrides: {
        'gpt-6.1-sol': 'keep-current-sol-successor',
        'gpt-6-luna': 'keep-current-luna',
        'custom-model': 'keep-custom',
      },
    })
  })

  test('migrates the runtime main-loop override and is idempotent on a second startup', () => {
    setUserSettings({
      model: 'gpt-5.5',
      availableModels: ['gpt-5.5', 'gpt-5.6-terra'],
      modelOverrides: { 'gpt-5.5': 'legacy-terra-override' },
    })
    mainLoopOverride = 'gpt-5.6-sol[1m]'

    migrateRetiredGptModels()
    migrateRetiredGptModels()

    expect(getSettingsForSource('userSettings')).toEqual({
      model: 'gpt-5.6-terra',
      availableModels: ['gpt-5.6-terra'],
      modelOverrides: { 'gpt-5.6-terra': 'legacy-terra-override' },
    })
    expect(mainLoopOverrideWrites).toEqual(['gpt-6.1-sol'])
    expect(mainLoopOverride).toBe('gpt-6.1-sol')
  })
})

function setUserSettings(settings: SettingsJson): void {
  const result = updateSettingsForSource('userSettings', settings)
  expect(result.error).toBeNull()
  resetSettingsCache()
}

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
    "import { migrateRetiredGptModels } from './migrateRetiredGptModels.js'",
  )
  expect(ownerSource).toContain('const retiredGptError = migrateRetiredGptModels()')
  expect(ownerSource).toContain('if (retiredGptError) return retiredGptError')
  expect(initSource).toContain('await runEngineMigrations()')
})
