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

  constructor(private readonly maxFrameBytes: number) {}

  push(chunk: Buffer): FrameDecodeResult[] {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk])
    const results: FrameDecodeResult[] = []

    while (this.buffer.length >= LENGTH_PREFIX_BYTES) {
      const declaredLength = this.buffer.readUInt32BE(0)

      if (declaredLength > this.maxFrameBytes) {
        results.push({
          kind: 'error',
          reason: `frame length ${declaredLength} exceeds max ${this.maxFrameBytes}`,
        })
        // Unrecoverable: we cannot trust where the next boundary is.
        this.buffer = Buffer.alloc(0)
        return results
      }

      const totalLength = LENGTH_PREFIX_BYTES + declaredLength
      if (this.buffer.length < totalLength) {
        break // wait for more bytes
      }

      const body = this.buffer.subarray(LENGTH_PREFIX_BYTES, totalLength)
      this.buffer = this.buffer.subarray(totalLength)

      try {
        // F14 — decode UTF-8 in FATAL mode so malformed bytes (e.g. a lone 0xff)
        // throw a protocol error instead of being silently replaced with U+FFFD.
        const text = FATAL_UTF8.decode(body)
        results.push({ kind: 'frame', payload: JSON.parse(text) })
      } catch {
        results.push({ kind: 'error', reason: 'frame body is not valid UTF-8 JSON' })
        this.buffer = Buffer.alloc(0)
        return results
      }
    }

    return results
  }
}
