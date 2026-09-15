// biome-ignore-all assist/source/organizeImports: ANT-ONLY import markers must not be reordered
import { feature } from 'bun:bundle'
import { TASK_OUTPUT_TOOL_NAME } from '../tools/TaskOutputTool/constants.js'
import { EXIT_PLAN_MODE_V2_TOOL_NAME } from '../tools/ExitPlanModeTool/constants.js'
import { ENTER_PLAN_MODE_TOOL_NAME } from '../tools/EnterPlanModeTool/constants.js'
import { AGENT_TOOL_NAME } from '../tools/AgentTool/constants.js'
import { RESUME_AGENT_TOOL_NAME } from '../tools/ResumeAgentTool/constants.js'
import { ASK_USER_QUESTION_TOOL_NAME } from '../tools/AskUserQuestionTool/prompt.js'
import { TASK_STOP_TOOL_NAME } from '../tools/TaskStopTool/prompt.js'
import { FILE_READ_TOOL_NAME } from '../tools/FileReadTool/prompt.js'
import { WEB_SEARCH_TOOL_NAME } from '../tools/WebSearchTool/prompt.js'
import { TODO_WRITE_TOOL_NAME } from '../tools/TodoWriteTool/constants.js'
import { GREP_TOOL_NAME } from '../tools/GrepTool/prompt.js'
import { WEB_FETCH_TOOL_NAME } from '../tools/WebFetchTool/prompt.js'
import { GLOB_TOOL_NAME } from '../tools/GlobTool/prompt.js'
import { SHELL_TOOL_NAMES } from '../utils/shell/shellToolUtils.js'
import { FILE_EDIT_TOOL_NAME } from '../tools/FileEditTool/constants.js'
import { FILE_PATCH_TOOL_NAME } from '../tools/FilePatchTool/constants.js'
import { FILE_WRITE_TOOL_NAME } from '../tools/FileWriteTool/prompt.js'
import { NOTEBOOK_EDIT_TOOL_NAME } from '../tools/NotebookEditTool/constants.js'
import { SKILL_TOOL_NAME } from '../tools/SkillTool/constants.js'
import { SEND_MESSAGE_TOOL_NAME } from '../tools/SendMessageTool/constants.js'
import { TASK_CREATE_TOOL_NAME } from '../tools/TaskCreateTool/constants.js'
import { TASK_GET_TOOL_NAME } from '../tools/TaskGetTool/constants.js'
import { TASK_LIST_TOOL_NAME } from '../tools/TaskListTool/constants.js'
import { TASK_UPDATE_TOOL_NAME } from '../tools/TaskUpdateTool/constants.js'
import { TOOL_SEARCH_TOOL_NAME } from '../tools/ToolSearchTool/prompt.js'
import { SYNTHETIC_OUTPUT_TOOL_NAME } from '../tools/SyntheticOutputTool/SyntheticOutputTool.js'
import { ENTER_WORKTREE_TOOL_NAME } from '../tools/EnterWorktreeTool/constants.js'
import { EXIT_WORKTREE_TOOL_NAME } from '../tools/ExitWorktreeTool/constants.js'
import { WORKFLOW_TOOL_NAME } from '../tools/WorkflowTool/constants.js'
import { ASK_PARENT_SESSION_TOOL_NAME } from '../tools/AskParentSessionTool/prompt.js'
import { CLAUDE_CLI_TOOL_NAME } from '../tools/ClaudeCliTool/constants.js'
import { isTodoV2Enabled } from '../utils/tasks.js'
import { getAPIProvider } from '../utils/model/providers.js'
import {
  CRON_CREATE_TOOL_NAME,
  CRON_DELETE_TOOL_NAME,
  CRON_LIST_TOOL_NAME,
} from '../tools/ScheduleCronTool/prompt.js'

export { RESUME_AGENT_TOOL_NAME }

export const ALL_AGENT_DISALLOWED_TOOLS = new Set([
  TASK_OUTPUT_TOOL_NAME,
  EXIT_PLAN_MODE_V2_TOOL_NAME,
  ENTER_PLAN_MODE_TOOL_NAME,
  // Allow Agent/ResumeAgent for agents when user is ant (enables nested agents).
  // Other builds block recursive resume for the same authorization-boundary
  // reason they block recursive spawn.
  ...(process.env.USER_TYPE === 'ant' ? [] : [AGENT_TOOL_NAME]),
  ...(process.env.USER_TYPE === 'ant' ? [] : [RESUME_AGENT_TOOL_NAME]),
  ASK_USER_QUESTION_TOOL_NAME,
  TASK_STOP_TOOL_NAME,
  // Prevent recursive workflow execution inside subagents.
  ...(feature('WORKFLOW_SCRIPTS') ? [WORKFLOW_TOOL_NAME] : []),
])

export const CUSTOM_AGENT_DISALLOWED_TOOLS = new Set([
  ...ALL_AGENT_DISALLOWED_TOOLS,
])

/**
 * Provider aliases for the ONE file-edit capability. The pool carries exactly
 * one of these — `getProviderFileEditTool()` in tools.ts returns FilePatchTool
 * on the OpenAI/Codex path and FileEditTool everywhere else. Both names are
 * allowlisted for async agents (so the filter never strips a worker's only edit
 * tool) and both are denied together when a role disallows either one (see
 * resolveAgentTools): a provider alias must not change a role's logical
 * capability (owner decision 2026-07-30, C10/C11).
 */
export const PROVIDER_FILE_EDIT_TOOL_ALIASES = [
  FILE_EDIT_TOOL_NAME,
  FILE_PATCH_TOOL_NAME,
] as const

const ASYNC_AGENT_BASE_ALLOWED_TOOLS = [
  FILE_READ_TOOL_NAME,
  WEB_SEARCH_TOOL_NAME,
  GREP_TOOL_NAME,
  WEB_FETCH_TOOL_NAME,
  GLOB_TOOL_NAME,
  ...SHELL_TOOL_NAMES,
  FILE_WRITE_TOOL_NAME,
  NOTEBOOK_EDIT_TOOL_NAME,
  ASK_PARENT_SESSION_TOOL_NAME,
  SYNTHETIC_OUTPUT_TOOL_NAME,
  TOOL_SEARCH_TOOL_NAME,
  ENTER_WORKTREE_TOOL_NAME,
  EXIT_WORKTREE_TOOL_NAME,
] as const

/**
 * Tools an async agent does NOT get by default but MAY receive when its own
   * agent definition names them in its `tools` list. Skill is coordinator-only
   * by default so workers do not have Skill access unless a role explicitly
   * grants it (owner decision 2026-07-30, C10).
 * ClaudeCli launches a nested external Claude CLI agent loop, so it is a
   * narrow advisory tool for a role that names it (a coordinator coding
   * worker), not a default grant for every worker — a wildcard `tools: ['*']`
 * definition does not count as naming it (see resolveAgentTools).
 * ALL_AGENT_DISALLOWED_TOOLS stays absolute: this escape hatch never reopens a
 * recursion or authorization boundary.
 */
export const ASYNC_AGENT_EXPLICIT_GRANT_TOOLS = new Set([
  SKILL_TOOL_NAME,
  CLAUDE_CLI_TOOL_NAME,
])

const ASYNC_AGENT_V1_TASK_TOOLS = [TODO_WRITE_TOOL_NAME] as const

const ASYNC_AGENT_V2_TASK_TOOLS = [
  TASK_CREATE_TOOL_NAME,
  TASK_GET_TOOL_NAME,
  TASK_LIST_TOOL_NAME,
  TASK_UPDATE_TOOL_NAME,
] as const

/*
 * Async Agent Tool Availability Status (Source of Truth)
 */
export const ASYNC_AGENT_ALLOWED_TOOLS = new Set([
  ...ASYNC_AGENT_BASE_ALLOWED_TOOLS,
  ...PROVIDER_FILE_EDIT_TOOL_ALIASES,
  ...ASYNC_AGENT_V1_TASK_TOOLS,
  ...ASYNC_AGENT_V2_TASK_TOOLS,
])

/** The file-edit tool name a worker actually receives on this provider. */
export function getAsyncAgentFileEditTool(): string {
  return getAPIProvider() === 'openai'
    ? FILE_PATCH_TOOL_NAME
    : FILE_EDIT_TOOL_NAME
}

/**
 * The tools a delegated worker can receive, resolved for the current provider.
 * This is a candidate set: a worker's role definition may narrow it further
 * (see resolveAgentTools), so callers must not advertise it as a guarantee.
 */
export function getAsyncAgentDisplayTools(): string[] {
  return [
    ...ASYNC_AGENT_BASE_ALLOWED_TOOLS,
    getAsyncAgentFileEditTool(),
    ...(isTodoV2Enabled()
      ? ASYNC_AGENT_V2_TASK_TOOLS
      : ASYNC_AGENT_V1_TASK_TOOLS),
  ]
}
/**
 * Tools allowed only for in-process teammates (not general async agents).
 * These are injected by inProcessRunner.ts and allowed through filterToolsForAgent
 * via isInProcessTeammate() check.
 */
export const IN_PROCESS_TEAMMATE_ALLOWED_TOOLS = new Set([
  TASK_CREATE_TOOL_NAME,
  TASK_GET_TOOL_NAME,
  TASK_LIST_TOOL_NAME,
  TASK_UPDATE_TOOL_NAME,
  SEND_MESSAGE_TOOL_NAME,
  // Teammate-created crons are tagged with the creating agentId and routed to
  // that teammate's pendingUserMessages queue (see useScheduledTasks.ts).
  ...(feature('AGENT_TRIGGERS')
    ? [CRON_CREATE_TOOL_NAME, CRON_DELETE_TOOL_NAME, CRON_LIST_TOOL_NAME]
    : []),
])

/*
 * BLOCKED FOR ASYNC AGENTS:
 * - AgentTool: Blocked to prevent recursion
 * - TaskOutputTool: Blocked to prevent recursion
 * - ExitPlanModeTool: Plan mode is a main thread abstraction.
 * - TaskStopTool: Requires access to main thread task state.
 * - TungstenTool: Uses singleton virtual terminal abstraction that conflicts between agents.
 * - SkillTool, ClaudeCliTool: Default-off; an agent definition that names one
 *   of these in `tools` still gets it (ASYNC_AGENT_EXPLICIT_GRANT_TOOLS).
 *
 * ENABLE LATER (NEED WORK):
 * - MCPTool: TBD
 * - ListMcpResourcesTool: TBD
 * - ReadMcpResourceTool: TBD
 */

/**
 * Tools allowed in coordinator mode - only output and agent management tools for the coordinator
 */
export const COORDINATOR_MODE_ALLOWED_TOOLS = new Set([
  AGENT_TOOL_NAME,
  RESUME_AGENT_TOOL_NAME,
  TASK_STOP_TOOL_NAME,
  SEND_MESSAGE_TOOL_NAME,
  SYNTHETIC_OUTPUT_TOOL_NAME,
])
