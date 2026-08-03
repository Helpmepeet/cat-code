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
  createCompactBoundaryMessage,
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
  const compacted = process.argv.includes('--compacted')
  const unresolvedToolTail = process.argv.includes('--unresolved-tool-tail')
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
  if (compacted) {
    user.timestamp = '2026-07-31T17:59:00.000Z'
    assistant.timestamp = '2026-07-31T17:59:01.000Z'
    const boundary = createCompactBoundaryMessage('manual', 316_672)
    boundary.timestamp = '2026-07-31T18:00:16.000Z'
    const summary = createUserMessage({
      content: 'compacted model seed summary',
      isCompactSummary: true,
    })
    summary.timestamp = '2026-07-31T18:00:17.000Z'
    const command = createUserMessage({
      content: '<command-name>/compact</command-name>',
    })
    command.timestamp = '2026-07-31T18:00:18.000Z'
    const compactedMessages = [
      user,
      assistant,
      boundary,
      summary,
      command,
    ]
    if (unresolvedToolTail) {
      compactedMessages.push(
        createAssistantMessage({
          content: [
            {
              type: 'tool_use',
              id: `unresolved-${marker}`,
              name: 'Read',
              input: { file_path: `/tmp/${marker}` },
            },
          ],
        }),
      )
    }
    await recordTranscript(compactedMessages)
  } else {
    await recordTranscript([user, assistant])
  }
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
  if (compacted) {
    process.stdout.write('MINTED_TRANSCRIPT_SHAPE=compacted\n')
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
