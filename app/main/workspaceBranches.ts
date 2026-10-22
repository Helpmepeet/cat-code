import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { basename, resolve } from 'node:path'
import type { HostResult, SessionDescriptor, SwitchWorkspaceBranchResult, WorkspaceBranchObservation, WorkspaceBranches } from '../shared/hostApi.js'
import type { Host } from '../host/host.js'
import type { SessionId } from '../shared/protocol.js'

const execFileAsync = promisify(execFile)

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', cwd, ...args], {
    timeout: 10_000,
    maxBuffer: 256 * 1024,
    encoding: 'utf8',
  })
  return stdout.endsWith('\n') ? stdout.slice(0, -1) : stdout
}

export async function gitRoot(cwd: string): Promise<string | null> {
  try {
    return await git(cwd, 'rev-parse', '--show-toplevel')
  } catch {
    return null
  }
}

const pendingBranchReads = new Map<string, Promise<HostResult<WorkspaceBranchObservation>>>()

/** A readout needs HEAD only, not a working-tree scan or picker blockers. */
export function readWorkspaceBranch(cwd: string): Promise<HostResult<WorkspaceBranchObservation>> {
  const pending = pendingBranchReads.get(cwd)
  if (pending) return pending
  const request = (async (): Promise<HostResult<WorkspaceBranchObservation>> => {
    const current = await git(cwd, 'symbolic-ref', '--quiet', '--short', 'HEAD').catch(() => null)
    if (current) return { ok: true, value: { current } }
    try {
      return { ok: true, value: { current: null, detached: await git(cwd, 'rev-parse', '--short', 'HEAD') } }
    } catch {
      const root = await gitRoot(cwd)
      return { ok: false, error: { code: 'branch_unavailable', message: root
        ? 'Could not read this project’s branch.'
        : 'This project is not a Git repository.' } }
    }
  })()
  pendingBranchReads.set(cwd, request)
  void request.finally(() => pendingBranchReads.delete(cwd))
  return request
}

export function createSessionBranchReader(options: {
  host: () => Pick<Host, 'getSessionDescriptor' | 'getWorkspaceObservation' | 'canPreview'> | null
  isLive(id: SessionId): boolean
  readSaved(session: SessionDescriptor): Promise<import('../shared/protocol.js').WorkspaceObservation>
}) {
  return async (id: unknown): Promise<HostResult<WorkspaceBranchObservation>> => {
    const h = options.host()
    const descriptor = h?.getSessionDescriptor(id)
    if (!h || !descriptor) return { ok: false, error: { code: 'session_not_found', message: 'Session not found.' } }
    let observation = h.getWorkspaceObservation(descriptor.appSessionId)
    if (!options.isLive(descriptor.appSessionId) && h.canPreview(descriptor.appSessionId)) {
      try {
        observation = await options.readSaved(descriptor)
      } catch {
        return { ok: false, error: { code: 'branch_unavailable', message: 'Could not read this chat’s branch.' } }
      }
    }
    if (!observation) return { ok: false, error: { code: 'branch_unavailable', message: 'Wait for this chat to connect.' } }
    const result = await readWorkspaceBranch(observation.cwd)
    return result.ok ? { ok: true, value: {
      ...result.value,
      ...(observation.lastWorkingBranch !== undefined ? { recordedBranch: observation.lastWorkingBranch } : {}),
    } } : result
  }
}

export async function listWorkspaceBranches(cwd: string): Promise<HostResult<WorkspaceBranches>> {
  const root = await gitRoot(cwd)
  if (!root) {
    return { ok: false, error: { code: 'branch_unavailable', message: 'This project is not a Git repository.' } }
  }
  try {
    const [current, refs, status, worktrees] = await Promise.all([
      git(root, 'symbolic-ref', '--quiet', '--short', 'HEAD').catch(() => ''),
      git(root, 'for-each-ref', '--sort=-committerdate', '--format=%(refname:short)', 'refs/heads'),
      git(root, 'status', '--porcelain'),
      git(root, 'worktree', 'list', '--porcelain', '-z'),
    ])
    const occupied: Record<string, string> = Object.create(null)
    for (const record of worktrees.split('\0\0')) {
      const fields = record.split('\0')
      const path = fields.find(field => field.startsWith('worktree '))?.slice(9)
      const branch = fields.find(field => field.startsWith('branch refs/heads/'))?.slice(18)
      if (path && branch && resolve(path) !== resolve(root)) occupied[branch] = basename(path)
    }
    const branches = refs ? refs.split('\n').filter(branch => branch !== current) : []
    if (current) branches.unshift(current)
    const detached = current ? undefined : await git(root, 'rev-parse', '--short', 'HEAD').catch(() => undefined)
    return { ok: true, value: { current: current || null, branches, dirty: status.length > 0, occupied, ...(detached ? { detached } : {}) } }
  } catch {
    return { ok: false, error: { code: 'branch_unavailable', message: 'Could not read branches for this project.' } }
  }
}

export async function switchWorkspaceBranch(
  cwd: string,
  branch: string,
  otherLiveCwds: readonly string[],
): Promise<HostResult<WorkspaceBranches> | Extract<SwitchWorkspaceBranchResult, { branchChanged: true }>> {
  const listed = await listWorkspaceBranches(cwd)
  if (!listed.ok) return listed
  if (!listed.value.branches.includes(branch)) {
    return { ok: false, error: { code: 'branch_unavailable', message: 'That local branch is no longer available.' } }
  }
  if (listed.value.current === branch) return listed
  if (listed.value.occupied?.[branch]) {
    return { ok: false, error: { code: 'branch_unavailable', message: `That branch is open in ${listed.value.occupied[branch]}. Choose another branch.` } }
  }
  const root = await gitRoot(cwd)
  if (!root) return { ok: false, error: { code: 'branch_unavailable', message: 'This project is not a Git repository.' } }
  for (const other of otherLiveCwds) {
    if (await gitRoot(other) === root) {
      return { ok: false, error: { code: 'branch_unavailable', message: 'Close other live sessions in this repository before switching branches.' } }
    }
  }
  let attemptedSwitch = false
  try {
    if (await git(root, 'status', '--porcelain')) {
      return { ok: false, error: { code: 'branch_unavailable', message: 'Commit or stash local changes before switching branches.' } }
    }
    // Git's default --overwrite-ignore can silently destroy ignored local
    // files when the target branch tracks their paths.
    attemptedSwitch = true
    await git(root, 'switch', '--no-overwrite-ignore', '--', branch)
  } catch (error) {
    // An interrupted checkout may move HEAD before reporting an error. If Git
    // cannot tell us where HEAD is, retire the old branch-cached sidecar too.
    const current = attemptedSwitch
      ? await git(root, 'symbolic-ref', '--quiet', '--short', 'HEAD').catch(() => null)
      : listed.value.current
    if (attemptedSwitch && (current === null || current !== listed.value.current)) {
      return { ok: false, branchChanged: true, error: { code: 'branch_unavailable', message: 'Git may have changed the checkout, but could not confirm its branch. Check Git and open a fresh chat.' } }
    }
    const stderr = (error as { stderr?: unknown }).stderr
    const collision = typeof stderr === 'string' && stderr.includes('would be overwritten')
    const occupied = typeof stderr === 'string' && /already (?:checked out at|used by worktree at)/.test(stderr)
    return { ok: false, error: { code: 'branch_unavailable', message: collision
      ? 'A local file would be overwritten by that branch. Move it before switching.'
      : occupied ? 'That branch is now open in another worktree. Choose another branch.'
      : 'Git could not switch to that branch. Check Git and try again.' } }
  }
  // The session cwd may be a tracked subdirectory removed by this checkout.
  // The repository root remains valid for inspection and replacement spawn.
  const after = await listWorkspaceBranches(root)
  if (after.ok && after.value.current === branch) return after
  return { ok: false, branchChanged: true, error: { code: 'branch_unavailable', message: `Git changed the checkout, but could not confirm ${branch} as the current branch. Open a fresh chat after checking Git.` } }
}

type BranchSwitchHost = Pick<Host,
  'listSessions' | 'getWorkspaceObservation' | 'beginBranchReplacement' |
  'completeBranchReplacement' | 'closeSession' | 'endBranchSwitch'>

/** The receiving-side transaction, shared by Electron IPC and hermetic tests. */
export function createWorkspaceBranchSwitcher(options: {
  host: BranchSwitchHost | (() => BranchSwitchHost | null)
  switchingSessionIds: Set<SessionId>
  sessionsWithSubmit: ReadonlySet<SessionId>
  isWorkspaceReserved(id: SessionId): boolean
  isLive(id: SessionId): boolean
  validateCwd(cwd: string): { ok: boolean }
  transferFiles(from: SessionId, to: SessionId): void
  log(message: string): void
  onTransition?(id: SessionId, active: boolean): void
}) {
  const switchingGitRoots = new Set<string>()
  const failure = (message: string): SwitchWorkspaceBranchResult => ({
    ok: false, error: { code: 'branch_unavailable', message },
  })
  const execute = async (appSessionId: unknown, branch: unknown): Promise<SwitchWorkspaceBranchResult> => {
    const h = typeof options.host === 'function' ? options.host() : options.host
    if (!h) return { ok: false, error: { code: 'session_not_found', message: 'Session not found.' } }
    const descriptor = h.listSessions().find(row => row.appSessionId === appSessionId)
    if (!descriptor) return { ok: false, error: { code: 'session_not_found', message: 'Session not found.' } }
    const id = descriptor.appSessionId
    if (options.isWorkspaceReserved(id)) return failure('Wait for the workspace change to settle.')
    if (options.switchingSessionIds.has(id)) return failure('A branch switch is already in progress.')
    if (descriptor.status !== 'ready') return failure('Wait for this session to connect before switching branches.')
    if (descriptor.lastMessageSentAt !== null || options.sessionsWithSubmit.has(id)) return failure('Start a new chat to choose another branch.')
    if (typeof branch !== 'string' || branch.length === 0 || branch.length > 255) return failure('Choose a local branch from the list.')
    options.switchingSessionIds.add(id)
    try {
      options.onTransition?.(id, true)
      const observation = h.getWorkspaceObservation(id)
      if (!observation) return failure('Wait for this chat to connect.')
      const cwd = observation.cwd
      const root = await gitRoot(cwd)
      if (!root) return failure('This project is not a Git repository.')
      if (switchingGitRoots.has(root)) return failure('A branch switch is already in progress.')
      switchingGitRoots.add(root)
      let checkoutMoved = false
      let replacementReserved = false
      try {
        const admitted = h.beginBranchReplacement(id)
        if (!admitted.ok) return admitted.error.code === 'session_limit'
          ? { ok: false, error: { ...admitted.error, message: 'Wait a moment before switching branches.' } }
          : admitted
        replacementReserved = true
        const fresh = h.listSessions().find(row => row.appSessionId === id)
        if (fresh?.status !== 'ready' || fresh.lastMessageSentAt !== null || options.sessionsWithSubmit.has(id)) {
          return failure('Start a new empty chat to choose another branch.')
        }
        const others = h.listSessions().filter(row => row.appSessionId !== id && options.isLive(row.appSessionId))
        const observations = others.map(row => h.getWorkspaceObservation(row.appSessionId))
        if (observations.some(value => !value)) return failure('Wait for the other chat to connect before switching branches.')
        if (h.getWorkspaceObservation(id)?.cwd !== cwd) return failure('The working folder changed. Try again.')
        const switched = await switchWorkspaceBranch(cwd, branch, observations.map(value => value!.cwd))
        checkoutMoved = switched.ok || 'branchChanged' in switched
        if (!switched.ok) return switched
        const created = await h.completeBranchReplacement(options.validateCwd(cwd).ok ? cwd : root)
        if (!created.ok) return {
          ok: false, branchChanged: true,
          error: { ...created.error, message: `Branch switched to ${branch}, but a new chat could not start. Open a new chat in this project. ${created.error.message}` },
        }
        const closed = await h.closeSession(id)
        if (!closed.ok) return {
          ok: false, branchChanged: true,
          error: { ...closed.error, message: `Branch switched to ${branch} and a new chat opened, but the previous chat could not close. ${closed.error.message}` },
        }
        return created
      } catch (error) {
        options.log(`branch switch handoff failed: ${String(error)}`)
        return checkoutMoved
          ? { ok: false, branchChanged: true, error: { code: 'branch_unavailable', message: `Branch switched to ${branch}, but the chat handoff failed. Check open chats before continuing.` } }
          : failure('Could not switch branches. Try again.')
      } finally {
        if (replacementReserved) h.endBranchSwitch()
        switchingGitRoots.delete(root)
      }
    } finally {
      options.switchingSessionIds.delete(id)
      options.onTransition?.(id, false)
    }
  }
  return async (appSessionId: unknown, branch: unknown): Promise<SwitchWorkspaceBranchResult> => {
    const result = await execute(appSessionId, branch)
    // No error-producing transaction steps remain after capabilities move.
    if (result.ok) options.transferFiles(appSessionId as SessionId, result.value.appSessionId)
    return result
  }
}
