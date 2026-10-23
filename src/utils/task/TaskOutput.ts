import { open, unlink } from 'fs/promises'
import { constants } from 'fs'
import { CircularBuffer } from '../CircularBuffer.js'
import { logForDebugging } from '../debug.js'
import { readFileRange, tailFile } from '../fsOperations.js'
import { getMaxOutputLength } from '../shell/outputLimits.js'
import { safeJoinLines } from '../stringUtils.js'
import { DiskTaskOutput, getTaskOutputPath } from './diskOutput.js'

const DEFAULT_MAX_MEMORY = 8 * 1024 * 1024 // 8MB
const POLL_INTERVAL_MS = 1000
const INLINE_POLL_INTERVAL_MS = 100
const PROGRESS_TAIL_BYTES = 4096

type PollingState = {
  instance: TaskOutput
  inline: boolean
  timer?: ReturnType<typeof setTimeout>
  lastContent: string
  lastBytes: number
}

async function readInlineTail(path: string) {
  await using file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  const metadata = await file.stat()
  if (!metadata.isFile()) throw new Error('Command output is not a regular file')
  const bytesTotal = metadata.size
  const offset = Math.max(0, bytesTotal - PROGRESS_TAIL_BYTES)
  const buffer = Buffer.alloc(Math.min(bytesTotal, PROGRESS_TAIL_BYTES))
  let bytesRead = 0
  while (bytesRead < buffer.length) {
    const result = await file.read(
      buffer,
      bytesRead,
      buffer.length - bytesRead,
      offset + bytesRead,
    )
    if (!result.bytesRead) break
    bytesRead += result.bytesRead
  }
  let start = 0
  // Skip a code point split by the rolling window; withhold incomplete final bytes.
  if (offset > 0) {
    while (start < bytesRead && (buffer[start]! & 0xc0) === 0x80) start++
  }
  const content = new TextDecoder().decode(buffer.subarray(start, bytesRead), {
    stream: true,
  })
  return { content, bytesRead, bytesTotal }
}

type ProgressCallback = (
  lastLines: string,
  allLines: string,
  totalLines: number,
  totalBytes: number,
  isIncomplete: boolean,
) => void

/**
 * Single source of truth for a shell command's output.
 *
 * For bash commands (file mode): both stdout and stderr go directly to
 * a file via stdio fds — neither enters JS. Progress is extracted by
 * polling the file tail. getStderr() returns '' since stderr is
 * interleaved in the output file.
 *
 * For hooks (pipe mode): data flows through writeStdout()/writeStderr()
 * and is buffered in memory, spilling to disk if it exceeds the limit.
 */
export class TaskOutput {
  readonly taskId: string
  readonly path: string
  /** True when stdout goes to a file fd (bypassing JS). False for pipe mode (hooks). */
  readonly stdoutToFile: boolean
  #stdoutBuffer = ''
  #stderrBuffer = ''
  #disk: DiskTaskOutput | null = null
  #recentLines = new CircularBuffer<string>(1000)
  #totalLines = 0
  #totalBytes = 0
  #maxMemory: number
  #onProgress: ProgressCallback | null
  /** Set by getStdout() — true when the file was fully read (≤ maxOutputLength). */
  #outputFileRedundant = false
  /** Set by getStdout() — total file size in bytes. */
  #outputFileSize = 0

  // --- Shared poller state ---

  /** Registry of all file-mode TaskOutput instances with onProgress callbacks. */
  static #registry = new Map<string, TaskOutput>()
  /** Subscription identity fences results from reads started before unsubscribe. */
  static #activePolling = new Map<string, PollingState>()
  static #reading = new Set<string>()
  static #pollInterval: ReturnType<typeof setInterval> | null = null

  constructor(
    taskId: string,
    onProgress: ProgressCallback | null,
    stdoutToFile = false,
    maxMemory: number = DEFAULT_MAX_MEMORY,
  ) {
    this.taskId = taskId
    this.path = getTaskOutputPath(taskId)
    this.stdoutToFile = stdoutToFile
    this.#maxMemory = maxMemory
    this.#onProgress = onProgress

    // Register for polling when stdout goes to a file and progress is needed.
    // Consumers opt into polling via startPolling/stopPolling.
    if (stdoutToFile && onProgress) {
      TaskOutput.#registry.set(taskId, this)
    }
  }

  /**
   * Begin polling the output file for progress. Inline consumers sample
   * immediately; ordinary consumers retain their shared tick.
   */
  static startPolling(taskId: string, options?: { inline: true }): void {
    const instance = TaskOutput.#registry.get(taskId)
    if (!instance || !instance.#onProgress) {
      return
    }
    const existing = TaskOutput.#activePolling.get(taskId)
    if (
      existing?.instance === instance &&
      existing.inline === !!options?.inline
    )
      return
    TaskOutput.stopPolling(taskId)
    const state: PollingState = {
      instance,
      inline: !!options?.inline,
      lastContent: '',
      lastBytes: 0,
    }
    TaskOutput.#activePolling.set(taskId, state)
    if (state.inline) {
      TaskOutput.#sample(taskId, state)
    } else if (!TaskOutput.#pollInterval) {
      TaskOutput.#pollInterval = setInterval(TaskOutput.#tick, POLL_INTERVAL_MS)
      TaskOutput.#pollInterval.unref()
    }
  }

  /**
   * Stop polling; an in-flight read cannot publish into a removed subscription.
   */
  static stopPolling(taskId: string): void {
    const state = TaskOutput.#activePolling.get(taskId)
    if (state?.timer) clearTimeout(state.timer)
    TaskOutput.#activePolling.delete(taskId)
    if (
      ![...TaskOutput.#activePolling.values()].some((state) => !state.inline) &&
      TaskOutput.#pollInterval
    ) {
      clearInterval(TaskOutput.#pollInterval)
      TaskOutput.#pollInterval = null
    }
  }

  /**
   * Shared tick for ordinary consumers. The per-task read fence prevents
   * overlapping reads even when a subscription is stopped and restarted.
   */
  static #tick(): void {
    for (const [taskId, state] of TaskOutput.#activePolling) {
      if (!state.inline) TaskOutput.#sample(taskId, state)
    }
  }

  static #sample(taskId: string, state: PollingState): void {
    const entry = state.instance
    if (!entry.#onProgress || TaskOutput.#reading.has(taskId)) return
    TaskOutput.#reading.add(taskId)
    const read = state.inline
      ? readInlineTail(entry.path)
      : tailFile(entry.path, PROGRESS_TAIL_BYTES)
    void read
      .then(
        ({ content, bytesRead, bytesTotal }) => {
          if (
            !entry.#onProgress ||
            TaskOutput.#activePolling.get(taskId) !== state
          )
            return
          if (state.inline) {
            if (content === state.lastContent && bytesTotal === state.lastBytes)
              return
            state.lastContent = content
            state.lastBytes = bytesTotal
            if (!content && bytesTotal === 0) return
          }
          // Ordinary polling calls onProgress even when content is empty, so the
          // progress loop wakes up and can check for backgrounding.
          // Commands like `git log -S` produce no output for long periods.
          if (!content) {
            entry.#onProgress('', '', entry.#totalLines, bytesTotal, false)
            return
          }
          // Count all newlines in the tail and capture slice points for the
          // last 5 and last 100 lines. Uncapped so extrapolation stays accurate
          // for dense output (short lines → >100 newlines in 4KB).
          let pos = content.length
          let n5 = 0
          let n100 = 0
          let lineCount = 0
          while (pos > 0) {
            pos = content.lastIndexOf('\n', pos - 1)
            lineCount++
            if (lineCount === 5) n5 = pos <= 0 ? 0 : pos + 1
            if (lineCount === 100) n100 = pos <= 0 ? 0 : pos + 1
          }
          // lineCount is exact when the whole file fits in PROGRESS_TAIL_BYTES.
          // Otherwise extrapolate from the tail sample; monotone max keeps the
          // counter from going backwards when the tail has longer lines on one tick.
          const totalLines =
            bytesRead >= bytesTotal
              ? lineCount
              : Math.max(
                  entry.#totalLines,
                  Math.round((bytesTotal / bytesRead) * lineCount),
                )
          entry.#totalLines = totalLines
          entry.#totalBytes = bytesTotal
          entry.#onProgress(
            content.slice(n5),
            content.slice(n100),
            totalLines,
            bytesTotal,
            bytesRead < bytesTotal,
          )
        },
        () => {
          // File may not exist yet
        },
      )
      .finally(() => {
        TaskOutput.#reading.delete(taskId)
        const current = TaskOutput.#activePolling.get(taskId)
        if (!current?.inline) return
        if (current !== state) {
          TaskOutput.#sample(taskId, current)
          return
        }
        current.timer = setTimeout(
          () => TaskOutput.#sample(taskId, current),
          INLINE_POLL_INTERVAL_MS,
        )
        current.timer.unref()
      })
  }

  /** Write stdout data (pipe mode only — used by hooks). */
  writeStdout(data: string): void {
    this.#writeBuffered(data, false)
  }

  /** Write stderr data (always piped). */
  writeStderr(data: string): void {
    this.#writeBuffered(data, true)
  }

  #writeBuffered(data: string, isStderr: boolean): void {
    this.#totalBytes += data.length

    this.#updateProgress(data)

    // Write to disk if already overflowed
    if (this.#disk) {
      this.#disk.append(isStderr ? `[stderr] ${data}` : data)
      return
    }

    // Check if this chunk would exceed the in-memory limit
    const totalMem =
      this.#stdoutBuffer.length + this.#stderrBuffer.length + data.length
    if (totalMem > this.#maxMemory) {
      this.#spillToDisk(isStderr ? data : null, isStderr ? null : data)
      return
    }

    if (isStderr) {
      this.#stderrBuffer += data
    } else {
      this.#stdoutBuffer += data
    }
  }

  /**
   * Single backward pass: count all newlines (for totalLines) and extract
   * the last few lines as flat copies (for the CircularBuffer / progress).
   * Only used in pipe mode (hooks). File mode uses the shared poller.
   */
  #updateProgress(data: string): void {
    const MAX_PROGRESS_BYTES = 4096
    const MAX_PROGRESS_LINES = 100

    let lineCount = 0
    const lines: string[] = []
    let extractedBytes = 0
    let pos = data.length

    while (pos > 0) {
      const prev = data.lastIndexOf('\n', pos - 1)
      if (prev === -1) {
        break
      }
      lineCount++
      if (
        lines.length < MAX_PROGRESS_LINES &&
        extractedBytes < MAX_PROGRESS_BYTES
      ) {
        const lineLen = pos - prev - 1
        if (lineLen > 0 && lineLen <= MAX_PROGRESS_BYTES - extractedBytes) {
          const line = data.slice(prev + 1, pos)
          if (line.trim()) {
            lines.push(Buffer.from(line).toString())
            extractedBytes += lineLen
          }
        }
      }
      pos = prev
    }

    this.#totalLines += lineCount

    for (let i = lines.length - 1; i >= 0; i--) {
      this.#recentLines.add(lines[i]!)
    }

    if (this.#onProgress && lines.length > 0) {
      const recent = this.#recentLines.getRecent(5)
      this.#onProgress(
        safeJoinLines(recent, '\n'),
        safeJoinLines(this.#recentLines.getRecent(100), '\n'),
        this.#totalLines,
        this.#totalBytes,
        this.#disk !== null,
      )
    }
  }

  #spillToDisk(stderrChunk: string | null, stdoutChunk: string | null): void {
    this.#disk = new DiskTaskOutput(this.taskId)

    // Flush existing buffers
    if (this.#stdoutBuffer) {
      this.#disk.append(this.#stdoutBuffer)
      this.#stdoutBuffer = ''
    }
    if (this.#stderrBuffer) {
      this.#disk.append(`[stderr] ${this.#stderrBuffer}`)
      this.#stderrBuffer = ''
    }

    // Write the chunk that triggered overflow
    if (stdoutChunk) {
      this.#disk.append(stdoutChunk)
    }
    if (stderrChunk) {
      this.#disk.append(`[stderr] ${stderrChunk}`)
    }
  }

  /**
   * Get stdout. In file mode, reads from the output file.
   * In pipe mode, returns the in-memory buffer or tail from CircularBuffer.
   */
  async getStdout(): Promise<string> {
    if (this.stdoutToFile) {
      return this.#readStdoutFromFile()
    }
    // Pipe mode (hooks) — use in-memory data
    if (this.#disk) {
      const recent = this.#recentLines.getRecent(5)
      const tail = safeJoinLines(recent, '\n')
      const sizeKB = Math.round(this.#totalBytes / 1024)
      const notice = `\nOutput truncated (${sizeKB}KB total). Full output saved to: ${this.path}`
      return tail ? tail + notice : notice.trimStart()
    }
    return this.#stdoutBuffer
  }

  async #readStdoutFromFile(): Promise<string> {
    const maxBytes = getMaxOutputLength()
    try {
      const result = await readFileRange(this.path, 0, maxBytes)
      if (!result) {
        this.#outputFileRedundant = true
        return ''
      }
      const { content, bytesRead, bytesTotal } = result
      // If the file fits, it's fully captured inline and can be deleted.
      // If not, return what we read — processToolResultBlock handles
      // the <persisted-output> formatting and persistence downstream.
      this.#outputFileSize = bytesTotal
      this.#outputFileRedundant = bytesTotal <= bytesRead
      return content
    } catch (err) {
      // Surface the error instead of silently returning empty. An ENOENT here
      // means the output file was deleted while the command was running
      // (historically: cross-session startup cleanup in the same project dir).
      // Returning a diagnostic string keeps the tool_result non-empty, which
      // avoids reminder-only-at-tail confusion downstream and tells the model
      // (and us, via the transcript) what actually happened.
      const code =
        err instanceof Error && 'code' in err ? String(err.code) : 'unknown'
      logForDebugging(
        `TaskOutput.#readStdoutFromFile: failed to read ${this.path} (${code}): ${err}`,
      )
      return `<bash output unavailable: output file ${this.path} could not be read (${code}). This usually means another Cat Code process in the same project deleted it during startup cleanup.>`
    }
  }

  /** Sync getter for ExecResult.stderr */
  getStderr(): string {
    if (this.#disk) {
      return ''
    }
    return this.#stderrBuffer
  }

  get isOverflowed(): boolean {
    return this.#disk !== null
  }

  get totalLines(): number {
    return this.#totalLines
  }

  get totalBytes(): number {
    return this.#totalBytes
  }

  /**
   * True after getStdout() when the output file was fully read.
   * The file content is redundant (fully in ExecResult.stdout) and can be deleted.
   */
  get outputFileRedundant(): boolean {
    return this.#outputFileRedundant
  }

  /** Total file size in bytes, set after getStdout() reads the file. */
  get outputFileSize(): number {
    return this.#outputFileSize
  }

  /** Force all buffered content to disk. Call when backgrounding. */
  spillToDisk(): void {
    if (!this.#disk) {
      this.#spillToDisk(null, null)
    }
  }

  async flush(): Promise<void> {
    await this.#disk?.flush()
  }

  /** Delete the output file (fire-and-forget safe). */
  async deleteOutputFile(): Promise<void> {
    try {
      await unlink(this.path)
    } catch {
      // File may already be deleted or not exist
    }
  }

  clear(): void {
    this.#stdoutBuffer = ''
    this.#stderrBuffer = ''
    this.#recentLines.clear()
    this.#onProgress = null
    this.#disk?.cancel()
    if (TaskOutput.#activePolling.get(this.taskId)?.instance === this)
      TaskOutput.stopPolling(this.taskId)
    if (TaskOutput.#registry.get(this.taskId) === this)
      TaskOutput.#registry.delete(this.taskId)
  }
}
