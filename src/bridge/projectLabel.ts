import { execFileSync } from 'child_process'
import { basename } from 'path'

export function buildPtcloveProjectLabel(cwd: string): string {
  const projectName = basename(cwd) || cwd
  const branch = gitOutput(cwd, ['branch', '--show-current'])
  const defaultBranch = gitOutput(cwd, ['symbolic-ref', 'refs/remotes/origin/HEAD'])
    ?.replace(/^refs\/remotes\/origin\//, '')
  const worktreeRoot = gitOutput(cwd, ['rev-parse', '--show-toplevel'])
  const suffixes: string[] = []

  if (branch && branch !== 'main' && branch !== 'master' && branch !== defaultBranch) {
    suffixes.push(`branch=${branch}`)
  }

  if (worktreeRoot && basename(worktreeRoot) !== projectName) {
    suffixes.push(`wt=${basename(worktreeRoot)}`)
  }

  return suffixes.length > 0 ? `${projectName} · ${suffixes.join(' · ')}` : projectName
}

function gitOutput(cwd: string, args: string[]): string | undefined {
  try {
    const output = execFileSync('git', args, {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    return output || undefined
  } catch {
    return undefined
  }
}
