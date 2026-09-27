import { realpathSync } from 'node:fs'
import { join, resolve } from 'node:path'
import type { CwdValidation } from '../host/host.js'
import type { EditableSettingSource } from '../shared/settingsEditable.js'

function canonicalDirectory(path: string): string {
  try {
    return realpathSync(path)
  } catch {
    return resolve(path)
  }
}

/** User defaults and project/local overrides have distinct storage targets. */
export function settingsWriteMatchesScope(
  source: EditableSettingSource,
  requestedProjectCwd: unknown,
): boolean {
  return source === 'userSettings'
    ? requestedProjectCwd === null
    : typeof requestedProjectCwd === 'string' && requestedProjectCwd.length > 0
}

/** The disposable reader must not present HOME's project layers as user scope. */
export function settingsInventoryScopeArgs(requestedProjectCwd: unknown): string[] {
  return requestedProjectCwd === null ? ['--user-settings-scope'] : []
}

/** Only previously observed projects may be named by the renderer. */
export function resolveSettingsInventoryCwd(
  requested: unknown,
  homeCwd: string,
  knownProjectCwds: ReadonlySet<string>,
  validateCwd: (cwd: string) => CwdValidation,
  configRoot: string,
): string | null {
  if (requested === null) {
    const home = validateCwd(homeCwd)
    return home.ok ? home.realpath : null
  }
  if (
    typeof requested !== 'string' ||
    requested.length === 0 ||
    requested.length > 4096 ||
    !knownProjectCwds.has(requested)
  ) {
    return null
  }
  const project = validateCwd(requested)
  if (!project.ok) return null
  // The project file and user file are the same when the config root is this
  // project's .cat-code directory (including symlinked custom config roots).
  const projectConfigRoot = canonicalDirectory(join(project.realpath, '.cat-code'))
  const userConfigRoot = canonicalDirectory(resolve(project.realpath, configRoot))
  if (projectConfigRoot === userConfigRoot) {
    return null
  }
  return project.realpath
}
