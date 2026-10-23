import { open, writeFile, type FileHandle } from 'node:fs/promises'
import { constants } from 'node:fs'

export const INLINE_COMMAND_OUTPUT_LIMIT = 24_000

export function boundInlineCommandText(text: string, budget = INLINE_COMMAND_OUTPUT_LIMIT, tail = false): string {
  if (JSON.stringify(text).length <= budget) return text
  let low = 0
  let high = text.length
  while (low < high) {
    const size = Math.ceil((low + high) / 2)
    const candidate = tail ? text.slice(-size) : text.slice(0, size)
    if (JSON.stringify(candidate).length <= budget) low = size
    else high = size - 1
  }
  let value = low === 0 ? '' : tail ? text.slice(-low) : text.slice(0, low)
  // Do not display half of a supplementary Unicode character at a window edge.
  if (tail && /^[\uDC00-\uDFFF]/.test(value)) value = value.slice(1)
  if (!tail && /[\uD800-\uDBFF]$/.test(value)) value = value.slice(0, -1)
  return value
}

type InlineOutput = { output: string; outputTail?: string; omittedBytes?: number; fullOutputPath?: string }

/** Read the real file tail, never the end of the shell's already head-bounded stdout. */
export async function readInlineCommandOutput(stdout: string, fullOutputPath?: string): Promise<InlineOutput> {
  if (!fullOutputPath) return { output: stdout }
  const file = await open(fullOutputPath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    return await readOutputFile(file, fullOutputPath)
  } finally {
    await file.close()
  }
}

async function readOutputFile(file: FileHandle, fullOutputPath: string): Promise<InlineOutput> {
  const metadata = await file.stat()
  if (!metadata.isFile()) throw new Error('Command output is not a regular file')
  const { size } = metadata
  const headBuffer = Buffer.alloc(Math.min(size, INLINE_COMMAND_OUTPUT_LIMIT))
  const headRead = await file.read(headBuffer, 0, headBuffer.length, 0)
  const headText = new TextDecoder().decode(headBuffer.subarray(0, headRead.bytesRead), { stream: headRead.bytesRead < size })
  if (headRead.bytesRead === size && JSON.stringify(headText).length <= INLINE_COMMAND_OUTPUT_LIMIT) {
    return { output: headText, fullOutputPath }
  }
  const output = boundInlineCommandText(headText, INLINE_COMMAND_OUTPUT_LIMIT / 2)
  const headBytes = Buffer.byteLength(output)
  const tailPosition = Math.max(headBytes, size - INLINE_COMMAND_OUTPUT_LIMIT)
  const tailBuffer = Buffer.alloc(size - tailPosition)
  const tailRead = await file.read(tailBuffer, 0, tailBuffer.length, tailPosition)
  let start = 0
  while (start < tailRead.bytesRead && (tailBuffer[start]! & 0xc0) === 0x80) start++
  const tailText = tailBuffer.subarray(start, tailRead.bytesRead).toString('utf8')
  const outputTail = boundInlineCommandText(tailText, INLINE_COMMAND_OUTPUT_LIMIT / 2, true)
  return { output, outputTail, omittedBytes: Math.max(0, size - headBytes - Buffer.byteLength(outputTail)), fullOutputPath }
}

export async function retainInlineCommandOutput(stdout: string, artifactPath: string, sourcePath?: string): Promise<InlineOutput> {
  if (!sourcePath) {
    await writeFile(artifactPath, stdout, { flag: 'wx', mode: 0o600 })
    return readInlineCommandOutput(stdout, artifactPath)
  }
  // Shell code can rename its output pathname. Retain the opened regular file,
  // never follow a replacement symlink with the engine's ambient read authority.
  const source = await open(sourcePath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const output = await readOutputFile(source, artifactPath)
    const size = Math.min((await source.stat()).size, 64 * 1024 * 1024)
    const artifact = await open(artifactPath, 'wx', 0o600)
    try {
      const buffer = Buffer.alloc(64 * 1024)
      let position = 0
      while (position < size) {
        const { bytesRead } = await source.read(buffer, 0, Math.min(buffer.length, size - position), position)
        if (!bytesRead) break
        let written = 0
        while (written < bytesRead) {
          const result = await artifact.write(buffer, written, bytesRead - written, position + written)
          if (!result.bytesWritten) throw new Error('Could not retain command output')
          written += result.bytesWritten
        }
        position += bytesRead
      }
    } finally { await artifact.close() }
    return output
  } finally { await source.close() }
}
