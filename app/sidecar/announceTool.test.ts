import { expect, spyOn, test } from 'bun:test'
import { feature } from 'bun:bundle'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ToolUseContext } from '../../src/Tool.js'
import { SessionRegistry } from '../host/registry.js'
import { MAX_PEER_NOTICE_BYTES } from '../shared/limits.js'
import { parsePeerNoticeInput } from '../shared/peerNotice.js'
import { hasPermissionsToUseTool } from '../../src/utils/permissions/permissions.js'
import * as classifier from '../../src/utils/permissions/yoloClassifier.js'
import { buildPeerDoctrine } from './desktopSystemPrompt.js'
import { createAnnounceTool } from './announceTool.js'
import { createListPeersTool } from './listPeersTool.js'
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

test('a memory-only post is explicit rather than promising saved scope', async () => {
  const tool = createAnnounceTool((async () => ({ ok: true, value: { postedAt: 10000, saved: false } })) as PeerHostRequester)
  const result = await tool.call({ doing: 'Editing' }, {} as ToolUseContext)
  expect(result.data).toMatchObject({ ok: true, saved: false })
  expect(JSON.stringify(result.data)).toContain('could not be saved')
})

test('a missing announcing session is not described as a missing named peer', async () => {
  const tool = createAnnounceTool((async () => ({
    ok: false, error: { code: 'session_not_found', message: 'This conversation is no longer available.' },
  })) as PeerHostRequester)
  const result = await tool.call({ doing: 'Editing' }, {} as ToolUseContext)
  expect(result.data).toEqual({ ok: false, message: 'This session is no longer available to post a notice.' })
  expect(tool.mapToolResultToToolResultBlockParam(result.data, 'tu').is_error).toBe(true)
})

test('scope guidance keeps posting optional, replaces only for a new task, and treats omitted notices as unavailable', async () => {
  const doctrine = buildPeerDoctrine({ name: 'Bear', createdByName: null, createdById: null })
  expect(doctrine).toContain('Post a scope notice with Announce when it would save peers asking what you are doing')
  expect(doctrine).not.toContain('especially before you edit files')
  expect(doctrine).toContain('Read a peer\'s notice in ListPeers before asking what it is working on')
  expect(doctrine).toContain('the notice is unavailable and you are about to edit near its work')
  expect(doctrine).toContain('Subagents have no peer tools, so give them any peer context they need')
  const prompt = await createAnnounceTool().prompt()
  expect(prompt).toContain('when it would save peers asking what you are doing')
  expect(prompt).toContain('Describe the whole task, not your progress')
  expect(prompt).toContain('replace it only when you are given a different one or need to edit a shared file outside the areas it names')
  expect(await createListPeersTool().prompt()).toContain('noticeOmitted has a notice that did not fit in this list')
})

test('Auto classifies the whole notice without an acceptEdits bypass', async () => {
  if (!feature('TRANSCRIPT_CLASSIFIER')) {
    const child = spawnSync(process.execPath, ['--feature=TRANSCRIPT_CLASSIFIER', 'test', import.meta.path, '-t', 'Auto classifies the whole notice'], {
      encoding: 'utf8', timeout: 30000,
    })
    expect(child.stderr + child.stdout).toContain('1 pass')
    expect(child.status).toBe(0)
    return
  }
  const tool = createAnnounceTool()
  const input = { doing: 'Editing', touches: ['shared-file'], note: 'Standing text requiring analysis' }
  const toolPermissionContext = {
    mode: 'auto', additionalWorkingDirectories: new Map(), alwaysAllowRules: {}, alwaysDenyRules: {},
    alwaysAskRules: {}, isBypassPermissionsModeAvailable: false,
  }
  const context = {
    getAppState: () => ({ toolPermissionContext }),
    setAppState: () => {},
    abortController: new AbortController(),
    messages: [], options: { tools: [tool] },
  } as unknown as ToolUseContext
  const spy = spyOn(classifier, 'classifyYoloAction').mockResolvedValue({ shouldBlock: true, reason: 'fixture denied notice', model: 'fixture-classifier' })
  try {
    const decision = await hasPermissionsToUseTool(tool, input, context, { message: { id: 'notice' } } as never, 'notice-call')
    expect(spy).toHaveBeenCalledTimes(1)
    expect(JSON.stringify(spy.mock.calls[0]?.[1])).toContain(input.note)
    expect(JSON.stringify(spy.mock.calls[0]?.[1])).toContain(input.touches[0])
    expect(JSON.stringify(spy.mock.calls[0]?.[1])).toContain(input.doing)
    expect(decision.behavior).toBe('deny')
    for (const mode of ['default', 'acceptEdits', 'dontAsk', 'plan', 'bypassPermissions']) {
      toolPermissionContext.mode = mode
      expect((await tool.checkPermissions(input, context)).behavior).toBe('allow')
    }
  } finally {
    spy.mockRestore()
  }
})
