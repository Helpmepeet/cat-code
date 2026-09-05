/**
 * The measurement floor the RAM-0 instruments share (no secrets, no engine
 * imports).
 *
 * `ram-probe.ts` and `ram-fleet.ts` had each written this out in full, and both
 * said so in a comment ("verbatim reuse of ram-probe.ts idioms", "Env —
 * hermetic, account-free (ram-probe.ts:210-237)"). Two of the copies were
 * load-bearing rather than merely repetitive: the vmmap/ps readers ARE the
 * measurement, so a drift between them silently makes two runs incomparable,
 * and the hermetic env carries a credential DENY-LIST — a variable added to one
 * copy and not the other leaves the second probe booting a real engine against
 * the operator's live account.
 *
 * The KILL path deliberately stays in each script. `killPid` / `killSidecar` are
 * guarded by `ramScriptsSource.test.ts` per file, because signalling a raw pid
 * is the one dangerous thing these instruments do and the rule ("only a
 * descendant captured from a provably-live parent") has to be readable next to
 * the call that breaks it.
 */

import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'

/** `--key value` / `--flag` → a flat string map. Every RAM script's CLI. */
export function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const key = a.slice(2)
      const val = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true'
      out[key] = val
    }
  }
  return out
}

/** Parse a vmmap size token like "237.4M" / "1.2G" / "512K" / "0" → MB. */
export function sizeTokenToMB(tok: string): number | null {
  const m = tok.trim().match(/^([\d.]+)\s*([KMG])?/)
  if (!m) return null
  const n = parseFloat(m[1])
  const unit = m[2]
  if (unit === 'G') return n * 1024
  if (unit === 'M') return n
  if (unit === 'K') return n / 1024
  return n / (1024 * 1024) // bytes
}

export function psRssMB(pid: number): number | null {
  try {
    const out = execFileSync('ps', ['-o', 'rss=', '-p', String(pid)], { encoding: 'utf8' })
    const kb = parseInt(out.trim(), 10)
    return Number.isFinite(kb) ? +(kb / 1024).toFixed(1) : null
  } catch {
    return null
  }
}

/**
 * macOS physical footprint (+ peak) for one pid. `raw` is the whole capture,
 * which `ram-probe.ts` retains on disk — discarding raw output was the F1
 * defect the RAM-0 protocol exists to prevent.
 */
export function vmmapSummary(pid: number): {
  raw: string
  footprintMB: number | null
  peakMB: number | null
} {
  let raw = ''
  try {
    raw = execFileSync('vmmap', ['--summary', String(pid)], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 })
  } catch (e) {
    raw = `vmmap failed: ${e instanceof Error ? e.message : String(e)}`
    return { raw, footprintMB: null, peakMB: null }
  }
  let footprintMB: number | null = null
  let peakMB: number | null = null
  for (const line of raw.split('\n')) {
    const peak = line.match(/Physical footprint \(peak\):\s*(.+)$/)
    if (peak) { peakMB = sizeTokenToMB(peak[1]); continue }
    const fp = line.match(/Physical footprint:\s*(.+)$/)
    if (fp) footprintMB = sizeTokenToMB(fp[1])
  }
  return { raw, footprintMB, peakMB }
}

export function childPids(pid: number): number[] {
  try {
    const out = execFileSync('pgrep', ['-P', String(pid)], { encoding: 'utf8' })
    return out.split('\n').map(s => parseInt(s.trim(), 10)).filter(n => Number.isFinite(n))
  } catch {
    return []
  }
}

/** Every descendant pid of `pid`, gathered before any kill (dead parents lose theirs). */
export function descendantPids(pid: number): number[] {
  const kids = childPids(pid)
  return [...kids, ...kids.flatMap(descendantPids)]
}

export function isAlive(pid: number): boolean {
  try {
    execFileSync('ps', ['-p', String(pid)], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise(res => setTimeout(res, ms))
}

export async function waitForSocket(socketPath: string, timeoutMs = 30_000): Promise<void> {
  const start = Date.now()
  while (!existsSync(socketPath)) {
    if (Date.now() - start > timeoutMs) throw new Error(`sidecar never bound socket at ${socketPath}`)
    await sleep(50)
  }
}

/**
 * Credentials the hermetic env DELETES. Keeping this in one place is the point
 * of the module: a probe that boots a real engine with any of these still set is
 * measuring the operator's account, not a sandbox.
 */
const CREDENTIAL_ENV_KEYS = [
  'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL',
  'OPENAI_API_KEY', 'OPENAI_BASE_URL', 'CLAUDE_CODE_OAUTH_TOKEN',
  'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN',
  'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_OPENAI',
] as const

/**
 * Hermetic, account-free sidecar env: strip credentials, poison the network,
 * isolate the config home. Per-run additions (`CATCODE_SIDECAR_PROBE`,
 * `MIMALLOC_PURGE_DELAY`) are the caller's to set on the returned object.
 */
export function hermeticSidecarEnv(input: {
  configDir: string
  socketPath: string
  sessionId: string
  cwdDir: string
}): Record<string, string> {
  const env: Record<string, string> = { ...process.env } as Record<string, string>
  for (const k of CREDENTIAL_ENV_KEYS) delete env[k]
  Object.assign(env, {
    CLAUDE_CONFIG_DIR: input.configDir,
    CATCODE_SIDECAR_SOCKET: input.socketPath,
    CATCODE_SIDECAR_SESSION_ID: input.sessionId,
    CATCODE_SIDECAR_CWD: input.cwdDir,
    // Disable the idle JANITOR (onIdle) so it never reaps mid-measurement; park
    // (onPark) is the only self-exit the fleet probe exercises, and only via
    // app.park.
    CATCODE_SIDECAR_IDLE_TTL_MS: '0',
    DISABLE_AUTOUPDATER: '1',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    CI: '1',
    HTTP_PROXY: 'http://127.0.0.1:9',
    HTTPS_PROXY: 'http://127.0.0.1:9',
    ALL_PROXY: 'http://127.0.0.1:9',
    http_proxy: 'http://127.0.0.1:9',
    https_proxy: 'http://127.0.0.1:9',
    all_proxy: 'http://127.0.0.1:9',
    NO_PROXY: '',
  })
  return env
}
