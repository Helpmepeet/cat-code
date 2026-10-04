const MAX_STARTUP_STDERR_CHARS = 8 * 1024

type StderrStream = {
  on(event: 'data', listener: (data: Buffer) => void): unknown
  off(event: 'data', listener: (data: Buffer) => void): unknown
}

/** Keep a bounded startup excerpt while always leaving the pipe drained. */
export function captureMcpStartupStderr(stream: StderrStream) {
  let output = ''
  let truncated = false
  let collecting = true
  const handler = (data: Buffer) => {
    if (!collecting || data.length === 0) return
    if (output.length >= MAX_STARTUP_STDERR_CHARS) {
      truncated = true
      return
    }
    const remaining = MAX_STARTUP_STDERR_CHARS - output.length
    // Four input bytes per remaining UTF-16 code unit is sufficient to fill
    // the excerpt, while avoiding decoding a large pipe chunk just to discard it.
    const bytesToDecode = Math.min(data.length, remaining * 4)
    const text = data.subarray(0, bytesToDecode).toString('utf8')
    output += text.slice(0, remaining)
    if (text.length > remaining || bytesToDecode < data.length) truncated = true
  }
  stream.on('data', handler)

  return {
    take(): string {
      const result = output + (truncated ? '\n[stderr truncated]' : '')
      output = ''
      truncated = false
      return result
    },
    stopCapturing(): void {
      collecting = false
      output = ''
      truncated = false
    },
    dispose(): void {
      collecting = false
      output = ''
      truncated = false
      stream.off('data', handler)
    },
  }
}
