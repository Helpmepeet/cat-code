import { afterEach, expect, test } from 'bun:test'
import { randomUUID } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runSessionRelocationWorker } from '../main/sessionRelocationRunner.js'
import { readSessionRelocation } from '../../src/utils/sessionRelocationState.js'
import type { SessionLocation } from '../../src/utils/sessionRelocationState.js'

const here = dirname(fileURLToPath(import.meta.url))
const minter = join(here, '..', 'sidecar', 'mintTranscript.fixture.ts')
const outputWriter = join(here, '..', 'sidecar', 'relocationOutput.probe.fixture.ts')
const resumeProbe = join(here, '..', 'sidecar', 'resumeProbe.fixture.ts')
const worker = join(here, '..', 'sidecar', 'sessionRelocationWorker.ts')
const originalConfigDir = process.env.CLAUDE_CONFIG_DIR
let root: string | null = null

afterEach(() => {
  if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = originalConfigDir
  if (root) rmSync(root, { recursive: true, force: true })
  root = null
})

async function fixture(script: string, args: string[], cwd: string, configHome: string, blocker: string): Promise<string> {
  const child = Bun.spawn(['bun', `--preload=${blocker}`, 'run', script, ...args], {
    cwd,
    env: { ...process.env, CLAUDE_CONFIG_DIR: configHome, TEST_ENABLE_SESSION_PERSISTENCE: '1', NODE_ENV: 'development' },
    stdout: 'pipe', stderr: 'pipe',
  })
  const [code, stdout, stderr] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
  ])
  if (code !== 0) throw new Error(stderr)
  return stdout
}

function outputPath(stdout: string, key: string): string {
  const path = stdout.split('\n').find(line => line.startsWith(`${key}=`))?.slice(key.length + 1)
  if (!path) throw new Error(`Missing ${key}`)
  return path
}

test('repeated project corrections retain old outputs and rollback drops only its uncommitted boundary', async () => {
  root = mkdtempSync(join(tmpdir(), 'catcode-relocation-repeat-'))
  const configHome = join(root, 'config')
  const chatCwd = realpathSync(root)
  const projectA = join(root, 'project-a')
  const projectB = join(root, 'project-b')
  mkdirSync(configHome)
  mkdirSync(projectA)
  mkdirSync(projectB)
  const blocker = join(root, 'block-network.ts')
  writeFileSync(blocker, 'globalThis.fetch = (async () => new Response("Network disabled", { status: 503 })) as typeof fetch\n')
  process.env.CLAUDE_CONFIG_DIR = configHome
  writeFileSync(join(configHome, '.config.json'), JSON.stringify({ projects: {
    [realpathSync(projectA)]: { hasTrustDialogAccepted: true },
    [realpathSync(projectB)]: { hasTrustDialogAccepted: true },
  } }))

  const engineSessionId = randomUUID()
  const appSessionId = randomUUID()
  const chat: SessionLocation = { cwd: chatCwd, binding: {
    kind: 'managed', storageRootId: randomUUID(), storageId: randomUUID(),
  } }
  const a: SessionLocation = { cwd: realpathSync(projectA), binding: { kind: 'project' } }
  const b: SessionLocation = { cwd: realpathSync(projectB), binding: { kind: 'project' } }
  const chatFile = join(chat.cwd, 'chat-working-file.txt')
  writeFileSync(chatFile, 'Made in Chat')
  const minted = await fixture(minter, [engineSessionId, 'repeat-move', '--saved-output', '--realistic-tail'], chat.cwd, configHome, blocker)
  const chatOutput = outputPath(minted, 'MINTED_OUTPUT_PATH')
  const chatTranscript = outputPath(minted, 'MINTED_TRANSCRIPT_PATH')
  const assistantId = readFileSync(chatTranscript, 'utf8').split('\n').flatMap(line => {
    if (!line) return []
    const entry = JSON.parse(line) as { type?: string; uuid?: string }
    return entry.type === 'assistant' && entry.uuid ? [entry.uuid] : []
  }).at(-1)
  if (!assistantId) throw new Error('Fixture did not persist an assistant frame')
  async function move(source: SessionLocation, target: SessionLocation, rollback = false): Promise<void> {
    await runSessionRelocationWorker({
      command: 'bun', args: [`--preload=${blocker}`, 'run', worker], cwd: source.cwd,
      request: { type: 'session-relocation', version: 1, appSessionId, engineSessionId,
        source, target, controls: { mode: 'default' }, ...(rollback ? { rollback: true as const } : {}) },
      env: { CLAUDE_CONFIG_DIR: configHome, NODE_ENV: 'development' },
    })
  }

  await move(chat, a)
  const aOutput = outputPath(await fixture(outputWriter, [engineSessionId, 'from-a'], a.cwd, configHome, blocker), 'OUTPUT_PATH')
  await move(a, chat)
  await move(chat, b)
  expect(readFileSync(aOutput, 'utf8')).toBe('from-a')
  await move(b, chat)
  await move(chat, a)

  const record = readSessionRelocation(engineSessionId)
  expect(record?.phase).toBe('complete')
  expect(record?.appSessionId).toBe(appSessionId)
  expect(record?.engineSessionId).toBe(engineSessionId)
  expect(record?.original).toEqual(chat)
  expect(record?.target).toEqual(a)
  expect(record?.transitions?.map(item => item.target.cwd)).toEqual([a.cwd, chat.cwd, b.cwd, chat.cwd, a.cwd])
  expect(record?.transitions?.map(item => item.afterFrameId)).toEqual(Array(5).fill(assistantId))
  expect(existsSync(chatTranscript)).toBe(false)
  expect(readFileSync(chatOutput, 'utf8')).toContain('repeat-move')
  expect(readFileSync(aOutput, 'utf8')).toBe('from-a')
  expect(readFileSync(chatFile, 'utf8')).toBe('Made in Chat')
  expect(existsSync(join(a.cwd, 'chat-working-file.txt'))).toBe(false)
  expect(existsSync(join(b.cwd, 'chat-working-file.txt'))).toBe(false)
  expect(lstatSync(join(dirname(chatTranscript), engineSessionId)).isSymbolicLink()).toBe(true)
  await move(a, chat, true)
  const rolledBack = readSessionRelocation(engineSessionId)
  expect(rolledBack?.target).toEqual(chat)
  expect(rolledBack?.transitions?.map(item => item.target.cwd)).toEqual([a.cwd, chat.cwd, b.cwd, chat.cwd])
  expect(existsSync(chatTranscript)).toBe(true)
  expect(readFileSync(aOutput, 'utf8')).toBe('from-a')

  await move(chat, a)
  await fixture(minter, [engineSessionId, 'compacted-a', '--compacted', '--recent-compacted', '--relocation-skills'], a.cwd, configHome, blocker)
  await move(a, chat)
  await move(chat, b)
  const resumed = await fixture(resumeProbe, [engineSessionId, 'compacted-a'], b.cwd, configHome, blocker)
  const payload = JSON.parse(outputPath(resumed, 'RESUME_RESULT')) as {
    hasCompactBoundary: boolean
    invokedSkillPaths: string[]
    historyCwd: string
  }
  expect(payload.hasCompactBoundary).toBe(true)
  expect(payload.historyCwd).toBe(b.cwd)
  expect(payload.invokedSkillPaths.some(path => path.startsWith(a.cwd))).toBe(false)
  expect(payload.invokedSkillPaths.some(path => path.startsWith(configHome))).toBe(true)
}, 120_000)
