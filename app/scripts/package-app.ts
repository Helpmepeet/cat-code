/**
 * Build the double-clickable Cat Code application (P5-1).
 *
 *   bun run --cwd app package
 *
 * Conforms to `docs/migration/decisions/LOCAL-USE-CONTRACT.md`: one macOS
 * `.app` for this machine, ad-hoc signed, identified by `com.catcode.desktop`,
 * versioned by git SHA rather than a release number.
 *
 * The one hard requirement is that the result runs with no checkout. Development
 * spawns the sidecar as repository TypeScript under `bun` off PATH, so the
 * packaging step compiles the sidecar and its whole engine graph into a single
 * standalone Bun executable that ships inside the bundle
 * (`app/sidecar/packagedEntry.ts` selects the mode). No new dependency is
 * involved: `bun build --compile` is the same mechanism `scripts/build.ts`
 * already uses for `cli-dev`, and the assembly below is `cp` plus PlistBuddy
 * plus `codesign`, exactly as `prepare-dev-electron.ts` does for the dev binary.
 */

import { spawnSync } from 'node:child_process'
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { SIDECAR_RUNTIME_ARGS, PACKAGED_SIDECAR_BINARY } from '../main/mainDecisions.js'
import { scanPackagedBundle, formatBundleScanFindings } from './packagedBundleScan.js'

const here = dirname(fileURLToPath(import.meta.url))
const appRoot = join(here, '..')
const repoRoot = join(appRoot, '..')

/** LOCAL-USE-CONTRACT §2. macOS keys per-app state to this; do not change it. */
const BUNDLE_ID = 'com.catcode.desktop'
const APP_NAME = 'Cat Code'
/** LOCAL-USE-CONTRACT §4: one deterministic output path, wiped every build. */
const OUT_DIR = join(appRoot, 'dist-app')
const APP_BUNDLE = join(OUT_DIR, `${APP_NAME}.app`)
const CONTENTS = join(APP_BUNDLE, 'Contents')
const RESOURCES = join(CONTENTS, 'Resources')
/** Electron loads `Contents/Resources/app/` and reads `main` from its package.json. */
const APP_PAYLOAD = join(RESOURCES, 'app')

function run(
  cmd: string,
  args: string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; quiet?: boolean } = {},
): void {
  const { quiet, ...spawnOptions } = options
  const result = spawnSync(cmd, args, {
    stdio: quiet ? ['ignore', 'ignore', 'pipe'] : 'inherit',
    ...spawnOptions,
  })
  if (result.status !== 0) {
    if (quiet && result.stderr) process.stderr.write(result.stderr.toString())
    throw new Error(`${cmd} ${args.join(' ')} failed (exit ${result.status})`)
  }
}

function capture(cmd: string, args: string[]): string | null {
  const result = spawnSync(cmd, args, { encoding: 'utf8', cwd: repoRoot })
  if (result.status !== 0) return null
  return result.stdout.trim() || null
}

function plistSet(plist: string, key: string, value: string): void {
  // Set fails on a key the stock Info.plist does not already carry, so fall
  // back to Add. Both are stock macOS tooling.
  const set = spawnSync('/usr/libexec/PlistBuddy', ['-c', `Set :${key} ${value}`, plist], {
    stdio: 'ignore',
  })
  if (set.status === 0) return
  run('/usr/libexec/PlistBuddy', ['-c', `Add :${key} string ${value}`, plist])
}

/**
 * Version authority (LOCAL-USE-CONTRACT §3). The SHA is the identity; the
 * numeric version stays `0.0.0` because "not independently versioned" is the
 * true statement and a made-up release number would not be.
 */
function buildStamp(): { commitId: string; buildId: string; dirty: boolean } {
  const commitId = capture('git', ['rev-parse', 'HEAD']) ?? 'unknown'
  const dirty = (capture('git', ['status', '--porcelain']) ?? '') !== ''
  const short = commitId === 'unknown' ? 'unknown' : commitId.slice(0, 8)
  return { commitId, buildId: dirty ? `${short}-dirty` : short, dirty }
}

function buildRenderer(): void {
  console.log('[package] renderer')
  run('bun', ['run', 'renderer:build'], { cwd: appRoot })
}

function buildMainAndPreload(stamp: { commitId: string; buildId: string }): void {
  console.log('[package] main + preload')
  // The two ids reach a double-clicked app only as build-time constants: a GUI
  // launch inherits no shell environment, so `main.ts`'s reads of
  // `process.env.CATCODE_BUILD_ID`/`CATCODE_COMMIT_ID` would be undefined
  // forever otherwise (LOCAL-USE-CONTRACT §3 named this the gap to close).
  run('bun', ['run', join(here, 'build-electron.ts')], {
    env: {
      ...process.env,
      CATCODE_BUILD_ID: stamp.buildId,
      CATCODE_COMMIT_ID: stamp.commitId,
    },
  })
}

function buildSidecar(): void {
  console.log('[package] sidecar (compiled, standalone)')
  mkdirSync(join(RESOURCES, 'sidecar'), { recursive: true })
  const outfile = join(RESOURCES, 'sidecar', PACKAGED_SIDECAR_BINARY)
  // Features are baked in from the SAME list the development spawn passes as
  // Bun runtime flags for the SESSION sidecar, so the packaged engine is the
  // engine that was tested. One binary serves all five modes, so the three
  // disposable workers get those features here even though development starts
  // them without: see the divergence note on `SIDECAR_MODE_ENTRIES`.
  const features = SIDECAR_RUNTIME_ARGS.filter(arg => arg.startsWith('--feature='))
  const cmd = [
    'bun',
    'build',
    join(appRoot, 'sidecar', 'packagedEntry.ts'),
    '--compile',
    '--target',
    'bun',
    '--format',
    'esm',
    '--outfile',
    outfile,
    '--packages',
    'bundle',
    '--conditions',
    'bun',
    ...features,
    // Optional native addons the engine loads defensively; they are absent from
    // this source snapshot and `scripts/build.ts` externalizes them the same way.
    '--external', '@ant/*',
    '--external', 'audio-capture-napi',
    '--external', 'image-processor-napi',
    '--external', 'modifiers-napi',
    '--external', 'url-handler-napi',
    // Mirrors `scripts/build.ts`. `USER_TYPE` folds away the internal-only
    // `require()`s that do not exist in this snapshot, and MACRO is the engine's
    // build-metadata global — `initializeRuntime.ts` shims it only when a build
    // did not define it, which is exactly this case.
    '--define', 'process.env.USER_TYPE="external"',
    '--define', 'process.env.CLAUDE_CODE_FORCE_FULL_LOGO="true"',
    '--define', 'process.env.CLAUDE_CODE_VERIFY_PLAN="false"',
    '--define', 'process.env.CCR_FORCE_BUNDLE="true"',
    '--define', `MACRO.VERSION=${JSON.stringify(engineVersion())}`,
    '--define', `MACRO.BUILD_TIME=${JSON.stringify(new Date().toISOString())}`,
    '--define', 'MACRO.PACKAGE_URL="@cat-code/desktop"',
    '--define', 'MACRO.NATIVE_PACKAGE_URL=undefined',
    '--define', 'MACRO.FEEDBACK_CHANNEL="github"',
    '--define', 'MACRO.ISSUES_EXPLAINER="This build is local-use only."',
    '--define', 'MACRO.VERSION_CHANGELOG="Local desktop build."',
  ]
  run(cmd[0]!, cmd.slice(1), { cwd: repoRoot })
}

let cachedStamp: { commitId: string; buildId: string; dirty: boolean } | null = null
function stamp(): { commitId: string; buildId: string; dirty: boolean } {
  cachedStamp ??= buildStamp()
  return cachedStamp
}

/** The ENGINE's version string, which is the root package's, plus the SHA. */
function engineVersion(): string {
  const rootPkg = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
    version: string
  }
  return `${rootPkg.version}-desktop.sha${stamp().buildId}`
}

function makeIcon(): string | null {
  const source = join(appRoot, 'resources', 'icon.png')
  if (!existsSync(source)) return null
  const iconset = join(OUT_DIR, 'catcode.iconset')
  mkdirSync(iconset, { recursive: true })
  // Stock macOS tooling; no image dependency.
  for (const size of [16, 32, 64, 128, 256, 512]) {
    run('sips', ['-z', String(size), String(size), source, '--out', join(iconset, `icon_${size}x${size}.png`)], { quiet: true })
    run('sips', ['-z', String(size * 2), String(size * 2), source, '--out', join(iconset, `icon_${size}x${size}@2x.png`)], { quiet: true })
  }
  const icns = join(OUT_DIR, 'catcode.icns')
  run('iconutil', ['-c', 'icns', iconset, '-o', icns], { quiet: true })
  rmSync(iconset, { recursive: true, force: true })
  return icns
}

function assembleBundle(): void {
  const sourceApp = join(appRoot, 'node_modules', 'electron', 'dist', 'Electron.app')
  if (!existsSync(sourceApp)) {
    throw new Error(`electron is not installed at ${sourceApp}; run 'bun install' in app/`)
  }
  console.log('[package] bundle skeleton')
  // -Rc clones on APFS, preserving the framework's own signed structure.
  run('cp', ['-Rc', sourceApp, APP_BUNDLE])

  // The executable's BASENAME is what makes this a packaged build: Electron
  // lowercases basename(process.execPath) and reports app.isPackaged for
  // anything that is not `electron`. This is the deliberate inverse of
  // prepare-dev-electron.ts, which must keep that name to stay development.
  renameSync(join(CONTENTS, 'MacOS', 'Electron'), join(CONTENTS, 'MacOS', APP_NAME))

  // Electron's own placeholder app; it would never load once Resources/app
  // exists, and shipping it is dead weight in a bundle we scan for stowaways.
  rmSync(join(RESOURCES, 'default_app.asar'), { force: true })

  const plist = join(CONTENTS, 'Info.plist')
  plistSet(plist, 'CFBundleExecutable', APP_NAME)
  plistSet(plist, 'CFBundleName', APP_NAME)
  plistSet(plist, 'CFBundleDisplayName', APP_NAME)
  plistSet(plist, 'CFBundleIdentifier', BUNDLE_ID)
  // 0.0.0 per LOCAL-USE-CONTRACT §3: the commit id is the identity of record,
  // and these keys must not be dressed up to look like a release.
  plistSet(plist, 'CFBundleShortVersionString', '0.0.0')
  plistSet(plist, 'CFBundleVersion', '0.0.0')

  const icns = makeIcon()
  if (icns) {
    cpSync(icns, join(RESOURCES, 'catcode.icns'))
    rmSync(icns, { force: true })
    plistSet(plist, 'CFBundleIconFile', 'catcode.icns')
  }
}

function copyPayload(): void {
  console.log('[package] app payload')
  mkdirSync(APP_PAYLOAD, { recursive: true })

  // A generated package.json, not the repository's: the repository one carries
  // devDependencies and scripts that describe a checkout this bundle does not
  // have. `productName` is what names the Dock tile and the userData directory
  // in a packaged run, where main's IS_DEV `app.setName` never fires.
  writeFileSync(
    join(APP_PAYLOAD, 'package.json'),
    `${JSON.stringify(
      {
        name: 'cat-code-desktop',
        productName: APP_NAME,
        version: '0.0.0',
        private: true,
        type: 'module',
        main: 'main/main.js',
      },
      null,
      2,
    )}\n`,
  )

  mkdirSync(join(APP_PAYLOAD, 'main'), { recursive: true })
  cpSync(join(appRoot, 'main', 'main.js'), join(APP_PAYLOAD, 'main', 'main.js'))

  // The PRODUCTION preload only. preload.dev.cjs carries the dev harness and has
  // no business in a bundle; the scan below fails the build if it appears.
  mkdirSync(join(APP_PAYLOAD, 'preload'), { recursive: true })
  cpSync(join(appRoot, 'preload', 'preload.cjs'), join(APP_PAYLOAD, 'preload', 'preload.cjs'))

  // main.ts resolves these relative to its own __dirname: renderer/dist/index.html
  // is PACKAGED_INDEX_PATH and resources/icon.png is APP_ICON_PATH.
  cpSync(join(appRoot, 'renderer', 'dist'), join(APP_PAYLOAD, 'renderer', 'dist'), {
    recursive: true,
  })
  mkdirSync(join(APP_PAYLOAD, 'resources'), { recursive: true })
  cpSync(join(appRoot, 'resources', 'icon.png'), join(APP_PAYLOAD, 'resources', 'icon.png'))
}

function sign(): void {
  console.log('[package] ad-hoc signing')
  // LOCAL-USE-CONTRACT §5: nested executables first, then the bundle. Editing
  // Info.plist and renaming the executable both invalidate the signature the
  // stock Electron bundle ships with, and an unsigned nested binary makes the
  // whole app refuse to launch.
  run('codesign', ['--sign', '-', '--force', join(RESOURCES, 'sidecar', PACKAGED_SIDECAR_BINARY)])
  run('codesign', ['--sign', '-', '--force', '--deep', APP_BUNDLE])
}

function scan(): void {
  console.log('[package] stowaway scan')
  const findings = scanPackagedBundle(APP_BUNDLE)
  if (findings.length > 0) {
    process.stderr.write(`${formatBundleScanFindings(findings)}\n`)
    throw new Error(`${findings.length} disallowed file(s) in the bundle`)
  }
  console.log('[package]   clean')
}

function main(): void {
  if (process.platform !== 'darwin') {
    throw new Error('the local-use contract targets macOS only')
  }
  // Wiped, never merged: a prior build's stale resource must not survive into
  // this one and make a missing input look present.
  rmSync(OUT_DIR, { recursive: true, force: true })
  mkdirSync(OUT_DIR, { recursive: true })

  const info = stamp()
  console.log(`[package] commit ${info.buildId}${info.dirty ? ' (working tree dirty)' : ''}`)

  buildRenderer()
  buildMainAndPreload(info)
  assembleBundle()
  copyPayload()
  buildSidecar()
  sign()
  scan()

  console.log(`[package] built ${APP_BUNDLE}`)
  if (info.dirty) {
    console.log('[package] note: built from a dirty working tree, so the commit id under-describes it')
  }
}

main()
