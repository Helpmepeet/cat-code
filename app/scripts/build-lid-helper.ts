import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync, copyFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export function buildLidHelper(): void {
  if (process.platform !== 'darwin') return
  const source = join(dirname(fileURLToPath(import.meta.url)), '../native/lid-closed')
  const output = join(source, 'dist')
  mkdirSync(output, { recursive: true })
  const sources = ['LidCore.swift','LidSecurity.swift','LidPlatform.swift','main.swift','install.sh','uninstall.sh']
  const digest = createHash('sha256').update(readFileSync(fileURLToPath(import.meta.url)))
    .update(sources.map(name => readFileSync(join(source, name), 'utf8')).join('\n')).digest('hex')
  const manifestPath = join(output, 'manifest.json')
  if (existsSync(manifestPath)) {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { sourceDigest: string; helperSHA256: string }
    if (manifest.sourceDigest === digest && existsSync(join(output, 'helper')) &&
        createHash('sha256').update(readFileSync(join(output, 'helper'))).digest('hex') === manifest.helperSHA256) return
  }
  const compiled = spawnSync('/usr/bin/swiftc', ['-module-cache-path', join(output, 'cache'),
    ...sources.filter(name => name.endsWith('.swift')).map(name => join(source, name)), '-o', join(output, 'helper')], { encoding: 'utf8', timeout: 60_000 })
  if (compiled.status !== 0) throw new Error(compiled.stderr || 'Lid helper compilation failed')
  const signed = spawnSync('/usr/bin/codesign', ['--force','--sign','-','--options','runtime',join(output,'helper')], { encoding: 'utf8', timeout: 10_000 })
  if (signed.status !== 0) throw new Error(signed.stderr || 'Lid helper signing failed')
  for (const name of ['install.sh','uninstall.sh']) copyFileSync(join(source, name), join(output, name))
  writeFileSync(manifestPath, JSON.stringify({ sourceDigest: digest,
    helperSHA256: createHash('sha256').update(readFileSync(join(output, 'helper'))).digest('hex') }) + '\n')
}
if (import.meta.main) buildLidHelper()
