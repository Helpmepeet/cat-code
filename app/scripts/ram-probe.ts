/*
 * RAM-0 hermetic sidecar memory probe (measurement instrument, NO secrets).
 *
 * Historical source/probe runs keep using a caller-owned fresh config directory.
 * `--real-turn` is the acceptance path: it launches the packaged session sidecar,
 * submits one normal turn against a closed local endpoint, and owns every process
 * and temporary path it creates.
 */

import {
  execFileSync,
  spawn,
  type ChildProcess,
} from 'node:child_process'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { connect, type Socket } from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { isProviderManagedEnvVar } from '../../src/utils/managedEnvConstants.js'
import { resolveSidecarLaunch } from '../main/mainDecisions.js'
import { FrameDecoder, encodeFrame } from '../shared/framing.js'
import { MAX_OUTBOUND_FRAME_BYTES } from '../shared/limits.js'

const here = dirname(fileURLToPath(import.meta.url))
const SIDECAR_ENTRY = join(here, '..', 'sidecar', 'index.ts')
const MAX_SAMPLES = 256
const MAX_FRAME_SUMMARIES = 256
const MAX_STDERR_BYTES = 256 * 1024
const MAX_VMMAP_CAPTURE_BYTES = 512 * 1024
const MAX_VMMAP_RAW_BYTES_PER_SAMPLE = 128 * 1024
const MAX_RAW_ARTIFACT_BYTES = 8 * 1024 * 1024
const DEFAULT_REAL_TURN_TIMEOUT_MS = 30_000
const CLEANUP_TIMEOUT_MS = 5_000
const SYNTHETIC_API_KEY = 'synthetic-ram-probe-key'
const CLOSED_ANTHROPIC_ENDPOINT = 'http://127.0.0.1:1'
const CLOSED_PROXY_ENDPOINT = 'http://127.0.0.1:9'

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]
    if (!arg.startsWith('--')) continue
    const key = arg.slice(2)
    const next = argv[index + 1]
    out[key] = next !== undefined && !next.startsWith('--') ? argv[++index] : 'true'
  }
  return out
}

type Sample = {
  label: string
  elapsedMs: number
  rssMB: number | null
  footprintMB: number | null
  footprintPeakMB: number | null
  vmmapBytes: number
  vmmapTruncated: boolean
}

type BoundedArtifact = {
  path: string
  maxBytes: number
  bytesWritten: number
  truncated: boolean
}

function appendBounded(artifact: BoundedArtifact, value: string | Buffer): void {
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value, 'utf8')
  const remaining = artifact.maxBytes - artifact.bytesWritten
  if (remaining <= 0) {
    if (bytes.byteLength > 0) artifact.truncated = true
    return
  }
  const written = bytes.subarray(0, remaining)
  appendFileSync(artifact.path, written)
  artifact.bytesWritten += written.byteLength
  if (written.byteLength < bytes.byteLength) artifact.truncated = true
}

function artifactSize(path: string): number {
  try {
    return statSync(path).size
  } catch {
    return 0
  }
}

function sizeTokenToMB(token: string): number | null {
  const match = token.trim().match(/^([\d.]+)\s*([KMG])?/)
  if (!match) return null
  const number = Number.parseFloat(match[1])
  if (match[2] === 'G') return number * 1024
  if (match[2] === 'M') return number
  if (match[2] === 'K') return number / 1024
  return number / (1024 * 1024)
}

function psRssMB(pid: number): number | null {
  try {
    const output = execFileSync('ps', ['-o', 'rss=', '-p', String(pid)], {
      encoding: 'utf8',
    })
    const kib = Number.parseInt(output.trim(), 10)
    return Number.isFinite(kib) ? +(kib / 1024).toFixed(1) : null
  } catch {
    return null
  }
}

function vmmapSummary(pid: number): {
  raw: Buffer
  capturedBytes: number
  truncated: boolean
  footprintMB: number | null
  peakMB: number | null
} {
  let output = ''
  try {
    output = execFileSync('vmmap', ['--summary', String(pid)], {
      encoding: 'utf8',
      maxBuffer: MAX_VMMAP_CAPTURE_BYTES,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
  } catch (error) {
    output = `vmmap failed: ${error instanceof Error ? error.message : String(error)}`
  }

  let footprintMB: number | null = null
  let peakMB: number | null = null
  for (const line of output.split('\n')) {
    const peak = line.match(/Physical footprint \(peak\):\s*(.+)$/)
    if (peak) {
      peakMB = sizeTokenToMB(peak[1])
      continue
    }
    const footprint = line.match(/Physical footprint:\s*(.+)$/)
    if (footprint) footprintMB = sizeTokenToMB(footprint[1])
  }

  const captured = Buffer.from(output, 'utf8')
  const raw = captured.subarray(0, MAX_VMMAP_RAW_BYTES_PER_SAMPLE)
  return {
    raw,
    capturedBytes: captured.byteLength,
    truncated: raw.byteLength < captured.byteLength,
    footprintMB,
    peakMB,
  }
}

function readProcessGroupId(pid: number): number | null {
  try {
    const output = execFileSync('ps', ['-o', 'pgid=', '-p', String(pid)], {
      encoding: 'utf8',
    })
    const processGroupId = Number.parseInt(output.trim(), 10)
    return Number.isInteger(processGroupId) && processGroupId > 1
      ? processGroupId
      : null
  } catch {
    return null
  }
}

function processGroupPids(processGroupId: number): number[] {
  try {
    const output = execFileSync('ps', ['-axo', 'pid=,pgid='], {
      encoding: 'utf8',
    })
    return output
      .split('\n')
      .map(line => line.trim().split(/\s+/).map(Number))
      .filter(
        (row): row is [number, number] =>
          row.length === 2 &&
          Number.isInteger(row[0]) &&
          Number.isInteger(row[1]) &&
          row[1] === processGroupId,
      )
      .map(([pid]) => pid)
  } catch {
    return []
  }
}

function isAlive(pid: number): boolean {
  try {
    execFileSync('ps', ['-p', String(pid)], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolveSleep => setTimeout(resolveSleep, ms))
}

async function waitForSocket(socketPath: string, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!existsSync(socketPath)) {
    if (Date.now() >= deadline) {
      throw new Error(`sidecar never bound socket at ${socketPath}`)
    }
    await sleep(50)
  }
}

let activeProc: ChildProcess | null = null
let activeSock: Socket | null = null
let activeOwnedTempDirs: string[] = []
let cleaned = false
let lastOwnedProcessGroupPids: number[] = []
let lastOwnedProcessGroupId: number | null = null

function hasExited(proc: ChildProcess): boolean {
  return proc.exitCode !== null || proc.signalCode !== null
}

function waitForExit(proc: ChildProcess): Promise<void> {
  if (hasExited(proc)) return Promise.resolve()
  return new Promise(resolveExit => {
    proc.once('exit', () => resolveExit())
  })
}

/**
 * Kill only the process group created for this child at spawn. The group id
 * must equal the child pid, which is the detached-spawn ownership invariant.
 */
function killSidecar(proc: ChildProcess): boolean {
  if (hasExited(proc)) return false
  const pid = proc.pid
  lastOwnedProcessGroupId = null
  lastOwnedProcessGroupPids = []
  if (!pid || !isAlive(pid)) return false

  const processGroupId = readProcessGroupId(pid)
  if (processGroupId !== pid) {
    proc.kill('SIGKILL')
    return false
  }
  lastOwnedProcessGroupId = processGroupId
  lastOwnedProcessGroupPids = processGroupPids(processGroupId)
  try {
    process.kill(-processGroupId, 'SIGKILL')
    return true
  } catch {
    proc.kill('SIGKILL')
    return false
  }
}

function removeOwnedTempDir(path: string): boolean {
  try {
    rmSync(path, { recursive: true, force: true })
  } catch {
    return false
  }
  return !existsSync(path)
}

function emergencyCleanup(): void {
  if (cleaned) return
  cleaned = true
  try {
    activeSock?.destroy()
  } catch {
    // The socket may already be closed.
  }
  if (activeProc) {
    killSidecar(activeProc)
  }
  for (const path of activeOwnedTempDirs) removeOwnedTempDir(path)
}

for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) {
  process.on(signal, () => {
    emergencyCleanup()
    process.exit(1)
  })
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function frameKindSummary(frame: Record<string, unknown>): string {
  if (frame.kind !== 'event' || !isRecord(frame.event)) {
    return typeof frame.kind === 'string' ? frame.kind : 'unknown'
  }
  return typeof frame.event.type === 'string'
    ? `event:${frame.event.type}`
    : 'event:unknown'
}

function failJson(message: string): void {
  process.stdout.write(`${JSON.stringify({ ok: false, error: message }, null, 2)}\n`)
  process.exitCode = 2
}

async function run(): Promise<void> {
  const args = parseArgs(process.argv.slice(2))
  const label = args.label ?? 'run'
  const outDir = args.out ?? join(here, '..', '.ram-scratch', 'out')
  const mode = args.mode ?? 'real'
  const attached = args.attach === 'true'
  const realTurn = args['real-turn'] === 'true'
  const packagedApp = args['packaged-app']
  const dwellMs = Number(args['dwell-ms'] ?? '240000')
  const sampleMs = Number(args['sample-ms'] ?? '30000')
  const settleMs = Number(args['settle-ms'] ?? '2500')
  const realTurnTimeoutMs = Number(
    args['turn-timeout-ms'] ?? String(DEFAULT_REAL_TURN_TIMEOUT_MS),
  )
  const mimallocPurgeDelay = args['mimalloc-purge-delay']

  if (realTurn) {
    if (args.mode !== 'real' || !attached || !packagedApp || packagedApp === 'true') {
      failJson('ram-probe: --real-turn requires --mode real --attach --packaged-app <path>')
      return
    }
    if ('config-dir' in args) {
      failJson('ram-probe: --real-turn owns its config home; do not pass --config-dir')
      return
    }
  } else if (!args['config-dir']) {
    failJson('ram-probe: --config-dir is required outside --real-turn mode')
    return
  }

  if (
    ![dwellMs, sampleMs, settleMs, realTurnTimeoutMs].every(Number.isFinite) ||
    dwellMs < 0 ||
    sampleMs <= 0 ||
    settleMs < 0 ||
    realTurnTimeoutMs <= 0
  ) {
    failJson('ram-probe: dwell-ms and settle-ms must be nonnegative; sample-ms and turn-timeout-ms must be positive')
    return
  }

  const launch = packagedApp && packagedApp !== 'true'
    ? resolveSidecarLaunch({
        packaged: true,
        mainDir: join(resolve(packagedApp), 'Contents', 'Resources', 'app', 'main'),
        resourcesPath: join(resolve(packagedApp), 'Contents', 'Resources'),
      })
    : null
  const sidecarCommand = launch?.command ?? 'bun'
  const sidecarArgs = launch?.argsFor('session') ?? ['run', SIDECAR_ENTRY]
  if (launch && !existsSync(sidecarCommand)) {
    failJson(`ram-probe: packaged sidecar does not exist at ${sidecarCommand}`)
    return
  }

  mkdirSync(outDir, { recursive: true })
  const socketDir = mkdtempSync(join(tmpdir(), 'ram0-'))
  activeOwnedTempDirs = [socketDir]
  const cwdDir = join(socketDir, 'cwd')
  mkdirSync(cwdDir, { recursive: true })
  const ownedConfigDir = realTurn
    ? mkdtempSync(join(tmpdir(), 'ram0-config-'))
    : null
  const configDir = ownedConfigDir ?? args['config-dir']
  if (!configDir) throw new Error('config directory resolution failed')
  if (ownedConfigDir) activeOwnedTempDirs.push(ownedConfigDir)
  if (realTurn) {
    writeFileSync(
      join(configDir, '.cat-code.json'),
      `${JSON.stringify({
        projects: {
          [cwdDir]: { hasTrustDialogAccepted: true },
        },
      })}\n`,
      { mode: 0o600 },
    )
  }

  const socketPath = join(socketDir, 's.sock')
  const pidFile = join(outDir, `${label}.pids`)
  const rawFile = join(outDir, `${label}.vmmap.txt`)
  const stderrFile = join(outDir, `${label}.sidecar.stderr.log`)
  writeFileSync(rawFile, '')
  writeFileSync(stderrFile, '')
  const rawArtifact: BoundedArtifact = {
    path: rawFile,
    maxBytes: MAX_RAW_ARTIFACT_BYTES,
    bytesWritten: 0,
    truncated: false,
  }
  const stderrArtifact: BoundedArtifact = {
    path: stderrFile,
    maxBytes: MAX_STDERR_BYTES,
    bytesWritten: 0,
    truncated: false,
  }

  const env: Record<string, string> = { ...process.env } as Record<string, string>
  const explicitSensitiveKeys = new Set([
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
    'ANTHROPIC_BASE_URL',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'CLAUDE_CONFIG_DIR',
    'CODEX_HOME',
    'OPENAI_API_KEY',
    'OPENAI_BASE_URL',
    'OPENAI_ORG_ID',
    'OPENAI_PROJECT_ID',
    'AWS_ACCESS_KEY_ID',
    'AWS_SECRET_ACCESS_KEY',
    'AWS_SESSION_TOKEN',
    'AWS_PROFILE',
    'AWS_SHARED_CREDENTIALS_FILE',
    'AWS_WEB_IDENTITY_TOKEN_FILE',
    'GOOGLE_APPLICATION_CREDENTIALS',
    'GOOGLE_API_KEY',
    'GEMINI_API_KEY',
    'CLAUDE_CODE_USE_BEDROCK',
    'CLAUDE_CODE_USE_VERTEX',
    'CLAUDE_CODE_USE_FOUNDRY',
    'CLAUDE_CODE_USE_OPENAI',
    'HTTP_PROXY',
    'HTTPS_PROXY',
    'ALL_PROXY',
    'http_proxy',
    'https_proxy',
    'all_proxy',
  ])
  for (const key of Object.keys(env)) {
    if (
      explicitSensitiveKeys.has(key) ||
      (realTurn &&
        (isProviderManagedEnvVar(key) ||
          /^(?:ANTHROPIC|OPENAI|AWS|AZURE|GOOGLE|GEMINI|VERTEX|BEDROCK|CODEX|CLAUDE).*?(?:API_KEY|TOKEN|SECRET|PASSWORD|CREDENTIALS_FILE|CUSTOM_HEADERS)$/.test(key)))
    ) {
      delete env[key]
    }
  }
  Object.assign(env, {
    CLAUDE_CONFIG_DIR: configDir,
    CATCODE_SIDECAR_SOCKET: socketPath,
    CATCODE_SIDECAR_SESSION_ID: `ram0-${label}`,
    CATCODE_SIDECAR_CWD: cwdDir,
    CATCODE_SIDECAR_IDLE_TTL_MS: '0',
    DISABLE_AUTOUPDATER: '1',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    CLAUDE_CODE_MAX_RETRIES: '1',
    API_TIMEOUT_MS: '3000',
    CLAUDE_STREAM_IDLE_TIMEOUT_MS: '3000',
    CI: '1',
    HTTP_PROXY: CLOSED_PROXY_ENDPOINT,
    HTTPS_PROXY: CLOSED_PROXY_ENDPOINT,
    ALL_PROXY: CLOSED_PROXY_ENDPOINT,
    http_proxy: CLOSED_PROXY_ENDPOINT,
    https_proxy: CLOSED_PROXY_ENDPOINT,
    all_proxy: CLOSED_PROXY_ENDPOINT,
    NO_PROXY: '127.0.0.1,localhost',
    no_proxy: '127.0.0.1,localhost',
  })
  if (mode === 'probe') env.CATCODE_SIDECAR_PROBE = '1'
  else delete env.CATCODE_SIDECAR_PROBE
  if (realTurn) {
    env.CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST = '1'
    env.ANTHROPIC_API_KEY = SYNTHETIC_API_KEY
    env.ANTHROPIC_BASE_URL = CLOSED_ANTHROPIC_ENDPOINT
  }
  if (mimallocPurgeDelay !== undefined) {
    env.MIMALLOC_PURGE_DELAY = String(mimallocPurgeDelay)
  }

  let proc: ChildProcess | null = null
  let sock: Socket | null = null
  let stderrDrain: Promise<void> | null = null
  let stderrObservedBytes = 0
  let reachedReady = false
  let readyScan = ''
  let failure: string | null = null
  let killVerified = false
  let processGroupOwnershipVerified = false
  let ownedProcessGroupId: number | null = null
  let survivors: number[] = []
  let ownedPids: number[] = []
  let socketDirRemoved = false
  let configDirRemoved: boolean | null = null
  const samples: Sample[] = []
  let samplesTruncated = false
  const observedFrameKinds: string[] = []
  let observedFrameCount = 0
  let observedFramesTruncated = false
  let normalEnvelopeObserved = false
  let decodeFailure: string | null = null
  let socketFailure: string | null = null
  let trustedObserved = false
  let untrustedObserved = false
  let submitSent = false
  let submitAccepted = false
  let submitAcceptedAt: number | null = null
  let activeTurnAt: number | null = null
  let terminalTurnAt: number | null = null
  let frameOrdinal = 0
  const t0 = Date.now()
  const sessionId = `ram0-${label}`
  const submitRequestId = 'ram0-submit-request'
  const submitId = 'ram0-submit'

  const sample = (sampleLabel: string): void => {
    if (samples.length >= MAX_SAMPLES) {
      samplesTruncated = true
      return
    }
    const pid = proc?.pid
    if (!pid) return
    const rssMB = psRssMB(pid)
    const capture = vmmapSummary(pid)
    const header =
      `\n===== ${sampleLabel} @ ${((Date.now() - t0) / 1000).toFixed(1)}s ` +
      `pid=${pid} rss=${rssMB}MB footprint=${capture.footprintMB}MB peak=${capture.peakMB}MB =====\n`
    appendBounded(rawArtifact, header)
    appendBounded(rawArtifact, capture.raw)
    appendBounded(rawArtifact, '\n')
    samples.push({
      label: sampleLabel,
      elapsedMs: Date.now() - t0,
      rssMB,
      footprintMB: capture.footprintMB,
      footprintPeakMB: capture.peakMB,
      vmmapBytes: capture.capturedBytes,
      vmmapTruncated: capture.truncated,
    })
    process.stderr.write(
      `[probe:${label}] ${sampleLabel} rss=${rssMB}MB ` +
      `footprint=${capture.footprintMB}MB peak=${capture.peakMB}MB\n`,
    )
  }

  const waitFor = async (
    description: string,
    predicate: () => boolean,
    timeoutMs: number,
  ): Promise<void> => {
    const deadline = Date.now() + timeoutMs
    while (!predicate()) {
      if (decodeFailure) throw new Error(`outbound frame decode failed: ${decodeFailure}`)
      if (socketFailure) throw new Error(`sidecar socket failed: ${socketFailure}`)
      if (proc && hasExited(proc)) throw new Error(`sidecar exited before ${description}`)
      if (Date.now() >= deadline) throw new Error(`timed out waiting for ${description}`)
      await sleep(25)
    }
  }

  const sendMessage = (message: Record<string, unknown>): void => {
    if (!sock || sock.destroyed) throw new Error('sidecar socket is not writable')
    sock.write(encodeFrame({ protocolVersion: 1, sessionId, message }))
  }

  const observePayload = (payload: unknown): void => {
    if (!isRecord(payload)) return
    let frame = payload
    if (payload.kind === 'sidecar.delivery-envelope') {
      if (!isRecord(payload.frame)) return
      normalEnvelopeObserved = true
      frame = payload.frame
    }

    frameOrdinal++
    observedFrameCount++
    if (observedFrameKinds.length < MAX_FRAME_SUMMARIES) {
      observedFrameKinds.push(frameKindSummary(frame))
    } else {
      observedFramesTruncated = true
    }

    if (frame.kind === 'workspace-trust.snapshot' && isRecord(frame.workspaceTrust)) {
      if (frame.workspaceTrust.trusted === true) {
        trustedObserved = true
      } else if (frame.workspaceTrust.trusted === false && realTurn) {
        untrustedObserved = true
      }
      return
    }
    if (
      frame.kind === 'submit.result' &&
      frame.submitId === submitId &&
      frame.accepted === true &&
      submitAcceptedAt === null
    ) {
      submitAccepted = true
      submitAcceptedAt = frameOrdinal
      return
    }
    if (frame.kind !== 'event' || !isRecord(frame.event) || frame.event.type !== 'turn.status') {
      return
    }
    if (frame.event.activeTurn === true && submitSent && activeTurnAt === null) {
      activeTurnAt = frameOrdinal
      return
    }
    if (frame.event.activeTurn === false && activeTurnAt !== null && terminalTurnAt === null) {
      terminalTurnAt = frameOrdinal
    }
  }

  try {
    appendBounded(
      rawArtifact,
      `# RAM-0 raw vmmap captures; label=${label} mode=${mode} attached=${attached} realTurn=${realTurn}\n`,
    )
    proc = spawn(sidecarCommand, sidecarArgs, {
      cwd: cwdDir,
      env,
      detached: true,
      stdio: ['ignore', 'ignore', 'pipe'],
    })
    activeProc = proc
    const parentPid = proc.pid
    ownedPids = parentPid ? [parentPid] : []
    writeFileSync(pidFile, parentPid ? `${parentPid}\n` : '')

    stderrDrain = (async () => {
      try {
        const decoder = new TextDecoder()
        for await (const value of proc!.stderr!) {
          const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value)
          stderrObservedBytes += chunk.byteLength
          appendBounded(stderrArtifact, chunk)
          const text = decoder.decode(chunk, { stream: true })
          readyScan = `${readyScan}${text}`.slice(-256)
          if (readyScan.includes('[sidecar] READY')) reachedReady = true
        }
        readyScan = `${readyScan}${decoder.decode()}`.slice(-256)
        if (readyScan.includes('[sidecar] READY')) reachedReady = true
      } catch {
        // Teardown closes the stream; retained diagnostics are already bounded.
      }
    })()

    await waitForSocket(socketPath)
    await waitFor('READY', () => reachedReady, 30_000)
    await sleep(settleMs)
    sample('boot')

    if (attached) {
      const decoder = new FrameDecoder(MAX_OUTBOUND_FRAME_BYTES)
      sock = connect({ path: socketPath })
      activeSock = sock
      sock.on('data', chunk => {
        for (const decoded of decoder.push(chunk)) {
          if (decoded.kind === 'error') {
            decodeFailure = decoded.reason
            sock?.destroy()
            break
          }
          observePayload(decoded.payload)
        }
      })
      sock.on('error', error => {
        if (!cleaned) socketFailure = error.message
      })
      await new Promise<void>((resolveConnect, rejectConnect) => {
        sock!.once('connect', resolveConnect)
        sock!.once('error', rejectConnect)
      })

      if (realTurn) {
        if (untrustedObserved) {
          throw new Error(
            'packaged sidecar did not read the isolated trusted-workspace fixture',
          )
        }
        await waitFor('workspace trust snapshot with trusted=true', () => trustedObserved, realTurnTimeoutMs)
        if (!normalEnvelopeObserved) {
          throw new Error('normal sidecar delivery envelope was not observed')
        }
        sample('attached-trusted')
        sendMessage({
          type: 'app.submit',
          requestId: submitRequestId,
          prompt: 'Return one short synthetic response.',
          options: { submitId },
        })
        submitSent = true
        await waitFor(
          'accepted submit and ordered active/terminal turn transitions',
          () =>
            submitAcceptedAt !== null &&
            activeTurnAt !== null &&
            terminalTurnAt !== null &&
            Math.max(submitAcceptedAt, activeTurnAt) < terminalTurnAt,
          realTurnTimeoutMs,
        )
        sample('real-turn-terminal')
      } else {
        await sleep(settleMs)
        sample('attached-first-enum')
      }

      const deadline = Date.now() + dwellMs
      let cycle = 1
      while (Date.now() < deadline) {
        await sleep(Math.min(sampleMs, Math.max(0, deadline - Date.now())))
        sample(`attached-cycle-${cycle}`)
        cycle++
      }
    } else {
      await sleep(Math.min(dwellMs, 5_000))
      sample('boot-settled')
    }
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error)
  } finally {
    cleaned = true
    try {
      sock?.destroy()
    } catch {
      // The socket may already be closed.
    }

    if (proc && hasExited(proc)) {
      await waitForExit(proc)
      // Historical probes treated a self-exited fixture as fully cleaned. The
      // acceptance path is stricter: once its parent is gone there is no live
      // ownership root from which descendants can be gathered safely.
      killVerified = !realTurn
      try {
        appendFileSync(
          pidFile,
          `killVerified=${killVerified} survivors=none (exited on its own)\n`,
        )
      } catch {
        failure ??= 'could not record process cleanup evidence'
      }
    } else if (proc?.pid) {
      const parentPid = proc.pid
      processGroupOwnershipVerified = killSidecar(proc)
      ownedProcessGroupId = lastOwnedProcessGroupId
      ownedPids = [...new Set([parentPid, ...lastOwnedProcessGroupPids])]
      await Promise.race([waitForExit(proc), sleep(CLEANUP_TIMEOUT_MS)])
      const deadline = Date.now() + CLEANUP_TIMEOUT_MS
      while (
        ownedProcessGroupId !== null &&
        processGroupPids(ownedProcessGroupId).length > 0 &&
        Date.now() < deadline
      ) {
        await sleep(50)
      }
      const groupSurvivors =
        ownedProcessGroupId === null
          ? []
          : processGroupPids(ownedProcessGroupId)
      survivors = [...new Set([
        ...ownedPids.filter(isAlive),
        ...groupSurvivors,
      ])]
      ownedPids = [...new Set([...ownedPids, ...groupSurvivors])]
      killVerified =
        processGroupOwnershipVerified &&
        survivors.length === 0 &&
        hasExited(proc)
      try {
        appendFileSync(
          pidFile,
          `ownedPids=${ownedPids.join(',') || 'none'} killVerified=${killVerified} ` +
            `survivors=${survivors.join(',') || 'none'}\n`,
        )
      } catch {
        failure ??= 'could not record process cleanup evidence'
      }
    }

    if (stderrDrain) {
      await Promise.race([stderrDrain, sleep(CLEANUP_TIMEOUT_MS)])
    }
    socketDirRemoved = removeOwnedTempDir(socketDir)
    if (ownedConfigDir) configDirRemoved = removeOwnedTempDir(ownedConfigDir)
    activeProc = null
    activeSock = null
    activeOwnedTempDirs = []
  }

  const turnProofOrdered =
    submitAcceptedAt !== null &&
    activeTurnAt !== null &&
    terminalTurnAt !== null &&
    Math.max(submitAcceptedAt, activeTurnAt) < terminalTurnAt
  const tempCleanupComplete = socketDirRemoved && (!ownedConfigDir || configDirRemoved === true)
  const processCleanupComplete = killVerified && survivors.length === 0
  const realTurnProofComplete =
    !realTurn ||
    (launch?.packaged === true &&
      mode === 'real' &&
      normalEnvelopeObserved &&
      trustedObserved &&
      submitSent &&
      submitAccepted &&
      turnProofOrdered)
  const ok =
    failure === null &&
    reachedReady &&
    processCleanupComplete &&
    tempCleanupComplete &&
    realTurnProofComplete

  const result = {
    ok,
    error: failure,
    label,
    mode,
    attached,
    realTurn,
    dwellMs,
    sampleMs,
    mimallocPurgeDelay: mimallocPurgeDelay ?? null,
    launch: {
      packaged: launch?.packaged ?? false,
      command: sidecarCommand,
      args: sidecarArgs,
      binaryPresent: existsSync(sidecarCommand),
    },
    normalRuntime: {
      probeFixture: mode === 'probe',
      probeEnvironmentSet: env.CATCODE_SIDECAR_PROBE === '1',
      deliveryEnvelopeObserved: normalEnvelopeObserved,
      reachedReady,
    },
    isolation: {
      internallyOwnedConfigHome: ownedConfigDir !== null,
      providerEnvironmentStripped: realTurn,
      syntheticAnthropicCredential: realTurn,
      anthropicBaseUrl: realTurn ? CLOSED_ANTHROPIC_ENDPOINT : null,
      apiTimeoutMs: realTurn ? 3_000 : null,
    },
    workspaceTrust: {
      source: 'isolated synthetic config',
      trustedObserved,
    },
    turnProof: {
      submitSent,
      submitAccepted,
      activeTurnObserved: activeTurnAt !== null,
      terminalTurnObserved: terminalTurnAt !== null,
      ordered: turnProofOrdered,
    },
    observedFrameKinds,
    observedFrameCount,
    observedFramesTruncated,
    cleanup: {
      parentPid: proc?.pid ?? null,
      processGroupId: ownedProcessGroupId,
      processGroupOwnershipVerified,
      ownedPids,
      survivors,
      processComplete: processCleanupComplete,
      socketDirectory: {
        path: socketDir,
        removed: socketDirRemoved,
      },
      configHome: {
        path: configDir,
        owned: ownedConfigDir !== null,
        removed: configDirRemoved,
      },
      tempComplete: tempCleanupComplete,
    },
    samples,
    samplesTruncated,
    artifacts: {
      rawVmmap: {
        path: rawFile,
        bytes: artifactSize(rawFile),
        maxBytes: MAX_RAW_ARTIFACT_BYTES,
        truncated: rawArtifact.truncated || samples.some(item => item.vmmapTruncated),
      },
      sidecarStderr: {
        path: stderrFile,
        observedBytes: stderrObservedBytes,
        bytes: artifactSize(stderrFile),
        maxBytes: MAX_STDERR_BYTES,
        truncated: stderrArtifact.truncated,
      },
      pidFile: {
        path: pidFile,
        bytes: artifactSize(pidFile),
        truncated: false,
      },
    },
  }
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)

  if (!ok) {
    if (!processCleanupComplete || !tempCleanupComplete) process.exitCode = 3
    else if (!reachedReady || !realTurnProofComplete) process.exitCode = 4
    else process.exitCode = 1
  }
}

run().catch(error => {
  emergencyCleanup()
  process.stdout.write(
    `${JSON.stringify({
      ok: false,
      error: `ram-probe fatal: ${error instanceof Error ? error.message : String(error)}`,
    }, null, 2)}\n`,
  )
  process.exit(1)
})
