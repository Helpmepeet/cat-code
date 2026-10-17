// Runs only in a fresh process with a caller-owned isolated config and cwd.
import { spyOn } from 'bun:test'
import { randomUUID } from 'node:crypto'

await (await import('./workerRuntime.js')).bootstrapWorkerEngine()
const { initializeSidecarRuntime } = await import('./initializeRuntime.js')
await initializeSidecarRuntime()
const mode = process.argv[2]
if (mode === 'mint') {
  const { switchSession } = await import('../../src/bootstrap/state.js')
  const { asSessionId, asAgentId } = await import('../../src/types/ids.js')
  const { createUserMessage, createAssistantMessage } = await import('../../src/utils/messages.js')
  const storage = await import('../../src/utils/sessionStorage.js')
  switchSession(asSessionId(process.argv[3]!))
  const toolUseId = 'baseline-agent-tool'
  const messages = [createAssistantMessage({ content: [{ type: 'tool_use', id: toolUseId, name: 'Agent', input: { description: 'fixture', subagent_type: 'Explore' } }] }),
    createUserMessage({ content: [{ type: 'tool_result', tool_use_id: toolUseId, content: 'fixture complete' }] })]
  for (let i = 0; i < 200; i++) messages.push(createUserMessage({ content: `fixture ${i} ${'x'.repeat(1024)}` }), createAssistantMessage({ content: 'fixture complete' }))
  await storage.recordTranscript(messages)
  const agentId = asAgentId('baseline-agent')
  await storage.recordSidechainTranscript(Array.from({ length: 100 }, () => createAssistantMessage({ content: 'fixture worker result' })), agentId)
  await storage.writeAgentMetadata(agentId, { agentType: 'Explore', parentSessionId: process.argv[3]!, parentToolUseId: toolUseId, spawnedAt: new Date().toISOString() })
  await storage.flushSessionStorage()
  process.stdout.write(JSON.stringify({ pairs: 200, subagentMessages: 100 }) + '\n')
} else {
  const status = await import('../../src/utils/status.js')
  const delay = Number(process.argv[3])
  spyOn(status, 'buildInstallationDiagnostics').mockImplementation(() => delay < 0 ? new Promise(() => {}) : new Promise(resolve => setTimeout(() => resolve([]), delay)))
  const { createSidecarSessionController } = await import('./sessionController.js')
  const started = performance.now()
  const session = await createSidecarSessionController({ probe: false, cwd: process.cwd(), appSessionId: randomUUID(), generation: randomUUID(),
    timing: input => process.stdout.write(JSON.stringify(input) + '\n') })
  process.stdout.write(JSON.stringify({ controllerCompletedMs: performance.now() - started }) + '\n')
  await session.disposeMcpLifecycle?.()
}
const { releaseActiveTranscriptLease } = await import('../../src/utils/transcriptLease.js')
await releaseActiveTranscriptLease()
process.exit(0)
