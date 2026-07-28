/**
 * Guards the dev-mode trap that cost a full debugging day on 2026-07-28.
 *
 * Electron derives `app.isPackaged` from `basename(process.execPath)`
 * lowercased: any executable not named `electron` reports PACKAGED, so main.ts
 * flips `IS_DEV` false, loads the stale `renderer/dist` instead of the Vite
 * server, and silently kills HMR plus every `import.meta.env.DEV` surface.
 * Rebranding the dev bundle therefore has to touch the Info.plist DISPLAY keys
 * only, never CFBundleExecutable and never the file's name.
 *
 * Nothing here executes prepareDevElectron(): it copies and re-signs a real
 * bundle the operator's running dev app may be launched from. The invariants
 * are asserted against the exported constants the script itself consumes, plus
 * source shape for the two mutations that would bypass them.
 */
import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { basename } from 'node:path'

import { DEV_ELECTRON_BINARY, REBRANDED_PLIST_KEYS } from './prepare-dev-electron.js'

const source = readFileSync(
  new URL('./prepare-dev-electron.ts', import.meta.url),
  'utf8',
)

test('the dev binary keeps Electron own name, so app.isPackaged stays false', () => {
  expect(basename(DEV_ELECTRON_BINARY).toLowerCase()).toBe('electron')
  // The rebrand rides the BUNDLE name; the executable inside it does not move.
  expect(DEV_ELECTRON_BINARY).toContain('Cat Code Dev.app/Contents/MacOS/')
  expect(source).toContain('return DEV_ELECTRON_BINARY')
})

test('only the Info.plist display keys are rewritten, never CFBundleExecutable', () => {
  expect([...REBRANDED_PLIST_KEYS]).toEqual(['CFBundleName', 'CFBundleDisplayName'])
  expect([...REBRANDED_PLIST_KEYS]).not.toContain('CFBundleExecutable')
  // The exported list is the one the PlistBuddy loop actually iterates.
  expect(source).toContain('for (const key of REBRANDED_PLIST_KEYS)')
})

test('the rebrand never renames the copied executable', () => {
  const commands = [...source.matchAll(/run\('([^']+)'/g)].map(m => m[1])
  expect(commands).toEqual(['cp', '/usr/libexec/PlistBuddy', 'codesign'])
  expect(source).not.toContain('renameSync')
})
