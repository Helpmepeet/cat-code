/**
 * Test fixture minter — writes a real engine transcript through the engine's OWN
 * persistence (`recordTranscript`), NOT hand-written JSONL. Used by the P3-1
 * resume probes: mint a transcript in a chosen cwd + config home, then spawn a
 * sidecar that resumes it.
 *
 * Run standalone (the probe spawns it as its own Bun process so the mint uses the
 * same cwd + CLAUDE_CONFIG_DIR the resuming sidecar will use, and never pollutes
 * the test runner's global engine STATE):
 *
 *   CLAUDE_CONFIG_DIR=… bun run app/sidecar/mintTranscript.fixture.ts <sessionId> <marker>
 *
 * The process cwd (set by the spawner) is the session root. Prints the transcript
 * path on stdout as a machine-readable line and exits 0 on success.
 */

import { init } from '../../src/entrypoints/init.js'
import { switchSession } from '../../src/bootstrap/state.js'
import { asAgentId, asSessionId } from '../../src/types/ids.js'
import {
  createAssistantMessage,
  createSystemMessage,
  createUserMessage,
} from '../../src/utils/messages.js'
import {
  flushSessionStorage,
  getAgentTranscriptPath,
  getTranscriptPathForSession,
  recordSidechainTranscript,
  recordTranscript,
} from '../../src/utils/sessionStorage.js'

async function main(): Promise<void> {
  const sessionId = process.argv[2]
  const marker = process.argv[3] ?? 'p3-1-fixture-marker'
  const realisticTail = process.argv.includes('--realistic-tail')
  if (!sessionId) {
    throw new Error('usage: mintTranscript.fixture.ts <sessionId> [marker]')
  }

  await init()
  // Adopt the target id so recordTranscript keys the file by it (it reads
  // getSessionId()); the transcript lands under the project dir derived from the
  // process cwd — exactly where the resuming sidecar (same cwd + config) looks.
  switchSession(asSessionId(sessionId))

  const user = createUserMessage({ content: `remember this nonce: ${marker}` })
  const assistant = createAssistantMessage({
    content: `acknowledged the nonce ${marker}`,
  })
  await recordTranscript([user, assistant])
  if (realisticTail) {
    // Reproduce the P3-8 live shape through production persistence: a
    // sidechain record and then a later, dangling system diagnostic. The latter
    // must not become the resume tip and discard the user/assistant context.
    await recordSidechainTranscript(
      [createSystemMessage(`sidechain for ${marker}`, 'info')],
      'restore-probe-sidechain',
    )
    await recordTranscript([
      createSystemMessage(`diagnostic after ${marker}`, 'info'),
    ])
  }
  // Writes are queued on a flush timer; force them to disk before exit (the
  // graceful-shutdown flush we bypass with process.exit would otherwise do it).
  await flushSessionStorage()

  const path = getTranscriptPathForSession(sessionId)
  process.stdout.write(`MINTED_TRANSCRIPT_PATH=${path}\n`)
  if (realisticTail) {
    process.stdout.write('MINTED_TRANSCRIPT_SHAPE=realistic-tail\n')
    process.stdout.write(
      `MINTED_SIDECHAIN_PATH=${getAgentTranscriptPath(asAgentId('restore-probe-sidechain'))}\n`,
    )
  }
  process.exit(0)
}

void main().catch(error => {
  process.stderr.write(
    `mint failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  )
  process.exit(1)
})
