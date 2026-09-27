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
 * subshell so no variable, trap, or option of the user's shell changes. It
 * sits directly in front of the final command, or after the `&&` that guards
 * it, so nothing can run between the marker and that command. It is still one
 * more command, so it is skipped where the command reads status the marker
 * would reset (`$?`, `PIPESTATUS`) or where something could observe it
 * (xtrace, verbose, DEBUG traps).
 *
 * Proving the command started is not enough if the name runs user code: a
 * `diff` function returning 1 is not diff reporting differences. Any command
 * name the user's shell defines as a function or alias (other than a wrapper
 * provably running the same program) disables the marker, which also keeps
 * user code from running unseen before it.
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

/** What the snapshot lets the marker rely on; null means never instrument. */
export type ExitMarkerShellState = {
  /**
   * Names that run user-defined code: snapshot functions and aliases, minus
   * aliases to the same command with literal arguments and functions whose
   * whole body is `command <same name> <literal args> "$@"`.
   */
  userDefinedCommands: ReadonlySet<string>
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
  /**
   * direct: operand is the whole statement. and/or: operand is the right side
   * of `&&`/`||`, so the left side runs first and may never reach it.
   */
  relation: 'direct' | 'and' | 'or'
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
  shellState: ExitMarkerShellState,
): ExitAttributionPlan | null {
  const root = parse(command)
  if (!root || !isInstrumentableProgram(root, semanticCommands, shellState)) {
    return null
  }
  const located = locateFinalOperand(root)
  if (!located) return null
  const candidate = candidateOf(located.operand)
  if (
    !candidate ||
    !semanticCommands.has(candidate.name) ||
    shellState.userDefinedCommands.has(candidate.name)
  ) {
    return null
  }
  // Only `&&` and a direct statement leave nothing between the marker and the
  // command. After `||` the left side runs after the marker and can end the
  // shell (`exit 1 || grep x f`), so evidence would claim a start that never
  // happened.
  if (located.relation === 'or') return null
  if (readsStatusTheMarkerResets(located)) return null

  const token = randomBytes(16).toString('hex')
  const marker = buildExitMarker(evidenceFilePath, token)
  const followsAnd = located.relation === 'and'
  const insertAt = followsAnd
    ? located.operand.startIndex
    : located.statement.startIndex
  const insertion = followsAnd ? `${marker} && ` : `${marker}; `
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
 * The snapshot runs before every command. Null when it could observe the
 * marker (tracing on, DEBUG/ZERR trap functions, a marker builtin redefined);
 * otherwise the names it gives user-defined meaning. Bash traps are not
 * captured by the snapshot, so they can only come from the command or the
 * session script, both checked separately.
 */
export function analyzeSnapshotForExitMarker(
  snapshotText: string | undefined,
): ExitMarkerShellState | null {
  if (snapshotText === undefined) return null
  if (
    /^setopt\s+(xtrace|verbose)\s*$/m.test(snapshotText) ||
    /^set -o (xtrace|verbose|functrace)\s*$/m.test(snapshotText) ||
    /^\s*trap\b/m.test(snapshotText)
  ) {
    return null
  }
  const functions = snapshotFunctions(snapshotText)
  const aliases = snapshotAliases(snapshotText)
  const names = [...functions.keys(), ...aliases.keys()]
  if (names.some(n => n.startsWith('TRAP') || MARKER_BUILTINS.has(n))) {
    return null
  }
  const userDefinedCommands = new Set<string>()
  for (const [name, definition] of functions) {
    if (!isTransparentFunction(name, definition)) userDefinedCommands.add(name)
  }
  for (const [name, value] of aliases) {
    if (!isTransparentAlias(name, value)) userDefinedCommands.add(name)
  }
  return { userDefinedCommands }
}

/**
 * The session environment script is sourced before every command too, and it
 * is not in the snapshot, so any option change, trap, alias, or function
 * definition in it is unaccounted for.
 */
export function sessionEnvAllowsExitMarker(sessionEnvScript: string | null): boolean {
  return !(
    sessionEnvScript &&
    /\b(set|setopt|unsetopt|shopt|trap|source|eval|emulate|alias|function)\b|^\s*\.\s|\(\s*\)\s*\{/m.test(
      sessionEnvScript,
    )
  )
}

/**
 * The marker is a completed command, so reading `$?` (or zsh `$status`) right
 * after it sees 0, and `PIPESTATUS`/`pipestatus` describe the marker instead
 * of the user's previous pipeline. After `&&` the previous command already
 * succeeded, so `$?` is 0 either way; the pipeline arrays still differ.
 */
function readsStatusTheMarkerResets(located: Located): boolean {
  const text =
    located.relation === 'and' ? located.operand.text : located.statement.text
  if (/\b(PIPESTATUS|pipestatus)\b/.test(text)) return true
  return (
    located.relation === 'direct' && /\$\{?(\?|status\b)/.test(text)
  )
}

/**
 * Function name → definition text. zsh snapshots hold `typeset -f` output
 * (`name () {` ... `}` at column 0); bash snapshots hold one base64-encoded
 * `declare -f` definition per eval line. The generator's own rg/find/grep
 * shims are written as indented `function name {` text, so they never match:
 * they dispatch to the embedded tool with the same exit codes.
 */
function snapshotFunctions(snapshotText: string): Map<string, string> {
  const functions = new Map<string, string>()
  const collect = (text: string) => {
    for (const match of text.matchAll(/^(\S+) \(\) ?\n?\{[\s\S]*?^\}$/gm)) {
      functions.set(unquoteName(match[1]!), match[0])
    }
  }
  collect(snapshotText)
  for (const match of snapshotText.matchAll(
    /^eval "\$\(echo '([A-Za-z0-9+/=\s]+)' \| base64 -d\)"/gm,
  )) {
    collect(Buffer.from(match[1]!.replace(/\s/g, ''), 'base64').toString('utf8'))
  }
  return functions
}

/** Alias name → expansion, from the snapshot's `alias -- name=value` lines. */
function snapshotAliases(snapshotText: string): Map<string, string> {
  const aliases = new Map<string, string>()
  for (const match of snapshotText.matchAll(/^alias -- ([^=\s]+)=(.*)$/gm)) {
    const raw = match[2]!
    const value =
      raw.length >= 2 && raw.startsWith("'") && raw.endsWith("'")
        ? raw.slice(1, -1).replace(/'\\''/g, "'")
        : raw
    aliases.set(unquoteName(match[1]!), value)
  }
  return aliases
}

/** zsh prints names with special characters quoted: `'[' () {`, `'['=false`. */
function unquoteName(name: string): string {
  return name.length >= 2 && name.startsWith("'") && name.endsWith("'")
    ? name.slice(1, -1).replace(/'\\''/g, "'")
    : name
}

// Argument shapes with no expansion or substitution: the word the shell runs
// is the word written.
const LITERAL_ARG_TYPES = new Set([
  'word',
  'concatenation',
  'raw_string',
  'string',
  'string_content',
  '"',
])

function isLiteralArg(node: TsNode): boolean {
  for (const inner of walk(node)) {
    if (!LITERAL_ARG_TYPES.has(inner.type)) return false
  }
  return true
}

/** `alias grep='grep --color=auto'`: the same program with literal flags. */
function isTransparentAlias(name: string, value: string): boolean {
  const root = parse(value)
  const [only] = root?.children ?? []
  if (root?.children.length !== 1 || only?.type !== 'command') return false
  const [nameNode, ...args] = only.children
  return (
    nameNode?.type === 'command_name' &&
    literalWord(nameNode) === name &&
    args.every(isLiteralArg)
  )
}

/** `diff () { command diff --color "$@" }`: the real program, same args. */
function isTransparentFunction(name: string, definition: string): boolean {
  const root = parse(definition)
  const fn = root?.children.length === 1 ? root.children[0] : undefined
  if (fn?.type !== 'function_definition') return false
  const body = fn.children.find(c => c.type === 'compound_statement')
  const inner = body?.children.filter(c => c.type !== '{' && c.type !== '}')
  const call = inner?.length === 1 ? inner[0] : undefined
  if (call?.type !== 'command') return false
  const [nameNode, target, ...rest] = call.children
  const forwarded = rest[rest.length - 1]
  return (
    nameNode?.type === 'command_name' &&
    literalWord(nameNode) === 'command' &&
    target?.type === 'word' &&
    target.text === name &&
    forwarded?.text === '"$@"' &&
    rest.slice(0, -1).every(isLiteralArg)
  )
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

function isInstrumentableProgram(
  root: TsNode,
  semanticCommands: ReadonlySet<string>,
  shellState: ExitMarkerShellState,
): boolean {
  if (root.type !== 'program') return false
  for (const node of walk(root)) {
    if (node.type === 'ERROR' || node.type === 'heredoc_redirect') return false
    if (node.type === 'function_definition') {
      const name = node.children.find(c => c.type === 'word')?.text ?? ''
      if (
        name.startsWith('TRAP') ||
        MARKER_BUILTINS.has(name) ||
        semanticCommands.has(name)
      ) {
        return false
      }
    }
    if (node.type === 'command' && !isSafeCommand(node, shellState)) {
      return false
    }
    // `[ ... ]` parses as test_command, not command, but runs whatever the
    // shell defines as `[`.
    if (
      node.type === 'test_command' &&
      node.children[0]?.type === '[' &&
      shellState.userDefinedCommands.has('[')
    ) {
      return false
    }
  }
  return true
}

function isSafeCommand(node: TsNode, shellState: ExitMarkerShellState): boolean {
  const nameNode = node.children.find(c => c.type === 'command_name')
  if (!nameNode) return true
  const name = literalWord(nameNode)
  if (name === null) return false
  if (OPAQUE_BUILTINS.has(name)) return false
  if (shellState.userDefinedCommands.has(name)) return false
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
    return { statement, operand: body, relation: 'direct' }
  }
  const [, operator, right] = body.children
  if (body.children.length !== 3 || !operator || !right) return null
  if (operator.type === '&&') return { statement, operand: right, relation: 'and' }
  if (operator.type === '||') return { statement, operand: right, relation: 'or' }
  return null
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

  if (original.relation === 'and') {
    if (located.relation !== 'and') return false
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
