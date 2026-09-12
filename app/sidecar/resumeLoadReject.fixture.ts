import { existsSync, writeFileSync } from 'node:fs'

import { init } from '../../src/entrypoints/init.js'
import { releaseActiveTranscriptLease } from '../../src/utils/transcriptLease.js'
import { loadOwnedConversationForResume } from './sessionResume.js'

const [sessionId, readyFile, releaseFile] = process.argv.slice(2)
if (!sessionId || !readyFile || !releaseFile) throw new Error('missing fixture arguments')
await init()
try {
  await loadOwnedConversationForResume(sessionId, async () => {
    throw new Error('controlled loader rejection')
  })
  throw new Error('controlled loader unexpectedly resolved')
} catch (error) {
  if (!(error instanceof Error) || error.message !== 'controlled loader rejection') throw error
}
writeFileSync(readyFile, String(process.pid))
while (!existsSync(releaseFile)) await Bun.sleep(20)
await releaseActiveTranscriptLease()
