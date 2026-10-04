/**
 * Reproducible synthetic measurement for the app socket FrameDecoder.
 *
 * The baseline value models the original Buffer.concat decoder exactly: every
 * push after the first copied its pending prefix plus the new socket chunk.
 * The current value counts Buffer.copy calls during decoding. No timing target
 * is asserted; elapsed time is included only as a local observation.
 */
import { encodeFrame, FrameDecoder } from '../../app/shared/framing.js'
import { EventEmitter } from 'node:events'
import { captureMcpStartupStderr } from '../../src/services/mcp/mcpStderrCapture.js'
import { subscribeToProjection } from '../../app/sidecar/projectedSubscription.js'

const frameMiB = Number(process.argv[2] ?? 20)
const chunkKiB = Number(process.argv[3] ?? 64)
if (!Number.isFinite(frameMiB) || frameMiB <= 0) throw new Error('frameMiB must be positive')
if (!Number.isFinite(chunkKiB) || chunkKiB <= 0) throw new Error('chunkKiB must be positive')

const payload = { value: 'x'.repeat(Math.floor(frameMiB * 1024 * 1024)) }
const frame = encodeFrame(payload)
const chunkBytes = Math.floor(chunkKiB * 1024)
const decoder = new FrameDecoder(frame.length)

let measuredCopyBytes = 0
const originalCopy = Buffer.prototype.copy
Buffer.prototype.copy = function (target, targetStart, sourceStart, sourceEnd) {
  measuredCopyBytes += (sourceEnd ?? this.length) - (sourceStart ?? 0)
  return originalCopy.call(this, target, targetStart, sourceStart, sourceEnd)
}

const startedAt = process.hrtime.bigint()
let decodedFrames = 0
try {
  for (let offset = 0; offset < frame.length; offset += chunkBytes) {
    const chunk = frame.subarray(offset, Math.min(offset + chunkBytes, frame.length))
    decodedFrames += decoder.push(chunk).filter(result => result.kind === 'frame').length
  }
} finally {
  Buffer.prototype.copy = originalCopy
}
const elapsedMs = Number(process.hrtime.bigint() - startedAt) / 1e6

let pendingBytes = 0
let baselineConcatCopyBytes = 0
for (let offset = 0; offset < frame.length; offset += chunkBytes) {
  const incomingBytes = Math.min(chunkBytes, frame.length - offset)
  // The original decoder borrowed the first chunk and concatenated thereafter.
  if (pendingBytes > 0) baselineConcatCopyBytes += pendingBytes + incomingBytes
  pendingBytes += incomingBytes
  if (pendingBytes === frame.length) pendingBytes = 0
}

console.log(JSON.stringify({
  fixture: 'one JSON frame over a synthetic socket chunk stream',
  frameBytes: frame.length,
  chunkBytes,
  chunks: Math.ceil(frame.length / chunkBytes),
  decodedFrames,
  baselineBufferConcatCopiedBytes: baselineConcatCopyBytes,
  currentBufferCopyBytes: measuredCopyBytes,
  elapsedMs: Number(elapsedMs.toFixed(1)),
}))

// The original connected-server callback retained this text even though its
// startup consumer had already finished. Measure characters, not string bytes.
const stderr = new EventEmitter()
const capture = captureMcpStartupStderr(stderr)
stderr.emit('data', Buffer.from('startup diagnostic'))
capture.take()
capture.stopCapturing()
const stderrChunk = Buffer.alloc(32 * 1024, 0x78)
let legacyStderr = ''
for (let index = 0; index < 512; index++) {
  if (legacyStderr.length < 64 * 1024 * 1024) legacyStderr += stderrChunk.toString()
  stderr.emit('data', stderrChunk)
}
console.log(JSON.stringify({
  fixture: 'connected MCP stderr after startup',
  legacyRetainedCharacters: legacyStderr.length,
  currentRetainedCharacters: capture.take().length,
  currentDataListeners: stderr.listenerCount('data'),
}))
capture.dispose()

const storeChanges = new EventEmitter()
let source = { id: 'fixture-task', status: 'running', progress: 0 }
let publications = 0
const unsubscribe = subscribeToProjection(
  listener => {
    storeChanges.on('change', listener)
    return () => { storeChanges.off('change', listener) }
  },
  () => ({ tasks: [{ id: source.id, status: source.status }] }),
  () => { publications++ },
)
for (let progress = 1; progress <= 1_000; progress++) {
  source = { ...source, progress }
  storeChanges.emit('change')
}
const unchangedPublications = publications
source = { ...source, status: 'completed' }
storeChanges.emit('change')
unsubscribe()
console.log(JSON.stringify({
  fixture: 'new source objects with unchanged display projection',
  updates: 1_000,
  legacyWholeStorePublications: 1_000,
  currentUnchangedPublications: unchangedPublications,
  currentRealTransitionPublications: publications - unchangedPublications,
}))
