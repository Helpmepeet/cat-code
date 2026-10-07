/** Engine-free check used before the catalog worker imports the engine graph. */
import { createHash } from 'node:crypto'
import { open, readdir, stat } from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import type { FileHandle } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

import {
  MAX_SESSIONS_CATALOG_CACHE_BYTES,
  SESSIONS_CATALOG_CACHE_FILENAME,
  SESSIONS_CATALOG_CACHE_SUBDIR,
} from './sessionsCatalogCache.js'
import { parseSessionsCatalogSnapshot } from './sessionsCatalogWorker.js'

type CachedCatalog = {
  catalog: NonNullable<ReturnType<typeof parseSessionsCatalogSnapshot>>
  fingerprint: string
}

function configHome(): string {
  return (process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.cat-code')).normalize('NFC')
}

function cachePath(): string {
  return join(configHome(), SESSIONS_CATALOG_CACHE_SUBDIR, SESSIONS_CATALOG_CACHE_FILENAME)
}

async function readCachedCatalog(): Promise<CachedCatalog | null> {
  let file: FileHandle | undefined
  try {
    const path = cachePath()
    file = await open(path, 'r')
    const fileStat = await file.stat()
    if (!fileStat.isFile() || fileStat.size > MAX_SESSIONS_CATALOG_CACHE_BYTES) return null
    const bytes = Buffer.alloc(fileStat.size + 1)
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0)
    if (bytesRead !== fileStat.size) return null
    const raw: unknown = JSON.parse(bytes.subarray(0, bytesRead).toString('utf8'))
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
    const value = raw as Record<string, unknown>
    if (typeof value.sourceFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(value.sourceFingerprint)) return null
    const { sourceFingerprint, ...snapshotValue } = value
    const catalog = parseSessionsCatalogSnapshot(snapshotValue)
    return catalog ? { catalog, fingerprint: sourceFingerprint } : null
  } catch {
    return null
  } finally {
    await file?.close().catch(() => {})
  }
}

/**
 * Hash project transcript metadata, relocation records used by the catalog
 * projection, active lease acquisition markers, and workspace existence. File
 * ctime catches same-size rewrites whose mtime was restored by a caller.
 */
async function currentFileFingerprint(projectsDir = join(configHome(), 'projects')): Promise<string> {
  const hash = createHash('sha256')
  let projects: Dirent[]
  try {
    projects = await readdir(projectsDir, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') projects = []
    else throw error
  }
  const projectNames = projects.filter(row => row.isDirectory()).map(row => row.name).sort()
  for (const projectName of projectNames) {
    hash.update(`p\0${projectName}\0`)
    const projectPath = join(projectsDir, projectName)
    const entries = await readdir(projectPath, { withFileTypes: true })
    const transcripts = entries
      .filter(row => row.isFile() && row.name.endsWith('.jsonl'))
      .map(row => row.name)
      .sort()
    for (const name of transcripts) {
      const filePath = join(projectPath, name)
      const fileStat = await stat(filePath, { bigint: true })
      hash.update(`f\0${projectName}\0${name}\0${fileStat.size}\0${fileStat.mtimeNs}\0${fileStat.ctimeNs}\0`)
    }
  }
  // The engine's catalog builder also overlays desktop session relocation
  // records after reading each transcript; those can change cwd/binding without
  // touching the JSONL source.
  const relocationDir = join(configHome(), 'session-relocations')
  let relocations: Dirent[]
  try {
    relocations = await readdir(relocationDir, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') relocations = []
    else throw error
  }
  for (const name of relocations.filter(row => row.isFile() && row.name.endsWith('.json')).map(row => row.name).sort()) {
    const fileStat = await stat(join(relocationDir, name), { bigint: true })
    hash.update(`r\0${name}\0${fileStat.size}\0${fileStat.mtimeNs}\0${fileStat.ctimeNs}\0`)
  }
  // Only durable active acquisitions (transcriptLease.readTranscriptActivationAtMs),
  // never lease targets or lock directories whose heartbeat/maintenance changes.
  const leaseDir = join(configHome(), 'transcript-leases')
  let leases: Dirent[]
  try {
    leases = await readdir(leaseDir, { withFileTypes: true })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') leases = []
    else throw error
  }
  const activations = leases.filter(row => row.isFile() &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.activation\.json$/i.test(row.name))
    .map(row => row.name).sort()
  for (const name of activations) {
    const fileStat = await stat(join(leaseDir, name), { bigint: true })
    hash.update(`a\0${name}\0${fileStat.size}\0${fileStat.mtimeNs}\0${fileStat.ctimeNs}\0`)
  }
  return hash.digest('hex')
}

async function currentCatalogFingerprint(fileFingerprint: string, catalog: CachedCatalog['catalog']): Promise<string> {
  const facts: Array<[string, boolean]> = []
  for (const cwd of [...new Set(catalog.entries.map(entry => entry.cwd).filter(Boolean))].sort()) {
    let exists = false
    try { exists = (await stat(cwd)).isDirectory() } catch { /* Same fail-closed meaning as catalog annotation. */ }
    facts.push([cwd, exists])
  }
  return combineFingerprint(fileFingerprint, facts)
}

function combineFingerprint(fileFingerprint: string, facts: ReadonlyArray<[string, boolean]>): string {
  const hash = createHash('sha256').update(fileFingerprint)
  for (const [cwd, exists] of facts) hash.update(`\0d\0${cwd}\0${exists ? 1 : 0}`)
  return hash.digest('hex')
}

/** Persist the workspace existence values observed by the completed enumeration. */
export function catalogFingerprintForSnapshot(
  fileFingerprint: string,
  catalog: CachedCatalog['catalog'],
): string {
  const facts: Array<[string, boolean]> = [...new Map(catalog.entries.map(entry => [entry.cwd, entry.cwdExists] as [string, boolean])).entries()]
    .filter(([cwd]) => cwd.length > 0)
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
  return combineFingerprint(fileFingerprint, facts)
}

/** Returns true only when both the bounded cache and all source facts validate. */
export async function inspectSessionsCatalogSources(): Promise<{
  fingerprint: string
  unchanged: boolean
}> {
  const cached = await readCachedCatalog()
  const fingerprint = await currentFileFingerprint()
  const cachedMatches = cached !== null &&
    await currentCatalogFingerprint(fingerprint, cached.catalog) === cached.fingerprint
  return {
    fingerprint,
    unchanged: cachedMatches,
  }
}
