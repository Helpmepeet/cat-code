import type { SidecarSocketLike } from './sidecarServer.js'

// A reader that never drains would let the queue grow without bound; cut the
// connection instead of exhausting memory. Sized above MAX_OUTBOUND_FRAME_BYTES
// (32 MiB) so a single legitimate max-size frame's remainder always fits.
const DEFAULT_MAX_QUEUED_BYTES = 64 * 1024 * 1024

/**
 * The subset of a Bun `Socket` this module drives. Bun's `write()` follows
 * POSIX write(2): it returns the number of bytes actually accepted, which can
 * be FEWER than the buffer length once the socket's send buffer fills. The
 * caller must retry the remainder — Bun signals room again via the `drain`
 * socket handler.
 */
export type RawSocketLike = {
  write(data: Uint8Array): number
  end(): void
}

/**
 * Wrap a raw Bun Unix-socket in a `SidecarSocketLike` that survives partial
 * writes. Without this, any outbound frame larger than the socket's high-water
 * mark (~8 KiB) is silently truncated: `socket.write()`'s short return is
 * discarded, the length-prefixed FrameDecoder on the reader keeps consuming
 * unrelated bytes to satisfy the frame's declared length, and the whole stream
 * desyncs until it drops on invalid UTF-8. A >8 KiB `memory.snapshot` (fired on
 * every connect), a long assistant turn, or history replay all hit this.
 *
 * Bytes the socket can't accept yet are queued IN ORDER (a length-prefixed
 * stream desyncs if any byte is reordered or dropped) and flushed from the
 * `drain` handler. Locked transport (Unix-domain socket, D6) is unchanged —
 * this only fixes the write loop within it.
 *
 * Returns the wrapper plus a `drain()` to call from the socket's `drain` handler.
 */
export function createBackpressuredSocket(
  socket: RawSocketLike,
  options: {
    maxQueuedBytes?: number
    onOverflow?: (queuedBytes: number) => void
  } = {},
): { wrapper: SidecarSocketLike; drain: () => void } {
  const maxQueuedBytes = options.maxQueuedBytes ?? DEFAULT_MAX_QUEUED_BYTES
  // Unwritten byte chunks, head-first.
  const queue: Uint8Array[] = []
  let queuedBytes = 0
  let ended = false
  let overflowed = false

  const enqueue = (chunk: Uint8Array): void => {
    queue.push(chunk)
    queuedBytes += chunk.byteLength
    if (queuedBytes > maxQueuedBytes && !overflowed) {
      overflowed = true
      const overflowedBytes = queuedBytes
      queue.length = 0
      queuedBytes = 0
      options.onOverflow?.(overflowedBytes)
      socket.end()
    }
  }

  const wrapper: SidecarSocketLike = {
    write: data => {
      if (overflowed) return
      // Once anything is queued, everything queues behind it — ordering is
      // load-bearing for the length-prefixed stream.
      if (queue.length > 0) {
        enqueue(data)
        return
      }
      const n = socket.write(data)
      const written = n > 0 ? n : 0
      if (written < data.byteLength) {
        enqueue(written > 0 ? data.subarray(written) : data)
      }
    },
    end: () => {
      ended = true
      // Defer the real close until buffered bytes flush, else `end()` truncates
      // exactly the frames we queued to protect. If the peer stops reading
      // without disconnecting, `drain` never fires and this deferred close waits
      // — that's bounded externally, not here: the socket `close`/`error`
      // handler (and die-with-window lifetime) tears the connection down.
      if (queue.length === 0 && !overflowed) socket.end()
    },
  }

  const drain = (): void => {
    if (overflowed) return
    while (queue.length > 0) {
      const chunk = queue[0]!
      const n = socket.write(chunk)
      const written = n > 0 ? n : 0
      if (written >= chunk.byteLength) {
        queue.shift()
        queuedBytes -= chunk.byteLength
      } else {
        // Still backpressured — keep the remainder at the head, wait for the
        // next drain.
        if (written > 0) {
          queue[0] = chunk.subarray(written)
          queuedBytes -= written
        }
        return
      }
    }
    if (ended) socket.end()
  }

  return { wrapper, drain }
}
