import { mock } from 'bun:test'
import { utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

const root = process.env.EXTERNAL_READ_CHANGES_TEST_ROOT
if (!root || process.env.HOME !== root || process.cwd() !== join(root, 'workspace')) {
  throw new Error('Isolated fixture required')
}
function refuseNetwork(): never { throw new Error('Network forbidden') }
globalThis.fetch = Object.assign(refuseNetwork, { preconnect: refuseNetwork })
Object.assign(globalThis, { MACRO: { VERSION: 'external-read-changes-test' } })

const files = [
  { name: 'full.txt', original: 'original-full-line\nsecond-line\n' },
  { name: 'limited.txt', original: 'original-limited-line\nhidden-line\n', range: { limit: 1 } },
  { name: 'offset.txt', original: 'hidden-line\noriginal-offset-line\n', range: { offset: 2 } },
  { name: 'truncated.txt', original: `original-truncated-line\n${'x\n'.repeat(2100)}` },
  { name: 'grown.txt', original: 'original-grown-line\n' },
  { name: 'preserved.txt', original: 'before-preserved-line\n' },
]
for (const { name, original } of files) {
  await writeFile(name, original)
  await utimes(name, 1, 1)
}

type ProviderRequest = {
  stream: boolean
  messages: Array<{ content: unknown }>
}
function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map(textOf).join('\n')
  if (content && typeof content === 'object') {
    if ('text' in content) return textOf(content.text)
    if ('content' in content) return textOf(content.content)
  }
  return ''
}

const requests: ProviderRequest[] = []
mock.module('../services/api/client.js', () => ({
  CLIENT_REQUEST_ID_HEADER: 'x-client-request-id',
  resolveCodexOAuthTokensForLeaseOwner: refuseNetwork,
  getAnthropicClient: async () => ({ beta: { messages: { create: (body: ProviderRequest) => {
    if (!body.stream || requests.length >= 3) throw new Error('Unexpected provider request')
    const round = requests.push(body)
    const issuingReads = round === 1
    const stream = Object.assign((async function* () {
      yield { type: 'message_start', message: {
        id: `response-${round}`, type: 'message', role: 'assistant', model: 'claude-sonnet-4-5',
        content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 20, output_tokens: 0 },
      } }
      if (issuingReads) {
        for (const [index, file] of files.entries()) {
          yield { type: 'content_block_start', index, content_block: { type: 'tool_use', id: `read-${index}`, name: 'Read', input: {} } }
          const input = { file_path: join(process.cwd(), file.name), ...file.range }
          yield { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } }
          yield { type: 'content_block_stop', index }
        }
      } else {
        yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }
        yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Finished.' } }
        yield { type: 'content_block_stop', index: 0 }
      }
      yield { type: 'message_delta', delta: { stop_reason: issuingReads ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 12 } }
      yield { type: 'message_stop' }
    })(), { controller: new AbortController() })
    return { withResponse: async () => ({ data: stream, request_id: `request-${round}`, response: new Response('') }) }
  } } } }),
}))

const { enableConfigs } = await import('../utils/config.js')
const { getDefaultAppState } = await import('../state/AppStateStore.js')
const { createFileStateCacheWithSizeLimit } = await import('../utils/fileStateCache.js')
const { createQueryEngineAppSession } = await import('./createQueryEngineAppSession.js')
const { FileReadTool } = await import('../tools/FileReadTool/FileReadTool.js')
enableConfigs()
let state = getDefaultAppState()
const session = createQueryEngineAppSession({
  cwd: process.cwd(), tools: [FileReadTool], commands: [], mcpClients: [], agents: [],
  getAppState: () => state, setAppState: update => { state = update(state) },
  readFileCache: createFileStateCacheWithSizeLimit(20), customSystemPrompt: 'Read the local fixture files.',
  userSpecifiedModel: 'claude-sonnet-4-5', recordTranscript: async () => null,
})
try {
  for await (const _ of session.submitMessage('Read the fixture files.')) { /* drain the first turn */ }
  const editor = Bun.spawnSync([process.execPath, '-e', String.raw`
    import { readFileSync, utimesSync, writeFileSync } from 'node:fs';
    for (const name of process.argv.slice(1)) {
      const edited = readFileSync(name, 'utf8').replace('original-', 'edited-').replace('before-', 'edited-');
      writeFileSync(name, name === 'grown.txt' ? edited + 'x\n'.repeat(2100) : edited);
      utimesSync(name, 5, name === 'preserved.txt' ? 1 : 5);
    }
  `, ...files.map(file => file.name)])
  if (editor.exitCode !== 0) throw new Error(`Outside edit failed: ${editor.stderr.toString()}`)
  for await (const _ of session.submitMessage('Continue with the next turn.')) { /* drain the second turn */ }
  if (requests.length !== 3) throw new Error(`Expected three provider requests, received ${requests.length}`)
  const resultBlocks = requests[1]!.messages.flatMap(message => Array.isArray(message.content)
    ? message.content.filter(block => block.type === 'tool_result')
    : [])
  const readResults = files.map((_, index) => textOf(resultBlocks.find(block => block.tool_use_id === `read-${index}`)))
  const nextTurn = requests[2]!.messages.map(({ content }) =>
    textOf(Array.isArray(content) ? content.filter(block => block.type === 'text') : content),
  ).join('\n')
  console.log(JSON.stringify({ readResults, nextTurn }))
} finally {
  session.dispose?.()
}
process.exit(0)
