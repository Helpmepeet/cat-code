import { afterEach, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runSettingsWriteWorker } from '../main/settingsWriteRunner.js'

const scratch: string[] = []
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  scratch.push(dir)
  return dir
}

test('settings write persists to the named project with no chat session', async () => {
  const cwd = temp('catcode-settings-write-project-')
  const configHome = temp('catcode-settings-write-config-')
  const result = await runSettingsWriteWorker({
    command: process.execPath,
    args: ['run', join(import.meta.dir, 'settingsWriteWorker.ts')],
    cwd,
    env: {
      CLAUDE_CONFIG_DIR: configHome,
      HOME: configHome,
      ANTHROPIC_API_KEY: '',
      OPENAI_API_KEY: '',
    },
    request: {
      type: 'settings-write',
      version: 1,
      verb: {
        type: 'settings.setValue',
        requestId: 'save-without-session',
        source: 'projectSettings',
        key: 'includeCoAuthoredBy',
        value: false,
      },
    },
  })
  expect(result).toEqual({
    type: 'settings-write-result',
    version: 1,
    requestId: 'save-without-session',
    ok: true,
    changed: true,
    message: 'Setting saved.',
  })
  const saved = JSON.parse(readFileSync(join(cwd, '.cat-code', 'settings.json'), 'utf8'))
  expect(saved.includeCoAuthoredBy).toBe(false)
}, 60_000)
