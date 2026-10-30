import { afterAll, beforeAll, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getSessionId } from '../bootstrap/state.js'
import { asAgentId } from '../types/ids.js'
import { BaseHookInputSchema } from '../entrypoints/sdk/coreSchemas.js'
import {
  clearAgentTranscriptSubdir,
  getAgentTranscriptPath,
  getAgentTranscriptPathForSession,
  getTranscriptPathForSession,
  setAgentTranscriptSubdir,
} from './sessionStorage.js'

await import('../tools.js')
const { createBaseHookInput } = await import('./hooks.js')

const previousConfig = process.env.CLAUDE_CONFIG_DIR
let config: string
beforeAll(() => {
  config = mkdtempSync(join(tmpdir(), 'hook-base-input-'))
  process.env.CLAUDE_CONFIG_DIR = config
})
afterAll(() => {
  if (previousConfig === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = previousConfig
  rmSync(config, { recursive: true, force: true })
})

test('worker hook input preserves parent identity and exposes its actual transcript', () => {
  const agentId = asAgentId('map-reader-worker')
  setAgentTranscriptSubdir(agentId, 'nested')
  try {
    const input = createBaseHookInput('default', undefined, { agentId, agentType: 'implementor' })
    expect(input.session_id).toBe(getSessionId())
    expect(input.transcript_path).toBe(getTranscriptPathForSession(getSessionId()))
    expect(input.agent_transcript_path).toBe(getAgentTranscriptPath(agentId))
    expect(input.agent_transcript_path).toContain('/subagents/nested/agent-map-reader-worker.jsonl')
    expect(input.agent_transcript_path).not.toBe(input.transcript_path)
    expect(BaseHookInputSchema().parse(input).agent_transcript_path).toBe(input.agent_transcript_path)
  } finally {
    clearAgentTranscriptSubdir(agentId)
  }
})

test('explicit session input resolves its own worker transcript', () => {
  const sessionId = '00000000-0000-4000-8000-000000000001'
  const agentId = asAgentId('other-worker')
  const input = createBaseHookInput(undefined, sessionId, { agentId })
  expect(input.session_id).toBe(sessionId)
  expect(input.agent_transcript_path).toBe(getAgentTranscriptPathForSession(sessionId, agentId))
})

test('main hook input has no worker transcript', () => {
  const input = createBaseHookInput()
  expect(input.agent_id).toBeUndefined()
  expect('agent_transcript_path' in input).toBe(false)
})
