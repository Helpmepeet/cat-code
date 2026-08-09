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

import { randomUUID } from 'node:crypto'
import { init } from '../../src/entrypoints/init.js'
import { switchSession } from '../../src/bootstrap/state.js'
import { asAgentId, asSessionId } from '../../src/types/ids.js'
import { enqueue } from '../../src/utils/messageQueueManager.js'
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
  writeAgentMetadata,
} from '../../src/utils/sessionStorage.js'

async function main(): Promise<void> {
  const sessionId = process.argv[2]
  const marker = process.argv[3] ?? 'p3-1-fixture-marker'
  const realisticTail = process.argv.includes('--realistic-tail')
  const compacted = process.argv.includes('--compacted')
  const unresolvedToolTail = process.argv.includes('--unresolved-tool-tail')
  const subagentBranch = process.argv.includes('--subagent-branch')
  const interruptedQueued = process.argv.includes('--interrupted-queued')
  if (!sessionId) {
    throw new Error('usage: mintTranscript.fixture.ts <sessionId> [marker]')
  }

  await init()
  // Adopt the target id so recordTranscript keys the file by it (it reads
  // getSessionId()); the transcript lands under the project dir derived from the
  // process cwd — exactly where the resuming sidecar (same cwd + config) looks.
  switchSession(asSessionId(sessionId))

  // The parent half of a subagent spawn: an Agent tool_use plus its result.
  // Recorded in the SAME `recordTranscript` call as the nonce pair — each call
  // starts a fresh parentUuid chain, and the display loader walks that chain
  // back from the leaf, so a separate call would leave these orphaned and
  // invisible to restore.
  const subagentId = asAgentId(`branch-agent-${marker}`)
  const subagentToolUseId = `branch-tu-${marker}`
  const subagentBranchMessages = !subagentBranch ? [] : [
    createAssistantMessage({
      content: [
        {
          type: 'tool_use',
          id: subagentToolUseId,
          name: 'Agent',
          input: { description: `delegate ${marker}`, subagent_type: 'Explore' },
        },
      ],
    }),
    createUserMessage({
      content: [
        {
          type: 'tool_result',
          tool_use_id: subagentToolUseId,
          content: `delegate ${marker} finished`,
        },
      ],
    }),
  ]

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
    // Branch BEFORE the nonce pair: the display projection keeps the prefix
    // ahead of the resumable seed anchor and replaces everything from the
    // anchor onward with the seed itself (`mergeDisplayHistoryWithSeed`), so a
    // branch recorded after the anchor is dropped before restore ever sees it.
    await recordTranscript(
      [...subagentBranchMessages, user, assistant],
    )
  }
  if (subagentBranch) {
    // The worker's own turns go to its OWN sidechain file, and the meta sidecar
    // carries the join key back to the parent's Agent tool_use
    // (`src/tools/AgentTool/runAgent.ts:818`). Both through production
    // persistence, so the probe exercises the real three-artifact shape.
    await recordSidechainTranscript(
      [createAssistantMessage({ content: `subagent turn for ${marker}` })],
      subagentId,
    )
    await writeAgentMetadata(subagentId, {
      agentType: 'Explore',
      agentName: `Ada-${marker}`,
      description: `delegate ${marker}`,
      parentSessionId: sessionId,
      parentToolUseId: subagentToolUseId,
      spawnedAt: new Date().toISOString(),
    })
    process.stdout.write(`MINTED_SUBAGENT_TOOL_USE_ID=${subagentToolUseId}\n`)
    process.stdout.write(`MINTED_SUBAGENT_NAME=Ada-${marker}\n`)
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
  if (interruptedQueued) {
    const interruptedToolUseId = `interrupted-${marker}`
    await recordTranscript([
      createAssistantMessage({
        content: [
          {
            type: 'tool_use',
            id: interruptedToolUseId,
            name: 'Read',
            input: { file_path: `/tmp/${marker}` },
          },
        ],
      }),
      createUserMessage({
        content: [
          {
            type: 'tool_result',
            tool_use_id: interruptedToolUseId,
            content: `partial result ${marker}`,
          },
        ],
      }),
    ])
    const queuedUuid = randomUUID()
    enqueue({
      value: `queued input ${marker}`,
      mode: 'prompt',
      uuid: queuedUuid,
    })
    await Bun.sleep(0)
    process.stdout.write(`MINTED_QUEUED_UUID=${queuedUuid}\n`)
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
