import { afterEach, expect, mock, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { PassThrough } from 'node:stream'
import { act } from 'react'
import stripAnsi from 'strip-ansi'
import * as React from 'react'
import {
  getAllowedSettingSources,
  getFlagSettingsInline,
  getFlagSettingsPath,
  getOriginalCwd,
  getProjectRoot,
  setAllowedSettingSources,
  setFlagSettingsInline,
  setFlagSettingsPath,
  setOriginalCwd,
  setProjectRoot,
} from '../../bootstrap/state.js'
import { AppStateProvider, getDefaultAppState } from '../../state/AppState.js'
import {
  clearUserContextCache,
  getUserContext,
} from '../../context.js'
import type { LocalJSXCommandContext } from '../../commands.js'
import { render } from '../../ink.js'
import {
  getManagedSessionPolicy,
  setManagedSessionPolicy,
} from '../../utils/managedSessionPolicy.js'
import {
  getManagedFilePath,
  getManagedSettingsDropInDir,
} from '../../utils/settings/managedPath.js'
import { resetSettingsCache } from '../../utils/settings/settingsCache.js'
import { _setGlobalConfigCacheForTesting } from '../../utils/config.js'
import { getClaudeConfigHomeDir } from '../../utils/envUtils.js'
import { getMemoryFiles } from '../../utils/claudemd.js'
import { getAutoMemPath } from '../../memdir/paths.js'

let activeHandlers: Record<string, () => void | false | Promise<void>> = {}
const actionHandlers = new Map<string, () => void>()
const scratchDirectories: string[] = []
const originalSources = getAllowedSettingSources()
const originalCwd = getOriginalCwd()
const originalProjectRoot = getProjectRoot()
const originalFlagPath = getFlagSettingsPath()
const originalFlagSettings = getFlagSettingsInline()
const originalManagedSessionPolicy = getManagedSessionPolicy()
const originalEnvironment = new Map(
  [
    'HOME',
    'CLAUDE_CONFIG_DIR',
    'CLAUDE_CODE_MANAGED_SETTINGS_PATH',
    'CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD',
    'CLAUDE_CODE_DISABLE_AUTO_MEMORY',
    'CLAUDE_CODE_SIMPLE',
    'CLAUDE_CODE_REMOTE',
    'CLAUDE_CODE_REMOTE_MEMORY_DIR',
    'CLAUDE_COWORK_MEMORY_PATH_OVERRIDE',
    'GIT_CONFIG_GLOBAL',
    'GIT_CONFIG_NOSYSTEM',
    'NODE_ENV',
    'USER_TYPE',
  ].map(name => [name, process.env[name]]),
)
const keybindingModule = await import('../../keybindings/useKeybinding.js')
const terminalSizeModule = await import('../../hooks/useTerminalSize.js')
const modalContextModule = await import('../../context/modalContext.js')
const exitModule = await import('../../hooks/useExitOnCtrlCDWithKeybindings.js')
const statusModule = await import('./Status.js')

await mock.module('../../keybindings/useKeybinding.js', () => ({
  ...keybindingModule,
  useKeybinding: (action: string, handler: () => void) => {
    actionHandlers.set(action, handler)
  },
  useKeybindings: (
    handlers: Record<string, () => void | false | Promise<void>>,
  ) => {
    activeHandlers = handlers
  },
}))
await mock.module('../../hooks/useTerminalSize.js', () => ({
  ...terminalSizeModule,
  useTerminalSize: () => ({ columns: 120, rows: 40 }),
}))
await mock.module('../../context/modalContext.js', () => ({
  ...modalContextModule,
  useIsInsideModal: () => false,
  useModalOrTerminalSize: (size: { columns: number; rows: number }) => size,
}))
await mock.module('../../hooks/useExitOnCtrlCDWithKeybindings.js', () => ({
  ...exitModule,
  useExitOnCtrlCDWithKeybindings: () => undefined,
}))
await mock.module('./Status.js', () => ({
  ...statusModule,
  Status: () => null,
  buildDiagnostics: async () => [],
}))

const { Settings } = await import('./Settings.js')

function resetCaches(): void {
  clearUserContextCache()
  getMemoryFiles.cache.clear?.()
  getAutoMemPath.cache.clear?.()
  getManagedSettingsDropInDir.cache.clear?.()
  getManagedFilePath.cache.clear?.()
  getClaudeConfigHomeDir.cache.clear?.()
  resetSettingsCache()
  _setGlobalConfigCacheForTesting(null)
}

function createFixture(): { project: string; config: string } {
  const root = mkdtempSync(join(tmpdir(), 'config-instruction-files-'))
  scratchDirectories.push(root)
  const home = join(root, 'home')
  const config = join(root, 'config')
  const managed = join(root, 'managed')
  const project = join(root, 'project')
  for (const directory of [home, config, managed, project]) {
    mkdirSync(directory, { recursive: true })
  }
  process.env.HOME = home
  process.env.CLAUDE_CONFIG_DIR = config
  process.env.CLAUDE_CODE_MANAGED_SETTINGS_PATH = managed
  process.env.NODE_ENV = 'test'
  process.env.USER_TYPE = 'ant'
  process.env.GIT_CONFIG_GLOBAL = '/dev/null'
  process.env.GIT_CONFIG_NOSYSTEM = '1'
  process.env.CLAUDE_CODE_DISABLE_AUTO_MEMORY = '0'
  delete process.env.CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD
  delete process.env.CLAUDE_CODE_SIMPLE
  delete process.env.CLAUDE_CODE_REMOTE
  delete process.env.CLAUDE_CODE_REMOTE_MEMORY_DIR
  delete process.env.CLAUDE_COWORK_MEMORY_PATH_OVERRIDE
  setAllowedSettingSources([
    'userSettings',
    'projectSettings',
    'localSettings',
  ])
  setManagedSessionPolicy(null)
  setOriginalCwd(project)
  setProjectRoot(project)
  setFlagSettingsPath(undefined)
  setFlagSettingsInline(null)
  activeHandlers = {}
  actionHandlers.clear()
  resetCaches()
  return { project, config }
}

function writeSettings(config: string, settings: Record<string, unknown>): void {
  writeFileSync(join(config, 'settings.json'), JSON.stringify(settings))
  resetSettingsCache()
}

function userInstructionMode(config: string): string | undefined {
  const settings = JSON.parse(
    readFileSync(join(config, 'settings.json'), 'utf8'),
  ) as {
    pluginConfigs?: Record<
      string,
      { options?: Record<string, string | number | boolean | string[]> }
    >
  }
  const value =
    settings.pluginConfigs?.['agents-md@builtin']?.options?.instructionFiles
  return typeof value === 'string' ? value : undefined
}

function passThroughStdin(): NodeJS.ReadStream & {
  isTTY: boolean
  setRawMode(enabled: boolean): void
  ref(): void
  unref(): void
} {
  const stdin = new PassThrough() as unknown as NodeJS.ReadStream & {
    isTTY: boolean
    setRawMode(enabled: boolean): void
    ref(): void
    unref(): void
  }
  stdin.isTTY = true
  stdin.setRawMode = () => undefined
  stdin.ref = () => undefined
  stdin.unref = () => undefined
  return stdin
}

async function waitForRender(): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, 100))
}

async function renderSettings(
  onClose: Parameters<typeof Settings>[0]['onClose'] = () => undefined,
): Promise<{
  output(): string
  stdin: ReturnType<typeof passThroughStdin>
  unmount(): void
}> {
  const stdout = new PassThrough() as unknown as NodeJS.WriteStream & {
    columns: number
  }
  stdout.columns = 120
  const stderr = new PassThrough() as unknown as NodeJS.WriteStream
  const stdin = passThroughStdin()
  let output = ''
  await getMemoryFiles(true)
  ;(stdout as unknown as PassThrough).on('data', chunk => {
    output += chunk.toString()
  })

  let instance: Awaited<ReturnType<typeof render>>
  await act(async () => {
    instance = await render(
      <AppStateProvider initialState={getDefaultAppState()}>
        <Settings
          onClose={onClose}
          context={
            {
              options: { mcpClients: [] },
              messages: [],
            } as unknown as LocalJSXCommandContext
          }
          defaultTab="Config"
        />
      </AppStateProvider>,
      {
        stdout,
        stdin,
        stderr,
        exitOnCtrlC: false,
        patchConsole: false,
      },
    )
  })
  await waitForRender()
  return {
    output: () => stripAnsi(output),
    stdin,
    unmount: () => instance.unmount(),
  }
}

async function filterProjectInstructions(
  stdin: ReturnType<typeof passThroughStdin>,
): Promise<void> {
  await act(async () => {
    stdin.write('Project instructions')
  })
  await waitForRender()
  await act(async () => {
    stdin.write('\r')
  })
  await waitForRender()
}

async function invokeAccept(): Promise<void> {
  const handler = activeHandlers['select:accept']
  expect(handler).toBeDefined()
  await act(async () => {
    await handler?.()
  })
  await waitForRender()
}

afterEach(() => {
  for (const [name, value] of originalEnvironment) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  setAllowedSettingSources(originalSources)
  setManagedSessionPolicy(originalManagedSessionPolicy)
  setOriginalCwd(originalCwd)
  setProjectRoot(originalProjectRoot)
  setFlagSettingsPath(originalFlagPath)
  setFlagSettingsInline(originalFlagSettings)
  resetCaches()
  for (const directory of scratchDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

test('Project instructions exposes the four friendly choices and writes each mode', async () => {
  const { project, config } = createFixture()
  writeSettings(config, {})
  const agentsPath = join(project, 'AGENTS.md')
  writeFileSync(agentsPath, 'UI_CACHE_AGENTS_MARKER')
  expect(
    (await getMemoryFiles()).some(file => basename(file.path) === 'AGENTS.md'),
  ).toBe(true)
  const ui = await renderSettings()
  try {
    await filterProjectInstructions(ui.stdin)
    expect(ui.output()).toContain('Project instructions')
    expect(ui.output()).toContain('CLAUDE.md or AGENTS.md')
    for (const mode of [
      'claude-md',
      'claude-md-and-agents-md',
      'managed-only',
      'claude-md-or-agents-md',
    ] as const) {
      await invokeAccept()
      expect(userInstructionMode(config)).toBe(mode)
      expect(
        (await getMemoryFiles()).some(
          file => basename(file.path) === 'AGENTS.md',
        ),
      ).toBe(mode === 'claude-md-and-agents-md' || mode === 'claude-md-or-agents-md')
    }
  } finally {
    ui.unmount()
  }
})

test('changing Project instructions refreshes cached user context', async () => {
  const { project, config } = createFixture()
  writeSettings(config, {})
  writeFileSync(
    join(project, 'AGENTS.md'),
    'CONTEXT_INVALIDATION_AGENTS_MARKER',
  )

  const before = await getUserContext()
  expect(before.claudeMd).toContain('CONTEXT_INVALIDATION_AGENTS_MARKER')

  const ui = await renderSettings()
  try {
    await filterProjectInstructions(ui.stdin)
    await invokeAccept()
    expect(userInstructionMode(config)).toBe('claude-md')

    const after = await getUserContext()
    expect(after.claudeMd ?? '').not.toContain(
      'CONTEXT_INVALIDATION_AGENTS_MARKER',
    )
  } finally {
    ui.unmount()
  }
})

test('Escape stays open and can retry when Project instructions rollback fails', async () => {
  const { config } = createFixture()
  writeSettings(config, {
    pluginConfigs: {
      'agents-md@builtin': {
        options: { instructionFiles: 'claude-md' },
      },
    },
  })
  let closeCalls = 0
  const onClose: Parameters<typeof Settings>[0]['onClose'] = () => {
    closeCalls += 1
  }
  const ui = await renderSettings(onClose)
  const settingsPath = join(config, 'settings.json')
  try {
    await filterProjectInstructions(ui.stdin)
    await invokeAccept()
    expect(userInstructionMode(config)).toBe('claude-md-and-agents-md')
    const changedSettings = readFileSync(settingsPath)

    rmSync(settingsPath)
    mkdirSync(settingsPath)
    const escape = actionHandlers.get('confirm:no')
    expect(escape).toBeDefined()
    await act(async () => {
      escape?.()
    })
    await waitForRender()
    expect(closeCalls).toBe(0)

    rmSync(settingsPath, { recursive: true })
    writeFileSync(settingsPath, changedSettings)
    resetSettingsCache()
    await act(async () => {
      actionHandlers.get('confirm:no')?.()
    })
    await waitForRender()

    expect(closeCalls).toBe(1)
    expect(userInstructionMode(config)).toBe('claude-md')
  } finally {
    ui.unmount()
  }
})

test('flag-owned mode is read-only and Escape restores only the original user option', async () => {
  const { config } = createFixture()
  writeSettings(config, {
    permissions: { allow: ['Read(*)'] },
    pluginConfigs: {
      'agents-md@builtin': {
        mcpServers: { local: { command: 'test-server' } },
        options: { keep: 'sibling', instructionFiles: 'claude-md' },
      },
      'other@builtin': { options: { keep: 'other-plugin' } },
    },
  })
  setFlagSettingsInline({
    pluginConfigs: {
      'agents-md@builtin': {
        options: { instructionFiles: 'claude-md-and-agents-md' },
      },
    },
  })
  resetSettingsCache()
  const readOnlyUi = await renderSettings()
  try {
    await filterProjectInstructions(readOnlyUi.stdin)
    expect(readOnlyUi.output()).toContain('CLAUDE.md and AGENTS.md')
    await invokeAccept()
    expect(userInstructionMode(config)).toBe('claude-md')
  } finally {
    readOnlyUi.unmount()
  }

  setFlagSettingsInline(null)
  resetSettingsCache()
  const editableUi = await renderSettings()
  try {
    await filterProjectInstructions(editableUi.stdin)
    await invokeAccept()
    expect(userInstructionMode(config)).toBe('claude-md-and-agents-md')

    const escape = actionHandlers.get('confirm:no')
    expect(escape).toBeDefined()
    await act(async () => {
      escape?.()
    })
    await waitForRender()

    expect(userInstructionMode(config)).toBe('claude-md')
    const settings = JSON.parse(
      readFileSync(join(config, 'settings.json'), 'utf8'),
    )
    expect(settings.permissions).toEqual({ allow: ['Read(*)'] })
    expect(settings.pluginConfigs['agents-md@builtin']).toEqual({
      mcpServers: { local: { command: 'test-server' } },
      options: { keep: 'sibling', instructionFiles: 'claude-md' },
    })
    expect(settings.pluginConfigs['other@builtin']).toEqual({
      options: { keep: 'other-plugin' },
    })
  } finally {
    editableUi.unmount()
  }
})
