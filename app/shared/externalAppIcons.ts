export const EXTERNAL_APP_ICON_TARGETS = ['vscode', 'zed', 'cursor', 'finder', 'browser', 'default', 'chrome', 'safari'] as const
export type ExternalAppIconTarget = typeof EXTERNAL_APP_ICON_TARGETS[number]
export type ExternalAppIconResult = { dataUrl: string | null }
export type ExternalAppIcon = ExternalAppIconResult
export type ExternalAppIconRequest =
  | { target: Exclude<ExternalAppIconTarget, 'default'> }
  | { target: 'default'; appSessionId: string; path: string }

export function parseExternalAppIconRequest(value: unknown): ExternalAppIconRequest | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const request = value as Record<string, unknown>
  const target = parseExternalAppIconTarget(request.target)
  if (!target) return null
  const keys = Object.keys(request)
  if (target !== 'default') return keys.length === 1 && keys[0] === 'target' ? { target } : null
  if (keys.length !== 3 || !keys.every(key => ['target', 'appSessionId', 'path'].includes(key))) return null
  if (typeof request.appSessionId !== 'string' || !request.appSessionId || request.appSessionId.length > 256) return null
  if (typeof request.path !== 'string' || !request.path || request.path.length > 4096 || request.path.includes('\0')) return null
  return { target, appSessionId: request.appSessionId, path: request.path }
}

/** Fixed application identities, independent of workspace-file validation. */
export function parseExternalAppIconTarget(value: unknown): ExternalAppIconTarget | null {
  return typeof value === 'string' && (EXTERNAL_APP_ICON_TARGETS as readonly string[]).includes(value)
    ? value as ExternalAppIconTarget
    : null
}
