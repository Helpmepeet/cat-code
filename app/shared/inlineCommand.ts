import { unified } from 'unified'
import remarkParse from 'remark-parse'
import type { Nodes } from 'mdast'
import { parse, postprocess, preprocess } from 'micromark'

export type InlineCommandSource = {
  engineSessionId: string
  messageUuid: string
  contentBlockIndex: number
  fenceOrdinal: number
}
export type InlineCommandRun = {
  runId: string
  source: InlineCommandSource
  command: string
  cwd: string
  status: 'running' | 'success' | 'failed' | 'stopped' | 'interrupted'
  output: string
  outputTail?: string
  omittedBytes?: number
  totalLines?: number
  fullOutputPath?: string
  startedAt?: number
  durationMs?: number
  exitCode: number | null
  error?: string
}
export type InlineCommandRequest = {
  requestId: string
  source: InlineCommandSource
  status: 'accepted' | 'running' | 'completed' | 'rejected'
  runId?: string
  error?: string
}
export type InlineCommandFence = {
  ordinal: number
  command: string
  language: string
  startOffset: number
  endOffset: number
}
const parser = unified().use(remarkParse)
const languages = new Set(['bash', 'sh', 'shell', 'zsh'])

/** Parse actual Markdown blocks, not delimiter-looking lines inside other blocks. */
export function extractInlineCommandFences(text: string): InlineCommandFence[] {
  const fences: InlineCommandFence[] = []
  const completed = new Set<number>()
  let active: { start: number; delimiters: number } | undefined
  // The tokenizer distinguishes a real closing fence from indented code that
  // merely ends in delimiter-looking text, including nested container prefixes.
  for (const [event, token] of postprocess(parse().document().write(preprocess()(text, undefined, true)))) {
    if (event === 'enter' && token.type === 'codeFenced') active = { start: token.start.offset, delimiters: 0 }
    if (event === 'enter' && token.type === 'codeFencedFence' && active) active.delimiters++
    if (event === 'exit' && token.type === 'codeFenced' && active) {
      if (active.delimiters === 2) completed.add(active.start)
      active = undefined
    }
  }
  let ordinal = 0
  const visit = (node: Nodes): void => {
    if (node.type === 'code') {
      const code = node
      const start = code.position?.start.offset
      const end = code.position?.end.offset
      if (start === undefined || end === undefined) return
      const raw = text.slice(start, end)
      const opening = /^(`{3,}|~{3,})([^\r\n]*)/.exec(raw)
      if (!opening) return // Indented code does not consume a fence ordinal.
      const current = ordinal++
      const language = code.lang?.toLowerCase() ?? ''
      if (completed.has(start) && languages.has(language) && code.value.trim()) {
        fences.push({ ordinal: current, command: code.value, language, startOffset: start, endOffset: end })
      }
    }
    if ('children' in node && Array.isArray(node.children)) {
      for (const child of node.children) visit(child)
    }
  }
  visit(parser.parse(text))
  return fences
}

const prefix = '<cat-code-inline-command-result>\n'
const suffix = '\n</cat-code-inline-command-result>'
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const closed = (value: Record<string, unknown>, keys: string[]) => Object.keys(value).every(key => keys.includes(key))
const nonempty = (value: unknown): value is string => typeof value === 'string' && value.length > 0
const identifier = (value: unknown): value is string => nonempty(value) && value.length <= 128
const index = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 100_000
const count = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0

export function parseInlineCommandResult(text: string): InlineCommandRun | null {
  if (!text.startsWith(prefix) || !text.endsWith(suffix) || text.length > 262_144) return null
  try {
    const run: unknown = JSON.parse(text.slice(prefix.length, -suffix.length))
    if (!record(run) || !closed(run, ['runId', 'source', 'command', 'cwd', 'status', 'output', 'outputTail', 'omittedBytes', 'totalLines', 'fullOutputPath', 'startedAt', 'durationMs', 'exitCode', 'error'])) return null
    const source = run.source
    if (!record(source) || !closed(source, ['engineSessionId', 'messageUuid', 'contentBlockIndex', 'fenceOrdinal']) ||
      !identifier(source.engineSessionId) || !identifier(source.messageUuid) || !index(source.contentBlockIndex) || !index(source.fenceOrdinal)) return null
    if (!identifier(run.runId) || !nonempty(run.command) || !nonempty(run.cwd) || typeof run.output !== 'string' ||
      typeof run.status !== 'string' || !['success', 'failed', 'stopped', 'interrupted'].includes(run.status) ||
      !(run.exitCode === null || (typeof run.exitCode === 'number' && Number.isSafeInteger(run.exitCode))) ||
      !(run.error === undefined || typeof run.error === 'string') ||
      !(run.outputTail === undefined || (typeof run.outputTail === 'string' && run.outputTail.length <= 24_000)) ||
      !(run.fullOutputPath === undefined || (nonempty(run.fullOutputPath) && run.fullOutputPath.length <= 8192)) ||
      !['omittedBytes', 'totalLines', 'startedAt', 'durationMs'].every(key => run[key] === undefined || count(run[key]))) return null
    return run as InlineCommandRun
  } catch { return null }
}

export function encodeInlineCommandResult(run: InlineCommandRun): string {
  const text = prefix + JSON.stringify(run) + suffix
  if (!parseInlineCommandResult(text)) throw new Error('Invalid inline command result')
  return text
}

export function inlineCommandSourceKey(source: InlineCommandSource): string {
  return JSON.stringify([source.engineSessionId, source.messageUuid, source.contentBlockIndex, source.fenceOrdinal])
}

/** A deliberately narrow UI hint, not shell parsing or an execution policy. */
export function isInteractiveShellCommand(command: string): boolean {
  if (/\$\(|`/.test(command)) return false
  const words: string[] = []
  let word = ''
  let started = false
  let quote = ''
  let escaped = false
  for (const character of command.trim()) {
    if (escaped) {
      word += character
      escaped = false
      continue
    }
    if (character === '\\' && quote !== "'") {
      escaped = true
      started = true
    } else if (quote) {
      if (character === quote) quote = ''
      else word += character
    } else if (character === "'" || character === '"') {
      quote = character
      started = true
    } else if (/[|;&<>()\r\n#]/.test(character)) {
      return false
    } else if (/\s/.test(character)) {
      if (started) words.push(word)
      word = ''
      started = false
    } else {
      word += character
      started = true
    }
  }
  if (quote || escaped) return false
  if (started) words.push(word)
  const [program, ...args] = words
  if (program === 'top') return !args.some(arg => /^-l(?:\d+)?$/.test(arg))
  if (program === 'tail') {
    const end = args.indexOf('--')
    return (end < 0 ? args : args.slice(0, end)).some(arg => /^-[^-]*[fF]/.test(arg))
  }
  return program !== undefined && ['htop', 'btop', 'vim', 'vi', 'nvim', 'nano', 'emacs', 'less', 'more', 'man', 'watch'].includes(program)
}
