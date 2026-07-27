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
const sourceApp = join(appRoot, 'node_modules', 'electron', 'dist', 'Electron.app')
const cacheDir = join(appRoot, '.dev-electron')
const targetApp = join(cacheDir, `${DEV_APP_NAME}.app`)
const versionMarker = join(cacheDir, '.electron-version')

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

  const version = electronVersion()
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
    run('mv', [
      join(targetApp, 'Contents', 'MacOS', 'Electron'),
      join(targetApp, 'Contents', 'MacOS', DEV_APP_NAME),
    ])
    const plist = join(targetApp, 'Contents', 'Info.plist')
    for (const key of ['CFBundleName', 'CFBundleDisplayName', 'CFBundleExecutable']) {
      run('/usr/libexec/PlistBuddy', ['-c', `Set :${key} ${DEV_APP_NAME}`, plist])
    }
    // Renaming the executable invalidates the ad-hoc signature Electron
    // ships with (it was ad-hoc/unsigned already — see codesign -dv on the
    // stock bundle — so re-signing ad-hoc doesn't change its trust level).
    run('codesign', ['--sign', '-', '--force', '--deep', targetApp])
    writeFileSync(versionMarker, version)
  }
  return join(targetApp, 'Contents', 'MacOS', DEV_APP_NAME)
}

if (import.meta.main) {
  const path = prepareDevElectron()
  console.log(
    path
      ? `[prepare-dev-electron] ready: ${path}`
      : '[prepare-dev-electron] skipped (non-darwin or electron not installed)',
  )
}
