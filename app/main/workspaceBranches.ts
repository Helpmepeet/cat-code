import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { HostResult, WorkspaceBranches } from '../shared/hostApi.js'

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
): Promise<HostResult<WorkspaceBranches>> {
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
  try {
    if (await git(root, 'status', '--porcelain')) {
      return { ok: false, error: { code: 'branch_unavailable', message: 'Commit or stash local changes before switching branches.' } }
    }
    await git(root, 'switch', '--', branch)
    return listWorkspaceBranches(cwd)
  } catch {
    return { ok: false, error: { code: 'branch_unavailable', message: 'Git could not switch to that branch. Check whether another worktree uses it.' } }
  }
}
