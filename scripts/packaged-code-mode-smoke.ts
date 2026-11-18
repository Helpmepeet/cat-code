import { randomUUID } from 'node:crypto'
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { SidecarSupervisor } from '../app/supervisor/supervisor.js'

const MODEL = 'claude-sonnet-4-6'
const TOOL_USE_ID = 'toolu_packaged_script'
const PROMPT = 'Run the packaged Script smoke check.'
const TIMEOUT_MS = 45_000
const NO_BUN_PATH = '/usr/bin:/bin:/usr/sbin:/sbin'

function modelResponse(tool: boolean, requestNumber: number): Response {
  const events = [
    { type: 'message_start', message: { id: `msg_packaged_${requestNumber}`, type: 'message', role: 'assistant', model: MODEL, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 8, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: tool ? { type: 'tool_use', id: TOOL_USE_ID, name: 'REPL', input: {} } : { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: tool ? { type: 'input_json_delta', partial_json: JSON.stringify({ code: 'const result = await Promise.resolve(6 * 7); output(result);', description: 'Check the packaged Script worker' }) } : { type: 'text_delta', text: 'Packaged Script smoke complete.' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: tool ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 4 } },
    { type: 'message_stop' },
  ]
  return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''), {
    headers: { 'content-type': 'text/event-stream', 'request-id': 'packaged-script-smoke' },
  })
}

type ModelBlock = { type: string; tool_use_id?: string; is_error?: boolean; content?: unknown; text?: string }
type RequestBody = {
  stream?: boolean
  tools?: Array<{ name: string }>
  messages?: Array<{ content: string | ModelBlock[] }>
}

async function runCli(binary: string, cwd: string, env: Record<string, string>): Promise<void> {
  const child = Bun.spawn([
    binary, '-p', '--model', MODEL, '--tools', 'REPL', '--allowedTools', 'REPL',
    '--setting-sources', '', '--max-turns', '2', PROMPT,
  ], { cwd, env, stdin: 'ignore', stdout: 'pipe', stderr: 'pipe', timeout: TIMEOUT_MS })
  const [status, stdout, stderr] = await Promise.all([
    child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
  ])
  if (status !== 0 || !stdout.includes('Packaged Script smoke complete.')) {
    throw new Error(`CLI did not complete the Script turn (${status}): ${(stderr + stdout).trim().slice(0, 500)}`)
  }
}

async function runSidecar(binary: string, cwd: string, env: Record<string, string>, sockets: string): Promise<void> {
  // This disposable smoke process passes an isolated environment to the normal supervisor.
  for (const key of Object.keys(process.env)) delete process.env[key]
  const diagnostics: string[] = []
  const supervisor = new SidecarSupervisor({ sidecarCommand: binary, sidecarArgs: ['session'], sidecarEnv: env, socketDir: sockets, log: line => diagnostics.push(line) })
  const sessionId = randomUUID()
  let unsubscribe: (() => void) | undefined
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    await new Promise<void>((resolve, reject) => {
      timeout = setTimeout(() => reject(new Error('Packaged sidecar Script turn timed out')), TIMEOUT_MS)
      unsubscribe = supervisor.subscribe(event => {
        if (event.sessionId !== sessionId) return
        if (event.type === 'exit' || (event.type === 'status' && (event.status === 'failed' || event.status === 'disconnected' || event.status === 'exited'))) {
          reject(new Error(`Packaged sidecar did not reach its Script turn: ${JSON.stringify(event)}`))
          return
        }
        if (event.type === 'status' && event.status === 'ready') {
          try { supervisor.send(sessionId, { type: 'app.submit', requestId: 'packaged-script', prompt: PROMPT }) }
          catch (error) { reject(error) }
        }
        if (event.type !== 'frame') return
        const frame = event.frame
        if (frame.kind === 'error') reject(new Error(frame.message))
        if (frame.kind !== 'event') return
        if (frame.event.type === 'permission.requested') reject(new Error('Packaged Script permission was not pre-authorized'))
        if (frame.event.type === 'message' && frame.event.message.type === 'result') {
          if (frame.event.message.subtype === 'success' && !frame.event.message.is_error) resolve()
          else reject(new Error(`Packaged sidecar Script turn failed: ${frame.event.message.subtype}`))
        }
      })
      supervisor.spawnSession(sessionId, { cwd, model: MODEL, permissionMode: 'default' })
    })
  } catch (error) {
    throw new Error(`${String(error)}\n${diagnostics.slice(-8).join('\n')}`)
  } finally {
    clearTimeout(timeout)
    unsubscribe?.()
    await supervisor.shutdown()
  }
}

const [mode, artifact] = process.argv.slice(2)
if ((mode !== 'cli' && mode !== 'sidecar') || !artifact) {
  throw new Error('Usage: packaged-code-mode-smoke.ts <cli|sidecar> <compiled executable>')
}
const root = realpathSync(mkdtempSync(join(tmpdir(), 'cc-script-')))
try {
  const cwd = join(root, 'workspace')
  const config = join(root, 'config')
  mkdirSync(cwd)
  mkdirSync(config)
  writeFileSync(join(config, '.config.json'), JSON.stringify({ projects: { [cwd]: { hasTrustDialogAccepted: true } } }))
  writeFileSync(join(config, 'settings.json'), JSON.stringify({ permissions: { allow: ['REPL'] } }))
  let offeredScript = false
  let receivedOutput = false
  let mismatch: string | undefined
  let requestNumber = 0
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      if (new URL(request.url).pathname !== '/v1/messages' || request.method !== 'POST') return new Response(null, { status: 404 })
      const body = await request.json() as RequestBody
      if (!body.stream) {
        return Response.json({ id: 'msg_packaged_aux', type: 'message', role: 'assistant', model: MODEL, content: [{ type: 'text', text: 'Packaged Script smoke' }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } })
      }
      const requestId = requestNumber++
      // Desktop may send a structured startup query without the Script tool.
      if (!body.tools?.some(tool => tool.name === 'REPL')) return modelResponse(false, requestId)
      if (!offeredScript) {
        offeredScript = true
        return modelResponse(true, requestId)
      }
      const result = body.messages?.flatMap(message => Array.isArray(message.content) ? message.content : [])
        .find(block => block.type === 'tool_result' && block.tool_use_id === TOOL_USE_ID)
      const content = result?.content
      const output = typeof content === 'string' ? content : Array.isArray(content) ? content.map((block: ModelBlock) => block.text ?? '').join('') : ''
      receivedOutput = !result?.is_error && output.startsWith('42\n\n[Code Mode] completed;')
      if (!receivedOutput) mismatch = `Compiled Script result did not contain 42 and a completed receipt: ${output.slice(0, 350)}`
      return modelResponse(false, requestId)
    },
  })
  const env = {
    HOME: root,
    PATH: NO_BUN_PATH,
    CLAUDE_CONFIG_DIR: config,
    ANTHROPIC_BASE_URL: server.url.origin,
    ANTHROPIC_API_KEY: 'sk-ant-packaged-script-fixture',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    DISABLE_TELEMETRY: '1',
    HTTP_PROXY: server.url.origin,
    HTTPS_PROXY: server.url.origin,
    NO_PROXY: '127.0.0.1',
  }
  try {
    const binary = resolve(artifact)
    if (mode === 'cli') await runCli(binary, cwd, env)
    else await runSidecar(binary, cwd, env, join(root, 's'))
    if (!offeredScript) throw new Error('Compiled engine did not advertise Script')
    if (!receivedOutput) throw new Error(mismatch ?? 'Compiled engine never returned Script output to the model')
    console.log(`Packaged ${mode} Script returned 42`)
  } finally {
    server.stop(true)
  }
} finally {
  rmSync(root, { recursive: true, force: true })
}
