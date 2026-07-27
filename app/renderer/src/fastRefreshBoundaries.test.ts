import { expect, test } from 'bun:test'
import { createRequire } from 'node:module'
import { readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const require = createRequire(import.meta.url)
const refreshRuntime = require('react-refresh/runtime') as {
  isLikelyComponentType(value: unknown): boolean
}

const here = dirname(fileURLToPath(import.meta.url))

test('renderer TSX modules export React components only', async () => {
  const failures: string[] = []
  const files = readdirSync(here)
    .filter(
      file =>
        file.endsWith('.tsx') &&
        !file.endsWith('.test.tsx') &&
        file !== 'main.tsx',
    )
    .sort()

  for (const file of files) {
    const module = await import(pathToFileURL(join(here, file)).href)
    for (const [name, value] of Object.entries(module)) {
      if (!refreshRuntime.isLikelyComponentType(value)) {
        failures.push(`${file}: ${name}`)
      }
    }
  }

  expect(failures).toEqual([])
})
