import { normalizeLocalhostPreviewUrl } from '../shared/filePreview.js'

export interface LocalhostPopupSource { id: string; frameName: string; url: string }

/** Native popups remain denied; only a proven live preview receives the note. */
export function createLocalhostPopups(deps: {
  records: () => readonly LocalhostPopupSource[]
  frames: () => readonly LocalhostPopupSource[]
  focusedFrameName: () => Promise<unknown>
  leave: (id: string, url: string) => unknown
}) {
  let pending = false, disposed = false
  const sources = (): readonly LocalhostPopupSource[] => {
    const records = deps.records()
    return deps.frames().filter(frame => {
      const record = records.find(record => record.id === frame.id && record.frameName === frame.frameName)
      const actual = normalizeLocalhostPreviewUrl(frame.url), known = record && normalizeLocalhostPreviewUrl(record.url)
      return !!actual && !!known && new URL(actual).origin === new URL(known).origin
    })
  }
  const normalized = (value: string) => { if (value.length > 4096) return null; try { const url = new URL(value); url.hash = ''; return url } catch { return null } }
  const identity = (source: LocalhostPopupSource) => `${source.id}\0${source.frameName}\0${source.url}`
  return {
    handle(url: string, referrer: string): void {
      if (disposed || url.length > 4096) return
      const current = sources()
      if (!current.length) return
      const origin = normalized(referrer)
      const exact = origin ? current.filter(source => normalized(source.url)?.href === origin.href) : []
      const candidates = exact.length ? exact : origin ? current.filter(source => normalized(source.url)?.origin === origin.origin) : []
      if (candidates.length && candidates.every(source => source.id === candidates[0]!.id)) {
        deps.leave(candidates[0]!.id, url)
        return
      }
      if (pending) return
      pending = true
      let expired = false
      const timer = setTimeout(() => { expired = true }, 200)
      const allowed = new Set(current.map(identity))
      let request: Promise<unknown>
      try { request = deps.focusedFrameName() } catch { clearTimeout(timer); pending = false; return }
      // Keep admission held until the underlying operation settles, even if it
      // outlives the deadline. A stalled page cannot accumulate focus lookups.
      void request.then(value => {
        if (disposed || expired || typeof value !== 'string' || value.length > 160) return
        const source = sources().find(source => source.frameName === value && allowed.has(identity(source)))
        if (source) deps.leave(source.id, url)
      }, () => {}).catch(() => {}).finally(() => { clearTimeout(timer); pending = false })
    },
    dispose(): void { disposed = true },
  }
}
