import { afterEach, describe, expect, test } from 'bun:test'

import { subprocessEnv } from './subprocessEnv.js'

const envKeys = [
  'CLAUDE_CODE_SUBPROCESS_ENV_SCRUB',
  'EXA_API_KEY',
  'INPUT_EXA_API_KEY',
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
})
