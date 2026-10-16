import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ToolUseContext } from '../../src/Tool.js'
import { SessionRegistry } from '../host/registry.js'
import { MAX_PEER_NOTICE_BYTES } from '../shared/limits.js'
import { parsePeerNoticeInput } from '../shared/peerNotice.js'
import { createAnnounceTool } from './announceTool.js'
import type { PeerHostRequester } from './peerHostRequester.js'

test('worker refusal leaves the conversational agent’s registry notice unchanged', async () => {
  const storageDir = mkdtempSync(join(tmpdir(), 'announce-worker-'))
  try {
    const registry = new SessionRegistry({ storageDir })
    await registry.launch()
    await registry.upsertOnSpawn({ appSessionId: 'writer', cwd: '/workspace', name: 'Bear' })
    let requests = 0
    const requestHost = (async (verb: string, input: unknown) => {
      expect(verb).toBe('peer.announce')
      requests++
      const content = parsePeerNoticeInput(input)
      if (!content) throw new Error('invalid notice sent')
      const notice = await registry.setPeerNotice('writer', content)
      return { ok: true, value: { postedAt: notice!.postedAt } }
    }) as PeerHostRequester
    const tool = createAnnounceTool(requestHost)
    const input = { doing: 'Editing parent scope', touches: ['app', 'src'], note: 'Includes worker edits' }
    const posted = await tool.call(input, {} as ToolUseContext)
    expect(posted.data.ok).toBe(true)
    expect(tool.isReadOnly()).toBe(false)
    expect(tool.toAutoClassifierInput(input)).toBe(JSON.stringify(input))
    const previous = registry.sessions[0]?.peerNotice
    const before = readFileSync(registry.filePath, 'utf8')
    const refused = await tool.call({ doing: 'Only my narrow slice' }, { agentId: 'worker-1' } as ToolUseContext)
    expect(refused.data.ok).toBe(false)
    expect(tool.mapToolResultToToolResultBlockParam(refused.data, 'tu-worker').is_error).toBe(true)
    expect(requests).toBe(1)
    expect(registry.sessions[0]?.peerNotice).toEqual(previous)
    expect(readFileSync(registry.filePath, 'utf8')).toBe(before)
  } finally {
    rmSync(storageDir, { recursive: true, force: true })
  }
})

test('tool schema and direct-call guard both reject invalid notices', async () => {
  let calls = 0
  const tool = createAnnounceTool((async () => { calls++; throw new Error('must not send') }) as PeerHostRequester)
  for (const input of [{ doing: 'two\nlines' }, { doing: ' ' }, { doing: '界'.repeat(MAX_PEER_NOTICE_BYTES) }]) {
    expect(tool.inputSchema.safeParse(input).success).toBe(false)
    expect((await tool.call(input, {} as ToolUseContext)).data.ok).toBe(false)
  }
  expect(calls).toBe(0)
})

test('a refused host write is reported as an error, not a posted notice', async () => {
  const tool = createAnnounceTool((async () => ({
    ok: false, error: { code: 'rate_limited', message: 'slow down' },
  })) as PeerHostRequester)
  const result = await tool.call({ doing: 'Read-only analysis' }, {} as ToolUseContext)
  expect(result.data.ok).toBe(false)
  expect(tool.mapToolResultToToolResultBlockParam(result.data, 'tu').is_error).toBe(true)
})
