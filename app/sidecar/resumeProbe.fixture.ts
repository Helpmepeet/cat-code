/**
 * Test fixture — drives the sidecar's REAL resume machinery
 * (`resumeEngineSession`) in its own Bun process and prints the engine-returned
 * result as JSON. Used by the P3-1 resume probe to assert that the resumed
 * session's state actually contains the prior messages, read from the engine's
 * deserialized `Message[]` — NOT by re-reading the JSONL.
 *
 * Run (the probe spawns it rooted in the session cwd + the fixture's config home,
 * matching how a real sidecar would resume):
 *
 *   CLAUDE_CONFIG_DIR=… bun run app/sidecar/resumeProbe.fixture.ts <engineSessionId> <marker>
 *
 * Prints one JSON line `RESUME_RESULT={…}` on stdout and exits 0 on success; a
 * failed resume throws and exits non-zero (loud, never a silent empty result).
 */

import { init } from '../../src/entrypoints/init.js'
import { resumeEngineSession } from './sessionResume.js'
import { projectUndeliveredPrompts } from './historyProjection.js'
import { loadAgentDefinitionsForRuntime } from './sessionController.js'
import { getInvokedSkills } from '../../src/bootstrap/state.js'
import { getClaudeMds, getMemoryFiles } from '../../src/utils/claudemd.js'
import { loadMessageLogs } from '../../src/utils/sessionStorage.js'
import { releaseActiveTranscriptLease } from '../../src/utils/transcriptLease.js'
import { enumerateSessionsCatalog } from './sessionsCatalogDomain.js'
import { getSkillDirCommands } from '../../src/skills/loadSkillsDir.js'

async function main(): Promise<void> {
  const engineSessionId = process.argv[2]
  const marker = process.argv[3] ?? ''
  if (!engineSessionId) {
    throw new Error('usage: resumeProbe.fixture.ts <engineSessionId> [marker]')
  }

  await init()
  const cwd = process.cwd()
  const result = await resumeEngineSession(
    engineSessionId,
    cwd,
    await loadAgentDefinitionsForRuntime(cwd),
  )
  const historyRow = (await loadMessageLogs()).find(log => log.sessionId === engineSessionId)

  const payload = {
    engineSessionId: result.engineSessionId,
    count: result.messages.length,
    hasMarker: JSON.stringify(result.messages).includes(marker),
    instructionContext: getClaudeMds(await getMemoryFiles()),
    invokedSkillPaths: [...getInvokedSkills().values()].map(skill => skill.skillPath),
    discoveredSkillNames: (await getSkillDirCommands(cwd)).map(command => command.name),
    hasHistoricalSkillListing: result.messages.some(message =>
      message.type === 'attachment' && typeof message.attachment === 'object' &&
      message.attachment !== null && 'type' in message.attachment &&
      message.attachment.type === 'skill_listing'),
    historyCwd: historyRow?.projectPath ?? null,
    historyBinding: historyRow?.sessionBinding?.kind ?? null,
    ...(process.argv.includes('--catalog') ? { catalog: await enumerateSessionsCatalog() } : {}),
    hasCompactBoundary: result.messages.some(
      message => message.type === 'system' && message.subtype === 'compact_boundary',
    ),
    // The exact rows `index.ts` appends to the restored history for messages
    // that were still queued when the process died — the assertion surface for
    // what a restore does and does not resurrect.
    undeliveredHistory: projectUndeliveredPrompts(
      result.undeliveredPrompts,
      result.engineSessionId,
    ),
  }
  process.stdout.write(`RESUME_RESULT=${JSON.stringify(payload)}\n`)
  // Flush stdout before exit so the parent reliably reads the line.
  await new Promise<void>(resolve => {
    if (process.stdout.write('')) resolve()
    else process.stdout.once('drain', () => resolve())
  })
  await releaseActiveTranscriptLease()
  process.exit(0)
}

void main().catch(error => {
  process.stderr.write(
    `resume-probe failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  )
  process.exit(1)
})
