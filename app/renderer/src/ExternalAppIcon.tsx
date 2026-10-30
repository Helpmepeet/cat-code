import { useEffect, useState } from 'react'
import type { ExternalAppIconRequest } from '../../shared/externalAppIcons.js'
import './externalAppIcon.css'

/** Display-only: the host resolves installed apps and owns all image bytes. */
export function ExternalAppIcon({ request }: { request: ExternalAppIconRequest }) {
  const target = request.target
  const appSessionId = request.target === 'default' ? request.appSessionId : undefined
  const path = request.target === 'default' ? request.path : undefined
  const key = JSON.stringify([target, appSessionId, path])
  const [loaded, setLoaded] = useState<{ key: string; dataUrl: string } | null>(null)
  const [failed, setFailed] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    const input: ExternalAppIconRequest = target === 'default'
      ? { target, appSessionId: appSessionId!, path: path! }
      : { target }
    void (async () => {
      try {
        const icon = await window.catcode?.getExternalAppIcon?.(input)
        if (active && icon?.dataUrl && /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(icon.dataUrl)) {
          setLoaded({ key, dataUrl: icon.dataUrl })
        }
      } catch {
        // Missing apps, a disconnected host, and unreadable icons retain the glyph.
      }
    })()
    return () => { active = false }
  }, [target, appSessionId, path, key])

  const src = loaded?.key === key ? loaded.dataUrl : null
  return (
    <span className="external-app-icon" aria-hidden="true" data-app-target={target}>
      {src && failed !== src ? (
        <img src={src} alt="" draggable={false} onError={() => setFailed(src)} />
      ) : (
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
          {target === 'browser' ? <><circle cx="12" cy="12" r="9" /><path d="M3 12h18M12 3c5 5 5 13 0 18-5-5-5-13 0-18Z" /></>
            : target === 'finder' ? <path d="M3 7V5h6l2 2h10v13H3V7Z" />
            : <><rect x="3" y="4" width="18" height="16" rx="3" /><path d="M3 9h18M7 6.5h.01M10 6.5h.01" /></>}
        </svg>
      )}
    </span>
  )
}
