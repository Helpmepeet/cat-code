import { randomUUID } from 'node:crypto'
import type { CanUseToolFn } from '../../hooks/useCanUseTool.js'
import { findToolByName, type ToolUseContext } from '../../Tool.js'
import type { Message } from '../../types/message.js'
import { createAssistantMessage, createUserMessage } from '../../utils/messages.js'
import { runToolUse } from '../../services/tools/toolExecution.js'
import { resolveCodeModeTool, codeModeToolPrincipal, captureCodeModeToolPrincipals, describeCodeModeTool, searchCodeModeTools, MAX_CODE_MODE_TOOL_NAME_CHARS } from './codeModeTools.js'
import { encode } from './runtime/protocol.js'
import { withCodeModeRead } from '../../utils/fileStateCache.js'
import { preflightCodeModeInstructions } from './codeModeInstructions.js'
import type { Attachment } from '../../utils/attachments.js'
import { hasScriptReadHooks } from '../../utils/hooks.js'
import { GlobTool } from '../GlobTool/GlobTool.js'

export type CodeModeCall = {
  toolUseId: string
  name: string
  input: unknown
  inputOmission?: { bytes: number }
  status: 'running' | 'completed' | 'failed' | 'cancelled' | 'blocked'
  line?: number
  result?: unknown
  error?: string
}
export type CodeModeIdentity = { cellId: string; generation: string; line?: number }

const MAX_PARALLEL_READS = 3

function canOverlapGlob(context: ToolUseContext, name: string, input: unknown): boolean {
  if (name !== GlobTool.name || findToolByName(context.options.tools, name) !== GlobTool) return false
  const pattern = (input as { pattern?: unknown } | null)?.pattern
  // Keep the search root in getPath's final-input preflight. Patterns that
  // can choose another root stay on the ordinary serial path.
  return typeof pattern === 'string' && !/[/\\:]/.test(pattern) &&
    !context.nestedMemoryAttachmentTriggers?.size && !hasScriptReadHooks(context)
}

function projectGuestData(value: unknown, limit: number): { complete: boolean; value?: unknown } {
  try {
    const serialized = JSON.stringify(value)
    if (Buffer.byteLength(serialized) > limit) return { complete: false }
    const data = JSON.parse(serialized)
    encode(data, limit)
    return { complete: true, value: data }
  } catch { return { complete: false } }
}

/** A cell-local fail-closed fence. Guest catch only handles ordinary tool errors. */
export class CodeModeDispatch {
  private tail: Promise<void> = Promise.resolve()
  private readonly activeReads = new Set<Promise<void>>()
  private fence?: string
  private inputBytes = 0
  private resultBytes = 0
  private readonly principals: Map<string, string>
  private readonly contextModifiers: ((context: ToolUseContext) => ToolUseContext)[] = []
  permissionBlocked = false
  readonly calls: CodeModeCall[] = []

  constructor(
    private context: ToolUseContext,
    private readonly canUseTool: CanUseToolFn,
    private readonly identity: CodeModeIdentity,
    private readonly deliver: (message: Message) => Promise<void>,
    private readonly following: (message: Message) => Promise<void>,
    principals: ReadonlyMap<string, string> = captureCodeModeToolPrincipals(context.options.tools, context),
  ) { this.principals = new Map(principals) }

  stop(reason: string): void { this.fence ??= reason }
  get blockedReason(): string | undefined { return this.fence }
  get currentContext(): ToolUseContext {
    const refreshed = this.context.options.refreshMcpRuntime?.()
    if (refreshed && (refreshed.tools !== this.context.options.tools ||
        refreshed.commands !== this.context.options.commands ||
        refreshed.mcpClients !== this.context.options.mcpClients ||
        refreshed.mcpResources !== this.context.options.mcpResources)) {
      this.context = { ...this.context, options: { ...this.context.options, ...refreshed } }
    }
    else if (!this.context.options.refreshMcpRuntime && this.context.options.refreshTools) {
      const tools = this.context.options.refreshTools()
      if (tools !== this.context.options.tools) this.context = { ...this.context, options: { ...this.context.options, tools } }
    }
    return this.context
  }

  private rememberDiscovered(context: ToolUseContext, names: readonly string[]): void {
    for (const name of names) {
      const tool = findToolByName(context.options.tools, name)
      if (tool) this.bindPrincipal(name, codeModeToolPrincipal(tool, context))
    }
  }

  private bindPrincipal(name: string, principal: string): void {
    const original = this.principals.get(name)
    if (original !== undefined && original !== principal) {
      this.stop('This tool name now resolves to a different principal. Author a new script for the refreshed pool.')
      this.context.codeModeHost?.fenceForInstructions(this.fence!)
      throw new Error(this.fence)
    }
    if (original === undefined) this.principals.set(name, principal)
  }

  async describe(name: string) {
    const context = this.currentContext
    const result = await describeCodeModeTool(context, name)
    if (result.schemaComplete) this.rememberDiscovered(context, [name, result.name])
    return result
  }

  async search(query: string, max: number) {
    const context = this.currentContext
    const result = await searchCodeModeTools(context, query, max)
    this.rememberDiscovered(context, result.matches.map(match => match.name))
    return result
  }

  get contextModifier(): ((context: ToolUseContext) => ToolUseContext) | undefined {
    if (this.contextModifiers.length === 0) return undefined
    const modifiers = this.contextModifiers.slice()
    return context => modifiers.reduce((current, modify) => modify(current), context)
  }

  /**
   * Prepare children in submission order. Only a known read that has passed the
   * normal effect boundary can release the lane early; everything else drains
   * those reads before running. No StreamingToolExecutor sibling-abort policy.
   */
  call(name: string, input: unknown, line?: number, nothrow = false): Promise<unknown> {
    if (!name || name.length > MAX_CODE_MODE_TOOL_NAME_CHARS) return Promise.reject(new Error('Tool name exceeds the isolated bridge limit'))
    if (this.calls.length >= 256) {
      this.stop('Code Mode child-call limit reached')
      return Promise.reject(new Error(this.fence))
    }
    const inputBytes = Buffer.byteLength(JSON.stringify(input))
    if (inputBytes > 64 * 1024 || this.inputBytes + inputBytes > 128 * 1024) {
      this.stop('Code Mode cumulative child-input limit reached')
      return Promise.reject(new Error(this.fence))
    }
    this.inputBytes += inputBytes
    const call: CodeModeCall = { toolUseId: `code_${randomUUID()}`, name, input, status: 'running', ...(line === undefined ? {} : { line }) }
    this.calls.push(call)
    const lane = Promise.withResolvers<void>()
    const operation = this.tail.then(() => this.execute(call, nothrow, () => {
      this.activeReads.add(settled)
      lane.resolve()
    })).catch(error => {
      if (call.status === 'running') call.status = this.context.abortController.signal.aborted ? 'cancelled' : this.fence ? 'blocked' : 'failed'
      call.error = (error instanceof Error ? error.message : String(error)).slice(0, 2048)
      throw error
    })
    const finish = () => {
      this.activeReads.delete(settled)
      lane.resolve()
    }
    const settled = operation.then(finish, finish)
    this.tail = lane.promise
    return operation
  }

  async settle(): Promise<void> {
    await this.tail
    await Promise.all(this.activeReads)
  }

  private assertCurrentPrincipal(name: string, principal: string) {
    if (this.fence || this.context.abortController.signal.aborted) {
      throw new Error(this.fence ?? 'Code Mode execution cancelled')
    }
    const current = resolveCodeModeTool(this.currentContext, name)
    if (codeModeToolPrincipal(current, this.context) !== principal) {
      this.stop('Tool principal changed before execution. Author a new script for the refreshed pool.')
      this.context.codeModeHost?.fenceForInstructions(this.fence!)
      throw new Error(this.fence)
    }
    return current
  }

  private async execute(call: CodeModeCall, nothrow: boolean, releaseReadLane: () => void): Promise<unknown> {
    const { name, input, line, toolUseId } = call
    let canOverlap = false
    while (!this.fence && !this.context.abortController.signal.aborted) {
      canOverlap = canOverlapGlob(this.currentContext, name, input)
      if (!this.activeReads.size) break
      if (!canOverlap) await Promise.all(this.activeReads)
      else if (this.activeReads.size >= MAX_PARALLEL_READS) await Promise.race(this.activeReads)
      else break
    }
    if (this.fence || this.context.abortController.signal.aborted) {
      throw new Error(this.fence ?? 'Code Mode execution cancelled')
    }
    const tool = resolveCodeModeTool(this.context, name)
    const dispatchedPrincipal = codeModeToolPrincipal(tool, this.context)
    this.bindPrincipal(name, dispatchedPrincipal)
    if (name !== tool.name) this.bindPrincipal(tool.name, dispatchedPrincipal)
    call.name = tool.name
    const identity = { ...this.identity, ...(line === undefined ? {} : { line }) }
    const assistant = Object.assign(createAssistantMessage({
      content: [{ type: 'tool_use', id: toolUseId, name: tool.name, input: input as Record<string, unknown> }],
      isVirtual: true,
    }), { codeMode: identity })
    await this.deliver(assistant)
    let result: unknown
    let failed = false
    let received = false
    let preparedGlob: unknown
    let overlapping = false
    this.context.loadedNestedMemoryPaths ??= new Set()
    return withCodeModeRead(toolUseId, async () => {
    try {
      for await (const update of runToolUse(
        { type: 'tool_use', id: toolUseId, name: tool.name, input: input as Record<string, unknown>, caller: { type: 'direct' } },
        assistant,
        async (...args) => {
          const decision = await this.canUseTool(...args)
          if (args[4] === toolUseId && decision.behavior === 'allow' && (decision.acceptFeedback || decision.contentBlocks?.length)) {
            this.stop('Approval feedback requires a new model decision before execution')
            this.context.codeModeHost?.fenceForInstructions('Approval feedback requires a new model decision before execution')
            await this.following(createUserMessage({ content: [
              ...(decision.acceptFeedback ? [{ type: 'text' as const, text: decision.acceptFeedback }] : []),
              ...(decision.contentBlocks ?? []),
            ] }))
            return { behavior: 'deny', message: this.fence!, decisionReason: { type: 'other', reason: this.fence! } }
          }
          return decision
        },
        {
          ...this.context, inlineCommand: undefined, preserveToolUseResults: true,
          getCodeModeDispatchFence: () => this.fence ?? (this.context.abortController.signal.aborted ? 'Code Mode execution cancelled' : undefined),
          messages: [...this.context.messages, assistant],
          onToolExecutionStart: () => {
            this.context.onToolExecutionStart?.()
            if (preparedGlob && canOverlapGlob(this.context, name, preparedGlob)) {
              overlapping = true
              releaseReadLane()
            }
          },
          onToolFinalInput: async (id, finalName, finalInput, executionContext) => {
            if (id !== toolUseId) return
            const current = this.assertCurrentPrincipal(name, dispatchedPrincipal)
            if (this.activeReads.size &&
                (!canOverlap || current !== GlobTool || !canOverlapGlob(executionContext, finalName, finalInput))) {
              await Promise.all(this.activeReads)
              this.assertCurrentPrincipal(name, dispatchedPrincipal)
            }
            call.name = finalName
            const bytes = Buffer.byteLength(JSON.stringify(finalInput))
            call.input = bytes <= 64 * 1024 ? finalInput : { omitted: true, reason: 'Final executable input display limit', bytes }
            if (bytes > 64 * 1024) call.inputOmission = { bytes }
            else delete call.inputOmission
            const qualifiedPath = current.getPath?.(finalInput)
            const instructions = !current.isMcp && !current.mcpInfo || qualifiedPath
              ? await preflightCodeModeInstructions(executionContext, finalName, finalInput, qualifiedPath) : []
            if (instructions.length) {
              this.stop('Final executable input activates instructions; author a new script')
              this.context.codeModeHost?.requireModelMessages(instructions)
              for (const message of instructions) await this.following(message)
              throw new Error(this.fence)
            }
            const finalTool = this.assertCurrentPrincipal(name, dispatchedPrincipal)
            if (canOverlap && finalTool === GlobTool && canOverlapGlob(executionContext, finalName, finalInput)) {
              preparedGlob = finalInput
            }
          },
        },
      )) {
        if (update.contextModifier) {
          const modify = update.contextModifier.modifyContext
          this.context = modify(this.context)
          this.contextModifiers.push(modify)
        }
        const message = update.message
        if (!message) continue
        const attachment = message.type === 'attachment' ? message.attachment as Attachment : undefined
        if (message.type === 'attachment' &&
            ((attachment?.type === 'hook_success' && attachment.content === '') ||
             (attachment?.type === 'hook_permission_decision' && attachment.decision === 'allow'))) {
          await this.deliver(message)
          continue
        }
        if (message.type === 'user') {
          const blocks = message.message.content
          const paired = Array.isArray(blocks) ? blocks.find(block => block.type === 'tool_result' && block.tool_use_id === toolUseId) : undefined
          if (paired?.type === 'tool_result') {
            received = true
            failed = Boolean(paired.is_error)
            // Effective content is produced after applicable PostToolUse replacement.
            // Never expose pre-hook data, MCP metadata, or host objects to the guest.
            const content = typeof paired.content === 'string' ? paired.content :
              (paired.content ?? []).map(block => block.type === 'text' ? { type: 'text', text: block.text } : ({
                type: 'direct-only-content',
                originalType: block.type,
                reason: 'This content requires direct tool delivery; media bytes are not exposed to the interpreter',
              }))
            const contentComplete = Buffer.byteLength(JSON.stringify(content)) <= 96 * 1024
            result = {
              content: contentComplete ? content : '[Effective content exceeds 96 KiB guest delivery limit; narrow the tool inputs or use direct delivery]',
              contentComplete, isError: failed,
              contentPolicy: 'text-only; annotations and protocol metadata are not transferred; non-text blocks are explicitly direct-only',
            }
            const mediaData = message.toolUseResult && typeof message.toolUseResult === 'object' &&
              'type' in message.toolUseResult && ['image', 'pdf', 'parts', 'notebook'].includes(String(message.toolUseResult.type))
            if (mediaData) result = { ...(result as Record<string, unknown>), dataComplete: false, dataUnavailable: 'Structured media requires direct tool delivery' }
            if (!tool.isMcp && !mediaData && (typeof paired.content === 'string' || !(paired.content ?? []).some(block => block.type !== 'text')) && message.toolUseResult !== undefined) {
              const data = projectGuestData(message.toolUseResult, 96 * 1024)
              result = {
                ...(result as Record<string, unknown>),
                ...(data.complete
                  ? { data: data.value, dataComplete: true }
                  : { dataComplete: false, dataUnavailable: 'Structured tool data is unsupported or exceeds the 96 KiB guest delivery limit' }),
              }
            }
            if (tool.isMcp && message.mcpMeta?.structuredContent) {
              const structured = projectGuestData(message.mcpMeta.structuredContent, 128 * 1024)
              result = {
                ...(result as Record<string, unknown>),
                ...(structured.complete
                  ? { structuredContent: structured.value, structuredContentComplete: true }
                  : { structuredContentComplete: false, structuredContentUnavailable: 'Structured result is unsupported or exceeds the 128 KiB guest delivery limit' }),
              }
            }
            const extra = Array.isArray(blocks) ? blocks.filter(block => block !== paired) : []
            if (extra.length) {
              this.stop('Approval feedback requires a new model decision')
              await this.following({ ...message, message: { ...message.message, content: extra } })
            }
            const auditMessage = Object.assign({ ...message, isVirtual: true as const }, { codeMode: identity })
            if ('permissionDecision' in message && message.permissionDecision) {
              if (!this.fence?.startsWith('Approval feedback')) this.permissionBlocked = true
              this.stop('Child permission decision requires a new model decision')
              if (message.permissionDecision.outcome === 'rejected-by-user') {
                const words = typeof paired.content === 'string' ? paired.content : JSON.stringify(content)
                const refusal = createUserMessage({ content: `User refused a scripted ${tool.name} action. Feedback for that action:\n${words}`, isMeta: true })
                this.context.codeModeHost?.fenceForInstructions('Human refusal requires a new model decision', [assistant, auditMessage, refusal])
                await this.following(refusal)
              }
            }
            await this.deliver(auditMessage)
            continue
          }
          if (Array.isArray(blocks) && blocks.some(block => block.type !== 'text')) {
            this.stop('Supplemental media requires direct tool delivery')
            await this.deliver(Object.assign({ ...message, isVirtual: true as const }, { codeMode: identity }))
            continue
          }
        }
        // Supplemental Skill instructions, hooks, and attachments cannot be selected
        // away by JavaScript. Conservatively yield before every subsequent call.
        if (message.type !== 'progress') {
          this.stop('New tool instructions require a new model decision')
          await this.following(message)
        }
      }
      for (const path of this.context.nestedMemoryAttachmentTriggers ?? []) {
        this.context.nestedMemoryAttachmentTriggers?.delete(path)
        const instructions = await preflightCodeModeInstructions(this.context, 'Read', { file_path: path })
        if (instructions.length) {
          this.stop('Tool-discovered instructions require a new script before further dispatch')
          this.context.codeModeHost?.requireModelMessages(instructions)
          for (const message of instructions) await this.following(message)
        }
      }
      if (!received) throw new Error('Child execution ended without a result receipt')
      call.status = this.context.abortController.signal.aborted ? 'cancelled' : failed ? (this.fence && !overlapping ? 'blocked' : 'failed') : 'completed'
      const resultBytes = Buffer.byteLength(JSON.stringify(result))
      call.result = this.resultBytes + resultBytes <= 128 * 1024
        ? result : { omitted: true, reason: 'Cumulative cell display-result limit', bytes: resultBytes }
      this.resultBytes += Math.min(resultBytes, 128 * 1024)
      if (failed && !nothrow) throw new Error(JSON.stringify(result).slice(0, 16_384))
      return result
    } catch (error) {
      call.status = this.context.abortController.signal.aborted ? 'cancelled' : this.fence && !overlapping ? 'blocked' : 'failed'
      call.error = error instanceof Error ? error.message : String(error)
      throw error
    }
    })
  }
}
