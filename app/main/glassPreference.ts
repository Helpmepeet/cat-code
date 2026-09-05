import { readPreferenceFile, writePreferenceFile } from './preferenceFile.js'

const GLASS_PREFERENCE_FILE = 'glass-preference.json'

type GlassPreference = { version: 1; enabled: boolean }

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
