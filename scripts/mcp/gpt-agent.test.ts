import { spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'bun:test'

const SERVER = '/Users/pt/cat-code/scripts/mcp/gpt-agent.ts'
const DEBUG_TOOLS_ENV = { GPT_AGENT_DEBUG_TOOLS: '1' }

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n')
}

function waitForLine(child: ReturnType<typeof spawn>, timeoutMs: number): Promise<any> {
  return new Promise((resolve, reject) => {
    let buffer = ''
    const timer = setTimeout(() => reject(new Error('timed out waiting for response')), timeoutMs)
    child.stdout?.on('data', chunk => {
      buffer += chunk.toString('utf8')
      const newline = buffer.indexOf('\n')
      if (newline === -1) return
      clearTimeout(timer)
      resolve(JSON.parse(buffer.slice(0, newline)))
    })
    child.once('error', reject)
  })
}

function callTool(child: ReturnType<typeof spawn>, id: number, name: string, args: Record<string, unknown>, meta?: Record<string, unknown>): Promise<any> {
  child.stdin?.write(JSON.stringify({
    jsonrpc: '2.0',
    id,
    method: 'tools/call',
    params: { name, arguments: args, _meta: meta },
  }) + '\n')
  return waitForLine(child, 4000)
}

function createRpcClient(child: ReturnType<typeof spawn>) {
  let buffer = ''
  const pending = new Map<number, (response: any) => void>()
  child.stdout?.on('data', chunk => {
    buffer += chunk.toString('utf8')
    let newline: number
    while ((newline = buffer.indexOf('\n')) !== -1) {
      const response = JSON.parse(buffer.slice(0, newline))
      buffer = buffer.slice(newline + 1)
      pending.get(response.id)?.(response)
      pending.delete(response.id)
    }
  })
  return {
    callTool(id: number, name: string, args: Record<string, unknown>): Promise<any> {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          if (!pending.has(id)) return
          pending.delete(id)
          reject(new Error(`timed out waiting for response ${id}`))
        }, 4000)
        pending.set(id, response => {
          clearTimeout(timer)
          resolve(response)
        })
        child.stdin?.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }) + '\n')
      })
    },
  }
}

async function waitForFile(path: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (existsSync(path)) return
    await Bun.sleep(50)
  }
  throw new Error(`timed out waiting for ${path}`)
}

async function waitForJsonlRecords(path: string, count: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (existsSync(path) && readJsonl(path).length >= count) return
    await Bun.sleep(50)
  }
  throw new Error(`timed out waiting for ${count} records in ${path}`)
}

function sanitizePath(path: string): string {
  return path.replace(/[^a-zA-Z0-9]/g, '-')
}

function readJsonl(path: string): any[] {
  return readFileSync(path, 'utf8').trim().split('\n').map(line => JSON.parse(line))
}

test('foreground spawn writes append-only audit records with MCP join id and token summary', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gpt-agent-audit-fg-'))
  const fakeCli = join(dir, 'cat-code')
  const auditLog = join(dir, 'audit.jsonl')
  const configDir = join(dir, 'config')
  const transcript = join(configDir, 'projects', sanitizePath(realpathSync(dir)), 'session-fg.jsonl')
  writeFileSync(fakeCli, `#!/usr/bin/env bash
mkdir -p "$(dirname "$FAKE_TRANSCRIPT")"
cat > "$FAKE_TRANSCRIPT" <<'JSONL'
{"type":"system","subtype":"codex_send_path","effort":"high","account_id_prefix":"acct1234","cached_tokens":4,"input_tokens":12}
{"type":"system","subtype":"codex_stream_surface","model":"gpt-5.4-mini","account_id_prefix":"acct1234","input_tokens":12,"output_tokens":3,"cached_tokens":4,"completed":true}
JSONL
printf '%s\n' '{"result":"done","session_id":"session-fg","is_error":false}'
`)
  chmodSync(fakeCli, 0o700)

  const child = spawn('bun', [SERVER], {
    cwd: dir,
    env: {
      ...process.env,
      CAT_CODE_CLI: fakeCli,
      CLAUDE_CONFIG_DIR: configDir,
      GPT_AGENT_AUDIT_LOG: auditLog,
      GPT_AGENT_TIMEOUT_MS: '5000',
      FAKE_TRANSCRIPT: transcript,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  try {
    const response = await callTool(child, 1, 'spawn_gpt_agent', {
      prompt: 'secret prompt must not be audited',
      model: 'gpt-5.4-mini',
    }, { 'claudecode/toolUseId': 'toolu-fg' })

    expect(response.result.isError).toBe(false)
    const records = readJsonl(auditLog)
    expect(records).toHaveLength(2)
    expect(records[0]).toMatchObject({
      event: 'started',
      mcp_tool_use_id: 'toolu-fg',
      mcp_request_id: 1,
      mode: 'foreground',
      model: 'gpt-5.4-mini',
      timeout_ms: 5000,
    })
    expect(records[1]).toMatchObject({
      event: 'terminal',
      status: 'completed',
      mcp_tool_use_id: 'toolu-fg',
      session_id: 'session-fg',
      session_jsonl: transcript,
      account_id_prefix: 'acct1234',
      model: 'gpt-5.4-mini',
      effort: 'high',
      token_summary: {
        input_tokens: 12,
        output_tokens: 3,
        cached_tokens: 4,
      },
    })
    expect(readFileSync(auditLog, 'utf8')).not.toContain('secret prompt')
  } finally {
    child.kill('SIGTERM')
    rmSync(dir, { recursive: true, force: true })
  }
})

test('background spawn writes audit records for job start and completion', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gpt-agent-audit-bg-'))
  const fakeCli = join(dir, 'cat-code')
  const auditLog = join(dir, 'audit.jsonl')
  const jobs = join(dir, 'jobs')
  writeFileSync(fakeCli, `#!/usr/bin/env bash
printf '%s\n' '{"result":"done","session_id":"session-bg-audit","is_error":false}'
`)
  chmodSync(fakeCli, 0o700)

  const child = spawn('bun', [SERVER], {
    cwd: dir,
    env: {
      ...process.env,
      CAT_CODE_CLI: fakeCli,
      GPT_AGENT_AUDIT_LOG: auditLog,
      GPT_AGENT_BACKGROUND_DIR: jobs,
      GPT_AGENT_TIMEOUT_MS: '5000',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  try {
    const startResponse = await callTool(child, 1, 'spawn_gpt_agent', {
      prompt: 'background secret must not be audited',
      model: 'gpt-5.4-mini',
      run_in_background: true,
    }, { 'claudecode/toolUseId': 'toolu-bg' })
    const jobId = startResponse.result.content[0].text.match(/job_id: (job_[a-zA-Z0-9-]+)/)?.[1]
    expect(jobId).toBeString()

    await waitForFile(join(jobs, jobId!, 'result.json'), 4000)
    await waitForJsonlRecords(auditLog, 2, 4000)

    const records = readJsonl(auditLog)
    expect(records[0]).toMatchObject({
      event: 'started',
      mode: 'background',
      status: 'queued',
      mcp_tool_use_id: 'toolu-bg',
      job_id: jobId,
      model: 'gpt-5.4-mini',
    })
    expect(records.at(-1)).toMatchObject({
      event: 'terminal',
      mode: 'background',
      status: 'completed',
      mcp_tool_use_id: 'toolu-bg',
      job_id: jobId,
      session_id: 'session-bg-audit',
    })
    expect(readFileSync(auditLog, 'utf8')).not.toContain('background secret')
  } finally {
    child.kill('SIGTERM')
    rmSync(dir, { recursive: true, force: true })
  }
})

test('background spawn creates a named GPT even without an explicit name', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gpt-agent-bg-addressable-'))
  const fakeCli = join(dir, 'cat-code')
  const jobs = join(dir, 'jobs')
  writeFileSync(fakeCli, `#!/usr/bin/env bash
printf '%s\n' '{"result":"done","session_id":"session-addressable","is_error":false}'
`)
  chmodSync(fakeCli, 0o700)

  const child = spawn('bun', [SERVER], {
    cwd: dir,
    env: {
      ...process.env,
      ...DEBUG_TOOLS_ENV,
      CAT_CODE_CLI: fakeCli,
      GPT_AGENT_BACKGROUND_DIR: jobs,
      GPT_AGENT_TIMEOUT_MS: '5000',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  try {
    const startResponse = await callTool(child, 1, 'spawn_gpt_agent', {
      prompt: 'background task',
      description: 'display label',
      run_in_background: true,
    })
    const startText = startResponse.result.content[0].text
    const jobId = startText.match(/job_id: (job_[a-zA-Z0-9-]+)/)?.[1]

    expect(jobId).toBeString()
    expect(startText).toContain('Started GPT "GPT 1" in the background.')
    expect(startText).not.toContain('Started GPT "display label"')
    expect(startText).toContain('send_gpt_agent_message')
    expect(startText).not.toContain('followup_tool: spawn_gpt_agent')
    expect(startText).not.toContain('delivery: one-shot')

    await waitForFile(join(jobs, jobId!, 'result.json'), 4000)
    const resultResponse = await callTool(child, 2, 'get_gpt_agent_job_result', { job_id: jobId })
    const result = JSON.parse(resultResponse.result.content[0].text)

    expect(result.name).toBe('GPT 1')

	    const secondResponse = await callTool(child, 3, 'spawn_gpt_agent', {
	      prompt: 'second background task',
	      description: 'second display label',
	      run_in_background: true,
	    })
	    const secondText = secondResponse.result.content[0].text
	    const secondJobId = secondText.match(/job_id: (job_[a-zA-Z0-9-]+)/)?.[1]
	    expect(secondJobId).toBeString()
	    expect(secondText).toContain('Started GPT "GPT 2" in the background.')
	    expect(secondText).not.toContain('Started GPT "second display label"')
	    await waitForFile(join(jobs, secondJobId!, 'result.json'), 4000)
  } finally {
    child.kill('SIGTERM')
    rmSync(dir, { recursive: true, force: true })
  }
})

test('default background spawn response does not advertise hidden debug tools', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gpt-agent-bg-default-response-'))
  const fakeCli = join(dir, 'cat-code')
  const jobs = join(dir, 'jobs')
  writeFileSync(fakeCli, `#!/usr/bin/env bash
printf '%s\n' '{"result":"done","session_id":"session-bg-default","is_error":false}'
`)
  chmodSync(fakeCli, 0o700)

  const child = spawn('bun', [SERVER], {
    cwd: dir,
    env: {
      ...process.env,
      CAT_CODE_CLI: fakeCli,
      GPT_AGENT_BACKGROUND_DIR: jobs,
      GPT_AGENT_TIMEOUT_MS: '5000',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  try {
    const response = await callTool(child, 1, 'spawn_gpt_agent', {
      name: 'Default Background',
      prompt: 'background task',
      run_in_background: true,
    })
    const text = response.result.content[0].text

    expect(response.result.isError).toBe(false)
    expect(text).toContain('Started GPT "Default Background" in the background.')
    expect(text).toContain('send_gpt_agent_message')
    expect(text).toContain('Debug job_id:')
    expect(text).not.toContain('get_gpt_agent_job_status')
    expect(text).not.toContain('get_gpt_agent_job_result')
    expect(text).not.toContain('wait_for_gpt_agent_job')
    expect(text).not.toContain('tail_gpt_agent_job_log')
    expect(text).not.toContain('cancel_gpt_agent_job')
    expect(text).not.toContain('status_tool:')
  } finally {
    child.kill('SIGTERM')
    rmSync(dir, { recursive: true, force: true })
  }
})

test('named GPTs can be listed and continued by message', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gpt-agent-named-flow-'))
  const fakeCli = join(dir, 'cat-code')
  const jobs = join(dir, 'jobs')
  const store = join(dir, 'conversations.json')
  writeFileSync(fakeCli, `#!/usr/bin/env bash
args=" $* "
	if [[ "$args" == *" --resume session-first "* ]]; then
  printf '%s\n' '{"result":"second result","session_id":"session-second","is_error":false}'
	elif [[ "$args" == *" --resume session-store "* ]]; then
	  printf '%s\n' '{"result":"store result","session_id":"session-store-2","is_error":false}'
else
  printf '%s\n' '{"result":"first result","session_id":"session-first","is_error":false}'
fi
`)
  chmodSync(fakeCli, 0o700)

  const child = spawn('bun', [SERVER], {
    cwd: dir,
    env: {
      ...process.env,
      CAT_CODE_CLI: fakeCli,
      GPT_AGENT_BACKGROUND_DIR: jobs,
      GPT_AGENT_STORE: store,
      GPT_AGENT_TIMEOUT_MS: '5000',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  try {
    const startResponse = await callTool(child, 1, 'spawn_gpt_agent', {
      name: 'Hooks Recon',
      prompt: 'first prompt',
      run_in_background: true,
    })
    const startText = startResponse.result.content[0].text
    const jobId = startText.match(/job_id: (job_[a-zA-Z0-9-]+)/)?.[1]
    expect(jobId).toBeString()

    await waitForFile(join(jobs, jobId!, 'result.json'), 4000)

    const listResponse = await callTool(child, 2, 'list_gpt_agents', {})
    const list = JSON.parse(listResponse.result.content[0].text)
    expect(list).toEqual([{ name: 'Hooks Recon', status: 'completed', last_job_id: jobId }])
    expect(listResponse.result.content[0].text).not.toContain('session-first')
    expect(listResponse.result.content[0].text).not.toContain('first prompt')
	    writeJson(store, { 'Hooks Recon': { sessionId: 'session-store', model: 'gpt-5.5' } })

    const sendResponse = await callTool(child, 3, 'send_gpt_agent_message', {
      to: 'Hooks Recon',
      message: 'second prompt',
    })
    expect(sendResponse.result.isError).toBe(false)
    expect(sendResponse.result.content[0].text).toContain('GPT "Hooks Recon" replied.')
    expect(sendResponse.result.content[0].text).toContain('second result')
	    expect(sendResponse.result.content[0].text).not.toContain('store result')
  } finally {
    child.kill('SIGTERM')
    rmSync(dir, { recursive: true, force: true })
  }
})

test('send_gpt_agent_message gates stale prompt caches from reconciled updatedAt', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gpt-agent-cache-gate-'))
  const fakeCli = join(dir, 'cat-code')
  const jobs = join(dir, 'jobs')
  const calls = join(dir, 'calls.log')
  writeFileSync(fakeCli, `#!/usr/bin/env bash
printf '%s\n' "$*" >> "$CALLS_LOG"
if [[ "$*" == *"--resume session-warn"* ]]; then
  printf '%s\n' '{"result":"warn continued","session_id":"session-warn-2","is_error":false}'
elif [[ "$*" == *"decline"* ]]; then
  printf '%s\n' '{"result":"decline created","session_id":"session-decline","is_error":false}'
else
  printf '%s\n' '{"result":"warn created","session_id":"session-warn","is_error":false}'
fi
`)
  chmodSync(fakeCli, 0o700)

  const child = spawn('bun', [SERVER], {
    cwd: dir,
    env: {
      ...process.env,
      CAT_CODE_CLI: fakeCli,
      CALLS_LOG: calls,
      GPT_AGENT_BACKGROUND_DIR: jobs,
      GPT_AGENT_TIMEOUT_MS: '5000',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  try {
    const warnStart = await callTool(child, 1, 'spawn_gpt_agent', {
      name: 'Warn Cache',
      prompt: 'warn create',
      model: 'gpt-5.4-mini',
      run_in_background: true,
    })
    const warnJobId = warnStart.result.content[0].text.match(/job_id: (job_[a-zA-Z0-9-]+)/)?.[1]
    expect(warnJobId).toBeString()
    await waitForFile(join(jobs, warnJobId!, 'result.json'), 4000)
    const warnStatusPath = join(jobs, warnJobId!, 'status.json')
    const warnStatus = JSON.parse(readFileSync(warnStatusPath, 'utf8'))
    warnStatus.updatedAt = new Date(Date.now() - 11 * 60 * 1000).toISOString()
    writeJson(warnStatusPath, warnStatus)

    const warnSend = await callTool(child, 2, 'send_gpt_agent_message', {
      to: 'Warn Cache',
      message: 'warn followup',
    })
    expect(warnSend.result.isError).toBe(false)
    expect(warnSend.result.content[0].text).toContain('Warning:')
    expect(warnSend.result.content[0].text).toContain('warn continued')

    const declineStart = await callTool(child, 3, 'spawn_gpt_agent', {
      name: 'Decline Cache',
      prompt: 'decline create',
      model: 'gpt-5.4-mini',
      run_in_background: true,
    })
    const declineJobId = declineStart.result.content[0].text.match(/job_id: (job_[a-zA-Z0-9-]+)/)?.[1]
    expect(declineJobId).toBeString()
    await waitForFile(join(jobs, declineJobId!, 'result.json'), 4000)
    const declineStatusPath = join(jobs, declineJobId!, 'status.json')
    const declineStatus = JSON.parse(readFileSync(declineStatusPath, 'utf8'))
    declineStatus.updatedAt = new Date(Date.now() - 61 * 60 * 1000).toISOString()
    writeJson(declineStatusPath, declineStatus)

    const beforeDeclineCalls = readFileSync(calls, 'utf8')
    const declined = await callTool(child, 4, 'send_gpt_agent_message', {
      to: 'Decline Cache',
      message: 'decline followup',
    })
    expect(declined.result.isError).toBe(true)
    expect(declined.result.content[0].text).toContain('too stale')
    expect(readFileSync(calls, 'utf8')).toBe(beforeDeclineCalls)
  } finally {
    child.kill('SIGTERM')
    rmSync(dir, { recursive: true, force: true })
  }
})

test('send_gpt_agent_message applies gpt-5.5 cache thresholds', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gpt-agent-cache-gate-long-'))
  const fakeCli = join(dir, 'cat-code')
  const jobs = join(dir, 'jobs')
  const calls = join(dir, 'calls.log')
  writeFileSync(fakeCli, `#!/usr/bin/env bash
printf '%s\n' "$*" >> "$CALLS_LOG"
if [[ "$*" == *"--resume session-long-warn"* ]]; then
  printf '%s\n' '{"result":"long warn continued","session_id":"session-long-warn-2","is_error":false}'
elif [[ "$*" == *"--resume session-long-decline"* ]]; then
  printf '%s\n' '{"result":"should not resume","session_id":"session-long-decline-2","is_error":false}'
elif [[ "$*" == *"long decline create"* ]]; then
  printf '%s\n' '{"result":"long decline created","session_id":"session-long-decline","is_error":false}'
else
  printf '%s\n' '{"result":"long warn created","session_id":"session-long-warn","is_error":false}'
fi
`)
  chmodSync(fakeCli, 0o700)

  const child = spawn('bun', [SERVER], {
    cwd: dir,
    env: {
      ...process.env,
      CAT_CODE_CLI: fakeCli,
      CALLS_LOG: calls,
      GPT_AGENT_BACKGROUND_DIR: jobs,
      GPT_AGENT_TIMEOUT_MS: '5000',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  try {
    const warnStart = await callTool(child, 1, 'spawn_gpt_agent', {
      name: 'Long Warn Cache',
      prompt: 'long warn create',
      run_in_background: true,
    })
    const warnJobId = warnStart.result.content[0].text.match(/job_id: (job_[a-zA-Z0-9-]+)/)?.[1]
    expect(warnJobId).toBeString()
    await waitForFile(join(jobs, warnJobId!, 'result.json'), 4000)
    const warnStatusPath = join(jobs, warnJobId!, 'status.json')
    const warnStatus = JSON.parse(readFileSync(warnStatusPath, 'utf8'))
    warnStatus.updatedAt = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString()
    writeJson(warnStatusPath, warnStatus)

    const warnSend = await callTool(child, 2, 'send_gpt_agent_message', {
      to: 'Long Warn Cache',
      message: 'long warn followup',
    })
    expect(warnSend.result.isError).toBe(false)
    expect(warnSend.result.content[0].text).toContain('Warning:')
    expect(warnSend.result.content[0].text).toContain('long warn continued')
    expect(readFileSync(calls, 'utf8')).toContain('--resume session-long-warn')

    const declineStart = await callTool(child, 3, 'spawn_gpt_agent', {
      name: 'Long Decline Cache',
      prompt: 'long decline create',
      run_in_background: true,
    })
    const declineJobId = declineStart.result.content[0].text.match(/job_id: (job_[a-zA-Z0-9-]+)/)?.[1]
    expect(declineJobId).toBeString()
    await waitForFile(join(jobs, declineJobId!, 'result.json'), 4000)
    const declineStatusPath = join(jobs, declineJobId!, 'status.json')
    const declineStatus = JSON.parse(readFileSync(declineStatusPath, 'utf8'))
    declineStatus.updatedAt = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString()
    writeJson(declineStatusPath, declineStatus)

    const beforeDeclineCalls = readFileSync(calls, 'utf8')
    const declined = await callTool(child, 4, 'send_gpt_agent_message', {
      to: 'Long Decline Cache',
      message: 'long decline followup',
    })
    expect(declined.result.isError).toBe(true)
    expect(declined.result.content[0].text).toContain('too stale')
    expect(readFileSync(calls, 'utf8')).toBe(beforeDeclineCalls)
  } finally {
    child.kill('SIGTERM')
    rmSync(dir, { recursive: true, force: true })
  }
})

test('spawn_gpt_agent errors on duplicate visible GPT names', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gpt-agent-duplicate-name-'))
  const fakeCli = join(dir, 'cat-code')
  writeFileSync(fakeCli, `#!/usr/bin/env bash
printf '%s\n' '{"result":"done","session_id":"session-duplicate","is_error":false}'
`)
  chmodSync(fakeCli, 0o700)

  const child = spawn('bun', [SERVER], {
    cwd: dir,
    env: {
      ...process.env,
      CAT_CODE_CLI: fakeCli,
      GPT_AGENT_TIMEOUT_MS: '5000',
      GPT_AGENT_STORE: join(dir, 'conversations.json'),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  try {
    const first = await callTool(child, 1, 'spawn_gpt_agent', {
      name: 'Hooks Recon',
      prompt: 'first prompt',
    })
    expect(first.result.isError).toBe(false)

    const duplicate = await callTool(child, 2, 'spawn_gpt_agent', {
      name: 'Hooks Recon',
      prompt: 'second prompt',
    })
    expect(duplicate.result.isError).toBe(true)
    expect(duplicate.result.content[0].text).toContain('already exists')
    expect(duplicate.result.content[0].text).toContain('send_gpt_agent_message')
  } finally {
    child.kill('SIGTERM')
    rmSync(dir, { recursive: true, force: true })
  }
})

test('concurrent foreground spawns reserve duplicate names before running', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gpt-agent-concurrent-spawn-'))
  const fakeCli = join(dir, 'cat-code')
  const calls = join(dir, 'calls.log')
  writeFileSync(fakeCli, `#!/usr/bin/env bash
printf 'run\n' >> "$CALLS_LOG"
sleep 0.3
printf '%s\n' '{"result":"done","session_id":"session-concurrent-spawn","is_error":false}'
`)
  chmodSync(fakeCli, 0o700)

  const child = spawn('bun', [SERVER], {
    cwd: dir,
    env: {
      ...process.env,
      CAT_CODE_CLI: fakeCli,
      CALLS_LOG: calls,
      GPT_AGENT_TIMEOUT_MS: '5000',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const client = createRpcClient(child)

  try {
    const responses = await Promise.all([
      client.callTool(1, 'spawn_gpt_agent', { name: 'Race GPT', prompt: 'race prompt' }),
      client.callTool(2, 'spawn_gpt_agent', { name: 'Race GPT', prompt: 'race prompt' }),
    ])

    expect(responses.filter(response => response.result.isError === false)).toHaveLength(1)
    expect(responses.filter(response => response.result.isError === true)).toHaveLength(1)
    expect(responses.find(response => response.result.isError === true)!.result.content[0].text).toContain('already exists')
    expect(readFileSync(calls, 'utf8').trim().split('\n')).toHaveLength(1)
  } finally {
    child.kill('SIGTERM')
    rmSync(dir, { recursive: true, force: true })
  }
})

test('spawn_gpt_agent replace_existing starts fresh only after terminal GPTs', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gpt-agent-replace-existing-'))
  const fakeCli = join(dir, 'cat-code')
  const calls = join(dir, 'calls.log')
  writeFileSync(fakeCli, `#!/usr/bin/env bash
printf '%s\n' "$*" >> "$CALLS_LOG"
printf '%s\n' '{"result":"done","session_id":"session-replaced","is_error":false}'
`)
  chmodSync(fakeCli, 0o700)

  const child = spawn('bun', [SERVER], {
    cwd: dir,
    env: {
      ...process.env,
      CAT_CODE_CLI: fakeCli,
      CALLS_LOG: calls,
      GPT_AGENT_TIMEOUT_MS: '5000',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  try {
    const first = await callTool(child, 1, 'spawn_gpt_agent', {
      name: 'Replace Me',
      prompt: 'first prompt',
    })
    expect(first.result.isError).toBe(false)

    const replaced = await callTool(child, 2, 'spawn_gpt_agent', {
      name: 'Replace Me',
      prompt: 'replacement prompt',
      replace_existing: true,
    })
    expect(replaced.result.isError).toBe(false)
    expect(readFileSync(calls, 'utf8')).not.toContain('--resume')
  } finally {
    child.kill('SIGTERM')
    rmSync(dir, { recursive: true, force: true })
  }
})

test('send_gpt_agent_message returns busy for running GPTs', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gpt-agent-busy-'))
  const fakeCli = join(dir, 'cat-code')
  const jobs = join(dir, 'jobs')
  writeFileSync(fakeCli, `#!/usr/bin/env bash
sleep 1
printf '%s\n' '{"result":"done","session_id":"session-busy","is_error":false}'
`)
  chmodSync(fakeCli, 0o700)

  const child = spawn('bun', [SERVER], {
    cwd: dir,
    env: {
      ...process.env,
      CAT_CODE_CLI: fakeCli,
      GPT_AGENT_BACKGROUND_DIR: jobs,
      GPT_AGENT_TIMEOUT_MS: '5000',
      GPT_AGENT_STORE: join(dir, 'conversations.json'),
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  try {
    const startResponse = await callTool(child, 1, 'spawn_gpt_agent', {
      name: 'Slow GPT',
      prompt: 'slow prompt',
      run_in_background: true,
    })
    expect(startResponse.result.isError).toBe(false)

    const busy = await callTool(child, 2, 'send_gpt_agent_message', {
      to: 'Slow GPT',
      message: 'follow-up',
    })
    expect(busy.result.isError).toBe(true)
    expect(busy.result.content[0].text).toContain('still running')
    expect(busy.result.content[0].text).toContain('list_gpt_agents')

    const replaceBusy = await callTool(child, 3, 'spawn_gpt_agent', {
      name: 'Slow GPT',
      prompt: 'replacement',
      replace_existing: true,
    })
    expect(replaceBusy.result.isError).toBe(true)
    expect(replaceBusy.result.content[0].text).toContain('list_gpt_agents')
  } finally {
    child.kill('SIGTERM')
    rmSync(dir, { recursive: true, force: true })
  }
})

test('concurrent foreground sends mark named GPT busy before running', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gpt-agent-concurrent-send-'))
  const fakeCli = join(dir, 'cat-code')
  const calls = join(dir, 'calls.log')
  writeFileSync(fakeCli, `#!/usr/bin/env bash
if [[ "$*" == *"follow"* ]]; then
  printf 'follow\n' >> "$CALLS_LOG"
  sleep 0.3
  printf '%s\n' '{"result":"followed","session_id":"session-followed","is_error":false}'
else
  printf 'create\n' >> "$CALLS_LOG"
  printf '%s\n' '{"result":"created","session_id":"session-created","is_error":false}'
fi
`)
  chmodSync(fakeCli, 0o700)

  const child = spawn('bun', [SERVER], {
    cwd: dir,
    env: {
      ...process.env,
      CAT_CODE_CLI: fakeCli,
      CALLS_LOG: calls,
      GPT_AGENT_TIMEOUT_MS: '5000',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const client = createRpcClient(child)

  try {
    const create = await client.callTool(1, 'spawn_gpt_agent', { name: 'Send Race', prompt: 'create prompt' })
    expect(create.result.isError).toBe(false)

    const responses = await Promise.all([
      client.callTool(2, 'send_gpt_agent_message', { to: 'Send Race', message: 'follow one' }),
      client.callTool(3, 'send_gpt_agent_message', { to: 'Send Race', message: 'follow two' }),
    ])

    expect(responses.filter(response => response.result.isError === false)).toHaveLength(1)
    expect(responses.filter(response => response.result.isError === true)).toHaveLength(1)
    expect(responses.find(response => response.result.isError === true)!.result.content[0].text).toContain('list_gpt_agents')
    expect(readFileSync(calls, 'utf8').trim().split('\n').filter(line => line === 'follow')).toHaveLength(1)
  } finally {
    child.kill('SIGTERM')
    rmSync(dir, { recursive: true, force: true })
  }
})

test('missing active job artifacts make named GPT non-busy and non-continuable', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gpt-agent-missing-artifacts-'))
  const fakeCli = join(dir, 'cat-code')
  const jobs = join(dir, 'jobs')
  writeFileSync(fakeCli, `#!/usr/bin/env bash
sleep 1
printf '%s\n' '{"result":"done","session_id":"session-missing","is_error":false}'
`)
  chmodSync(fakeCli, 0o700)

  const child = spawn('bun', [SERVER], {
    cwd: dir,
    env: {
      ...process.env,
      CAT_CODE_CLI: fakeCli,
      GPT_AGENT_BACKGROUND_DIR: jobs,
      GPT_AGENT_TIMEOUT_MS: '5000',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  try {
    const startResponse = await callTool(child, 1, 'spawn_gpt_agent', {
      name: 'Missing Artifacts',
      prompt: 'slow prompt',
      run_in_background: true,
    })
    const jobId = startResponse.result.content[0].text.match(/job_id: (job_[a-zA-Z0-9-]+)/)?.[1]
    expect(jobId).toBeString()

    rmSync(join(jobs, jobId!), { recursive: true, force: true })

    const listResponse = await callTool(child, 2, 'list_gpt_agents', {})
    const list = JSON.parse(listResponse.result.content[0].text)
    expect(list).toEqual([{ name: 'Missing Artifacts', status: 'failed', last_job_id: jobId }])

    const sendResponse = await callTool(child, 3, 'send_gpt_agent_message', {
      to: 'Missing Artifacts',
      message: 'follow-up',
    })
    expect(sendResponse.result.isError).toBe(true)
    expect(sendResponse.result.content[0].text).toContain('cannot be continued')
  } finally {
    child.kill('SIGTERM')
    rmSync(dir, { recursive: true, force: true })
  }
})

test('list_gpt_agents ignores global conversation store entries', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gpt-agent-list-no-global-'))
  const store = join(dir, 'conversations.json')
  writeJson(store, { 'Old Global GPT': { sessionId: 'session-old', model: 'gpt-5.5' } })

  const child = spawn('bun', [SERVER], {
    cwd: dir,
    env: { ...process.env, GPT_AGENT_STORE: store },
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  try {
    const response = await callTool(child, 1, 'list_gpt_agents', {})
    expect(JSON.parse(response.result.content[0].text)).toEqual([])
  } finally {
    child.kill('SIGTERM')
    rmSync(dir, { recursive: true, force: true })
  }
})

test('timeout foreground calls write timed_out audit records', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gpt-agent-audit-timeout-'))
  const fakeCli = join(dir, 'cat-code')
  const auditLog = join(dir, 'audit.jsonl')
  writeFileSync(fakeCli, `#!/usr/bin/env bash
sleep 5
`)
  chmodSync(fakeCli, 0o700)

  const child = spawn('bun', [SERVER], {
    cwd: dir,
    env: {
      ...process.env,
      CAT_CODE_CLI: fakeCli,
      GPT_AGENT_AUDIT_LOG: auditLog,
      GPT_AGENT_TIMEOUT_MS: '100',
      GPT_AGENT_KILL_GRACE_MS: '100',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  try {
    const response = await callTool(child, 1, 'spawn_gpt_agent', {
      prompt: 'timeout secret must not be audited',
      model: 'gpt-5.4-mini',
    }, { 'claudecode/toolUseId': 'toolu-timeout' })

    expect(response.result.isError).toBe(true)
    const records = readJsonl(auditLog)
    expect(records.at(-1)).toMatchObject({
      event: 'terminal',
      mode: 'foreground',
      status: 'timed_out',
      mcp_tool_use_id: 'toolu-timeout',
      timeout_ms: 100,
      kill_grace_ms: 100,
      process: {
        termination: 'timed out',
      },
    })
    expect(readFileSync(auditLog, 'utf8')).not.toContain('timeout secret')
  } finally {
    child.kill('SIGTERM')
    rmSync(dir, { recursive: true, force: true })
  }
})

test('invalid spawn arguments write a safe failed audit record', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gpt-agent-audit-invalid-'))
  const auditLog = join(dir, 'audit.jsonl')
  const child = spawn('bun', [SERVER], {
    cwd: dir,
    env: { ...process.env, GPT_AGENT_AUDIT_LOG: auditLog },
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  try {
    const response = await callTool(child, 7, 'spawn_gpt_agent', {
      prompt: 'validation secret must not be audited',
      model: 'bad-model',
    }, { 'claudecode/toolUseId': 'toolu-invalid' })

    expect(response.result.isError).toBe(true)
    const audit = readFileSync(auditLog, 'utf8')
    const records = readJsonl(auditLog)
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({
      event: 'terminal',
      status: 'failed',
      error_type: 'validation',
      mcp_request_id: 7,
      mcp_tool_use_id: 'toolu-invalid',
    })
    expect(audit).not.toContain('validation secret')
    expect(audit).not.toContain('bad-model')
  } finally {
    child.kill('SIGTERM')
    rmSync(dir, { recursive: true, force: true })
  }
})

test('spawn expands tilde in add_dirs', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gpt-agent-tilde-add-dir-'))
  const fakeCli = join(dir, 'cat-code')
  writeFileSync(fakeCli, `#!/usr/bin/env bash
printf '%s\n' '{"result":"done","session_id":"session-tilde","is_error":false}'
`)
  chmodSync(fakeCli, 0o700)

  const child = spawn('bun', [SERVER], {
    cwd: dir,
    env: {
      ...process.env,
      CAT_CODE_CLI: fakeCli,
      GPT_AGENT_AUDIT_LOG: join(dir, 'audit.jsonl'),
      GPT_AGENT_TIMEOUT_MS: '5000',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  try {
    const response = await callTool(child, 1, 'spawn_gpt_agent', {
      prompt: 'tilde path',
      add_dirs: ['~'],
    })

    expect(response.result.isError).toBe(false)
    expect(response.result.content[0].text).toContain('done')
  } finally {
    child.kill('SIGTERM')
    rmSync(dir, { recursive: true, force: true })
  }
})

test('tools/list exposes only named GPT tools by default', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gpt-agent-tools-default-'))
  const child = spawn('bun', [SERVER], {
    cwd: dir,
    env: { ...process.env, GPT_AGENT_STORE: join(dir, 'conversations.json') },
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  try {
    child.stdin?.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) + '\n')
    const response = await waitForLine(child, 4000)
    const names = response.result.tools.map((tool: { name: string }) => tool.name)
	    const spawnTool = response.result.tools.find((tool: { name: string }) => tool.name === 'spawn_gpt_agent')
	    const spawnProps = spawnTool.inputSchema.properties

    expect(names).toEqual(['spawn_gpt_agent', 'send_gpt_agent_message', 'list_gpt_agents'])
	    expect(spawnProps.conversation).toBeUndefined()
	    expect(spawnProps.reset_conversation).toBeUndefined()
	    expect(spawnProps.resume_session).toBeUndefined()
  } finally {
    child.kill('SIGTERM')
    rmSync(dir, { recursive: true, force: true })
  }
})

test('debug-only job tools cannot be called in default mode', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gpt-agent-debug-call-default-'))
  const child = spawn('bun', [SERVER], {
    cwd: dir,
    env: { ...process.env },
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  try {
    const response = await callTool(child, 1, 'get_gpt_agent_job_status', { job_id: 'job_11111111-1111-4111-8111-111111111111' })

    expect(response.result.isError).toBe(true)
    expect(response.result.content[0].text).toContain('GPT_AGENT_DEBUG_TOOLS=1')
  } finally {
    child.kill('SIGTERM')
    rmSync(dir, { recursive: true, force: true })
  }
})

test('spawn_gpt_agent rejects legacy conversation fields', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gpt-agent-legacy-fields-'))
  const child = spawn('bun', [SERVER], {
    cwd: dir,
    env: { ...process.env },
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  try {
    const conversation = await callTool(child, 1, 'spawn_gpt_agent', {
      conversation: 'Old Name',
      prompt: 'will not run',
    })
    const reset = await callTool(child, 2, 'spawn_gpt_agent', {
      name: 'Old Reset',
      prompt: 'will not run',
      reset_conversation: true,
    })

    expect(conversation.result.isError).toBe(true)
    expect(conversation.result.content[0].text).toContain('use name')
    expect(reset.result.isError).toBe(true)
    expect(reset.result.content[0].text).toContain('create-only')
  } finally {
    child.kill('SIGTERM')
    rmSync(dir, { recursive: true, force: true })
  }
})

test('tools/list exposes job-control tools in debug mode', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gpt-agent-tools-'))
  const child = spawn('bun', [SERVER], {
    cwd: dir,
    env: { ...process.env, ...DEBUG_TOOLS_ENV, GPT_AGENT_STORE: join(dir, 'conversations.json') },
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  try {
    child.stdin?.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) + '\n')
    const response = await waitForLine(child, 4000)
    const names = response.result.tools.map((tool: { name: string }) => tool.name)
    const spawnTool = response.result.tools.find((tool: { name: string }) => tool.name === 'spawn_gpt_agent')
    const spawnProps = spawnTool.inputSchema.properties

    expect(names).toContain('spawn_gpt_agent')
    expect(names).toContain('send_gpt_agent_message')
    expect(names).toContain('list_gpt_agents')
    expect(names).toContain('get_gpt_agent_job_status')
    expect(names).toContain('get_gpt_agent_job_result')
    expect(names).toContain('wait_for_gpt_agent_job')
    expect(names).toContain('tail_gpt_agent_job_log')
    expect(names).toContain('cancel_gpt_agent_job')
    expect(names).toContain('list_gpt_agent_jobs')
    expect(names).toContain('cleanup_gpt_agent_job')
    expect(spawnProps.name).toBeDefined()
	    expect(spawnProps.description).toBeDefined()
    expect(spawnProps.run_in_background.description).toContain('detached job')
    for (const tool of response.result.tools.filter((tool: { name: string }) => tool.name.includes('_job'))) {
	      expect(tool.description).toContain('detached GPT job')
	    }
    expect(spawnProps.conversation).toBeUndefined()
	    expect(spawnProps.reset_conversation).toBeUndefined()
    expect(spawnProps.resume_session).toBeUndefined()

  } finally {
    child.kill('SIGTERM')
    rmSync(dir, { recursive: true, force: true })
  }
})

test('cleanup_gpt_agent_job does not strand named GPTs busy', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gpt-agent-cleanup-named-'))
  const fakeCli = join(dir, 'cat-code')
  const jobs = join(dir, 'jobs')
  writeFileSync(fakeCli, `#!/usr/bin/env bash
printf '%s\n' '{"result":"done","session_id":"session-cleanup","is_error":false}'
`)
  chmodSync(fakeCli, 0o700)

  const child = spawn('bun', [SERVER], {
    cwd: dir,
    env: {
      ...process.env,
      ...DEBUG_TOOLS_ENV,
      CAT_CODE_CLI: fakeCli,
      GPT_AGENT_BACKGROUND_DIR: jobs,
      GPT_AGENT_TIMEOUT_MS: '5000',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  try {
    const startResponse = await callTool(child, 1, 'spawn_gpt_agent', {
      name: 'Cleanup GPT',
      prompt: 'cleanup task',
      run_in_background: true,
    })
    const jobId = startResponse.result.content[0].text.match(/job_id: (job_[a-zA-Z0-9-]+)/)?.[1]
    expect(jobId).toBeString()
    await waitForFile(join(jobs, jobId!, 'result.json'), 4000)

    const cleanup = await callTool(child, 2, 'cleanup_gpt_agent_job', { job_id: jobId })
    const listResponse = await callTool(child, 3, 'list_gpt_agents', {})
    const sendResponse = await callTool(child, 4, 'send_gpt_agent_message', {
      to: 'Cleanup GPT',
      message: 'follow-up',
    })
    const list = JSON.parse(listResponse.result.content[0].text)

    expect(cleanup.result.isError).toBe(false)
    expect(list).toEqual([{ name: 'Cleanup GPT', status: 'completed', last_job_id: jobId }])
    expect(sendResponse.result.isError).toBe(true)
    expect(sendResponse.result.content[0].text).toContain('cannot be continued')
  } finally {
    child.kill('SIGTERM')
    rmSync(dir, { recursive: true, force: true })
  }
})

test('run_in_background survives MCP server exit and result is retrievable', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gpt-agent-bg-'))
  const fakeCli = join(dir, 'cat-code')
  const store = join(dir, 'conversations.json')
  const jobs = join(dir, 'jobs')
  writeFileSync(fakeCli, `#!/usr/bin/env bash
sleep 1
printf '%s\n' '{"result":"done","session_id":"session-bg","is_error":false}'
`)
  chmodSync(fakeCli, 0o700)

  const env = {
    ...process.env,
    ...DEBUG_TOOLS_ENV,
    CAT_CODE_CLI: fakeCli,
    GPT_AGENT_STORE: store,
    GPT_AGENT_BACKGROUND_DIR: jobs,
    GPT_AGENT_AUDIT_LOG: join(dir, 'audit.jsonl'),
    GPT_AGENT_TIMEOUT_MS: '5000',
  }
  const child = spawn('bun', [SERVER], {
    cwd: dir,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  try {
    const started = Date.now()
    const startResponse = await callTool(child, 1, 'spawn_gpt_agent', {
      prompt: 'slow task',
	    name: 'Background task shape',
      run_in_background: true,
    })
    const startText = startResponse.result.content[0].text
    const jobId = startText.match(/job_id: (job_[a-zA-Z0-9-]+)/)?.[1]

    expect(Date.now() - started).toBeLessThan(750)
    expect(startResponse.result.isError).toBe(false)
    expect(jobId).toBeString()

    child.kill('SIGTERM')
    await waitForFile(join(jobs, jobId!, 'result.json'), 4000)

    const second = spawn('bun', [SERVER], {
      cwd: dir,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    try {
      const resultResponse = await callTool(second, 2, 'get_gpt_agent_job_result', { job_id: jobId })
      const resultText = resultResponse.result.content[0].text

      expect(resultResponse.result.isError).toBe(false)
      expect(resultText).toContain('done')
	  expect(resultText).toContain('Background task shape')
	  expect(resultText).not.toContain('session-bg')
	  expect(resultResponse.result.content.at(-1).text).toContain('[name: Background task shape]')
	  expect(existsSync(store)).toBe(false)
    } finally {
      second.kill('SIGTERM')
    }
  } finally {
    child.kill('SIGTERM')
    rmSync(dir, { recursive: true, force: true })
  }
})

test('background job stores display description without changing name', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gpt-agent-bg-description-'))
  const fakeCli = join(dir, 'cat-code')
  const jobs = join(dir, 'jobs')
  writeFileSync(fakeCli, `#!/usr/bin/env bash
printf '%s\n' '{"result":"done","session_id":"session-bg-description","is_error":false}'
`)
  chmodSync(fakeCli, 0o700)

  const child = spawn('bun', [SERVER], {
    cwd: dir,
    env: {
      ...process.env,
      ...DEBUG_TOOLS_ENV,
      CAT_CODE_CLI: fakeCli,
      GPT_AGENT_BACKGROUND_DIR: jobs,
      GPT_AGENT_TIMEOUT_MS: '5000',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  try {
    const startResponse = await callTool(child, 1, 'spawn_gpt_agent', {
      prompt: 'slow task',
      name: 'Persistent thread',
      description: 'display label',
      run_in_background: true,
    })
    const jobId = startResponse.result.content[0].text.match(/job_id: (job_[a-zA-Z0-9-]+)/)?.[1]
    expect(jobId).toBeString()

    await waitForFile(join(jobs, jobId!, 'result.json'), 4000)

    const statusResponse = await callTool(child, 2, 'get_gpt_agent_job_status', { job_id: jobId })
    const resultResponse = await callTool(child, 3, 'get_gpt_agent_job_result', { job_id: jobId })
    const listResponse = await callTool(child, 4, 'list_gpt_agent_jobs', {})
    const status = JSON.parse(statusResponse.result.content[0].text)
    const result = JSON.parse(resultResponse.result.content[0].text)
    const list = JSON.parse(listResponse.result.content[0].text)

    expect(status).toMatchObject({ name: 'Persistent thread', description: 'display label' })
    expect(result).toMatchObject({ name: 'Persistent thread', description: 'display label' })
    expect(list[0]).toMatchObject({ name: 'Persistent thread', description: 'display label' })
  } finally {
    child.kill('SIGTERM')
    rmSync(dir, { recursive: true, force: true })
  }
})

test('completed job result is parseable and self-describing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gpt-agent-result-json-'))
  const jobs = join(dir, 'jobs')
  const jobId = 'job_66666666-6666-4666-8666-666666666666'
  const jobDir = join(jobs, jobId)
  mkdirSync(jobDir, { recursive: true })
  const paths = {
    request: join(jobDir, 'request.json'),
    status: join(jobDir, 'status.json'),
    result: join(jobDir, 'result.json'),
    stdout: join(jobDir, 'stdout.log'),
    stderr: join(jobDir, 'stderr.log'),
  }
  writeJson(paths.status, { jobId, status: 'completed', conversation: 'Completed job name', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), cwd: dir, paths })
  writeJson(paths.result, { text: 'done', sessionId: 'session-json', isError: false, status: 'completed' })

  const child = spawn('bun', [SERVER], {
    cwd: dir,
    env: { ...process.env, ...DEBUG_TOOLS_ENV, GPT_AGENT_BACKGROUND_DIR: jobs },
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  try {
    const response = await callTool(child, 1, 'get_gpt_agent_job_result', { job_id: jobId })
    const result = JSON.parse(response.result.content[0].text)
    const listResponse = await callTool(child, 2, 'list_gpt_agent_jobs', {})
    const jobsList = JSON.parse(listResponse.result.content[0].text)

    expect(result).toMatchObject({
      job_id: jobId,
      status: 'completed',
      ready: true,
      name: 'Completed job name',
      text: 'done',
    })
    expect(result.session_id).toBeUndefined()
    expect(jobsList[0]).toMatchObject({ job_id: jobId, name: 'Completed job name' })
    expect(jobsList[0].conversation).toBeUndefined()
  } finally {
    child.kill('SIGTERM')
    rmSync(dir, { recursive: true, force: true })
  }
})

test('wait_for_gpt_agent_job waits until a background result is ready', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gpt-agent-wait-'))
  const fakeCli = join(dir, 'cat-code')
  const jobs = join(dir, 'jobs')
  writeFileSync(fakeCli, `#!/usr/bin/env bash
sleep 0.2
printf '%s\n' '{"result":"done","session_id":"session-wait","is_error":false}'
`)
  chmodSync(fakeCli, 0o700)

  const child = spawn('bun', [SERVER], {
    cwd: dir,
    env: {
      ...process.env,
      ...DEBUG_TOOLS_ENV,
      CAT_CODE_CLI: fakeCli,
      GPT_AGENT_BACKGROUND_DIR: jobs,
      GPT_AGENT_TIMEOUT_MS: '5000',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  try {
    const startResponse = await callTool(child, 1, 'spawn_gpt_agent', {
      prompt: 'slow task',
	    name: 'Wait job name',
      run_in_background: true,
    })
    const jobId = startResponse.result.content[0].text.match(/job_id: (job_[a-zA-Z0-9-]+)/)?.[1]
    expect(jobId).toBeString()

    const waitResponse = await callTool(child, 2, 'wait_for_gpt_agent_job', { job_id: jobId, timeout_ms: 3000 })
    const result = JSON.parse(waitResponse.result.content[0].text)

    expect(result).toMatchObject({
      job_id: jobId,
      status: 'completed',
      ready: true,
	    name: 'Wait job name',
      text: 'done',
    })
	  expect(result.session_id).toBeUndefined()
  } finally {
    child.kill('SIGTERM')
    rmSync(dir, { recursive: true, force: true })
  }
})

test('named GPT creation ignores corrupt global conversation store', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gpt-agent-corrupt-store-'))
  const store = join(dir, 'conversations.json')
  const fakeCli = join(dir, 'cat-code')
  writeFileSync(store, '{broken')
  writeFileSync(fakeCli, `#!/usr/bin/env bash
printf '%s\n' '{"result":"done","session_id":"session-ignore-store","is_error":false}'
`)
  chmodSync(fakeCli, 0o700)

  const child = spawn('bun', [SERVER], {
    cwd: dir,
    env: {
      ...process.env,
      CAT_CODE_CLI: fakeCli,
      GPT_AGENT_STORE: store,
      GPT_AGENT_AUDIT_LOG: join(dir, 'audit.jsonl'),
      GPT_AGENT_TIMEOUT_MS: '5000',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  try {
    const response = await callTool(child, 1, 'spawn_gpt_agent', {
      prompt: 'will run',
	      name: 'locked-conv',
    })

    expect(response.result.isError).toBe(false)
    expect(readFileSync(store, 'utf8')).toBe('{broken')
    expect(existsSync(`${store}.locks/conversation-locked-conv.lock`)).toBe(false)
  } finally {
    child.kill('SIGTERM')
    rmSync(dir, { recursive: true, force: true })
  }
})

test('active status reconciles from existing terminal result', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gpt-agent-reconcile-'))
  const jobs = join(dir, 'jobs')
  const jobId = 'job_11111111-1111-4111-8111-111111111111'
  const jobDir = join(jobs, jobId)
  mkdirSync(jobDir, { recursive: true })
  const paths = {
    request: join(jobDir, 'request.json'),
    status: join(jobDir, 'status.json'),
    result: join(jobDir, 'result.json'),
    stdout: join(jobDir, 'stdout.log'),
    stderr: join(jobDir, 'stderr.log'),
  }
  writeJson(paths.status, { jobId, status: 'running', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), cwd: dir, paths })
  writeJson(paths.result, { text: 'done', sessionId: 'session-reconciled', isError: false, status: 'completed' })

  const child = spawn('bun', [SERVER], {
    cwd: dir,
    env: { ...process.env, ...DEBUG_TOOLS_ENV, GPT_AGENT_BACKGROUND_DIR: jobs },
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  try {
    const response = await callTool(child, 1, 'get_gpt_agent_job_status', { job_id: jobId })
    const status = JSON.parse(response.result.content[0].text)

    expect(status.status).toBe('completed')
    expect(status.session_id).toBeUndefined()
  } finally {
    child.kill('SIGTERM')
    rmSync(dir, { recursive: true, force: true })
  }
})

test('dead background worker reconciliation writes terminal audit record', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gpt-agent-dead-worker-audit-'))
  const jobs = join(dir, 'jobs')
  const auditLog = join(dir, 'audit.jsonl')
  const jobId = 'job_55555555-5555-4555-8555-555555555555'
  const jobDir = join(jobs, jobId)
  mkdirSync(jobDir, { recursive: true })
  const paths = {
    request: join(jobDir, 'request.json'),
    status: join(jobDir, 'status.json'),
    result: join(jobDir, 'result.json'),
    stdout: join(jobDir, 'stdout.log'),
    stderr: join(jobDir, 'stderr.log'),
  }
  writeJson(paths.request, {
    args: {
      prompt: 'dead worker secret must not be audited',
      explicitModel: 'gpt-5.4-mini',
      addDirs: [],
      resetConversation: false,
      runInBackground: true,
    },
    cwd: dir,
    createdAt: new Date().toISOString(),
    audit: { requestId: 55, toolUseId: 'toolu-dead-worker' },
  })
  writeJson(paths.status, { jobId, status: 'running', workerPid: 999999999, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), cwd: dir, paths })

  const child = spawn('bun', [SERVER], {
    cwd: dir,
    env: { ...process.env, ...DEBUG_TOOLS_ENV, GPT_AGENT_BACKGROUND_DIR: jobs, GPT_AGENT_AUDIT_LOG: auditLog },
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  try {
    const response = await callTool(child, 1, 'get_gpt_agent_job_status', { job_id: jobId })
    const status = JSON.parse(response.result.content[0].text)
    const audit = readFileSync(auditLog, 'utf8')
    const records = readJsonl(auditLog)

    expect(status.status).toBe('failed')
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({
      event: 'terminal',
      mode: 'background',
      status: 'failed',
      mcp_request_id: 55,
      mcp_tool_use_id: 'toolu-dead-worker',
      job_id: jobId,
      model: 'gpt-5.4-mini',
    })
    expect(audit).not.toContain('dead worker secret')
  } finally {
    child.kill('SIGTERM')
    rmSync(dir, { recursive: true, force: true })
  }
})

test('dead cancelling worker becomes cancelled result instead of not-ready', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gpt-agent-cancelled-'))
  const jobs = join(dir, 'jobs')
  const jobId = 'job_22222222-2222-4222-8222-222222222222'
  const jobDir = join(jobs, jobId)
  mkdirSync(jobDir, { recursive: true })
  const paths = {
    request: join(jobDir, 'request.json'),
    status: join(jobDir, 'status.json'),
    result: join(jobDir, 'result.json'),
    stdout: join(jobDir, 'stdout.log'),
    stderr: join(jobDir, 'stderr.log'),
  }
  writeJson(paths.status, { jobId, status: 'cancelling', workerPid: 999999999, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), cwd: dir, paths })

  const child = spawn('bun', [SERVER], {
    cwd: dir,
    env: { ...process.env, ...DEBUG_TOOLS_ENV, GPT_AGENT_BACKGROUND_DIR: jobs },
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  try {
    const response = await callTool(child, 1, 'get_gpt_agent_job_result', { job_id: jobId })
    const result = JSON.parse(response.result.content[0].text)

    expect(response.result.isError).toBe(false)
    expect(result).toMatchObject({ job_id: jobId, status: 'cancelled', ready: true, is_error: false })
    expect(existsSync(paths.result)).toBe(true)
  } finally {
    child.kill('SIGTERM')
    rmSync(dir, { recursive: true, force: true })
  }
})

test('tail log returns only requested final lines from a large log', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gpt-agent-tail-'))
  const jobs = join(dir, 'jobs')
  const jobId = 'job_33333333-3333-4333-8333-333333333333'
  const jobDir = join(jobs, jobId)
  mkdirSync(jobDir, { recursive: true })
  const paths = {
    request: join(jobDir, 'request.json'),
    status: join(jobDir, 'status.json'),
    result: join(jobDir, 'result.json'),
    stdout: join(jobDir, 'stdout.log'),
    stderr: join(jobDir, 'stderr.log'),
  }
  writeJson(paths.status, { jobId, status: 'completed', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), cwd: dir, paths })
  writeFileSync(paths.stdout, Array.from({ length: 2000 }, (_, i) => `line-${i}`).join('\n') + '\n')

  const child = spawn('bun', [SERVER], {
    cwd: dir,
    env: { ...process.env, ...DEBUG_TOOLS_ENV, GPT_AGENT_BACKGROUND_DIR: jobs },
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  try {
    const response = await callTool(child, 1, 'tail_gpt_agent_job_log', { job_id: jobId, lines: 2 })
    const text = response.result.content[0].text

    expect(text).toContain('line-1998')
    expect(text).toContain('line-1999')
    expect(text).not.toContain('line-0')
  } finally {
    child.kill('SIGTERM')
    rmSync(dir, { recursive: true, force: true })
  }
})

test('terminal missing result returns bounded logs instead of generic fallback', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gpt-agent-terminal-log-'))
  const jobs = join(dir, 'jobs')
  const jobId = 'job_44444444-4444-4444-8444-444444444444'
  const jobDir = join(jobs, jobId)
  mkdirSync(jobDir, { recursive: true })
  const paths = {
    request: join(jobDir, 'request.json'),
    status: join(jobDir, 'status.json'),
    result: join(jobDir, 'result.json'),
    stdout: join(jobDir, 'stdout.log'),
    stderr: join(jobDir, 'stderr.log'),
  }
  writeJson(paths.status, { jobId, status: 'completed', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), cwd: dir, paths })
  writeFileSync(paths.stdout, 'terminal stdout line 1\nterminal stdout line 2\n')
  writeFileSync(paths.stderr, '')

  const child = spawn('bun', [SERVER], {
    cwd: dir,
    env: { ...process.env, ...DEBUG_TOOLS_ENV, GPT_AGENT_BACKGROUND_DIR: jobs },
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  try {
    const response = await callTool(child, 1, 'get_gpt_agent_job_result', { job_id: jobId })
    const result = JSON.parse(response.result.content[0].text)

    expect(response.result.isError).toBe(false)
    expect(result).toMatchObject({ job_id: jobId, status: 'completed', ready: true, has_result: false })
    expect(result.text).toContain('terminal stdout line 1')
    expect(result.text).toContain('terminal stdout line 2')
    expect(result.text).not.toContain('no result artifact was written')
  } finally {
    child.kill('SIGTERM')
    rmSync(dir, { recursive: true, force: true })
  }
})
