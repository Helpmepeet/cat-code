/**
 * inc-5046: fetch the official marketplace from a GCS mirror instead of
 * git-cloning GitHub on every startup.
 *
 * Backend (anthropic#317037) publishes a marketplace-only zip alongside the
 * titanium squashfs, keyed by base repo SHA. This module fetches the `latest`
 * pointer, compares against a local sentinel, and downloads+extracts the zip
 * when there's a new SHA. Callers decide fallback behavior on failure.
 */

import axios from 'axios'
import { randomUUID } from 'crypto'
import { existsSync, lstatSync, realpathSync } from 'fs'
import {
  chmod,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'fs/promises'
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'path'
import { waitForScrollIdle } from '../../bootstrap/state.js'
import type { AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS } from '../../services/analytics/index.js'
import { logEvent } from '../../services/analytics/index.js'
import { logForDebugging } from '../debug.js'
import { parseZipModes, unzipFile } from '../dxt/zip.js'
import { errorMessage, getErrnoCode } from '../errors.js'
import {
  PluginMarketplaceSchema,
  validateOfficialNameSource,
} from './schemas.js'
import { OFFICIAL_MARKETPLACE_SOURCE } from './officialMarketplace.js'

type SafeString = AnalyticsMetadata_I_VERIFIED_THIS_IS_NOT_CODE_OR_FILEPATHS

// CDN-fronted domain for the public GCS bucket (same bucket the native
// binary ships from — nativeInstaller/download.ts:24 uses the raw GCS URL).
// `{sha}.zip` is content-addressed so CDN can cache it indefinitely;
// `latest` has Cache-Control: max-age=300 so CDN staleness is bounded.
// Backend (anthropic#317037) populates this prefix.
const GCS_BASE =
  'https://downloads.claude.ai/claude-code-releases/plugins/claude-plugins-official'

// Zip arc paths are seed-dir-relative (marketplaces/claude-plugins-official/…)
// so the titanium seed machinery can use the same zip. Strip this prefix when
// extracting for a laptop install.
const ARC_PREFIX = 'marketplaces/claude-plugins-official/'
const MANIFEST_PATH = '.claude-plugin/marketplace.json'

function assertCacheChild(cachePath: string, cacheDir: string): string {
  const resolvedCacheDir = resolve(cacheDir)
  const resolvedTarget = resolve(cachePath)
  const targetName = basename(resolvedTarget)
  if (
    !targetName ||
    resolvedTarget === resolvedCacheDir ||
    dirname(resolvedTarget) !== resolvedCacheDir
  ) {
    throw new Error(
      `Official marketplace cache target must be a direct child of ${resolvedCacheDir}`,
    )
  }

  const canonicalCacheDir = realpathSync(resolvedCacheDir)
  if (realpathSync(dirname(resolvedTarget)) !== canonicalCacheDir) {
    throw new Error('Official marketplace cache target has linked ancestry')
  }

  try {
    if (lstatSync(resolvedTarget).isSymbolicLink()) {
      throw new Error('Official marketplace cache target cannot be a symlink')
    }
    if (
      realpathSync(resolvedTarget) !== join(canonicalCacheDir, targetName)
    ) {
      throw new Error('Official marketplace cache target is not canonical')
    }
  } catch (error) {
    if (getErrnoCode(error) !== 'ENOENT') throw error
  }
  return resolvedTarget
}

function assertStagingPath(candidate: string, stagingPath: string): string {
  const lexicalStaging = resolve(stagingPath)
  const canonicalStaging = realpathSync(stagingPath)
  const resolvedCandidate = resolve(candidate)
  const lexicalRel = relative(lexicalStaging, resolvedCandidate)
  const canonicalRel = relative(canonicalStaging, resolvedCandidate)
  const isStrictChild = (path: string) =>
    path !== '' &&
    path !== '..' &&
    !path.startsWith(`..${sep}`) &&
    !isAbsolute(path)
  const rel = isStrictChild(lexicalRel) ? lexicalRel : canonicalRel
  if (!isStrictChild(rel)) {
    throw new Error(
      `Official marketplace archive path escapes staging: ${candidate}`,
    )
  }

  const safeCandidate = join(canonicalStaging, rel)
  let current = canonicalStaging
  for (const segment of rel.split(sep)) {
    current = join(current, segment)
    try {
      if (lstatSync(current).isSymbolicLink()) {
        throw new Error('Official marketplace staging path cannot contain symlinks')
      }
    } catch (error) {
      if (getErrnoCode(error) === 'ENOENT') break
      throw error
    }
  }
  return safeCandidate
}

/**
 * Fetch the official marketplace from GCS and extract to installLocation.
 * Idempotent — checks a `.gcs-sha` sentinel before downloading the ~3.5MB zip.
 *
 * @param installLocation where to extract (must be inside marketplacesCacheDir)
 * @param marketplacesCacheDir the plugins marketplace cache root — passed in
 *   by callers (rather than imported from pluginDirectories) to break a
 *   circular-dep edge through marketplaceManager
 * @param assertSourceAllowed required live-policy guard for the canonical
 *   official marketplace source
 * @returns the fetched SHA on success (including no-op), null on any failure
 *   (network, 404, zip parse). Caller decides whether to fall through to git.
 */
export async function fetchOfficialMarketplaceFromGcs(
  installLocation: string,
  marketplacesCacheDir: string,
  assertSourceAllowed: () => void,
): Promise<string | null> {
  assertSourceAllowed()
  const cacheDir = resolve(marketplacesCacheDir)
  let resolvedLoc: string
  try {
    resolvedLoc = assertCacheChild(installLocation, cacheDir)
  } catch (error) {
    logForDebugging(
      `fetchOfficialMarketplaceFromGcs: refusing unsafe cache path ${installLocation}: ${errorMessage(error)}`,
      { level: 'error' },
    )
    return null
  }

  // Network + zip extraction competes for the event loop with scroll frames.
  // This is a fire-and-forget startup call — delaying by a few hundred ms
  // until scroll settles is invisible to the user.
  await waitForScrollIdle()
  assertSourceAllowed()

  const start = performance.now()
  let outcome: 'noop' | 'updated' | 'failed' = 'failed'
  let sha: string | undefined
  let bytes: number | undefined
  let errKind: string | undefined
  let stagingPath: string | undefined

  try {
    // 1. Latest pointer — ~40 bytes, backend sets Cache-Control: no-cache,
    //    max-age=300. Cheap enough to hit every startup.
    assertSourceAllowed()
    const latest = await axios.get(`${GCS_BASE}/latest`, {
      responseType: 'text',
      timeout: 10_000,
    })
    sha = String(latest.data).trim()
    if (!sha) {
      // Empty /latest body — backend misconfigured. Bail (null), don't
      // lock into a permanently-broken empty-sentinel state.
      throw new Error('latest pointer returned empty body')
    }

    // 2. Sentinel check — `.gcs-sha` at the install root holds the last
    //    extracted SHA. Matching means we already have this content.
    const sentinelPath = join(resolvedLoc, '.gcs-sha')
    const currentSha = await readFile(sentinelPath, 'utf8').then(
      s => s.trim(),
      () => null, // ENOENT — first fetch, proceed to download
    )
    if (currentSha === sha) {
      outcome = 'noop'
      return sha
    }

    // 3. Download and validate a complete replacement in fresh staging before
    //    publishing it over the current cache.
    assertSourceAllowed()
    const zipResp = await axios.get(`${GCS_BASE}/${sha}.zip`, {
      responseType: 'arraybuffer',
      timeout: 60_000,
    })
    const zipBuf = Buffer.from(zipResp.data)
    bytes = zipBuf.length
    const files = await unzipFile(zipBuf)
    // fflate doesn't surface external_attr, so parse the central directory
    // ourselves to recover exec bits. Without this, hooks/scripts extract as
    // 0644 and `sh -c "/path/script.sh"` (hooks.ts:~1002) fails with EACCES
    // on Unix. Git-clone preserves +x natively; this keeps GCS at parity.
    const modes = parseZipModes(zipBuf)
    const manifestBytes = files[`${ARC_PREFIX}${MANIFEST_PATH}`]
    if (!manifestBytes) {
      throw new Error('Official marketplace archive is missing marketplace.json')
    }
    let manifestValue: unknown
    try {
      manifestValue = JSON.parse(Buffer.from(manifestBytes).toString('utf8'))
    } catch {
      throw new Error('Official marketplace archive has invalid marketplace.json')
    }
    const manifestResult = PluginMarketplaceSchema().safeParse(manifestValue)
    if (!manifestResult.success) {
      throw new Error(
        `Official marketplace archive has an invalid manifest: ${manifestResult.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join(', ')}`,
      )
    }
    const identityError = validateOfficialNameSource(
      manifestResult.data.name,
      OFFICIAL_MARKETPLACE_SOURCE,
    )
    if (identityError) throw new Error(identityError)

    const extractedFiles = Object.entries(files).flatMap(([arcPath, data]) => {
      if (!arcPath.startsWith(ARC_PREFIX)) return []
      const rel = arcPath.slice(ARC_PREFIX.length)
      if (!rel || rel.endsWith('/')) return []
      if (
        isAbsolute(rel) ||
        rel.includes('\\') ||
        rel.split('/').some(segment => segment === '' || segment === '.' || segment === '..')
      ) {
        throw new Error(`Official marketplace archive has unsafe path: ${arcPath}`)
      }
      return [{ arcPath, rel, data }]
    })

    stagingPath = assertCacheChild(
      join(cacheDir, `marketplace-gcs-staging-${randomUUID()}`),
      cacheDir,
    )
    const backupPath = assertCacheChild(
      join(cacheDir, `marketplace-gcs-backup-${randomUUID()}`),
      cacheDir,
    )
    assertSourceAllowed()
    await mkdir(stagingPath)
    assertCacheChild(stagingPath, cacheDir)

    for (const { arcPath, rel, data } of extractedFiles) {
      assertSourceAllowed()
      const dest = assertStagingPath(join(stagingPath, rel), stagingPath)
      await mkdir(dirname(dest), { recursive: true })
      assertStagingPath(dest, stagingPath)
      assertSourceAllowed()
      await writeFile(dest, data)
      const mode = modes[arcPath]
      if (mode && mode & 0o111) {
        // Only chmod when an exec bit is set — skip plain files to save syscalls.
        // Swallow EPERM/ENOTSUP (NFS root_squash, some FUSE mounts) — losing +x
        // is the pre-PR behavior and better than aborting mid-extraction.
        assertSourceAllowed()
        await chmod(dest, mode & 0o777).catch(() => {})
      }
    }
    const stagedSentinel = assertStagingPath(
      join(stagingPath, '.gcs-sha'),
      stagingPath,
    )
    assertSourceAllowed()
    await writeFile(stagedSentinel, sha)

    let backedUp = false
    let published = false
    try {
      assertSourceAllowed()
      assertCacheChild(resolvedLoc, cacheDir)
      if (existsSync(resolvedLoc)) {
        await rename(
          assertCacheChild(resolvedLoc, cacheDir),
          assertCacheChild(backupPath, cacheDir),
        )
        backedUp = true
      }
      assertSourceAllowed()
      await rename(
        assertCacheChild(stagingPath, cacheDir),
        assertCacheChild(resolvedLoc, cacheDir),
      )
      stagingPath = undefined
      published = true
      assertSourceAllowed()
    } catch (publicationError) {
      try {
        if (published) {
          await rm(assertCacheChild(resolvedLoc, cacheDir), {
            recursive: true,
            force: true,
          })
        }
        if (backedUp) {
          await rename(
            assertCacheChild(backupPath, cacheDir),
            assertCacheChild(resolvedLoc, cacheDir),
          )
        }
      } catch (rollbackError) {
        throw new Error(
          `Official marketplace publication failed and rollback could not restore the previous cache: ${errorMessage(rollbackError)}`,
          { cause: publicationError },
        )
      }
      throw publicationError
    }

    if (backedUp) {
      await rm(assertCacheChild(backupPath, cacheDir), {
        recursive: true,
        force: true,
      })
    }

    outcome = 'updated'
    return sha
  } catch (e) {
    errKind = classifyGcsError(e)
    logForDebugging(
      `Official marketplace GCS fetch failed: ${errorMessage(e)}`,
      { level: 'warn' },
    )
    return null
  } finally {
    if (stagingPath) {
      try {
        await rm(assertCacheChild(stagingPath, cacheDir), {
          recursive: true,
          force: true,
        })
      } catch (cleanupError) {
        logForDebugging(
          `Failed to clean official marketplace staging directory: ${errorMessage(cleanupError)}`,
          { level: 'warn' },
        )
      }
    }
    // tengu_plugin_remote_fetch schema shared with the telemetry PR
    // (.daisy/inc-5046/index.md) — adds source:'marketplace_gcs'. All string
    // values below are static enums or a git SHA — not code/filepaths/PII.
    logEvent('tengu_plugin_remote_fetch', {
      source: 'marketplace_gcs' as SafeString,
      host: 'downloads.claude.ai' as SafeString,
      is_official: true,
      outcome: outcome as SafeString,
      duration_ms: Math.round(performance.now() - start),
      ...(bytes !== undefined && { bytes }),
      ...(sha && { sha: sha as SafeString }),
      ...(errKind && { error_kind: errKind as SafeString }),
    })
  }
}

// Bounded set of errno codes we report by name. Anything else buckets as
// fs_other to keep dashboard cardinality tractable.
const KNOWN_FS_CODES = new Set([
  'ENOSPC',
  'EACCES',
  'EPERM',
  'EXDEV',
  'EBUSY',
  'ENOENT',
  'ENOTDIR',
  'EROFS',
  'EMFILE',
  'ENAMETOOLONG',
])

/**
 * Classify a GCS fetch error into a stable telemetry bucket.
 *
 * Telemetry from v2.1.83+ showed 50% of failures landing in 'other' — and
 * 99.99% of those had both sha+bytes set, meaning download succeeded but
 * extraction/fs failed. This splits that bucket so we can see whether the
 * failures are fixable (wrong staging dir, cross-device rename) or inherent
 * (disk full, permission denied) before flipping the git-fallback kill switch.
 */
export function classifyGcsError(e: unknown): string {
  if (axios.isAxiosError(e)) {
    if (e.code === 'ECONNABORTED') return 'timeout'
    if (e.response) return `http_${e.response.status}`
    return 'network'
  }
  const code = getErrnoCode(e)
  // Node fs errno codes are E<UPPERCASE> (ENOSPC, EACCES). Axios also sets
  // .code (ERR_NETWORK, ERR_BAD_OPTION, EPROTO) — don't bucket those as fs.
  if (code && /^E[A-Z]+$/.test(code) && !code.startsWith('ERR_')) {
    return KNOWN_FS_CODES.has(code) ? `fs_${code}` : 'fs_other'
  }
  // fflate sets numeric .code (0-14) on inflate/unzip errors — catches
  // deflate-level corruption ("unexpected EOF", "invalid block type") that
  // the message regex misses.
  if (typeof (e as { code?: unknown })?.code === 'number') return 'zip_parse'
  const msg = errorMessage(e)
  if (/unzip|invalid zip|central directory/i.test(msg)) return 'zip_parse'
  if (/empty body/.test(msg)) return 'empty_latest'
  return 'other'
}
