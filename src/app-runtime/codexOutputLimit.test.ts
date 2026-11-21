import { expect, test } from 'bun:test'
import { mkdir, mkdtemp, readFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

type Transport = 'http' | 'websocket'
type Scenario = 'continue' | 'limit' | 'streamed-tool' | 'terminal-tool'
type Evidence = {
  requests: Array<{
    transport: Transport
    body: {
      input: Array<{ role?: string; content?: string | Array<{ text?: string }> }>
      previous_response_id?: string
    }
  }>
  result: { type: string; is_error: boolean; result?: string }
  wroteFile: boolean
}

async function capture(transport: Transport, scenario: Scenario): Promise<Evidence> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'codex-output-limit-')))
  try {
    await Promise.all([mkdir(join(root, 'config')), mkdir(join(root, 'workspace'))])
    const child = Bun.spawn([
      process.execPath, '--feature=CODE_MODE',
      new URL('./codexOutputLimit.fixture.ts', import.meta.url).pathname, transport, scenario,
    ], {
      cwd: join(root, 'workspace'), stdout: 'pipe', stderr: 'pipe',
      env: {
        PATH: process.env.PATH, HOME: root, TMPDIR: root,
        CLAUDE_CONFIG_DIR: join(root, 'config'), XDG_CONFIG_HOME: join(root, 'config'),
        CLAUDE_CODE_USE_OPENAI: '1', ANTHROPIC_API_KEY: 'fixture-not-a-credential',
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', DISABLE_TELEMETRY: '1',
        DISABLE_AUTO_COMPACT: '1', ENABLE_TOOL_SEARCH: 'false',
      },
    })
    const timer = setTimeout(() => child.kill(), 15_000)
    const [code, stdout, stderr] = await Promise.all([
      child.exited, new Response(child.stdout).text(), new Response(child.stderr).text(),
    ]).finally(() => clearTimeout(timer))
    if (code !== 0) throw new Error(`Codex fixture (${transport}/${scenario}) failed (${code}): ${stderr}\n${stdout}`)
    return JSON.parse(await readFile(join(root, 'evidence.json'), 'utf8'))
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

function expectContinuation(request: Evidence['requests'][number], lastParagraph: number) {
  expect(request.body.previous_response_id).toBeUndefined()
  const assistantText = request.body.input.filter(item => item.role === 'assistant')
    .flatMap(({ content }) => typeof content === 'string' ? [content] : content?.map(block => block.text) ?? [])
  expect(assistantText).toEqual(Array.from({ length: lastParagraph + 1 }, (_, index) => `Delivered paragraph ${index}.`))
  const resume = request.body.input.at(-1)
  expect(resume?.role).toBe('user')
  const text = typeof resume?.content === 'string' ? resume.content : resume?.content?.[0]?.text
  expect(text).toContain('Output token limit hit. Resume directly')
}

for (const transport of ['http', 'websocket'] as const) {
  test(`Codex continues delivered text after an output limit over ${transport}`, async () => {
    const { requests, result } = await capture(transport, 'continue')
    expect(requests.map(request => request.transport)).toEqual([transport, transport])
    expectContinuation(requests[1]!, 0)
    expect(result).toMatchObject({ type: 'result', is_error: false, result: 'Delivered paragraph 1.' })
  }, 20_000)

  test(`Codex respects the output-token recovery limit over ${transport}`, async () => {
    const { requests, result } = await capture(transport, 'limit')
    expect(requests.map(request => request.transport)).toEqual(Array(4).fill(transport))
    for (const [index, request] of requests.slice(1).entries()) expectContinuation(request, index)
    expect(result).toMatchObject({ type: 'result', is_error: true })
  }, 20_000)

  for (const scenario of ['streamed-tool', 'terminal-tool'] as const) {
    test(`Codex does not continue an output-limited ${scenario} call over ${transport}`, async () => {
      const { requests, result, wroteFile } = await capture(transport, scenario)
      expect(requests.map(request => request.transport)).toEqual([transport])
      expect(result).toMatchObject({ type: 'result', is_error: true })
      expect(wroteFile).toBe(false)
    }, 20_000)
  }
}
