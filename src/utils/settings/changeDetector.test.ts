import { afterEach, expect, test } from 'bun:test'
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { getOriginalCwd, setOriginalCwd } from '../../bootstrap/state.js'
import { initialize, resetForTesting, subscribe } from './changeDetector.js'
import { getSettingsFilePathForSource } from './settings.js'

const scratchDirectories: string[] = []
const originalConfigDir = process.env.CLAUDE_CONFIG_DIR
const originalOriginalCwd = getOriginalCwd()

const FAST_TIMING = {
  stabilityThreshold: 20,
  pollInterval: 10,
  mdmPollInterval: 60 * 60 * 1000,
  deletionGrace: 50,
}

/**
 * Point the settings module's two directory roots (user config home, project
 * cwd) at a fresh temp hierarchy so nothing in this file can reach the real
 * ~/.cat-code. Returns the temp root.
 *
 * realpath: on macOS the tmpdir is a /var → /private/var symlink and fsevents
 * reports the resolved path, so the watched root must be resolved too.
 */
function sandbox(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'change-detector-')))
  scratchDirectories.push(root)
  process.env.CLAUDE_CONFIG_DIR = join(root, 'config')
  setOriginalCwd(join(root, 'project'))
  return root
}

/** Fail loudly if a path we are about to write is not inside the sandbox. */
function assertInside(root: string, path: string | undefined): string {
  expect(path).toBeDefined()
  expect(path!.startsWith(resolve(root) + '/')).toBe(true)
  return path!
}

/**
 * initialize() constructs the watcher but does not await chokidar's `ready`,
 * so the very first write can land before the watcher is armed. Rewrite the
 * file until the expected source is observed rather than writing once and
 * racing.
 */
async function writeUntilSeen(
  path: string,
  seen: string[],
  source: string,
  timeoutMs = 10000,
): Promise<string[]> {
  const deadline = Date.now() + timeoutMs
  let n = 0
  while (!seen.includes(source) && Date.now() < deadline) {
    writeFileSync(path, `{"model":"v${n++}"}\n`)
    for (let i = 0; i < 12 && !seen.includes(source); i++) {
      await new Promise(r => setTimeout(r, 25))
    }
  }
  return seen
}

afterEach(async () => {
  await resetForTesting()
  if (originalConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = originalConfigDir
  setOriginalCwd(originalOriginalCwd)
  for (const directory of scratchDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('watches a settings directory that exists but holds no settings file yet', async () => {
  const root = sandbox()
  const configDir = join(root, 'config')
  mkdirSync(configDir, { recursive: true })

  const settingsPath = assertInside(
    root,
    getSettingsFilePathForSource('userSettings'),
  )
  expect(settingsPath).toBe(join(configDir, 'settings.json'))

  await resetForTesting(FAST_TIMING)
  await initialize()

  const seen: string[] = []
  subscribe(source => {
    seen.push(source)
  })

  expect(await writeUntilSeen(settingsPath, seen, 'userSettings')).toContain(
    'userSettings',
  )
}, 30000)

test('still fires for a settings file that existed at init', async () => {
  const root = sandbox()
  const projectSettingsDir = join(root, 'project', '.cat-code')
  mkdirSync(projectSettingsDir, { recursive: true })

  const settingsPath = assertInside(
    root,
    getSettingsFilePathForSource('projectSettings'),
  )
  expect(settingsPath).toBe(join(projectSettingsDir, 'settings.json'))
  writeFileSync(settingsPath, '{"model":"first"}\n')

  await resetForTesting(FAST_TIMING)
  await initialize()

  const seen: string[] = []
  subscribe(source => {
    seen.push(source)
  })

  expect(await writeUntilSeen(settingsPath, seen, 'projectSettings')).toContain(
    'projectSettings',
  )
}, 30000)

test('does not watch a settings directory that does not exist at init', async () => {
  const root = sandbox()
  // The config dir exists (it is the positive control that proves the watcher
  // is armed); the project settings dir does not, so creating it mid-session
  // must stay invisible until the next restart.
  const configDir = join(root, 'config')
  mkdirSync(configDir, { recursive: true })

  const userPath = assertInside(root, getSettingsFilePathForSource('userSettings'))
  const projectPath = assertInside(
    root,
    getSettingsFilePathForSource('projectSettings'),
  )

  await resetForTesting(FAST_TIMING)
  await initialize()

  const seen: string[] = []
  subscribe(source => {
    seen.push(source)
  })

  // Positive control: the watcher is live before we assert an absence.
  expect(await writeUntilSeen(userPath, seen, 'userSettings')).toContain(
    'userSettings',
  )

  mkdirSync(join(root, 'project', '.cat-code'), { recursive: true })
  for (let n = 0; n < 6; n++) {
    writeFileSync(projectPath, `{"model":"v${n}"}\n`)
    await new Promise(r => setTimeout(r, 200))
  }

  expect(seen).not.toContain('projectSettings')
}, 30000)
