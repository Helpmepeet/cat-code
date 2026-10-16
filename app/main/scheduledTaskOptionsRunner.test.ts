import { afterEach, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runScheduledTaskOptionsWorker } from './scheduledTaskOptionsRunner.js'
const directories: string[] = []
afterEach(() => { for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true }) })
function isolated() {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'scheduled-options-')))
  directories.push(dir)
  const config = join(dir, 'config')
  const project = join(dir, 'project')
  for (const path of [config, project]) mkdirSync(path)
  return { dir, config, project }
}
test('real observation worker reads engine models and saved projects with no project hooks', async () => {
  const h = isolated()
  const marker = join(h.dir, 'hook-ran')
  writeFileSync(join(h.config, '.config.json'), JSON.stringify({ projects: { [h.project]: { hasTrustDialogAccepted: true } } }))
  mkdirSync(join(h.project, '.claude'))
  writeFileSync(join(h.project, '.claude', 'settings.json'), JSON.stringify({ hooks: {
    SessionStart: [{ hooks: [{ type: 'command', command: `touch '${marker}'` }] }],
  } }))
  const result = await runScheduledTaskOptionsWorker({ command: process.execPath,
    log: line => console.error(line),
    args: [fileURLToPath(new URL('../sidecar/scheduledTaskOptionsWorker.ts', import.meta.url))], cwd: h.dir,
    env: { HOME: h.dir, NODE_ENV: 'production', CLAUDE_CONFIG_DIR: h.config,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_TELEMETRY: '1', ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '' },
  })
  expect(result.projectPaths).toEqual([h.project])
  expect(result.models.length).toBeGreaterThan(0)
  expect(result.models.every(model => model.effortOptions.every(effort => typeof effort === 'string'))).toBe(true)
  expect(existsSync(marker)).toBe(false)
}, 20_000)

test.each([
  '{"type":"scheduled-options-result","version":1,"models":[],"defaultEffortOptions":[],"projectPaths":[],"extra":true}',
  '{}',
  '{"type":"scheduled-options-result","version":1,"models":[],"defaultEffortOptions":[],"projectPaths":[]}\n{"type":"scheduled-options-result","version":1,"models":[],"defaultEffortOptions":[],"projectPaths":[]}',
])('worker refuses malformed or duplicate records', async output => {
  const h = isolated()
  await expect(runScheduledTaskOptionsWorker({ command: process.execPath,
    args: ['-e', 'process.stdout.write(process.env.OPTIONS_FIXTURE + "\\n")'], cwd: h.dir,
    env: { HOME: h.dir, CLAUDE_CONFIG_DIR: h.config, OPTIONS_FIXTURE: output },
  })).rejects.toThrow('Scheduled task options could not be read')
})
