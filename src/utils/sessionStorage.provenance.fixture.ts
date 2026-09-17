/**
 * Bundled by sessionStorage.provenance.test.ts with a fixed MACRO.VERSION.
 * This is deliberately a real asynchronous transcript write: a direct helper
 * call would not cover Bun's define behavior inside the persistence path.
 */
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { switchSession } from '../bootstrap/state.js'
import { asSessionId } from '../types/ids.js'
import { createUserMessage } from './messages.js'
import {
  flushCurrentTranscriptDurably,
  getTranscriptPathForSession,
  recordTranscript,
} from './sessionStorage.js'
import { releaseActiveTranscriptLease } from './transcriptLease.js'

const projectDir = process.argv[2]
if (!projectDir) throw new Error('missing project directory')

const sessionId = asSessionId(randomUUID())
switchSession(sessionId, projectDir)
const message = createUserMessage({ content: 'compiled provenance probe' })
await recordTranscript([message])
await flushCurrentTranscriptDurably()

const row = readFileSync(getTranscriptPathForSession(sessionId), 'utf8')
  .trim()
  .split('\n')
  .map(line => JSON.parse(line) as { uuid?: string; version?: string })
  .find(entry => entry.uuid === message.uuid)

await releaseActiveTranscriptLease()
process.stdout.write(row?.version ?? 'missing')
process.exit(0)
