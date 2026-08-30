import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildStallReminders } from './sessionRestore.js'

const dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
})

async function writeTranscript(lines: unknown[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'stall-reminders-'))
  dirs.push(dir)
  const path = join(dir, 'transcript.jsonl')
  await writeFile(path, lines.map(line => JSON.stringify(line)).join('\n'))
  return path
}

function spawned(toolUseId: string, agentId: string) {
  return {
    type: 'subagent-spawned',
    sessionId: 'session-1',
    agentId,
    agentType: 'implementor',
    description: 'Fix seven validated defects',
    transcriptPath: `/tmp/${agentId}.jsonl`,
    toolUseId,
    spawnedAt: new Date(Date.now() - 60_000).toISOString(),
  }
}

/**
 * The 2026-08-29 loss: the engine was killed mid-subagent, so the stall sweep
 * wrote a `stall-detected` terminal record and the parent never wrote the
 * tool_result. Gating the reminder on the terminal record meant that tombstone
 * suppressed the only warning, and the resumed model told the user it had never
 * spawned the subagent. The gate is the tool_result.
 */
test('a subagent killed with its parent still produces a resume reminder', async () => {
  const path = await writeTranscript([
    spawned('call_lost', 'agent-lost'),
    {
      type: 'subagent-terminal',
      sessionId: 'session-1',
      agentId: 'agent-lost',
      toolUseId: 'call_lost',
      status: 'stall-detected',
      reason: 'parent-exited-without-result',
      durationMs: 402_155,
      endedAt: new Date(Date.now() - 30_000).toISOString(),
    },
  ])

  const reminders = await buildStallReminders(path)

  expect(reminders).toHaveLength(1)
  const text = reminders[0]!.type === 'system' ? reminders[0]!.content : ''
  expect(text).toContain('agent-lost')
  expect(text).toContain('stall-detected')
  expect(text).toContain('parent-exited-without-result')
  // The exact failure this reminder exists to stop.
  expect(text).toContain('never spawned')
})

test('a subagent whose result reached the transcript produces no reminder', async () => {
  const path = await writeTranscript([
    spawned('call_done', 'agent-done'),
    {
      type: 'subagent-terminal',
      sessionId: 'session-1',
      agentId: 'agent-done',
      toolUseId: 'call_done',
      status: 'completed',
      durationMs: 1_000,
      endedAt: new Date().toISOString(),
    },
    {
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'call_done', content: 'ok' }],
      },
    },
  ])

  expect(await buildStallReminders(path)).toHaveLength(0)
})

test('a result delivered without any terminal record also stays silent', async () => {
  const path = await writeTranscript([
    spawned('call_quiet', 'agent-quiet'),
    {
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'call_quiet', content: 'ok' }],
      },
    },
  ])

  expect(await buildStallReminders(path)).toHaveLength(0)
})
