import { spawnSync } from 'node:child_process'
import { closeSync, openSync, readSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

// Bun's bundled runtime requires macOS 13. Keep Swift and bundle metadata aligned.
export const MINIMUM_MACOS_VERSION = '13.0'

export function assertMacOSDeploymentTarget(loadCommands: string, path: string): void {
  const commands = loadCommands.split(/Load command \d+/)
    .filter(command => /\bcmd LC_(?:BUILD_VERSION|VERSION_MIN_MACOSX)\b/.test(command))
  if (commands.some(command => command.includes('LC_BUILD_VERSION') && !/\bplatform\s+(?:1|macos)\b/i.test(command))) {
    throw new Error(`Not a macOS native image: ${path}`)
  }
  const versions = commands.map(command => command.match(/\b(?:minos|version)\s+(\d+(?:\.\d+){1,2})\b/)?.[1])
  if (versions.length === 0 || versions.some(version => !version)) {
    throw new Error(`Missing macOS deployment target: ${path}`)
  }
  const minimum = MINIMUM_MACOS_VERSION.split('.').map(Number)
  for (const version of versions) {
    const parts = version!.split('.').map(Number)
    for (let i = 0; i < Math.max(parts.length, minimum.length); i++) {
      const difference = (parts[i] ?? 0) - (minimum[i] ?? 0)
      if (difference > 0) {
        throw new Error(`${path} requires macOS ${version}; the app targets macOS ${MINIMUM_MACOS_VERSION}+`)
      }
      if (difference < 0) break
    }
  }
}

/** Check actual native payloads, not just Info.plist, before signing an app. */
export function verifyMacOSCompatibility(directory: string): number {
  let checked = 0
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) {
      checked += verifyMacOSCompatibility(path)
    } else if (entry.isFile()) {
      const header = Buffer.alloc(4)
      const fd = openSync(path, 'r')
      try {
        const bytes = readSync(fd, header, 0, 4, 0)
        if (bytes !== 4 || !['feedface', 'feedfacf', 'cefaedfe', 'cffaedfe', 'cafebabe', 'bebafeca', 'cafebabf', 'bfbafeca'].includes(header.toString('hex'))) continue
        // otool interprets parentheses in filenames as archive-member syntax.
        const result = spawnSync('/usr/bin/otool', ['-arch', 'arm64', '-l', '/dev/fd/3'], {
          encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe', fd],
        })
        if (result.status !== 0) throw new Error(`Cannot inspect ARM64 image ${path}: ${result.stderr || result.error}`)
        assertMacOSDeploymentTarget(result.stdout, path)
        checked++
      } finally {
        closeSync(fd)
      }
    }
  }
  return checked
}
