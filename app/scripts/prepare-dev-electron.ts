/**
 * Rebrand the dev-only Electron binary so the Dock shows "Cat Code Dev"
 * instead of the stock "Electron" name/tooltip. `app.setName()` in main.ts
 * only renames the JS-level app.name (AX title/menu bar/window title already
 * follow it and were GUI-verified working) — the Dock tile's hover tooltip
 * comes from the running bundle's own Info.plist, which JS can't touch at
 * runtime. A separate renamed copy (never touching the vendored
 * node_modules/electron other scripts/tests spawn) is cheaper and safer than
 * mutating it in place.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { spawnSync } from 'node:child_process'

const here = dirname(fileURLToPath(import.meta.url))
const appRoot = join(here, '..')

const DEV_APP_NAME = 'Cat Code Dev'
/**
 * Bump when the rebrand STEPS change, not when Electron does. The cache key was
 * the Electron version alone, so editing this recipe left every existing
 * `.dev-electron` bundle stale and the change silently did nothing.
 */
const REBRAND_RECIPE = 2
const sourceApp = join(appRoot, 'node_modules', 'electron', 'dist', 'Electron.app')
const cacheDir = join(appRoot, '.dev-electron')
const targetApp = join(cacheDir, `${DEV_APP_NAME}.app`)
const versionMarker = join(cacheDir, '.electron-version')

/**
 * The Info.plist keys the rebrand rewrites. Exported so the invariant is
 * testable: CFBundleExecutable must never join this list (see the loop below).
 */
export const REBRANDED_PLIST_KEYS = ['CFBundleName', 'CFBundleDisplayName'] as const

/**
 * The path prepareDevElectron() hands back. Its BASENAME is load-bearing:
 * Electron lowercases `basename(process.execPath)` to decide `app.isPackaged`,
 * so it has to stay `Electron` (see the loop below).
 */
export const DEV_ELECTRON_BINARY = join(targetApp, 'Contents', 'MacOS', 'Electron')

function electronVersion(): string {
  const pkg = JSON.parse(
    readFileSync(join(appRoot, 'node_modules', 'electron', 'package.json'), 'utf8'),
  )
  return pkg.version
}

function run(cmd: string, args: string[]): void {
  const result = spawnSync(cmd, args, { stdio: 'inherit' })
  if (result.status !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} failed (exit ${result.status})`)
  }
}

/**
 * Returns the rebranded binary's absolute path, (re)building the cached copy
 * only when missing or stale. Returns null on non-macOS or if electron isn't
 * installed yet — callers fall back to the stock `.bin/electron` path.
 */
export function prepareDevElectron(): string | null {
  if (process.platform !== 'darwin') return null
  if (!existsSync(sourceApp)) return null

  const version = `${electronVersion()} r${REBRAND_RECIPE}`
  const isCached =
    existsSync(targetApp) &&
    existsSync(versionMarker) &&
    readFileSync(versionMarker, 'utf8').trim() === version
  if (!isCached) {
    rmSync(cacheDir, { recursive: true, force: true })
    mkdirSync(cacheDir, { recursive: true })
    // -c clones on APFS (fast, exact attrs/xattrs); falls back to a plain copy
    // if the volume doesn't support it.
    run('cp', ['-Rc', sourceApp, targetApp])
    // The EXECUTABLE deliberately keeps Electron's own name.
    //
    // Electron derives `app.isPackaged` from `basename(process.execPath)`: any
    // name other than `electron` reports PACKAGED. Renaming it here therefore
    // told main.ts it was a production build, so `IS_DEV` went false and the
    // window loaded `renderer/dist` instead of the Vite server dev.ts had just
    // started — silently killing HMR and every `import.meta.env.DEV` surface
    // (found 2026-07-28). Only the display keys need to change; the Dock tile
    // reads those, which is all the rebrand was ever for. CFBundleExecutable is
    // excluded too: it must keep naming the file that actually exists.
    const plist = join(targetApp, 'Contents', 'Info.plist')
    for (const key of REBRANDED_PLIST_KEYS) {
      run('/usr/libexec/PlistBuddy', ['-c', `Set :${key} ${DEV_APP_NAME}`, plist])
    }
    // Editing Info.plist invalidates the ad-hoc signature Electron ships with
    // (it was ad-hoc/unsigned already — see codesign -dv on the stock bundle —
    // so re-signing ad-hoc doesn't change its trust level).
    run('codesign', ['--sign', '-', '--force', '--deep', targetApp])
    writeFileSync(versionMarker, version)
  }
  return DEV_ELECTRON_BINARY
}

if (import.meta.main) {
  const path = prepareDevElectron()
  console.log(
    path
      ? `[prepare-dev-electron] ready: ${path}`
      : '[prepare-dev-electron] skipped (non-darwin or electron not installed)',
  )
}
