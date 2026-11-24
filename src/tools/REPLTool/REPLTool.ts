import { z } from 'zod/v4'
import { buildTool, type ToolDef, type ToolResult } from '../../Tool.js'
import { isEnvTruthy } from '../../utils/envUtils.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { SCRIPT_BASH_DIRECTORY_GUIDANCE } from '../BashTool/prompt.js'
import { consumeCodeModeWrapperApproval } from './codeModeAdmission.js'
import { getScriptToolConcurrency, isReplModeEnabled, REPL_TOOL_NAME } from './constants.js'
import { MAX_AUTO_SCRIPT_REVIEW_CHARS } from './scriptReviewHistory.js'
import type { CodeModeResult } from './codeModeHost.js'

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
    return `Execute JavaScript in an isolated interpreter with persistent live variables. No ambient filesystem, network, process, or imports are available. Use await tools.call({name:"Read",input:{file_path:"/absolute/path"}}) to invoke a currently granted tool. Calls use normal validation, hooks, permissions, and serialization. A child returns {content,isError,contentPolicy}; content is effective tool-result text or text blocks after output hooks. Eligible MCP results may also include structuredContent and structuredContentComplete, bounded to 128 KiB; oversized structured content is explicitly unavailable. Post-hook replacement invalidates original structured metadata. Raw MCP _meta is never exposed. Ordinary failed commands throw and can be caught.
Use await tools.discover({op:"search",query:"keywords",max:5}) to search the current eligible pool. Search is bounded and declares completeness; inputKeys is only a preview. Use await tools.discover({op:"describe",name:"ToolName"}) for the complete input schema before calling an unfamiliar tool. Discovery does not grant authority or register native model tools.
${SCRIPT_BASH_DIRECTORY_GUIDANCE}
Each script costs a round trip, and everything it outputs stays in your context: about 150 lines of output cost as much as another script. Gather what your next decision needs in one script, let the code decide follow-up steps it can, and output only the evidence you need. Start another script when a result needs your judgment.
Inside a script, give each independent read its own sh call unless they form one pipeline, so each result shows whether it failed or found nothing. Keep results in variables instead of rerunning a command. After an edit, output the failing tests and git diff --stat rather than whole files.
Write short standalone comments above major operations so progress has useful step labels. Do not number the comments or include tool-call tallies.
In contextual Auto Mode, the first child that needs model review triggers one review of the entire Script and any earlier uncovered cells. A covering decision applies to this cell only. Child calls still go through tool permissions and hooks. Keep the current and uncovered source within 32,000 characters. Legacy Auto Mode uses its own classifier.
Ordinary results may include data and dataComplete, bounded to 96 KiB. These completeness flags describe guest delivery, not an exhaustive filesystem/search enumeration; honor the underlying data.truncated and pagination semantics. Content delivery is separately bounded and declares contentComplete. Returned structured data is not the selected model output.
An image returned by Read is sent separately to the model. Script receives a placeholder for the image and yields before further tool calls.
Run shell commands with sh. It keeps backslashes except for template escapes for backticks and \${. It inserts one quoted shell word per value or array item. Put values in separate argument positions outside quotes. The receiving command decides how to interpret its arguments. Refusals and command failures return isError; a search that finds nothing is not an error. Example:
const defs = await sh\`rg -l 'function loadConfig' src\`;
const uses = await sh\`rg -l 'loadConfig\\(' src -g '*.test.ts'\`;
const files = uses.data?.stdout?.trim();
if (defs.isError || uses.isError) output({ defs: defs.content, uses: uses.content });
else if (!files) output({ defs: defs.data.stdout, files: "none found" });
else { const tests = await sh\`bun test \${files.split("\\n")}\`; output({ defs: defs.data.stdout, files, tests: tests.isError ? tests.content : "passed" }); }
Write patches with String.raw. For other expected failures, pass nothrow:true to tools.call. The example assumes filenames contain no newlines. For sh, data.stdout includes stderr. If sh cannot deliver complete stdout, it returns isError:true without stdout. If Bash moves the command to the background, sh returns isError:true with its task ID. Inspect content or data and choose the next step. The cell result reports permission refusals and their source even when the guest throws or catches an error. A user skip or contextual Auto denial cancels already-queued changes. Fresh child calls still need their own permission. Cancellation or new instructions can fence the cell even if the guest catches the error.
Use output(value) for selected model-facing output, or console.log(value). Intermediate child results remain virtual audit records. Tools may return bounded or incomplete results: do not treat capped Glob, Grep, or Read output as exhaustive. Non-text blocks are explicit direct-only-content markers, never flattened media or base64; supplemental media yields for direct delivery. Instructions, Skill additions, approval feedback, and host outcomes are delivered separately and cannot be filtered by the script. Approval feedback pauses before the qualified operation itself, requiring a newly authored call.
Variables survive fully drained cells within this live session or worker incarnation, including retained functions and async helpers. Dynamic eval, Function constructors, async generators, for-await, and with are unsupported. Await your work: any unresolved guest Promise continuation at cell completion fences and destroys the interpreter rather than allowing it to borrow a later cell's authority. Foreground execution has a ten-minute wall limit. One interpreter evaluation runs at a time. Independent built-in Glob calls with filename-only patterns can overlap (up to ${getScriptToolConcurrency()}) when no relevant hooks are configured. Other calls run in submission order and wait for earlier reads. Await any result you depend on.
${backgroundTasksDisabled ? '' : `Set run_in_background:true for a task receipt while evaluation continues, bounded to two hours. A running receipt is followed by separately delivered final selected output and virtual child audit. Granted TaskOutput and TaskStop tools address the taskId. At most eight background cells may await delivery in one incarnation, with a shared limit of 32 undelivered cells. Later scripts queue behind the active interpreter cell. Healthy background work allows the conversation to continue. Cancellation or failed receipt delivery retains an effect fence until actual outcomes are accepted. Worker completion cancels and drains owned cells before releasing resources.\n`}A yielded script is terminal. Author a new script after receiving updated instructions.
State resets on restart, resume, fork, workspace transition, cancellation that destroys the runtime, or runtime failure. Earlier scripts are never replayed. A cell is not a transaction: completed effects are not rolled back by a later error. Applicable durable instructions are preflighted for qualified local-file targets after normal permission and final-input preparation, before effect. Simple literal Bash paths, redirections, and nested shell-source arguments are checked, with nested shell source limited to three levels. Opaque executed code and shell-expanded destinations are not inferred, so prefer explicit file tools for dependent file work. MCP domain paths do not implicitly activate unrelated local project instructions. New instructions are delivered outside selected output, and scripts authored by an older model-context epoch cannot cross the barrier.`
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
    const { contextualAutoReviewMode } = await import('../../utils/permissions/contextualAuthorization.js')
    if (getEffectiveAutoMode(context.getAppState().toolPermissionContext) !== null &&
        contextualAutoReviewMode() !== 'experimental') {
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
