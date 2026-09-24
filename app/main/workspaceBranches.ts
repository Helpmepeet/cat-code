import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { HostResult, SwitchWorkspaceBranchResult, WorkspaceBranches } from '../shared/hostApi.js'

const execFileAsync = promisify(execFile)

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', cwd, ...args], {
    timeout: 10_000,
    maxBuffer: 256 * 1024,
    encoding: 'utf8',
  })
  return stdout.trim()
}

export async function gitRoot(cwd: string): Promise<string | null> {
  try {
    return await git(cwd, 'rev-parse', '--show-toplevel')
  } catch {
    return null
  }
}

export async function listWorkspaceBranches(cwd: string): Promise<HostResult<WorkspaceBranches>> {
  const root = await gitRoot(cwd)
  if (!root) {
    return { ok: false, error: { code: 'branch_unavailable', message: 'This project is not a Git repository.' } }
  }
  try {
    const [current, refs, status] = await Promise.all([
      git(root, 'symbolic-ref', '--quiet', '--short', 'HEAD').catch(() => ''),
      git(root, 'for-each-ref', '--format=%(refname:short)', 'refs/heads'),
      git(root, 'status', '--porcelain'),
    ])
    return { ok: true, value: { current: current || null, branches: refs ? refs.split('\n') : [], dirty: status.length > 0 } }
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
    return { ok: false, error: { code: 'branch_unavailable', message: collision
      ? 'A local file would be overwritten by that branch. Move it before switching.'
      : 'Git could not switch to that branch. Check whether another worktree uses it.' } }
  }
  // The session cwd may be a tracked subdirectory removed by this checkout.
  // The repository root remains valid for inspection and replacement spawn.
  const after = await listWorkspaceBranches(root)
  if (after.ok && after.value.current === branch) return after
  return { ok: false, branchChanged: true, error: { code: 'branch_unavailable', message: `Git changed the checkout, but could not confirm ${branch} as the current branch. Open a fresh chat after checking Git.` } }
}
