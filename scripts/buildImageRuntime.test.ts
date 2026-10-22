import { expect, test } from 'bun:test'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { randomFillSync } from 'node:crypto'
import { createRequire } from 'node:module'
import sharp from 'sharp'
import { buildImageRuntime } from './buildImageRuntime.js'
import { scanPackagedBundle } from '../app/scripts/packagedBundleScan.js'

const root = resolve(import.meta.dir, '..')

test.skipIf(process.platform !== 'darwin')('compiled image processing resizes and compresses without checkout dependencies', async () => {
  const temp = mkdtempSync(join(tmpdir(), 'cat-compiled-images-'))
  try {
    const sidecar = join(temp, 'Cat.app', 'Contents', 'Resources', 'sidecar')
    mkdirSync(sidecar, { recursive: true })
    const executable = join(sidecar, 'cat-code-sidecar')
    const entry = join(temp, 'probe.ts')
    const wide = join(temp, 'wide.png')
    const noise = join(temp, 'noise.png')
    await sharp({ create: { width: 3120, height: 1540, channels: 3, background: '#ff9933' } }).png().toFile(wide)
    await sharp(randomFillSync(Buffer.alloc(900 * 900 * 3)), {
      raw: { width: 900, height: 900, channels: 3 },
    }).png().toFile(noise)
    const legacyEntry = join(temp, 'legacy.ts')
    const legacyExecutable = join(temp, 'legacy')
    const sharpPath = createRequire(import.meta.url).resolve('sharp')
    writeFileSync(legacyEntry, `
      const { default: sharp } = await import(${JSON.stringify(sharpPath)})
      await sharp(await Bun.file(process.argv[2]).arrayBuffer()).metadata()
    `)
    const legacyBuild = Bun.spawnSync([
      process.execPath, 'build', legacyEntry, '--compile', '--target=bun',
      '--outfile', legacyExecutable,
    ], { cwd: root })
    expect(legacyBuild.exitCode, legacyBuild.stderr.toString()).toBe(0)
    const legacyRun = Bun.spawnSync([legacyExecutable, wide], {
      cwd: temp,
      env: { PATH: '/usr/bin:/bin', HOME: temp },
    })
    expect(legacyRun.exitCode).not.toBe(0)
    expect(legacyRun.stderr.toString()).toContain('Could not load the "sharp" module')
    writeFileSync(entry, `
      import { readFileSync } from 'node:fs'
      import { maybeResizeAndDownsampleImageBuffer, compressImageBuffer } from ${JSON.stringify(join(root, 'src/utils/imageResizer.ts'))}
      import { getImageProcessor, getImageCreator } from ${JSON.stringify(join(root, 'src/tools/FileReadTool/imageProcessor.ts'))}
      const input = readFileSync(process.argv[2])
      const resized = await maybeResizeAndDownsampleImageBuffer(input, input.length, 'png')
      const sharp = await getImageProcessor()
      const metadata = await sharp(resized.buffer).metadata()
      if (metadata.width !== 2000 || metadata.height !== 987) throw Error('resize did not run: ' + JSON.stringify(metadata))
      const noisy = readFileSync(process.argv[3])
      const compressed = await compressImageBuffer(noisy, 150000, 'image/png')
      const compressedBuffer = Buffer.from(compressed.base64, 'base64')
      if (compressedBuffer.length > 150000 || compressedBuffer.equals(noisy)) throw Error('compression did not run')
      const decoded = await sharp(compressedBuffer).metadata()
      if (!decoded.width || !decoded.height) throw Error('invalid compressed image')
      const create = await getImageCreator()
      const created = await create({create:{width:3,height:2,channels:3,background:{r:1,g:2,b:3}}}).png().toBuffer()
      if ((await sharp(created).metadata()).width !== 3) throw Error('creator did not run')
      console.log(JSON.stringify({width:metadata.width,height:metadata.height,inputBytes:noisy.length,compressedBytes:compressedBuffer.length}))
    `)
    const build = Bun.spawnSync([
      process.execPath, 'build', entry, '--compile', '--target=bun',
      '--format=esm', '--minify', '--bytecode', '--packages=bundle', '--conditions=bun',
      '--define', 'process.env.USER_TYPE="external"',
      '--external', '@ant/*',
      '--external', 'audio-capture-napi',
      '--external', 'image-processor-napi',
      '--external', 'modifiers-napi',
      '--external', 'url-handler-napi',
      '--outfile', executable,
    ], { cwd: root })
    expect(build.exitCode, build.stderr.toString()).toBe(0)
    const env = { PATH: '/usr/bin:/bin', HOME: temp, CLAUDE_CONFIG_DIR: join(temp, 'state') }
    const run = () => Bun.spawnSync([executable, wide, noise], { cwd: temp, env })
    // A compiled processor must not silently fall back to a checkout's Sharp.
    const missing = run()
    expect(missing.exitCode).not.toBe(0)
    await buildImageRuntime(executable)
    const result = run()
    expect(result.exitCode, result.stderr.toString()).toBe(0)
    expect(JSON.parse(result.stdout.toString())).toMatchObject({ width: 2000, height: 987 })
    expect(scanPackagedBundle(join(temp, 'Cat.app'))).toEqual([])
    // The original PNG is genuinely over the model dimension limit.
    expect(readFileSync(wide).readUInt32BE(16)).toBe(3120)
    console.log(result.stdout.toString().trim())
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
}, 120000)
