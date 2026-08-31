import { feature } from 'bun:bundle'
import { afterEach, describe, expect, mock, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { AppState } from '../../state/AppState.js'
import type { ToolPermissionContext } from '../../Tool.js'
import { _resetForTesting, setAutoModeActive } from '../permissions/autoModeState.js'
import { pathInAllowedWorkingPath } from '../permissions/filesystem.js'
import type { PermissionRule } from '../permissions/PermissionRule.js'
import { permissionRuleValueFromString } from '../permissions/permissionRuleParser.js'
import type { SettingsJson } from './types.js'

/**
 * `feature()` is false under a plain `bun test`, so the auto-mode branches are
 * dead there. `bun test --feature=TRANSCRIPT_CLASSIFIER` compiles them in — the
 * same switch `scripts/build.ts` passes to `bun build` for the default set.
 * The directory-reconciliation tests below are not feature-gated and run in
 * both configurations.
 */
const CLASSIFIER_COMPILED_IN = ((): boolean => {
  if (feature('TRANSCRIPT_CLASSIFIER')) {
    return true
  }
  return false
})()

function permissionContext(
  overrides: Partial<ToolPermissionContext>,
): ToolPermissionContext {
  return {
    mode: 'default',
    additionalWorkingDirectories: new Map(),
    alwaysAllowRules: {},
    alwaysDenyRules: {},
    alwaysAskRules: {},
    isBypassPermissionsModeAvailable: false,
    ...overrides,
  }
}

function allowRule(source: string, ruleString: string): PermissionRule {
  return {
    source,
    ruleBehavior: 'allow',
    ruleValue: permissionRuleValueFromString(ruleString),
  } as PermissionRule
}

/**
 * Drives the real applySettingsChange with the settings snapshot and the disk
 * rules the settings watcher would have seen, and returns the resulting
 * context. Only the three disk reads are mocked; every permission decision in
 * between is the production code path.
 */
async function runSettingsChange({
  context,
  previousSettings,
  nextSettings,
  diskRules,
}: {
  context: ToolPermissionContext
  previousSettings: SettingsJson
  nextSettings: SettingsJson
  diskRules: PermissionRule[]
}): Promise<ToolPermissionContext> {
  const realSettings = await import('./settings.js')
  const realLoader = await import('../permissions/permissionsLoader.js')

  await mock.module('./settings.js', () => ({
    ...realSettings,
    getInitialSettings: () => nextSettings,
    // shouldPlanUseAutoMode() reads these; pin them so the plan branch does
    // not depend on the developer's own settings files.
    hasAutoModeOptIn: () => true,
    getUseAutoModeDuringPlan: () => true,
  }))
  await mock.module('../permissions/permissionsLoader.js', () => ({
    ...realLoader,
    loadAllPermissionRulesFromDisk: () => diskRules,
  }))
  await mock.module('../hooks/hooksConfigSnapshot.js', () => ({
    updateHooksConfigSnapshot: () => {},
  }))

  const { applySettingsChange } = await import('./applySettingsChange.js')

  let state = {
    settings: previousSettings,
    toolPermissionContext: context,
  } as unknown as AppState
  applySettingsChange('localSettings', updater => {
    state = updater(state)
  })
  return state.toolPermissionContext
}

afterEach(() => {
  _resetForTesting()
  mock.restore()
})

describe('applySettingsChange auto-mode re-strip', () => {
  // syncPermissionRulesFromDisk replaces every disk source from disk, undoing
  // the in-memory strip auto mode performed at entry. transitionPlanAutoMode
  // repaired that for plan+auto only, so a settings write from any source (a
  // concurrent session persisting an always-allow, an editor save) silently
  // handed the model back a classifier-bypassing allow rule for the rest of
  // the session.
  test.if(CLASSIFIER_COMPILED_IN)(
    'direct auto mode does not get its dangerous allow rules back',
    async () => {
      setAutoModeActive(true)
      const result = await runSettingsChange({
        context: permissionContext({
          mode: 'auto',
          alwaysAllowRules: { localSettings: [] },
          strippedDangerousRules: { localSettings: ['Bash(python3:*)'] },
        }),
        previousSettings: {} as SettingsJson,
        nextSettings: {} as SettingsJson,
        diskRules: [
          allowRule('localSettings', 'Bash(python3:*)'),
          allowRule('localSettings', 'Bash(ls:*)'),
        ],
      })

      expect(result.alwaysAllowRules.localSettings).not.toContain(
        'Bash(python3:*)',
      )
      // The benign rule from the same source must still land, or the strip is
      // just discarding the reload.
      expect(result.alwaysAllowRules.localSettings).toContain('Bash(ls:*)')
      // Still restorable when the user leaves auto mode.
      expect(result.strippedDangerousRules?.localSettings).toContain(
        'Bash(python3:*)',
      )
    },
  )

  test.if(CLASSIFIER_COMPILED_IN)(
    'plan mode with auto active still re-strips exactly once',
    async () => {
      setAutoModeActive(true)
      const result = await runSettingsChange({
        context: permissionContext({
          mode: 'plan',
          prePlanMode: 'default',
          alwaysAllowRules: { localSettings: [] },
          strippedDangerousRules: { localSettings: ['Bash(python3:*)'] },
        }),
        previousSettings: {} as SettingsJson,
        nextSettings: {} as SettingsJson,
        diskRules: [
          allowRule('localSettings', 'Bash(python3:*)'),
          allowRule('localSettings', 'Bash(ls:*)'),
        ],
      })

      expect(result.mode).toBe('plan')
      expect(result.alwaysAllowRules.localSettings).not.toContain(
        'Bash(python3:*)',
      )
      expect(result.alwaysAllowRules.localSettings).toContain('Bash(ls:*)')
      expect(result.strippedDangerousRules?.localSettings).toEqual([
        'Bash(python3:*)',
      ])
    },
  )

  test.if(CLASSIFIER_COMPILED_IN)(
    'default mode keeps the rules the user allowed',
    async () => {
      const result = await runSettingsChange({
        context: permissionContext({ mode: 'default' }),
        previousSettings: {} as SettingsJson,
        nextSettings: {} as SettingsJson,
        diskRules: [allowRule('localSettings', 'Bash(python3:*)')],
      })

      expect(result.alwaysAllowRules.localSettings).toContain('Bash(python3:*)')
      expect(result.strippedDangerousRules).toBeUndefined()
    },
  )
})

describe('applySettingsChange additionalDirectories reconciliation', () => {
  const created: string[] = []

  function tempDirectory(): string {
    const dir = mkdtempSync(join(tmpdir(), 'catcode-add-dir-'))
    created.push(dir)
    return dir
  }

  afterEach(() => {
    while (created.length > 0) {
      rmSync(created.pop()!, { recursive: true, force: true })
    }
  })

  function settingsWithDirectories(directories: string[]): SettingsJson {
    return { permissions: { additionalDirectories: directories } } as SettingsJson
  }

  // Several sessions share one settings file. Before this, a directory the
  // settings no longer list stayed authorized in every already-running session
  // until restart, because applySettingsChange reloaded rules, hooks, bypass
  // availability and plan/auto state but never the working directories.
  test('a directory removed from settings stops being a working directory', async () => {
    const dir = tempDirectory()
    const result = await runSettingsChange({
      context: permissionContext({
        additionalWorkingDirectories: new Map([
          [dir, { path: dir, source: 'localSettings' }],
        ]),
      }),
      previousSettings: settingsWithDirectories([dir]),
      nextSettings: settingsWithDirectories([]),
      diskRules: [],
    })

    expect(result.additionalWorkingDirectories.has(dir)).toBe(false)
    expect(pathInAllowedWorkingPath(join(dir, 'f'), result)).toBe(false)
  })

  test('a directory settings still list stays authorized', async () => {
    const dir = tempDirectory()
    const result = await runSettingsChange({
      context: permissionContext({
        additionalWorkingDirectories: new Map([
          [dir, { path: dir, source: 'localSettings' }],
        ]),
      }),
      previousSettings: settingsWithDirectories([dir]),
      nextSettings: settingsWithDirectories([dir]),
      diskRules: [],
    })

    expect(result.additionalWorkingDirectories.has(dir)).toBe(true)
    expect(pathInAllowedWorkingPath(join(dir, 'f'), result)).toBe(true)
  })

  // Session-only grants (/add-dir without remember, the process PWD symlink)
  // were never in settings, so a settings write must not revoke them.
  test('a session-only directory survives an unrelated settings change', async () => {
    const sessionDir = tempDirectory()
    const removedDir = tempDirectory()
    const result = await runSettingsChange({
      context: permissionContext({
        additionalWorkingDirectories: new Map([
          [sessionDir, { path: sessionDir, source: 'session' }],
          [removedDir, { path: removedDir, source: 'localSettings' }],
        ]),
      }),
      previousSettings: settingsWithDirectories([removedDir]),
      nextSettings: settingsWithDirectories([]),
      diskRules: [],
    })

    expect(result.additionalWorkingDirectories.has(sessionDir)).toBe(true)
    expect(result.additionalWorkingDirectories.has(removedDir)).toBe(false)
  })

  // Deliberate: additions are not applied here. Startup grants a directory
  // only after an async fs check this synchronous reducer cannot run, and a
  // settings write from another process should not widen this session's
  // workspace on its own.
  test('a directory newly added to settings is not granted without validation', async () => {
    const dir = tempDirectory()
    const result = await runSettingsChange({
      context: permissionContext({}),
      previousSettings: settingsWithDirectories([]),
      nextSettings: settingsWithDirectories([dir]),
      diskRules: [],
    })

    expect(result.additionalWorkingDirectories.has(dir)).toBe(false)
  })
})
