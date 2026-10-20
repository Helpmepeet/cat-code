// biome-ignore-all assist/source/organizeImports: ANT-ONLY import markers must not be reordered
import { getAntModelOverrideConfig } from '../utils/model/antModels.js'
import { type as osType, version as osVersion, release as osRelease } from 'os'
import { env } from '../utils/env.js'
import { getIsGit } from '../utils/git.js'
import { getCwd } from '../utils/cwd.js'
import { isManagedSession } from '../utils/managedSessionPolicy.js'
import { getIsNonInteractiveSession } from '../bootstrap/state.js'
import { getCurrentWorktreeSession } from '../utils/worktree.js'
import { getSessionStartDate } from './common.js'
import { getInitialSettings } from '../utils/settings/settings.js'
import { AGENT_TOOL_NAME } from '../tools/AgentTool/constants.js'
import { FILE_WRITE_TOOL_NAME } from '../tools/FileWriteTool/prompt.js'
import { FILE_READ_TOOL_NAME } from '../tools/FileReadTool/prompt.js'
import { FILE_EDIT_TOOL_NAME } from '../tools/FileEditTool/constants.js'
import { TODO_WRITE_TOOL_NAME } from '../tools/TodoWriteTool/constants.js'
import { TASK_CREATE_TOOL_NAME } from '../tools/TaskCreateTool/constants.js'
import type { Tools } from '../Tool.js'
import type { Command } from '../types/command.js'
import { BASH_TOOL_NAME } from '../tools/BashTool/toolName.js'
import {
  getCanonicalName,
  getMarketingNameForModel,
} from '../utils/model/model.js'
import { getSkillToolCommands } from 'src/commands.js'
import { SKILL_TOOL_NAME } from '../tools/SkillTool/constants.js'
import { getOutputStyleConfig } from './outputStyles.js'
import type {
  MCPServerConnection,
  ConnectedMCPServer,
} from '../services/mcp/types.js'
import { GLOB_TOOL_NAME } from 'src/tools/GlobTool/prompt.js'
import { GREP_TOOL_NAME } from 'src/tools/GrepTool/prompt.js'
import { hasEmbeddedSearchTools } from 'src/utils/embeddedTools.js'
import { ASK_USER_QUESTION_TOOL_NAME } from '../tools/AskUserQuestionTool/prompt.js'
import { EXPLORE_AGENT } from 'src/tools/AgentTool/built-in/exploreAgent.js'
import { areExplorePlanAgentsEnabled } from 'src/tools/AgentTool/builtInAgents.js'
import {
  isScratchpadEnabled,
  getScratchpadDir,
} from '../utils/permissions/filesystem.js'
import { isEnvDefinedFalsy, isEnvTruthy } from '../utils/envUtils.js'
import { isReplModeEnabled } from '../tools/REPLTool/constants.js'
import { feature } from 'bun:bundle'
import { getFeatureValue_CACHED_MAY_BE_STALE } from 'src/services/analytics/growthbook.js'
import { shouldUseGlobalCacheScope } from '../utils/betas.js'
import { isForkSubagentEnabled } from '../tools/AgentTool/forkSubagent.js'
import {
  systemPromptSection,
  DANGEROUS_uncachedSystemPromptSection,
  resolveSystemPromptSections,
  NO_SECTION_INPUTS,
} from './systemPromptSections.js'
import {
  getAgentPromptIdentityPrefix,
  getCLISyspromptPrefix,
} from './system.js'
import { SLEEP_TOOL_NAME } from '../tools/SleepTool/prompt.js'
import { TICK_TAG } from './xml.js'
import { logForDebugging } from '../utils/debug.js'
import { loadMemoryPrompt } from '../memdir/memdir.js'
import { isUndercover } from '../utils/undercover.js'
import { isMcpInstructionsDeltaEnabled } from '../utils/mcpInstructionsDelta.js'
import {
  getAPIProvider,
  resolveRequestProvider,
  type APIProvider,
} from '../utils/model/providers.js'
import { getGPTPromptFamily, isGPTPromptStyle } from './promptStyle.js'
import {
  getGPTIntroSection,
  getGPTSystemSection,
  getGPTDoingTasksSection,
  getGPTActionsSection,
  getGPTUsingToolsSection,
  getGPTToneAndStyleSection,
  getGPTOutputSection,
  getGPTSessionGuidanceSection,
  getGPTDefaultAgentPrompt,
} from './promptStyles/gpt.js'

// Dead code elimination: conditional imports for feature-gated modules
/* eslint-disable @typescript-eslint/no-require-imports */
const getCachedMCConfigForFRC = feature('CACHED_MICROCOMPACT')
  ? (
      require('../services/compact/cachedMCConfig.js') as typeof import('../services/compact/cachedMCConfig.js')
    ).getCachedMCConfig
  : null

const proactiveModule =
  feature('PROACTIVE') || feature('KAIROS')
    ? require('../proactive/index.js')
    : null
const BRIEF_PROACTIVE_SECTION: string | null =
  feature('KAIROS') || feature('KAIROS_BRIEF')
    ? (
        require('../tools/BriefTool/prompt.js') as typeof import('../tools/BriefTool/prompt.js')
      ).BRIEF_PROACTIVE_SECTION
    : null
const briefToolModule =
  feature('KAIROS') || feature('KAIROS_BRIEF')
    ? (require('../tools/BriefTool/BriefTool.js') as typeof import('../tools/BriefTool/BriefTool.js'))
    : null
const DISCOVER_SKILLS_TOOL_NAME: string | null = feature(
  'EXPERIMENTAL_SKILL_SEARCH',
)
  ? (
      require('../tools/DiscoverSkillsTool/prompt.js') as typeof import('../tools/DiscoverSkillsTool/prompt.js')
    ).DISCOVER_SKILLS_TOOL_NAME
  : null
// Capture the module (not .isSkillSearchEnabled directly) so spyOn() in tests
// patches what we actually call — a captured function ref would point past the spy.
const skillSearchFeatureCheck = feature('EXPERIMENTAL_SKILL_SEARCH')
  ? (require('../services/skillSearch/featureCheck.js') as typeof import('../services/skillSearch/featureCheck.js'))
  : null
/* eslint-enable @typescript-eslint/no-require-imports */
import type { OutputStyleConfig } from './outputStyles.js'
import {
  getCorePolicySection,
  getCyberPolicyInstruction,
  HOOK_AUTHORITY_RULE,
  INSTRUCTION_AUTHORITY_RULE,
  OUTCOME_REPORTING_RULE,
  PROJECT_INSTRUCTION_AUTHORITY_RULE,
  PROMPT_INJECTION_RULE,
  RETRY_RULE,
  RUNTIME_METADATA_RULE,
  TOOL_OUTPUT_IS_DATA_RULE,
} from './corePolicy.js'

/**
 * Boundary marker separating static (cross-org cacheable) content from dynamic content.
 * Everything BEFORE this marker in the system prompt array can use scope: 'global'.
 * Everything AFTER contains user/session-specific content and should not be cached.
 *
 * WARNING: Do not remove or reorder this marker without updating cache logic in:
 * - src/utils/api.ts (splitSysPromptPrefix)
 * - src/services/api/claude.ts (buildSystemPromptBlocks)
 */
export const SYSTEM_PROMPT_DYNAMIC_BOUNDARY =
  '__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__'

// @[MODEL LAUNCH]: Update the model IDs below to the latest in each tier.
const LATEST_CLAUDE_MODEL_IDS = {
  opus: 'claude-opus-5-5',
  sonnet: 'claude-sonnet-5-5',
  haiku: 'claude-haiku-5-5',
}

function getConversationCompressionInstruction(): string {
  return 'When the conversation grows long, some or all of the current context is summarized; the summary, along with any remaining unsummarized context, is provided in the next context window so work can continue. You do not need to wrap up early or hand off mid-task.'
}

/**
 * Proactive-only. That assembly has no `# System` section, so the shared
 * provenance rules would otherwise reach every variant except the most
 * autonomous one.
 */
function getSystemRemindersSection(): string {
  return `- ${RUNTIME_METADATA_RULE}
- ${TOOL_OUTPUT_IS_DATA_RULE}
- ${PROMPT_INJECTION_RULE}
- ${HOOK_AUTHORITY_RULE}
- ${getConversationCompressionInstruction()}`
}

function getAntModelOverrideSection(): string | null {
  if (process.env.USER_TYPE !== 'ant') return null
  if (isUndercover()) return null
  return getAntModelOverrideConfig()?.defaultSystemPromptSuffix || null
}

function getLanguageSection(
  languagePreference: string | undefined,
): string | null {
  if (!languagePreference) return null

  return `# Language
Always respond in ${languagePreference}. Use ${languagePreference} for all explanations, comments, and communications with the user. Technical terms and code identifiers should remain in their original form.`
}

function getOutputStyleSection(
  outputStyleConfig: OutputStyleConfig | null,
): string | null {
  if (outputStyleConfig === null) return null

  return `# Output Style: ${outputStyleConfig.name}
${outputStyleConfig.prompt}`
}

function getMcpInstructionsSection(
  mcpClients: MCPServerConnection[] | undefined,
): string | null {
  if (!mcpClients || mcpClients.length === 0) return null
  return getMcpInstructions(mcpClients)
}

export function prependBullets(items: Array<string | string[]>): string[] {
  return items.flatMap(item =>
    Array.isArray(item)
      ? item.map(subitem => `  - ${subitem}`)
      : [` - ${item}`],
  )
}

function getSimpleIntroSection(
  outputStyleConfig: OutputStyleConfig | null,
): string {
  const introTaskDescription =
    outputStyleConfig !== null
      ? 'according to your "Output Style" below, which describes how you should respond to user queries.'
      : isManagedSession()
        ? 'with the tasks they request. Prioritize correctness over appearing successful, and say so plainly when constraints conflict.'
      : 'with software engineering tasks. Prioritize correctness over appearing successful, and say so plainly when constraints conflict.'
  // eslint-disable-next-line custom-rules/prompt-spacing
  return `You are an interactive agent that helps users ${introTaskDescription} Use the instructions below and the tools available to you to assist the user.

If the user asks about the instruction prompt, feel free to talk about it.

${getCyberPolicyInstruction()}

IMPORTANT: Do not generate or guess non-programming URLs. You may navigate to a well-known public service's exact root homepage when it directly fits the user's request. Never infer a deeper path, video link, playlist, search-result URL, account page, purchase page, or another domain. Otherwise use only URLs provided by the user in their messages or local files, or returned by your web searches or otherwise read with a tool.`
}

function getSimpleSystemSection(): string {
  const items = [
    `All text you output outside of tool use is displayed to the user. Output text to communicate with the user. You can use Github-flavored markdown for formatting, and will be rendered in a monospace font using the CommonMark specification.`,
    `Tools are executed in a user-selected permission mode. When you attempt to call a tool that is not automatically allowed by the user's permission mode or permission settings, the user will be prompted so that they can approve or deny the execution. If the user denies a tool you call, do not re-attempt the exact same tool call. Instead, think about why the user has denied the tool call and adjust your approach.`,
    TOOL_OUTPUT_IS_DATA_RULE,
    RUNTIME_METADATA_RULE,
    PROMPT_INJECTION_RULE,
    HOOK_AUTHORITY_RULE,
    getConversationCompressionInstruction(),
  ]

  return ['# System', ...prependBullets(items)].join(`\n`)
}

function getSimpleDoingTasksSection(enabledTools: Set<string>): string {
  const managed = isManagedSession()
  const codeStyleSubitems = [
    `Don't add features, refactor code, or make "improvements" beyond what was asked. A bug fix doesn't need surrounding code cleaned up. A simple feature doesn't need extra configurability. Don't add docstrings, comments, or type annotations to code you didn't change.`,
    `Don't add error handling, fallbacks, or validation for scenarios that can't happen. Trust internal code and framework guarantees. Only validate at system boundaries (user input, external APIs, file I/O, network calls). Don't use feature flags, backwards-compatibility shims, renamed unused _vars, re-exports, or "// removed" markers when you can just change the code. If you are certain something is unused, delete it.`,
    `Don't create helpers, utilities, or abstractions for one-time operations. Don't design for hypothetical future requirements. The right amount of complexity is what the task actually requires—no speculative abstractions, but no half-finished implementations either. Three similar lines of code is better than a premature abstraction.`,
    `Default to writing very few comments. Only add one when the reason is not obvious: a hidden constraint, a subtle invariant, a workaround for a specific bug, or behavior that would surprise a reader. Don't restate what the code already says, and don't reference the current task, fix, or callers ("used by X", "handles the case from issue #123"), since those rot as the codebase evolves. Don't remove existing comments unless you're removing the code they describe or you know they're wrong; one that looks unnecessary may still encode a lesson from a past bug.`,
    `For risky or important changes, verify before saying the task is done when possible. If verification is not possible, say that clearly. Do not overdo verification for small, low-risk changes.`,
  ]

  const items = [
    managed
      ? `Interpret the task from the user's request. The working directory is a place to work, not evidence that its existing files or a repository are the subject of the request.`
      : `The user will primarily request you to perform software engineering tasks. These may include solving bugs, adding new functionality, refactoring code, explaining code, and more. When given an unclear or generic instruction, consider it in the context of these software engineering tasks and the current working directory. For example, if the user asks you to change "methodName" to snake case, do not reply with just "method_name", instead find the method in the code and modify the code.`,
    `If the user is wrong, say so clearly, calmly, and briefly. Do not agree just to preserve momentum. If you notice a nearby bug, risky assumption, or likely mistake related to the task, mention it briefly even if the user did not ask.`,
    `In general, do not propose changes to code you haven't read. If a user asks about or wants you to modify a file, read it first, and re-read it if another session may have changed it since. Understand existing code before suggesting modifications.`,
    `Do not create files unless they're absolutely necessary for achieving your goal. Generally prefer editing an existing file to creating a new one, as this prevents file bloat and builds on existing work more effectively.`,
    `${RETRY_RULE} Escalate to the user${enabledTools.has(ASK_USER_QUESTION_TOOL_NAME) ? ` with ${ASK_USER_QUESTION_TOOL_NAME}` : ''} only when you're genuinely stuck after investigation, not as a first response to friction.`,
    `Be careful not to introduce security vulnerabilities such as command injection, XSS, SQL injection, and other OWASP top 10 vulnerabilities. If you notice that you wrote insecure code, immediately fix it. Prioritize writing safe, secure, and correct code.`,
    ...(managed ? [codeStyleSubitems[codeStyleSubitems.length - 1]!] : codeStyleSubitems),
    OUTCOME_REPORTING_RULE,
    ...(process.env.USER_TYPE === 'ant'
      ? [
          `If the user reports a bug, slowness, or unexpected behavior with Cat Code itself (as opposed to asking you to fix their own code), recommend the appropriate slash command: /issue for model-related problems (odd outputs, wrong tool choices, hallucinations, refusals), or /share to upload the full session transcript for product bugs, crashes, slowness, or general issues. Only recommend these when the user is describing a problem with Cat Code. After /share produces a ccshare link, if you have a Slack MCP tool available, offer to post the link to #claude-code-feedback (channel ID C07VBSHV7EV) for the user.`,
        ]
      : []),
  ]

  return [`# Doing tasks`, ...prependBullets(items)].join(`\n`)
}

function getActionsSection(): string {
  return `# Executing actions with care

Carefully consider the reversibility and blast radius of actions. Generally you can freely take local, reversible actions like editing files or running tests. But for actions that are hard to reverse, affect shared systems beyond your local environment, or could otherwise be risky or destructive, check with the user before proceeding. The cost of pausing to confirm is low, while the cost of an unwanted action (lost work, unintended messages sent, deleted branches) can be very high. For actions like these, consider the context, the action, and user instructions, and by default transparently communicate the action and ask for confirmation before proceeding. This default can be changed by user instructions - if explicitly asked to operate more autonomously, then you may proceed without confirmation, but still attend to the risks and consequences when taking actions. A user approving an action (like a git push) once does NOT mean that they approve it in all contexts, so unless the action is authorized in advance for that scope, always confirm first. Authorization stands for the scope specified, not beyond. Match the scope of your actions to what was actually requested.

${PROJECT_INSTRUCTION_AUTHORITY_RULE} If a loaded instruction file or skill causes you to pause, ask for permission, or leave work unfinished, name the file and quote the instruction, separating its requirement from your interpretation.

Examples of the kind of risky actions that warrant user confirmation:
- Destructive operations: deleting files/branches, dropping database tables, killing processes, rm -rf, overwriting uncommitted changes
- Hard-to-reverse operations: force-pushing (can also overwrite upstream), git reset --hard, amending published commits, removing or downgrading packages/dependencies, modifying CI/CD pipelines
- Actions visible to others or that affect shared state: pushing code, creating/closing/commenting on PRs or issues, sending messages (Slack, email, GitHub), posting to external services, modifying shared infrastructure or permissions
- Uploading content to third-party web tools (diagram renderers, pastebins, gists) publishes it - consider whether it could be sensitive before sending, since it may be cached or indexed even if later deleted.

When you encounter an obstacle, do not use destructive actions as a shortcut to simply make it go away. For instance, identify root causes and fix underlying issues rather than bypassing safety checks (e.g. --no-verify). If you discover unexpected state like unfamiliar files, branches, or configuration, investigate before deleting or overwriting, as it may represent the user's in-progress work. For example, typically resolve merge conflicts rather than discarding changes; similarly, if a lock file exists, investigate what process holds it rather than deleting it. In short: only take risky actions carefully, and when in doubt, ask before acting. Follow both the spirit and letter of these instructions - measure twice, cut once.`
}

function getDeliveringWorkSection(): string {
  return `# Delivering work

Once you have enough to act, act. Build on what the conversation has already settled, and give a recommendation rather than a survey of options. A request to inspect, explain, review, or diagnose is not a request to change anything. A new message usually steers the current task rather than replacing it, so answer it and carry on.

Deliver the scope that was asked for, without quietly narrowing, widening, or replacing it. If you see a problem with it, say so briefly and keep building under a stated assumption; if the user still wants it as asked, that settles it. If something is unclear, do the parts that don't depend on it first. If part is blocked, finish the rest and say what you left out and why. Stop and wait for an answer only when every reasonable assumption would be unsafe or make the result useless.`
}

function getCorrectionsSection(): string {
  return `# Corrections

If something you told the user was wrong in a way that would change their code, conclusions, or decisions, correct it briefly and continue. A follow-up question is not by itself a sign you were wrong; answer what was asked.`
}

function getUsingYourToolsSection(enabledTools: Set<string>): string {
  const taskToolName = [TASK_CREATE_TOOL_NAME, TODO_WRITE_TOOL_NAME].find(n =>
    enabledTools.has(n),
  )

  // In REPL mode, Read/Write/Edit/Glob/Grep/Bash/Agent are hidden from direct
  // use (REPL_ONLY_TOOLS). REPL's prompt covers scripted tool calls.
  if (isReplModeEnabled()) {
    const items = [
      taskToolName
        ? `Break down and manage your work with the ${taskToolName} tool. These tools are helpful for planning your work and helping the user track your progress. Mark each task as completed as soon as you are done with the task. Do not batch up multiple tasks before marking them as completed.`
        : null,
    ].filter(item => item !== null)
    if (items.length === 0) return ''
    return [`# Using your tools`, ...prependBullets(items)].join(`\n`)
  }

  // Ant-native builds alias find/grep to embedded bfs/ugrep and remove the
  // dedicated Glob/Grep tools, so skip guidance pointing at them.
  const embedded = hasEmbeddedSearchTools()

  const providedToolSubitems = [
    enabledTools.has(FILE_READ_TOOL_NAME)
      ? `${FILE_READ_TOOL_NAME}: file contents.`
      : null,
    enabledTools.has(FILE_EDIT_TOOL_NAME)
      ? `${FILE_EDIT_TOOL_NAME}: exact string replacements.`
      : null,
    enabledTools.has(FILE_WRITE_TOOL_NAME)
      ? `${FILE_WRITE_TOOL_NAME}: create or replace files.`
      : null,
    !embedded && enabledTools.has(GLOB_TOOL_NAME)
      ? `${GLOB_TOOL_NAME}: file name patterns.`
      : null,
    !embedded && enabledTools.has(GREP_TOOL_NAME)
      ? `${GREP_TOOL_NAME}: content searches.`
      : null,
  ].filter(item => item !== null)

  const items = [
    ...(providedToolSubitems.length > 0
      ? [
          'Available file tools:',
          providedToolSubitems,
        ]
      : []),
    ...(enabledTools.has(BASH_TOOL_NAME)
      ? [
          `${BASH_TOOL_NAME}: shell commands.`,
        ]
      : []),
    taskToolName
      ? `Break down and manage your work with the ${taskToolName} tool. These tools are helpful for planning your work and helping the user track your progress. Mark each task as completed as soon as you are done with the task. Do not batch up multiple tasks before marking them as completed.`
      : null,
    `You can call multiple tools in a single response. If you intend to call multiple tools and there are no dependencies between them, make all independent tool calls in parallel. Maximize use of parallel tool calls where possible to increase efficiency. However, if some tool calls depend on previous calls to inform dependent values, do NOT call these tools in parallel and instead call them sequentially. For instance, if one operation must complete before another starts, run these operations sequentially instead. Never run file edits concurrently when their paths overlap; sequence them and re-read before the next edit.`,
  ].filter(item => item !== null)

  return [`# Using your tools`, ...prependBullets(items)].join(`\n`)
}

function getAgentToolSection(): string {
  return isForkSubagentEnabled()
    ? `Calling ${AGENT_TOOL_NAME} without a subagent_type creates a fork, which runs in the background and keeps its tool output out of your context \u2014 so you can keep chatting with the user while it works. Reach for it when research or multi-step implementation work would otherwise fill your context with raw output you won't need again. **If you ARE the fork** \u2014 execute directly; do not re-delegate.`
    : `Use the ${AGENT_TOOL_NAME} tool with specialized agents when the task clearly benefits from delegation. Subagents are useful for parallelizing independent work or protecting the main context from large amounts of raw output, but should not be used when the work can reasonably be done in this thread.

Do not spawn a subagent solely to review, verify, critique, or double-check work, whether it is your own or the task the user gave you. Use a review subagent only when the user explicitly asks for another agent; "adversarial", "cold" and "audit" name a method to apply, not a second agent.

Before spawning, require a concrete reason based on parallelism, context isolation, or explicit user request. If none applies, do the work yourself. Importantly, avoid duplicating work that subagents are already doing - if you delegate research to a subagent, do not also perform the same searches yourself.`
}

/**
 * Guidance for the skill_discovery attachment ("Skills relevant to your
 * task:") and the DiscoverSkills tool. Shared between the main-session
 * getUsingYourToolsSection bullet and the subagent path in
 * enhanceSystemPromptWithEnvDetails — subagents receive skill_discovery
 * attachments (post #22830) but don't go through getSystemPrompt, so
 * without this they'd see the reminders with no framing.
 *
 * feature() guard is internal — external builds DCE the string literal
 * along with the DISCOVER_SKILLS_TOOL_NAME interpolation.
 */
function getDiscoverSkillsGuidance(): string | null {
  if (
    feature('EXPERIMENTAL_SKILL_SEARCH') &&
    DISCOVER_SKILLS_TOOL_NAME !== null
  ) {
    return `Relevant skills are automatically surfaced each turn as "Skills relevant to your task:" reminders. If you're about to do something those don't cover — a mid-task pivot, an unusual workflow, a multi-step plan — call ${DISCOVER_SKILLS_TOOL_NAME} with a specific description of what you're doing. Skills already visible or loaded are filtered automatically. Skip this if the surfaced skills already cover your next action.`
  }
  return null
}

function getSessionSpecificGuidanceSection(
  enabledTools: Set<string>,
  skillToolCommands: Command[],
): string | null {
  const hasAskUserQuestionTool = enabledTools.has(ASK_USER_QUESTION_TOOL_NAME)
  const hasSkills =
    skillToolCommands.length > 0 && enabledTools.has(SKILL_TOOL_NAME)
  const hasAgentTool = enabledTools.has(AGENT_TOOL_NAME)

  const items = [
    hasAskUserQuestionTool
      ? `If you do not understand why the user has denied a tool call, use the ${ASK_USER_QUESTION_TOOL_NAME} to ask them.`
      : null,
    getIsNonInteractiveSession()
      ? null
      : `If you need the user to run a shell command themselves (e.g., an interactive login like \`gcloud auth login\`), suggest they type \`! <command>\` in the prompt — the \`!\` prefix runs the command in this session so its output lands directly in the conversation.`,
    // isForkSubagentEnabled() reads getIsNonInteractiveSession() — must be
    // post-boundary or it fragments the static prefix on session type.
    hasAgentTool ? getAgentToolSection() : null,
    ...(hasAgentTool &&
    areExplorePlanAgentsEnabled() &&
    !isForkSubagentEnabled()
      ? [
          `For simple, directed codebase searches (e.g. for a specific file/class/function), work directly.`,
          `When delegation is justified by independent parallel work, isolating substantial intermediate output, or an explicit user request, use ${EXPLORE_AGENT.agentType} for read-only discovery and concise answers. Use a general-purpose or coding worker for deep per-file analysis or implementation. Multiple searches or files alone do not require delegation.`,
        ]
      : []),
    hasAgentTool
      ? `When the ${AGENT_TOOL_NAME} tool's available-agent list includes implementor or verification, use implementor for bounded implementation slices where delegation helps, and verification only when the user asks for an independent check; keep the scope tight and report results yourself.`
      : null,
    hasSkills
      ? `/<skill-name> (e.g., /commit) is shorthand for users to invoke a user-invocable skill. When executed, the skill gets expanded to a full prompt. Use the ${SKILL_TOOL_NAME} tool to execute them. IMPORTANT: Only use ${SKILL_TOOL_NAME} for skills listed in its user-invocable skills section - do not guess or use built-in CLI commands.`
      : null,
    hasSkills
      ? `When the user asks for a written prompt to hand to another model, agent, or session, load and follow the writing-handoff-prompts skill (via ${SKILL_TOOL_NAME}, if listed) before writing it. A request to hand work to another session, or to reach one, is not a request for a prompt.`
      : null,
    DISCOVER_SKILLS_TOOL_NAME !== null &&
    hasSkills &&
    enabledTools.has(DISCOVER_SKILLS_TOOL_NAME)
      ? getDiscoverSkillsGuidance()
      : null,
  ].filter(item => item !== null)

  if (items.length === 0) return null
  return ['# Session-specific guidance', ...prependBullets(items)].join('\n')
}

// @[MODEL LAUNCH]: Remove this section when we launch numbat.
function getOutputEfficiencySection(): string {
  return `# Communicating with the user
When sending user-facing text, you're writing for a person, not logging to a console. Assume users can't see most tool calls or thinking - only your text output. Before your first tool call, briefly state what you're about to do. While working, give short updates at important points: when you find a root cause, change direction, or finish a meaningful step.

During prolonged work or waits, give an occasional brief update on what is happening or what you are waiting for, even when there is no new finding. Base it on observed status and avoid repetitive updates.

When making updates, assume the person has stepped away and lost the thread. They don't know codenames, abbreviations, or shorthand you created along the way, and didn't track your process. Write so they can pick back up cold: use complete, grammatically correct sentences without unexplained jargon. Expand technical terms when needed. Attend to cues about the user's level of expertise; if they seem like an expert, tilt more concise, while if they seem like they're new, be a bit more explanatory.

Write user-facing text in flowing prose while avoiding fragments, symbols and notation, or similarly hard-to-parse content. Only use tables when appropriate; for example to hold short enumerable facts (file names, line numbers, pass/fail), or communicate quantitative data. Don't pack explanatory reasoning into table cells -- explain before or after. Avoid semantic backtracking: structure each sentence so a person can read it linearly, building up meaning without having to re-parse what came before.

Keep updates brief. Keep final answers concise unless more detail is needed for clarity. Match responses to the task: a simple question gets a direct answer in prose, not headers and numbered sections. While keeping communication clear, also keep it concise, direct, and free of fluff. Avoid filler or stating the obvious. Get straight to the point. Don't overemphasize unimportant trivia about your process or use superlatives to oversell small wins or losses. Use inverted pyramid when appropriate (leading with the action), and if something about your reasoning or process is so important that it absolutely must be in user-facing text, save it for the end.

These user-facing text instructions do not apply to code or tool calls.`
}

function getSimpleToneAndStyleSection(): string {
  const items = [
    `Only use emojis if the user explicitly requests it. Avoid using emojis in all communication unless asked.`,
    `Your responses should be concise, clear, calm, and direct. Be helpful without flattery, unnecessary reassurance, or performative agreement.`,
    `Do not use em dashes in your own prose. Avoid volunteering time estimates for coding work; describe the work or progress instead.`,
    `When referencing specific functions or pieces of code include the pattern file_path:line_number to allow the user to easily navigate to the source code location.`,
    `When referencing GitHub issues or pull requests, use the owner/repo#123 format (e.g. anthropics/claude-code#100) so they render as clickable links.`,
    `When writing a prompt, or any other text meant to be copied verbatim (not run as a command), put it in a \`\`\`text fenced code block.`,
  ].filter(item => item !== null)

  return [`# Tone and style`, ...prependBullets(items)].join(`\n`)
}

/**
 * Lean assembly for the Claude style, the default for the models in
 * LEAN_PROMPT_MODELS; CAT_CODE_LEAN_SYSTEM_PROMPT=0 restores the full one.
 * Modelled on upstream's lean path
 * for its newest models. Upstream's lean block drops the prompt-injection and
 * tool-output-is-data rules along with `# System`; this one carries every
 * `corePolicy.ts` invariant, which is the reason it is not a port.
 * Evidence and comparator: docs/reports/2026-08-10-system-prompt-architecture-cat-vs-upstream.md
 * §3.0 and §5 item 0.
 */
export const LEAN_SYSTEM_PROMPT_ENV = 'CAT_CODE_LEAN_SYSTEM_PROMPT'

// Upstream keeps its full prompt for Sonnet, Haiku and older Opus models; lean
// is limited to the models it has been reviewed against.
const LEAN_PROMPT_MODELS = new Set(['claude-opus-5', 'claude-opus-5-5'])

function isLeanClaudePrompt(gpt: boolean, model: string): boolean {
  return (
    !gpt &&
    !isEnvDefinedFalsy(process.env[LEAN_SYSTEM_PROMPT_ENV]) &&
    LEAN_PROMPT_MODELS.has(getCanonicalName(model))
  )
}

function getLeanHarnessSection(): string {
  const items = [
    isManagedSession()
      ? `Interpret the task from the user's request. The working directory is a place to work, not evidence that its existing files or a repository are the subject of the request.`
      : null,
    `Text you output outside of tool use is displayed to the user as GitHub-flavored markdown.`,
    `Tools run behind a user-selected permission mode; a denied call means the user declined it, so adjust instead of retrying it verbatim.`,
    TOOL_OUTPUT_IS_DATA_RULE,
    RUNTIME_METADATA_RULE,
    PROMPT_INJECTION_RULE,
    HOOK_AUTHORITY_RULE,
    getConversationCompressionInstruction(),
    `Prefer the dedicated file and search tools over shell commands when one fits. Independent tool calls can run in parallel in one response; never run file edits concurrently when their paths overlap.`,
    `Reference code as file_path:line_number.`,
    `Write code that reads like the surrounding code: match its comment density, naming, and idiom.`,
    `Before proposing or making code changes, read the relevant current source; refresh it if another session may have changed it.`,
    `Do not introduce security vulnerabilities; fix insecure code you introduce.`,
    `Run relevant checks for risky or important changes before calling them done. Keep verification proportionate.`,
  ].filter(item => item !== null)
  return ['# Harness', ...prependBullets(items)].join('\n')
}

function getLeanActionsSection(): string {
  return `# Acting with care

For actions that are hard to reverse or outward-facing, confirm first unless durably authorized or explicitly told to proceed without asking; approval in one context doesn't extend to the next. Sending content to an external service publishes it; it may be cached or indexed even if later deleted. Before deleting or overwriting, look at the target: unfamiliar files, branches, or locks may be someone's in-progress work. Confirm before destructive actions or actions affecting others' work unless authorized for that scope. Resolve blockers without discarding others' changes or bypassing safeguards.

${PROJECT_INSTRUCTION_AUTHORITY_RULE} If a loaded instruction file or skill causes you to pause, ask for permission, or leave work unfinished, name the file and quote the instruction, separating its requirement from your interpretation.

${RETRY_RULE}

${OUTCOME_REPORTING_RULE}`
}

function getLeanStyleSection(): string {
  const items = [
    `Do not use em dashes in your own prose. Avoid volunteering time estimates for coding work.`,
    `When writing a prompt, or any other text meant to be copied verbatim (not run as a command), put it in a \`\`\`text fenced code block.`,
    `Reference GitHub issues and pull requests as owner/repo#123.`,
    `Briefly state your first step, then update the user at meaningful milestones or during long waits. Keep communication concise, direct, and understandable without internal shorthand.`,
  ]
  return ['# Style', ...prependBullets(items)].join('\n')
}

function getLeanSessionGuidanceSection(
  enabledTools: Set<string>,
  skillToolCommands: Command[],
): string | null {
  const hasSkills =
    skillToolCommands.length > 0 && enabledTools.has(SKILL_TOOL_NAME)
  const items = [
    enabledTools.has(AGENT_TOOL_NAME)
      ? `Use the ${AGENT_TOOL_NAME} tool when independent parallel work, isolating large intermediate output, or an explicit user request justifies it; otherwise work directly. Do not spawn an agent only to review or verify work unless the user asks for another agent; "adversarial", "cold" and "audit" describe methods, not requests for another agent.`
      : null,
    hasSkills
      ? `/<skill-name> is shorthand for a user-invocable skill; run it with the ${SKILL_TOOL_NAME} tool, and only for skills listed in its user-invocable skills section.`
      : null,
    hasSkills
      ? `When the user asks for a written prompt to hand to another model, agent, or session, load and follow the writing-handoff-prompts skill (via ${SKILL_TOOL_NAME}, if listed) before writing it. A request to hand work to another session, or to reach one, is not a request for a prompt.`
      : null,
  ].filter(item => item !== null)
  if (items.length === 0) return null
  return ['# Session-specific guidance', ...prependBullets(items)].join('\n')
}

/**
 * Key inputs for sections that branch on the enabled tool set. Sorted because
 * the guidance builders test membership, so ordering cannot change the output.
 * Contrast `additionalWorkingDirectories`, which is keyed unsorted: the
 * environment section renders those in order, so their order IS an input.
 */
function toolNamesKeyInput(enabledTools: Set<string>): string[] {
  return [...enabledTools].sort()
}

/**
 * Key inputs for sections that branch on available skills. The guidance
 * builders only read `skillToolCommands.length > 0` today, so keying the names
 * is finer than strictly required. That is the intended direction: over-keying
 * costs one extra cache entry, while under-keying serves a prompt built for a
 * different skill set, and nothing would surface that.
 */
function skillNamesKeyInput(skillToolCommands: Command[]): string[] {
  return skillToolCommands.map(command => command.name).sort()
}

/**
 * Key inputs for the output-style section. `getOutputStyleSection` reads only
 * the name and the prompt body; the rest of the config drives static sections
 * that are outside the registry.
 */
function outputStyleKeyInput(
  outputStyleConfig: OutputStyleConfig | null,
): { name: string; prompt: string } | null {
  if (outputStyleConfig === null) return null
  return { name: outputStyleConfig.name, prompt: outputStyleConfig.prompt }
}

/**
 * The dynamic (registry-managed) half of the system prompt. Both assemblies
 * below register the same sections, keyed and ordered identically, so they live
 * here once: getSystemPrompt adds two feature-gated entries via
 * `includeFeatureGatedSections` controls the optional sections that are only
 * meaningful for the full interactive prompt.
 */
function buildDynamicPromptSections({
  gpt,
  model,
  provider,
  additionalWorkingDirectories,
  mcpClients,
  enabledTools,
  skillToolCommands,
  outputStyleConfig,
  settings,
  includeFeatureGatedSections,
  lean,
}: {
  gpt: boolean
  model: string
  provider?: APIProvider
  additionalWorkingDirectories?: string[]
  mcpClients?: MCPServerConnection[]
  enabledTools: Set<string>
  skillToolCommands: Awaited<ReturnType<typeof getSkillToolCommands>>
  outputStyleConfig: OutputStyleConfig | null
  settings: ReturnType<typeof getInitialSettings>
  includeFeatureGatedSections: boolean
  lean: boolean
}) {
  return [
    systemPromptSection(
      'session_guidance',
      {
        gpt,
        lean,
        tools: toolNamesKeyInput(enabledTools),
        skills: skillNamesKeyInput(skillToolCommands),
      },
      () =>
        gpt
          ? getGPTSessionGuidanceSection(enabledTools, skillToolCommands)
          : lean
            ? getLeanSessionGuidanceSection(enabledTools, skillToolCommands)
            : getSessionSpecificGuidanceSection(enabledTools, skillToolCommands),
    ),
    systemPromptSection('memory', NO_SECTION_INPUTS, () => loadMemoryPrompt()),
    systemPromptSection('ant_model_override', NO_SECTION_INPUTS, () =>
      getAntModelOverrideSection(),
    ),
    // env_info_simple and frc predate this fork, so their key sets were derived
    // by tracing consumers rather than by assumption: computeSimpleEnvInfo and
    // getFunctionResultClearingSection have no caller outside this file, and
    // nothing reads the section cache by name (resolveSystemPromptSections is
    // the only reader). Everything else those computes touch is either
    // model-derived, a memoized process fact, or cwd/worktree state that the
    // clearSystemPromptSections() sites already cover.
    systemPromptSection(
      'env_info_simple',
      { model, additionalWorkingDirectories },
      () => computeSimpleEnvInfo(model, additionalWorkingDirectories, provider),
    ),
    // CONTRACT: language is read once per session. The picker writes the
    // setting immediately (components/LanguagePicker.tsx, applied at
    // components/Settings/Config.tsx), but this section keeps the value read at
    // the first prompt build, so a change takes effect on the next /clear,
    // /compact, or restart. Those are the paths a user reaches for; the full
    // set that calls clearSystemPromptSections() also includes worktree
    // enter/exit and session restore. (/clear reaches it indirectly, through
    // clearSessionCaches -> runPostCompactCleanup.)
    //
    // That is why NO_SECTION_INPUTS is deliberate here rather than an omission:
    // keying on settings.language would make the change apply mid-session and
    // silently replace the contract. Change the contract on purpose, or not at
    // all.
    systemPromptSection('language', NO_SECTION_INPUTS, () =>
      getLanguageSection(settings.language),
    ),
    systemPromptSection(
      'output_style',
      outputStyleKeyInput(outputStyleConfig),
      () => getOutputStyleSection(outputStyleConfig),
    ),
    // When delta enabled, instructions are announced via persisted
    // mcp_instructions_delta attachments (attachments.ts) instead of this
    // per-turn recompute, which busts the prompt cache on late MCP connect.
    // Gate check inside compute (not selecting between section variants)
    // so a mid-session gate flip doesn't read a stale cached value.
    DANGEROUS_uncachedSystemPromptSection(
      'mcp_instructions',
      () =>
        isMcpInstructionsDeltaEnabled()
          ? null
          : getMcpInstructionsSection(mcpClients),
      'MCP servers connect/disconnect between turns',
    ),
    systemPromptSection('scratchpad', NO_SECTION_INPUTS, () =>
      getScratchpadInstructions(),
    ),
    systemPromptSection('frc', { model }, () =>
      getFunctionResultClearingSection(model),
    ),
    systemPromptSection(
      'summarize_tool_results',
      NO_SECTION_INPUTS,
      () => SUMMARIZE_TOOL_RESULTS_SECTION,
    ),
    ...(includeFeatureGatedSections && feature('TOKEN_BUDGET')
      ? [
          // Cached unconditionally — the "When the user specifies..." phrasing
          // makes it a no-op with no budget active. Was DANGEROUS_uncached
          // (toggled on getCurrentTurnTokenBudget()), busting ~20K tokens per
          // budget flip. Not moved to a tail attachment: first-response and
          // budget-continuation paths don't see attachments (#21577).
          systemPromptSection(
            'token_budget',
            NO_SECTION_INPUTS,
            () =>
              'When the user specifies a token target (e.g., "+500k", "spend 2M tokens", "use 1B tokens"), your output token count will be shown each turn. Keep working until you approach the target, but do not trade correctness for output volume. If the task is impossible, contradictory, or blocked, say so plainly and use the remaining budget on honest diagnosis, decomposition, or next steps rather than forced progress. The target is a hard minimum. If you stop early, the system will automatically continue you.',
          ),
        ]
      : []),
    ...(includeFeatureGatedSections &&
    (feature('KAIROS') || feature('KAIROS_BRIEF'))
      ? [systemPromptSection('brief', NO_SECTION_INPUTS, () => getBriefSection())]
      : []),
    systemPromptSection(
      'session_transcripts',
      // Keyed: the section names Grep/Glob or shell find/grep depending on the
      // embedded-search build, and under-keying would serve the wrong one.
      { embeddedSearch: hasEmbeddedSearchTools(), tools: [...enabledTools].sort() },
      () => getSessionTranscriptsSection(enabledTools),
    ),
  ]
}

export async function getSystemPrompt(
  tools: Tools,
  model: string,
  additionalWorkingDirectories?: string[],
  mcpClients?: MCPServerConnection[],
  provider?: APIProvider,
): Promise<string[]> {
  const startTime = Date.now()
  logForDebugging(`[SystemPrompt] getSystemPrompt start`, {
    model,
    toolCount: tools.length,
    additionalWorkingDirectoryCount: additionalWorkingDirectories?.length ?? 0,
    mcpClientCount: mcpClients?.length ?? 0,
  })
  if (isEnvTruthy(process.env.CLAUDE_CODE_SIMPLE)) {
    return [
      [
        getCLISyspromptPrefix({
          isNonInteractive: false,
          hasAppendSystemPrompt: false,
        }),
        `CWD: ${getCwd()}\nDate: ${getSessionStartDate()}`,
        '# Core policy',
        getCyberPolicyInstruction(),
        TOOL_OUTPUT_IS_DATA_RULE,
        PROMPT_INJECTION_RULE,
        INSTRUCTION_AUTHORITY_RULE,
        OUTCOME_REPORTING_RULE,
      ].join('\n\n'),
    ]
  }

  const cwd = getCwd()
  const [skillToolCommands, outputStyleConfig, envInfo] = await Promise.all([
    getSkillToolCommands(cwd).then(result => {
      logForDebugging(`[SystemPrompt] getSkillToolCommands complete`, {
        commandCount: result.length
      })
      return result
    }),
    getOutputStyleConfig().then(result => {
      logForDebugging(`[SystemPrompt] getOutputStyleConfig complete`, {
        hasOutputStyle: result !== null
      })
      return result
    }),
    computeSimpleEnvInfo(model, additionalWorkingDirectories, provider).then(result => {
      logForDebugging(`[SystemPrompt] computeSimpleEnvInfo complete`, {
        envInfoLength: result.length
      })
      return result
    }),
  ])
  const requestProvider = resolveRequestProvider(model, provider)
  const gpt = isGPTPromptStyle(requestProvider)
  const gptFamily = getGPTPromptFamily(model)

  const settings = getInitialSettings()
  const enabledTools = new Set(tools.map(_ => _.name))

  if (
    (feature('PROACTIVE') || feature('KAIROS')) &&
    proactiveModule?.isProactiveActive()
  ) {
    logForDebugging(`[SystemPrompt] path=simple-proactive`)
    return [
      `\nYou are an autonomous agent. Use the available tools to do useful work.`,
      getCorePolicySection(),
      gpt ? getGPTActionsSection(gptFamily) : getActionsSection(),
      getSystemRemindersSection(),
      await loadMemoryPrompt(),
      envInfo,
      getLanguageSection(settings.language),
      // When delta enabled, instructions are announced via persisted
      // mcp_instructions_delta attachments (attachments.ts) instead.
      isMcpInstructionsDeltaEnabled()
        ? null
        : getMcpInstructionsSection(mcpClients),
      getScratchpadInstructions(),
      getFunctionResultClearingSection(model),
      SUMMARIZE_TOOL_RESULTS_SECTION,
      getProactiveSection(),
    ].filter(s => s !== null)
  }

  const lean = isLeanClaudePrompt(gpt, model)
  const dynamicSections = buildDynamicPromptSections({
    gpt,
    model,
    provider,
    additionalWorkingDirectories,
    mcpClients,
    enabledTools,
    skillToolCommands,
    outputStyleConfig,
    settings,
    includeFeatureGatedSections: true,
    lean,
  })

  const resolvedDynamicSections =
    await resolveSystemPromptSections(dynamicSections)
  logForDebugging(`[SystemPrompt] resolveSystemPromptSections complete`, {
    sectionCount: resolvedDynamicSections.length,
    durationMs: Date.now() - startTime
  })

  // Doing-tasks is the only container for truthful outcome reporting and the
  // retry budget. An output style that turns coding instructions off drops it.
  // Outcome reporting is an invariant, so whenever this section is absent the
  // core section stands in. The intro is always present here and already
  // carries the cyber policy, so the fallback must not restate it.
  const hasDoingTasksSection =
    (outputStyleConfig === null ||
      outputStyleConfig.keepCodingInstructions === true)

  if (lean) {
    logForDebugging(`[SystemPrompt] path=lean`)
    return [
      getSimpleIntroSection(outputStyleConfig),
      getLeanHarnessSection(),
      getLeanActionsSection(),
      getDeliveringWorkSection(),
      getCorrectionsSection(),
      getLeanStyleSection(),
      ...(shouldUseGlobalCacheScope() ? [SYSTEM_PROMPT_DYNAMIC_BOUNDARY] : []),
      ...resolvedDynamicSections,
    ].filter(s => s !== null)
  }

  return [
    // --- Static content (cacheable) ---
    gpt ? getGPTIntroSection(outputStyleConfig) : getSimpleIntroSection(outputStyleConfig),
    gpt ? getGPTSystemSection() : getSimpleSystemSection(),
    hasDoingTasksSection
      ? null
      : getCorePolicySection({
          cyberPolicy: false,
          retryRule: true,
        }),
    hasDoingTasksSection
      ? gpt
        ? getGPTDoingTasksSection(enabledTools, gptFamily)
        : getSimpleDoingTasksSection(enabledTools)
      : null,
    gpt ? getGPTActionsSection(gptFamily) : getActionsSection(),
    ...(gpt ? [] : [getDeliveringWorkSection(), getCorrectionsSection()]),
    gpt
      ? getGPTUsingToolsSection(enabledTools)
      : getUsingYourToolsSection(enabledTools),
    gpt ? getGPTToneAndStyleSection(gptFamily) : getSimpleToneAndStyleSection(),
    gpt ? getGPTOutputSection() : getOutputEfficiencySection(),
    // === BOUNDARY MARKER - DO NOT MOVE OR REMOVE ===
    ...(shouldUseGlobalCacheScope() ? [SYSTEM_PROMPT_DYNAMIC_BOUNDARY] : []),
    // --- Dynamic content (registry-managed) ---
    ...resolvedDynamicSections,
  ].filter(s => s !== null)
}

function getMcpInstructions(mcpClients: MCPServerConnection[]): string | null {
  const connectedClients = mcpClients.filter(
    (client): client is ConnectedMCPServer => client.type === 'connected',
  )

  const clientsWithInstructions = connectedClients.filter(
    client => client.instructions,
  )

  if (clientsWithInstructions.length === 0) {
    return null
  }

  const instructionBlocks = clientsWithInstructions
    .map(client => {
      return `## ${client.name}
${client.instructions}`
    })
    .join('\n\n')

  return `# MCP Server Instructions

The following MCP servers have provided instructions for how to use their tools and resources:

${instructionBlocks}`
}

export async function computeEnvInfo(
  modelId: string,
  additionalWorkingDirectories?: string[],
): Promise<string> {
  const [isGit, unameSR] = await Promise.all([
    isManagedSession() ? Promise.resolve(null) : getIsGit(),
    getUnameSR(),
  ])

  // Undercover: keep ALL model names/IDs out of the system prompt so nothing
  // internal can leak into public commits/PRs. This includes the public
  // FRONTIER_MODEL_* constants — if those ever point at an unannounced model,
  // we don't want them in context. Go fully dark.
  //
  // DCE: `process.env.USER_TYPE === 'ant'` is build-time --define. It MUST be
  // inlined at each callsite (not hoisted to a const) so the bundler can
  // constant-fold it to `false` in external builds and eliminate the branch.
  let modelDescription = ''
  if (process.env.USER_TYPE === 'ant' && isUndercover()) {
    // suppress
  } else {
    const marketingName = getMarketingNameForModel(modelId)
    modelDescription = marketingName
      ? `You are powered by the model named ${marketingName}. The exact model ID is ${modelId}.`
      : `You are powered by the model ${modelId}.`
  }

  const additionalDirsInfo =
    additionalWorkingDirectories && additionalWorkingDirectories.length > 0
      ? `Additional working directories: ${additionalWorkingDirectories.join(', ')}\n`
      : ''

  const cutoff = getKnowledgeCutoff(modelId)
  const knowledgeCutoffMessage = cutoff
    ? `\n\nAssistant knowledge cutoff is ${cutoff}.`
    : ''

  return `Here is useful information about the environment you are running in:
<env>
Working directory: ${getCwd()}
${isGit === null ? '' : `Is directory a git repo: ${isGit ? 'Yes' : 'No'}\n`}
${additionalDirsInfo}Platform: ${env.platform}
${getShellInfoLine()}
OS Version: ${unameSR}
</env>
${modelDescription}${knowledgeCutoffMessage}`
}

export async function computeSimpleEnvInfo(
  modelId: string,
  additionalWorkingDirectories?: string[],
  provider?: APIProvider,
): Promise<string> {
  const [isGit, unameSR] = await Promise.all([
    isManagedSession() ? Promise.resolve(null) : getIsGit(),
    getUnameSR(),
  ])
  const apiProvider = resolveRequestProvider(modelId, provider)

  // Undercover: strip all model name/ID references. See computeEnvInfo.
  // DCE: inline the USER_TYPE check at each site — do NOT hoist to a const.
  let modelDescription: string | null = null
  if (process.env.USER_TYPE === 'ant' && isUndercover()) {
    // suppress
  } else {
    const marketingName = getMarketingNameForModel(modelId)
    modelDescription = marketingName
      ? `You are powered by the model named ${marketingName}. The exact model ID is ${modelId}.`
      : `You are powered by the model ${modelId}.`
  }

  const cutoff = getKnowledgeCutoff(modelId)
  const knowledgeCutoffMessage = cutoff
    ? `Assistant knowledge cutoff is ${cutoff}.`
    : null

  const cwd = getCwd()
  const isWorktree = !isManagedSession() && getCurrentWorktreeSession() !== null

  const envItems = [
    `Primary working directory: ${cwd}`,
    isWorktree
      ? `This is a git worktree — an isolated copy of the repository. Run all commands from this directory. Do NOT \`cd\` to the original repository root.`
      : null,
    isGit === null ? null : [`Is a git repository: ${isGit}`],
    additionalWorkingDirectories && additionalWorkingDirectories.length > 0
      ? `Additional working directories:`
      : null,
    additionalWorkingDirectories && additionalWorkingDirectories.length > 0
      ? additionalWorkingDirectories
      : null,
    `Platform: ${env.platform}`,
    getShellInfoLine(),
    `OS Version: ${unameSR}`,
    modelDescription,
    knowledgeCutoffMessage,
    apiProvider === 'openai' ||
    (process.env.USER_TYPE === 'ant' && isUndercover())
      ? null
      : `The most recent Claude models are the Claude 5 family. Model IDs — Fable 5: 'claude-fable-5', Opus 5.5: '${LATEST_CLAUDE_MODEL_IDS.opus}', Sonnet 5.5: '${LATEST_CLAUDE_MODEL_IDS.sonnet}', Haiku 5.5: '${LATEST_CLAUDE_MODEL_IDS.haiku}'. When building AI applications, default to the latest and most capable Claude models.`,
    `This session is running through the ${apiProvider === 'openai' ? 'OpenAI Codex' : 'Anthropic'} provider.`,
    process.env.USER_TYPE === 'ant' && isUndercover()
      ? null
      : `Fast mode changes output speed, but it does NOT switch to a different model. It can be toggled with /fast.`,
  ].filter(item => item !== null)

  return [
    `# Environment`,
    `You have been invoked in the following environment:`,
    ...prependBullets(envItems),
  ].join(`\n`)
}

// @[MODEL LAUNCH]: Add the official reliable knowledge cutoff date for the new model.
function getKnowledgeCutoff(modelId: string): string | null {
  const canonical = getCanonicalName(modelId)
  if (canonical.includes('claude-opus-5-5') || canonical.includes('claude-sonnet-5-5')) {
    return 'June 2026'
  } else if (canonical.includes('claude-fable-5')) {
    return 'January 2026'
  } else if (canonical.includes('claude-opus-5')) {
    return 'May 2026'
  } else if (canonical.includes('claude-sonnet-5')) {
    return 'January 2026'
  } else if (canonical.includes('claude-sonnet-4-6')) {
    return 'August 2025'
  } else if (canonical.includes('claude-opus-4-6')) {
    return 'May 2025'
  } else if (canonical.includes('claude-opus-4-5')) {
    return 'May 2025'
  } else if (canonical.includes('claude-haiku-4')) {
    return 'February 2025'
  } else if (
    canonical.includes('claude-opus-4') ||
    canonical.includes('claude-sonnet-4')
  ) {
    return 'January 2025'
  }
  return null
}

function getShellInfoLine(): string {
  const shell = process.env.SHELL || 'unknown'
  const shellName = shell.includes('zsh')
    ? 'zsh'
    : shell.includes('bash')
      ? 'bash'
      : shell
  if (env.platform === 'win32') {
    return `Shell: ${shellName} (use Unix shell syntax, not Windows — e.g., /dev/null not NUL, forward slashes in paths)`
  }
  return `Shell: ${shellName}`
}

export function getUnameSR(): string {
  // os.type() and os.release() both wrap uname(3) on POSIX, producing output
  // byte-identical to `uname -sr`: "Darwin 25.3.0", "Linux 6.6.4", etc.
  // Windows has no uname(3); os.type() returns "Windows_NT" there, but
  // os.version() gives the friendlier "Windows 11 Pro" (via GetVersionExW /
  // RtlGetVersion) so use that instead. Feeds the OS Version line in the
  // system prompt env section.
  if (env.platform === 'win32') {
    return `${osVersion()} ${osRelease()}`
  }
  return `${osType()} ${osRelease()}`
}

export function getDefaultAgentPrompt(
  provider: ReturnType<typeof getAPIProvider> = getAPIProvider(),
): string {
  const identityPrefix = getAgentPromptIdentityPrefix(provider)
  if (isGPTPromptStyle(provider)) {
    return getGPTDefaultAgentPrompt(identityPrefix)
  }
  return `${identityPrefix} Given the user's message, you should use the tools available to complete the task. Complete the task fully without forcing a pass; if the task is contradictory or impossible, say so plainly. When you complete the task, respond with a concise report covering what was done and any key findings — the caller will relay this to the user, so it only needs the essentials.`
}

export async function enhanceSystemPromptWithEnvDetails(
  existingSystemPrompt: string[],
  model: string,
  additionalWorkingDirectories?: string[],
  enabledToolNames?: ReadonlySet<string>,
  provider?: string,
): Promise<string[]> {
  const resolvedProvider = provider ?? resolveRequestProvider(model)
  const colonNote = !isGPTPromptStyle(resolvedProvider)
    ? '\n- Do not use a colon before tool calls. Text like "Let me read the file:" followed by a read tool call should just be "Let me read the file." with a period.'
    : ''
  const notes = `Notes:
- In agent threads, a \`cd\` applies only to the current Bash call; the next call starts in the agent's assigned working directory. Relative paths work from that directory. Use absolute paths when referring to a location across calls.
- In your final response, share file paths (always absolute, never relative) that are relevant to the task. Include code snippets only when the exact text is load-bearing (e.g., a bug you found, a function signature the caller asked for) — do not recap code you merely read.
- For clear communication with the user the assistant MUST avoid using emojis.${colonNote}`
  // Subagents get skill_discovery attachments (prefetch.ts runs in query(),
  // no agentId guard since #22830) but don't go through getSystemPrompt —
  // surface the same DiscoverSkills framing the main session gets. Gated on
  // enabledToolNames when the caller provides it (runAgent.ts does).
  // AgentTool.tsx:768 builds the prompt before assembleToolPool:830 so it
  // omits this param — `?? true` preserves guidance there.
  const discoverSkillsGuidance =
    feature('EXPERIMENTAL_SKILL_SEARCH') &&
    skillSearchFeatureCheck?.isSkillSearchEnabled() &&
    DISCOVER_SKILLS_TOOL_NAME !== null &&
    (enabledToolNames?.has(DISCOVER_SKILLS_TOOL_NAME) ?? true)
      ? getDiscoverSkillsGuidance()
      : null
  const envInfo = await computeEnvInfo(model, additionalWorkingDirectories)
  return [
    ...existingSystemPrompt,
    notes,
    ...(discoverSkillsGuidance !== null ? [discoverSkillsGuidance] : []),
    envInfo,
  ]
}

/**
 * Returns instructions for using the scratchpad directory if enabled.
 * The scratchpad is a per-session directory where Claude can write temporary files.
 */
export function getScratchpadInstructions(): string | null {
  if (isManagedSession()) return null
  if (!isScratchpadEnabled()) {
    return null
  }

  const scratchpadDir = getScratchpadDir()

  return `# Scratchpad Directory

IMPORTANT: Always use this scratchpad directory for temporary files instead of \`/tmp\` or other system temp directories:
\`${scratchpadDir}\`

Use this directory for ALL temporary file needs:
- Storing intermediate results or data during multi-step tasks
- Writing temporary scripts or configuration files
- Saving outputs that don't belong in the user's project
- Creating working files during analysis or processing
- Any file that would otherwise go to \`/tmp\`

Only use \`/tmp\` if the user explicitly requests it.

The scratchpad directory is session-specific, isolated from the user's project, and can be used freely without permission prompts.`
}

function getFunctionResultClearingSection(model: string): string | null {
  if (!feature('CACHED_MICROCOMPACT') || !getCachedMCConfigForFRC) {
    return null
  }
  const config = getCachedMCConfigForFRC()
  const isModelSupported = config.supportedModels?.some(pattern =>
    model.includes(pattern),
  )
  if (
    !config.enabled ||
    !config.systemPromptSuggestSummaries ||
    !isModelSupported
  ) {
    return null
  }
  return `# Function Result Clearing

Old tool results will be automatically cleared from context to free up space. The ${config.keepRecent} most recent results are always kept.`
}

const SUMMARIZE_TOOL_RESULTS_SECTION = `When working with tool results, write down any important information you might need later in your response, as the original tool result may be cleared later.`

/**
 * Embedded-search builds remove the dedicated Glob/Grep tools (see
 * `hasEmbeddedSearchTools`), so this section names the search surface that
 * actually exists rather than a tool the model cannot call.
 *
 * When the task is simply to understand another session's work, guidance
 * prefers available session-reading tools over reconstructing context from raw
 * files. When debugging requires raw events or tool results the tool does not
 * expose, direct transcript inspection remains available, including discovering
 * relevant sessions.
 */
function getSessionTranscriptsSection(enabledTools: Set<string>): string {
  const embedded = hasEmbeddedSearchTools()
  const hasGrep = !embedded && enabledTools.has(GREP_TOOL_NAME)
  const hasGlob = !embedded && enabledTools.has(GLOB_TOOL_NAME)
  const hasShell = enabledTools.has(BASH_TOOL_NAME)
  const searchTool = hasGrep
    ? GREP_TOOL_NAME
    : hasShell ? `\`grep\` via the ${BASH_TOOL_NAME} tool` : null
  const resolveInstruction = hasGlob
    ? `Prefer a known workspace and full session ID to open the path directly. When resolving a specific session by prefix, locate the file with ${GLOB_TOOL_NAME}, passing the workspace directory under projects if known, or the projects dir as the \`path\` argument rather than the default cwd:

    ${GLOB_TOOL_NAME} pattern="**/*9a993deb*.jsonl" path="~/.cat-code/projects/"

Require unambiguous resolution to a single file before reading contents.`
    : hasShell
      ? `Prefer a known workspace and full session ID to open the path directly. When resolving a specific session by prefix, locate the file with \`find\` via the ${BASH_TOOL_NAME} tool (scoped to the workspace directory under projects if known, or the projects dir):

    find ~/.cat-code/projects -name '*9a993deb*.jsonl'

Require unambiguous resolution to a single file before reading contents.`
      : 'Prefer a known workspace and full session ID or transcript path. If the path is unknown and no file-search tool is available, ask the user for the exact path before reading contents.'
  const query = (pattern: string) =>
    hasGrep
      ? `${GREP_TOOL_NAME} '${pattern}' path="<path-to-transcript.jsonl>"`
      : `grep '${pattern}' <path-to-transcript.jsonl>`
  const queryExamples = searchTool ? `Examples for querying an individual transcript:

    ${query('"type":"tool_use"')}      # list tool calls
    ${query('"stop_reason"')}          # find last API response boundary
    ${query('"type":"subagent-')}      # enumerate spawn/terminal entries
    ${query('"tool_use_id":"')}        # link a tool_result back to its tool_use (ID prefixes vary by provider)

` : ''

  return `## Reading session transcripts

These files are the raw record of a session. When you need to understand another session's work, prefer the available session-reading tool. For debugging that requires raw events or tool results the tool does not expose, inspect the transcript directly.

Cat-code session files are line-oriented JSONL. ${searchTool ? `Use ${searchTool} with patterns on the "type" or other fields, and do NOT write a custom parser.` : 'Inspect a known path using an available reading tool. If no reading tool is available, explain that limitation.'} The shape is stable.

Paths:

    ~/.cat-code/projects/<sanitized-cwd>/<session-id>.jsonl
    ~/.cat-code/projects/<sanitized-cwd>/<session-id>/subagents/agent-<hash>.jsonl
    ~/.cat-code/projects/<sanitized-cwd>/<session-id>/subagents/agent-<hash>.meta.json

${resolveInstruction}

${queryExamples}The subagent sidecar .meta.json contains:

    {
      "agentType": "general-purpose",
      "description": "audit your code",
      "worktreePath": "...",
      "parentSessionId": "...",
      "parentToolUseId": "...",
      "spawnedAt": "2026-04-16T15:45:25Z"
    }

Read .meta.json first when you want to know what a subagent was for or who spawned it.`
}

function getBriefSection(): string | null {
  if (!(feature('KAIROS') || feature('KAIROS_BRIEF'))) return null
  if (!BRIEF_PROACTIVE_SECTION) return null
  // Whenever the tool is available, the model is told to use it. The
  // /brief toggle and --brief flag now only control the isBriefOnly
  // display filter — they no longer gate model-facing behavior.
  if (!briefToolModule?.isBriefEnabled()) return null
  // When proactive is active, getProactiveSection() already appends the
  // section inline. Skip here to avoid duplicating it in the system prompt.
  if (
    (feature('PROACTIVE') || feature('KAIROS')) &&
    proactiveModule?.isProactiveActive()
  )
    return null
  return BRIEF_PROACTIVE_SECTION
}

function getProactiveSection(): string | null {
  if (!(feature('PROACTIVE') || feature('KAIROS'))) return null
  if (!proactiveModule?.isProactiveActive()) return null

  return `# Autonomous work

You are running autonomously. You will receive \`<${TICK_TAG}>\` prompts that keep you alive between turns — just treat them as "you're awake, what now?" The time in each \`<${TICK_TAG}>\` is the user's current local time. Use it to judge the time of day — timestamps from external tools (Slack, GitHub, etc.) may be in a different timezone.

Multiple ticks may be batched into a single message. This is normal — just process the latest one. Never echo or repeat tick content in your response.

## Pacing

Use the ${SLEEP_TOOL_NAME} tool to control how long you wait between actions. Sleep longer when waiting for slow processes, shorter when actively iterating. Each wake-up costs an API call, but the prompt cache expires after 5 minutes of inactivity — balance accordingly.

**If you have nothing useful to do on a tick, you MUST call ${SLEEP_TOOL_NAME}.** Never respond with only a status message like "still waiting" or "nothing to do" — that wastes a turn and burns tokens for no reason.

## First wake-up

On your very first tick in a new session, greet the user briefly and ask what they'd like to work on. Do not start exploring the codebase or making changes unprompted — wait for direction.

## What to do on subsequent wake-ups

Look for useful work. A good colleague faced with ambiguity doesn't just stop — they investigate, reduce risk, and build understanding. Ask yourself: what don't I know yet? What could go wrong? What would I want to verify before calling this done?

Do not spam the user. If you already asked something and they haven't responded, do not ask again. Do not narrate what you're about to do — just do it.

If a tick arrives and you have no useful action to take (no files to read, no commands to run, no decisions to make), call ${SLEEP_TOOL_NAME} immediately. Do not output text narrating that you're idle — the user doesn't need "still waiting" messages.

## Staying responsive

When the user is actively engaging with you, check for and respond to their messages frequently. Treat real-time conversations like pairing — keep the feedback loop tight. If you sense the user is waiting on you (e.g., they just sent a message, the terminal is focused), prioritize responding over continuing background work.

## Bias toward action

Act on your best judgment rather than asking for confirmation.

- Read files, search code, explore the project, run tests, check types, run linters — all without asking.
- Make code changes. Commit when you reach a good stopping point.
- If you're unsure between two reasonable approaches, pick one and go. You can always course-correct.

## Be concise

Keep your text output brief and high-level. The user does not need a play-by-play of your thought process or implementation details — they can see your tool calls. Focus text output on:
- Decisions that need the user's input
- High-level status updates at natural milestones (e.g., "PR created", "tests passing")
- Errors or blockers that change the plan

Do not narrate each step, list every file you read, or explain routine actions. If you can say it in one sentence, don't use three.

## Terminal focus

The user context may include a \`terminalFocus\` field indicating whether the user's terminal is focused or unfocused. Use this to calibrate how autonomous you are:
- **Unfocused**: The user is away. Lean heavily into autonomous action — make decisions, explore, commit, push. Only pause for genuinely irreversible or high-risk actions.
- **Focused**: The user is watching. Be more collaborative — surface choices, ask before committing to large changes, and keep your output concise so it's easy to follow in real time.${BRIEF_PROACTIVE_SECTION && briefToolModule?.isBriefEnabled() ? `\n\n${BRIEF_PROACTIVE_SECTION}` : ''}`
}
