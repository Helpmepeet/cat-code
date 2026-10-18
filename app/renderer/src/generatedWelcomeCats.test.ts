import { expect, test } from 'bun:test'
import { readFileSync, statSync } from 'node:fs'
import { generatedWelcomeCats } from './generatedWelcomeCats.js'

test('Welcome rotation loads only the 28 optimized static display assets', () => {
  const source = readFileSync(new URL('./generatedWelcomeCats.ts', import.meta.url), 'utf8')
  const imports = [...source.matchAll(/from '(\.\/assets\/generated-welcome-cats\/[^']+)'/g)]
  expect(imports).toHaveLength(28)
  expect(generatedWelcomeCats).toHaveLength(28)
  expect(new Set(generatedWelcomeCats).size).toBe(28)
  expect(source).not.toContain('import.meta.glob')
  let total = 0
  for (const match of imports) {
    const path = match[1]!
    expect(path.endsWith('.webp')).toBe(true)
    const file = new URL(path, import.meta.url)
    const header = readFileSync(file).subarray(0, 12)
    expect(header.subarray(0, 4).toString()).toBe('RIFF')
    expect(header.subarray(8, 12).toString()).toBe('WEBP')
    total += statSync(file).size
  }
  expect(total).toBeLessThan(1_000_000)
})
