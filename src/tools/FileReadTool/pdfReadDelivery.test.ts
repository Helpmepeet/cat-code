import { afterAll, afterEach, beforeEach, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ToolUseContext } from '../../Tool.js'

const scratch = mkdtempSync(join(tmpdir(), 'pdf-read-delivery-'))
const savedEnv = { ...process.env }
const originalFetch = globalThis.fetch
const macroState = globalThis as typeof globalThis & { MACRO?: { VERSION: string } }
const originalMacro = macroState.MACRO
Object.assign(process.env, {
  CLAUDE_CONFIG_DIR: scratch, CLAUDE_CODE_TEST_FIXTURES_ROOT: scratch,
  CLAUDE_CODE_SIMPLE: '1', CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
})
macroState.MACRO = { VERSION: 'test-version' }
globalThis.fetch = Object.assign(async () => {
  throw new Error('Unexpected network request in PDF delivery test')
}, { preconnect: originalFetch.preconnect })
const state = await import('../../bootstrap/state.js')
const { FileReadTool, callFileReadToolWithPreparedCapability } = await import('./FileReadTool.js')
const { getEmptyToolPermissionContext } = await import('../../Tool.js')
const { createFileStateCacheWithSizeLimit } = await import('../../utils/fileStateCache.js')
const { normalizeMessagesForAPI, createAssistantMessage, createUserMessage } = await import('../../utils/messages.js')
const { createCodexFetch, translateToCodexBody } = await import('../../services/api/codex-fetch-adapter.js')
const { createCodexCredentialHandle } = await import('../../services/api/codexCredentialUse.js')
const { createCodexCredentialLifecycle } = await import('../../services/api/codexCredentialLifecycle.js')
const { runWithCwdOverride } = await import('../../utils/cwd.js')
const { resetPdftoppmCache, isPdftoppmAvailable } = await import('../../utils/pdf.js')
const hasRenderer = await isPdftoppmAvailable()

const lifecycle = createCodexCredentialLifecycle({ directory: join(scratch, 'lifecycle') })
await lifecycle.withTransaction('pdf-replay-test', { operationKind: 'legacy_bootstrap' }, permit => {
  lifecycle.legacyBootstrap(permit, { validatedUntaggedLegacyCredentials: true })
})
const credential = createCodexCredentialHandle({
  accountId: 'pdf-replay-test', accessToken: 'synthetic-local-access', refreshToken: 'synthetic-local-refresh',
  expiresAt: Date.now() + 3_600_000, credentialGeneration: 1,
  credentialSource: 'config', credentialPath: join(scratch, 'replay-credential.json'),
})
writeFileSync(credential.credentialPath, JSON.stringify({ codexOAuth: credential }))

beforeEach(() => {
  state.resetStateForTests()
  state.setSessionProvider('firstParty')
  state.setMainLoopModelOverride('claude-sonnet-4-6')
  resetPdftoppmCache()
})
afterEach(() => {
  process.env.PATH = savedEnv.PATH
  resetPdftoppmCache()
  state.resetStateForTests()
})
afterAll(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in savedEnv)) delete process.env[key]
  }
  Object.assign(process.env, savedEnv)
  globalThis.fetch = originalFetch
  macroState.MACRO = originalMacro
  rmSync(scratch, { recursive: true, force: true })
})

function writePDF(pages: number): string {
  const pageObjects = Array.from({ length: pages }, (_, index) => 3 + index)
  const streamObject = 3 + pages
  const fontObject = streamObject + 1
  const stream = 'BT /F1 12 Tf 40 740 Td (PDF delivery contract) Tj ET\n'
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    `<< /Type /Pages /Kids [${pageObjects.map(id => `${id} 0 R`).join(' ')}] /Count ${pages} >>`,
    ...pageObjects.map(() => `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents ${streamObject} 0 R /Resources << /Font << /F1 ${fontObject} 0 R >> >> >>`),
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}endstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]
  let pdf = '%PDF-1.4\n'
  const offsets = [0]
  for (let index = 0; index < objects.length; index++) {
    offsets.push(Buffer.byteLength(pdf))
    pdf += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`
  }
  const xref = Buffer.byteLength(pdf)
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  pdf += offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  const path = join(scratch, `${pages}-pages.pdf`)
  writeFileSync(path, pdf)
  return path
}

function contextFor(model: string, provider: 'openai' | 'firstParty'): ToolUseContext {
  const appState = {
    toolPermissionContext: {
      ...getEmptyToolPermissionContext(), mode: 'bypassPermissions',
      isBypassPermissionsModeAvailable: true,
    },
    mcp: { tools: [], clients: [] }, tasks: {}, sessionHooks: new Map(),
  }
  return {
    options: {
      commands: [], debug: false, mainLoopModel: model, mainLoopProvider: provider,
      tools: [FileReadTool], verbose: false, thinkingConfig: { type: 'disabled' },
      mcpClients: [], mcpResources: {}, isNonInteractiveSession: true,
      agentDefinitions: { activeAgents: [], allAgents: [] },
    },
    abortController: new AbortController(), readFileState: createFileStateCacheWithSizeLimit(100),
    getAppState: () => appState, setAppState: () => {}, messages: [],
    setInProgressToolUseIDs: () => {}, setResponseLength: () => {},
    updateFileHistoryState: () => {}, updateAttributionState: () => {},
  } as unknown as ToolUseContext
}

test.skipIf(!hasRenderer)('a GPT worker full-PDF read delivers rendered page content to the Codex wire', async () => {
  // The process remains on Claude: the invoking worker decides PDF delivery.
  expect(await isPdftoppmAvailable()).toBe(true)
  const path = writePDF(2)
  const read = await runWithCwdOverride(scratch, () => callFileReadToolWithPreparedCapability(
    { file_path: path }, contextFor('gpt-6.1-sol', 'openai'), undefined, undefined, { userMentioned: true },
  ))
  expect(read.data.type).toBe('parts')
  const normalized = normalizeMessagesForAPI(read.newMessages!)
  const wire = translateToCodexBody({ model: 'gpt-6.1-sol', _openaiInstructionAssembly: {
    instructions: 'Summarize the pages.', inputMessages: normalized,
  } }).codexBody
  const content = (wire.input as Array<{ content: Array<{ type: string; image_url?: string }> }>).flatMap(message => message.content)
  expect(content).toHaveLength(2)
  expect(content.every(part => part.type === 'input_image' && part.image_url!.startsWith('data:image/jpeg;base64,'))).toBe(true)
  expect(FileReadTool.mapToolResultToToolResultBlockParam(read.data, 'pdf-read').content).toContain('PDF pages extracted: 2 page(s)')

  // Explicit page selection retains the same supported delivery route.
  const range = await runWithCwdOverride(scratch, () => callFileReadToolWithPreparedCapability(
    { file_path: path, pages: '2' }, contextFor('gpt-6.1-sol', 'openai'), undefined, undefined, { userMentioned: true },
  ))
  expect(range.data.type).toBe('parts')
  expect(range.newMessages![0]!.message.content).toHaveLength(1)

  const large = writePDF(11)
  const context = contextFor('gpt-6.1-sol', 'openai')
  await expect(runWithCwdOverride(scratch, () => callFileReadToolWithPreparedCapability(
    { file_path: large }, context, undefined, undefined, { userMentioned: true },
  ))).rejects.toThrow('Use the pages parameter')
  await expect(runWithCwdOverride(scratch, () => callFileReadToolWithPreparedCapability(
    { file_path: large, pages: '1-21' }, context, undefined, undefined, { userMentioned: true },
  ))).rejects.toThrow('exceeds maximum')
})

test('a Claude worker under a GPT parent preserves native PDF document content', async () => {
  state.setSessionProvider('openai')
  state.setMainLoopModelOverride('gpt-6.1-sol')
  const path = writePDF(1)
  const read = await runWithCwdOverride(scratch, () => callFileReadToolWithPreparedCapability(
    { file_path: path }, contextFor('claude-sonnet-4-6', 'firstParty'), undefined, undefined, { userMentioned: true },
  ))
  expect(read.data.type).toBe('pdf')
  const normalized = normalizeMessagesForAPI(read.newMessages!)
  expect(normalized[0]!.message.content).toEqual([expect.objectContaining({
    type: 'document', source: expect.objectContaining({ type: 'base64', media_type: 'application/pdf' }),
  })])
})

test('GPT PDF delivery fails explicitly without page rendering', async () => {
  const context = contextFor('gpt-6.1-sol', 'openai')
  process.env.PATH = scratch
  resetPdftoppmCache()
  await expect(runWithCwdOverride(scratch, () => callFileReadToolWithPreparedCapability(
    { file_path: writePDF(1) }, context, undefined, undefined, { userMentioned: true },
  ))).rejects.toThrow('pdftoppm is not installed')
})

test('Codex replay rejects a native PDF document instead of silently losing its content', () => {
  expect(() => translateToCodexBody({ model: 'gpt-6.1-sol', _openaiInstructionAssembly: {
    instructions: 'Summarize the document.', inputMessages: [createUserMessage({ content: [{
      type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: 'JVBERi0xLjQ=' },
    }] })],
  } })).toThrow('document cannot be delivered to the current model')
})

test.skipIf(!hasRenderer).each(['attachment', 'tool result'] as const)(
  'a restored native PDF in a %s continues through the real Codex request boundary',
  async location => {
    const pdfPath = writePDF(2)
    const document = {
      type: 'document' as const,
      source: { type: 'base64' as const, media_type: 'application/pdf' as const, data: readFileSync(pdfPath).toString('base64') },
    }
    rmSync(pdfPath)
    const documentMessage = location === 'attachment'
      ? createUserMessage({ content: [document] })
      : createUserMessage({ content: [{ type: 'tool_result', tool_use_id: 'restored-read', content: [document] }] })
    const history = location === 'attachment' ? [documentMessage] : [
      createAssistantMessage({ content: [{ type: 'tool_use', id: 'restored-read', name: 'Read', input: { file_path: pdfPath } }] }),
      documentMessage,
    ]
    const request = {
      model: 'gpt-6.1-sol',
      _openaiInstructionAssembly: { instructions: 'Summarize the restored PDF.', inputMessages: history },
    }
    const saved = JSON.stringify(request)
    let sent: Record<string, unknown> | undefined
    const blockedFetch = globalThis.fetch
    globalThis.fetch = Object.assign(async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      expect(String(url)).toBe('https://chatgpt.com/backend-api/codex/responses')
      sent = JSON.parse(String(init?.body))
      const events = [
        { type: 'response.output_text.delta', delta: 'Restored PDF response' },
        { type: 'response.completed', response: { id: 'response-restored-pdf', usage: { input_tokens: 1, output_tokens: 2 } } },
      ]
      return new Response(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''), {
        headers: { 'content-type': 'text/event-stream' },
      })
    }, { preconnect: originalFetch.preconnect }) as typeof fetch
    try {
      const response = await createCodexFetch(credential, undefined, { credentialUse: { lifecycle } })(
        'https://api.anthropic.com/v1/messages', { method: 'POST', body: saved },
      )
      expect((await response.json()).content).toEqual([{ type: 'text', text: 'Restored PDF response' }])
      const input = sent!.input as Array<{ content?: Array<{ type: string; image_url?: string }>; output?: Array<{ type: string; image_url?: string }> }>
      const images = input.flatMap(item => item.content ?? item.output ?? []).filter(part => part.type === 'input_image')
      expect(images).toHaveLength(2)
      expect(images.every(part => part.image_url!.startsWith('data:image/jpeg;base64,'))).toBe(true)
      // Local temp paths must not perturb the replay prefix on the next turn.
      const firstInput = sent!.input
      const repeated = await createCodexFetch(credential, undefined, { credentialUse: { lifecycle } })(
        'https://api.anthropic.com/v1/messages', { method: 'POST', body: saved },
      )
      await repeated.json()
      expect(sent!.input).toEqual(firstInput)
    } finally {
      globalThis.fetch = blockedFetch
    }
  },
)

test('restored document conversion rejects unsupported input and absent rendering before sending', async () => {
  const adapter = createCodexFetch(credential, undefined, { credentialUse: { lifecycle } })
  const requestFor = (source: Record<string, unknown>) => ({
    model: 'gpt-6.1-sol', _openaiInstructionAssembly: {
      instructions: 'Summarize the restored document.',
      inputMessages: [{ role: 'user', content: [{ type: 'document', source }] }],
    },
  })
  const send = (body: Record<string, unknown>) => adapter('https://api.anthropic.com/v1/messages', {
    method: 'POST', body: JSON.stringify(body),
  })
  await expect(send(requestFor({ type: 'text', media_type: 'text/plain', data: 'unsupported attachment' })))
    .rejects.toThrow('Only base64 PDF attachments can be rendered')
  await expect(send(requestFor({ type: 'base64', media_type: 'application/pdf', data: Buffer.from('invalid PDF').toString('base64') })))
    .rejects.toThrow('not a valid PDF')
  if (hasRenderer) {
    await expect(send(requestFor({ type: 'base64', media_type: 'application/pdf', data: readFileSync(writePDF(21)).toString('base64') })))
      .rejects.toThrow('20-page limit')
  }
  process.env.PATH = scratch
  resetPdftoppmCache()
  await expect(send(requestFor({ type: 'base64', media_type: 'application/pdf', data: readFileSync(writePDF(1)).toString('base64') })))
    .rejects.toThrow('pdftoppm is not installed')
})
