import { expect, test } from 'bun:test'

test('saveGlobalConfig reports writes and no-ops without touching disk', async () => {
  const previousNodeEnv = process.env.NODE_ENV
  process.env.NODE_ENV = 'test'
  const { getGlobalConfig, saveGlobalConfig } = await import('./config.js')
  const previousStartups = getGlobalConfig().numStartups

  try {
    expect(saveGlobalConfig(current => current)).toBe(false)
    expect(
      saveGlobalConfig(current => ({
        ...current,
        numStartups: previousStartups + 1,
      })),
    ).toBe(true)
  } finally {
    saveGlobalConfig(current => ({
      ...current,
      numStartups: previousStartups,
    }))
    if (previousNodeEnv === undefined) {
      delete process.env.NODE_ENV
    } else {
      process.env.NODE_ENV = previousNodeEnv
    }
  }
})
