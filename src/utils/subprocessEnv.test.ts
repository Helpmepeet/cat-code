import { afterEach, describe, expect, test } from 'bun:test'

import { subprocessEnv } from './subprocessEnv.js'

const envKeys = [
  'CLAUDE_CODE_SUBPROCESS_ENV_SCRUB',
  'EXA_API_KEY',
  'INPUT_EXA_API_KEY',
  'CATCODE_SIDECAR_FRESH_SESSION_ID',
  'CATCODE_SIDECAR_RESUME_SESSION_ID',
  'CATCODE_SIDECAR_MODEL',
  'CATCODE_SIDECAR_PREFER_SPAWN_MODEL',
  'CATCODE_SIDECAR_CWD',
  'CATCODE_SESSION_BINDING_JSON',
] as const
const originalEnv = Object.fromEntries(
  envKeys.map(key => [key, process.env[key]]),
) as Record<(typeof envKeys)[number], string | undefined>

function restoreEnv(): void {
  for (const key of envKeys) {
    const value = originalEnv[key]
    if (value === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = value
    }
  }
}

describe('subprocessEnv', () => {
  afterEach(() => {
    restoreEnv()
  })

  test('scrubs EXA_API_KEY from subprocesses when scrub mode is enabled', () => {
    process.env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB = '1'
    process.env.EXA_API_KEY = 'secret-exa-key'
    process.env.INPUT_EXA_API_KEY = 'secret-input-exa-key'

    const env = subprocessEnv()

    expect(env.EXA_API_KEY).toBeUndefined()
    expect(env.INPUT_EXA_API_KEY).toBeUndefined()
    expect(process.env.EXA_API_KEY).toBe('secret-exa-key')
  })

  for (const scrub of ['0', '1']) {
    test(`isolates sidecar bootstrap independently of secret scrub mode (${scrub})`, () => {
      process.env.CLAUDE_CODE_SUBPROCESS_ENV_SCRUB = scrub
      const bootstrap = {
        CATCODE_SIDECAR_FRESH_SESSION_ID: 'parent-fresh',
        CATCODE_SIDECAR_RESUME_SESSION_ID: 'parent-resume',
        CATCODE_SIDECAR_MODEL: 'parent-model',
        CATCODE_SIDECAR_PREFER_SPAWN_MODEL: '1',
        CATCODE_SIDECAR_CWD: '/parent/workspace',
        CATCODE_SESSION_BINDING_JSON: '{"kind":"managed"}',
      }
      Object.assign(process.env, bootstrap)
      const env = subprocessEnv()
      for (const [key, value] of Object.entries(bootstrap)) {
        expect(env[key]).toBeUndefined()
        expect(process.env[key]).toBe(value)
      }
      // Explicit launch configuration can still be added by a process owner.
      const child = Bun.spawnSync([process.execPath, '-e', 'process.stdout.write(JSON.stringify({ model: process.env.CATCODE_SIDECAR_MODEL, fresh: process.env.CATCODE_SIDECAR_FRESH_SESSION_ID, binding: process.env.CATCODE_SESSION_BINDING_JSON }))'], {
        env: { ...env, CATCODE_SIDECAR_MODEL: 'child-model' },
      })
      expect(child.exitCode).toBe(0)
      expect(JSON.parse(child.stdout.toString())).toEqual({ model: 'child-model' })
    })
  }
})
