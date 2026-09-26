import { afterEach, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { runSettingsInventoryWorker } from '../main/settingsInventoryRunner.js'
import type { SettingsInventory } from '../shared/settingsInventoryWorker.js'

const scratch: string[] = []
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function temp(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  scratch.push(dir)
  return dir
}

test('inventory reads project skills and agents without opening a session', async () => {
  const cwd = temp('catcode-inventory-project-')
  const configHome = temp('catcode-inventory-config-')
  mkdirSync(join(cwd, '.cat-code', 'skills', 'reviewer'), { recursive: true })
  mkdirSync(join(cwd, '.cat-code', 'agents'), { recursive: true })
  mkdirSync(join(configHome, 'skills', 'personal'), { recursive: true })
  writeFileSync(join(cwd, '.cat-code', 'skills', 'reviewer', 'SKILL.md'),
    '---\nname: reviewer\ndescription: Review changed files\n---\nReview the changes.\n')
  writeFileSync(join(cwd, '.cat-code', 'agents', 'audit.md'),
    '---\nname: audit\ndescription: Audit this project\ntools: Read, Grep\n---\nAudit the project.\n')
  writeFileSync(join(configHome, 'skills', 'personal', 'SKILL.md'),
    '---\nname: personal\ndescription: Personal notes\n---\nRead personal notes.\n')
  writeFileSync(join(cwd, '.cat-code', 'settings.json'),
    JSON.stringify({ includeCoAuthoredBy: false }))
  writeFileSync(join(cwd, 'CLAUDE.md'), 'Project instructions for the probe.\n')
  const received: { value: SettingsInventory | null } = { value: null }
  const outcome = await runSettingsInventoryWorker({
    command: process.execPath,
    args: ['run', join(import.meta.dir, 'settingsInventoryWorker.ts')],
    cwd,
    env: {
      CLAUDE_CONFIG_DIR: configHome,
      HOME: configHome,
      ANTHROPIC_API_KEY: '',
      OPENAI_API_KEY: '',
    },
    onInventory: value => { received.value = value },
  })
  expect(outcome).toBe('delivered')
  const inventory = received.value
  if (inventory === null) throw new Error('inventory was not delivered')
  expect(inventory.extensions.skills?.some(skill => skill.name === 'reviewer')).toBe(true)
  expect(inventory.extensions.skills?.some(skill => skill.name === 'personal')).toBe(true)
  expect(inventory.agents.definitions.some(agent => agent.agentType === 'audit')).toBe(true)
  expect(inventory.settings?.editableValues.some(
    value => value.key === 'includeCoAuthoredBy' && value.value === false && value.source === 'projectSettings',
  )).toBe(true)
  expect(inventory.memory?.instructionFiles.some(
    file => file.path.endsWith('/CLAUDE.md') && file.type === 'Project',
  )).toBe(true)
}, 60_000)
