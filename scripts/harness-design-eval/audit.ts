import { createHash } from 'node:crypto'
import { readdir, readFile, lstat, mkdir, writeFile, mkdtemp, rm } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex')
const count = (map: Record<string, number>, key: string) => { map[key] = (map[key] ?? 0) + 1 }
const date = /^(\d{4}-\d\d-\d\dT[\d:.]+Z) /
const uuid = /^[a-f0-9-]{36}$/i
type Row = Record<string, any>

// Explicit paths, no runtime imports, credentials, network or state writes.
async function files(root: string, suffix: string): Promise<string[]> {
  const result: string[] = []
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) continue
    const path = join(root, entry.name)
    if (entry.isDirectory()) result.push(...await files(path, suffix))
    else if (entry.isFile() && entry.name.endsWith(suffix)) result.push(path)
  }
  return result.sort()
}

// A composition proxy, deliberately not a reconstruction of API assembly.
// Only a complete parent chain ending at a recorded boundary is accepted.
export function composition(boundary: Row, rows: Map<string, Row>) {
  const chain: Row[] = []
  let id = boundary.logicalParentUuid
  const seen = new Set<string>()
  while (id) {
    if (seen.has(id) || !rows.has(id)) return { available: false, reason: 'missing-or-cyclic-parent' }
    seen.add(id)
    const row = rows.get(id)!
    if (row.subtype === 'compact_boundary') break
    chain.unshift(row)
    id = row.parentUuid
  }
  if (!chain.length) return { available: false, reason: 'no-pre-boundary-chain' }
  const names = new Map<string, string>()
  const results = new Set<string>()
  const rounds: number[] = []
  let previousAssistant: string | undefined
  for (const [index, row] of chain.entries()) {
    if (row.type === 'assistant' && row.message?.id !== previousAssistant) {
      rounds.push(index); previousAssistant = row.message?.id
    }
    for (const block of Array.isArray(row.message?.content) ? row.message.content : []) {
      if (block.type === 'tool_use') names.set(block.id, block.name)
      if (block.type === 'tool_result') results.add(block.tool_use_id)
    }
  }
  const tailStart = rounds.at(-3) ?? 0
  let rawChars = 0, postCapChars = 0, eligibleOldChars = 0, protectedChars = 0, exemptions = 0
  for (const [index, row] of chain.entries()) {
    for (const block of Array.isArray(row.message?.content) ? row.message.content : []) {
      if (block.type !== 'tool_result') continue
      const name = names.get(block.tool_use_id)
      const parts = block.content
      const text = typeof parts === 'string' ? parts : Array.isArray(parts)
        ? parts.filter((p: Row) => p.type === 'text').map((p: Row) => p.text).join('') : ''
      const exempt = !name || name === 'ToolSearch' || (Array.isArray(parts) && parts.some((p: Row) => p.type === 'image'))
      const capped = exempt ? text.length : Math.min(text.length, 48_000)
      rawChars += text.length; postCapChars += capped
      if (exempt) exemptions++
      // Upper bound: excludes errors, non-workspace tools and three recent rounds.
      if (index < tailStart && !block.is_error && ['Read', 'Bash', 'Grep', 'Glob'].includes(name ?? '')) eligibleOldChars += capped
      else protectedChars += capped
    }
  }
  const pendingTools = [...names.keys()].filter(id => !results.has(id)).length
  if (pendingTools) return { available: false, reason: 'parent-walk-does-not-recover-complete-tool-exchanges',
    recoveredMessages: chain.length, unmatchedToolCalls: pendingTools }
  return { available: true, messages: chain.length, rawChars, postCapChars, eligibleOldChars, protectedChars, exemptions }
}

export async function audit(debugRoot: string, projectsRoot?: string, productionComposition = false) {
  const manifest: Row[] = [], sessions = new Map<string, Row>(), events: Record<string, number> = {}
  const requests: Row[] = [], usage: Row[] = [], thresholds: Row[] = []
  const builds: Record<string, number> = {}, models: Record<string, number> = {}, sendModes: Record<string, number> = {}
  let duplicateLines = 0
  for (const path of await files(debugRoot, '.txt')) {
    const before = await lstat(path)
    if (before.isSymbolicLink()) continue
    const body = await readFile(path)
    const after = await lstat(path)
    const fileId = `log-${manifest.length + 1}`
    const dates: string[] = [], versions = new Set<string>(), seen = new Set<string>()
    const sessionId = path.split('/').at(-1)!.slice(0, -4)
    for (const [index, line] of body.toString('utf8').split('\n').entries()) {
      const timestamp = line.match(date)?.[1]
      if (!timestamp) continue
      dates.push(timestamp)
      // Identical timestamped records are duplicates, never same-text new calls.
      if (seen.has(line)) { duplicateLines++; continue }
      seen.add(line)
      const location = { fileId, line: index + 1, timestamp }
      const version = line.match(/cc_version=([\w.\-]+);/)?.[1]
      if (version) { versions.add(version); count(builds, version) }
      const req = line.match(/\[codex-cache\] request account=(\S+) model=(\S+) conv=(\S+) instructions=(\d+)B hash=(\S+) messages=(\d+) effort=(\S+)/)
      if (req) {
        requests.push({ ...location, model: req[2], effort: req[7], instructionsChars: +req[4], items: +req[6],
          account: hash(req[1]!), conversationPrefix: req[3], build: version ?? [...versions].at(-1) ?? null })
        count(models, req[2]!)
      }
      const u = line.match(/\[codex-cache\] owner=(\S+) account=(\S+) model=(\S+) key=\S+ conversation=(\S+) cached=(\d+) input=(\d+)/)
      if (u) usage.push({ ...location, model: u[3], owner: u[1], account: hash(u[2]!), conversation: u[4], cached: +u[5], input: +u[6] })
      const t = line.match(/autocompact: tokens=(\d+) threshold=(\d+) effectiveWindow=(\d+)(.*)/)
      if (t) thresholds.push({ ...location, tokens: +t[1], threshold: +t[2], effectiveWindow: +t[3], overhead: +(t[4]!.match(/nonMessageOverhead=(\d+)/)?.[1] ?? NaN) })
      if (/\[codex-ws\] full send/.test(line)) count(sendModes, 'full')
      else if (/\[codex-ws\] incremental/.test(line)) count(sendModes, 'incremental')
      // Do not match compact words inside permissions, shell commands or bodies.
      if (/\[DEBUG\] Forked agent \[compact\] finished:/.test(line)) count(events, 'summary-agent-finished')
      if (/\[DEBUG\] Forked agent \[compact\] received message:/.test(line)) count(events, 'summary-agent-message')
      if (/\[DEBUG\] reactive compact:/.test(line)) count(events, 'reactive-debug-marker')
      if (/\[DEBUG\] autocompact: transient failure/.test(line)) count(events, 'auto-transient-failure')
    }
    dates.sort()
    const entry = { fileId, sha256: hash(body), bytes: body.length, start: dates[0] ?? null, end: dates.at(-1) ?? null,
      stableDuringRead: before.size === after.size && before.mtimeMs === after.mtimeMs, builds: [...versions].sort(), transcripts: 0 }
    manifest.push(entry)
    if (uuid.test(sessionId)) sessions.set(sessionId, entry)
  }
  const boundaries: Row[] = [], transcriptManifest: Row[] = []
  const diagnostics: Record<string, number> = {}, transcriptSends: Record<string, number> = {}
  const attempts = new Map<string, Row>(), attemptEnds = new Map<string, Row>()
  const sendUsage = { recordsWithUsage: 0, input: 0, cached: 0, streamMs: 0 }
  const transcriptBuilds: Record<string, number> = {}, origins: Record<string, number> = {}
  let rejectedIdentities = 0, malformedRows = 0
  if (projectsRoot) for (const path of await files(projectsRoot, '.jsonl')) {
    // Main transcript only; no inferred worker joins by filename or timestamp.
    const sessionId = path.split('/').at(-1)!.slice(0, -6)
    const entry = sessions.get(sessionId)
    if (!entry) continue
    const before = await lstat(path), body = await readFile(path), after = await lstat(path)
    const rows = new Map<string, Row>(), candidates: Array<{ row: Row; line: number }> = []
    let identityVerified = false, identityConflict = false
    const dates: string[] = []
    for (const [index, line] of body.toString('utf8').split('\n').entries()) {
      if (!line.trim()) continue
      let row: Row
      try { row = JSON.parse(line) } catch { malformedRows++; continue }
      if (row.sessionId === sessionId) identityVerified = true
      if (row.sessionId && row.sessionId !== sessionId) identityConflict = true
      if (typeof row.timestamp === 'string') dates.push(row.timestamp)
      if (row.uuid) rows.set(row.uuid, row)
      if (row.type === 'system' && row.subtype === 'compact_boundary') candidates.push({ row, line: index + 1 })
    }
    if (!identityVerified || identityConflict) { rejectedIdentities++; continue }
    entry.transcripts++
    const transcriptId = `transcript-${transcriptManifest.length + 1}`
    dates.sort()
    transcriptManifest.push({ transcriptId, logId: entry.fileId, sha256: hash(body), bytes: body.length,
      stableDuringRead: before.size === after.size && before.mtimeMs === after.mtimeMs, start: dates[0] ?? null, end: dates.at(-1) ?? null })
    for (const row of rows.values()) {
      if (!(row.timestamp >= entry.start && row.timestamp <= entry.end)) continue
      if (typeof row.version === 'string' && /^[\w.\-]+$/.test(row.version)) count(transcriptBuilds, row.version)
      if (row.entrypoint) count(origins, ['cli', 'sdk-ts', 'sdk-py'].includes(row.entrypoint) ? row.entrypoint : 'other-or-unknown')
      if (row.type !== 'system') continue
      if (['model_attempt_start', 'model_attempt_end', 'codex_request_start', 'codex_stream_surface', 'codex_send_path', 'tool_execution_start', 'tool_execution_end'].includes(row.subtype)) count(diagnostics, row.subtype)
      if (row.subtype === 'model_attempt_start' && row.attempt_id && row.call_id) attempts.set(`${transcriptId}/${row.attempt_id}`, row)
      if (row.subtype === 'model_attempt_end' && row.attempt_id && row.call_id) attemptEnds.set(`${transcriptId}/${row.attempt_id}`, row)
      if (row.subtype === 'codex_send_path' && ['full', 'incremental', 'prewarm', 'stale_retry'].includes(row.mode)) {
        count(transcriptSends, row.mode)
        if (Number.isFinite(row.input_tokens) && Number.isFinite(row.cached_tokens)) {
          sendUsage.recordsWithUsage++; sendUsage.input += row.input_tokens; sendUsage.cached += row.cached_tokens
          sendUsage.streamMs += Number.isFinite(row.total_stream_ms) ? row.total_stream_ms : 0
        }
      }
    }
    for (const { row, line } of candidates) {
      let outputComposition = composition(row, rows)
      if (!outputComposition.available && productionComposition && row.logicalParentUuid) {
        const scratch = await mkdtemp(join(tmpdir(), 'harness-composition-'))
        try {
          // Freeze only the verified transcript prefix before this boundary.
          const snapshot = join(scratch, 'source.jsonl')
          await writeFile(snapshot, body.toString('utf8').split('\n').slice(0, line - 1).join('\n') + '\n', { mode: 0o600 })
          const child = Bun.spawn([process.execPath, new URL('./composition.ts', import.meta.url).pathname, snapshot, row.logicalParentUuid], {
            env: { PATH: process.env.PATH, CLAUDE_CONFIG_DIR: join(scratch, 'config'), NODE_ENV: 'test', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' },
            stdout: 'pipe', stderr: 'pipe', timeout: 30_000,
          })
          const [code, output] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
          if (code === 0) outputComposition = JSON.parse(output)
        } catch { /* Preserve the explicit missing-data result. */ }
        finally { await rm(scratch, { recursive: true, force: true }) }
      }
      boundaries.push({ transcriptId, logId: entry.fileId, line, timestamp: row.timestamp, version: row.version ?? null,
        recordedPreTokens: row.compactMetadata?.preTokens ?? null, messagesSummarized: row.compactMetadata?.messagesSummarized ?? null,
        trigger: row.compactMetadata?.trigger ?? 'unknown', strategy: row.compactMetadata?.preservedMessages || row.compactMetadata?.preservedSegment ? 'preserving (prefix/session-memory/partial unresolved)' : 'full-or-unknown',
        withinLogDates: row.timestamp >= entry.start && row.timestamp <= entry.end,
        composition: outputComposition })
    }
  }
  const cache = { responses: usage.length, input: 0, cached: 0, cold: 0, warm: 0, partial: 0 }
  const owners: Record<string, number> = {}, cohorts: Record<string, Row> = {}
  for (const u of usage) {
    cache.input += u.input; cache.cached += u.cached
    count(owners, u.owner === 'main-thread' ? 'main-thread (desktop/terminal unresolved)' : u.owner === 'none' ? 'unowned' : 'other owner (worker identity unresolved)')
    if (u.input <= 0) continue
    cache[u.cached === 0 ? 'cold' : u.cached / u.input >= .8 ? 'warm' : 'partial']++
    const key = `${u.timestamp.slice(0, 10)}/${u.model}`
    const cohort = cohorts[key] ??= { responses: 0, input: 0, cached: 0 }
    cohort.responses++; cohort.input += u.input; cohort.cached += u.cached
  }
  const observed = boundaries.filter(b => b.withinLogDates)
  const attemptOutcomes: Record<string, number> = {}
  for (const [id, start] of attempts) {
    const end = attemptEnds.get(id)
    count(attemptOutcomes, end?.call_id === start.call_id && ['succeeded', 'failed', 'cancelled'].includes(end.outcome) ? end.outcome : 'incomplete')
  }
  // Public artifacts carry no identifiers, command text, output bodies or account hashes.
  const sources = await Promise.all(['./audit.ts', './composition.ts', '../../src/utils/sessionStorage.ts', '../../src/services/api/codex-fetch-adapter.ts'].map(async name => ({
    name, sha256: hash(await readFile(new URL(name, import.meta.url))),
  })))
  return { schema: 1, policy: { sources, wireCapChars: 48_000, protectedAssistantRounds: 3,
    eligibleTools: ['Read', 'Bash', 'Grep', 'Glob'], productionComposition },
    manifest, transcriptManifest, duplicateLines, rejectedIdentities, malformedRows,
    totals: { logs: manifest.length, bytes: manifest.reduce((n, f) => n + f.bytes, 0), requestMarkers: requests.length,
      usageResponses: usage.length, thresholdChecks: thresholds.length, checksAtThreshold: thresholds.filter(t => t.tokens >= t.threshold).length,
      matchedSessions: manifest.filter(f => f.transcripts).length, persistedBoundaries: boundaries.length, boundariesWithinLogDates: observed.length,
      sessionsWithBoundaryWithinLogDates: new Set(observed.map(b => b.logId)).size },
    events, builds, models, sendModes, cache, owners, cohorts, boundaries,
    transcriptDiagnostics: { counts: diagnostics, sendModes: transcriptSends, sendUsage, attemptOutcomes,
      identifiedLogicalCalls: new Set([...attempts.values()].map(r => r.call_id)).size, builds: transcriptBuilds, origins },
    thresholdSummary: { effectiveWindows: [...new Set(thresholds.map(t => t.effectiveWindow))],
      maximumPressure: Math.max(0, ...thresholds.map(t => t.tokens / t.threshold)),
      overheadMin: Math.min(...thresholds.filter(t => Number.isFinite(t.overhead)).map(t => t.overhead)),
      overheadMax: Math.max(...thresholds.filter(t => Number.isFinite(t.overhead)).map(t => t.overhead)) },
    missing: ['No request IDs: marker counts are not unique logical calls or attempts.',
      'No installed build attestation; attribution versions are observations, not current HEAD cohorts.',
      'No reliable per-request send/usage join under concurrent side calls.',
      'No compaction attempt/failure/strategy instrumentation in debug logs; persisted boundaries are a censored lower bound.',
      'Composition is a transcript-text proxy under the current GPT cap, not historical/current serialized request tokens.',
      'Tool schemas, permissions, full instruction composition, repeated failing actions, recovery costs and independently verified completion are unavailable.'] }
}

if (import.meta.main) {
  const args = process.argv.slice(2)
  const value = (flag: string) => args[args.indexOf(flag) + 1]
  if (!args.includes('--debug-dir') || !args.includes('--out')) throw new Error('Usage: bun audit.ts --debug-dir PATH [--projects-dir PATH] --out PATH')
  const input = resolve(value('--debug-dir')!), projects = args.includes('--projects-dir') ? resolve(value('--projects-dir')!) : undefined
  const output = resolve(value('--out')!)
  if ([input, projects].some(root => root && (output === root || output.startsWith(root + '/')))) throw new Error('Output must be outside input directories')
  const result = await audit(input, projects, args.includes('--production-composition'))
  await mkdir(output, { recursive: true })
  await writeFile(join(output, 'audit.json'), JSON.stringify(result, null, 2) + '\n')
  console.log(JSON.stringify({ totals: result.totals, cache: result.cache, events: result.events, sendModes: result.sendModes, models: result.models }))
}
