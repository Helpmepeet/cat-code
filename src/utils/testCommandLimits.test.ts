import { describe, expect, test } from 'bun:test'
import { getTestCommandLimits } from './testCommandLimits.js'

describe.skipIf(process.platform === 'win32')('finite test command routing', () => {
  test('recognizes direct and package test commands, including a compound launch', () => {
    for (const command of [
      'bun test ./a.test.ts', '/Users/me/.bun/bin/bun test ./a.test.ts',
      'bun run --cwd app test:slow runtime', 'npm test', 'npm run test:unit',
      'pnpm -C app test', 'yarn test', 'cd app && NODE_ENV=test bun test ./a.test.ts',
      'env NODE_ENV=test bun test ./a.test.ts',
    ]) expect(getTestCommandLimits(command)).toBeDefined()
  })
  test('leaves services, quoted mentions, and ordinary commands unchanged', () => {
    for (const command of [
      'bun test --watch', 'bun --hot test', 'npm run test:watch',
      'bun run dev', 'sleep 30', 'echo "bun test"', "rg 'bun test' src/",
      'echo hello > bun test', 'bun run build',
      'bun test && bun run dev', 'bun test && npm run test:watch',
    ]) expect(getTestCommandLimits(command)).toBeUndefined()
  })
})
