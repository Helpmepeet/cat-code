import { basename, dirname, extname, isAbsolute, relative, resolve } from 'node:path'
import type { Tool, Tools } from '../../Tool.js'
import type { Message } from '../../types/message.js'
import { collectPermissionDecisionContexts } from './permissionDecisionContext.js'

type PendingAction = { name: string; input: unknown }
export type AutoModeHistorySelection = {
  messages: Message[]
  keptCalls: number
  droppedCalls: number
  reason: 'independent_artifact' | 'ambiguous'
}

const ARTIFACT_EXTENSIONS = new Set(['.txt', '.md', '.csv', '.tsv'])
const SENSITIVE = /(?:^|[^\p{L}\p{N}])(?:agents|claude|skill|config|settings?|policy|permissions?|instructions?|rules?|secrets?|credentials?|passwords?|tokens?|keys?|auth|ssh|env)(?:$|[^\p{L}\p{N}])/iu
const INDIRECT = /\b(?:this|that|these|those|it|them|previous|earlier|above|same|again|both|all|yes|no|prerequisites?|after|before)\b/iu
const CODE = /\b(?:import|require|source|exec|eval|spawn|process|module|function|class|export|const|let|var)\b|\.[a-z][a-z\d]{0,8}\b/iu
// Bound selector work independently of the classifier's admission budget. An
// oversized or difficult history takes the ordinary full-evidence path.
const MAX_SELECTION_CHARS = 1_000_000
const MAX_TEXT_CHARS = 64_000

function tokens(text: string): Set<string> {
  return new Set(text.toLocaleLowerCase('en-US').match(/[\p{L}\p{N}_$]+/gu) ?? [])
}

function referenceTokens(text: string): Set<string> {
  // An explicit file path names that file. A bare directory name can instead
  // refer to its collection, whose members must all remain visible.
  return tokens(text.split(/\s+/u).filter(word => !word.includes('/') && !word.includes('\\')).join(' '))
}

function ordinaryPath(value: unknown, cwd: string): string | null {
  if (typeof value !== 'string' || !value || value.length > 4096 || value.includes('\0') || value.includes('\\')) return null
  const path = resolve(cwd, value)
  if (!ARTIFACT_EXTENSIONS.has(extname(path).toLowerCase()) || SENSITIVE.test(path) ||
    path.split('/').some(part => part.startsWith('.'))) return null
  return path
}

function plainArtifact(text: unknown): text is string {
  return typeof text === 'string' && text.length <= MAX_TEXT_CHARS && text.trim().length > 0 &&
    /^[\p{L}\p{N}\s_.,:!?;()'"%+-]*$/u.test(text) &&
    !SENSITIVE.test(text) && !CODE.test(text)
}

function values(input: unknown): string[] {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return []
  return Object.entries(input).filter(([key]) => key !== 'file_path')
    .flatMap(([, value]) => typeof value === 'string' ? [value] : [])
}

/**
 * Reduce only independently authored, plain-text artifact history. Code,
 * unknown tools, indirect approval scopes, and hidden dependency sources keep
 * their full evidence. This selects input messages; it never projects results.
 */
export function selectAutoModeHistory(
  messages: Message[], pending: PendingAction, tools: Tools, cwd: string,
): AutoModeHistorySelection {
  let callCount = 0
  for (const message of messages) if (message.type === 'assistant') {
    for (const block of message.message.content) if (block.type === 'tool_use') callCount++
  }
  const full = (): AutoModeHistorySelection => ({ messages, keptCalls: callCount, droppedCalls: 0, reason: 'ambiguous' })
  if (callCount > 1024 || cwd.length > 4096 || !isAbsolute(cwd)) return full()
  const calls = messages.flatMap(message => message.type === 'assistant'
    ? message.message.content.filter(block => block.type === 'tool_use').map(block => ({ message, block })) : [])
  const toolByName = new Map<string, Tool>(tools.map(tool => [tool.name, tool]))
  const pendingTool = toolByName.get(pending.name)
  if (pending.name !== 'Write' || !pendingTool || pendingTool.isMcp ||
    typeof pending.input !== 'object' || pending.input === null || !('file_path' in pending.input) ||
    !('content' in pending.input)) return full()
  const target = ordinaryPath(pending.input.file_path, cwd)
  const pendingValues = values(pending.input)
  if (!target || !plainArtifact(pending.input.content) ||
    pendingValues.some(value => value.length > MAX_TEXT_CHARS) ||
    pendingValues.reduce((total, value) => total + value.length, 0) > MAX_SELECTION_CHARS ||
    !pendingTool.inputSchema.safeParse(pending.input).success) return full()

  const protectedCalls = new Set(collectPermissionDecisionContexts(messages).map(record =>
    JSON.stringify([record.assistantUuid, record.toolUseId])))
  const completed = new Set<string>()
  const seenIds = new Set<string>()
  const sources: string[] = [pending.input.content]
  const roots = new Set([target])
  let chars = pending.input.content.length
  for (const message of messages) {
    // Auto-mode reminders contain closed mode metadata, with no file/content
    // dependencies. Preserve them while rejecting unknown attachment scopes.
    if (message.type === 'attachment' && (typeof message.attachment !== 'object' || message.attachment === null ||
      !('type' in message.attachment) || message.attachment.type !== 'auto_mode') ||
      message.type === 'system' ||
      message.type === 'user' && message.isCompactSummary) return full()
    if (message.type === 'user') {
      if (message.toolExecutionEvidence) return full()
      const content = message.message.content
      if (Array.isArray(content)) {
        for (const block of content) if (block.type === 'tool_result' && block.is_error !== true &&
          message.sourceToolAssistantUUID) completed.add(JSON.stringify([message.sourceToolAssistantUUID, block.tool_use_id]))
      }
      // Result bodies remain excluded, including text mixed into result turns.
      if (message.sourceToolAssistantUUID || message.toolUseResult !== undefined ||
        Array.isArray(content) && content.some(block => block.type === 'tool_result')) continue
      const text = typeof content === 'string' ? content : content.filter(block => block.type === 'text').map(block => block.text).join('\n')
      if (text.length > MAX_TEXT_CHARS || chars + text.length > MAX_SELECTION_CHARS || INDIRECT.test(text)) return full()
      sources.push(text)
      chars += text.length
    } else if (message.type === 'assistant') {
      const text = message.message.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
      if (text.length > MAX_TEXT_CHARS || chars + text.length > MAX_SELECTION_CHARS || INDIRECT.test(text)) return full()
      sources.push(text)
      chars += text.length
    }
    if (chars > MAX_SELECTION_CHARS) return full()
  }

  const candidates: { id: string; path: string; content: string; words: Set<string> }[] = []
  for (const { message, block } of calls) {
    if (seenIds.has(block.id)) return full()
    seenIds.add(block.id)
    const tool = toolByName.get(block.name)
    if (!tool || tool.isMcp || !['Read', 'Write', 'Edit'].includes(block.name) ||
      typeof block.input !== 'object' || block.input === null || !('file_path' in block.input)) return full()
    const path = ordinaryPath(block.input.file_path, cwd)
    if (!path) return full()
    const textValues = values(block.input)
    if (textValues.some(value => value.length > MAX_TEXT_CHARS) ||
      chars + textValues.reduce((total, value) => total + value.length + 1, 0) > MAX_SELECTION_CHARS ||
      !tool.inputSchema.safeParse(block.input).success) return full()
    const content = textValues.join('\n')
    chars += content.length
    if (chars > MAX_SELECTION_CHARS) return full()
    if (block.name !== 'Read' && !textValues.every(plainArtifact)) return full()
    const id = JSON.stringify([message.uuid, block.id])
    if (block.name === 'Read' || !completed.has(id) || protectedCalls.has(id)) {
      roots.add(path)
      sources.push(content)
    } else {
      candidates.push({ id, path, content, words: tokens(content) })
    }
  }

  // Preserve content provenance and named dependencies transitively. No
  // stopwords are discarded: even a short shared value can be copied data.
  const retained = new Set<string>()
  const vocabulary = tokens(sources.join('\n'))
  const references = referenceTokens(sources.join('\n'))
  if (candidates.length * sources.reduce((total, source) => total + source.length, 0) > 16_000_000) return full()
  const explicitlyNamed = new Set(candidates.filter(candidate => {
    const names = [candidate.path, relative(cwd, candidate.path), basename(candidate.path),
      basename(candidate.path, extname(candidate.path))]
    return sources.some(source => names.some(name => name && source.includes(name)))
  }).map(candidate => candidate.id))
  let changed = true
  let dependencyChecks = 0
  while (changed) {
    changed = false
    for (const candidate of candidates) {
      if (retained.has(candidate.id)) continue
      const aliases = tokens(`${basename(dirname(candidate.path))} ${basename(candidate.path, extname(candidate.path)).replace(/[-_]/g, ' ')}`)
      dependencyChecks += aliases.size + candidate.words.size
      if (dependencyChecks > 100_000) return full()
      if (!roots.has(candidate.path) && !explicitlyNamed.has(candidate.id) && ![...aliases].some(word => references.has(word)) &&
        ![...candidate.words].some(word => vocabulary.has(word))) continue
      retained.add(candidate.id)
      roots.add(candidate.path)
      for (const word of candidate.words) vocabulary.add(word)
      for (const word of referenceTokens(candidate.content)) references.add(word)
      changed = true
    }
  }
  const dropped = new Set(candidates.filter(candidate => !retained.has(candidate.id)).map(candidate => candidate.id))
  if (!dropped.size) return full()
  const selected = messages.map(message => {
    if (message.type !== 'assistant') return message
    const content = message.message.content.filter(block => block.type !== 'tool_use' ||
      !dropped.has(JSON.stringify([message.uuid, block.id])))
    return content.length === message.message.content.length ? message : { ...message, message: { ...message.message, content } }
  })
  return { messages: selected, keptCalls: calls.length - dropped.size, droppedCalls: dropped.size, reason: 'independent_artifact' }
}
