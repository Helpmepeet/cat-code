import type { CwdValidation } from '../host/host.js'
import type { EditableSettingSource } from '../shared/settingsEditable.js'

/** User defaults and project/local overrides have distinct storage targets. */
export function settingsWriteMatchesScope(
  source: EditableSettingSource,
  requestedProjectCwd: unknown,
): boolean {
  return source === 'userSettings'
    ? requestedProjectCwd === null
    : typeof requestedProjectCwd === 'string' && requestedProjectCwd.length > 0
}

/** Only previously observed projects may be named by the renderer. */
export function resolveSettingsInventoryCwd(
  requested: unknown,
  homeCwd: string,
  knownProjectCwds: ReadonlySet<string>,
  validateCwd: (cwd: string) => CwdValidation,
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
  return project.ok ? project.realpath : null
}
