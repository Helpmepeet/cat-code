import { expect, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import { captureMcpStartupStderr } from './mcpStderrCapture.js'

test('startup stderr stays bounded and is no longer retained after connection', () => {
  const stream = new EventEmitter()
  const capture = captureMcpStartupStderr(stream)
  stream.emit('data', Buffer.from('startup diagnostic'))
  expect(capture.take()).toBe('startup diagnostic')

  stream.emit('data', Buffer.alloc(2 * 1024 * 1024, 0x78))
  expect(capture.take()).toHaveLength(8 * 1024 + '\n[stderr truncated]'.length)

  capture.stopCapturing()
  stream.emit('data', Buffer.alloc(2 * 1024 * 1024, 0x78))
  expect(capture.take()).toBe('')
  // The listener remains attached so the child pipe continues to be drained.
  expect(stream.listenerCount('data')).toBe(1)

  capture.dispose()
  expect(stream.listenerCount('data')).toBe(0)
})

test('truncates at the diagnostic character cap and marks later output', () => {
  const stream = new EventEmitter()
  const capture = captureMcpStartupStderr(stream)
  stream.emit('data', Buffer.from('界'.repeat(8_192)))
  stream.emit('data', Buffer.from('later'))
  const diagnostic = capture.take()
  expect(diagnostic.slice(0, 8_192)).toBe('界'.repeat(8_192))
  expect(diagnostic).toHaveLength(8 * 1024 + '\n[stderr truncated]'.length)
  capture.dispose()
})

test('failed startup diagnostics survive cleanup until consumed', () => {
  const stream = new EventEmitter()
  const capture = captureMcpStartupStderr(stream)
  stream.emit('data', Buffer.from('startup failure detail'))
  capture.dispose()

  expect(stream.listenerCount('data')).toBe(0)
  expect(capture.take()).toBe('startup failure detail')
  expect(capture.take()).toBe('')
})
