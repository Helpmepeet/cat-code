import type { UUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createAssistantMessage, createUserMessage, normalizeMessagesForAPI } from '../utils/messages.js'
import { collectPermissionDecisionContexts } from '../utils/permissions/permissionDecisionContext.js'
import { loadConversationForResume } from '../utils/conversationRecovery.js'
import * as storage from '../utils/sessionStorage.js'
import { getSessionId } from '../bootstrap/state.js'

/** Called only by the isolated resume fixture, with networking already forbidden. */
export async function runCodeModeHistoryFixture(root: string) {
  const prompt = createUserMessage({ content: 'Start a background script.' })
  const outer = createAssistantMessage({ content: [{ type: 'tool_use', id: 'background-cell', name: 'REPL', input: { code: 'await tools.call({name:"Bash",input:{command:"refused"}})', description: 'Fixture' } }] })
  const receipt = createUserMessage({ sourceToolAssistantUUID: outer.uuid as UUID, content: [{ type: 'tool_result', tool_use_id: 'background-cell', content: 'Background script accepted' }] })
  const ordinaryPrompt = createUserMessage({ content: 'Meanwhile, read an ordinary file.' })
  const ordinaryCall = createAssistantMessage({ content: [{ type: 'tool_use', id: 'ordinary-read', name: 'Read', input: { file_path: 'ordinary-file' } }] })
  const prefix = [prompt, outer, receipt, ordinaryPrompt, ordinaryCall]
  function audit(branch: string) {
    const codeMode = { cellId: 'background-cell', generation: `generation-${branch}` }
    const call = createAssistantMessage({ codeMode, content: [{ type: 'tool_use', id: `refusal-${branch}`, name: 'Bash', input: { command: `hidden-command-${branch}` } }] })
    const result = createUserMessage({ codeMode, sourceToolAssistantUUID: call.uuid as UUID,
      permissionDecision: { version: 1, toolUseId: `refusal-${branch}`, assistantUuid: call.uuid, toolName: 'Bash', input: { command: `hidden-command-${branch}` }, outcome: 'rejected-by-user' },
      content: [{ type: 'tool_result', tool_use_id: `refusal-${branch}`, is_error: true, content: `hidden-payload-${branch}` }] })
    return [call, result]
  }
  const selectedAudit = audit('selected')
  const ordinaryResult = createUserMessage({ sourceToolAssistantUUID: ordinaryCall.uuid as UUID, content: [{ type: 'tool_result', tool_use_id: 'ordinary-read', content: 'ordinary visible result' }] })
  const completion = createUserMessage({ sourceToolAssistantUUID: outer.uuid as UUID, content: [{ type: 'tool_result', tool_use_id: 'background-cell', content: 'selected background output' }] })
  const final = createAssistantMessage({ content: 'Selected branch finished.' })
  const selected = [...prefix, ...selectedAudit, ordinaryResult, completion, final]
  // Real writer calls across incremental boundaries, including both a normal
  // tool result and a late outer result pointing to older logical owners.
  for (let length = 1; length <= selected.length; length++) await storage.recordTranscript(selected.slice(0, length))
  const abandonedAudit = audit('abandoned')
  const abandonedFinal = createAssistantMessage({ content: 'Abandoned branch finished.' })
  await storage.recordTranscript([...prefix, ...abandonedAudit, abandonedFinal])
  await storage.markActiveConversationTip(final.uuid as UUID)
  await storage.flushSessionStorage()
  const sourcePath = storage.getTranscriptPathForSession(getSessionId())
  async function load() {
    const loaded = await loadConversationForResume(undefined, sourcePath, { interruptedTurn: 'defer', mutable: false })
    if (!loaded) throw new Error('Real history fixture failed to resume')
    return loaded.messages
  }
  const restored = await load()
  const decisions = collectPermissionDecisionContexts(restored)
  const normalized = Object.fromEntries(['firstParty', 'openai'].map(provider => [provider,
    normalizeMessagesForAPI(restored, [], provider as 'firstParty' | 'openai')]))
  // Rewind before both audit branches: neither may be recovered merely because
  // its cell owner is still an ancestor of the selected tip.
  await storage.markActiveConversationTip(ordinaryCall.uuid as UUID)
  await storage.flushSessionStorage()
  const rewound = await load()
  await storage.markActiveConversationTip(final.uuid as UUID)
  await storage.flushSessionStorage()
  await (await import('../utils/transcriptLease.js')).releaseActiveTranscriptLease()
  await writeFile(join(root, 'history-evidence.json'), JSON.stringify({ sourcePath, sessionId: getSessionId(), restored, decisions, normalized, rewound,
    selectedAuditIds: selectedAudit.map(message => message.uuid), abandonedAuditIds: abandonedAudit.map(message => message.uuid),
    ordinaryCallUuid: ordinaryCall.uuid, ordinaryResultUuid: ordinaryResult.uuid, completionUuid: completion.uuid, outerUuid: outer.uuid }))
}
