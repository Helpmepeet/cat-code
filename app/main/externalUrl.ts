import { isSafeExternalUrl } from './navigationPolicy.js'

/** App links never borrow popup provenance from an embedded page. */
export function createExternalUrlHandler<E>(deps: {
  isTrustedSender: (event: E) => boolean
  open: (url: string) => Promise<void>
}) {
  let active = 0
  return async (event: E, input: unknown): Promise<boolean> => {
    if (!deps.isTrustedSender(event) || active >= 4 || !input || typeof input !== 'object' || Array.isArray(input)) return false
    const value = input as Record<string, unknown>
    if (Object.keys(value).length !== 1 || typeof value.url !== 'string' || !value.url || value.url.length > 4096 || value.url.includes('\0') || !isSafeExternalUrl(value.url)) return false
    let url: string
    try { url = new URL(value.url).href } catch { return false }
    if (url.length > 4096) return false
    active++
    try { await deps.open(url); return true }
    catch { return false }
    finally { active-- }
  }
}
