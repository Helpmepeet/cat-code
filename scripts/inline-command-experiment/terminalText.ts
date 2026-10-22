import { Terminal } from '@xterm/headless'

export type TerminalTextOptions = {
  columns?: number
  rows?: number
  scrollback?: number
  maxRawBytes?: number
  maxTextBytes?: number
}

export type TerminalTextResult = {
  text: string
  rawBytes: number
  rawTruncated: boolean
  textTruncated: boolean
  historyTruncated: boolean
  discardedResponseBytes: number
  retainedLines: number
  bufferType: 'normal' | 'alternate'
}

function boundedInteger(value: number, min: number, max: number, name: string): number {
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`Invalid ${name}`)
  return value
}

/** Interprets a bounded capture, with no input channel or host-action handlers. */
export async function interpretTerminal(
  chunks: Iterable<string | Uint8Array>,
  options: TerminalTextOptions = {},
): Promise<TerminalTextResult> {
  const maxRawBytes = boundedInteger(options.maxRawBytes ?? 4 * 1024 * 1024, 1, 4 * 1024 * 1024, 'raw limit')
  const maxTextBytes = boundedInteger(options.maxTextBytes ?? 32 * 1024, 1, 64 * 1024, 'text limit')
  const terminal = new Terminal({
    cols: boundedInteger(options.columns ?? 100, 10, 240, 'columns'),
    rows: boundedInteger(options.rows ?? 24, 1, 120, 'rows'),
    scrollback: boundedInteger(options.scrollback ?? 2_000, 0, 2_000, 'scrollback'),
    allowProposedApi: true,
    disableStdin: true,
    logLevel: 'off',
  })
  let rawBytes = 0
  let rawTruncated = false
  let discardedResponseBytes = 0
  let historyTruncated = false
  terminal.registerMarker(0)?.onDispose(() => { historyTruncated = true })
  // This is a sink, never a shell-input callback. Keep it even though xterm
  // currently suppresses device-query replies when disableStdin is true.
  terminal.onData(data => { discardedResponseBytes += Buffer.byteLength(data) })
  for (const identifier of [8, 52, 133, 633]) {
    terminal.parser.registerOscHandler(identifier, () => true)
  }
  try {
    for (const chunk of chunks) {
      const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk
      const remaining = maxRawBytes - rawBytes
      const admitted = bytes.subarray(0, remaining)
      rawBytes += admitted.byteLength
      if (admitted.byteLength) await new Promise<void>(resolve => terminal.write(admitted, resolve))
      if (bytes.byteLength > remaining) {
        rawTruncated = true
        break
      }
    }
    const buffer = terminal.buffer.active
    let text = ''
    for (let i = 0; i < buffer.length; i++) {
      const line = buffer.getLine(i)
      if (!line) continue
      if (i > 0 && !line.isWrapped) text += '\n'
      text += line.translateToString(!buffer.getLine(i + 1)?.isWrapped)
    }
    text = text.replace(/\n+$/, '')
    let textTruncated = false
    if (Buffer.byteLength(text) > maxTextBytes) {
      textTruncated = true
      // Streaming decode excludes an incomplete final code point rather than
      // adding a replacement character that may itself exceed the byte budget.
      text = new TextDecoder().decode(Buffer.from(text).subarray(0, maxTextBytes), { stream: true })
    }
    return {
      text,
      rawBytes,
      rawTruncated,
      textTruncated,
      historyTruncated,
      discardedResponseBytes,
      retainedLines: buffer.length,
      bufferType: buffer.type,
    }
  } finally {
    terminal.dispose()
  }
}
