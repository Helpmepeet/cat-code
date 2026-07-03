import { expect, test } from 'bun:test'
import { encodeFrame, FrameDecoder } from './framing.js'
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
