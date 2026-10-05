/** Synthetic fixtures only. Run with: bun scripts/benchmarks/resourceWasteHistory.ts */
import { randomUUID } from 'crypto'
import { mkdir, mkdtemp, open, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { dirname, join } from 'path'

const fixture = await mkdtemp(join(tmpdir(), 'cc-history-resource-'))
process.env.CLAUDE_CONFIG_DIR = join(fixture, 'config')
const { switchSession } = await import('../../src/bootstrap/state.js')
const { asAgentId, asSessionId } = await import('../../src/types/ids.js')
const storage = await import('../../src/utils/sessionStorage.js')
const { loadBranchesWithinBudget, projectBranchFrames } = await import('../../app/sidecar/subagentHistory.js')
const sessionId = randomUUID()
switchSession(asSessionId(sessionId), fixture)

// Observe actual fd reads in this isolated process, including alignment probes.
const probePath = join(fixture, 'probe')
await writeFile(probePath, '')
const handle = await open(probePath, 'r')
const prototype = Object.getPrototypeOf(handle)
const originalRead = prototype.read
let bytes = 0
prototype.read = async function (...args: unknown[]) {
  const result = await originalRead.apply(this, args)
  bytes += result.bytesRead
  return result
}
await handle.close()
try {
  const candidates = []
  for (let index = 0; index < 12; index++) {
    const agentId = asAgentId(`fixture-${index}`)
    const path = storage.getAgentTranscriptPathForSession(sessionId, agentId)
    await mkdir(dirname(path), { recursive: true })
    const firstUuid = randomUUID()
    const rows = ['x'.repeat(8 * 1024 * 1024), 'second'].map((text, row) => ({
      parentUuid: row === 0 ? null : firstUuid,
      uuid: row === 0 ? firstUuid : randomUUID(),
      isSidechain: true, agentId, sessionId, type: 'assistant',
      timestamp: `2026-10-04T00:00:0${row}.000Z`,
      message: { role: 'assistant', content: [{ type: 'text', text }] },
    }))
    await writeFile(path, rows.map(row => JSON.stringify(row)).join('\n') + '\n')
    candidates.push({ agentId, parentToolUseId: `tool-${index}`, agentName: undefined })
  }
  bytes = 0
  let baselineAccepted = 0
  for (const candidate of candidates) {
    const transcript = await storage.getAgentTranscriptForSession(sessionId, candidate.agentId)
    if (transcript && projectBranchFrames(transcript.messages, candidate.parentToolUseId, undefined).length <= 1) baselineAccepted++
  }
  const baselineReadBytes = bytes
  bytes = 0
  const accepted = await loadBranchesWithinBudget(sessionId, candidates, 1, new Set())
  console.log(JSON.stringify({ candidates: candidates.length, baselineAccepted, accepted: accepted.length, baselineReadBytes, boundedReadBytes: bytes }))
} finally {
  prototype.read = originalRead
  await rm(fixture, { recursive: true, force: true })
}
