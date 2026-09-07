import { spawn, type SpawnOptionsWithoutStdio } from 'child_process'
import { realpath } from 'fs/promises'
import { basename, resolve } from 'path'
import React from 'react'
import type { Readable } from 'stream'
import { z } from 'zod/v4'
import { MessageResponse } from '../../components/MessageResponse.js'
import { Box, Text } from '../../ink.js'
import { buildTool, type ToolDef, type ToolUseContext } from '../../Tool.js'
import { pwd } from '../../utils/cwd.js'
import { errorMessage } from '../../utils/errors.js'
import { expandPath } from '../../utils/path.js'
import { killProcessTree, registerDelegatedChild } from '../../utils/processTree.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { jsonStringify } from '../../utils/slowOperations.js'
import { subprocessEnv } from '../../utils/subprocessEnv.js'
import { resolveWorkerCapabilities } from '../../utils/agentCapabilities.js'
import { CLAUDE_CLI_TOOL_NAME } from './constants.js'
import { DESCRIPTION, PROMPT } from './prompt.js'

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000
const MAX_INLINE_OUTPUT_CHARS = 30_000
const MAX_DISPLAY_OUTPUT_CHARS = 4_000
const FORBIDDEN_EXECUTABLE_BASENAMES = new Set(['cat-code', 'cli', 'cli-dev'])
const CAT_CODE_EXECUTABLE_ERROR =
  'CLAUDE_CLI_PATH must point to the external Claude CLI, not a Cat Code executable.'

const effortValues = ['low', 'medium', 'high', 'xhigh', 'max'] as const
const permissionModeValues = [
  'default',
  'acceptEdits',
  'plan',
  'auto',
  'dontAsk',
  'bypassPermissions',
] as const

const inputSchema = lazySchema(() =>
  z.strictObject({
    prompt: z
      .string()
      .min(1)
      .describe('Self-contained task prompt to send to the external Claude CLI.'),
    cwd: z
      .string()
      .optional()
      .describe('Optional working directory for the Claude CLI process.'),
    model: z
      .string()
      .min(1)
      .optional()
      .describe('Optional Claude CLI model alias or full model name.'),
    effort: z
      .enum(effortValues)
      .optional()
      .describe('Optional Claude CLI effort level.'),
    max_turns: z
      .number()
      .int()
      .positive()
      .optional()
      .describe('Optional maximum number of agentic turns for Claude CLI.'),
    permission_mode: z
      .enum(permissionModeValues)
      .optional()
      .describe('Optional Claude CLI permission mode for the delegated run.'),
    timeout: z
      .number()
      .int()
      .positive()
      .optional()
      .describe(`Optional timeout in milliseconds. Defaults to ${DEFAULT_TIMEOUT_MS}.`),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>
type Input = z.infer<InputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    status: z
      .enum(['success', 'failed', 'timeout', 'interrupted'])
      .describe('Execution status for the external Claude CLI process.'),
    exit_code: z.number().nullable().describe('Claude CLI process exit code.'),
    stdout: z.string().describe('Captured stdout from Claude CLI.'),
    stderr: z.string().describe('Captured stderr from Claude CLI.'),
    result: z.string().optional().describe('Parsed Claude CLI result text, when available.'),
    session_id: z.string().optional().describe('Claude CLI session ID, when available.'),
    is_error: z
      .boolean()
      .optional()
      .describe('Claude CLI JSON is_error flag, when provided.'),
    model: z.string().optional().describe('Requested model, when provided.'),
    effort: z.enum(effortValues).optional().describe('Requested effort, when provided.'),
    cwd: z.string().describe('Working directory used for Claude CLI.'),
    elapsed_ms: z.number().describe('Elapsed execution time in milliseconds.'),
    truncated: z.boolean().describe('Whether stdout or stderr was truncated.'),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>
export type ClaudeCliToolOutput = z.infer<OutputSchema>

type ClaudeCliCommand = {
  executable: string
  args: string[]
  cwd: string
  timeoutMs: number
}

type CapturedOutput = {
  text: string
  omittedChars: number
}

type ClaudeCliChildProcess = {
  stdout?: Readable | null
  stderr?: Readable | null
  /** Undefined until the spawn succeeds, and after the process is reaped. */
  readonly pid?: number | undefined
  once(event: 'close', listener: (code: number | null, signal: NodeJS.Signals | null) => void): unknown
  once(event: 'error', listener: (error: Error) => void): unknown
  kill(signal?: NodeJS.Signals): boolean
}

type ClaudeCliSpawn = (
  executable: string,
  args: string[],
  options: SpawnOptionsWithoutStdio,
) => ClaudeCliChildProcess

function getClaudeCliExecutable(): string {
  return process.env.CLAUDE_CLI_PATH?.trim() || 'claude'
}

function buildClaudeCliCommand(input: Input): ClaudeCliCommand {
  const args = ['-p', '--output-format', 'json']
  if (input.model) args.push('--model', input.model)
  if (input.effort) args.push('--effort', input.effort)
  if (input.max_turns !== undefined) args.push('--max-turns', String(input.max_turns))
  if (input.permission_mode) {
    args.push('--permission-mode', input.permission_mode)
  }
  args.push(input.prompt)

  return {
    executable: getClaudeCliExecutable(),
    args,
    cwd: input.cwd ? expandPath(input.cwd) : pwd(),
    timeoutMs: input.timeout ?? DEFAULT_TIMEOUT_MS,
  }
}

function createCapturedOutput(): CapturedOutput {
  return { text: '', omittedChars: 0 }
}

function appendCapturedOutput(output: CapturedOutput, chunk: unknown): void {
  const text = typeof chunk === 'string' ? chunk : String(chunk)
  const remaining = MAX_INLINE_OUTPUT_CHARS - output.text.length
  if (remaining <= 0) {
    output.omittedChars += text.length
    return
  }
  if (text.length <= remaining) {
    output.text += text
    return
  }
  output.text += text.slice(0, remaining)
  output.omittedChars += text.length - remaining
}

function finalizeCapturedOutput(
  output: CapturedOutput,
  suffixes: string[] = [],
): { text: string; truncated: boolean } {
  const statusText = suffixes.filter(Boolean).join('\n')
  const truncationText =
    output.omittedChars > 0
      ? `... [output truncated - ${output.omittedChars} chars removed]`
      : ''
  const text = [output.text, truncationText, statusText].filter(Boolean).join('\n')
  return {
    text,
    truncated: output.omittedChars > 0,
  }
}

function getMissingExecutableMessage(executable: string): string {
  return `Claude CLI executable not found: ${executable}. Install Claude Code and ensure the external \`claude\` command is on PATH, or set CLAUDE_CLI_PATH to that executable.`
}

function parseClaudeJson(stdout: string): {
  result?: string
  session_id?: string
  is_error?: boolean
} {
  try {
    const parsed = JSON.parse(stdout) as unknown
    if (!parsed || typeof parsed !== 'object') return {}
    const record = parsed as Record<string, unknown>
    return {
      ...(typeof record.result === 'string' ? { result: record.result } : {}),
      ...(typeof record.session_id === 'string'
        ? { session_id: record.session_id }
        : {}),
      ...(typeof record.is_error === 'boolean'
        ? { is_error: record.is_error }
        : {}),
    }
  } catch {
    return {}
  }
}

function isTrustedBypassParentMode(context: Pick<ToolUseContext, 'getAppState'>): boolean {
  const permissionContext = context.getAppState().toolPermissionContext
  // prePlanMode is the record of the mode plan was entered from.
  // isBypassPermissionsModeAvailable only says bypass is permitted, which is
  // true for nearly every install and would trust every plan-mode session.
  return (
    permissionContext.mode === 'bypassPermissions' ||
    (permissionContext.mode === 'plan' &&
      permissionContext.prePlanMode === 'bypassPermissions')
  )
}

// Permission modes that let the delegated Claude CLI process apply edits
// without asking. Worker instructions never pass either of these to a delegated
// run; this enforces that in code rather
// than relying on the worker to comply. 'dontAsk' and 'auto' are excluded on
// purpose: 'dontAsk' converts an ask into a deny (permissions.ts, dontAsk mode
// transformation) and 'auto' still routes through the classifier, so neither
// skips the permission system the way these two do.
const WORKER_FORBIDDEN_DELEGATED_PERMISSION_MODES = new Set([
  'acceptEdits',
  'bypassPermissions',
])

function isPathLikeExecutable(executable: string): boolean {
  return (
    executable.includes('/') ||
    executable.includes('\\') ||
    executable.startsWith('~')
  )
}

function getCatCodeExecutableCandidates(): string[] {
  return [
    process.argv[1],
    process.execPath,
    resolve(process.cwd(), 'cat-code'),
    resolve(process.cwd(), 'cli'),
    resolve(process.cwd(), 'cli-dev'),
  ].filter((path): path is string => Boolean(path))
}

async function realpathOrNull(path: string): Promise<string | null> {
  try {
    return await realpath(path)
  } catch {
    return null
  }
}

async function assertExternalClaudeExecutable(command: ClaudeCliCommand): Promise<void> {
  const executableName = basename(command.executable)
  if (FORBIDDEN_EXECUTABLE_BASENAMES.has(executableName)) {
    throw new Error(CAT_CODE_EXECUTABLE_ERROR)
  }

  if (!isPathLikeExecutable(command.executable)) return

  const resolvedExecutable = await realpathOrNull(
    expandPath(command.executable, command.cwd),
  )
  if (!resolvedExecutable) return

  for (const candidate of getCatCodeExecutableCandidates()) {
    if (!FORBIDDEN_EXECUTABLE_BASENAMES.has(basename(candidate))) {
      continue
    }
    const resolvedCandidate = await realpathOrNull(candidate)
    if (resolvedCandidate && resolvedCandidate === resolvedExecutable) {
      throw new Error(CAT_CODE_EXECUTABLE_ERROR)
    }
  }
}

function failedOutput(
  input: Input,
  command: ClaudeCliCommand,
  startedAt: number,
  stderr: string,
): ClaudeCliToolOutput {
  const capturedStderr = createCapturedOutput()
  appendCapturedOutput(capturedStderr, stderr)
  const finalizedStderr = finalizeCapturedOutput(capturedStderr)
  return {
    status: 'failed',
    exit_code: null,
    stdout: '',
    stderr: finalizedStderr.text,
    model: input.model,
    effort: input.effort,
    cwd: command.cwd,
    elapsed_ms: Date.now() - startedAt,
    truncated: finalizedStderr.truncated,
  }
}

function truncateForDisplay(value: string): string {
  if (value.length <= MAX_DISPLAY_OUTPUT_CHARS) return value
  const removed = value.length - MAX_DISPLAY_OUTPUT_CHARS
  return `${value.slice(0, MAX_DISPLAY_OUTPUT_CHARS)}\n... [display truncated - ${removed} chars removed]`
}

function formatDisplayText(output: ClaudeCliToolOutput): string {
  return truncateForDisplay(
    output.result || output.stdout || output.stderr || output.status,
  )
}

function formatPromptSummary(prompt: string | undefined, limit = 80): string {
  if (!prompt) return 'task'
  if (prompt.length <= limit) return prompt
  return `${prompt.slice(0, limit)}...`
}

async function runClaudeCliTask(
  input: Input,
  context: Pick<ToolUseContext, 'abortController' | 'agentId'>,
  spawnImpl: ClaudeCliSpawn = spawn as ClaudeCliSpawn,
): Promise<ClaudeCliToolOutput> {
  const command = buildClaudeCliCommand(input)
  const startedAt = Date.now()

  try {
    await assertExternalClaudeExecutable(command)
  } catch (error) {
    return failedOutput(input, command, startedAt, errorMessage(error))
  }

  if (context.abortController.signal.aborted) {
    return {
      status: 'interrupted',
      exit_code: null,
      stdout: '',
      stderr: 'Claude CLI task was aborted before it started.',
      model: input.model,
      effort: input.effort,
      cwd: command.cwd,
      elapsed_ms: 0,
      truncated: false,
    }
  }

  return new Promise<ClaudeCliToolOutput>(resolve => {
    let settled = false
    const stdout = createCapturedOutput()
    const stderr = createCapturedOutput()
    let forcedStatus: ClaudeCliToolOutput['status'] | undefined
    let timeout: ReturnType<typeof setTimeout> | undefined
    let onAbort = (): void => {}
    let onProcessExit = (): void => {}
    let unregisterDelegatedChild = (): void => {}

    const finish = (output: ClaudeCliToolOutput): void => {
      if (settled) return
      settled = true
      unregisterDelegatedChild()
      if (timeout) clearTimeout(timeout)
      context.abortController.signal.removeEventListener('abort', onAbort)
      // Through the EventEmitter view: process.off('exit', …) does not
      // typecheck against the ambient process shim in this repo, and a
      // listener per delegated run would otherwise stay for the session.
      ;(process as NodeJS.EventEmitter).off('exit', onProcessExit)
      resolve(output)
    }

    const child = spawnImpl(command.executable, command.args, {
      cwd: command.cwd,
      env: {
        ...subprocessEnv(),
        GIT_EDITOR: 'true',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      // The delegated CLI is an engine: it starts an MCP server child per
      // configured server, and those survive a signal aimed at the CLI alone
      // (the leftover cua-driver processes in
      // docs/reports/2026-09-06-subagent-escalation-and-delegation-failures.md).
      // Detaching makes the CLI a process group leader, which is the only
      // thing that lets killProcessTree reach its descendants. It also moves
      // the child out of this process's group, so a terminal SIGINT no longer
      // reaches it and termination becomes ours alone to do: the same trade
      // Shell.ts makes for bash.
      detached: process.platform !== 'win32',
      windowsHide: true,
    })

    // Tracked so the worker that spawned this (if any) can reap it from
    // runAgent.ts's finally block even if neither abort nor the timeout below
    // catches it first: the streaming tool executor can discard an in-flight
    // tool call without aborting it, same as the process-exit reaper exists
    // for below. finish() unregisters this on every settlement path.
    unregisterDelegatedChild = registerDelegatedChild(context.agentId, child)

    // Group kill first so descendants go too; the direct kill then covers a
    // child that never led a group (Windows, or a spawn that failed).
    const killDelegatedTree = (): void => {
      killProcessTree(child, 'SIGKILL')
      child.kill('SIGKILL')
    }

    onAbort = (): void => {
      forcedStatus = 'interrupted'
      killDelegatedTree()
    }

    // Abort is not guaranteed to arrive. An async subagent runs on an
    // abortController unlinked from its parent's (runAgent), and the streaming
    // tool executor can discard an in-flight tool call without aborting it, so
    // engine exit is the last point at which this tree can still be reaped.
    onProcessExit = (): void => {
      killDelegatedTree()
    }
    process.on('exit', onProcessExit)

    timeout = setTimeout(() => {
      forcedStatus = 'timeout'
      killDelegatedTree()
    }, command.timeoutMs)
    timeout.unref?.()

    context.abortController.signal.addEventListener('abort', onAbort, {
      once: true,
    })

    child.stdout?.setEncoding('utf8')
    child.stderr?.setEncoding('utf8')
    child.stdout?.on('data', chunk => {
      appendCapturedOutput(stdout, chunk)
    })
    child.stderr?.on('data', chunk => {
      appendCapturedOutput(stderr, chunk)
    })
    child.once('error', error => {
      const err = error as NodeJS.ErrnoException
      if (err.code === 'ENOENT') {
        finish(
          failedOutput(
            input,
            command,
            startedAt,
            getMissingExecutableMessage(command.executable),
          ),
        )
        return
      }
      finish(
        failedOutput(
          input,
          command,
          startedAt,
          `Failed to launch Claude CLI: ${errorMessage(error)}`,
        ),
      )
    })
    child.once('close', (code, signal) => {
      const parsed = stdout.omittedChars === 0 ? parseClaudeJson(stdout.text) : {}
      const finalizedStdout = finalizeCapturedOutput(stdout)
      const timeoutMessage =
        forcedStatus === 'timeout'
          ? `Claude CLI task timed out after ${command.timeoutMs}ms.`
          : ''
      const interruptedMessage =
        forcedStatus === 'interrupted' ? 'Claude CLI task was aborted.' : ''
      const finalizedStderr = finalizeCapturedOutput(stderr, [
        timeoutMessage,
        interruptedMessage,
      ])
      const exitCode =
        code !== null && code !== undefined
          ? code
          : signal === 'SIGKILL'
            ? 137
            : null
      const status =
        forcedStatus ?? (exitCode === 0 && !parsed.is_error ? 'success' : 'failed')

      finish({
        status,
        exit_code: exitCode,
        stdout: finalizedStdout.text,
        stderr: finalizedStderr.text,
        ...parsed,
        model: input.model,
        effort: input.effort,
        cwd: command.cwd,
        elapsed_ms: Date.now() - startedAt,
        truncated: finalizedStdout.truncated || finalizedStderr.truncated,
      })
    })
  })
}

function renderToolUseMessage(input: Partial<Input>): React.ReactNode {
  // Must be Text-safe: AssistantToolUseMessage embeds this inside
  // <Text>(…)</Text>, so returning a <Box> crashes Ink ("<Box> can't be
  // nested inside <Text>") and unmounts the REPL.
  return `Asking Claude CLI: ${formatPromptSummary(input.prompt)}`
}

function renderToolResultMessage(output: ClaudeCliToolOutput): React.ReactNode {
  const text = formatDisplayText(output)
  return (
    <Box flexDirection="column" marginTop={1}>
      <Text>Claude CLI {output.status}</Text>
      <MessageResponse>
        <Text>{text}</Text>
      </MessageResponse>
    </Box>
  )
}

export const ClaudeCliTool = buildTool({
  name: CLAUDE_CLI_TOOL_NAME,
  searchHint: 'delegate task to external Claude CLI',
  maxResultSizeChars: 100_000,
  shouldDefer: true,
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  isConcurrencySafe() {
    // External Claude CLI runs can share auth state, workspace state, and quota.
    return false
  },
  isReadOnly() {
    return false
  },
  interruptBehavior() {
    return 'cancel'
  },
  userFacingName() {
    return 'Claude CLI'
  },
  getActivityDescription(input) {
    return input?.prompt
      ? `Asking Claude CLI: ${formatPromptSummary(input.prompt, 100)}`
      : 'Asking Claude CLI'
  },
  toAutoClassifierInput(input) {
    // Returning the whole parsed input, not a hand-formatted string, is what
    // keeps this forgery-resistant: the classifier's transcript builder
    // JSON-encodes whatever this returns (yoloClassifier.ts toCompactBlock),
    // so cwd/model/effort/permission_mode always land as their own JSON keys
    // with the caller's real values, and anything inside `prompt` that reads
    // like one of those keys stays escaped text nested in the "prompt"
    // string, never a sibling key that could override the real one. A field
    // the caller left unset is simply absent from the object (and therefore
    // from the JSON), rather than showing up as some specific mode.
    return input
  },
  async checkPermissions(input, context) {
    // context.agentId is only set for a subagent call; the main thread leaves
    // it undefined (Tool.ts). Everything below is a backstop: the ordinary
    // path already keeps ClaudeCli out of a worker's pool unless its own
    // agent definition names it (ASYNC_AGENT_EXPLICIT_GRANT_TOOLS), so this
    // only matters if some other path assembles a worker's pool without that
    // filter.
    if (context.agentId !== undefined) {
      const capabilities = resolveWorkerCapabilities(
        context.options.tools.map(tool => tool.name),
      )
      if (!capabilities.mayDelegateExternally) {
        return {
          behavior: 'deny',
          message:
            'This worker does not have Claude CLI in its tool pool. Do the work yourself instead of delegating to Claude CLI.',
          decisionReason: {
            type: 'other',
            reason: 'claude_cli_not_granted_to_worker',
          },
        }
      }

      if (
        input.permission_mode !== undefined &&
        WORKER_FORBIDDEN_DELEGATED_PERMISSION_MODES.has(input.permission_mode)
      ) {
        return {
          behavior: 'deny',
          message: `A delegated Claude CLI run from a worker cannot use permission_mode ${input.permission_mode}. Drop permission_mode, or pick a mode that does not edit files automatically.`,
          decisionReason: {
            type: 'other',
            reason: 'delegated_worker_permission_mode_edits_files',
          },
        }
      }
    }

    if (
      input.permission_mode === 'bypassPermissions' &&
      !isTrustedBypassParentMode(context)
    ) {
      return {
        behavior: 'deny',
        message:
          'ClaudeCli cannot delegate bypassPermissions unless the parent Cat Code session is already running with bypass permissions.',
        decisionReason: {
          type: 'other',
          reason: 'delegated_bypass_permissions_requires_parent_bypass',
        },
      }
    }

    return {
      behavior: 'passthrough',
      message:
        'ClaudeCli launches an external Claude CLI process. Review the delegated prompt, cwd, model, effort, and permission mode before allowing.',
      suggestions: [
        {
          type: 'addRules',
          rules: [{ toolName: CLAUDE_CLI_TOOL_NAME }],
          behavior: 'allow',
          destination: 'session',
        },
      ],
    }
  },
  async validateInput(input) {
    try {
      await assertExternalClaudeExecutable(buildClaudeCliCommand(input))
    } catch (error) {
      return {
        result: false,
        message: errorMessage(error),
        errorCode: 2,
      }
    }

    if (input.cwd) {
      try {
        const fs = await import('fs/promises')
        const stats = await fs.stat(expandPath(input.cwd))
        if (!stats.isDirectory()) {
          return {
            result: false,
            message: `cwd is not a directory: ${input.cwd}`,
            errorCode: 2,
          }
        }
      } catch (error) {
        return {
          result: false,
          message: `cwd is not accessible: ${input.cwd} (${errorMessage(error)})`,
          errorCode: 2,
        }
      }
    }
    return { result: true }
  },
  async description() {
    return DESCRIPTION
  },
  async prompt() {
    return PROMPT
  },
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: jsonStringify(output),
      is_error: output.status !== 'success',
    }
  },
  renderToolUseMessage,
  renderToolResultMessage,
  async call(input, context) {
    return {
      data: await runClaudeCliTask(input, context),
    }
  },
} satisfies ToolDef<InputSchema, ClaudeCliToolOutput>)

export const _claudeCliToolInternalsForTest = {
  buildClaudeCliCommand,
  runClaudeCliTask,
  parseClaudeJson,
  formatDisplayText,
}
