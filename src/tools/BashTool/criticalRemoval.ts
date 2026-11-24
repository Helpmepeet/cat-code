import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, isAbsolute, resolve } from 'node:path'
import { splitCommandWithOperators } from '../../utils/bash/commands.js'
import { getParserModule, type TsNode } from '../../utils/bash/bashParser.js'
import { tryParseShellCommand } from '../../utils/bash/shellQuote.js'
import { isCriticalRemovalPath } from '../../utils/permissions/pathValidation.js'
import { stripWrappersFromArgv } from './pathValidation.js'

type Inspection = { kind: 'removal'; command: 'rm' | 'rmdir'; path: string } | { kind: 'limit' }
type Directories = readonly string[]
type DirectoryFlow = { success: Directories; failure: Directories }

const unchanged = (directories: Directories): DirectoryFlow => ({ success: directories, failure: directories })
const merge = (left: Directories, right: Directories): Directories =>
  left === right ? left : [...new Set([...left, ...right])]
const MAX_DIRECTORY_CANDIDATES = 64
const MAX_SHELL_DEPTH = 16
const shells = new Set(['bash', 'dash', 'ksh', 'sh', 'zsh'])
const redirects = new Set(['>', '>>', '<', '>&', '<&', '<<<'])
const directoryScopes = new Set(['subshell', 'command_substitution', 'process_substitution', 'function_definition'])

function resolveOperand(operand: string, cwd: string, home: string): string | undefined {
  if (operand === '~' || operand.startsWith('~/')) operand = home + operand.slice(1)
  if (operand === '~+' || operand.startsWith('~+/')) operand = cwd + operand.slice(2)
  if (operand.startsWith('~') || /[$`{}?\[]/u.test(operand)) return undefined
  if (/^[A-Za-z]:[/\\]/u.test(operand)) return operand
  return resolve(cwd, operand)
}

function shellPayload(args: string[]): string | undefined {
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!
    if (arg === '--' || !arg.startsWith('-')) break
    if (/^-[A-Za-z]*c[A-Za-z]*$/u.test(arg)) return args[index + 1]
    if (arg === '-o' || arg === '-O') index++
  }
}

function commandArguments(text: string, home: string): string[] {
  const parsed = tryParseShellCommand(text, name => name === 'HOME' ? home : '$' + name)
  if (!parsed.success) return []
  const args: string[] = []
  let skipOperand = false
  for (const token of parsed.tokens) {
    if (typeof token === 'string' || ('op' in token && token.op === 'glob')) {
      if (!skipOperand) args.push(typeof token === 'string' ? token : token.pattern)
      skipOperand = false
    } else if ('op' in token && redirects.has(token.op)) {
      skipOperand = true
    } else {
      break
    }
  }
  return args
}

export function findCriticalRemoval(
  source: string,
  cwd: string,
  ast: TsNode | null,
): Inspection | undefined {
  let refusal: Inspection | undefined

  function command(text: string, directories: Directories, home: string, depth: number): DirectoryFlow {
    if (directories.length > MAX_DIRECTORY_CANDIDATES) {
      refusal = { kind: 'limit' }
      return unchanged(directories)
    }
    let args = commandArguments(text, home)
    const assignments = args.findIndex(arg => !/^[A-Za-z_]\w*=/u.test(arg))
    if (assignments < 0) return unchanged(directories)
    const childHome = args.slice(0, assignments).findLast(arg => arg.startsWith('HOME='))?.slice(5) ?? home
    args = stripWrappersFromArgv(args.slice(assignments))
    if (args[0] === 'command' || args[0] === 'exec') args = args.slice(args[1] === '--' ? 2 : 1)
    if (args[0] === 'sudo') args = args.slice(1).filter(arg => !['-n', '--'].includes(arg))
    const executable = basename(args.shift() ?? '')
    if (executable === 'cd') {
      const target = args.find(arg => arg !== '--' && arg !== '-P' && arg !== '-L') ?? home
      return {
        success: [...new Set(directories.flatMap(dir => {
          const path = resolveOperand(target, dir, home)
          if (!path) return [dir]
          try { return [path, realpathSync(path)] } catch { return [path] }
        }))],
        failure: directories,
      }
    }
    if (executable === 'rm' || executable === 'rmdir') {
      let options = true
      for (const operand of args) {
        if (options && operand === '--') { options = false; continue }
        if (!operand || options && operand.startsWith('-')) continue
        for (const dir of directories) {
          const path = resolveOperand(operand, dir, home)
          if (path && isCriticalRemovalPath(path)) {
            refusal = { kind: 'removal', command: executable, path }
            return unchanged(directories)
          }
        }
      }
    }
    const payload = shells.has(executable) ? shellPayload(args) : undefined
    if (payload) {
      if (depth === MAX_SHELL_DEPTH) refusal = { kind: 'limit' }
      else scan(payload, null, directories, childHome, depth + 1)
    }
    return unchanged(directories)
  }

  function tree(node: TsNode, directories: Directories, home: string, depth: number): DirectoryFlow {
    if (refusal) return unchanged(directories)
    const [left, operator, right] = node.children
    if (node.type === 'list' && left && right && (operator?.type === '&&' || operator?.type === '||')) {
      const first = tree(left, directories, home, depth)
      const and = operator.type === '&&'
      const second = tree(right, and ? first.success : first.failure, home, depth)
      return and ? { success: second.success, failure: merge(first.failure, second.failure) }
        : { success: merge(first.success, second.success), failure: second.failure }
    }
    // The parser groups words after a redirect into the redirect node.
    // Check that statement's argv together and visit its substitutions.
    const redirectedCommand = node.type === 'redirected_statement' && left?.type === 'command'
    let flow = unchanged(directories)
    for (const [index, child] of node.children.entries()) {
      if (refusal) break
      const bases = node.type === 'pipeline' ? directories : merge(flow.success, flow.failure)
      if (index === 0 && redirectedCommand) {
        for (const word of child.children) tree(word, bases, home, depth)
      } else if (child.children.length) {
        const next = tree(child, bases, home, depth)
        if (node.children[index + 1]?.type !== '&') flow = next
      }
    }
    if (node.type === 'command' || redirectedCommand) return command(node.text, directories, home, depth)
    if (node.type === 'pipeline' || directoryScopes.has(node.type)) return unchanged(directories)
    return flow
  }

  function scan(text: string, root: TsNode | null, directories: Directories, home: string, depth: number): void {
    // The regular Bash permission parser can be disabled or run in shadow.
    // Critical-removal checks need the same tree on the desktop and CLI.
    root ??= getParserModule()?.parse(text) ?? null
    if (root) { tree(root, directories, home, depth); return }
    const parts = splitCommandWithOperators(text)
    if (parts.length === 1) { command(text, directories, home, depth); return }
    let bases = directories
    const scopes: Directories[] = []
    for (const [index, part] of parts.entries()) {
      if (refusal) return
      if (part === '(') scopes.push(bases)
      else if (part === ')') bases = scopes.pop() ?? bases
      else {
        if (['&&', '||', '|', '|&', '&', ';'].includes(part)) continue
        const next = command(part, bases, home, depth)
        const operator = parts[index + 1]
        if (operator === '&&') bases = next.success
        else if (operator === '||') bases = next.failure
        else if (operator !== '|' && operator !== '|&' && operator !== '&') bases = merge(next.success, next.failure)
      }
    }
  }

  scan(source, ast, [cwd], homedir(), 0)
  return refusal
}
