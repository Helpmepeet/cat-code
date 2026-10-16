import { join } from 'path'
import type {
  LoadedPlugin,
  PluginComponent,
  PluginError,
  PluginManifest,
} from '../../types/plugin.js'
import { logForDebugging } from '../debug.js'
import { pathExists } from '../file.js'
import { logError } from '../log.js'
import type { CommandMetadata } from './schemas.js'

type PluginComponentDeclarations = Pick<
  PluginManifest,
  'name' | 'commands' | 'agents' | 'skills' | 'outputStyles'
>

type PluginComponentOrigin =
  | 'manifest'
  | 'marketplace-fallback'
  | 'marketplace-supplement'

type ComponentPathsField =
  | 'commandsPaths'
  | 'agentsPaths'
  | 'skillsPaths'
  | 'outputStylesPaths'

function assignPaths(
  plugin: LoadedPlugin,
  field: ComponentPathsField,
  paths: string[],
  origin: PluginComponentOrigin,
): void {
  if (paths.length === 0) return
  plugin[field] =
    origin === 'marketplace-supplement'
      ? [...(plugin[field] || []), ...paths]
      : paths
}

function reportMissingPath(
  plugin: LoadedPlugin,
  pluginName: string,
  component: PluginComponent,
  label: string,
  relPath: string,
  fullPath: string,
  origin: PluginComponentOrigin,
  errors: PluginError[],
): void {
  const context =
    origin === 'manifest'
      ? 'specified in manifest but'
      : 'from marketplace entry'
  logForDebugging(
    `${label} path ${relPath} ${context} not found at ${fullPath} for ${pluginName}`,
    { level: 'warn' },
  )
  logError(
    new Error(`Plugin component file not found: ${fullPath} for ${pluginName}`),
  )
  errors.push({
    type: 'path-not-found',
    source: plugin.source,
    plugin: pluginName,
    path: fullPath,
    component,
  })
}

async function resolvePaths(
  plugin: LoadedPlugin,
  pluginName: string,
  paths: string | string[],
  component: PluginComponent,
  label: string,
  origin: PluginComponentOrigin,
  errors: PluginError[],
): Promise<string[]> {
  const relPaths = Array.isArray(paths) ? paths : [paths]
  // Serial filesystem awaits previously compounded across plugin startup.
  // Check concurrently, then report failures in declaration order.
  const checks = await Promise.all(
    relPaths.map(async relPath => {
      const fullPath = join(plugin.path, relPath)
      return { relPath, fullPath, exists: await pathExists(fullPath) }
    }),
  )
  const validPaths: string[] = []
  for (const { relPath, fullPath, exists } of checks) {
    if (origin === 'marketplace-fallback' && component === 'skills') {
      logForDebugging(
        `Checking skill path: ${relPath} -> ${fullPath} (exists: ${exists})`,
      )
    }
    if (exists) {
      validPaths.push(fullPath)
    } else {
      reportMissingPath(
        plugin,
        pluginName,
        component,
        label,
        relPath,
        fullPath,
        origin,
        errors,
      )
    }
  }
  return validPaths
}

async function loadDeclaredCommands(
  plugin: LoadedPlugin,
  declarations: PluginComponentDeclarations,
  origin: PluginComponentOrigin,
  errors: PluginError[],
): Promise<void> {
  const commands = declarations.commands
  if (!commands) return

  // Retain the declaration format's first-entry discriminator, including empty
  // and malformed maps, rather than treating every object as command metadata.
  const firstValue = Object.values(commands)[0]
  if (
    typeof commands === 'object' &&
    !Array.isArray(commands) &&
    firstValue &&
    typeof firstValue === 'object' &&
    ('source' in firstValue || 'content' in firstValue)
  ) {
    const commandsMetadata: Record<string, CommandMetadata> =
      origin === 'marketplace-supplement'
        ? { ...(plugin.commandsMetadata || {}) }
        : {}
    const checks = await Promise.all(
      Object.entries(commands).map(async ([commandName, metadata]) => {
        if (!metadata || typeof metadata !== 'object') {
          return { commandName, metadata, kind: 'skip' as const }
        }
        if (metadata.source) {
          const fullPath = join(plugin.path, metadata.source)
          return {
            commandName,
            metadata,
            kind: 'source' as const,
            fullPath,
            exists: await pathExists(fullPath),
          }
        }
        if (origin === 'manifest' && metadata.content) {
          return { commandName, metadata, kind: 'content' as const }
        }
        return { commandName, metadata, kind: 'skip' as const }
      }),
    )
    const validPaths: string[] = []
    for (const check of checks) {
      if (check.kind === 'skip') continue
      if (check.kind === 'content') {
        commandsMetadata[check.commandName] = check.metadata
      } else if (check.exists) {
        validPaths.push(check.fullPath)
        commandsMetadata[check.commandName] = check.metadata
      } else {
        reportMissingPath(
          plugin,
          declarations.name,
          'commands',
          `Command ${check.commandName}`,
          check.metadata.source!,
          check.fullPath,
          origin,
          errors,
        )
      }
    }
    assignPaths(plugin, 'commandsPaths', validPaths, origin)
    // Marketplace declarations historically publish metadata only alongside a
    // valid source path; local manifests also support inline-only commands.
    if (
      origin === 'manifest'
        ? Object.keys(commandsMetadata).length > 0
        : validPaths.length > 0
    ) {
      plugin.commandsMetadata = commandsMetadata
    }
    return
  }

  const commandPaths = Array.isArray(commands) ? commands : [commands]
  const checks = await Promise.all(
    commandPaths.map(async cmdPath => {
      if (typeof cmdPath !== 'string') {
        return { kind: 'invalid' as const }
      }
      const fullPath = join(plugin.path, cmdPath)
      return {
        cmdPath,
        fullPath,
        kind: 'path' as const,
        exists: await pathExists(fullPath),
      }
    }),
  )
  const validPaths: string[] = []
  for (const check of checks) {
    if (check.kind === 'invalid') {
      const context = origin === 'manifest' ? 'manifest' : 'marketplace entry'
      logForDebugging(
        `Unexpected command format in ${context} for ${declarations.name}`,
        { level: 'error' },
      )
    } else if (check.exists) {
      validPaths.push(check.fullPath)
    } else {
      reportMissingPath(
        plugin,
        declarations.name,
        'commands',
        'Command',
        check.cmdPath,
        check.fullPath,
        origin,
        errors,
      )
    }
  }
  assignPaths(plugin, 'commandsPaths', validPaths, origin)
}

/**
 * Resolves disk-backed plugin components from local and marketplace manifests.
 * Hook composition and manifest-conflict decisions remain with the loader.
 */
export async function loadPluginComponents(
  plugin: LoadedPlugin,
  declarations: PluginComponentDeclarations,
  origin: PluginComponentOrigin,
): Promise<PluginError[]> {
  const errors: PluginError[] = []

  if (origin === 'manifest') {
    const [commands, agents, skills, outputStyles] = await Promise.all([
      !declarations.commands ? pathExists(join(plugin.path, 'commands')) : false,
      !declarations.agents ? pathExists(join(plugin.path, 'agents')) : false,
      !declarations.skills ? pathExists(join(plugin.path, 'skills')) : false,
      !declarations.outputStyles
        ? pathExists(join(plugin.path, 'output-styles'))
        : false,
    ])
    if (commands) plugin.commandsPath = join(plugin.path, 'commands')
    if (agents) plugin.agentsPath = join(plugin.path, 'agents')
    if (skills) plugin.skillsPath = join(plugin.path, 'skills')
    if (outputStyles) plugin.outputStylesPath = join(plugin.path, 'output-styles')
  }

  await loadDeclaredCommands(plugin, declarations, origin, errors)

  if (declarations.agents) {
    const paths = await resolvePaths(
      plugin,
      declarations.name,
      declarations.agents,
      'agents',
      'Agent',
      origin,
      errors,
    )
    assignPaths(plugin, 'agentsPaths', paths, origin)
  }

  if (declarations.skills) {
    if (origin === 'marketplace-fallback') {
      logForDebugging(
        `Processing ${Array.isArray(declarations.skills) ? declarations.skills.length : 1} skill paths for plugin ${declarations.name}`,
      )
    }
    const paths = await resolvePaths(
      plugin,
      declarations.name,
      declarations.skills,
      'skills',
      'Skill',
      origin,
      errors,
    )
    if (origin === 'marketplace-fallback') {
      logForDebugging(
        `Found ${paths.length} valid skill paths for plugin ${declarations.name}, setting skillsPaths`,
      )
    }
    assignPaths(plugin, 'skillsPaths', paths, origin)
  } else if (origin === 'marketplace-fallback') {
    logForDebugging(`Plugin ${declarations.name} has no entry.skills defined`)
  }

  if (declarations.outputStyles) {
    const paths = await resolvePaths(
      plugin,
      declarations.name,
      declarations.outputStyles,
      'output-styles',
      'Output style',
      origin,
      errors,
    )
    assignPaths(plugin, 'outputStylesPaths', paths, origin)
  }

  return errors
}
