import { z } from 'zod/v4'
import { getOriginalCwd, getSessionId, setOriginalCwd } from '../../bootstrap/state.js'
import { basename } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { clearSystemPromptSections } from '../../constants/systemPromptSections.js'
import { clearUserContextCache } from '../../context.js'
import { logEvent } from '../../services/analytics/index.js'
import type { Tool, ToolUseContext } from '../../Tool.js'
import { buildTool, type ToolDef } from '../../Tool.js'
import { clearMemoryFileCaches } from '../../utils/claudemd.js'
import { inspectBorrowedWorktree, type BorrowedWorktreeIdentity } from '../../utils/borrowedWorktree.js'
import { errorMessage } from '../../utils/errors.js'
import { getCwd } from '../../utils/cwd.js'
import { findCanonicalGitRoot } from '../../utils/git.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { getPlanSlug, getPlansDirectory } from '../../utils/plans.js'
import { setCwd } from '../../utils/Shell.js'
import { withWorktreeTransition } from '../../utils/workspaceTransition.js'
import {
  pinSessionProjectDir,
  saveWorktreeState,
} from '../../utils/sessionStorage.js'
import {
  createWorktreeForSession,
  getCurrentWorktreeSession,
  restoreWorktreeSession,
  validateWorktreeSlug,
} from '../../utils/worktree.js'
import { ENTER_WORKTREE_TOOL_NAME } from './constants.js'
import { getEnterWorktreeToolPrompt } from './prompt.js'
import { renderToolResultMessage, renderToolUseMessage } from './UI.js'

const inputSchema = lazySchema(() =>
  z.strictObject({
    name: z
      .string()
      .superRefine((s, ctx) => {
        try {
          validateWorktreeSlug(s)
        } catch (e) {
          ctx.addIssue({ code: 'custom', message: (e as Error).message })
        }
      })
      .optional()
      .describe(
        'Optional name for the worktree. Each "/"-separated segment may contain only letters, digits, dots, underscores, and dashes; max 64 chars total. A random name is generated if not provided.',
      ),
    path: z.string().min(1).optional().describe('Absolute path to an existing sibling Git worktree. Requires one-time user approval.'),
  }).refine(input => input.name === undefined || input.path === undefined, 'Choose name or path, not both.'),
)
type InputSchema = ReturnType<typeof inputSchema>
type PreparedWorktree = { origin: string; identity: BorrowedWorktreeIdentity } | { error: string }

function preparedWorktree(context: ToolUseContext): PreparedWorktree | undefined {
  return context.preparedExecution?.toolName === ENTER_WORKTREE_TOOL_NAME
    ? context.preparedExecution.state as PreparedWorktree | undefined : undefined
}

const outputSchema = lazySchema(() =>
  z.object({
    worktreePath: z.string(),
    worktreeBranch: z.string().optional(),
    borrowed: z.boolean().optional(),
    message: z.string(),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>
export type Output = z.infer<OutputSchema>

export const EnterWorktreeTool: Tool<InputSchema, Output> = buildTool({
  name: ENTER_WORKTREE_TOOL_NAME,
  searchHint: 'switch into an existing sibling Git worktree or create an isolated worktree',
  maxResultSizeChars: 100_000,
  async description() {
    return 'Switches the session into an existing sibling Git worktree or creates an isolated worktree'
  },
  async prompt() {
    return getEnterWorktreeToolPrompt()
  },
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  userFacingName(input) {
    return input?.path ? 'Entering worktree' : 'Creating worktree'
  },
  shouldDefer: true,
  toAutoClassifierInput(input) {
    return input.path ? { action: 'enter_existing_worktree', path: input.path } : input.name ?? ''
  },
  async prepareExecution(input, context) {
    let state: PreparedWorktree | undefined
    if (input.path) {
      const origin = getOriginalCwd()
      try {
        if (context.agentId) throw new Error('Only the main agent can change worktrees.')
        if (getCurrentWorktreeSession()) throw new Error('Leave the current worktree before entering another one.')
        state = { origin, identity: await inspectBorrowedWorktree(origin, input.path) }
      } catch (error) { state = { error: errorMessage(error) } }
    }
    return { state, cleanup() {} }
  },
  async validateInput(input, context) {
    if (input.path) {
      const prepared = preparedWorktree(context)
      if (!prepared || 'error' in prepared) return { result: false, errorCode: 1,
        message: prepared && 'error' in prepared ? prepared.error : 'Could not verify the existing worktree.' }
    }
    return { result: true }
  },
  async checkPermissions(input, context) {
    if (!input.path) return { behavior: 'allow', updatedInput: input }
    const prepared = preparedWorktree(context)
    if (!prepared || 'error' in prepared) return { behavior: 'deny', message: 'Could not verify the existing worktree.' }
    const message = 'Enter the existing worktree at ' + prepared.identity.checkout + '? This changes where the session and its workers can edit. Cat Code will not remove the worktree.'
    return { behavior: 'ask', humanOnly: true, message, updatedInput: input,
      decisionReason: { type: 'safetyCheck', reason: message, classifierApprovable: false } }
  },
  renderToolUseMessage,
  renderToolResultMessage,
  async call(input, context) {
    // Validate not already in a worktree created by this session
    if (getCurrentWorktreeSession()) {
      throw new Error('Already in a worktree session')
    }

    return withWorktreeTransition(context, async () => {
      const borrowed = input.path ? preparedWorktree(context) : undefined
      if (input.path && (!context.finalInputApprovedByUser || !borrowed || 'error' in borrowed)) {
        throw new Error('Entering an existing worktree requires your approval for that checkout.')
      }
      if (borrowed && !('error' in borrowed)) {
        const { origin, identity } = borrowed
        if (origin !== getOriginalCwd() || !isDeepStrictEqual(await inspectBorrowedWorktree(origin, input.path!).catch(() => null), identity)) {
          throw new Error('The selected worktree changed while approval was open. No workspace change was made.')
        }
        context.abortController.signal.throwIfAborted()
        const session = {
          originalCwd: origin, worktreePath: identity.checkout, worktreeName: basename(identity.checkout),
          sessionId: getSessionId(), borrowed: identity,
        }
        pinSessionProjectDir()
        process.chdir(identity.checkout)
        setCwd(identity.checkout)
        setOriginalCwd(identity.checkout)
        restoreWorktreeSession(session)
        saveWorktreeState(session)
        clearSystemPromptSections()
        clearMemoryFileCaches()
        clearUserContextCache()
        getPlansDirectory.cache.clear?.()
        return { data: { worktreePath: identity.checkout, borrowed: true,
          message: 'Entered the existing worktree at ' + identity.checkout + '. The session and its workers now use this checkout. ExitWorktree can leave it but cannot remove it.' } }
      }
      // Resolve to main repo root so worktree creation works from within a worktree
      const mainRepoRoot = findCanonicalGitRoot(getCwd())
      if (mainRepoRoot && mainRepoRoot !== getCwd()) {
        process.chdir(mainRepoRoot)
        setCwd(mainRepoRoot)
      }

      const slug = input.name ?? getPlanSlug()

      const worktreeSession = await createWorktreeForSession(getSessionId(), slug)

      // Must run BEFORE setOriginalCwd: the transcript file was materialized
      // under the pre-worktree project dir and the writer keeps that path, so
      // letting originalCwd move would repoint getTranscriptPath() (and every
      // hook's transcript_path) at a file nobody writes.
      pinSessionProjectDir()

      process.chdir(worktreeSession.worktreePath)
      setCwd(worktreeSession.worktreePath)
      setOriginalCwd(getCwd())
      saveWorktreeState(worktreeSession)
      // Clear cached system prompt sections so env_info_simple recomputes with worktree context
      clearSystemPromptSections()
      // Clear memoized caches that depend on CWD
      clearMemoryFileCaches()
      clearUserContextCache()
      getPlansDirectory.cache.clear?.()

      logEvent('tengu_worktree_created', {
        mid_session: true,
      })

      const branchInfo = worktreeSession.worktreeBranch
        ? ` on branch ${worktreeSession.worktreeBranch}`
        : ''

      return {
        data: {
          worktreePath: worktreeSession.worktreePath,
          worktreeBranch: worktreeSession.worktreeBranch,
          message: `Created worktree at ${worktreeSession.worktreePath}${branchInfo}. The session is now working in the worktree. Use ExitWorktree to leave mid-session, or exit the session to be prompted.`,
        },
      }
    })
  },
  mapToolResultToToolResultBlockParam({ message }, toolUseID) {
    return {
      type: 'tool_result',
      content: message,
      tool_use_id: toolUseID,
    }
  },
} satisfies ToolDef<InputSchema, Output>)
