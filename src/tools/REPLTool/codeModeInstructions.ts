import { basename, resolve } from 'node:path'
import { stat } from 'node:fs/promises'
import { parse } from 'shell-quote'
import type { ToolUseContext } from '../../Tool.js'
import type { Message } from '../../types/message.js'
import { getNestedMemoryAttachmentsForFile, createAttachmentMessage } from '../../utils/attachments.js'
import { getCwd } from '../../utils/cwd.js'
import { expandPath } from '../../utils/path.js'
import { getPreparedFileMutation, getPreparedFileMutationSet, getPreparedFileRead } from '../../utils/fileAuthorization.js'
import { splitCommand_DEPRECATED } from '../../utils/bash/commands.js'
import { extractHeredocs } from '../../utils/bash/heredoc.js'
import { getParserModule, type TsNode } from '../../utils/bash/bashParser.js'
import { isNormalizedCdCommand } from '../BashTool/bashPermissions.js'
import { getPatchMutationPaths } from '../FilePatchTool/parser.js'
import { RuntimeRequestError } from './runtime/protocol.js'

function addTarget(paths: Set<string>, path: string): void {
  if (!paths.has(path) && paths.size >= 64) throw new RuntimeRequestError('Too many filesystem targets for one instruction preflight. Split the operation into smaller calls.')
  paths.add(path)
}

// A standalone cat can copy its literal stdin to a static file. Keep that
// redirection and following commands visible along with ambiguous heredocs.
function withoutLiteralStdin(command: string): string {
  const { heredocs } = extractHeredocs(command)
  if (heredocs.size !== 1) return command
  const doc = heredocs.values().next().value!
  const before = command.slice(0, doc.operatorStartIndex).replace(/^[ \t\n]*/, '')
  const after = command.slice(doc.operatorEndIndex, doc.contentStartIndex)
  const header = `${before} ${after}`
  if (!/^cat(?:[ \t]*>>?[ \t]*(?:[A-Za-z0-9_./-]+|'[^'\r\n]+'|"[^"\\$`!\r\n]+"))?[ \t]*$/.test(header)) return command
  const operator = command.slice(doc.operatorStartIndex, doc.operatorEndIndex)
  const quoted = /^<<-?[ \t]*(['"])[A-Za-z_]\w*\1$/.test(operator)
  const plain = /^<<-?[ \t]*[A-Za-z_]\w*$/.test(operator)
  if (!quoted && (!plain || /[$`\\]/.test(command.slice(doc.contentStartIndex, doc.contentEndIndex)))) return command
  const rest = command.slice(doc.contentEndIndex)
  if (rest && !rest.startsWith('\n')) return command
  return rest ? `${header};${rest}` : header
}

function literalShellPaths(command: string, base: string, paths: Set<string>, depth = 0, checkDirectoryChanges = true): void {
  if (depth > 3) throw new RuntimeRequestError('Shell nesting exceeds the instruction preflight limit. Use simpler commands or explicit file tools.')
  const legacyCommand = withoutLiteralStdin(command)
  const root = getParserModule()?.parse(command)
  if (!root) throw new RuntimeRequestError('Shell instruction preflight could not parse this command. Split the command or use explicit file tools.')
  if (checkDirectoryChanges) {
    const commands = splitCommand_DEPRECATED(legacyCommand)
    const newlineCommands = legacyCommand.includes('\n') ? outerShellCommands(root) : []
    if ((commands.length > 1 && commands.some(isNormalizedCdCommand)) ||
        (newlineCommands.length > 1 && newlineCommands.some(part => splitCommand_DEPRECATED(part).some(isNormalizedCdCommand)))) {
      const leadingCd = depth === 0 ? /^[ \t]*cd[ \t]+(\/[A-Za-z0-9_./-]+|'[^'\r\n]+')[ \t]*&&/.exec(command)?.[1] : undefined
      const literalTarget = leadingCd?.startsWith("'") ? leadingCd.slice(1, -1) : leadingCd
      // This is a retry hint only. A shell alias or function can change what cd does.
      if (literalTarget === base && !commands.slice(1).some(isNormalizedCdCommand) &&
          !newlineCommands.slice(1).some(part => splitCommand_DEPRECATED(part).some(isNormalizedCdCommand))) {
        throw new RuntimeRequestError('Script Bash cannot preflight a compound command with a leading cd to the current directory. Remove the leading cd and retry the remaining command.')
      }
      throw new RuntimeRequestError('Script Bash cannot preflight paths after a compound directory change. Use explicit file paths or run the directory change separately.')
    }
  }
  const { commands, literalStdin, backtickBodies } = parsedShellPaths(root)
  const legacyInput = legacyCommand === command && literalStdin.length
    ? replaceLiteralStdin(command, literalStdin) : legacyCommand
  scanLiteralShellPaths(legacyInput, base, paths, depth, checkDirectoryChanges)
  // Scan executable nodes at any depth, including substitutions in words and
  // assignments. This pass only discovers paths. Directory changes inside a
  // substitution must not be counted as outer compound directory changes.
  for (const part of commands) {
    if (part !== legacyInput) scanLiteralShellPaths(part, base, paths, depth, false)
  }
  for (const body of backtickBodies) literalShellPaths(body, base, paths, depth + 1, false)
}

function outerShellCommands(root: TsNode): string[] {
  const commands: string[] = []
  const nodes: TsNode[] = [root]
  for (let node = nodes.pop(); node; node = nodes.pop()) {
    if (node.type === 'command' || node.type === 'redirected_statement') {
      if (node.children.some(child => child.type === 'heredoc_redirect')) {
        // Inspect the command and file redirects without treating the payload
        // of a heredoc as argv. The original scan still runs in full.
        const header = node.children.filter(child => child.type === 'command' || child.type === 'file_redirect')
        if (header.length) commands.push(header.map(child => child.text).join(' '))
      } else commands.push(node.text)
    } else if (node.type === 'program' || node.type === 'list' || node.type === 'pipeline') {
      for (let index = node.children.length - 1; index >= 0; index--) nodes.push(node.children[index]!)
    }
  }
  return commands
}

type LiteralStdin = { node: TsNode; replacement: string }

function parsedShellPaths(root: TsNode) {
  const commands = new Set<string>()
  const literalStdin: LiteralStdin[] = []
  const backtickBodies = new Set<string>()
  const nodes = [root]
  for (let node = nodes.pop(); node; node = nodes.pop()) {
    if (node.type === 'comment' || node.type === 'raw_string') continue
    if (node.type === 'command') commands.add(node.text)
    // Supply a command name so the existing scanner checks standalone redirects.
    if (node.type === 'file_redirect') commands.add(`true ${node.text}`)
    const [first, second, third] = node.children
    // Shell file tests have path operands. String and arithmetic tests do not.
    if (node.type === 'unary_expression' && first?.type === 'test_operator' && second &&
        /^-[abcdefghkLNOprSsuwxG]$/.test(first.text)) commands.add(`stat -- ${second.text}`)
    if (node.type === 'binary_expression' && first && second?.type === 'test_operator' && third &&
        ['-ef', '-nt', '-ot'].includes(second.text)) commands.add(`stat -- ${first.text} ${third.text}`)
    if (node.type === 'command_substitution' && first?.text === '`' && node.children.at(-1)?.text === '`') {
      // Old-style substitutions remove these escapes before parsing their
      // body, so escaped inner backticks are executable in that body.
      const raw = node.text.slice(1, -1)
      const decoded = raw.replace(/\\([`$\\])/g, '$1')
      if (decoded !== raw) backtickBodies.add(decoded)
    }
    if (node.type === 'redirected_statement' && node.children.some(child => child.type === 'heredoc_redirect')) {
      const replacement = withoutLiteralStdin(node.text)
      if (replacement !== node.text) literalStdin.push({ node, replacement })
    }
    // A quoted heredoc body has no executable children. An unquoted body can
    // contain substitutions, and only those children are visited as commands.
    for (let index = node.children.length - 1; index >= 0; index--) nodes.push(node.children[index]!)
  }
  return { commands, literalStdin, backtickBodies }
}

function replaceLiteralStdin(command: string, replacements: LiteralStdin[]): string {
  const input = Buffer.from(command)
  const parts: string[] = []
  let cursor = 0
  for (const { node, replacement } of replacements) {
    if (node.startIndex < cursor || input.toString('utf8', node.startIndex, node.endIndex) !== node.text) continue
    parts.push(input.toString('utf8', cursor, node.startIndex), replacement)
    cursor = node.endIndex
  }
  parts.push(input.toString('utf8', cursor))
  return parts.join('')
}

function scanLiteralShellPaths(command: string, base: string, paths: Set<string>, depth: number, checkDirectoryChanges: boolean): void {
  let executable = ''
  let argument = 0
  let redirected = false
  let shellSource = false
  let optionsEnded = false
  for (const token of parse(command, name => '$' + name)) {
    if (typeof token !== 'string') {
      if ('op' in token && ['>', '>>', '<', '>|'].includes(token.op)) redirected = true
      else if ('op' in token && [';', '&&', '||', '|', '&', '\n'].includes(token.op)) { executable = ''; argument = 0; optionsEnded = false }
      continue
    }
    if (!executable) {
      if (/^[A-Za-z_]\w*=/.test(token)) continue
      if (token.includes('/') || token.startsWith('.')) paths.add(resolve(base, token))
      executable = basename(token)
      continue
    }
    if (shellSource) { literalShellPaths(token, base, paths, depth + 1, checkDirectoryChanges); shellSource = false; continue }
    if (['sh', 'bash', 'zsh'].includes(executable) && token === '-c') { shellSource = true; continue }
    if (!redirected && token === '--') { optionsEnded = true; continue }
    if (!token || (!redirected && !optionsEnded && token.startsWith('-')) || /[\n$*?{}]/.test(token)) continue
    argument++
    const filesystemArgument = ['cd', 'cat', 'head', 'tail', 'ls', 'stat', 'find', 'touch', 'rm', 'mv', 'cp', 'mkdir', 'rmdir', 'chmod', 'chown'].includes(executable)
    const patternArgument = ['grep', 'rg', 'sed', 'awk'].includes(executable) && argument === 1
    const pathArgument = !['printf', 'echo'].includes(executable) && !patternArgument && (token.includes('/') || token.startsWith('.'))
    if (redirected || filesystemArgument || pathArgument) paths.add(resolve(base, token))
    redirected = false
  }
}

/** Uses ordinary managed-session, allowed-path, conditional-rule and dedup policy. */
export async function preflightCodeModeInstructions(context: ToolUseContext, name: string, input: unknown, qualifiedPath?: string): Promise<Message[]> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return []
  if (!qualifiedPath && !['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash', 'PowerShell', 'apply_patch', 'NotebookEdit', 'LSP'].includes(name)) return []
  const args = input as Record<string, unknown>
  const paths = new Set<string>()
  const base = typeof args.cwd === 'string' ? expandPath(args.cwd) : getCwd()
  const read = getPreparedFileRead(context, name, args)
  const mutation = getPreparedFileMutation(context, name, args)
  const mutationSet = getPreparedFileMutationSet(context, name, args)
  const preparedPaths = [read, read?.alternate?.capability ? read.alternate : undefined, mutation, ...(mutationSet?.byPath.values() ?? [])]
  for (const file of preparedPaths) {
    if (!file) continue
    addTarget(paths, file.originalPath)
    addTarget(paths, file.canonicalPath)
    if (file.actualPath) addTarget(paths, file.actualPath)
  }
  if (qualifiedPath) addTarget(paths, expandPath(qualifiedPath, base))
  for (const key of ['file_path', 'filePath', 'path', 'notebook_path', 'cwd']) {
    if (typeof args[key] === 'string') addTarget(paths, key === 'cwd' ? base : expandPath(args[key], base))
  }
  if (['Glob', 'Grep', 'Bash', 'PowerShell'].includes(name)) addTarget(paths, resolve(base, '__code_mode_instruction_preflight__'))
  if (name === 'Bash' && typeof args.command === 'string') {
    // Literal shell arguments are known before execution. Expansions and computed
    // destinations are not interpreted as authority or guessed filesystem targets.
    literalShellPaths(args.command, base, paths)
  }
  if (name === 'apply_patch' && !mutationSet) for (const path of getPatchMutationPaths(input)) addTarget(paths, expandPath(path, base))
  context.loadedNestedMemoryPaths ??= new Set()
  const messages: Message[] = []
  for (const path of paths) {
    if (process.platform === 'win32' && (path.startsWith('\\\\') || path.startsWith('//'))) continue
    const attachments = await getNestedMemoryAttachmentsForFile(path, context, context.getAppState())
    messages.push(...attachments.map(createAttachmentMessage))
    if (messages.length) return messages
    const directory = await stat(path).then(value => value.isDirectory(), () => false)
    if (directory) {
      const nested = await getNestedMemoryAttachmentsForFile(resolve(path, '__code_mode_instruction_preflight__'), context, context.getAppState())
      messages.push(...nested.map(createAttachmentMessage))
      if (messages.length) return messages
    }
  }
  return messages
}
