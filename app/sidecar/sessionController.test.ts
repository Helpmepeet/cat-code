import { expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { AppSessionController } from '../../src/app-runtime/AppSessionController.js'
import { resetSettingsCache } from '../../src/utils/settings/settingsCache.js'
import {
  createNormalSidecarQueryEngineConfig,
  createSidecarSessionController,
  loadSidecarToolPermissionContext,
} from './sessionController.js'

test('normal startup exposes the permission-context tools to the model', async () => {
  const { queryEngineConfig } = await createNormalSidecarQueryEngineConfig(
    process.cwd(),
  )

  expect(queryEngineConfig.tools.length).toBeGreaterThan(0)
  expect(queryEngineConfig.tools.some(tool => tool.name === 'Bash')).toBe(true)
})

test('normal startup roots the engine config at the caller-supplied cwd (P1_1_CWD retired)', async () => {
  // The P1-1 hardcode is gone: the cwd is now an argument threaded from the
  // sidecar's CATCODE_SIDECAR_CWD env, not a pinned literal.
  const cwd = process.cwd()
  const { queryEngineConfig } = await createNormalSidecarQueryEngineConfig(cwd)
  expect(queryEngineConfig.cwd).toBe(cwd)
})

test('normal startup constructs a real runtime-backed controller without starting a turn', async () => {
  const { controller, permissions } = await createSidecarSessionController({
    probe: false,
    cwd: process.cwd(),
  })

  expect(controller).toBeInstanceOf(AppSessionController)
  expect(permissions).not.toBeNull()
  expect(controller.getAbortState()).toEqual({ status: 'idle' })
  expect(controller.getGoalSnapshot()).toBeNull()
  expect(controller.getPendingPermissionRequests()).toEqual([])
})

test('probe startup has no permission domain (no engine app-state store)', async () => {
  const { permissions } = await createSidecarSessionController({
    probe: true,
    cwd: process.cwd(),
  })
  expect(permissions).toBeNull()
})

test('PERMISSION-BOUNDARY §8 fix — settings rules and defaultMode actually load', async () => {
  // The P1-2..P2-3 sidecar built its context from getEmptyToolPermissionContext,
  // so settings-file rules were silently never in effect (same defect class as
  // P1-3's `tools: []`). Prove the loader reads real settings: inject a user
  // settings file via CLAUDE_CONFIG_DIR (the engine's own override, memoize-keyed
  // on the env var) and assert the rules and defaultMode land in the context.
  const configDir = mkdtempSync(join(tmpdir(), 'catcode-p2-4-settings-'))
  const previousConfigDir = process.env.CLAUDE_CONFIG_DIR
  try {
    writeFileSync(
      join(configDir, 'settings.json'),
      JSON.stringify({
        permissions: {
          allow: ['Bash(catcode-p2-4-proof:*)'],
          deny: ['WebSearch'],
          defaultMode: 'acceptEdits',
        },
      }),
    )
    process.env.CLAUDE_CONFIG_DIR = configDir
    resetSettingsCache()

    const context = await loadSidecarToolPermissionContext()

    expect(context.alwaysAllowRules.userSettings).toContain(
      'Bash(catcode-p2-4-proof:*)',
    )
    expect(context.alwaysDenyRules.userSettings).toContain('WebSearch')
    expect(context.mode).toBe('acceptEdits')
    // §3 pin: no trusted desktop grant surface exists for bypass, so the
    // loader must keep the engine-side availability backstop OFF regardless
    // of what settings policy alone would report.
    expect(context.isBypassPermissionsModeAvailable).toBe(false)
  } finally {
    if (previousConfigDir === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR
    } else {
      process.env.CLAUDE_CONFIG_DIR = previousConfigDir
    }
    resetSettingsCache()
    rmSync(configDir, { recursive: true, force: true })
  }
})
