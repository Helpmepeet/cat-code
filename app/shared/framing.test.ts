import { expect, test } from 'bun:test'
import { encodeFrame, FrameDecoder, type FrameDecodeResult } from './framing.js'
import { MAX_FRAME_BYTES } from './limits.js'

test('round-trips a single frame', () => {
  const decoder = new FrameDecoder(MAX_FRAME_BYTES)
  const results = decoder.push(encodeFrame({ hello: 'world' }))
  expect(results).toHaveLength(1)
  expect(results[0]).toEqual({ kind: 'frame', payload: { hello: 'world' }, byteLength: Buffer.byteLength('{"hello":"world"}') })
})

test('reassembles a frame split across chunks', () => {
  const decoder = new FrameDecoder(MAX_FRAME_BYTES)
  const frame = encodeFrame({ a: 1, b: [1, 2, 3] })
  const mid = Math.floor(frame.length / 2)
  expect(decoder.push(frame.subarray(0, mid))).toHaveLength(0)
  const results = decoder.push(frame.subarray(mid))
  expect(results).toEqual([{ kind: 'frame', payload: { a: 1, b: [1, 2, 3] }, byteLength: frame.length - 4 }])
})

test('releases fully consumed input chunks instead of retaining their backing storage', () => {
  const decoder = new FrameDecoder(MAX_FRAME_BYTES)
  const largeBackingBuffer = Buffer.alloc(4 * 1024 * 1024)
  const frame = encodeFrame({ value: 'ok' })
  frame.copy(largeBackingBuffer)
  expect(decoder.push(largeBackingBuffer.subarray(0, frame.length))).toEqual([
    { kind: 'frame', payload: { value: 'ok' }, byteLength: frame.length - 4 },
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
  expect(output).toEqual([{ kind: 'frame', payload: { value }, byteLength: frame.length - 4 }])
})

test('geometric growth stays within the configured frame allocation ceiling', () => {
  const value = 'x'.repeat(1024 * 1024 - 12)
  const frame = encodeFrame({ value })
  const decoder = new FrameDecoder(frame.length - 4)
  expect(decoder.push(frame.subarray(0, frame.length - 1))).toEqual([])
  // Header overhead must not round a maximum-sized frame up to twice its cap.
  expect((decoder as unknown as { buffer: Buffer }).buffer.length).toBeLessThanOrEqual(frame.length)
  expect(decoder.push(frame.subarray(-1))).toEqual([{ kind: 'frame', payload: { value }, byteLength: frame.length - 4 }])
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
    { kind: 'frame', payload: { n: 1 }, byteLength: Buffer.byteLength('{"n":1}') },
    { kind: 'frame', payload: { n: 2 }, byteLength: Buffer.byteLength('{"n":2}') },
  ])
})

test('reports original UTF-8 wire bytes before whitespace and escapes are canonicalized', () => {
  const body = Buffer.from('  { "value": "\\u0061\\/界" } \n', 'utf8')
  const header = Buffer.alloc(4)
  header.writeUInt32BE(body.byteLength)
  const frame = Buffer.concat([header, body])
  const expected: FrameDecodeResult[] = [{ kind: 'frame', payload: { value: 'a/界' }, byteLength: body.byteLength }]
  expect(body.byteLength).toBeGreaterThan(Buffer.byteLength(JSON.stringify({ value: 'a/界' })))
  expect(new FrameDecoder(MAX_FRAME_BYTES).push(frame)).toEqual(expected)
  const fragmented = new FrameDecoder(MAX_FRAME_BYTES)
  expect(fragmented.push(frame.subarray(0, 7))).toEqual([])
  expect(fragmented.push(frame.subarray(7))).toEqual(expected)
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

test('oversized headers never reach admission, contiguous or fragmented', () => {
  const calls: number[] = []
  for (const fragmented of [false, true]) {
    const decoder = new FrameDecoder(16, bytes => { calls.push(bytes); return true })
    const frame = encodeFrame({ value: 'x'.repeat(100) })
    if (fragmented) expect(decoder.push(frame.subarray(0, 2))).toEqual([])
    const results = decoder.push(fragmented ? frame.subarray(2) : frame)
    expect(results).toEqual([{ kind: 'error', reason: `frame length ${frame.length - 4} exceeds max 16` }])
  }
  expect(calls).toEqual([])
})

test('refuses large bodies before buffering or parsing and releases partial headers', () => {
  const bodyLength = 2 * 1024 * 1024
  const frame = Buffer.alloc(bodyLength + 4, 0xff)
  frame.writeUInt32BE(bodyLength)
  for (const fragmented of [false, true]) {
    const calls: number[] = []
    const decoder = new FrameDecoder(bodyLength, bytes => {
      calls.push(bytes)
      // At admission only a fragmented header may have been retained.
      expect((decoder as unknown as { writeOffset: number }).writeOffset).toBe(fragmented ? 4 : 0)
      return false
    })
    if (fragmented) expect(decoder.push(frame.subarray(0, 2))).toEqual([])
    expect(decoder.push(fragmented ? frame.subarray(2) : frame)).toEqual([{
      kind: 'error',
      reason: 'Messages are arriving too quickly. Wait a moment and try again.',
    }])
    expect(calls).toEqual([bodyLength])
    expect((decoder as unknown as { buffer: Buffer }).buffer.buffer.byteLength).toBe(0)
  }
})

test('admits once when a header and body arrive in many fragments', () => {
  const calls: number[] = []
  const decoder = new FrameDecoder(MAX_FRAME_BYTES, bytes => { calls.push(bytes); return true })
  const frame = encodeFrame({ value: 'fragmented' })
  for (let offset = 0; offset < frame.length - 1; offset++) {
    expect(decoder.push(frame.subarray(offset, offset + 1))).toEqual([])
    expect(calls).toEqual(offset < 3 ? [] : [frame.length - 4])
  }
  expect(decoder.push(frame.subarray(-1))).toEqual([{
    kind: 'frame', payload: { value: 'fragmented' }, byteLength: frame.length - 4,
  }])
  expect(calls).toEqual([frame.length - 4])
})

test('admits each coalesced frame and stops before a refused frame is parsed', () => {
  const calls: number[] = []
  const first = encodeFrame({ first: true })
  const second = encodeFrame({ second: true })
  const third = encodeFrame({ third: true })
  const decoder = new FrameDecoder(MAX_FRAME_BYTES, bytes => {
    calls.push(bytes)
    return calls.length < 3
  })
  expect(decoder.push(Buffer.concat([first, second, third]))).toEqual([
    { kind: 'frame', payload: { first: true }, byteLength: first.length - 4 },
    { kind: 'frame', payload: { second: true }, byteLength: second.length - 4 },
    { kind: 'error', reason: 'Messages are arriving too quickly. Wait a moment and try again.' },
  ])
  expect(calls).toEqual([first.length - 4, second.length - 4, third.length - 4])
})

test('reset and errors clear admission state for the next frame', () => {
  const calls: number[] = []
  let allow = true
  const decoder = new FrameDecoder(MAX_FRAME_BYTES, bytes => { calls.push(bytes); return allow })
  const frame = encodeFrame({ next: true })
  expect(decoder.push(frame.subarray(0, 5))).toEqual([])
  decoder.reset()
  expect(decoder.push(frame)).toEqual([{
    kind: 'frame', payload: { next: true }, byteLength: frame.length - 4,
  }])
  allow = false
  expect(decoder.push(frame)[0].kind).toBe('error')
  allow = true
  const invalid = Buffer.from([0, 0, 0, 1, 0xff])
  expect(decoder.push(invalid)[0].kind).toBe('error')
  expect(decoder.push(frame)[0].kind).toBe('frame')
  expect(calls).toEqual([frame.length - 4, frame.length - 4, frame.length - 4, 1, frame.length - 4])
})
