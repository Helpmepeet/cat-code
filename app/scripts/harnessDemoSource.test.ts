import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'

test('harness demo cleanup is reachable on every exit path', () => {
  const source = readFileSync(new URL('./harness-demo.ts', import.meta.url), 'utf8')

  expect(source).toContain('async function cleanup(): Promise<void>')
  expect(source).toContain('await cleanup()')
  expect(source).toContain('process.exitCode =')
  expect(source).toContain('await main()\nprocess.exit(process.exitCode ?? 0)')
  expect(source.match(/\bprocess\.exit\(/g) ?? []).toHaveLength(1)
  expect(source).toContain('await terminateChild(vite)')
  expect(source).not.toContain('vite.kill()')
  expect(source).toContain("child.kill('SIGTERM')")
  expect(source).toContain("child.kill('SIGKILL')")
})

test('harness demo driver requests Electron shutdown before its forced-exit backstop', () => {
  const source = readFileSync(new URL('./harness-demo-driver.ts', import.meta.url), 'utf8')

  expect(source).toContain('function exitElectron(code: number): void')
  expect(source).toContain('app.quit()')
  expect(source).toContain('process.exitCode = code')
  expect(source).toContain('process.exit(code)')
  expect(source).toContain('exitElectron(0)')
  expect(source).toContain('exitElectron(1)')
})
