/**
 * Runtime proof for exit-code semantics.
 *
 * A command-specific exit rule (grep exit 1 = no matches) is only sound when
 * that command actually produced the final exit status. In
 * `cd /missing && grep x f`, cd fails, grep never runs, and the text alone
 * cannot tell that apart from `true && grep x f` reaching grep. So when the
 * final command has such a rule, a marker is inserted in front of it; the
 * marker writes a per-run token and the live option state to a side file, and
 * the engine trusts the rule only when that file proves the command started.
 *
 * The marker `: "$(...)" "$_"` is one builtin that always exits 0, prints
 * nothing, keeps `$_` (its last argument is the old `$_`), and writes from a
 * subshell so no variable, trap, or option of the user's shell changes. It is
 * inserted only where `$?` is already 0 or is never read, and never when
 * something could observe an extra command (xtrace, verbose, DEBUG traps).
 *
 * Every refusal here means "no attribution": the caller falls back to
 * non-zero-is-error, which can only over-report failure, never hide one.
 */

import { randomBytes } from 'crypto'
import { getParserModule, type TsNode } from './bashParser.js'
import { quote } from './shellQuote.js'

/** What the shell proved about the command whose exit rule would apply. */
export type CommandAttribution = {
  semanticCommand: string
  semanticCommandStarted: boolean
  pipelineHasMultipleCommands: boolean
  pipefailEnabled: boolean
}

export type ExitAttributionPlan = {
  instrumentedCommand: string
  evidenceFilePath: string
  token: string
  semanticCommand: string
  pipelineHasMultipleCommands: boolean
}

type Located = {
  statement: TsNode
  /** The pipeline or command whose status is the statement's status. */
  operand: TsNode
  /** operand is the right side of `&&`, so it may not run at all. */
  followsAnd: boolean
}

type Candidate = { name: string; stages: number }

// Builtins that can change what the shell traces or traps, or run text the
// parser never saw. Their presence anywhere makes the marker's invisibility
// unprovable.
const OPAQUE_BUILTINS = new Set([
  'trap',
  'source',
  '.',
  'eval',
  'exec',
  'emulate',
  'builtin',
  'alias',
  'enable',
])

// Names the marker itself relies on. A user function with one of these names
// would run in place of the marker's builtin.
const MARKER_BUILTINS = new Set([':', 'set', 'command'])

const SAFE_SET_OPTIONS = new Set(['errexit', 'nounset', 'pipefail'])

export function buildExitMarker(evidenceFilePath: string, token: string): string {
  const path = quote([evidenceFilePath])
  return `: "$( { command printf '%s %s\\n' ${token} "$-" >|${path}; set -o >>${path}; } 2>/dev/null )" "$_"`
}

/**
 * Plan the marker for `command`, or null when the final command has no
 * special exit rule or its attribution cannot be proven safely.
 */
export function planExitAttribution(
  command: string,
  semanticCommands: ReadonlySet<string>,
  evidenceFilePath: string,
): ExitAttributionPlan | null {
  const root = parse(command)
  if (!root || !isInstrumentableProgram(root)) return null
  const located = locateFinalOperand(root)
  if (!located) return null
  const candidate = candidateOf(located.operand)
  if (!candidate || !semanticCommands.has(candidate.name)) return null
  // A statement-start marker resets `$?` for the statement's first command.
  if (!located.followsAnd && /\$\{?\?/.test(located.statement.text)) {
    return null
  }

  const token = randomBytes(16).toString('hex')
  const marker = buildExitMarker(evidenceFilePath, token)
  const insertAt = located.followsAnd
    ? located.operand.startIndex
    : located.statement.startIndex
  const insertion = located.followsAnd ? `${marker} && ` : `${marker}; `
  const bytes = Buffer.from(command, 'utf8')
  const instrumentedCommand =
    bytes.subarray(0, insertAt).toString('utf8') +
    insertion +
    bytes.subarray(insertAt).toString('utf8')

  if (!verifyInstrumentation(instrumentedCommand, located, marker)) return null

  return {
    instrumentedCommand,
    evidenceFilePath,
    token,
    semanticCommand: candidate.name,
    pipelineHasMultipleCommands: candidate.stages > 1,
  }
}

/**
 * Turn the side file into an attribution. A missing file means the marker
 * never ran. A wrong token, or xtrace/verbose active when it ran, means the
 * evidence is not trusted at all.
 */
export function readExitEvidence(
  contents: string | undefined,
  plan: Pick<
    ExitAttributionPlan,
    'token' | 'semanticCommand' | 'pipelineHasMultipleCommands'
  >,
): CommandAttribution | null {
  const base = {
    semanticCommand: plan.semanticCommand,
    pipelineHasMultipleCommands: plan.pipelineHasMultipleCommands,
  }
  if (contents === undefined) {
    return { ...base, semanticCommandStarted: false, pipefailEnabled: true }
  }
  const newline = contents.indexOf('\n')
  const header = newline === -1 ? contents : contents.slice(0, newline)
  const [token, flags = ''] = header.split(' ')
  if (token !== plan.token || /[xv]/.test(flags)) return null
  return {
    ...base,
    semanticCommandStarted: true,
    // Unknown counts as enabled: only an explicit `off` line clears it.
    pipefailEnabled: !/^pipefail\s+off\s*$/m.test(contents),
  }
}

/**
 * Shell state that runs before the command and could observe the marker:
 * the snapshot (options, zsh trap functions, aliases) and the session
 * environment script. Bash traps are not captured by the snapshot, so they
 * can only come from the command or the session script, both checked.
 */
export function shellStateAllowsExitMarker(
  snapshotText: string | undefined,
  sessionEnvScript: string | null,
): boolean {
  if (snapshotText === undefined) return false
  if (
    /^setopt\s+(xtrace|verbose)\s*$/m.test(snapshotText) ||
    /^set -o (xtrace|verbose|functrace)\s*$/m.test(snapshotText) ||
    /^\s*trap\b/m.test(snapshotText) ||
    /^(TRAP[A-Z]+|:|set|command) \(\)/m.test(snapshotText) ||
    /^alias -- (:|set|command)=/m.test(snapshotText)
  ) {
    return false
  }
  if (
    sessionEnvScript &&
    /\b(set|setopt|unsetopt|shopt|trap|source|eval|emulate|alias)\b|^\s*\.\s/m.test(
      sessionEnvScript,
    )
  ) {
    return false
  }
  return true
}

function parse(command: string): TsNode | null {
  try {
    return getParserModule()?.parse(command) ?? null
  } catch {
    return null
  }
}

function* walk(node: TsNode): Generator<TsNode> {
  yield node
  for (const child of node.children) yield* walk(child)
}

function isInstrumentableProgram(root: TsNode): boolean {
  if (root.type !== 'program') return false
  for (const node of walk(root)) {
    if (node.type === 'ERROR' || node.type === 'heredoc_redirect') return false
    if (node.type === 'function_definition') {
      const name = node.children.find(c => c.type === 'word')?.text ?? ''
      if (name.startsWith('TRAP') || MARKER_BUILTINS.has(name)) return false
    }
    if (node.type === 'command' && !isSafeCommand(node)) return false
  }
  return true
}

function isSafeCommand(node: TsNode): boolean {
  const nameNode = node.children.find(c => c.type === 'command_name')
  if (!nameNode) return true
  const name = literalWord(nameNode)
  if (name === null) return false
  if (OPAQUE_BUILTINS.has(name)) return false
  const args = node.children.filter(
    c => c !== nameNode && c.type !== 'variable_assignment',
  )
  if (name === 'set') return args.every(isSafeSetArg)
  if (name === 'setopt' || name === 'unsetopt') {
    return args.every(
      a =>
        a.type === 'word' &&
        SAFE_SET_OPTIONS.has(a.text.toLowerCase().replace(/_/g, '')),
    )
  }
  if (name === 'shopt') {
    return args.every(a => a.type === 'word' && a.text !== '-o')
  }
  return true
}

function isSafeSetArg(arg: TsNode): boolean {
  if (arg.type !== 'word') return false
  return /^[-+][eu]*o?$/.test(arg.text) || SAFE_SET_OPTIONS.has(arg.text)
}

function literalWord(nameNode: TsNode): string | null {
  const [only] = nameNode.children
  if (nameNode.children.length !== 1 || only?.type !== 'word') return null
  return only.text
}

function locateFinalOperand(root: TsNode): Located | null {
  const statements = root.children
  let index = statements.length - 1
  while (
    index >= 0 &&
    (statements[index]!.type === 'comment' || statements[index]!.type === ';')
  ) {
    index--
  }
  const statement = statements[index]
  if (!statement) return null

  const body = withoutFileRedirects(statement)
  if (!body) return null
  if (body.type !== 'list') {
    return { statement, operand: body, followsAnd: false }
  }
  const [, operator, right] = body.children
  if (body.children.length !== 3 || !operator || !right) return null
  if (operator.type !== '&&' && operator.type !== '||') return null
  return { statement, operand: right, followsAnd: operator.type === '&&' }
}

/**
 * The parser attaches trailing redirects to the whole list
 * (`a && b 2>/dev/null` parses as redirected_statement(list, redirect)),
 * while the shell applies them to the final command only. Either way the
 * marker goes before the final operand, so file redirects are transparent.
 */
function withoutFileRedirects(node: TsNode): TsNode | null {
  if (node.type !== 'redirected_statement') return node
  const [body, ...redirects] = node.children
  if (!body || !redirects.every(r => r.type === 'file_redirect')) return null
  return body
}

function candidateOf(operand: TsNode): Candidate | null {
  const body = withoutFileRedirects(operand)
  if (!body) return null
  if (body.type === 'pipeline') {
    const stages = body.children.filter(c => c.type !== '|' && c.type !== '|&')
    const last = stages[stages.length - 1]
    const name = last ? simpleCommandName(last) : null
    return name ? { name, stages: stages.length } : null
  }
  const name = simpleCommandName(body)
  return name ? { name, stages: 1 } : null
}

function simpleCommandName(node: TsNode): string | null {
  const body = withoutFileRedirects(node)
  if (!body) return null
  if (body.type === 'test_command') {
    return body.children[0]?.type === '[' ? '[' : null
  }
  if (body.type !== 'command') return null
  const nameNode = body.children.find(c => c.type === 'command_name')
  return nameNode ? literalWord(nameNode) : null
}

/**
 * Re-parse and require the original statement unchanged with the marker
 * exactly where it was meant to go. Guards against any offset the parser got
 * wrong turning the insertion into different shell syntax.
 */
function verifyInstrumentation(
  instrumented: string,
  original: Located,
  marker: string,
): boolean {
  const root = parse(instrumented)
  if (!root || root.type !== 'program') return false
  const located = locateFinalOperand(root)
  if (!located || located.operand.text !== original.operand.text) return false

  if (original.followsAnd) {
    if (!located.followsAnd) return false
    const list = withoutFileRedirects(located.statement)
    const left = list?.children[0]
    const leftRight =
      left?.type === 'list' ? left.children[2] : undefined
    return (
      leftRight?.type === 'command' &&
      leftRight.text === marker &&
      left?.children[1]?.type === '&&'
    )
  }

  if (located.statement.text !== original.statement.text) return false
  const statements = root.children.filter(
    c => c.type !== ';' && c.type !== 'comment',
  )
  const before = statements[statements.indexOf(located.statement) - 1]
  return before?.type === 'command' && before.text === marker
}
