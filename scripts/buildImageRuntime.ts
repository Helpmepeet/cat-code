import { cpSync, mkdirSync, readdirSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

/** Ship only Sharp's bundled JS and the platform's native runtime, not node_modules. */
export async function buildImageRuntime(executable: string): Promise<string> {
  const require = createRequire(import.meta.url)
  const platform = `${process.platform}-${process.arch}`
  if (process.platform !== 'darwin') {
    throw new Error(`Image runtime packaging is not qualified for ${platform}`)
  }
  const root = join(dirname(executable), 'image-runtime')
  const native = require.resolve(`@img/sharp-${platform}/sharp.node`)
  const vipsPackage = require.resolve(`@img/sharp-libvips-${platform}/package`)
  const vips = join(dirname(vipsPackage), 'lib')
  mkdirSync(join(root, 'native', 'lib'), { recursive: true })
  cpSync(native, join(root, 'native', 'lib', 'sharp.node'))
  // Preserve the addon's existing @loader_path/../../sharp-libvips-*/lib rpath.
  const vipsOutput = join(root, `sharp-libvips-${platform}`, 'lib')
  mkdirSync(vipsOutput, { recursive: true })
  for (const name of readdirSync(vips)) {
    if (name.endsWith('.dylib')) cpSync(join(vips, name), join(vipsOutput, name))
  }
  const result = await Bun.build({
    entrypoints: [require.resolve('sharp')],
    outdir: root,
    naming: 'sharp.cjs',
    target: 'bun',
    format: 'cjs',
    minify: true,
    plugins: [{
      name: 'sharp-native-runtime',
      setup(build) {
        build.onLoad({ filter: /[/\\]sharp[/\\]lib[/\\]sharp\.js$/ }, () => ({
          contents: 'module.exports = require("./native/lib/sharp.node")',
          loader: 'js',
        }))
        build.onResolve({ filter: /^\.\/native\/lib\/sharp\.node$/ }, args => ({
          path: args.path,
          external: true,
        }))
      },
    }],
  })
  if (!result.success) throw new AggregateError(result.logs, 'Image runtime build failed')
  return root
}
