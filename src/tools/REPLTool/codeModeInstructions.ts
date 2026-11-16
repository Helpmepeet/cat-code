import { basename, resolve } from 'node:path'
import { stat } from 'node:fs/promises'
import { parse } from 'shell-quote'
import type { ToolUseContext } from '../../Tool.js'
import type { Message } from '../../types/message.js'
import { getNestedMemoryAttachmentsForFile, createAttachmentMessage } from '../../utils/attachments.js'
import { getCwd } from '../../utils/cwd.js'
import { getPatchMutationPaths } from '../FilePatchTool/parser.js'

function addTarget(paths: Set<string>, path: string): void {
  if (!paths.has(path) && paths.size >= 64) throw new Error('Too many filesystem targets for one instruction preflight. Split the operation into smaller calls.')
  paths.add(path)
}

function literalShellPaths(command: string, base: string, paths: Set<string>, depth = 0): void {
  if (depth > 3) throw new Error('Shell nesting exceeds the instruction preflight limit. Use simpler commands or explicit file tools.')
  let executable = ''
  let argument = 0
  let redirected = false
  let shellSource = false
  for (const token of parse(command, () => '')) {
    if (typeof token !== 'string') {
      if ('op' in token && ['>', '>>', '<', '>|'].includes(token.op)) redirected = true
      else if ('op' in token && [';', '&&', '||', '|', '&', '\n'].includes(token.op)) { executable = ''; argument = 0 }
      continue
    }
    if (!executable) {
      if (/^[A-Za-z_]\w*=/.test(token)) continue
      if (token.includes('/') || token.startsWith('.')) addTarget(paths, resolve(base, token))
      executable = basename(token)
      continue
    }
    if (shellSource) { literalShellPaths(token, base, paths, depth + 1); shellSource = false; continue }
    if (['sh', 'bash', 'zsh'].includes(executable) && token === '-c') { shellSource = true; continue }
    if (!token || token.startsWith('-') || /[\n$*?{}]/.test(token)) continue
    argument++
    const filesystemArgument = ['cd', 'cat', 'head', 'tail', 'ls', 'stat', 'find', 'touch', 'rm', 'mv', 'cp', 'mkdir', 'rmdir', 'chmod', 'chown'].includes(executable)
    const patternArgument = ['grep', 'rg', 'sed', 'awk'].includes(executable) && argument === 1
    const pathArgument = !['printf', 'echo'].includes(executable) && !patternArgument && (token.includes('/') || token.startsWith('.'))
    if (redirected || filesystemArgument || pathArgument) addTarget(paths, resolve(base, token))
    redirected = false
  }
}

/** Uses ordinary managed-session, allowed-path, conditional-rule and dedup policy. */
export async function preflightCodeModeInstructions(context: ToolUseContext, name: string, input: unknown, qualifiedPath?: string): Promise<Message[]> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return []
  if (!qualifiedPath && !['Read', 'Write', 'Edit', 'Glob', 'Grep', 'Bash', 'PowerShell', 'apply_patch', 'NotebookEdit', 'LSP'].includes(name)) return []
  const args = input as Record<string, unknown>
  const paths = new Set<string>()
  const base = typeof args.cwd === 'string' ? resolve(getCwd(), args.cwd) : getCwd()
  if (qualifiedPath) addTarget(paths, resolve(base, qualifiedPath))
  for (const key of ['file_path', 'filePath', 'path', 'notebook_path', 'cwd']) {
    if (typeof args[key] === 'string') addTarget(paths, key === 'cwd' ? base : resolve(base, args[key] as string))
  }
  if (['Glob', 'Grep', 'Bash', 'PowerShell'].includes(name)) addTarget(paths, resolve(base, '__code_mode_instruction_preflight__'))
  if (name === 'Bash' && typeof args.command === 'string') {
    // Literal shell arguments are known before execution. Expansions and computed
    // destinations are not interpreted as authority or guessed filesystem targets.
    literalShellPaths(args.command, base, paths)
  }
  if (name === 'apply_patch') for (const path of getPatchMutationPaths(input)) addTarget(paths, resolve(base, path))
  context.loadedNestedMemoryPaths ??= new Set()
  const messages: Message[] = []
  for (const path of paths) {
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
