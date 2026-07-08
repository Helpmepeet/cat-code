import { describe, test, expect } from 'bun:test'
import { createBackpressuredSocket } from './backpressuredSocket.js'

// A fake Bun socket that accepts at most `limitPerWrite` bytes per write() call
// (0 = accept nothing), mirroring POSIX partial-write behaviour.
function fakeSocket(limitPerWrite: number) {
  const received: number[] = []
  let ended = false
  const socket = {
    write(data: Uint8Array): number {
      const n = Math.min(limitPerWrite, data.byteLength)
      for (let i = 0; i < n; i++) received.push(data[i]!)
      return n
    },
    end() {
      ended = true
    },
  }
  return { socket, received, isEnded: () => ended }
}

describe('createBackpressuredSocket', () => {
  test('a frame larger than one write is delivered whole, in order, after drains', () => {
    const { socket, received } = fakeSocket(8192)
    const { wrapper, drain } = createBackpressuredSocket(socket)
    // 20 KB with a distinct per-byte pattern — the exact >8 KiB case that
    // silently truncated on the wire before the fix.
    const frame = new Uint8Array(20000).map((_, i) => i % 251)

    wrapper.write(frame)
    expect(received.length).toBe(8192) // only the first write landed; rest queued

    drain()
    expect(received.length).toBe(16384)
    drain()
    expect(received.length).toBe(20000)
    expect(received).toEqual(Array.from(frame)) // no bytes reordered or dropped
  })

  test('ordering: a frame queued during backpressure follows the first frame', () => {
    const { socket, received } = fakeSocket(4)
    const { wrapper, drain } = createBackpressuredSocket(socket)

    wrapper.write(Uint8Array.from([1, 2, 3, 4, 5, 6])) // writes 1-4, queues 5,6
    wrapper.write(Uint8Array.from([7, 8, 9])) // all queued behind the remainder
    expect(received).toEqual([1, 2, 3, 4])

    drain()
    expect(received).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9])
  })

  test('end() defers the real close until the queue has flushed', () => {
    const { socket, received, isEnded } = fakeSocket(4)
    const { wrapper, drain } = createBackpressuredSocket(socket)

    wrapper.write(Uint8Array.from([1, 2, 3, 4, 5, 6]))
    wrapper.end()
    expect(isEnded()).toBe(false) // bytes still queued — closing now would truncate

    drain()
    expect(received).toEqual([1, 2, 3, 4, 5, 6])
    expect(isEnded()).toBe(true)
  })

  test('a stuck reader past the cap ends the connection instead of buffering unbounded', () => {
    const { socket, isEnded } = fakeSocket(0) // accepts nothing → everything queues
    let overflowBytes = 0
    const { wrapper } = createBackpressuredSocket(socket, {
      maxQueuedBytes: 10,
      onOverflow: bytes => {
        overflowBytes = bytes
      },
    })

    wrapper.write(new Uint8Array(20))
    expect(overflowBytes).toBeGreaterThan(10)
    expect(isEnded()).toBe(true)
  })

  test('small frames that fit in one write never queue', () => {
    const { socket, received } = fakeSocket(8192)
    const { wrapper } = createBackpressuredSocket(socket)
    wrapper.write(Uint8Array.from([10, 20, 30]))
    expect(received).toEqual([10, 20, 30]) // delivered immediately, no drain needed
  })

  test('a frame exactly the size of one write is delivered whole, no queue', () => {
    const { socket, received } = fakeSocket(4)
    const { wrapper, drain } = createBackpressuredSocket(socket)
    wrapper.write(Uint8Array.from([1, 2, 3, 4])) // written === byteLength
    expect(received).toEqual([1, 2, 3, 4])
    drain() // spurious drain on an empty queue is a no-op
    expect(received).toEqual([1, 2, 3, 4])
  })

  test('end() before any write closes immediately', () => {
    const { socket, isEnded } = fakeSocket(4)
    const { wrapper } = createBackpressuredSocket(socket)
    wrapper.end()
    expect(isEnded()).toBe(true)
  })

  test('writes after overflow are dropped, not buffered', () => {
    const { socket, received } = fakeSocket(0) // accepts nothing
    const { wrapper } = createBackpressuredSocket(socket, { maxQueuedBytes: 10 })
    wrapper.write(new Uint8Array(20)) // trips overflow, ends the connection
    wrapper.write(Uint8Array.from([1, 2, 3])) // post-overflow write is a no-op
    expect(received).toEqual([]) // nothing delivered, nothing queued
  })
})
