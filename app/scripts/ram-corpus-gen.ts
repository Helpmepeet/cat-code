/**
 * RAM-0 deterministic corpus generator (measurement instrument, no secrets).
 *
 * Produces a real-shaped synthetic sessions-catalog corpus under a sandbox
 * `CLAUDE_CONFIG_DIR` so the sidecar's catalog enumeration
 * (`loadAllProjectsMessageLogsProgressive`, `src/utils/sessionStorage.ts:4476`)
 * has genuine transcripts to stat-list + enrich. The corpus is written to
 * `<out>/projects/<sanitized-cwd>/<uuid>.jsonl`, exactly where
 * `getProjectsDir()` (`sessionStoragePortable.ts:326`) looks.
 *
 * FULLY DETERMINISTIC — the RAM-0 protocol (F1) requires a re-runnable recipe:
 *   - NO `Math.random`, NO `Date.now`, NO `crypto.randomUUID`;
 *   - a seeded mulberry32 PRNG drives every choice;
 *   - UUIDs are derived from (seed, session index);
 *   - timestamps derive from a fixed base epoch + deterministic offsets;
 *   - file mtime/atime are stamped deterministically via `utimesSync`.
 * Re-running with the same `--seed`/`--sessions`/`--dirs`/`--min-bytes`
 * reproduces byte-identical files (aside from inode metadata).
 *
 * Each transcript is shaped so the lite enrich path
 * (`readLiteMetadata`, `sessionStorage.ts:5230`) extracts real fields:
 *   - HEAD (first 64KB, `LITE_READ_BUF_SIZE`): a `type:"user"` line carrying
 *     `cwd`, `gitBranch`, and a non-slash `message.content` (→ firstPrompt +
 *     hasConversation=true);
 *   - body: many `assistant`/`user` lines of deterministic filler so the file
 *     exceeds 128KB (head and tail windows are full AND disjoint);
 *   - TAIL (last 64KB): bookkeeping lines carrying `lastPrompt`, `customTitle`,
 *     `summary`, `tag`, `gitBranch`, `prNumber`, `prRepository`, and a final
 *     `timestamp` (→ real modified time, PR chip, labeled row).
 *
 * Usage:
 *   bun run app/scripts/ram-corpus-gen.ts --out <configDir> \
 *     --sessions 600 --dirs 30 --seed 42 --min-bytes 160000
 *
 * Prints a JSON manifest to stdout and writes `<out>/corpus-manifest.json`.
 */

import { mkdirSync, rmSync, writeFileSync, utimesSync, statSync, existsSync } from 'node:fs'
import { join } from 'node:path'

import { parseArgs } from './ramInstrument.js'

// ---------------------------------------------------------------------------
// Seeded PRNG (mulberry32) — deterministic, no global RNG state.
// ---------------------------------------------------------------------------
function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a |= 0
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Deterministic 8-4-4-4-12 lowercase-hex UUID (validateUuid-shaped). */
function deterministicUuid(rng: () => number): string {
  const hex = '0123456789abcdef'
  let s = ''
  for (let i = 0; i < 32; i++) s += hex[Math.floor(rng() * 16)]
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20, 32)}`
}

/** Mirror of engine sanitizePath (`sessionStoragePortable.ts:311`) for short names. */
function sanitizePath(name: string): string {
  return name.replace(/[^a-zA-Z0-9]/g, '-')
}

const WORDS = [
  'engine', 'catalog', 'sidecar', 'transcript', 'session', 'refresh', 'enrich',
  'plateau', 'footprint', 'allocator', 'mimalloc', 'boot', 'floor', 'resume',
  'snapshot', 'reducer', 'projector', 'permission', 'workspace', 'renderer',
  'supervisor', 'registry', 'lifetime', 'attach', 'connection', 'frame',
]

function deterministicSentence(rng: () => number, wordCount: number): string {
  const parts: string[] = []
  for (let i = 0; i < wordCount; i++) parts.push(WORDS[Math.floor(rng() * WORDS.length)])
  return parts.join(' ')
}

function main(): void {
  const args = parseArgs(process.argv.slice(2))
  const out = args.out
  if (!out) {
    process.stderr.write('ram-corpus-gen: --out <configDir> is required\n')
    process.exit(2)
  }
  const sessions = Number(args.sessions ?? '600')
  const dirs = Number(args.dirs ?? '30')
  const seed = Number(args.seed ?? '42')
  const minBytes = Number(args['min-bytes'] ?? '160000')
  const clean = args.clean === 'true'

  const projectsDir = join(out, 'projects')
  if (clean && existsSync(projectsDir)) {
    rmSync(projectsDir, { recursive: true, force: true })
  }
  mkdirSync(projectsDir, { recursive: true })

  // Fixed base epoch (2026-01-01T00:00:00Z) — deterministic, no Date.now.
  const BASE_MS = Date.UTC(2026, 0, 1, 0, 0, 0)
  const rng = mulberry32(seed)

  // Pre-create the project dirs (each a distinct sanitized cwd).
  const cwds: string[] = []
  const dirPaths: string[] = []
  for (let d = 0; d < dirs; d++) {
    const cwd = `/Users/seed/workspace-${d}`
    cwds.push(cwd)
    const dirPath = join(projectsDir, sanitizePath(cwd))
    mkdirSync(dirPath, { recursive: true })
    dirPaths.push(dirPath)
  }

  let totalBytes = 0
  let minFileBytes = Infinity
  let maxFileBytes = 0
  const sessionIds: string[] = []

  for (let i = 0; i < sessions; i++) {
    const uuid = deterministicUuid(rng)
    sessionIds.push(uuid)
    const dirIdx = i % dirs
    const cwd = cwds[dirIdx]
    const branch = `feature/seed-${i % 7}`
    // Each session's activity spans a deterministic window; later sessions are
    // "newer" so mtime ordering is stable and reproducible.
    const startMs = BASE_MS + i * 3_600_000 // one hour apart
    const lastMs = startMs + 1_800_000 // 30 min later
    const iso = (ms: number) => new Date(ms).toISOString()

    const firstPrompt = `Investigate ${deterministicSentence(rng, 6)} for session ${i}`
    const lastPrompt = `Follow up on ${deterministicSentence(rng, 5)}`
    const title = `Seeded ${WORDS[i % WORDS.length]} session ${i}`
    const summary = `Deterministic summary: ${deterministicSentence(rng, 8)}`

    const lines: string[] = []
    // HEAD — first user message with cwd + gitBranch (drives firstPrompt, cwd,
    // gitBranch, hasConversation).
    lines.push(
      JSON.stringify({
        type: 'user',
        uuid: deterministicUuid(rng),
        sessionId: uuid,
        timestamp: iso(startMs),
        version: '2.1.87',
        gitBranch: branch,
        cwd,
        message: { role: 'user', content: firstPrompt },
      }),
    )

    // BODY — deterministic filler until the file is comfortably over 128KB so
    // the head and tail 64KB windows are full and disjoint. Reserve headroom
    // for the tail bookkeeping lines.
    let approxBytes = lines[0].length + 1
    let turn = 0
    while (approxBytes < minBytes - 4_000) {
      const isAssistant = turn % 2 === 0
      const tMs = startMs + turn * 5_000
      const text = deterministicSentence(rng, 40)
      const line = isAssistant
        ? JSON.stringify({
            type: 'assistant',
            sessionId: uuid,
            timestamp: iso(tMs),
            message: { role: 'assistant', content: [{ type: 'text', text }] },
          })
        : JSON.stringify({
            type: 'user',
            sessionId: uuid,
            timestamp: iso(tMs),
            message: { role: 'user', content: text },
          })
      lines.push(line)
      approxBytes += line.length + 1
      turn++
    }

    // TAIL bookkeeping — carried in the last 64KB so readLiteMetadata's tail
    // scan extracts them (last occurrence wins).
    lines.push(JSON.stringify({ type: 'ai-title', aiTitle: title, timestamp: iso(lastMs) }))
    lines.push(JSON.stringify({ type: 'custom-title', customTitle: title, timestamp: iso(lastMs) }))
    lines.push(JSON.stringify({ type: 'summary', summary, timestamp: iso(lastMs) }))
    lines.push(JSON.stringify({ type: 'tag', tag: `seed-tag-${i % 5}`, timestamp: iso(lastMs) }))
    lines.push(
      JSON.stringify({
        type: 'pr-link',
        prNumber: 1000 + i,
        prRepository: 'seed/catcode',
        prUrl: `https://example.invalid/seed/catcode/pull/${1000 + i}`,
        timestamp: iso(lastMs),
      }),
    )
    // Final user line carrying lastPrompt + gitBranch + the last timestamp.
    lines.push(
      JSON.stringify({
        type: 'user',
        sessionId: uuid,
        timestamp: iso(lastMs),
        gitBranch: branch,
        lastPrompt,
        message: { role: 'user', content: lastPrompt },
      }),
    )

    const content = lines.join('\n') + '\n'
    const filePath = join(dirPaths[dirIdx], `${uuid}.jsonl`)
    writeFileSync(filePath, content)
    // Deterministic mtime/atime so getSessionFilesWithMtime ordering is stable.
    const mtimeSec = lastMs / 1000
    utimesSync(filePath, mtimeSec, mtimeSec)

    const size = statSync(filePath).size
    totalBytes += size
    minFileBytes = Math.min(minFileBytes, size)
    maxFileBytes = Math.max(maxFileBytes, size)
  }

  const manifest = {
    generator: 'app/scripts/ram-corpus-gen.ts',
    seed,
    sessions,
    dirs,
    minBytesRequested: minBytes,
    baseEpochUtc: new Date(BASE_MS).toISOString(),
    projectsDir,
    totalBytes,
    totalMB: +(totalBytes / (1024 * 1024)).toFixed(2),
    minFileBytes,
    maxFileBytes,
    firstSessionId: sessionIds[0],
    lastSessionId: sessionIds[sessionIds.length - 1],
  }
  writeFileSync(join(out, 'corpus-manifest.json'), JSON.stringify(manifest, null, 2) + '\n')
  process.stdout.write(JSON.stringify(manifest, null, 2) + '\n')
}

main()
