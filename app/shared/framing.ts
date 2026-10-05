/**
 * Length-prefixed JSON framing for the Unix-domain socket between the Electron
 * supervisor and a Bun sidecar.
 *
 * A socket is a byte stream, not a message stream: a single `write` can arrive
 * split across reads or coalesced with the next. We frame each JSON payload with
 * a 4-byte big-endian unsigned length prefix so the reader can reassemble exact
 * message boundaries.
 *
 * The max-frame cap (SECURITY-MINIMUM §2 R4 / T7) is enforced here at decode
 * time: an oversized declared length is rejected before the body is buffered, so
 * a compromised peer cannot force an unbounded allocation.
 */

const LENGTH_PREFIX_BYTES = 4

/** Fatal UTF-8 decoder: throws on malformed bytes rather than substituting (F14). */
const FATAL_UTF8 = new TextDecoder('utf-8', { fatal: true })

/** Encode one payload object into a length-prefixed frame. */
export function encodeFrame(payload: unknown): Buffer {
  const json = Buffer.from(JSON.stringify(payload), 'utf8')
  const prefix = Buffer.allocUnsafe(LENGTH_PREFIX_BYTES)
  prefix.writeUInt32BE(json.byteLength, 0)
  return Buffer.concat([prefix, json])
}

export type FrameDecodeResult =
  | { kind: 'frame'; payload: unknown }
  | { kind: 'error'; reason: string }

/**
 * Stateful decoder. Feed it socket chunks; it yields whole decoded frames.
 * Enforces `maxFrameBytes` on the declared length (T7). On a protocol violation
 * it emits an `error` result and the caller should drop the connection — the
 * stream can no longer be trusted to be re-synchronizable.
 */
export class FrameDecoder {
  private buffer: Buffer = Buffer.alloc(0)
  private readOffset = 0
  private writeOffset = 0

  constructor(private readonly maxFrameBytes: number) {}

  reset(): void {
    this.releaseBuffer()
  }

  push(chunk: Buffer): FrameDecodeResult[] {
    if (chunk.length === 0) return []
    const results: FrameDecodeResult[] = []
    let cursor = 0

    while (cursor < chunk.length) {
      let pendingBytes = this.writeOffset - this.readOffset
      const availableBytes = chunk.length - cursor

      if (pendingBytes === 0) {
        if (availableBytes < LENGTH_PREFIX_BYTES) {
          this.append(chunk, cursor, chunk.length)
          break
        }

        const declaredLength = chunk.readUInt32BE(cursor)
        if (declaredLength > this.maxFrameBytes) {
          results.push(this.oversizedFrameError(declaredLength))
          return results
        }

        const totalLength = LENGTH_PREFIX_BYTES + declaredLength
        if (availableBytes >= totalLength) {
          const bodyStart = cursor + LENGTH_PREFIX_BYTES
          if (!this.decodeBody(chunk.subarray(bodyStart, cursor + totalLength), results)) return results
          cursor += totalLength
          continue
        }

        // Retain only the unfinished frame. In particular, never copy bytes
        // after an incomplete frame into the decoder's backing allocation.
        this.append(chunk, cursor, chunk.length)
        break
      }

      if (pendingBytes < LENGTH_PREFIX_BYTES) {
        const headerBytes = Math.min(
          LENGTH_PREFIX_BYTES - pendingBytes,
          availableBytes,
        )
        this.append(chunk, cursor, cursor + headerBytes)
        cursor += headerBytes
        pendingBytes += headerBytes
        if (pendingBytes < LENGTH_PREFIX_BYTES) break
      }

      const declaredLength = this.buffer.readUInt32BE(this.readOffset)
      if (declaredLength > this.maxFrameBytes) {
        results.push(this.oversizedFrameError(declaredLength))
        return results
      }
      const totalLength = LENGTH_PREFIX_BYTES + declaredLength
      const bytesNeeded = totalLength - pendingBytes
      const bodyBytes = Math.min(bytesNeeded, chunk.length - cursor)
      this.append(chunk, cursor, cursor + bodyBytes)
      cursor += bodyBytes
      if (bodyBytes < bytesNeeded) break

      const body = this.buffer.subarray(
        this.readOffset + LENGTH_PREFIX_BYTES,
        this.readOffset + totalLength,
      )
      if (!this.decodeBody(body, results)) return results
      this.releaseBuffer()
    }

    return results
  }

  private append(source: Buffer, start: number, end: number): void {
    const additionalBytes = end - start
    if (additionalBytes === 0) return
    const pendingBytes = this.writeOffset - this.readOffset
    if (this.buffer.length - this.writeOffset >= additionalBytes) {
      source.copy(this.buffer, this.writeOffset, start, end)
      this.writeOffset += additionalBytes
      return
    }

    if (this.readOffset > 0 && this.buffer.length - pendingBytes >= additionalBytes) {
      this.buffer.copy(this.buffer, 0, this.readOffset, this.writeOffset)
      this.readOffset = 0
      this.writeOffset = pendingBytes
      source.copy(this.buffer, this.writeOffset, start, end)
      this.writeOffset += additionalBytes
      return
    }

    let capacity = Math.max(1024, this.buffer.length)
    while (capacity < pendingBytes + additionalBytes) capacity *= 2
    // A valid body plus its header may straddle a power-of-two boundary. Keep
    // that last growth within the configured frame allocation ceiling.
    capacity = Math.min(capacity, this.maxFrameBytes + LENGTH_PREFIX_BYTES)
    const grown = Buffer.allocUnsafe(capacity)
    if (pendingBytes > 0) this.buffer.copy(grown, 0, this.readOffset, this.writeOffset)
    this.buffer = grown
    this.readOffset = 0
    this.writeOffset = pendingBytes
    source.copy(this.buffer, this.writeOffset, start, end)
    this.writeOffset += additionalBytes
    return
  }

  private decodeBody(body: Buffer, results: FrameDecodeResult[]): boolean {
    try {
      // F14 — fatal UTF-8 rejects malformed bytes instead of replacing them.
      const text = FATAL_UTF8.decode(body)
      results.push({ kind: 'frame', payload: JSON.parse(text) })
      return true
    } catch {
      results.push({ kind: 'error', reason: 'frame body is not valid UTF-8 JSON' })
      this.releaseBuffer()
      return false
    }
  }

  private oversizedFrameError(declaredLength: number): FrameDecodeResult {
    this.releaseBuffer()
    return {
      kind: 'error',
      reason: `frame length ${declaredLength} exceeds max ${this.maxFrameBytes}`,
    }
  }

  private releaseBuffer(): void {
    this.buffer = Buffer.alloc(0)
    this.readOffset = 0
    this.writeOffset = 0
  }
}
