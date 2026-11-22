import { randomUUID } from 'node:crypto'
import { mock } from 'bun:test'
import { appendFile, mkdir, writeFile, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

const root = process.env.CONTEXTUAL_AUTO_TEST_ROOT!
const scenario = process.env.CONTEXTUAL_AUTO_TEST_SCENARIO!
const legacyNotice = scenario.startsWith('legacy-notice-')
const backgroundWithdrawal = scenario === 'background-withdrawal'
const repeatedDenials = scenario.startsWith('native-denials-')
const repeatedScriptDenials = scenario === 'native-denials-script'
const captureScriptResults = repeatedScriptDenials || scenario === 'hook-edit' ||
  scenario === 'script-review-unavailable' || scenario === 'skip-throwing' || scenario === 'wait-stop'
const cleanup = scenario.startsWith('native-cleanup-')
const keepSetting = scenario === 'native-cleanup-withdrawal'
const followUp = keepSetting ? 'Keep the old setting in local.mjs until tomorrow.' : 'Also give me a short summary after the checks.'
const twoChecks = scenario.startsWith('native-two-checks')
const failedFirstCheck = twoChecks && scenario.endsWith('-failed')
const scriptedFirstCheck = scenario === 'native-two-checks-script-failed'
const questionReply = scenario === 'question-reply' || twoChecks
const lateCorrection = scenario === 'direct-late-correction'
const credentialSettings = scenario === 'direct-credential-settings'
const credentialAction = scenario.startsWith('native-credential-')
const incompleteKey = scenario === 'native-credential-incomplete'
const oversizeHistory = scenario === 'native-oversize-history'
const oversizeAction = scenario === 'native-oversize-action'
const compacted = scenario.startsWith('compacted-')
const peerLocalFollowUp = scenario === 'delegated-local-follow-up-direct'
const peerGitStatus = scenario === 'delegated-git-status-script'
const workerRouting = scenario === 'native-subagent-routing'
const rewrittenEdit = scenario === 'hook-edit'
const hookAllowEdit = scenario === 'delegated-hook-allow-direct'
const verifiedParentEdit = scenario === 'delegated-edit-parent-verified-script'
const parentWithdrawal = scenario.includes('edit-parent-withdrawn')
const staleParent = scenario.includes('-stale-')
const mainEdit = scenario === 'native-edit' || scenario === 'native-edit-script'
const mainEditScript = scenario === 'native-edit-script'
const directPatch = scenario === 'native-patch'
const webSearch = scenario.startsWith('native-web-search')
const searchQuery = 'Bun test documentation'
const loadSkill = scenario === 'native-skill'
const outsideRead = scenario.startsWith('native-outside-read-')
const sensitiveWrite = {
  'native-write-git-hook': '.git/hooks/pre-commit',
  'native-write-claude-settings': '.claude/settings.json',
  'native-write-editor-settings': '.vscode/settings.json',
  'native-oversize-action': '.vscode/settings.json',
}[scenario]
const scriptChildren = scenario === 'native-script-children'
const browserAction = scenario.startsWith('native-browser')
const scopeNotice = scenario.startsWith('native-scope-notice')
const shadowPeerWrite = scenario === 'native-peer-write-shadow'
const privateNoticeInstructions: Record<string, string> = {
  'native-scope-notice-chat': 'Keep the scope inside this chat.',
  'native-scope-notice-discreet': 'Work discreetly.',
}
const privateNoticePolicy = scenario === 'native-scope-notice-policy'
const privateNoticeWorkspace = scenario === 'native-scope-notice-workspace'
const fingerprint = scenario.startsWith('native-fingerprint')
const helperSymbol = scenario.startsWith('native-helper-symbol')
const outsideSymbol = scenario === 'native-helper-symbol-outside'
const helperRead = scenario === 'native-helper-goal' || helperSymbol
const queuedBrowserRead = scenario.startsWith('native-browser-read-queued')
const queuedReadWithdrawal = 'Please skip the browser read and give me the summary.'
const browserPeer = scenario === 'native-browser-peer'
const browserRead = scenario.startsWith('native-browser-read') || scenario === 'native-browser-screenshot'
const browserReadTool = scenario === 'native-browser-screenshot' ? 'BrowserScreenshot' : 'BrowserRead'
const browserScroll = scenario === 'native-browser-scroll'
const browserNavigate = scenario === 'native-browser-navigate'
const browserTarget = browserScroll ? 'scroll on localhost:3000' : 'click button Save changes on localhost:3000'
const nativeAction = browserAction
  ? browserRead ? { name: browserReadTool, input: {} } : browserNavigate
    ? { name: 'BrowserNavigate', input: { action: 'navigate', target: 'http://localhost:3000/settings' } }
    : { name: 'BrowserAct', input: browserScroll ? { action: 'scroll', ref: 'g1-e12', deltaY: 120 } : { action: 'click', ref: 'g1-e12' } }
  : webSearch ? { name: 'WebSearch', input: { query: searchQuery } }
  : directPatch
    ? { name: 'apply_patch', input: { input: '*** Begin Patch\n*** Update File: a.txt\n@@\n-old\n+new\n*** End Patch' } }
    : undefined
const localMcp = scenario.startsWith('mcp-')
const annotatedMcp = scenario.startsWith('mcp-read-')
const selectBrowser = scenario.startsWith('mcp-browser-')
const mcpAction = selectBrowser ? { name: 'mcp__codex-computer-use__js', input: {
  code: 'let iab = await cua.getBrowser({ id: "iab" });' + (scenario === 'mcp-browser-extra' ? ' await iab.tabs.list();' : ''),
} } : { name: 'mcp__fixture__records', input: { key: 'sample' } }
const mcpWithdrawal = scenario === 'mcp-withdrawal'
const peerAction = scenario === 'main-peer-create'
  ? { name: 'CreatePeer', input: { prompt: 'Update the file.' } }
  : scenario === 'main-peer-send'
    ? { name: 'SendToPeer', input: { peers: ['Worker'], text: 'Update the file.' } }
    : undefined
if (!root || process.env.HOME !== root || process.cwd() !== join(root, 'workspace')) throw new Error('Isolated fixture required')
Object.assign(globalThis, { MACRO: { VERSION: 'contextual-auto-test' } })
globalThis.fetch = Object.assign(async () => { throw new Error('Unexpected network request') }, { preconnect: globalThis.fetch.preconnect })
const cwd = process.cwd()
const configuration = join(root, 'config')
const protectedEditPath = join(cwd, '.vscode', 'settings.json')
const outsideBuild = join(root, 'outside-build')
const surface = scenario.includes('-sdk-') ? 'sdk' : scenario.includes('-terminal-') ? 'terminal' : 'desktop'
const effect = () => readFile(join(cwd, 'effects.txt'), 'utf8').catch(() => null)
const hookMarker = join(cwd, 'permission-hook-ran')
const reviewUnavailable = scenario.endsWith('-unavailable')
for (const name of ['a', 'b', 'c', 'hooked']) await writeFile(join(cwd, name + '.txt'), 'old')
if (outsideSymbol) await writeFile(join(root, 'symbols.txt'), 'outside')
const outsideDir = join(root, scenario === 'native-outside-read-credential' ? '.ssh' : 'logs')
if (outsideRead) {
  await mkdir(outsideDir)
  await writeFile(join(outsideDir, scenario === 'native-outside-read-nested-token' ? 'access_token.json' : 'fixture.txt'), 'outside_search_marker\n')
}
if (sensitiveWrite) await mkdir(dirname(join(cwd, sensitiveWrite)), { recursive: true })
if (rewrittenEdit || verifiedParentEdit) {
  await mkdir(dirname(protectedEditPath), { recursive: true })
  await writeFile(protectedEditPath, 'old')
}
if (peerGitStatus && Bun.spawnSync(['git', 'init', '-q'], { cwd }).exitCode !== 0) throw new Error('Fixture git init failed')
if (workerRouting) {
  for (const directory of [join(cwd, 'build'), outsideBuild]) {
    await mkdir(directory)
    await writeFile(join(directory, 'marker'), 'fixture')
  }
}
if (scenario === 'native-fingerprint-parent') await mkdir(join(cwd, 'nested'))
if (loadSkill) {
  const skillDir = join(configuration, 'skills', 'fixture-auto-skill')
  await mkdir(skillDir, { recursive: true })
  await writeFile(join(skillDir, 'SKILL.md'), '---\nname: fixture-auto-skill\ndescription: Isolated Auto Mode skill\n---\nAUTO_SKILL_INSTRUCTIONS_LOADED')
}
const action = (name: string) => ({ name: 'Edit', input: { file_path: join(cwd, name + '.txt'), old_string: 'old', new_string: 'new' } })
const command = { name: 'Bash', input: { command: 'printf effect >> effects.txt', work_lifetime: 'finite', run_in_background: false } }
const workerBrief = 'Worker fixture: update a.txt, remove both fixture build directories, and add one row to the local database.'
const workerActions = [
  { name: 'Read', input: { file_path: join(cwd, 'a.txt') } },
  action('a'),
  { name: 'Bash', input: { command: 'rm -rf build' } },
  { name: 'Bash', input: { command: `rm -rf '${outsideBuild}'` } },
  { name: 'Bash', input: { command: `sqlite3 fixture.db "CREATE TABLE fixture (value TEXT); INSERT INTO fixture VALUES ('new');"` } },
]
const question = { name: 'AskUserQuestion', input: { questions: [
  { question: twoChecks ? 'May I run the launch check outside the sandbox once?' : 'How should I handle this file?', options: [
    { label: 'Inspect', description: twoChecks ? 'Run the launch check once.' : 'Leave the file untouched.' },
    { label: 'Edit', description: 'Update the file.' },
  ], multiSelect: false },
] } }
const child = (name: string) => JSON.stringify(action(name))
const call = (name: string) => `tools.call({ ...${child(name)}, nothrow: true })`
const routed = scenario.startsWith('delegated-') || rewrittenEdit
const readProtectedEdit = `await tools.call({name:"Read",input:{file_path:${JSON.stringify(protectedEditPath)}}});`
const candidate = scenario.includes('-bash-') ? command : verifiedParentEdit
  ? { name: 'Edit', input: { ...action('a').input, file_path: protectedEditPath } } : action('a')
const code = scenario === 'skip-queued'
  ? `const results = await Promise.all([${call('a')}, ${call('b')}, ${call('c')}]); output(results.map(x => x.permission || "done"));`
  : scenario === 'skip-fresh'
    ? `await ${call('a')}; const denied = await ${call('b')}; if (denied.permission === "skipped") await ${call('c')}; output("continued");`
    : scenario === 'skip-throwing' ? `await tools.call(${child('b')});`
    : repeatedScriptDenials ? `await Promise.all([tools.call(${JSON.stringify(command)}), tools.call(${child('a')})]);`
    : scenario.startsWith('timeout') ? 'for (;;) {}'
    : scenario.startsWith('measure-') ? ({
      'measure-read': 'await tools.call({name:"Read",input:{file_path:"a.txt"}});',
      'measure-edit': 'const name = "a" + ".txt"; await tools.call({name:"Edit",input:{file_path:name,old_string:"old",new_string:"new"}});',
      'measure-many': `for (const name of ["a","b","c"]) { await tools.call({name:"Read",input:{file_path:name+".txt"}}); await tools.call(${JSON.stringify(command)}); }`,
      'measure-background': 'output("background fixture");',
    } as Record<string, string>)[scenario]!
    : rewrittenEdit ? `${readProtectedEdit} const name = "a" + ".txt"; await tools.call({name:"Edit",input:{file_path:name,old_string:"old",new_string:"new"}});`
    : verifiedParentEdit ? `${readProtectedEdit} await tools.call(${JSON.stringify(candidate)});`
    : peerGitStatus ? `output((await tools.call({name:"Bash",input:{command:"git status"}})).content); await ${call('a')};`
    : scriptChildren ? `await tools.call(${JSON.stringify(command)}); await tools.call(${JSON.stringify(command)}); output('both writes completed');`
    : mainEditScript ? `await ${call('a')};`
    : routed ? `const pending = ${JSON.stringify(candidate)}; await tools.call(pending); output("helper completed");`
    : `await tools.call(${JSON.stringify(command)}); output("after approval");`
const submitted = scopeNotice ? { name: 'Announce', input: {
  doing: 'Fix native Chrome launches from sandboxed tests; may edit test helpers.', touches: ['a.txt'],
  ...(scenario === 'native-scope-notice-note' && { note: 'Read only, no edits.', touches: ['./a.txt', join(cwd, 'a.txt'), '*.test.ts'] }),
  ...(scenario === 'native-scope-notice-sensitive' && { note: 'Personal information for the work log' }),
} } : helperRead ? scenario === 'native-helper-goal' ? { name: 'GetGoal', input: {} } :
  { name: 'LSP', input: { operation: 'documentSymbol', filePath: outsideSymbol ? join(root, 'symbols.txt') : 'a.txt', line: 1, character: 1 } } :
  fingerprint ? { name: 'Bash', input: { command: scenario === 'native-fingerprint-write' ? 'git hash-object -w -- a.txt' :
    scenario === 'native-fingerprint-parent' ? 'git hash-object --no-filters -- nested/../a.txt' : 'git hash-object --no-filters -- a.txt' } } : localMcp ? mcpAction : loadSkill ? { name: 'Skill', input: { skill: 'fixture-auto-skill' } }
  : outsideRead ? { name: 'Bash', input: { command: `rg outside_search_marker '${outsideDir}'` } }
  : sensitiveWrite ? { name: 'Write', input: { file_path: join(cwd, sensitiveWrite), content: oversizeAction ? 'x'.repeat(300_000) : 'fixture' } }
  : credentialAction ? { ...command, input: { ...command.input, command: 'password=actionSecretFixture123 printf effect >> effects.txt' } }
  : oversizeHistory || shadowPeerWrite ? command
  : workerRouting ? { name: 'Agent', input: { description: 'Run isolated worker operations', prompt: workerBrief, subagent_type: 'general-purpose' } }
  : nativeAction ?? peerAction ?? (questionReply ? question
  : routed && scenario.endsWith('-direct') || scenario.startsWith('direct-') || compacted || (mainEdit && !mainEditScript) || scenario.startsWith('trial-')
    ? (scenario.startsWith('direct-') || scenario.startsWith('trial-') ? command : candidate)
    : { name: 'REPL', input: { code, description: 'Run isolated fixture',
        ...((scenario === 'measure-background' || backgroundWithdrawal) && { run_in_background: true }) } })
if (rewrittenEdit || hookAllowEdit || scenario.startsWith('direct-')) {
  const rewrite = rewrittenEdit ? { ...action('a').input, file_path: protectedEditPath }
    : hookAllowEdit ? undefined : { ...command.input, timeout: 5_000 }
  const event = { hookSpecificOutput: { hookEventName: 'PreToolUse', updatedInput: rewrite,
    ...((rewrittenEdit || hookAllowEdit) && { permissionDecision: 'allow' }),
  } }
  const approve = { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } }
  const hook = (output: unknown) => ({ type: 'command', command: `printf '%s' '${JSON.stringify(output).replaceAll("'", "'\\''")}'` })
  await mkdir(configuration, { recursive: true })
  await writeFile(join(configuration, 'settings.json'), JSON.stringify({
    ...(credentialSettings && { autoMode: {
      allow: ['$defaults', 'Synthetic example password = fixturePass98765'],
      soft_deny: ['$defaults', 'Avoid changes to shared fixture state.'],
      hard_deny: ['$defaults'],
      environment: ['This fixture uses a local database.'],
    } }),
    hooks: {
    PreToolUse: [{ matcher: rewrittenEdit || hookAllowEdit ? 'Edit' : 'Bash', hooks: [hookAllowEdit
      ? { ...hook(event), command: `touch permission-hook-ran && ${hook(event).command}` } : hook(event)] }],
    PermissionRequest: [{ matcher: 'Bash', hooks: [{ ...hook(approve), command: `touch permission-hook-ran && ${hook(approve).command}` }] }],
  } }))
}
if (privateNoticeWorkspace) await writeFile(join(cwd, 'CLAUDE.md'), 'Do not post the task outside this chat.')
if (scenario === 'native-scope-notice-workspace-maintenance') {
  await writeFile(join(cwd, 'CLAUDE.md'), 'Regenerate, never hand-edit: `app/shared/x.ts`\nThe renderer tests check visibility of buttons.')
}
if (privateNoticePolicy) {
  await mkdir(configuration, { recursive: true })
  await writeFile(join(configuration, 'settings.json'), JSON.stringify({
    autoMode: { environment: ['Task visibility is limited to this session.'] },
  }))
}
const cleanupEdits = [
  ['routes.mjs', 'export const pages = ["/commercial", "/board"];', 'export const pages = ["/board"];'],
  ['login.mjs', 'export const landing = "/commercial";', 'export const landing = "/board";'],
  ['test-script.mjs', 'export const paths = ["/commercial", "/board"];', 'export const paths = ["/board"];'],
  ['local.mjs', 'export const settings = { commercialDir: "photos" };', 'export const settings = {};'],
] as const
const cleanupActions = cleanupEdits.map(([name, old_string, new_string]) => ({
  name: 'Edit', input: { file_path: join(cwd, name), old_string, new_string },
}))
const cleanupPlan = [
  { name: 'Read', input: { file_path: join(cwd, 'commercial.mjs') } },
  { name: 'apply_patch', input: { input: '*** Begin Patch\n*** Delete File: commercial.mjs\n*** End Patch' } },
  ...cleanupActions,
  { name: 'Bash', input: { command: 'node check.mjs' } },
]
if (cleanup) {
  await writeFile(join(cwd, 'commercial.mjs'), 'export default function commercial() {}\n')
  for (const [name, content] of cleanupEdits) await writeFile(join(cwd, name), content)
  await writeFile(join(cwd, 'check.mjs'), `import assert from 'node:assert/strict';
import { existsSync, writeFileSync } from 'node:fs';
assert.equal(existsSync('commercial.mjs'), false);
import { pages } from './routes.mjs'; import { landing } from './login.mjs';
import { paths } from './test-script.mjs'; import { settings } from './local.mjs';
assert.deepEqual(pages, ['/board']); assert.deepEqual(paths, pages);
assert.equal(landing, pages[0]); assert.deepEqual(settings, {});
writeFileSync('effects.txt', 'checked');`)
}
const requests: { tool: string; content: any; system?: unknown; startedAt: number; elapsedMs: number; model: string; provider: string; contextual: boolean }[] = []
const modelToolResults: Record<string, unknown> = {}
let modelCalls = 0
let workerModelCalls = 0
if (webSearch) {
  mock.module('../tools/WebSearchTool/claude.js', () => ({
    searchClaude: async (input: { query: string }) => ({
      query: input.query, durationSeconds: 0, results: [], summary: 'Fixture search completed.',
    }),
  }))
}
const backgroundReview = Promise.withResolvers<void>()
const backgroundVerdict = Promise.withResolvers<void>()
let resolveBackground!: () => void
const backgroundFinished = new Promise<void>(resolve => { resolveBackground = resolve })
mock.module('../services/api/client.js', () => ({
  CLIENT_REQUEST_ID_HEADER: 'x-client-request-id',
  resolveCodexOAuthTokensForLeaseOwner: async () => { throw new Error('OAuth forbidden') },
  getAnthropicClient: async (client: { provider: string }) => ({ beta: { messages: { create(body: any) {
    if (!body.stream) {
      const start = performance.now()
      const contextual = !body.tool_choice
      const content = contextual ? JSON.parse(body.messages.at(-1).content) : body.messages.at(-1)?.content.at(-1)?.text
      const tool = contextual ? content.action.tool : /<pending_action>\n(\S+)/.exec(content)?.[1] ?? 'unknown'
      const review = { tool, content, ...((credentialSettings || shadowPeerWrite) && { system: body.system }), startedAt: start, elapsedMs: 0, model: body.model, provider: client.provider, contextual }
      requests.push(review)
      const operatorText = contextual ? content.conversation.filter((entry: any) => entry.origin === 'operator').map((entry: any) => entry.text) : []
      const verdict = twoChecks || credentialSettings ? 'allow' : repeatedDenials || shadowPeerWrite ? 'deny'
        : cleanup ? (tool === 'Edit' && operatorText.includes('Keep the old setting in local.mjs until tomorrow.') ? 'deny' : 'allow')
        : legacyNotice && tool === 'Edit' && content.assignment?.parent?.some((row: any) =>
          row.origin === 'operator' && row.text === 'Have a helper inspect a.txt. Leave it untouched.') ? 'deny'
        : operatorText.some((text: string) => text === 'Stop. Leave all files untouched.' ||
          text === queuedReadWithdrawal || text === 'Stop. Do not access the records.' ||
          text === 'Stop the background task. Leave the file untouched.' ||
          text === 'Leave the file untouched. Only inspect it.') ? 'deny'
        : privateNoticePolicy || privateNoticeWorkspace || privateNoticeInstructions[scenario] || scenario === 'mcp-deny' ? 'deny'
        : tool === 'REPL' ? 'allow'
        : scenario.includes('withdrawn') || staleParent || rewrittenEdit || questionReply || mainEdit || peerAction || directPatch || sensitiveWrite ? 'deny'
        : lateCorrection ? 'allow'
        : scenario.startsWith('skip-') ? (String(content?.action?.input?.file_path).endsWith('/b.txt') ? 'ask' : 'allow')
        : scenario.startsWith('wait-') || scenario.startsWith('direct-') ? 'ask' : 'allow'
      return (async () => {
        await Bun.sleep(2)
        if (localMcp && mcpWithdrawal && requests.length === 1) {
          const { enqueue } = await import('../utils/messageQueueManager.js')
          enqueue({ mode: 'prompt', value: 'Stop. Do not access the records.' })
        }
        if (tool === 'Bash' && lateCorrection && requests.length === 1) {
          const { enqueue } = await import('../utils/messageQueueManager.js')
          enqueue({ mode: 'prompt', value: 'Stop. Leave all files untouched.' })
        }
        if (tool === 'Bash' && backgroundWithdrawal) {
          backgroundReview.resolve()
          await backgroundVerdict.promise
        }
        review.elapsedMs = performance.now() - start
        if (reviewUnavailable) throw new Error('Synthetic provider outage')
        return { id: 'classifier', type: 'message', role: 'assistant', model: body.model,
          content: contextual
            ? [{ type: 'text', text: scenario === 'direct-invalid' ? 'unparseable result' : JSON.stringify({ decision: verdict, risk: 'medium', rationale: 'Isolated review decision.' }) }]
            : [{ type: 'tool_use', id: 'verdict', name: body.tool_choice.name, input: scenario === 'mcp-deny'
              ? { shouldBlock: true, thinking: 'Isolated review.', reason: 'Access exceeds the requested scope.' }
              : { shouldBlock: false, reason: 'Isolated baseline allowance.' } }],
          stop_reason: contextual ? 'end_turn' : 'tool_use', stop_sequence: null,
          usage: { input_tokens: 20, output_tokens: 10 } }
      })()
    }
    if (captureScriptResults) {
      for (const message of body.messages) {
        if (!Array.isArray(message.content)) continue
        for (const block of message.content) {
          if (block.type === 'tool_result') modelToolResults[block.tool_use_id] = block.content
        }
      }
    }
    const worker = workerRouting && body.messages.some((message: any) => message.role === 'user' &&
      JSON.stringify(message.content).includes(workerBrief))
    const index = worker ? workerModelCalls++ : modelCalls++
    const cleanupCall = cleanup ? cleanupPlan[index] : undefined
    const invocation = worker ? index < workerActions.length : twoChecks || repeatedScriptDenials ? index < 3 : repeatedDenials ? index < 5 : cleanup ? Boolean(cleanupCall) : index === 0 || (scenario === 'skip-queued' || legacyNotice || questionReply || scenario === 'mcp-browser-used') && index === 1
    let check
    if (twoChecks && index > 0) {
      const first = { name: 'Bash', input: {
        command: failedFirstCheck ? 'cat a.txt | tee -a effects.txt; exit 3' : 'cat a.txt | tee -a effects.txt',
        description: 'Verify the launch path', dangerouslyDisableSandbox: true,
      } }
      check = index === 1
        ? scriptedFirstCheck
          ? { name: 'REPL', input: { code: `await tools.call({...${JSON.stringify(first)}, nothrow: true})`, description: 'Verify the launch path' } }
          : first
        : { name: 'Bash', input: { command: 'CHROME_BIN=/usr/bin/false printf checked >> effects.txt', description: 'Verify the restricted failure path' } }
    }
    const main = worker ? workerActions[index] : check ?? (scenario === 'mcp-browser-used' ? (index === 0
      ? { name: mcpAction.name, input: { code: 'await cua.getState()' } } : mcpAction) : repeatedDenials ? (repeatedScriptDenials ? submitted : command) : cleanupCall || (legacyNotice
      ? index === 0 ? { name: 'Announce', input: { doing: 'Working on a.txt', touches: ['a.txt'] } } : action('a')
      : index === 0 ? submitted
      : questionReply ? command
      : { name: 'Read', input: { file_path: join(cwd, 'a.txt') } }))
    const stream = Object.assign((async function* () {
      yield { type: 'message_start', message: { id: `response-${index}`, type: 'message', role: 'assistant', model: 'claude-sonnet-5-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 20, output_tokens: 0 } } }
      if (queuedBrowserRead && index === 0) {
        const { enqueue } = await import('../utils/messageQueueManager.js')
        enqueue({ mode: 'prompt', value: scenario.endsWith('-stop') ? queuedReadWithdrawal : 'Also summarize the results afterwards.' })
      }
      if (cleanupCall === cleanupActions.at(-1) && cleanup) {
        const { enqueue } = await import('../utils/messageQueueManager.js')
        enqueue({ mode: 'prompt', value: followUp })
      }
      if (invocation && main) {
        yield { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: `${worker ? 'worker' : 'action'}-${index}`, name: main.name, input: {} } }
        yield { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(main.input) } }
        yield { type: 'content_block_stop', index: 0 }
      }
      yield { type: 'message_delta', delta: { stop_reason: invocation ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 12 } }
      yield { type: 'message_stop' }
    })(), { controller: new AbortController() })
    return { withResponse: async () => ({ data: stream, request_id: `request-${index}`, response: new Response('') }) }
  } } } }),
}))

const { enableConfigs } = await import('../utils/config.js')
const { getDefaultAppState } = await import('../state/AppStateStore.js')
const { createFileStateCacheWithSizeLimit } = await import('../utils/fileStateCache.js')
const { createQueryEngineAppSession } = await import('./createQueryEngineAppSession.js')
const { createQueryEngineSessionController } = await import('./createQueryEngineSessionController.js')
const { BashTool } = await import('../tools/BashTool/BashTool.js')
const { FileReadTool } = await import('../tools/FileReadTool/FileReadTool.js')
const { FileEditTool } = await import('../tools/FileEditTool/FileEditTool.js')
const { AskUserQuestionTool } = await import('../tools/AskUserQuestionTool/AskUserQuestionTool.js')
const { REPLTool } = await import('../tools/REPLTool/REPLTool.js')
const { CodeModeHost } = await import('../tools/REPLTool/codeModeHost.js')
const { createUserMessage } = await import('../utils/messages.js')
enableConfigs()
if ((routed && scenario.endsWith('-direct')) || workerRouting || backgroundWithdrawal || lateCorrection || mcpWithdrawal || cleanup || queuedBrowserRead || scenario.startsWith('trial-')) {
  const { getSessionId, switchSession } = await import('../bootstrap/state.js')
  switchSession(getSessionId())
}
let state = getDefaultAppState()
state = { ...state, toolPermissionContext: { ...state.toolPermissionContext, mode: 'auto', isAutoModeAvailable: true,
  ...(scenario === 'native-denials-headless' && { shouldAvoidPermissionPrompts: true }),
  ...(scenario === 'native-fingerprint-rule' && { alwaysDenyRules: { session: ['Read(./a.txt)'] } }),
  ...(scenario === 'native-scope-notice-ask' && { alwaysAskRules: { session: ['Announce'] } }),
  ...(scenario.startsWith('skip-') && { alwaysAskRules: { session: ['Edit'] } }),
} }
const assignment = verifiedParentEdit ? 'Update .vscode/settings.json from old to new.'
  : candidate.name === 'Edit' ? 'Update a.txt from old to new.' : 'Append one effect marker to effects.txt.'
const initial = routed && !scenario.includes('peer-only') && !scenario.includes('-parent-') ? [
  createUserMessage({ content: assignment }),
  ...(scenario.includes('withdrawn') ? [createUserMessage({ content: 'Stop this job. Leave all files as they are.' })] : []),
  ...(scenario.includes('stopped') ? [createUserMessage({ content: 'Interrupted by user', origin: { kind: 'interruption' } })] : []),
] : []
let parentReference: { parentSessionId: string; userMessageId: string } | undefined
if (scenario.includes('-parent-')) {
  const storage = await import('../utils/sessionStorage.js')
  const parentSessionId = randomUUID()
  const path = storage.getTranscriptPathForSession(parentSessionId)
  const grant = createUserMessage({ content: assignment })
  parentReference = { parentSessionId, userMessageId: grant.uuid }
  await mkdir(dirname(path), { recursive: true })
  const entry = (message: ReturnType<typeof createUserMessage>, parentUuid: string | null) =>
    JSON.stringify({ ...message, parentUuid, sessionId: parentSessionId, cwd, isSidechain: false, userType: 'external' }) + '\n'
  await writeFile(path, entry(grant, null))
  if (staleParent || parentWithdrawal) {
    const content = parentWithdrawal ? 'Stop this job. Leave all files as they are.' : 'Stop this edit and leave the file in place.'
    await appendFile(path, entry(createUserMessage({ content }), grant.uuid))
  }
}
let transcript: readonly any[] = []
const runtimeLimits = scenario.startsWith('wait-') ? { foregroundMs: 900, backgroundMs: 900, runtimeMs: 900 }
  : scenario === 'timeout-host' ? { foregroundMs: 350, backgroundMs: 350, runtimeMs: 1500 }
  : scenario === 'timeout-runtime' ? { foregroundMs: 1500, backgroundMs: 1500, runtimeMs: 350 } : undefined
const config: Omit<import('../QueryEngine.js').QueryEngineConfig, 'canUseTool'> = {
  cwd, tools: [REPLTool, BashTool, FileReadTool, FileEditTool, ...(questionReply ? [AskUserQuestionTool] : [])], commands: [], mcpClients: [], agents: [],
  getAppState: () => state, setAppState: update => {
    state = update(state)
    if (Object.values(state.tasks).some((task: any) => task.delivery === 'delivered')) resolveBackground()
  }, readFileCache: createFileStateCacheWithSizeLimit(20),
  userSpecifiedModel: 'claude-sonnet-5-5',
  recordTranscript: async messages => {
    transcript = structuredClone(messages)
    return (scenario.startsWith('measure-') || scenario.startsWith('wait-') || surface !== 'desktop' ||
      backgroundWithdrawal || lateCorrection || mcpWithdrawal || cleanup || queuedBrowserRead || scenario.startsWith('trial-'))
      ? (await import('../utils/sessionStorage.js')).recordTranscript(messages) : null
  },
  ...(runtimeLimits && { codeModeHost: new CodeModeHost(runtimeLimits) }),
  initialMessages: oversizeHistory ? [createUserMessage({ content: 'OVERSIZE_EARLIER_CONTEXT ' + 'old '.repeat(80_000) })]
    : twoChecks ? [createUserMessage({ content: 'Do not push. Old key was ghp_' + 'A'.repeat(36) })] : compacted ? [
    createUserMessage({ content: 'The lead assigned a file edit.', isCompactSummary: true,
      ...(scenario === 'compacted-relay-marker' && { summarizedRelayedInput: true }) }),
  ] : initial,
  ...(scenario === 'compacted-host-identity' && { peerCreatorAppSessionId: randomUUID() }),
}
const creatorAppId = randomUUID()
const postedNotices: unknown[] = []
let browserCalls = 0
if (webSearch) {
  const { WebSearchTool } = await import('../tools/WebSearchTool/WebSearchTool.js')
  config.tools = [...config.tools, WebSearchTool]
}
if (workerRouting) {
  const { AgentTool } = await import('../tools/AgentTool/AgentTool.js')
  const { GENERAL_PURPOSE_AGENT } = await import('../tools/AgentTool/built-in/generalPurposeAgent.js')
  config.tools = [...config.tools, AgentTool]
  config.agents = [GENERAL_PURPOSE_AGENT]
}
if (peerLocalFollowUp) {
  config.initialMessages = [
    createUserMessage({ content: assignment, origin: { kind: 'peer', name: 'Lead', appSessionId: creatorAppId } }),
    createUserMessage({ content: 'Update a.txt.' }),
  ]
}
if (sensitiveWrite) {
  const { FileWriteTool } = await import('../tools/FileWriteTool/FileWriteTool.js')
  config.tools = [...config.tools, FileWriteTool]
}
if (loadSkill) {
  const { SkillTool } = await import('../tools/SkillTool/SkillTool.js')
  config.tools = [...config.tools, SkillTool]
}
if (nativeAction || cleanup) {
  if (browserAction) {
    const { createBrowserTools } = await import('../../app/sidecar/browserTools.js')
    config.tools = [...config.tools, ...createBrowserTools((async verb => {
      if (verb === 'browser.describe') return { ok: true, value: {
        description: browserTarget, url: 'http://localhost:3000/settings',
      } }
      const expectedVerb = browserRead ? (browserReadTool === 'BrowserRead' ? 'browser.read' : 'browser.screenshot')
        : browserNavigate ? 'browser.navigate' : 'browser.act'
      if (verb !== expectedVerb) throw new Error('Unexpected browser fixture request')
      browserCalls++
      return { ok: true, value: {} }
    }) as import('../../app/sidecar/peerHostRequester.js').PeerHostRequester)]
    if (browserPeer) config.initialMessages = [createUserMessage({ content: 'Click Save in the browser.' })]
  } else {
    const { FilePatchTool } = await import('../tools/FilePatchTool/FilePatchTool.js')
    config.tools = [...config.tools, FilePatchTool]
  }
}
let cleanupMcp: (() => Promise<void>) | undefined
if (localMcp) {
  const { connectToServer, fetchToolsForClient } = await import('../services/mcp/client.js')
  const fixtureServer = new URL('./codeModeMcpLocalServer.fixture.ts', import.meta.url)
  const adapter = join(root, '.local/share/codex-computer-use-mcp/local/dist/mcp-server.js')
  const preload = join(root, 'browser-preload.cjs')
  if (selectBrowser) {
    await mkdir(dirname(adapter), { recursive: true })
    await writeFile(adapter, `if (process.env.FIXTURE_BROWSER_PRELOAD && !globalThis.fixtureBrowserPreloaded) process.exit(1);
import(${JSON.stringify(fixtureServer.href)});`)
  }
  const browserPreload = scenario === 'mcp-browser-preload'
  if (browserPreload) await writeFile(preload, 'globalThis.fixtureBrowserPreloaded = true;')
  const client = await connectToServer(selectBrowser ? 'codex-computer-use' : 'fixture', {
    type: 'stdio', command: selectBrowser ? Bun.which('node')! : process.execPath,
    args: [selectBrowser ? adapter : fixtureServer.pathname],
    env: { HOME: root, CODE_MODE_TEST_ROOT: root, ...(selectBrowser && { FIXTURE_BROWSER: '1' }),
      ...(annotatedMcp && !scenario.endsWith('-missing') && { FIXTURE_MCP_OPEN_WORLD: String(scenario.endsWith('-open')) }),
      ...(browserPreload && { NODE_OPTIONS: `--require "${preload}"`, FIXTURE_BROWSER_PRELOAD: '1' }) },
    scope: scenario === 'mcp-read-project' ? 'project' : annotatedMcp || (selectBrowser && scenario !== 'mcp-browser-impostor') ? 'user' : 'local',
  })
  if (client.type !== 'connected') throw new Error('Local MCP fixture failed to connect')
  cleanupMcp = client.cleanup
  const mcpTools = await fetchToolsForClient(client)
  config.getMcpRuntimeSnapshot = () => ({ clients: [client], tools: mcpTools, commands: [], resources: {} })
}
let peerRequests = 0
if (peerAction) {
  const { createCreatePeerTool } = await import('../../app/sidecar/createPeerTool.js')
  const { createSendToPeerTool } = await import('../../app/sidecar/sendToPeerTool.js')
  const host: import('../../app/sidecar/peerHostRequester.js').PeerHostRequester = async () => {
    peerRequests++
    return { ok: false, error: { code: 'unavailable', message: 'Unexpected peer request' } }
  }
  config.tools = [...config.tools, createCreatePeerTool(host), createSendToPeerTool(host)]
}
if (scopeNotice) {
  const { createAnnounceTool } = await import('../../app/sidecar/announceTool.js')
  config.tools = [...config.tools, createAnnounceTool(async (_verb, args) => {
    postedNotices.push(args)
    return { ok: true, value: { postedAt: Date.now() } } as never
  })]
}
if (helperSymbol) {
  const server = new URL('./contextualAutoLspServer.fixture.ts', import.meta.url).pathname
  mock.module('../services/lsp/config.js', () => ({ getAllLspServers: async () => ({ servers: {
    'fixture-symbols': { command: process.execPath, args: [server], extensionToLanguage: { '.txt': 'plaintext' } },
  } }) }))
  const lsp = await import('../services/lsp/manager.js')
  lsp.initializeLspServerManager()
  await lsp.waitForInitialization()
}
if (helperRead) {
  const { GetGoalTool } = await import('../tools/GetGoalTool/GetGoalTool.js')
  const { LSPTool } = await import('../tools/LSPTool/LSPTool.js')
  config.tools = [...config.tools, GetGoalTool, LSPTool]
  config.peerCreatorAppSessionId = creatorAppId
}
if (legacyNotice) {
  const { getTranscriptPathForSession } = await import('../utils/sessionStorage.js')
  const { createAnnounceTool } = await import('../../app/sidecar/announceTool.js')
  const parentSessionId = randomUUID()
  const childAppSessionId = randomUUID()
  const parentFile = getTranscriptPathForSession(parentSessionId)
  const grant = createUserMessage({ content: 'Have a helper inspect a.txt. Leave it untouched.' })
  const callId = randomUUID()
  const script = scenario === 'legacy-notice-script' ? { isVirtual: true as const, codeMode: { cellId: 'fixture-cell', generation: 'fixture-generation' } } : {}
  const create = { type: 'assistant', uuid: randomUUID(), ...script, message: { role: 'assistant', content: [
    { type: 'tool_use', name: 'CreatePeer', id: callId, input: { prompt: 'Inspect a.txt.' } },
  ] } }
  const receipt = { ...createUserMessage({ content: [{ type: 'tool_result', tool_use_id: callId, content: 'Created peer' }],
    sourceToolAssistantUUID: create.uuid, toolUseResult: { ok: true,
      appSessionId: scenario === 'legacy-notice-other-child' ? randomUUID() : childAppSessionId } }), ...script }
  const rows = [grant, create, receipt]
  if (scenario === 'legacy-notice-conflicting') {
    rows.push({ ...receipt, uuid: randomUUID(), toolUseResult: { ok: true, appSessionId: randomUUID() } })
  }
  if (scenario === 'legacy-notice-no-anchor') rows.push(rows.shift()!)
  await mkdir(dirname(parentFile), { recursive: true })
  await writeFile(parentFile, rows.map((row, i) => JSON.stringify({ ...row, parentUuid: rows[i - 1]?.uuid ?? null,
    sessionId: parentSessionId, cwd, isSidechain: false, userType: 'external' })).join('\n') + '\n')
  if (scenario === 'legacy-notice-queued') await appendFile(parentFile, JSON.stringify({
    type: 'queue-operation', operation: 'enqueue', queueVersion: 2, mode: 'prompt',
    sessionId: parentSessionId, uuid: randomUUID(), timestamp: new Date().toISOString(),
    content: 'Stop the helper job.',
  }) + '\n')
  config.peerCreatorAppSessionId = creatorAppId
  config.lookupLegacyPeerCreator = async creator => creator === creatorAppId && scenario !== 'legacy-notice-no-creator'
    ? { parentSessionId, childAppSessionId } : undefined
  config.tools = [...config.tools, createAnnounceTool(async (verb, args) => {
    if (verb !== 'peer.announce') throw new Error('Unexpected fixture host request')
    postedNotices.push(args)
    return { ok: true, value: { postedAt: Date.now() } } as never
  })]
}
const { createAssistantMessage } = await import('../utils/messages.js')
if (cleanup) {
  const proposal = createAssistantMessage({ content: 'Remove the leftover /commercial page and check the cleanup, or plan the edit-table flattening?' })
  proposal.message.model = 'claude-sonnet-5-5'
  config.initialMessages = [proposal]
}
const session = createQueryEngineAppSession(config)
const controller = createQueryEngineSessionController(session)
const prompts: unknown[] = []
const reviewEvents: unknown[] = []
const sdkResults: unknown[] = []
const replies: Promise<void>[] = []
let waitMs = 0
let observedBeforeReply: string | null | undefined
controller.subscribe(event => {
  if (event.type === 'tool.review') reviewEvents.push(event)
  if (event.type === 'message' && event.message.type === 'result') sdkResults.push(event.message)
  if (event.type !== 'permission.requested') return
  const { requestId, request } = event.request
  prompts.push(request)
  replies.push((async () => {
    if (questionReply && request.tool_name === question.name) {
      const { recordQuestionSelections, reconstructQuestionSelection } = await import('../utils/questionSelections.js')
      const first = question.input.questions[0]!
      const answers = { [first.question]: 'Inspect' }
      recordQuestionSelections(request.tool_use_id, request.input.questions, answers, [
        reconstructQuestionSelection(request.tool_use_id, 0, first, { optionIndices: [0] }),
      ])
      controller.respondToPermissionRequest(requestId, { behavior: 'allow', updatedInput: { ...request.input, answers } })
      return
    }
    const start = performance.now()
    if (scenario.startsWith('wait-')) await Bun.sleep(1200)
    if (scenario.startsWith('direct-')) await Bun.sleep(200)
    if (request.tool_name === 'Bash') observedBeforeReply = await effect()
    waitMs += performance.now() - start
    if (scenario === 'wait-stop') controller.abort()
    if (scenario === 'wait-correction') {
      const { enqueue } = await import('../utils/messageQueueManager.js')
      enqueue({ mode: 'prompt', value: 'Leave the file untouched. Only inspect it.' })
    }
    if (repeatedDenials || scenario === 'wait-approve' || scenario === 'wait-correction' || scenario === 'direct-allow' || scenario === 'direct-mutated' || scenario === 'direct-unavailable' || scenario === 'direct-invalid') {
      const response = { behavior: 'allow' as const, updatedInput: scenario === 'direct-mutated' ? { ...request.input, run_in_background: true } : request.input }
      controller.respondToPermissionRequest(requestId, response)
      controller.respondToPermissionRequest(requestId, response)
    } else if (scenario === 'wait-stop') {
      controller.respondToPermissionRequest(requestId, { behavior: 'allow', updatedInput: request.input })
    } else if (scenario.startsWith('skip-') && !String(request.input.file_path).endsWith('/b.txt')) {
      controller.respondToPermissionRequest(requestId, { behavior: 'allow', updatedInput: request.input })
    } else {
      controller.respondToPermissionRequest(requestId, { behavior: 'deny', message: '' })
    }
  })())
})
const start = performance.now()
let hookRanBeforeHuman = false
async function awaitHook() {
  const deadline = performance.now() + 3000
  while (performance.now() < deadline && !await Bun.file(hookMarker).exists()) await Bun.sleep(10)
  hookRanBeforeHuman = await Bun.file(hookMarker).exists()
  await Bun.sleep(50)
  observedBeforeReply = await effect()
}

if (surface === 'desktop') {
  if (helperRead) await controller.submit('Inspect the goal and symbols.', {
    origin: { kind: 'peer', name: 'Lead', appSessionId: creatorAppId, creationPrompt: true },
  })
  else if (scenario === 'native-scope-notice-note') await controller.submit('Inspect the private method and tell me what you find.')
  else if (privateNoticeInstructions[scenario]) await controller.submit(privateNoticeInstructions[scenario]!)
  else if (scopeNotice) await controller.submit(scenario === 'native-scope-notice-private' ?
    'Investigate the Chrome crash. Keep this investigation private.' : 'Investigate and fix the Chrome crash.')
  else if (cleanup) await controller.submit('yep. up to you')
  else if (shadowPeerWrite) await controller.submit(assignment, {
    origin: { kind: 'peer', name: 'Lead', appSessionId: creatorAppId },
  })
  else if (scenario === 'native-outside-read-peer') await controller.submit('Search the fixture logs.', {
    origin: { kind: 'peer', name: 'Lead', appSessionId: creatorAppId },
  })
  else if (credentialAction) await controller.submit(`Use the synthetic fixture key to configure the local destination.\n-----BEGIN PRIVATE KEY-----\nfixture-private-key-body${incompleteKey ? '' : '\n-----END PRIVATE KEY-----'}`)
  else if (localMcp) await controller.submit('Look up the sample record.', scenario === 'mcp-peer-only' ? {
    origin: { kind: 'peer', name: 'Lead', appSessionId: creatorAppId },
  } : undefined)
  else if (nativeAction) await controller.submit(browserAction
    ? browserRead ? 'Read the browser page.' : browserScroll ? 'Scroll down in the browser.' : 'Click Save in the browser.'
    : 'Update a.txt from old to new.',
    browserPeer ? { origin: { kind: 'peer', name: 'Lead', appSessionId: creatorAppId } } : undefined)
  else if (legacyNotice) await controller.submit('Inspect a.txt.', { origin: {
    kind: 'peer', name: 'Lead', appSessionId: creatorAppId, creationPrompt: true,
  } })
  else if (peerLocalFollowUp) await controller.submit('Also update the docs.')
  else await controller.submit(routed || mainEdit ? assignment : loadSkill ? 'Use the fixture-auto-skill.' :
    peerAction ? 'Inspect a.txt yourself. Do not create or contact another session.' :
    'Run the isolated action and report the result.', routed ? {
      origin: { kind: 'peer', name: 'Lead', appSessionId: 'fixture-lead', creationPrompt: true, ...(parentReference && { assignment: parentReference }) },
    } : compacted ? { isMeta: true } : undefined)
  if (backgroundWithdrawal) {
    await backgroundReview.promise
    await controller.submit('Stop the background task. Leave the file untouched.')
    backgroundVerdict.resolve()
    await backgroundFinished
  }
  if (scenario === 'wait-stop') {
    const { getSessionId } = await import('../bootstrap/state.js')
    const { getInterruptedToolRun } = await import('../services/tools/interruptedToolRun.js')
    await getInterruptedToolRun(getSessionId()).whenSettled()
    await controller.submit('Report why the Script stopped.')
  }
} else {
  const { QueryEngine } = await import('../QueryEngine.js')
  let engine: InstanceType<typeof QueryEngine>
  let canUseTool: import('../hooks/useCanUseTool.js').CanUseToolFn
  let closeIo: (() => void) | undefined
  if (surface === 'terminal') {
    const { createPermissionContext } = await import('../hooks/toolPermission/PermissionContext.js')
    const { handleInteractivePermission } = await import('../hooks/toolPermission/handlers/interactiveHandler.js')
    const { hasPermissionsToUseTool } = await import('../utils/permissions/permissions.js')
    canUseTool = async (tool, input, context, assistant, id, forced) => {
      const result = forced ?? await hasPermissionsToUseTool(tool, input, context, assistant, id)
      if (result.behavior !== 'ask') return result
      return new Promise(resolve => {
        const ctx = createPermissionContext(tool, input, context, assistant, id, permission => {
          state = { ...state, toolPermissionContext: permission }
        }, {
          push(item) {
            prompts.push({ human_only: item.permissionResult.behavior === 'ask' && item.permissionResult.humanOnly, input: item.input, tool_name: item.tool.name })
            replies.push((async () => {
              await awaitHook()
              if (scenario.endsWith('-stop')) engine.interrupt()
              if (scenario.endsWith('-deny')) item.onReject()
              else {
                await item.onAllow(item.input, [])
                await item.onAllow(item.input, [])
              }
            })())
          },
          remove() {},
          update() {},
        })
        handleInteractivePermission({ ctx, description: 'Review the isolated shell action', result,
          awaitAutomatedChecksBeforeDialog: false }, resolve)
      })
    }
  } else {
    const { StructuredIO } = await import('../cli/structuredIO.js')
    const { Stream } = await import('../utils/stream.js')
    const incoming = new Stream<string>()
    const io = new StructuredIO(incoming)
    if (!scenario.endsWith('-nohost')) io.enableHumanOnlyPermissionPrompts()
    canUseTool = io.createCanUseTool()
    const read = (async () => { for await (const _ of io.structuredInput) { /* control replies settle inside StructuredIO */ } })()
    const write = (async () => {
      for await (const frame of io.outbound) {
        if (frame.type !== 'control_request' || frame.request.subtype !== 'can_use_tool') continue
        prompts.push(frame.request)
        await awaitHook()
        if (scenario.endsWith('-stop')) {
          engine.interrupt()
          await Bun.sleep(10)
        }
        const deny = scenario.endsWith('-deny')
        const reply = JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: frame.request_id,
          response: deny ? { behavior: 'deny', message: '', decisionClassification: 'user_reject' } : {
            behavior: 'allow', updatedInput: frame.request.input,
            ...(scenario.endsWith('-automated') ? {} : { decisionClassification: 'user_temporary' }),
          } } }) + '\n'
        incoming.enqueue(reply)
        incoming.enqueue(reply)
      }
    })()
    closeIo = () => { incoming.done(); io.outbound.done() }
    replies.push(read, write)
  }
  engine = new QueryEngine({ ...config, canUseTool })
  for await (const _ of engine.submitMessage('Run the isolated action and report the result.')) { /* retain normal transcript */ }
  closeIo?.()
  engine.dispose()
}
if (scenario === 'measure-background') await backgroundFinished
const scriptWallMs = performance.now() - start
await Promise.all(replies)
let executions: unknown[] = []
if (scenario.startsWith('measure-')) {
  const storage = await import('../utils/sessionStorage.js')
  await storage.flushSessionStorage()
  const data = await readFile(storage.getTranscriptPath(), 'utf8')
  executions = data.trim().split('\n').map(row => JSON.parse(row))
    .filter(row => row.subtype === 'tool_execution_end')
    .map(row => ({ id: row.tool_use_id, durationMs: row.duration_ms }))
}
let savedReviews: unknown[] = []
if (lateCorrection || backgroundWithdrawal || scenario.startsWith('trial-')) {
  const { getTranscriptPath } = await import('../utils/sessionStorage.js')
  const { readAutoModeReviews } = await import('./autoModeReviewPersistence.js')
  savedReviews = readAutoModeReviews(getTranscriptPath())
}
const workerDatabase = workerRouting && await Bun.file(join(cwd, 'fixture.db')).exists()
  ? Bun.spawnSync(['sqlite3', 'fixture.db', 'SELECT value FROM fixture'], { cwd }).stdout.toString().trim() : undefined
await writeFile(join(root, 'evidence.json'), JSON.stringify({
  scenarios: scenario, requests, prompts, reviewEvents, savedReviews, transcript, waitMs, observedBeforeReply, hookRanBeforeHuman, sdkResults, postedNotices, peerRequests,
  ...(captureScriptResults && { modelToolResults }),
  ...(cleanup && { pageExists: await Bun.file(join(cwd, 'commercial.mjs')).exists(), cleanupFiles: await Promise.all(cleanupEdits.map(([name]) => readFile(join(cwd, name), 'utf8'))) }),
  ...(browserAction && { browserCalls }),
  ...(sensitiveWrite && { sensitiveFileExists: await Bun.file(join(cwd, sensitiveWrite)).exists() }),
  ...((rewrittenEdit || verifiedParentEdit) && { protectedEdit: await readFile(protectedEditPath, 'utf8') }),
  ...(workerRouting && {
    workerDatabase,
    buildExists: await Bun.file(join(cwd, 'build', 'marker')).exists(),
    outsideBuildExists: await Bun.file(join(outsideBuild, 'marker')).exists(),
  }),
  ...(hookAllowEdit && { hookRan: await Bun.file(hookMarker).exists() }),
  ...(localMcp && { mcpCalls: await readFile(join(root, 'mcp-calls.jsonl'), 'utf8')
    .then(text => text.trim().split('\n').map(line => JSON.parse(line)), () => []) }),
  wallMs: scriptWallMs, executions, effect: await effect(), files:
    Object.fromEntries(await Promise.all(['a', 'b', 'c', 'hooked'].map(async name => [name, await readFile(join(cwd, name + '.txt'), 'utf8')]))),
}))
controller.dispose()
await cleanupMcp?.()
if (helperSymbol) await (await import('../services/lsp/manager.js')).shutdownLspServerManager()
