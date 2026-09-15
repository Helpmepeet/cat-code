import { afterAll, afterEach, describe, expect, mock, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const sources = [
  'userSettings',
  'projectSettings',
  'localSettings',
  'flagSettings',
  'policySettings',
] as const

type SettingSource = (typeof sources)[number]
type McpApprovalSettings = {
  enabledMcpjsonServers?: string[]
  disabledMcpjsonServers?: string[]
  enableAllProjectMcpServers?: boolean
}

let cwd = ''
let nonInteractive = false
let effectiveSettings: McpApprovalSettings = {}
const settingsBySource: Partial<Record<SettingSource, McpApprovalSettings>> = {}

const actualBootstrapState = await import('../../bootstrap/state.js')
const actualConfig = await import('../../utils/config.js')
const actualCwd = await import('../../utils/cwd.js')
const actualPluginLoader = await import(
  '../../utils/plugins/pluginLoader.js'
)
const actualSettingsConstants = await import(
  '../../utils/settings/constants.js'
)
const actualManagedPath = await import('../../utils/settings/managedPath.js')
const actualSettings = await import('../../utils/settings/settings.js')

mock.module('../../bootstrap/state.js', () => ({
  ...actualBootstrapState,
  getIsNonInteractiveSession: () => nonInteractive,
}))

mock.module('../../utils/config.js', () => ({
  ...actualConfig,
  getCurrentProjectConfig: () => ({}),
  getGlobalConfig: () => ({}),
  saveCurrentProjectConfig: () => { },
  saveGlobalConfig: () => { },
}))

mock.module('../../utils/cwd.js', () => ({
  ...actualCwd,
  getCwd: () => cwd,
}))

mock.module('../../utils/plugins/pluginLoader.js', () => ({
  ...actualPluginLoader,
  loadAllPluginsCacheOnly: async () => ({ enabled: [], errors: [] }),
}))

mock.module('../../utils/settings/constants.js', () => ({
  ...actualSettingsConstants,
  isSettingSourceEnabled: () => true,
}))

mock.module('../../utils/settings/managedPath.js', () => ({
  ...actualManagedPath,
  getManagedFilePath: () => cwd,
}))

mock.module('../../utils/settings/settings.js', () => ({
  ...actualSettings,
  getInitialSettings: () => effectiveSettings,
  getSettings_DEPRECATED: () => effectiveSettings,
  getSettingsForSource: (source: SettingSource) =>
    settingsBySource[source] ?? null,
}))

const { getClaudeCodeMcpConfigs } = await import('./config.js')

async function writeProjectServers(): Promise<void> {
  await writeFile(
    join(cwd, '.mcp.json'),
    JSON.stringify({
      mcpServers: {
        pending: { command: 'pending-server' },
        approved: { command: 'approved-server' },
        rejected: { command: 'rejected-server' },
        repositoryApproved: { command: 'repository-approved-server' },
      },
    }),
  )
}

function resetApprovalState(): void {
  nonInteractive = false
  effectiveSettings = {}
  for (const source of sources) {
    delete settingsBySource[source]
  }
}

describe('getClaudeCodeMcpConfigs project approval policy', () => {
  afterEach(async () => {
    if (cwd) await rm(cwd, { recursive: true, force: true })
    cwd = ''
    resetApprovalState()
  })

  afterAll(() => {
    mock.restore()
  })

  test('explicit-only includes trusted approvals, retains rejections, and excludes pending and repository approvals', async () => {
    cwd = await mkdtemp(join(tmpdir(), 'cat-code-mcp-config-'))
    await writeProjectServers()
    settingsBySource.userSettings = {
      enabledMcpjsonServers: ['approved', 'rejected'],
    }
    settingsBySource.localSettings = {
      disabledMcpjsonServers: ['rejected'],
    }
    settingsBySource.projectSettings = {
      enabledMcpjsonServers: ['repositoryApproved'],
    }
    effectiveSettings = {
      enabledMcpjsonServers: ['approved', 'rejected', 'repositoryApproved'],
      disabledMcpjsonServers: ['rejected'],
    }

    const { servers } = await getClaudeCodeMcpConfigs(
      {},
      Promise.resolve({}),
      { projectMcpApproval: 'explicit-only' },
    )

    expect(Object.keys(servers)).toEqual(['approved'])
  })

  test('explicit-only accepts named approvals from every trusted settings source', async () => {
    for (const source of [
      'userSettings',
      'localSettings',
      'flagSettings',
      'policySettings',
    ] as const) {
      cwd = await mkdtemp(join(tmpdir(), 'cat-code-mcp-config-'))
      await writeProjectServers()
      settingsBySource[source] = { enabledMcpjsonServers: ['approved'] }

      const { servers } = await getClaudeCodeMcpConfigs(
        {},
        Promise.resolve({}),
        { projectMcpApproval: 'explicit-only' },
      )

      expect(Object.keys(servers)).toEqual(['approved'])

      await rm(cwd, { recursive: true, force: true })
      cwd = ''
      resetApprovalState()
    }
  })

  test('explicit-only accepts approve-all from every trusted settings source', async () => {
    for (const source of [
      'userSettings',
      'localSettings',
      'flagSettings',
      'policySettings',
    ] as const) {
      cwd = await mkdtemp(join(tmpdir(), 'cat-code-mcp-config-'))
      await writeProjectServers()
      settingsBySource[source] = { enableAllProjectMcpServers: true }
      settingsBySource.localSettings = {
        ...settingsBySource.localSettings,
        disabledMcpjsonServers: ['rejected'],
      }

      const { servers } = await getClaudeCodeMcpConfigs(
        {},
        Promise.resolve({}),
        { projectMcpApproval: 'explicit-only' },
      )

      expect(Object.keys(servers).sort()).toEqual([
        'approved',
        'pending',
        'repositoryApproved',
      ])

      await rm(cwd, { recursive: true, force: true })
      cwd = ''
      resetApprovalState()
    }
  })

  test('default behavior continues to auto-approve pending project servers in non-interactive sessions', async () => {
    cwd = await mkdtemp(join(tmpdir(), 'cat-code-mcp-config-'))
    await writeProjectServers()
    nonInteractive = true

    const { servers } = await getClaudeCodeMcpConfigs()

    expect(Object.keys(servers).sort()).toEqual([
      'approved',
      'pending',
      'rejected',
      'repositoryApproved',
    ])
  })
})
