import { existsSync, writeFileSync } from 'node:fs'

import { switchSession } from '../../src/bootstrap/state.js'
import { init } from '../../src/entrypoints/init.js'
import { asSessionId } from '../../src/types/ids.js'
import { createAssistantMessage, createUserMessage } from '../../src/utils/messages.js'
import {
  flushSessionStorage,
  getTranscriptPathForSession,
  recordTranscript,
} from '../../src/utils/sessionStorage.js'
import { releaseActiveTranscriptLease } from '../../src/utils/transcriptLease.js'

async function waitFor(path: string): Promise<void> {
  const startedAt = Date.now()
  while (!existsSync(path)) {
    if (Date.now() - startedAt > 30_000) throw new Error(`Timed out waiting for ${path}`)
    await Bun.sleep(20)
  }
}

async function main(): Promise<void> {
  const [sessionId, readyFile, appendFile, marker] = process.argv.slice(2)
  if (!sessionId || !readyFile || !appendFile || !marker) throw new Error('missing fixture arguments')
  await init()
  switchSession(asSessionId(sessionId))
  const initial = [
    createUserMessage({ content: 'initial fact' }),
    createAssistantMessage({ content: 'initial fact acknowledged' }),
  ]
  await recordTranscript(initial)
  await flushSessionStorage()
  writeFileSync(readyFile, getTranscriptPathForSession(sessionId))
  await waitFor(appendFile)
  await recordTranscript([
    ...initial,
    createUserMessage({ content: `late durable fact ${marker}` }),
    createAssistantMessage({ content: `late durable fact ${marker} acknowledged` }),
  ])
  await flushSessionStorage()
  await releaseActiveTranscriptLease()
}

void main().catch(error => {
  process.stderr.write(String(error instanceof Error ? error.stack : error))
  process.exit(1)
})
