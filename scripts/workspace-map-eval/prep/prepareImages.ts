#!/usr/bin/env bun
// Usage: bun prepareImages.ts <srcDir> <outDir>
// Applies the desktop composer's attachment preparation
// (app/renderer/src/imageAttachment.ts prepareImageAttachment) so the run
// receives the image the app would have sent: kept as-is when its base64 fits
// 90,000 chars; otherwise scaled to a 1,600px long edge and re-encoded as JPEG
// at 0.82/0.68/0.54/0.40 quality, shrinking 0.72x per pass, up to five passes.
// macOS sips stands in for the browser canvas encoder (an approximation).
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

const [src, out] = process.argv.slice(2) as [string, string]
const MAX = 90_000
rmSync(out, { recursive: true, force: true })
mkdirSync(out, { recursive: true })
const b64 = (f: string) => Math.ceil(statSync(f).size / 3) * 4
for (const name of readdirSync(src).sort((a, b) => parseInt(a) - parseInt(b))) {
  const file = join(src, name)
  const n = parseInt(name)
  if (b64(file) <= MAX) { execFileSync('cp', [file, join(out, name)]); console.log(JSON.stringify({ name, kept: true })); continue }
  const dims = execFileSync('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', file], { encoding: 'utf8' })
  const w = Number(/pixelWidth: (\d+)/.exec(dims)![1]), h = Number(/pixelHeight: (\d+)/.exec(dims)![1])
  let scale = Math.min(1, 1600 / Math.max(w, h))
  let done = false
  for (let pass = 0; pass < 5 && !done; pass++) {
    const edge = Math.max(1, Math.round(Math.max(w, h) * scale))
    for (const q of [82, 68, 54, 40]) {
      const dest = join(out, `${n}.jpeg`)
      execFileSync('sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', String(q), '-Z', String(edge), file, '--out', dest], { stdio: 'ignore' })
      if (b64(dest) <= MAX) { console.log(JSON.stringify({ name, from: [w, h], edge, quality: q / 100, base64Chars: b64(dest) })); done = true; break }
    }
    scale *= 0.72
  }
  if (!done) throw new Error(`${name}: the app would refuse this image as too large`)
}
void readFileSync
