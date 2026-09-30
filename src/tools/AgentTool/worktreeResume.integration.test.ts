import { afterAll, expect, mock, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const root = mkdtempSync(join(tmpdir(), 'worker-isolation-'))
const previousConfigDir = process.env.CLAUDE_CONFIG_DIR
const previousPersistence = process.env.TEST_ENABLE_SESSION_PERSISTENCE
process.env.CLAUDE_CONFIG_DIR = join(root, 'config')
process.env.TEST_ENABLE_SESSION_PERSISTENCE = '1'
let queryDeps: any
const realDeps = await import('../../query/deps.js')
mock.module('../../query/deps.js', () => ({
  ...realDeps, productionDeps: () => queryDeps ?? realDeps.productionDeps(),
}))
const { resetStateForTests, switchSession, setCwdState } = await import('../../bootstrap/state.js')
const { asSessionId, asAgentId } = await import('../../types/ids.js')
const { getEmptyToolPermissionContext } = await import('../../Tool.js')
const { createAssistantMessage, createUserMessage } = await import('../../utils/messages.js')
const { releaseActiveTranscriptLease } = await import('../../utils/transcriptLease.js')
const { getCwd } = await import('../../utils/cwd.js')
const { readAgentMetadata, getAgentTranscriptPath, recordTranscript, resetProjectForTesting, flushSessionStorage } = await import('../../utils/sessionStorage.js')
const { AgentTool } = await import('./AgentTool.js')
const { resumeAgentBackground } = await import('./resumeAgent.js')
const { getDefaultAppState } = await import('../../state/AppStateStore.js')
const { isAgentLifecycleOwned } = await import('./agentLifecycleOwnership.js')
const { _clearOutputsForTest, _resetTaskOutputDirForTest } = await import('../../utils/task/diskOutput.js')
const { resetCommandQueue } = await import('../../utils/messageQueueManager.js')

async function git(cwd: string, ...args: string[]) {
  const child = Bun.spawn(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' })
  const stderr = await new Response(child.stderr).text()
  expect(await child.exited, stderr).toBe(0)
}

afterAll(async () => {
  mock.restore()
  await flushSessionStorage()
  await releaseActiveTranscriptLease()
  resetProjectForTesting()
  await _clearOutputsForTest()
  _resetTaskOutputDirForTest()
  resetCommandQueue()
  resetStateForTests()
  await rm(root, { recursive: true, force: true })
  if (previousConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = previousConfigDir
  if (previousPersistence === undefined) delete process.env.TEST_ENABLE_SESSION_PERSISTENCE
  else process.env.TEST_ENABLE_SESSION_PERSISTENCE = previousPersistence
})

// Real launch/query, worktree cleanup, metadata, and resume. Only model I/O is scripted.
test.each(['clean', 'dirty', 'ordinary'])(
  '%s blocked worker preserves isolation across cleanup and resume', async mode => {
    _resetTaskOutputDirForTest()
    const repo = join(root, mode)
    await git(root, 'init', repo)
    await writeFile(join(repo, 'file.txt'), 'base\n')
    await git(repo, 'add', 'file.txt')
    await git(repo, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'base')
    resetStateForTests()
    switchSession(asSessionId(crypto.randomUUID()), repo)
    setCwdState(repo)
    resetProjectForTesting()
    await recordTranscript([createUserMessage({ content: 'fixture parent' })])
    await flushSessionStorage()
    const agent = {
      agentType: 'isolation-fixture', source: 'built-in', baseDir: 'built-in',
      whenToUse: 'fixture', tools: [], getSystemPrompt: () => 'fixture',
    }
    let state: any = {
      ...getDefaultAppState(), toolPermissionContext: getEmptyToolPermissionContext(),
      agentDefinitions: { activeAgents: [agent], allAgents: [agent] },
    }
    const setAppState = (update: any) => { state = update(state) }
    const context: any = {
      options: {
        commands: [], debug: false, verbose: false,
        mainLoopModel: 'claude-sonnet-4-6', mainLoopProvider: 'anthropic',
        tools: [], thinkingConfig: { type: 'disabled' }, mcpClients: [], mcpResources: {},
        isNonInteractiveSession: true, agentDefinitions: state.agentDefinitions,
      },
      abortController: new AbortController(), readFileState: new Map(), messages: [],
      getAppState: () => state, setAppState, setAppStateForTasks: setAppState,
      setInProgressToolUseIDs() {}, setResponseLength() {},
      updateFileHistoryState() {}, updateAttributionState() {}, toolUseId: `launch-${mode}`,
    }
    const directories: string[] = []
    queryDeps = {
      uuid: () => crypto.randomUUID(),
      microcompact: async (messages: any) => ({ messages }),
      autocompact: async () => ({ wasCompacted: false, consecutiveFailures: 0 }),
      callModel: async function* () {
        directories.push(getCwd())
        if (mode === 'dirty') await writeFile(join(getCwd(), 'file.txt'), 'worker changes\n')
        yield createAssistantMessage({ content: 'Summary.\nstatus: blocked\nOpen questions / blockers:\n- Need a decision.' })
      },
    }
    const result = await AgentTool.call({
      subagent_type: agent.agentType, prompt: 'fixture', description: 'Fixture',
      ...(mode !== 'ordinary' ? { isolation: 'worktree' as const } : {}),
    }, context, (async (_tool: unknown, input: unknown) => ({ behavior: 'allow', updatedInput: input })) as never, undefined as never)
    const agentId = (result.data as any).agentId
    expect(JSON.stringify(result)).toContain('status: blocked')
    await flushSessionStorage()
    // Wait for runAgent's fire-and-forget metadata write before reading it.
    await new Promise(resolve => setTimeout(resolve, 20))
    const metadata = await readAgentMetadata(asAgentId(agentId))
    const launchedCwd = directories[0]!
    expect(launchedCwd === repo).toBe(mode === 'ordinary')
    // Transcript cwd stamps also survive; resume uses explicit metadata, not
    // these historical execution stamps, to restore isolation.
    const rows = (await readFile(getAgentTranscriptPath(asAgentId(agentId)), 'utf8'))
      .trim().split('\n').map(line => JSON.parse(line))
    expect(rows.some(row => row.type === 'assistant' && row.cwd === launchedCwd)).toBe(true)
    if (mode === 'dirty') expect(metadata?.worktreePath).toBe(launchedCwd)
    context.toolUseId = `resume-${mode}`
    const resume = () => resumeAgentBackground({ agentId, prompt: 'continue', toolUseContext: context, canUseTool: (async (_tool: unknown, input: unknown) => ({ behavior: 'allow', updatedInput: input })) as never })
    if (mode === 'clean') {
      expect(await stat(launchedCwd).catch(() => null)).toBeNull()
      await expect(resume()).rejects.toThrow('no longer exists')
      expect(metadata?.worktreePath).toBe(launchedCwd)
      expect(directories).toEqual([launchedCwd])
    } else {
      if (mode === 'dirty') expect(await readFile(join(launchedCwd, 'file.txt'), 'utf8')).toBe('worker changes\n')
      await resume()
      for (let i = 0; i < 200 && isAgentLifecycleOwned(agentId); i++) await new Promise(resolve => setTimeout(resolve, 5))
      expect(isAgentLifecycleOwned(agentId)).toBe(false)
      expect(directories).toEqual([launchedCwd, launchedCwd])
      if (mode === 'dirty') expect(await readFile(join(launchedCwd, 'file.txt'), 'utf8')).toBe('worker changes\n')
    }
  }, 20_000,
)
