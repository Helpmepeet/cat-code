import { readPreferenceFile, writePreferenceFile } from './preferenceFile.js'

const GLASS_PREFERENCE_FILE = 'glass-preference.json'

type GlassPreference = { version: 1; enabled: boolean }

type GlassWindow = {
  setBackgroundColor(color: string): void
  webContents: { invalidate(): void }
}

export function applyGlassWindowBackground(window: GlassWindow | null, enabled: boolean): void {
  if (!window) return
  window.setBackgroundColor(enabled ? '#00000000' : '#09090b')
  // A native background change can leave the old composited surface visible
  // until resize. Repaint without resizing or reloading the running renderer.
  window.webContents.invalidate()
}

export function readGlassPreference(userDataDir: string): boolean {
  return (
    readPreferenceFile(userDataDir, GLASS_PREFERENCE_FILE, raw => {
      const value = raw as Partial<GlassPreference>
      return value.version === 1 && typeof value.enabled === 'boolean'
        ? value.enabled
        : null
    }) ?? false
  )
}

export function writeGlassPreference(userDataDir: string, enabled: boolean): void {
  writePreferenceFile(userDataDir, GLASS_PREFERENCE_FILE, {
    version: 1,
    enabled,
  })
}
