import { expect, test } from 'bun:test'
import type { ConfigScope, ScopedMcpServerConfig } from '../../src/services/mcp/types.js'
import type { HookSource } from '../../src/utils/hooks/hooksSettings.js'
import type { HookCommand } from '../../src/schemas/hooks.js'
import type { HookEvent } from '../../src/entrypoints/sdk/coreTypes.js'
import type { CommandBase, PromptCommand } from '../../src/types/command.js'
import type { Command } from '../../src/commands.js'
import type { LoadedPlugin, PluginError } from '../../src/types/plugin.js'
import type { AgentDefinition } from '../../src/tools/AgentTool/loadAgentsDir.js'
import { scanForSecrets } from '../shared/secretGuard.js'
import type {
  ExtensionsSnapshotFrame,
  HookConfigSource,
  HookConfigType,
  McpConfigScope,
  McpConfigTransport,
  SkillConfigSource,
} from '../shared/protocol.js'
import {
  buildHookEntries,
  buildMcpEntry,
  buildPluginEntries,
  buildSkillEntries,
} from './extensionsDomain.js'

/* -------------------- compile-time drift tripwires -------------------- */
// The wire unions must stay a SUPERSET of the engine vocabularies they mirror,
// so a new engine literal fails this file loudly rather than silently dropping a
// row (P4-21 drift-insurance; docs/reports/2026-07-08-app-engine-duplication-review.md).
type AssertAssignable<T extends true> = T
type McpScopeCoversEngine = AssertAssignable<
  Exclude<ConfigScope, McpConfigScope> extends never ? true : false
>
type HookSourceCoversEngine = AssertAssignable<
  Exclude<HookSource, HookConfigSource> extends never ? true : false
>
type SkillSourceCoversEngine = AssertAssignable<
  Exclude<PromptCommand['source'], SkillConfigSource> extends never ? true : false
>
type HookTypeCoversEngine = AssertAssignable<
  Exclude<HookCommand['type'], HookConfigType> extends never ? true : false
>
// `buildMcpEntry` casts `config.type ?? 'stdio'` to `McpConfigTransport`; the
// wire union must stay a superset of every engine `McpServerConfig.type`
// literal (`src/services/mcp/types.ts` transport variants) or a new server
// kind would be cast to a wire value the renderer can't render.
type McpTransportCoversEngine = AssertAssignable<
  Exclude<NonNullable<ScopedMcpServerConfig['type']>, McpConfigTransport> extends never
    ? true
    : false
>
void (null as unknown as McpScopeCoversEngine)
void (null as unknown as HookSourceCoversEngine)
void (null as unknown as SkillSourceCoversEngine)
void (null as unknown as HookTypeCoversEngine)
void (null as unknown as McpTransportCoversEngine)

/* ------------------------------ helpers ------------------------------- */

function promptSkill(
  fields: Partial<CommandBase & PromptCommand> & { name: string },
): Command {
  return {
    type: 'prompt',
    progressMessage: '',
    contentLength: 0,
    description: fields.description ?? `desc for ${fields.name}`,
    source: fields.source ?? 'userSettings',
    loadedFrom: fields.loadedFrom ?? 'skills',
    getPromptForCommand: async () => [{ type: 'text', text: 'SECRET_PROMPT_BODY' }],
    ...fields,
  } as unknown as Command
}

function loadedPlugin(fields: Partial<LoadedPlugin> & { name: string; source: string }): LoadedPlugin {
  return {
    manifest: { name: fields.name, version: '1.2.3' },
    path: `/plugins/${fields.name}`,
    repository: fields.source,
    ...fields,
  } as unknown as LoadedPlugin
}

/* --------------------------------- MCP -------------------------------- */

test('buildMcpEntry maps stdio config and withholds env', () => {
  const config = {
    type: 'stdio',
    command: 'node',
    args: ['server.js', '--port', '3000'],
    env: { API_KEY: 'sk-live-SECRET' },
    scope: 'user',
  } as unknown as ScopedMcpServerConfig
  const entry = buildMcpEntry('local-tools', config)
  expect(entry).toEqual({
    name: 'local-tools',
    transport: 'stdio',
    scope: 'user',
    command: 'node',
    argCount: 3,
  })
  expect(JSON.stringify(entry)).not.toContain('sk-live')
  expect(JSON.stringify(entry)).not.toContain('API_KEY')
})

test('buildMcpEntry maps remote config to a credential-free url + pluginSource', () => {
  const config = {
    type: 'http',
    url: 'https://mcp.example.com/rpc?api_key=sk-live-URL#token-fragment',
    headers: { Authorization: 'Bearer sk-live-SECRET' },
    scope: 'project',
    pluginSource: 'slack@anthropic',
  } as unknown as ScopedMcpServerConfig
  const entry = buildMcpEntry('remote', config)
  expect(entry).toMatchObject({
    name: 'remote',
    transport: 'http',
    scope: 'project',
    url: 'https://mcp.example.com/rpc',
    pluginSource: 'slack@anthropic',
  })
  expect(entry.command).toBeUndefined()
  expect(JSON.stringify(entry)).not.toContain('Authorization')
  expect(JSON.stringify(entry)).not.toContain('sk-live')
  expect(JSON.stringify(entry)).not.toContain('token-fragment')
})

test('buildMcpEntry withholds a credential embedded in the url path', () => {
  const config = {
    type: 'http',
    url: 'https://mcp.example.com/api/mcp/s/NjQ4YzExMmZha2V0b2tlbg/mcp',
    scope: 'user',
  } as unknown as ScopedMcpServerConfig
  const entry = buildMcpEntry('path-secret', config)
  expect(entry.url).toBe('https://mcp.example.com/api/mcp/s/*/mcp')
  expect(JSON.stringify(entry)).not.toContain('NjQ4YzExMmZha2V0b2tlbg')
})

test('buildMcpEntry withholds opaque path segments whatever their shape', () => {
  const shapes = [
    ['uuid', '5f1c0b7a-4d2e-4a71-9b30-1c2d3e4f5a6b'],
    ['hex', 'a3f9c2b1d4e6f7a8b9c0d1e2f3a4b5c6'],
    ['mixed case', 'AbCdEfGhIjKl'],
    ['percent encoded', 'sk%2Dlive%2Dfake'],
  ] as const
  for (const [, segment] of shapes) {
    const config = {
      type: 'sse',
      url: `https://mcp.example.com/v1/${segment}/sse`,
      scope: 'user',
    } as unknown as ScopedMcpServerConfig
    const entry = buildMcpEntry('opaque', config)
    expect(entry.url).toBe('https://mcp.example.com/v1/*/sse')
  }
})

test('buildMcpEntry keeps a word-shaped path so the server stays identifiable', () => {
  const config = {
    type: 'http',
    url: 'https://mcp.example.com:8443/api/v1/messages',
    scope: 'user',
  } as unknown as ScopedMcpServerConfig
  expect(buildMcpEntry('plain', config).url).toBe(
    'https://mcp.example.com:8443/api/v1/messages',
  )
})

test('buildMcpEntry defaults a missing transport to stdio', () => {
  const config = { command: 'x', args: [], scope: 'local' } as unknown as ScopedMcpServerConfig
  expect(buildMcpEntry('legacy', config).transport).toBe('stdio')
})

/* -------------------------------- Skills ------------------------------ */

test('buildSkillEntries filters to skill-sourced prompt commands and withholds bodies', () => {
  const commands: Command[] = [
    promptSkill({ name: 'deep-research', source: 'userSettings', whenToUse: 'for research' }),
    promptSkill({
      name: 'reviewer',
      source: 'plugin',
      loadedFrom: 'plugin',
      context: 'fork',
      agent: 'general-purpose',
      pluginInfo: { pluginManifest: { name: 'review-kit' }, repository: 'review-kit@mkt' } as never,
    }),
    promptSkill({ name: 'hidden', source: 'userSettings', disableModelInvocation: true, userInvocable: false }),
    // A non-skill prompt command (built-in) — excluded.
    promptSkill({ name: 'clear', source: 'builtin', loadedFrom: 'bundled' }),
    // A non-prompt command — excluded.
    { type: 'local', name: 'exit', description: 'exit', loadedFrom: 'skills' } as unknown as Command,
  ]
  const skills = buildSkillEntries(commands)
  const names = skills.map(s => s.name)
  expect(names).toEqual(['deep-research', 'hidden', 'reviewer'])

  const fork = skills.find(s => s.name === 'reviewer')
  expect(fork).toMatchObject({
    source: 'plugin',
    context: 'fork',
    agent: 'general-purpose',
    pluginName: 'review-kit',
  })
  const hidden = skills.find(s => s.name === 'hidden')
  expect(hidden).toMatchObject({ disableModelInvocation: true, userInvocable: false })
  const research = skills.find(s => s.name === 'deep-research')
  expect(research).toMatchObject({ context: 'inline', userInvocable: true, whenToUse: 'for research' })

  expect(JSON.stringify(skills)).not.toContain('SECRET_PROMPT_BODY')
})

/* -------------------------------- Hooks ------------------------------- */

function hook(fields: {
  event: HookEvent
  config: HookCommand
  matcher?: string
  source: HookSource
  pluginName?: string
}) {
  return fields
}

test('buildHookEntries orders by canonical event without exposing hook bodies', () => {
  const hooks = [
    hook({
      event: 'PostToolUse',
      config: { type: 'http', url: 'https://hooks.example.com/post?token=sk-live-HTTP' } as HookCommand,
      source: 'projectSettings',
    }),
    hook({
      event: 'PreToolUse',
      config: { type: 'command', command: 'curl -H "x-api-key: sk-live-COMMAND"' , async: true } as HookCommand,
      matcher: 'Write|Edit',
      source: 'userSettings',
    }),
  ]
  const entries = buildHookEntries(hooks)
  // PreToolUse sorts before PostToolUse (canonical HOOK_EVENTS order).
  expect(entries.map(e => e.event)).toEqual(['PreToolUse', 'PostToolUse'])
  expect(entries[0]).toMatchObject({
    type: 'command',
    matcher: 'Write|Edit',
    source: 'userSettings',
    async: true,
    displayLine: 'command hook',
  })
  expect(entries[1]).toMatchObject({
    type: 'http',
    async: false,
    displayLine: 'http hook',
  })
  expect(JSON.stringify(entries)).not.toContain('sk-live')
})

/* ------------------------------- Plugins ------------------------------ */

test('buildPluginEntries derives provides, correlates errors, and staged updates', () => {
  const plugin = loadedPlugin({
    name: 'formatter',
    source: 'formatter@tools',
    isBuiltin: false,
    mcpServers: { fmtServer: { type: 'stdio', command: 'fmt' } } as never,
    hooksConfig: { PreToolUse: [{ hooks: [{ type: 'command', command: 'fmt' }] }] } as never,
    lspServers: { fmtLsp: {} } as never,
  })
  const brokenPlugin = loadedPlugin({ name: 'broken', source: 'broken@tools' })

  const commands: Command[] = [
    promptSkill({
      name: 'fmt-skill',
      source: 'plugin',
      loadedFrom: 'plugin',
      pluginInfo: { pluginManifest: { name: 'formatter' }, repository: 'formatter@tools' } as never,
    }),
  ]
  const agents: AgentDefinition[] = [
    { agentType: 'fmt-agent', source: 'plugin', plugin: 'formatter@tools', whenToUse: 'x' } as unknown as AgentDefinition,
  ]
  const errors: PluginError[] = [
    { type: 'generic-error', source: 'broken@tools', error: 'failed to load broken' },
  ]

  const entries = buildPluginEntries({
    loaded: [
      { plugin, enabled: true },
      { plugin: brokenPlugin, enabled: false },
    ],
    errors,
    pending: [
      { pluginId: 'formatter@tools', scope: 'user', oldVersion: '1.2.3', newVersion: '1.3.0' },
    ],
    commands,
    agentDefinitions: agents,
  })

  const fmt = entries.find(e => e.id === 'formatter@tools')
  expect(fmt).toMatchObject({
    name: 'formatter',
    version: '1.2.3',
    enabled: true,
    builtin: false,
    pendingUpdate: { oldVersion: '1.2.3', newVersion: '1.3.0' },
  })
  expect(fmt?.provides).toEqual({
    commands: 0,
    agents: 1,
    skills: 1,
    hooks: 1,
    mcpServers: 1,
    lsp: 1,
  })

  const broken = entries.find(e => e.id === 'broken@tools')
  expect(broken?.enabled).toBe(false)
  expect(broken?.error).toContain('broken')
})

test('buildPluginEntries surfaces an error that never produced a LoadedPlugin', () => {
  // `pluginLoader.ts` returns `null` before building a `LoadedPlugin` for
  // several error kinds (`plugin-not-found`, `plugin-cache-miss`, …), so
  // there is no `loaded` row for `correlatePluginError` to attach to. Before
  // the fix `buildPluginEntries` mapped `loaded` only and dropped these on
  // the floor; the plugin should still show up, disabled, carrying the error.
  const entries = buildPluginEntries({
    loaded: [],
    errors: [
      { type: 'plugin-not-found', source: 'foo@mkt', pluginId: 'foo', marketplace: 'mkt' },
    ],
    pending: [],
    commands: [],
    agentDefinitions: [],
  })

  expect(entries).toHaveLength(1)
  expect(entries[0]).toMatchObject({
    id: 'foo@mkt',
    name: 'foo',
    source: 'foo@mkt',
    enabled: false,
    builtin: false,
    provides: { commands: 0, agents: 0, skills: 0, hooks: 0, mcpServers: 0, lsp: 0 },
  })
  expect(entries[0]?.error).toContain('foo')
  expect(entries[0]?.error).toContain('mkt')
})

test('buildPluginEntries redacts a credential-bearing URL in an error-only row', () => {
  // `generic-error.error` is an arbitrary caught-error message that can embed
  // the URL a fetch/download failed against (`pluginLoader.ts` "Failed to
  // download/cache plugin …" sites), and — because this error kind returns
  // `null` before building a `LoadedPlugin` — this error-only row is the ONLY
  // place that message can end up. `secretGuard` only matches key names, so
  // the sidecar's own redaction is what has to withhold the credential here.
  const entries = buildPluginEntries({
    loaded: [],
    errors: [
      {
        type: 'generic-error',
        source: 'creds@mkt',
        plugin: 'creds',
        error:
          'Failed to download/cache plugin creds: fetch failed: https://user:sk-live-SECRET@dl.example.com/api/mcp/s/NjQ4YzExMmZha2V0b2tlbg/pkg.zip',
      },
    ],
    pending: [],
    commands: [],
    agentDefinitions: [],
  })

  expect(entries).toHaveLength(1)
  const message = entries[0]?.error ?? ''
  expect(message).not.toContain('sk-live-SECRET')
  expect(message).not.toContain('user:')
  expect(message).not.toContain('NjQ4YzExMmZha2V0b2tlbg')
  expect(message).toContain('https://dl.example.com')
})

/* --------------------------- secret posture --------------------------- */

test('a full extensions frame carries no secret material', () => {
  const mcp = [
    buildMcpEntry('remote', {
      type: 'http',
      url: 'https://x/y?api_key=sk-live-URL',
      headers: { Authorization: 'sk-live-HEADER' },
      scope: 'user',
    } as unknown as ScopedMcpServerConfig),
  ]
  const skills = buildSkillEntries([promptSkill({ name: 'a', source: 'userSettings' })])
  const hooks = buildHookEntries([
    hook({
      event: 'PreToolUse',
      config: { type: 'command', command: 'run-check --token sk-live-HOOK' } as HookCommand,
      source: 'userSettings',
    }),
  ])
  const plugins = buildPluginEntries({
    loaded: [{ plugin: loadedPlugin({ name: 'p', source: 'p@m' }), enabled: true }],
    errors: [],
    pending: [],
    commands: [],
    agentDefinitions: [],
  })

  const frame: ExtensionsSnapshotFrame = {
    kind: 'extensions.snapshot',
    protocolVersion: 1,
    sessionId: 'sess-1',
    extensions: { mcp, plugins, skills, hooks },
  }
  const serialized = JSON.stringify(frame)
  expect(serialized).not.toContain('sk-live')
  expect(serialized).not.toContain('Authorization')
  expect(serialized).not.toContain('SECRET_PROMPT_BODY')
  expect(scanForSecrets(frame).ok).toBe(true)
})
