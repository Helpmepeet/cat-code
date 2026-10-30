import { parseExternalAppIconRequest, type ExternalAppIcon, type ExternalAppIconTarget } from '../shared/externalAppIcons.js'

/** Fixed display-only boundary. File associations never accept an unvalidated path. */
export function createExternalAppIconHandler<E>(deps: {
  isTrustedSender: (event: E) => boolean
  resolveFile: (appSessionId: string, path: string) => Promise<string | null>
  read: (target: ExternalAppIconTarget, trustedPath?: string) => Promise<ExternalAppIcon>
}) {
  let active = 0
  return async (event: E, ...args: unknown[]): Promise<ExternalAppIcon> => {
    const fallback: ExternalAppIcon = { dataUrl: null }
    if (!deps.isTrustedSender(event) || args.length !== 1 || active >= 8) return fallback
    const request = parseExternalAppIconRequest(args[0])
    if (!request) return fallback
    active++
    try {
      if (request.target !== 'default') return await deps.read(request.target)
      const path = await deps.resolveFile(request.appSessionId, request.path)
      return path ? await deps.read('default', path) : fallback
    } catch {
      return fallback
    } finally {
      active--
    }
  }
}
