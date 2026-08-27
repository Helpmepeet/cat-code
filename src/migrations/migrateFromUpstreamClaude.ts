/**
 * One-time migration: copy user data from legacy config homes into ~/.cat-code/.
 *
 * Legacy source families (tried in order, first existing dir wins):
 *   1. ~/.free-code  (fork-era)       + ~/.free-code.json
 *   2. ~/.claude     (upstream Claude) + ~/.claude.json
 *
 * Rules:
 * - Copy only — never delete from legacy sources
 * - Skip if ~/.cat-code/.migrated-to-cat-code already exists
 * - Skip if ~/.cat-code/ already exists (user set it up manually)
 * - Skip if no legacy source directory exists
 * - Each file/dir copy is best-effort; one failure does not abort the rest
 * - macOS keychain: copy legacy entries to "cat-code*" equivalents
 * - CLAUDE_CONFIG_DIR override is always respected (set before init)
 */

import { writeFileSync } from 'fs'
import { copyFile, cp, mkdir, stat } from 'fs/promises'
import { homedir } from 'os'
import { join } from 'path'
import { getClaudeConfigHomeDir } from '../utils/envUtils.js'
import * as lockfile from '../utils/lockfile.js'

/** Legacy source families in priority order */
const LEGACY_SOURCES = [
  {
    dir: join(homedir(), '.free-code'),
    json: join(homedir(), '.free-code.json'),
    keychainServices: ['free-code-credentials', 'free-code'],
  },
  {
    dir: join(homedir(), '.claude'),
    json: join(homedir(), '.claude.json'),
    keychainServices: ['Claude Code-credentials', 'Claude Code'],
  },
]

const MIGRATION_STAMP = '.migrated-to-cat-code'
const MIGRATION_LOCK_STALE_MS = 5_000
const MIGRATION_LOCK_UPDATE_MS = 1_000

/** Files to copy from legacy dir → ~/.cat-code/ */
const FILES_TO_COPY: string[] = [
  '.credentials.json',
  'settings.json',
  'settings.local.json',
  'CLAUDE.md',
  'history.jsonl',
]

/** Directories to copy recursively from legacy dir → ~/.cat-code/ */
const DIRS_TO_COPY: string[] = [
  'projects',
  'sessions',
  'plans',
  'shell-snapshots',
  'skills',
  'plugins',
]

function log(msg: string): void {
  if (process.env.NODE_ENV !== 'test') {
    process.stderr.write(`[migrate] ${msg}\n`)
  }
}

async function exists(p: string): Promise<boolean> {
  try {
    await stat(p)
    return true
  } catch {
    return false
  }
}

async function copyKeychainEntry(
  fromService: string,
  toService: string,
): Promise<void> {
  if (process.platform !== 'darwin') return
  try {
    const { execFile } = await import('child_process')
    const { promisify } = await import('util')
    const exec = promisify(execFile)

    // Read password from source keychain entry
    const { stdout } = await exec('security', [
      'find-generic-password',
      '-s', fromService,
      '-w',
    ])
    const password = stdout.trim()
    if (!password) return

    // Get account name from source
    const { stdout: accountOut } = await exec('security', [
      'find-generic-password',
      '-s', fromService,
    ])
    const accountMatch = accountOut.match(/"acct"<blob>="([^"]+)"/)
    const account = accountMatch?.[1] ?? 'cat-code'

    // Write to destination keychain entry
    await exec('security', [
      'add-generic-password',
      '-s', toService,
      '-a', account,
      '-w', password,
      '-U', // update if exists
    ])
    log(`Copied keychain entry: ${fromService} → ${toService}`)
  } catch {
    // Keychain ops are best-effort; entry may not exist
  }
}

export async function migrateFromUpstreamClaude(): Promise<void> {
  const destDir = getClaudeConfigHomeDir()

  // Skip if CLAUDE_CONFIG_DIR was overridden to something other than ~/.cat-code
  if (destDir !== join(homedir(), '.cat-code')) {
    return
  }

  await migrateFromPaths(destDir, LEGACY_SOURCES)
}

type LegacySource = (typeof LEGACY_SOURCES)[number]

async function acquireMigrationLock(
  destDir: string,
  onCompromised: (error: Error) => void,
): Promise<() => Promise<void>> {
  const lockTarget = `${destDir}.migration`
  return lockfile.lock(lockTarget, {
    lockfilePath: `${lockTarget}.lock`,
    realpath: false,
    retries: {
      retries: 40,
      factor: 1.2,
      minTimeout: 25,
      maxTimeout: 250,
      randomize: true,
    },
    stale: MIGRATION_LOCK_STALE_MS,
    update: MIGRATION_LOCK_UPDATE_MS,
    onCompromised,
  })
}

async function migrationIsCompleteOrDestinationExists(
  destDir: string,
): Promise<boolean> {
  return (
    (await exists(join(destDir, MIGRATION_STAMP))) || (await exists(destDir))
  )
}

async function migrateFromPaths(
  destDir: string,
  legacySources: readonly LegacySource[],
): Promise<void> {
  // These are terminal skip conditions. Avoid contending on the migration lock
  // during every normal startup, then repeat them under lock for race safety.
  if (await migrationIsCompleteOrDestinationExists(destDir)) return

  let compromised: Error | null = null
  const release = await acquireMigrationLock(destDir, error => {
    compromised = error
  })

  try {
    await _runMigration(destDir, legacySources, () => {
      if (compromised) throw compromised
    })
  } finally {
    await release()
  }
}

async function _runMigration(
  destDir: string,
  legacySources: readonly LegacySource[],
  assertLockOwned: () => void,
): Promise<void> {
  // Skip if migration stamp exists
  if (await exists(join(destDir, MIGRATION_STAMP))) return

  // Skip if dest already exists (user set it up manually)
  if (await exists(destDir)) return

  // Find the first existing legacy source
  let source = null
  for (const candidate of legacySources) {
    if (await exists(candidate.dir)) {
      source = candidate
      break
    }
  }

  // Skip if no legacy source exists
  if (!source) return

  log(`Starting migration from ${source.dir} → ${destDir}`)
  const errors: string[] = []

  // Create destination directory
  try {
    await mkdir(destDir, { recursive: true })
  } catch (err) {
    log(`Failed to create ${destDir}: ${err}`)
    return
  }

  // Copy legacy global JSON → ~/.cat-code/.cat-code.json
  const destJson = join(destDir, '.cat-code.json')
  if (await exists(source.json)) {
    try {
      await copyFile(source.json, destJson)
      log(`Copied ${source.json} → ${destJson}`)
    } catch (err) {
      errors.push(`${source.json}: ${err}`)
    }
  }

  // Copy individual files
  for (const filename of FILES_TO_COPY) {
    const src = join(source.dir, filename)
    const dest = join(destDir, filename)
    if (await exists(src)) {
      try {
        await copyFile(src, dest)
        log(`Copied ${src} → ${dest}`)
      } catch (err) {
        errors.push(`${src}: ${err}`)
      }
    }
  }

  // Copy directories recursively
  for (const dirname of DIRS_TO_COPY) {
    const src = join(source.dir, dirname)
    const dest = join(destDir, dirname)
    if (await exists(src)) {
      try {
        await cp(src, dest, { recursive: true })
        log(`Copied dir ${src} → ${dest}`)
      } catch (err) {
        errors.push(`${src}: ${err}`)
      }
    }
  }

  // Copy keychain entries from the matched legacy source (macOS only)
  for (const legacyService of source.keychainServices) {
    const targetService = legacyService
      .replace(/^free-code/, 'cat-code')
      .replace(/^Claude Code/, 'cat-code')
    await copyKeychainEntry(legacyService, targetService)
  }

  assertLockOwned()

  // Write migration stamp
  try {
    writeFileSync(
      join(destDir, MIGRATION_STAMP),
      `migrated-from: ${source.dir}\ndate: ${new Date().toISOString()}\n`,
    )
  } catch (err) {
    errors.push(`stamp: ${err}`)
  }

  if (errors.length > 0) {
    log(`Migration completed with ${errors.length} error(s):`)
    for (const e of errors) log(`  - ${e}`)
  } else {
    log('Migration completed successfully.')
  }
}

export const _forTest = {
  acquireMigrationLock,
  migrateFromPaths,
}
