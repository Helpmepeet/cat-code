import { describe, test, expect } from 'bun:test'
import { unlinkSync } from 'fs'
import { encodeFrame, FrameDecoder } from '../shared/framing.js'
import { MAX_OUTBOUND_FRAME_BYTES } from '../shared/limits.js'
import { createBackpressuredSocket } from './backpressuredSocket.js'

// Real Bun Unix-socket round-trip, exercising Bun's ACTUAL partial-write +
// drain behaviour — the coverage the in-memory unit test can't give, and the
// gap that let a >8 KiB truncation slip past the whole app suite (its tests use
// in-memory SidecarSocketLike fakes). A frame far larger than any single
// write() syscall forces the drain loop; before the fix it truncated at the
// send-buffer boundary and the reader's length-prefixed FrameDecoder desynced.
const BunRt = (globalThis as { Bun?: typeof import('bun') }).Bun

describe('backpressured socket over a real Bun unix socket', () => {
  test('a multi-MB frame round-trips intact (no truncation/desync)', async () => {
    if (!BunRt?.listen) return // Bun-only path

    const socketPath = `/tmp/catcode-bp-probe-${process.pid}.sock`
    try {
      unlinkSync(socketPath)
    } catch {
      // not present — fine
    }

    // ~3 MB: cannot fit one write() on any platform, so the drain loop is
    // mandatory (and the pre-fix truncation is guaranteed to trigger).
    const bigBody = 'x'.repeat(3 * 1024 * 1024)
    const frame = encodeFrame({ kind: 'probe', body: bigBody })
    const drains = new Map<unknown, () => void>()
    let drainCalls = 0

    const server = BunRt.listen({
      unix: socketPath,
      socket: {
        open(socket) {
          const { wrapper, drain } = createBackpressuredSocket(socket)
          drains.set(socket, drain)
          wrapper.write(frame)
        },
        drain(socket) {
          drainCalls++
          drains.get(socket)?.()
        },
      },
    })

    try {
      const payload = await new Promise<{ kind: string; body: string }>(
        (resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('timed out')), 10_000)
          const decoder = new FrameDecoder(MAX_OUTBOUND_FRAME_BYTES)
          BunRt.connect({
            unix: socketPath,
            socket: {
              data(_socket, chunk) {
                for (const result of decoder.push(Buffer.from(chunk))) {
                  clearTimeout(timer)
                  if (result.kind === 'error') reject(new Error(result.reason))
                  else
                    resolve(
                      result.payload as { kind: string; body: string },
                    )
                }
              },
              error(_socket, err) {
                clearTimeout(timer)
                reject(err)
              },
            },
          }).catch(reject)
        },
      )

      expect(payload.kind).toBe('probe')
      expect(payload.body.length).toBe(bigBody.length)
      expect(payload.body).toBe(bigBody)
      // Prove the test actually exercised backpressure (not a trivial pass):
      // a 3 MB frame must have needed at least one drain.
      expect(drainCalls).toBeGreaterThan(0)
    } finally {
      server.stop(true)
      try {
        unlinkSync(socketPath)
      } catch {
        // already gone
      }
    }
  }, 15_000)
})
