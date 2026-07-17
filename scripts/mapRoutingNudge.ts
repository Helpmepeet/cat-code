#!/usr/bin/env bun
import { createHash } from 'node:crypto'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
} from 'node:fs'
import { dirname, isAbsolute, relative, resolve } from 'node:path'

type HookInput = {
  agent_transcript_path?: string
  session_id?: string
  tool_input?: {
    command?: string
    glob?: string
    path?: string
    pattern?: string
  }
  tool_name?: string
  transcript_path?: string
}

export type SearchClassification = 'broad' | 'external' | 'narrow' | 'not-search'

const GLOB_META = /[*?[\]{}]/
const SEARCH_COMMAND = /(?:^|[|;&\s])(rg|grep)(?=\s|$)/

function isWithinRepo(candidate: string, repoRoot: string): boolean {
  const rel = relative(repoRoot, candidate)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

function classifyPathScope(
  rawPath: string | undefined,
  cwd: string,
  repoRoot = cwd,
): 'directory' | 'external' | 'file' | 'unknown' {
  if (!rawPath) return 'unknown'
  const candidate = resolveShellPath(rawPath, cwd)
  if (!isWithinRepo(candidate, repoRoot)) return 'external'
  if (!existsSync(candidate)) return 'unknown'
  const stat = statSync(candidate)
  if (stat.isFile()) return 'file'
  if (stat.isDirectory()) return 'directory'
  return 'unknown'
}

function classifyGrep(input: HookInput, repoRoot: string): SearchClassification {
  const scope = classifyPathScope(input.tool_input?.path, repoRoot)
  if (scope === 'external') return 'external'
  if (scope === 'file') return 'narrow'

  const glob = input.tool_input?.glob
  if (glob && !GLOB_META.test(glob)) {
    const base = input.tool_input?.path
      ? resolve(repoRoot, input.tool_input.path)
      : repoRoot
    if (classifyPathScope(resolve(base, glob), repoRoot) === 'file') return 'narrow'
  }
  return 'broad'
}

function classifyGlob(input: HookInput, repoRoot: string): SearchClassification {
  const scope = classifyPathScope(input.tool_input?.path, repoRoot)
  if (scope === 'external') return 'external'

  const pattern = input.tool_input?.pattern ?? ''
  if (isAbsolute(pattern) && !isWithinRepo(resolve(pattern), repoRoot)) {
    return 'external'
  }
  if (!GLOB_META.test(pattern)) {
    const base = input.tool_input?.path
      ? resolve(repoRoot, input.tool_input.path)
      : repoRoot
    if (classifyPathScope(resolve(base, pattern), repoRoot) === 'file') {
      return 'narrow'
    }
  }
  return 'broad'
}

function shellTokens(command: string): string[] {
  return command
    .split(/\s+/)
    .map(token => token.replace(/^["']|["',;|]+$/g, ''))
    .filter(Boolean)
}

function splitPipeline(command: string): string[] {
  const segments: string[] = []
  let current = ''
  let quote: "'" | '"' | null = null
  let escaped = false

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]!
    if (escaped) {
      current += char
      escaped = false
      continue
    }
    if (char === '\\' && quote !== "'") {
      current += char
      escaped = true
      continue
    }
    if (char === "'" || char === '"') {
      quote = quote === char ? null : quote ?? char
      current += char
      continue
    }
    if (char === '|' && quote === null) {
      if (command[index + 1] === '|') {
        current += '||'
        index += 1
      } else {
        segments.push(current)
        current = ''
      }
      continue
    }
    current += char
  }
  segments.push(current)
  return segments
}

function resolveShellPath(rawPath: string, repoRoot: string): string {
  const home = process.env.HOME
  if (home && (rawPath === '~' || rawPath.startsWith('~/'))) {
    return resolve(home, rawPath.slice(2))
  }
  if (home && (rawPath === '$HOME' || rawPath.startsWith('$HOME/'))) {
    return resolve(home, rawPath.slice(6))
  }
  return resolve(repoRoot, rawPath)
}

function searchPathOperands(searchSegment: string): string[] {
  const tokens = shellTokens(searchSegment)
  const commandIndex = tokens.findIndex(token => /(?:^|\/)(?:rg|grep)$/.test(token))
  if (commandIndex < 0) return []

  const optionsWithValues = new Set([
    '-e',
    '-g',
    '-t',
    '--exclude',
    '--glob',
    '--iglob',
    '--include',
    '--regexp',
    '--type',
  ])
  const patternOptions = new Set(['-e', '--regexp'])
  const operands: string[] = []
  let patternConsumed = false
  let optionTerminated = false

  for (let index = commandIndex + 1; index < tokens.length; index += 1) {
    const token = tokens[index]!
    if (!optionTerminated && token === '--') {
      optionTerminated = true
      continue
    }
    if (!optionTerminated && token.startsWith('-')) {
      const option = token.split('=', 1)[0]!
      if (patternOptions.has(option)) patternConsumed = true
      if (optionsWithValues.has(option) && !token.includes('=')) index += 1
      continue
    }
    if (!patternConsumed) {
      patternConsumed = true
      continue
    }
    operands.push(token)
  }
  return operands
}

function classifyBash(input: HookInput, repoRoot: string): SearchClassification {
  const command = input.tool_input?.command ?? ''
  if (!SEARCH_COMMAND.test(command)) return 'not-search'

  const pipeline = splitPipeline(command)
  const searchSegmentIndex = pipeline.findIndex(segment => SEARCH_COMMAND.test(segment))
  if (searchSegmentIndex > 0) return 'not-search'
  const searchSegment = pipeline[searchSegmentIndex] ?? command

  const cdMatch = command.match(/(?:^|[;&|]\s*)cd\s+(["']?)([^"';&|\s]+)\1/)
  const commandRoot = cdMatch
    ? resolveShellPath(cdMatch[2]!, repoRoot)
    : repoRoot
  if (!isWithinRepo(commandRoot, repoRoot) && !command.includes(repoRoot)) {
    return 'external'
  }

  if (/\brg\s+[^;&|]*--files\b|\bgrep\s+[^;&|]*--recursive\b|\bgrep\s+[^;&|]*-r\b/.test(searchSegment)) {
    return 'broad'
  }

  const operands = searchPathOperands(searchSegment)
  const globOperands = operands.filter(token => GLOB_META.test(token))
  const repoGlob = globOperands.some(token => {
    const metaIndex = token.search(GLOB_META)
    const anchor = metaIndex > 0 ? token.slice(0, metaIndex) : '.'
    return isWithinRepo(resolveShellPath(anchor, commandRoot), repoRoot)
  })
  if (repoGlob) return 'broad'

  const exactOperands = operands.filter(token => !GLOB_META.test(token))
  const scopes = exactOperands
    .map(token => classifyPathScope(token, commandRoot, repoRoot))
    .filter(scope => scope !== 'unknown')

  const repoScopes = scopes.filter(scope => scope !== 'external')
  if (repoScopes.includes('directory')) return 'broad'
  if (repoScopes.includes('file')) return 'narrow'
  if (globOperands.length > 0) return 'external'
  if (scopes.length > 0 && repoScopes.length === 0) return 'external'
  return 'broad'
}

export function classifySearch(
  input: HookInput,
  repoRoot: string,
): SearchClassification {
  switch (input.tool_name) {
    case 'Grep':
      return classifyGrep(input, repoRoot)
    case 'Glob':
      return classifyGlob(input, repoRoot)
    case 'Bash':
      return classifyBash(input, repoRoot)
    default:
      return 'not-search'
  }
}

function transcriptConsultedMap(transcriptPath: string): boolean {
  const transcript = readFileSync(transcriptPath, 'utf8')
  return transcript.split('\n').some(line => {
    if (!/"type"\s*:\s*"tool_use"/.test(line) || !line.includes('docs/maps/')) {
      return false
    }
    if (/"name"\s*:\s*"Read"/.test(line)) return true
    return (
      /"name"\s*:\s*"Bash"/.test(line) &&
      /\b(?:cat|head|less|sed|tail)\b[^\n]*docs\/maps\//.test(line)
    )
  })
}

function claimOnce(statePath: string): boolean {
  try {
    mkdirSync(statePath)
    return true
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'EEXIST') return false
    throw error
  }
}

export function runMapRoutingNudge(
  input: HookInput,
  options: {
    logFile?: string | false
    repoRoot: string
    stateRoot: string
  },
): string | null {
  const classification = classifySearch(input, options.repoRoot)
  if (classification !== 'broad') return null

  const transcriptPath = input.agent_transcript_path ?? input.transcript_path
  if (!transcriptPath || !existsSync(transcriptPath)) return null

  const sessionKey = createHash('sha256')
    .update(input.session_id ?? 'unknown')
    .digest('hex')
    .slice(0, 16)
  const statePath = resolve(options.stateRoot, `map-nudge-${sessionKey}`)
  if (existsSync(statePath)) return null

  if (transcriptConsultedMap(transcriptPath)) {
    claimOnce(statePath)
    return null
  }
  if (!claimOnce(statePath)) return null

  if (options.logFile) {
    mkdirSync(dirname(options.logFile), { recursive: true })
    const kind = input.agent_transcript_path ? 'subagent' : 'main'
    appendFileSync(
      options.logFile,
      `${new Date().toISOString()} sid=${sessionKey} kind=${kind} tool=${input.tool_name} reason=first-broad-search\n`,
    )
  }

  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      additionalContext:
        'Routing nudge (fires once per session): this appears to be broad repository navigation and no docs/maps route has been consulted. If ownership is not already established, read docs/maps/WORKSPACE_MAP.md now, choose the relevant focused map, then continue into source. If an exact owner file or focused map was already supplied, proceed.',
    },
    suppressOutput: true,
  })
}

if (import.meta.main) {
  try {
    const input = JSON.parse(readFileSync(0, 'utf8')) as HookInput
    const repoRoot = resolve(process.env.CLAUDE_PROJECT_DIR ?? process.cwd())
    const stateRoot = resolve(process.env.TMPDIR ?? '/tmp')
    const logFile = process.env.HOME
      ? resolve(process.env.HOME, '.cache', 'map-nudge.log')
      : false
    const output = runMapRoutingNudge(input, { logFile, repoRoot, stateRoot })
    if (output) process.stdout.write(`${output}\n`)
  } catch {
    // Hooks must never block or break the tool call they observe.
  }
}
