import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import type { ProjectMetadata } from '../shared/projectMetadata.js'

const MAX_BYTES = 8 * 1024
const empty = (): ProjectMetadata => ({ aliases: [], description: '' })
const invalid = (): ProjectMetadata => ({ ...empty(), metadataWarning: 'Project metadata could not be read. Check .cat-code/project.json.' })

function normalize(value: unknown, limit: number): string {
  if (typeof value !== 'string') throw new Error('Invalid field')
  // Whitespace controls are normalized; other control characters are not display text.
  if (/[\p{Cc}]/u.test(value.replace(/\s/gu, '')) || /[\uD800-\uDFFF]/u.test(value)) {
    throw new Error('Invalid text')
  }
  const text = value.normalize('NFC').trim().replace(/\s+/gu, ' ')
  if (Array.from(text).length > limit) throw new Error('Field too long')
  return text
}

/** Runs in the Bun discovery worker, after saved trust and canonical-root checks. */
export function readProjectMetadata(canonicalRoot: string): ProjectMetadata {
  const directory = join(canonicalRoot, '.cat-code')
  const path = join(directory, 'project.json')
  let fd: number | undefined
  try {
    if (process.platform === 'win32' || !constants.O_NOFOLLOW) return invalid()
    const root = lstatSync(canonicalRoot)
    if (!root.isDirectory() || root.isSymbolicLink() || realpathSync(canonicalRoot).normalize('NFC') !== canonicalRoot) return invalid()
    const parent = lstatSync(directory)
    if (!parent.isDirectory() || parent.isSymbolicLink()) return invalid()
    const expected = lstatSync(path)
    if (!expected.isFile() || expected.isSymbolicLink() || expected.size > MAX_BYTES) return invalid()
    // NONBLOCK prevents a raced replacement with a FIFO from blocking the host.
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    const before = fstatSync(fd)
    if (!before.isFile() || before.size > MAX_BYTES || before.ino !== expected.ino || before.dev !== expected.dev) return invalid()
    // Resolve the opened object, not just its authored pathname, before reading.
    // This rejects a parent swapped to an external symlink during open.
    if (realpathSync(`/dev/fd/${fd}`).normalize('NFC') !== path) return invalid()
    const currentParent = lstatSync(directory)
    if (currentParent.isSymbolicLink() || currentParent.ino !== parent.ino || currentParent.dev !== parent.dev) return invalid()
    const bytes = Buffer.alloc(MAX_BYTES)
    let length = 0
    while (length < bytes.length) {
      const count = readSync(fd, bytes, length, bytes.length - length, length)
      if (count === 0) break
      length += count
    }
    const after = fstatSync(fd)
    const current = lstatSync(path)
    if (length !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs || current.isSymbolicLink() || current.ino !== before.ino || current.dev !== before.dev || realpathSync(`/dev/fd/${fd}`).normalize('NFC') !== path) return invalid()
    const payload: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, length)))
    if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) return invalid()
    const data = payload as Record<string, unknown>
    let aliases: string[] = []
    if (Object.hasOwn(data, 'aliases')) {
      if (!Array.isArray(data.aliases) || data.aliases.length > 12) return invalid()
      aliases = data.aliases.map(alias => normalize(alias, 80))
      if (aliases.some(alias => !alias)) return invalid()
    }
    const seen = new Set<string>()
    aliases = aliases.filter(alias => {
      const key = alias.toLowerCase().normalize('NFC')
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    return { aliases, description: Object.hasOwn(data, 'description') ? normalize(data.description, 320) : '' }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return empty()
    return invalid()
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}
