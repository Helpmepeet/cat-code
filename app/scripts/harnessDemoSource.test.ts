import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

test('harness demo driver requests Electron shutdown before its forced-exit backstop', () => {
  const source = readFileSync(new URL('./harness-demo-driver.ts', import.meta.url), 'utf8')

  expect(source).toContain('function exitElectron(code: number): void')
  expect(source).toContain('app.quit()')
  expect(source).toContain('process.exitCode = code')
  expect(source).toContain('process.exit(code)')
  expect(source).toContain('exitElectron(0)')
  expect(source).toContain('exitElectron(1)')
})
