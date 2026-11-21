import stripAnsi from 'strip-ansi'
import { splitCommandWithOperators } from '../../utils/bash/commands.js'
import { readFileRange, tailFile } from '../../utils/fsOperations.js'

const SCAN_HEAD_BYTES = 2 * 1024 * 1024
const SCAN_TAIL_BYTES = 32 * 1024
const MAX_EXCERPT_LINE_BYTES = 240

const bunTrailer = /^(?: *\d+ (?:pass|skip|todo|fail|errors?|expect\(\) calls)\n)+Ran \d+ tests? across \d+ files?\. \[[\d.]+(?:ms|s)\]$/gm
const unittestTrailer = /^-{70}\n(Ran \d+ tests? in [\d.]+s\n\nFAILED \([a-z ]+=\d+(?:, [a-z ]+=\d+)*\))$/gm
const bunBanner = /^bun test v\d+\.\d+\.\d+(?:-\S+)? \([\da-f]+\)$/m
const bunCommand = /^(?:\S+\/)?bun[ \t]+(?:(?:run|--cwd[ \t]+\S+)[ \t]+)*test(?::[\w:-]+)?(?:\s|$)/
const unittestCommand = /^(?:\S+\/)?python3?(?:\.\d+)?[ \t]+-m[ \t]+unittest(?:\s|$)/

type AddCase = (key: string, lines: string[]) => void

function getTestRunner(command: string): 'bun' | 'unittest' | undefined {
  for (const part of splitCommandWithOperators(command)) {
    const executable = part.trimStart().replace(/^(?:[A-Za-z_]\w*=\S+[ \t]+)+/, '')
    if (bunCommand.test(executable)) return 'bun'
    if (unittestCommand.test(executable)) return 'unittest'
  }
  return undefined
}

function bunFailures(lines: string[], addCase: AddCase): void {
  let file = ''
  let diagnostics: string[] = []
  let setup = false
  for (const [index, line] of lines.entries()) {
    // Bun can repeat the failures in its summary after all files complete.
    if (/^\d+ tests? failed:$/.test(line)) break
    if (/^\S.*\.[cm]?[jt]sx?:$/.test(line)) {
      file = line
      diagnostics = []
      setup = false
      continue
    }
    if (line === '# Unhandled error between tests') {
      diagnostics = []
      setup = true
      continue
    }
    if (setup && /^error: \S/.test(line)) {
      addCase(`${file}\n${line}`, ['# Unhandled error between tests', line])
      setup = false
      continue
    }
    if (diagnostics.length === 0 && /^error: /.test(line)) {
      diagnostics.push(line)
    } else if (diagnostics.length > 0 && diagnostics.length < 3 && /^(?:Expected:|Received:|[+-]) /.test(line)) {
      diagnostics.push(line)
    }
    const failure = line.match(/^\(fail\) (.+?)(?: \[[\d.]+(?:ms|s)\])?$/)?.[1]
    if (failure) {
      const nextLine = lines[index + 1]
      if (nextLine && /^ +\^ this test timed out after /.test(nextLine)) diagnostics.push(nextLine)
      addCase(`${file}\n${failure}`, [`(fail) ${failure}`, ...diagnostics])
    }
    if (/^\((?:pass|fail|skip|todo)\) /.test(line)) diagnostics = []
  }
}

function unittestFailures(lines: string[], addCase: AddCase): void {
  const headerRule = '='.repeat(70)
  const divider = '-'.repeat(70)
  let title: string | undefined
  for (const [index, line] of lines.entries()) {
    if (line === headerRule) {
      if (title) addCase(title, [title])
      title = undefined
    }
    if (/^(?:FAIL|ERROR): \S/.test(line) && lines[index - 1] === headerRule && lines[index + 1] === divider) {
      title = line
      continue
    }
    if (title && /^[\w.]*?(?:Error|Exception|Failure)(?::|$)/.test(line)) {
      addCase(title, [title, line])
      title = undefined
    }
  }
  if (title) addCase(title, [title])
}

function limitLine(line: string): string {
  const trimmed = line.trim()
  const bytes = Buffer.from(trimmed)
  if (bytes.length <= MAX_EXCERPT_LINE_BYTES) return trimmed
  let end = MAX_EXCERPT_LINE_BYTES - Buffer.byteLength('…')
  while ((bytes[end]! & 0xc0) === 0x80) end--
  return bytes.toString('utf8', 0, end) + '…'
}

export async function readTestFailurePreview(
  command: string,
  path: string,
  maxBytes: number,
): Promise<string | undefined> {
  try {
    const runner = getTestRunner(command)
    if (!runner) return undefined

    const tail = await tailFile(path, SCAN_TAIL_BYTES)
    const tailText = stripAnsi(tail.content).replaceAll('\r\n', '\n')
    const summary = runner === 'bun'
      ? [...tailText.matchAll(bunTrailer)].at(-1)?.[0].trim()
      : [...tailText.matchAll(unittestTrailer)].at(-1)?.[1]
    if (!summary || (runner === 'bun' && !/^ *[1-9]\d* fail$/m.test(summary))) return undefined

    const headLimit = tail.bytesTotal <= SCAN_HEAD_BYTES + SCAN_TAIL_BYTES
      ? tail.bytesTotal
      : SCAN_HEAD_BYTES
    const head = await readFileRange(path, 0, headLimit)
    if (!head) return undefined
    const headText = stripAnsi(head.content).replaceAll('\r\n', '\n')
    if (runner === 'bun' && !bunBanner.test(headText.slice(0, 4096))) return undefined

    const scanFailures = runner === 'bun' ? bunFailures : unittestFailures
    const seen = new Set<string>()
    const excerpts: string[] = []
    let remaining = maxBytes - Buffer.byteLength(summary) - 2
    const addCase: AddCase = (key, lines) => {
      if (remaining <= 0 || seen.has(key)) return
      const excerpt = lines.map(limitLine).join('\n')
      const size = Buffer.byteLength(excerpt) + (excerpts.length === 0 ? 0 : 2)
      if (size > remaining) return
      seen.add(key)
      excerpts.push(excerpt)
      remaining -= size
    }

    const headLines = headText.split('\n')
    if (head.bytesRead < head.bytesTotal) headLines.pop()
    scanFailures(headLines, addCase)
    if (head.bytesRead < head.bytesTotal) {
      // The tail can start in the middle of an output line or UTF-8 code point.
      scanFailures(tailText.split('\n').slice(1), addCase)
    }
    return excerpts.length > 0 ? [...excerpts, summary].join('\n\n') : undefined
  } catch {
    // A retained log can disappear between persistence and preview generation.
    return undefined
  }
}
