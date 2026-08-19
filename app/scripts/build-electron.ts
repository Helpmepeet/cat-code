/**
 * Build the Electron main + preload bundles from their TypeScript sources.
 *
 * - main → ESM (`main/main.js` as ESM): Electron 33 runs an ESM main process,
 *   and main uses `import.meta.url`.
 * - preload → CJS (`preload/preload.js`): a sandboxed preload (sandbox:true)
 *   must be a single CommonJS file. It uses no `import.meta`.
 *
 * `electron` + node builtins stay external (provided by the runtime). The engine
 * is NOT bundled — main/preload/supervisor import engine TYPES only, erased at
 * build time.
 */

import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const appRoot = join(here, '..')

async function buildOne(
  entry: string,
  format: 'esm' | 'cjs',
  ext: 'js' | 'cjs',
  options: { name?: string; define?: Record<string, string> } = {},
): Promise<void> {
  const result = await Bun.build({
    entrypoints: [entry],
    outdir: appRoot,
    target: 'node',
    format,
    external: ['electron'],
    naming: options.name ?? `[dir]/[name].${ext}`,
    root: appRoot,
    define: options.define,
  })
  if (!result.success) {
    for (const message of result.logs) console.error(message)
    throw new Error(`bundle failed: ${entry}`)
  }
  for (const output of result.outputs) console.log(`  built ${output.path}`)
}

/**
 * Build-time identity stamp (P5-1 / LOCAL-USE-CONTRACT §3).
 *
 * `main.ts` reads `process.env.CATCODE_BUILD_ID` and `CATCODE_COMMIT_ID` for the
 * diagnostics bundle, but a double-clicked `.app` inherits no shell
 * environment, so in a packaged run those can only ever arrive as build-time
 * constants. `package-app.ts` sets them; a development build leaves them
 * `undefined`, which is what main saw before this existed.
 */
function stampDefines(): Record<string, string> {
  const stamp: Record<string, string> = {}
  for (const key of ['CATCODE_BUILD_ID', 'CATCODE_COMMIT_ID'] as const) {
    const value = process.env[key]
    stamp[`process.env.${key}`] = value ? JSON.stringify(value) : 'undefined'
  }
  return stamp
}

async function build(): Promise<void> {
  // main as ESM .js (package is type:module); preload as CJS .cjs (sandboxed
  // preload must be CommonJS, and .cjs opts out of the package's ESM default).
  await buildOne(join(appRoot, 'main', 'main.ts'), 'esm', 'js', {
    define: stampDefines(),
  })
  await buildOne(join(appRoot, 'preload', 'preload.ts'), 'cjs', 'cjs', {
    define: { __CATCODE_DEV_HARNESS__: 'false' },
  })
  await buildOne(join(appRoot, 'preload', 'preload.ts'), 'cjs', 'cjs', {
    name: '[dir]/[name].dev.cjs',
    define: { __CATCODE_DEV_HARNESS__: 'true' },
  })
}

void build()
