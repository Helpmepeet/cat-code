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
): Promise<void> {
  const result = await Bun.build({
    entrypoints: [entry],
    outdir: appRoot,
    target: 'node',
    format,
    external: ['electron'],
    naming: `[dir]/[name].${ext}`,
    root: appRoot,
  })
  if (!result.success) {
    for (const message of result.logs) console.error(message)
    throw new Error(`bundle failed: ${entry}`)
  }
  for (const output of result.outputs) console.log(`  built ${output.path}`)
}

async function build(): Promise<void> {
  // main as ESM .js (package is type:module); preload as CJS .cjs (sandboxed
  // preload must be CommonJS, and .cjs opts out of the package's ESM default).
  await buildOne(join(appRoot, 'main', 'main.ts'), 'esm', 'js')
  await buildOne(join(appRoot, 'preload', 'preload.ts'), 'cjs', 'cjs')
}

void build()
