import { mock } from 'bun:test'
import { execFileSync } from 'node:child_process'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ToolUseContext } from '../Tool.js'

const root = process.env.WORKTREE_INSTRUCTIONS_TEST_ROOT!
const cwdPhase = process.env.WORKTREE_CWD_PHASE
const borrow = cwdPhase?.startsWith('borrow')
const sibling = join(root, 'sibling')
if (!root || process.env.HOME !== root || process.cwd() !== join(root, 'workspace')) {
  throw new Error('Isolated fixture required')
}
;(globalThis as unknown as { MACRO: unknown }).MACRO = { VERSION: 'worktree-instructions-test' }
globalThis.fetch = (() => { throw new Error('Network forbidden') }) as unknown as typeof fetch
type RequestEvidence = { modelRound: number; prefix: string; cwd: string }
const models: RequestEvidence[] = []
const reviews: RequestEvidence[] = []
const failures: string[] = []
const approvals: string[] = []
const gitApprovals: string[] = []
let workerRound = 0
let unmergedBeforeCommit = ''
let workerResumeRefusal = ''
mock.module('../services/api/client.js', () => ({
  CLIENT_REQUEST_ID_HEADER: 'x-client-request-id',
  resolveCodexOAuthTokensForLeaseOwner: async () => { throw new Error('OAuth forbidden') },
  getAnthropicClient: async () => ({ beta: { messages: { create: (body: Record<string, unknown>) => {
    const messages = body.messages as unknown[]
    if (!body.stream) {
      reviews.push({ modelRound: models.length, prefix: JSON.stringify(messages[0]), cwd: process.cwd() })
      const choice = body.tool_choice as { name: string }
      return Promise.resolve({ id: 'review', type: 'message', role: 'assistant', model: body.model,
        content: [{ type: 'tool_use', id: 'verdict', name: choice.name,
          input: { shouldBlock: false, thinking: 'Offline fixture admission', reason: 'Synthetic fixture' } }],
        stop_reason: 'tool_use', stop_sequence: null, usage: { input_tokens: 20, output_tokens: 10 } })
    }
    const worker = borrow && messages.some(message => {
      const row = message as { role?: string; content?: unknown }
      return row.role === 'user' && (typeof row.content === 'string' ? row.content.includes('Resolve fixture conflict') :
        Array.isArray(row.content) && row.content.some(block => block.type === 'text' && block.text.includes('Resolve fixture conflict')))
    })
    const round = worker ? ++workerRound : models.length + 1
    if ((cwdPhase === 'borrow' || cwdPhase === 'borrow-sandbox') && !worker && round === 4) {
      unmergedBeforeCommit = execFileSync('git', ['ls-files', '-u', '--', 'conflict.txt'], { cwd: sibling }).toString()
    }
    if (round > 6) throw new Error('Unexpected model request')
    if (!worker) models.push({ modelRound: round, prefix: JSON.stringify(messages.find(message => JSON.stringify(message).includes('# claudeMd'))), cwd: process.cwd() })
    const bash = (name: string) => ({ name: 'Bash', input: {
      command: `bash -c 'printf fixture > ${name}.txt'`, work_lifetime: 'finite', run_in_background: false,
    } })
    const write = (name: string) => ({ name: 'Write', input: { file_path: name + '.txt', content: 'fixture' } })
    const calls = worker ? round === 1 ? [{ name: 'Write', input: { file_path: 'conflict.txt', content: 'resolved by worker\n' } }] : []
      : borrow ? round === 1 ? [{ name: 'EnterWorktree', input: { path: sibling } }]
        : cwdPhase !== 'borrow' && cwdPhase !== 'borrow-sandbox' ? [] : round === 3 ? [{ name: 'Agent', input: { subagent_type: 'general-purpose', description: 'Resolve merge conflict', prompt: 'Resolve fixture conflict in conflict.txt. Do not stage it.' } }]
          : round === 4 || round === 5 ? [{ name: 'Bash', input: { command: round === 4 ? 'git add -- conflict.txt' : 'git commit -m resolved', work_lifetime: 'finite', run_in_background: false } }] : []
      : cwdPhase === 'enter'
      ? round === 1 ? [{ name: 'EnterWorktree', input: { name: 'instructions' } }]
        : round === 3 ? [bash('next-shell'), write('next-file')] : []
      : cwdPhase === 'reopen'
        ? round === 1 ? [{ name: 'ExitWorktree', input: { action: 'keep' } }]
          : round === 3 ? [bash('return-shell'), write('return-file')] : []
        : round === 1
          ? [{ name: 'EnterWorktree', input: { name: 'instructions' } }, bash('stale-first')]
          : round === 2 ? [bash('fresh-first')]
            : round === 3 ? [{ name: 'ExitWorktree', input: { action: 'keep' } }, bash('stale-second')]
              : round === 4 ? [bash('fresh-second')] : []
    const stream = Object.assign((async function* () {
      yield { type: 'message_start', message: { id: (worker ? 'worker-' : 'response-') + round, type: 'message', role: 'assistant', model: 'claude-sonnet-4-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 20, output_tokens: 10 } } }
      if (calls.length) for (const [index, call] of calls.entries()) {
        yield { type: 'content_block_start', index, content_block: { type: 'tool_use', id: `call-${round}-${index}`, name: call.name, input: {} } }
        yield { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(call.input) } }
        yield { type: 'content_block_stop', index }
      }
      else {
        yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }
        yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Finished synthetic transitions.' } }
        yield { type: 'content_block_stop', index: 0 }
      }
      yield { type: 'message_delta', delta: { stop_reason: calls.length ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 12 } }
      yield { type: 'message_stop' }
    })(), { controller: new AbortController() })
    return { withResponse: async () => ({ data: stream, request_id: `request-${round}`, response: new Response('') }) }
  } } } }),
}))
const { enableConfigs } = await import('../utils/config.js')
const { getDefaultAppState } = await import('../state/AppStateStore.js')
const { createFileStateCacheWithSizeLimit } = await import('../utils/fileStateCache.js')
const { createQueryEngineAppSession } = await import('./createQueryEngineAppSession.js')
const { EnterWorktreeTool } = await import('../tools/EnterWorktreeTool/EnterWorktreeTool.js')
const { ExitWorktreeTool } = await import('../tools/ExitWorktreeTool/ExitWorktreeTool.js')
const { BashTool } = await import('../tools/BashTool/BashTool.js')
const { FileWriteTool } = await import('../tools/FileWriteTool/FileWriteTool.js')
const { AgentTool } = await import('../tools/AgentTool/AgentTool.js')
const { GENERAL_PURPOSE_AGENT } = await import('../tools/AgentTool/built-in/generalPurposeAgent.js')
const { getOriginalCwd, getSessionId } = await import('../bootstrap/state.js')
const { createAssistantMessage } = await import('../utils/messages.js')
const { getCurrentWorktreeSession } = await import('../utils/worktree.js')
const { restoreWorktreeForResume } = await import('../utils/sessionRestore.js')
const storage = await import('../utils/sessionStorage.js')
const { SandboxManager } = await import('../utils/sandbox/sandbox-adapter.js')
enableConfigs()
if (cwdPhase === 'borrow-reopen' || cwdPhase === 'borrow-reopen-missing' || cwdPhase === 'borrow-sandbox-reopen') {
  const { loadConversationForResume } = await import('../utils/conversationRecovery.js')
  const transcript = await readFile(join(root, 'transcript-path'), 'utf8')
  const { updateHooksConfigSnapshot } = await import('../utils/hooks/hooksConfigSnapshot.js')
  updateHooksConfigSnapshot()
  try {
    const resumed = await loadConversationForResume(undefined, transcript)
    if (!resumed?.worktreeSession?.borrowed) throw new Error('Missing borrowed state on resume')
    await restoreWorktreeForResume(resumed.worktreeSession)
    if (cwdPhase === 'borrow-sandbox-reopen') await sandboxProbe('cold')
    else {
      const remove = { action: 'remove', discard_changes: true } as const
      try { await (ExitWorktreeTool.call as (input: typeof remove) => Promise<unknown>)(remove) }
      catch (error) { failures.push(String(error)) }
      await (ExitWorktreeTool.call as (input: { action: 'keep' }) => Promise<unknown>)({ action: 'keep' })
    }
  } catch (error) { failures.push(String(error)) }
  await writeFile(join(root, 'evidence.json'), JSON.stringify({ failures, cwd: process.cwd() }))
  process.exit(0)
}
if (cwdPhase === 'borrow-sandbox') await SandboxManager.initialize()

async function sandboxProbe(name: string): Promise<void> {
  if (!SandboxManager.isSandboxingEnabled()) throw new Error('Fixture sandbox is not active')
  if (process.cwd() !== sibling) throw new Error('Sandbox probe did not enter sibling')
  const command = await SandboxManager.wrapWithSandbox(
    'printf allowed > ' + name + '-allowed; printf denied > ../workspace/' + name + '-denied', '/bin/sh',
  )
  const result = Bun.spawnSync(['/bin/sh', '-c', command], { cwd: sibling, stdout: 'pipe', stderr: 'pipe' })
  if (result.exitCode === 0 || !(await Bun.file(join(sibling, name + '-allowed')).exists())) {
    throw new Error('Unexpected sandbox result: ' + result.stderr.toString())
  }
}
if (cwdPhase === 'reopen') {
  await restoreWorktreeForResume(JSON.parse(await readFile(join(root, 'checkout.json'), 'utf8')))
}
let state = getDefaultAppState()
state = { ...state, toolPermissionContext: { ...state.toolPermissionContext, mode: 'auto', isAutoModeAvailable: true } }
const inlineFile = cwdPhase === 'reopen' ? 'return-inline.txt' : 'next-inline.txt'
const sourceMessage = createAssistantMessage({ content: '```bash\nprintf fixture > ' + inlineFile + '\n```' })
sourceMessage.message.stop_reason = 'end_turn'
const session = createQueryEngineAppSession({
  cwd: process.cwd(), getWorkspaceCwd: getOriginalCwd,
  ...(cwdPhase ? { initialMessages: [sourceMessage] } : {}),
  tools: [EnterWorktreeTool, ExitWorktreeTool, BashTool, FileWriteTool, ...(borrow ? [AgentTool] : [])], commands: [], mcpClients: [], agents: borrow ? [GENERAL_PURPOSE_AGENT] : [],
  getAppState: () => state, setAppState: update => { state = update(state) },
  readFileCache: createFileStateCacheWithSizeLimit(20), customSystemPrompt: 'Perform the synthetic transitions.',
  userSpecifiedModel: 'claude-sonnet-4-5',
  recordTranscript: borrow ? storage.recordTranscript : async () => null,
})
const prompts = borrow ? cwdPhase === 'borrow' || cwdPhase === 'borrow-sandbox' ? ['Enter the existing worktree.', 'Resolve and commit the merge.'] : ['Enter the existing worktree.']
  : cwdPhase ? ['Change checkout.', 'Write the two fixture files.'] : ['Enter the fixture worktree, return, and report.']
for (const [index, prompt] of prompts.entries()) {
  for await (const message of session.submitMessage(prompt, {
    onPermissionRequest: async ({ request, requestId }) => {
      if (borrow && request.tool_name === 'EnterWorktree') {
        approvals.push(request.decision_reason ?? '')
        if (cwdPhase === 'borrow-replaced') {
          await rename(sibling, sibling + '-moved')
          await mkdir(sibling)
        }
        if (cwdPhase !== 'borrow-denied') return { behavior: 'allow', updatedInput: request.input }
      } else if (cwdPhase === 'borrow-sandbox' && request.tool_name === 'Bash' && request.human_only && typeof request.input.command === 'string') {
        gitApprovals.push(request.input.command)
        return { behavior: 'allow', updatedInput: request.input }
      } else failures.push('Unexpected manual approval: ' + requestId + ' ' + request.tool_name)
      return { behavior: 'deny', message: 'Fixture denies fallback' }
    },
  })) {
    if (message.type === 'user' && Array.isArray(message.message.content)) {
      for (const block of message.message.content) if (block.type === 'tool_result' && block.is_error) failures.push(String(block.content))
    }
  }
  if (cwdPhase && !borrow && index === 0) {
    if (!session.executeInlineCommand) throw new Error('Missing inline command runtime')
    for await (const _message of session.executeInlineCommand({
      source: { engineSessionId: getSessionId(), messageUuid: sourceMessage.uuid, contentBlockIndex: 0, fenceOrdinal: 0 },
      runId: crypto.randomUUID(), signal: new AbortController().signal,
      onProgress: run => { if (run.status !== 'running' && run.exitCode !== 0) failures.push(run.output) },
    })) { /* drain the execution */ }
  }
}
if (cwdPhase === 'enter') {
  const checkout = getCurrentWorktreeSession()
  if (!checkout) throw new Error('Fixture did not enter its worktree')
  await writeFile(join(root, 'checkout.json'), JSON.stringify(checkout))
}
if (borrow && getCurrentWorktreeSession()?.borrowed) {
  await storage.flushCurrentTranscriptDurably()
  await writeFile(join(root, 'transcript-path'), storage.getTranscriptPath())
  if (cwdPhase === 'borrow-sandbox') await sandboxProbe('warm')
}
if (cwdPhase === 'borrow' && !failures.length) {
  await storage.flushSessionStorage()
  const [worker] = await storage.listAgentMetadataForSession(getSessionId())
  if (!worker || worker.metadata.assignedCwd !== sibling || worker.metadata.parentWorktreeIdentity?.checkout !== sibling) {
    throw new Error('Worker did not persist the inherited checkout')
  }
  await (ExitWorktreeTool.call as (input: { action: 'keep' }) => Promise<unknown>)({ action: 'keep' })
  const { resumeAgentBackground } = await import('../tools/AgentTool/resumeAgent.js')
  try {
    await resumeAgentBackground({
      agentId: worker.agentId, prompt: 'Attempt to resume after leaving the worktree.',
      toolUseContext: { getAppState: () => state } as unknown as ToolUseContext,
      canUseTool: async () => ({ behavior: 'deny', message: 'Fixture does not allow worker tools' }),
    })
  } catch (error) { workerResumeRefusal = String(error) }
}
await writeFile(join(root, 'evidence.json'), JSON.stringify({ models, reviews, failures, approvals, gitApprovals, workerRound, workerResumeRefusal, unmergedBeforeCommit, cwd: process.cwd() }))
session.dispose?.()
process.exit(0)
