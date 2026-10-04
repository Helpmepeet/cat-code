import { expect, test } from 'bun:test'
import { encodeFrame, FrameDecoder, type FrameDecodeResult } from './framing.js'
import { MAX_FRAME_BYTES } from './limits.js'

test('round-trips a single frame', () => {
  const decoder = new FrameDecoder(MAX_FRAME_BYTES)
  const results = decoder.push(encodeFrame({ hello: 'world' }))
  expect(results).toHaveLength(1)
  expect(results[0]).toEqual({ kind: 'frame', payload: { hello: 'world' } })
})

test('reassembles a frame split across chunks', () => {
  const decoder = new FrameDecoder(MAX_FRAME_BYTES)
  const frame = encodeFrame({ a: 1, b: [1, 2, 3] })
  const mid = Math.floor(frame.length / 2)
  expect(decoder.push(frame.subarray(0, mid))).toHaveLength(0)
  const results = decoder.push(frame.subarray(mid))
  expect(results).toEqual([{ kind: 'frame', payload: { a: 1, b: [1, 2, 3] } }])
})

test('releases fully consumed input chunks instead of retaining their backing storage', () => {
  const decoder = new FrameDecoder(MAX_FRAME_BYTES)
  const largeBackingBuffer = Buffer.alloc(4 * 1024 * 1024)
  const frame = encodeFrame({ value: 'ok' })
  frame.copy(largeBackingBuffer)
  expect(decoder.push(largeBackingBuffer.subarray(0, frame.length))).toEqual([
    { kind: 'frame', payload: { value: 'ok' } },
  ])
  // A zero-length subarray still retains its parent allocation. The decoder's
  // pending state must be empty after consuming the only frame.
  expect((decoder as unknown as { buffer: Buffer }).buffer.buffer.byteLength).toBe(0)
})

test('assembles a large frame delivered in small chunks', () => {
  const decoder = new FrameDecoder(3 * 1024 * 1024)
  const value = 'x'.repeat(2 * 1024 * 1024)
  const frame = encodeFrame({ value })
  let output: FrameDecodeResult[] = []
  for (let offset = 0; offset < frame.length; offset += 64 * 1024) {
    output = decoder.push(frame.subarray(offset, Math.min(offset + 64 * 1024, frame.length)))
  }
  expect(output).toEqual([{ kind: 'frame', payload: { value } }])
})

test('geometric growth stays within the configured frame allocation ceiling', () => {
  const value = 'x'.repeat(1024 * 1024 - 12)
  const frame = encodeFrame({ value })
  const decoder = new FrameDecoder(frame.length - 4)
  expect(decoder.push(frame.subarray(0, frame.length - 1))).toEqual([])
  // Header overhead must not round a maximum-sized frame up to twice its cap.
  expect((decoder as unknown as { buffer: Buffer }).buffer.length).toBeLessThanOrEqual(frame.length)
  expect(decoder.push(frame.subarray(-1))).toEqual([{ kind: 'frame', payload: { value } }])
})

test('validates the declared cap before buffering a hostile body chunk', () => {
  const decoder = new FrameDecoder(16)
  const chunk = Buffer.alloc(4 * 1024 * 1024)
  chunk.writeUInt32BE(17, 0)
  expect(decoder.push(chunk)).toEqual([
    { kind: 'error', reason: 'frame length 17 exceeds max 16' },
  ])
  expect((decoder as unknown as { buffer: Buffer }).buffer.buffer.byteLength).toBe(0)
})

test('does not retain a large frame allocation for a partial following header', () => {
  const decoder = new FrameDecoder(2 * 1024 * 1024)
  const frame = encodeFrame({ value: 'x'.repeat(1024 * 1024) })
  const nextFrame = encodeFrame({ next: true })
  const input = Buffer.concat([frame, nextFrame.subarray(0, 3)])
  expect(decoder.push(input)).toHaveLength(1)
  expect((decoder as unknown as { buffer: Buffer }).buffer.buffer.byteLength).toBe(1024)
})

test('splits two frames coalesced in one chunk', () => {
  const decoder = new FrameDecoder(MAX_FRAME_BYTES)
  const chunk = Buffer.concat([encodeFrame({ n: 1 }), encodeFrame({ n: 2 })])
  const results = decoder.push(chunk)
  expect(results).toEqual([
    { kind: 'frame', payload: { n: 1 } },
    { kind: 'frame', payload: { n: 2 } },
  ])
})

test('rejects an oversized declared length before buffering the body (T7)', () => {
  const decoder = new FrameDecoder(16)
  const oversized = encodeFrame({ big: 'x'.repeat(100) })
  const results = decoder.push(oversized)
  expect(results[0].kind).toBe('error')
})

test('reports an error on a non-JSON body', () => {
  const decoder = new FrameDecoder(MAX_FRAME_BYTES)
  const prefix = Buffer.allocUnsafe(4)
  prefix.writeUInt32BE(3, 0)
  const results = decoder.push(Buffer.concat([prefix, Buffer.from('abc')]))
  expect(results[0].kind).toBe('error')
})

test('rejects malformed UTF-8 instead of replacing it during JSON decoding', () => {
  const decoder = new FrameDecoder(MAX_FRAME_BYTES)
  const body = Buffer.from([0x22, 0xff, 0x22])
  const prefix = Buffer.allocUnsafe(4)
  prefix.writeUInt32BE(body.length, 0)
  expect(decoder.push(Buffer.concat([prefix, body]))).toEqual([
    { kind: 'error', reason: 'frame body is not valid UTF-8 JSON' },
  ])
})

test('reset releases a partial frame when the connection closes', () => {
  const decoder = new FrameDecoder(MAX_FRAME_BYTES)
  const frame = encodeFrame({ value: 'pending' })
  decoder.push(frame.subarray(0, frame.length - 1))
  decoder.reset()
  const pending = decoder as unknown as { buffer: Buffer }
  expect(pending.buffer.length).toBe(0)
  expect(pending.buffer.buffer.byteLength).toBe(0)
})
