import { constants } from 'node:fs'
import { open, realpath, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { FILE_PREVIEW_PRIVATE_CONFIG_NAMES, isCredentialLikeFilePath, type FilePreviewTextWindow, type FilePreviewTextWindowSide } from '../shared/filePreview.js'

const WINDOW_BYTES = 2 * 1024 * 1024
const WINDOW_LINES = 50_000
export class BinaryPreviewError extends Error {}
export interface TextSnapshot { bytes: Buffer; text: string; textWindow: FilePreviewTextWindow }

function utf8Boundary(bytes: Buffer, offset: number, forward: boolean): number {
  while (offset > 0 && offset < bytes.length && (bytes[offset]! & 0xc0) === 0x80) offset += forward ? 1 : -1
  return offset
}

/** Read a bounded snapshot, tolerating append and in-place writes on the same inode. */
export async function readTextPreview(path: string, side: FilePreviewTextWindowSide): Promise<TextSnapshot> {
  const expected = await stat(path)
  if (!expected.isFile() || await realpath(path) !== path) throw new Error('File moved')
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const before = await handle.stat()
    if (before.ino !== expected.ino || before.dev !== expected.dev) throw new Error('File moved')
    const head = Buffer.alloc(Math.min(8192, before.size))
    const headRead = await handle.read(head, 0, head.length, 0)
    if (head.subarray(0, headRead.bytesRead).includes(0)) throw new BinaryPreviewError()
    // One extra UTF-8 code point lets the window stop without inventing a replacement character.
    const offset = side === 'end' ? Math.max(0, before.size - WINDOW_BYTES - 4) : 0
    const buffer = Buffer.alloc(Math.min(WINDOW_BYTES + 4, before.size - offset))
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset)
    const after = await stat(path)
    if (before.ino !== after.ino || before.dev !== after.dev || await realpath(path) !== path || after.size < before.size) throw new Error('File moved')
    const raw = buffer.subarray(0, bytesRead)
    let start = side === 'end' ? utf8Boundary(raw, Math.max(0, raw.length - WINDOW_BYTES), true) : 0
    let end = side === 'start' && raw.length > WINDOW_BYTES ? utf8Boundary(raw, WINDOW_BYTES, false) : raw.length
    if (side === 'end' && offset + start > 0) {
      const newline = raw.indexOf(10, start)
      if (newline >= 0 && newline < end - 1) start = newline + 1
    } else if (side === 'start' && end < before.size) {
      const newline = raw.lastIndexOf(10, end - 1)
      if (newline >= 0) end = newline + 1
    }
    let lines = 0
    if (side === 'start') {
      for (let index = start; index < end; index++) if (raw[index] === 10 && ++lines === WINDOW_LINES) { end = index + 1; break }
    } else {
      // A terminal newline closes a record rather than introducing an extra record.
      for (let index = end - (raw[end - 1] === 10 ? 2 : 1); index >= start; index--) {
        if (raw[index] === 10 && ++lines === WINDOW_LINES) { start = index + 1; break }
      }
    }
    const bytes = raw.subarray(start, end)
    let invalidUtf8 = false
    try { new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch { invalidUtf8 = true }
    const truncated = offset + start > 0 || offset + end < before.size
    return { bytes, text: bytes.toString('utf8'), textWindow: {
      side, truncated, totalBytes: before.size, shownBytes: bytes.length, invalidUtf8,
      firstLine: side === 'start' || !truncated ? 1 : null,
    } }
  } finally { await handle.close() }
}

function within(root: string, path: string): boolean {
  const local = relative(root, path)
  return local !== '..' && !local.startsWith(`..${sep}`) && !isAbsolute(local)
}

/** Canonical policy protects aliases of the vault as well as recognizable names. */
export async function credentialPreviewPath(path: string, home: string): Promise<boolean> {
  if (isCredentialLikeFilePath(path)) return true
  const configHomes = new Set([join(home, '.cat-code')])
  if (process.env.CLAUDE_CONFIG_DIR !== undefined) {
    const configuredHome = process.env.CLAUDE_CONFIG_DIR.normalize('NFC')
    if (!isAbsolute(configuredHome)) return true
    configHomes.add(process.env.CLAUDE_CONFIG_DIR)
    configHomes.add(configuredHome)
  }
  // Settings and the global config can themselves be symlinks to ordinary names.
  // Compare each canonical file, rather than excluding session logs in the root.
  for (const configHome of configHomes) for (const name of FILE_PREVIEW_PRIVATE_CONFIG_NAMES) {
    const protectedPath = join(configHome, name)
    if (path === protectedPath) return true
    try { if (await realpath(protectedPath) === path) return true }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return true }
  }
  const roots = [join(home, 'claude-vault'), join(home, 'codex-vault')]
  const configPath = join(home, '.codex-nootp', 'config.toml')
  try {
    const config = await open(configPath, constants.O_RDONLY | constants.O_NONBLOCK)
    try {
      const before = await config.stat()
      // The account pool scans the whole config. An incomplete scan cannot prove
      // that an apparently ordinary file is outside its configured vault.
      const limit = 1024 * 1024
      if (!before.isFile() || before.size > limit) return true
      const data = Buffer.alloc(before.size + 1)
      let length = 0
      while (length < data.length) {
        const { bytesRead } = await config.read(data, length, data.length - length, length)
        if (bytesRead === 0) break
        length += bytesRead
      }
      const after = await stat(configPath)
      if (length !== before.size || before.ino !== after.ino || before.dev !== after.dev ||
        before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) return true
      const configured = /^\s*vault_path\s*=\s*"([^"]*)"/m.exec(data.subarray(0, length).toString('utf8'))?.[1]
      if (configured) {
        // Keep the account pool's expansion, including its non-shell ~name form.
        const expanded = configured.startsWith('~') ? configured.replace('~', home) : configured
        // Relative vault paths follow each engine process's cwd. Main cannot
        // establish every historical/worker cwd, so it must not volunteer bytes.
        if (!isAbsolute(expanded)) return true
        roots.push(resolve(expanded))
      }
    } finally { await config.close() }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return true
  }
  for (const root of roots) {
    let canonical = root
    try { canonical = await realpath(root) } catch { /* The default root may not exist yet. */ }
    if (within(canonical, path)) return true
  }
  return false
}
