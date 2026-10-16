import { afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getCwdState, getOriginalCwd, setCwdState, setOriginalCwd } from '../bootstrap/state.js'
import { resetCwdIfOutsideProject } from '../tools/BashTool/utils.js'
import { exec } from './Shell.js'
import { setWorkspaceTransitionCoordinator } from './workspaceTransition.js'

const originalCwd = getCwdState()
const originalProjectCwd = getOriginalCwd()
const originalConfig = process.env.CLAUDE_CONFIG_DIR
const originalMaintainCwd = process.env.CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR
let root: string
let target: string

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'shell-workspace-transition-')))
  target = join(root, 'target')
  mkdirSync(target)
  process.env.CLAUDE_CONFIG_DIR = join(root, 'config')
  setCwdState(root)
})

afterEach(() => {
  setWorkspaceTransitionCoordinator(null)
  setCwdState(originalCwd)
  setOriginalCwd(originalProjectCwd)
  if (originalMaintainCwd === undefined) delete process.env.CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR
  else process.env.CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR = originalMaintainCwd
  if (originalConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = originalConfig
  rmSync(root, { recursive: true, force: true })
})

test('an independent chat already in its project does not reserve a no-op shell reset', async () => {
  setOriginalCwd(root)
  process.env.CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR = '1'
  setWorkspaceTransitionCoordinator({
    begin: async () => { throw new Error('branch switch reserved') },
    finish: async () => { throw new Error('no transition occurred') },
  })
  expect(await resetCwdIfOutsideProject({} as never)).toBe(false)
  expect(getCwdState()).toBe(root)
})

test('shell result awaits admission and the settled cwd acknowledgement', async () => {
  let admit!: () => void
  let entered!: () => void
  let finish!: () => void
  let settling!: () => void
  const admission = new Promise<void>(resolve => { admit = resolve })
  const inside = new Promise<void>(resolve => { entered = resolve })
  const finished = new Promise<void>(resolve => { finish = resolve })
  const atFinish = new Promise<void>(resolve => { settling = resolve })
  setWorkspaceTransitionCoordinator({
    begin: async () => { entered(); await admission },
    finish: async (_operationId, cwd) => { expect(cwd).toBe(target); settling(); await finished },
  })
  const command = await exec(`cd '${target}'`, new AbortController().signal, 'bash', { timeout: 10_000 })
  let resolved = false
  const result = command.result.then(value => { resolved = true; return value })
  try {
    await inside
    expect(getCwdState()).toBe(root)
    expect(resolved).toBe(false)
    admit()
    await atFinish
    expect(getCwdState()).toBe(target)
    expect(resolved).toBe(false)
    finish()
    expect((await result).code).toBe(0)
    expect(getCwdState()).toBe(target)
  } finally {
    admit(); finish()
    await result
    command.cleanup()
  }
}, 15_000)

test('a checkout reservation refuses shell cwd mutation and reports the refusal', async () => {
  setWorkspaceTransitionCoordinator({
    begin: async () => { throw new Error('branch switch reserved') },
    finish: async () => { throw new Error('must not finish a refused transition') },
  })
  const command = await exec(`cd '${target}'`, new AbortController().signal, 'bash', { timeout: 10_000 })
  try {
    const result = await command.result
    expect(getCwdState()).toBe(root)
    expect(result.stdout).toContain('Could not update the shell working folder: branch switch reserved')
  } finally { command.cleanup() }
}, 15_000)
