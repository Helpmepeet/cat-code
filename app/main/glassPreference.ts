import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const GLASS_PREFERENCE_FILE = 'glass-preference.json'

type GlassPreference = { version: 1; enabled: boolean }

export function readGlassPreference(userDataDir: string): boolean {
  try {
    const value = JSON.parse(
      readFileSync(join(userDataDir, GLASS_PREFERENCE_FILE), 'utf8'),
    ) as Partial<GlassPreference>
    return value.version === 1 && typeof value.enabled === 'boolean'
      ? value.enabled
      : false
  } catch {
    return false
  }
}

export function writeGlassPreference(userDataDir: string, enabled: boolean): void {
  try {
    mkdirSync(userDataDir, { recursive: true })
    const target = join(userDataDir, GLASS_PREFERENCE_FILE)
    const temporary = `${target}.${process.pid}.tmp`
    writeFileSync(temporary, `${JSON.stringify({ version: 1, enabled })}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    })
    renameSync(temporary, target)
  } catch {
    // A visual preference must not make the window unusable when user-data storage fails.
  }
}
