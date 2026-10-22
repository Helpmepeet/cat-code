import { expect, test } from 'bun:test'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { generatedWelcomeCats } from './generatedWelcomeCats.js'

test('Welcome rotation includes one optimized display asset for every generated PNG', () => {
  const source = readFileSync(new URL('./generatedWelcomeCats.ts', import.meta.url), 'utf8')
  const imports = [...source.matchAll(/from '(\.\/assets\/generated-welcome-cats\/[^']+)'/g)]
  const sourceNames = readdirSync(new URL('./assets/generated-welcome-cats/', import.meta.url))
    .filter(name => name.endsWith('.png'))
    .map(name => name.slice(0, -'.png'.length))
    .sort()
  const importNames = imports.map(match => match[1]!.split('/').at(-1)!.replace(/\.webp$/, '')).sort()
  expect(importNames).toEqual(sourceNames)
  expect(generatedWelcomeCats).toHaveLength(sourceNames.length)
  expect(new Set(generatedWelcomeCats).size).toBe(sourceNames.length)
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
  expect(total).toBeLessThan(2_500_000)
})
