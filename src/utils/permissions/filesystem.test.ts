import { afterAll, beforeAll, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, sep } from 'path'

import { getOriginalCwd, setOriginalCwd } from '../../bootstrap/state.js'
import { getAutoMemPath } from '../../memdir/paths.js'
import type { ToolPermissionContext } from '../../Tool.js'
import {
  checkEditableInternalPath,
  checkReadableInternalPath,
  matchingRuleForInput,
} from './filesystem.js'

// LIVE-STATE SAFETY: this suite creates a symlink inside the auto-memory
// directory, so the memory root is redirected to a mkdtemp root before the
// first getAutoMemPath() call and every test asserts containment before it
// writes. If the redirect ever fails, beforeAll throws instead of touching
// the real ~/.cat-code/.
//
// memRoot is deliberately a DIFFERENT temp root from configRoot: under the
// default layout the memory dir sits inside ~/.cat-code/projects/<key>/, and
// the project-dir read carve-out (isProjectDirPath) allows it first, so the
// auto-memory read carve-out is only reachable when the memory base is
// elsewhere — which is what CLAUDE_CODE_REMOTE_MEMORY_DIR configures.
let configRoot = ''
let memRoot = ''
let decoyRoot = ''
let memDir = ''

// MACRO is a build-time define; the read path's final carve-out
// (getBundledSkillsRoot) reads MACRO.VERSION, which bare `bun test` does not
// compile in.
const macroState = globalThis as typeof globalThis & {
  MACRO?: { VERSION: string }
}
const savedMacro = macroState.MACRO

const savedConfigDir = process.env.CLAUDE_CONFIG_DIR
const savedRemoteMemoryDir = process.env.CLAUDE_CODE_REMOTE_MEMORY_DIR
const savedMemoryOverride = process.env.CLAUDE_COWORK_MEMORY_PATH_OVERRIDE

function assertUnderMemRoot(path: string): void {
  expect(path.startsWith(memRoot + sep)).toBe(true)
}

beforeAll(() => {
  macroState.MACRO = { VERSION: 'test-version' }
  configRoot = mkdtempSync(join(tmpdir(), 'catcode-fs-perm-cfg-'))
  memRoot = mkdtempSync(join(tmpdir(), 'catcode-fs-perm-mem-'))
  decoyRoot = mkdtempSync(join(tmpdir(), 'catcode-fs-perm-decoy-'))
  process.env.CLAUDE_CONFIG_DIR = configRoot
  process.env.CLAUDE_CODE_REMOTE_MEMORY_DIR = memRoot
  delete process.env.CLAUDE_COWORK_MEMORY_PATH_OVERRIDE
  getAutoMemPath.cache.clear()

  memDir = getAutoMemPath()
  if (!memDir.startsWith(memRoot + sep)) {
    throw new Error(
      `refusing to run: auto-memory dir ${memDir} is not under the temp root ${memRoot}`,
    )
  }
  mkdirSync(memDir, { recursive: true })
  mkdirSync(join(decoyRoot, 'not-real-credentials'), { recursive: true })
})

afterAll(() => {
  macroState.MACRO = savedMacro
  if (savedConfigDir === undefined) {
    delete process.env.CLAUDE_CONFIG_DIR
  } else {
    process.env.CLAUDE_CONFIG_DIR = savedConfigDir
  }
  if (savedRemoteMemoryDir === undefined) {
    delete process.env.CLAUDE_CODE_REMOTE_MEMORY_DIR
  } else {
    process.env.CLAUDE_CODE_REMOTE_MEMORY_DIR = savedRemoteMemoryDir
  }
  if (savedMemoryOverride !== undefined) {
    process.env.CLAUDE_COWORK_MEMORY_PATH_OVERRIDE = savedMemoryOverride
  }
  getAutoMemPath.cache.clear()
  rmSync(configRoot, { recursive: true, force: true })
  rmSync(memRoot, { recursive: true, force: true })
  rmSync(decoyRoot, { recursive: true, force: true })
})

describe('auto-memory carve-out', () => {
  test('allows an ordinary file inside the memory directory', () => {
    const filePath = join(memDir, 'MEMORY.md')
    assertUnderMemRoot(filePath)
    writeFileSync(filePath, '# memory\n')

    expect(
      checkEditableInternalPath(filePath, { file_path: filePath }).behavior,
    ).toBe('allow')
    expect(
      checkReadableInternalPath(filePath, { file_path: filePath }).behavior,
    ).toBe('allow')
  })

  test('allows a memory file that does not exist yet', () => {
    const filePath = join(memDir, 'topic_not_created_yet.md')
    assertUnderMemRoot(filePath)

    expect(
      checkEditableInternalPath(filePath, { file_path: filePath }).behavior,
    ).toBe('allow')
    expect(
      checkReadableInternalPath(filePath, { file_path: filePath }).behavior,
    ).toBe('allow')
  })

  test('does not carve out a symlink inside the memory directory that resolves outside it', () => {
    const linkPath = join(memDir, 'escape.md')
    const target = join(decoyRoot, 'not-real-credentials', 'authorized_keys')
    assertUnderMemRoot(linkPath)
    expect(target.startsWith(decoyRoot + sep)).toBe(true)
    writeFileSync(target, 'decoy\n')
    symlinkSync(target, linkPath)

    expect(
      checkEditableInternalPath(linkPath, { file_path: linkPath }).behavior,
    ).toBe('passthrough')
    expect(
      checkReadableInternalPath(linkPath, { file_path: linkPath }).behavior,
    ).toBe('passthrough')
  })
})

describe('matchingRuleForInput: identical leading-/ rule text from two sources', () => {
  // A leading-/ pattern resolves relative to its source's settings root
  // (rootPathForSource), which differs between userSettings and
  // projectSettings. If two rules share the same ruleContent text, a
  // contents-only dedup collapses them to one rule and silently resolves the
  // dropped rule's pattern against the wrong root.
  function contextWithDenyRuleInBothScopes(): ToolPermissionContext {
    return {
      mode: 'default',
      additionalWorkingDirectories: new Map(),
      alwaysAllowRules: {},
      alwaysDenyRules: {
        userSettings: ['Read(/x/**)'],
        projectSettings: ['Read(/x/**)'],
      },
      alwaysAskRules: {},
      isBypassPermissionsModeAvailable: true,
    }
  }

  test('denies a read under the user-settings root and keeps the project-settings root working', () => {
    const userConfigRoot = mkdtempSync(
      join(tmpdir(), 'catcode-fs-perm-user-'),
    )
    const projectRoot = mkdtempSync(join(tmpdir(), 'catcode-fs-perm-proj-'))
    const savedConfigDirForTest = process.env.CLAUDE_CONFIG_DIR
    const savedCwd = getOriginalCwd()
    process.env.CLAUDE_CONFIG_DIR = userConfigRoot
    setOriginalCwd(projectRoot)

    try {
      const context = contextWithDenyRuleInBothScopes()
      const userScopedPath = join(userConfigRoot, 'x', 'secret.txt')
      const projectScopedPath = join(projectRoot, 'x', 'secret.txt')

      const userRule = matchingRuleForInput(
        userScopedPath,
        context,
        'read',
        'deny',
      )
      expect(userRule).not.toBeNull()
      expect(userRule?.source).toBe('userSettings')

      const projectRule = matchingRuleForInput(
        projectScopedPath,
        context,
        'read',
        'deny',
      )
      expect(projectRule).not.toBeNull()
      expect(projectRule?.source).toBe('projectSettings')
    } finally {
      if (savedConfigDirForTest === undefined) {
        delete process.env.CLAUDE_CONFIG_DIR
      } else {
        process.env.CLAUDE_CONFIG_DIR = savedConfigDirForTest
      }
      setOriginalCwd(savedCwd)
      rmSync(userConfigRoot, { recursive: true, force: true })
      rmSync(projectRoot, { recursive: true, force: true })
    }
  })
})
