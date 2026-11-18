import { z } from 'zod/v4'
import { buildTool, type ToolDef, type ToolResult } from '../../Tool.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { consumeCodeModeWrapperApproval } from './codeModeAdmission.js'
import { isReplModeEnabled, REPL_TOOL_NAME } from './constants.js'
import type { CodeModeResult } from './codeModeHost.js'

const MAX_AUTO_SCRIPT_REVIEW_CHARS = 32_000
// eslint-disable-next-line custom-rules/no-process-env-top-level -- Match the fixed Bash background schema for this process.
const backgroundTasksDisabled = isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_BACKGROUND_TASKS)

const fullInputSchema = lazySchema(() => z.strictObject({
  code: z.string().min(1).max(128 * 1024).describe('JavaScript to execute in the isolated persistent session interpreter'),
  description: z.string().min(1).max(512).describe('Brief description of what this script does'),
  run_in_background: z.boolean().optional().describe('Return a real task receipt while the script continues; completion is delivered separately'),
}))
const inputSchema = lazySchema(() => backgroundTasksDisabled
  ? fullInputSchema().omit({ run_in_background: true }) : fullInputSchema())
type InputSchema = ReturnType<typeof inputSchema>

export const REPLTool = buildTool({
  name: REPL_TOOL_NAME,
  maxResultSizeChars: 300_000,
  get inputSchema(): InputSchema { return inputSchema() },
  isEnabled: isReplModeEnabled,
  isConcurrencySafe: () => false,
  isReadOnly: () => false,
  toAutoClassifierInput: input => input.code,
  async checkPermissions(input, context) {
    const { getEffectiveAutoMode } = await import('../../utils/permissions/permissions.js')
    return getEffectiveAutoMode(context.getAppState().toolPermissionContext) !== null
      ? { behavior: 'passthrough' as const, message: 'The submitted script requires automatic admission before execution.' }
      : { behavior: 'allow' as const, updatedInput: input }
  },
  userFacingName: () => 'SCRIPT',
  async description() { return 'Execute JavaScript that orchestrates the currently granted coding tools' },
  async prompt() {
    return `Execute JavaScript in an isolated interpreter with persistent live variables. No ambient filesystem, network, process, or imports are available. Use await tools.call({name:"Read",input:{file_path:"/absolute/path"}}) to invoke a currently granted tool. Calls use normal validation, hooks, permissions, and serialization. A child returns {content,isError,contentPolicy}; content is effective tool-result text or text blocks after output hooks. Eligible MCP results may also include structuredContent and structuredContentComplete, bounded to 128 KiB; oversized structured content is explicitly unavailable. Post-hook replacement invalidates original structured metadata. Raw MCP _meta is never exposed. Ordinary failed commands throw and can be caught. Refusal, cancellation, and new instructions fence later calls even if caught.
Use await tools.discover({op:"search",query:"keywords",max:5}) to search the current eligible pool. Search is bounded and declares completeness; inputKeys is only a preview. Use await tools.discover({op:"describe",name:"ToolName"}) for the complete input schema before calling an unfamiliar tool. Discovery does not grant authority or register native model tools.
Write short standalone comments above major operations so progress has useful step labels. Do not number the comments or include tool-call tallies.
Auto mode reviews the complete final submitted script before execution. Its escaped script projection must fit 32,000 characters; split larger scripts into smaller persistent cells. Oversized Auto source is rejected, never silently truncated for review. Each child call still goes through its own tool permissions, including applicable Auto review of the arguments it will use.
Ordinary results may include data and dataComplete, bounded to 96 KiB. These completeness flags describe guest delivery, not an exhaustive filesystem/search enumeration; honor the underlying data.truncated and pagination semantics. Content delivery is separately bounded and declares contentComplete. Returned structured data is not the selected model output.
For expected command/test failures or diagnostic inspection, use await tools.call({name:"Bash",input:{command:"your test command",work_lifetime:"finite"${backgroundTasksDisabled ? '' : ',run_in_background:false'}},nothrow:true}). This returns the effective bounded result with isError:true instead of throwing; inspect content or data and choose the next step. Default calls reject on ordinary failures; the bridge error message may be generic, so use nothrow for diagnostic text. Neither nothrow nor catch clears refusal, cancellation, or instruction fences.
Use output(value) for selected model-facing output, or console.log(value). Intermediate child results remain virtual audit records. Tools may return bounded or incomplete results: do not treat capped Glob, Grep, or Read output as exhaustive. Non-text blocks are explicit direct-only-content markers, never flattened media or base64; supplemental media yields for direct delivery. Instructions, Skill additions, approval feedback, and host outcomes are delivered separately and cannot be filtered by the script. Approval feedback pauses before the qualified operation itself, requiring a newly authored call.
Variables survive fully drained cells within this live session or worker incarnation, including retained functions and async helpers. Dynamic eval, Function constructors, async generators, for-await, and with are unsupported. Await your work: any unresolved guest Promise continuation at cell completion fences and destroys the interpreter rather than allowing it to borrow a later cell's authority. Foreground execution has a ten-minute wall limit. One interpreter evaluation runs at a time; child calls currently serialize.
${backgroundTasksDisabled ? '' : `Set run_in_background:true for a task receipt while evaluation continues, bounded to two hours. A running receipt is followed by separately delivered final selected output and virtual child audit. Granted TaskOutput and TaskStop tools address the taskId. At most eight background cells may await delivery in one incarnation, with a shared limit of 32 undelivered cells. Later scripts queue behind the active interpreter cell. Healthy background work allows the conversation to continue. Cancellation or failed receipt delivery retains an effect fence until actual outcomes are accepted. Worker completion cancels and drains owned cells before releasing resources.\n`}A yielded script is terminal. Author a new script after receiving updated instructions.
State resets on restart, resume, fork, workspace transition, cancellation that destroys the runtime, or runtime failure. Earlier scripts are never replayed. A cell is not a transaction: completed effects are not rolled back by a later error. Direct coding tools remain available. Applicable durable instructions are preflighted for qualified local-file targets after normal permission and final-input preparation, before effect. Simple literal Bash paths, redirections, and nested shell-source arguments are checked, bounded to 64 targets and three nested levels; oversized analyses reject rather than silently omit targets. Opaque executed code and shell-expanded destinations are not inferred, so prefer explicit file tools for dependent file work. MCP domain paths do not implicitly activate unrelated local project instructions. New instructions are delivered outside selected output, and scripts authored by an older model-context epoch cannot cross the barrier.`
  },
  async validateInput(input, context) {
    if (context.codeModeHost && !context.codeModeHost.isModelContextCurrent(context.codeModeModelEpoch)) return {
      result: false, errorCode: 4,
      message: 'New instructions require a fresh model decision. End this turn and wait for the instructions before authoring another script.',
    }
    if (Buffer.byteLength(input.code) > 128 * 1024) return {
      result: false, errorCode: 3, message: 'Script source exceeds 128 KiB. Split it into smaller cells. No script code ran.',
    }
    const { getEffectiveAutoMode } = await import('../../utils/permissions/permissions.js')
    if (getEffectiveAutoMode(context.getAppState().toolPermissionContext) !== null) {
      const reviewed = /[\r\n\v\f\u0085\u2028\u2029<]/.test(input.code)
        ? JSON.stringify(input.code).replace(/</g, '\\u003c').replace(/\u0085/g, '\\u0085').replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')
        : input.code
      if (reviewed.length > MAX_AUTO_SCRIPT_REVIEW_CHARS) return {
        result: false, errorCode: 2,
        message: 'This script is too large for one automatic review. Split it into smaller cells. No script code ran.',
      }
    }
    return context.codeModeHost ? { result: true } : { result: false, message: 'Code Mode is unavailable in this runtime owner', errorCode: 1 }
  },
  renderToolUseMessage: () => null,
  renderToolResultMessage: () => null,
  renderToolUseErrorMessage: () => null,
  mapToolResultToToolResultBlockParam(data, toolUseID) {
    return { type: 'tool_result', tool_use_id: toolUseID, content: data.output }
  },
  async call(input, context, canUseTool, parentMessage) {
    if (!context.codeModeHost || !context.toolUseId) throw new Error('Code Mode requires an engine-owned runtime and cell identity')
    const policyIsCurrent = consumeCodeModeWrapperApproval(context, input)
    const source = { code: input.code, description: input.description }
    if ('run_in_background' in input && input.run_in_background === true) {
      if (backgroundTasksDisabled) throw new Error('Background scripts are disabled.')
      const data = context.codeModeHost.runBackground(source, context.toolUseId, context, canUseTool, policyIsCurrent, parentMessage.uuid)
      return { data, modelResultContent: data.output }
    }
    const completed = await context.codeModeHost.run(source, context.toolUseId, context, canUseTool, policyIsCurrent)
    const newMessages = completed.messages.filter(
      (message): message is NonNullable<ToolResult<CodeModeResult>['newMessages']>[number] =>
        message.type === 'assistant' || message.type === 'user' ||
        message.type === 'attachment' || message.type === 'system',
    )
    return { data: completed.result, modelResultContent: completed.result.output, newMessages, contextModifier: completed.contextModifier }
  },
} satisfies ToolDef<InputSchema, CodeModeResult>)
