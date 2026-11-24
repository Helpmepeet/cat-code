import { lstat, readFile, realpath, stat } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { execFileNoThrowWithCwd } from './execFileNoThrow.js'
import { gitExe } from './git.js'

export type BorrowedWorktreeIdentity = {
  primary: string
  checkout: string
  commonDir: string
  gitDir: string
  checkoutId: string
  commonId: string
  gitDirId: string
}

export type BorrowedGitWrite = { identity: BorrowedWorktreeIdentity; ref: string; command: string }
export const BORROWED_GIT_WRITE_UNAVAILABLE = 'Scoped Git writes in an entered worktree require the macOS sandbox. The checkout has not changed.'

/** Keep elevated Git metadata access out of compound commands and shell expansions. */
export function isBorrowedGitWrite(command: string): boolean {
  return /^git add -- (?:[A-Za-z0-9._/-]+|'[^'\r\n]+')(?: (?:[A-Za-z0-9._/-]+|'[^'\r\n]+'))*$/.test(command) ||
    /^git commit -m (?:[A-Za-z0-9._-]+|'[^'\r\n]+'|"[A-Za-z0-9 ._/-]+")$/.test(command)
}

function inside(path: string, root: string): boolean {
  const rel = relative(root, path)
  return !isAbsolute(rel) && rel !== '..' && !rel.startsWith('..' + sep)
}

async function directoryId(path: string): Promise<string> {
  const entry = await stat(path, { bigint: true })
  if (!entry.isDirectory()) throw new Error('Not a directory')
  return [entry.dev, entry.ino, entry.birthtimeNs].join(':')
}

async function readGit(cwd: string, ...args: string[]): Promise<string> {
  const env = Object.fromEntries(Object.keys(process.env).filter(key => key.startsWith('GIT_')).map(key => [key, undefined]))
  const result = await execFileNoThrowWithCwd(gitExe(), ['--no-optional-locks', ...args], {
    cwd, env, timeout: 5_000, stdin: 'ignore', maxBuffer: 1024 * 1024,
  })
  if (result.code !== 0) throw new Error('Could not read Git worktree registration')
  return result.stdout
}

/** Authorization reads fresh metadata; project identity caches are not proof of ownership. */
export async function inspectBorrowedWorktree(origin: string, path: string): Promise<BorrowedWorktreeIdentity> {
  if (!isAbsolute(path)) throw new Error('Use the absolute path to the existing worktree.')
  const [checkout, originRoot] = await Promise.all([
    realpath(path), readGit(origin, 'rev-parse', '--show-toplevel').then(realpath),
  ])
  const registrations = await readGit(originRoot, 'worktree', 'list', '--porcelain', '-z')
  const rows = registrations.split('\0\0').map(row => row.split('\0'))
  const primaryPath = rows[0]?.[0]?.startsWith('worktree ') && rows[0][0].slice(9)
  const primary = primaryPath && await realpath(primaryPath)
  const target = rows.find(row => row[0] === 'worktree ' + checkout && !row.some(field => field.startsWith('prunable')))
  if (!primary || originRoot !== primary || inside(checkout, primary) || inside(primary, checkout) || !target) {
    throw new Error('Choose a registered sibling worktree of this repository, outside the primary checkout.')
  }
  const targetBranch = target.find(field => field.startsWith('branch '))
  if (targetBranch && rows.some(row => row !== target && row.includes(targetBranch))) {
    throw new Error('The target shares its branch with another checkout.')
  }
  const pointer = join(checkout, '.git')
  if (!(await lstat(pointer)).isFile()) throw new Error('Expected a linked Git worktree.')
  const gitPointer = /^gitdir: ([^\r\n]+)\r?\n?$/.exec(await readFile(pointer, 'utf8'))
  if (!gitPointer) throw new Error('Invalid Git worktree pointer.')
  const gitDir = await realpath(resolve(checkout, gitPointer[1]!))
  const commonDir = await realpath(join(primary, '.git'))
  if (dirname(gitDir) !== join(commonDir, 'worktrees')) throw new Error('Git worktree points to another repository.')
  const [backlink, common, topLevel] = await Promise.all([
    readFile(join(gitDir, 'gitdir'), 'utf8').then(value => realpath(resolve(gitDir, value.trim()))),
    readFile(join(gitDir, 'commondir'), 'utf8').then(value => realpath(resolve(gitDir, value.trim()))),
    readGit(checkout, 'rev-parse', '--show-toplevel').then(realpath),
  ])
  if (backlink !== pointer || common !== commonDir || topLevel !== checkout) throw new Error('Git worktree registration does not match the checkout.')
  const [checkoutId, commonId, gitDirId] = await Promise.all([directoryId(checkout), directoryId(commonDir), directoryId(gitDir)])
  return { primary, checkout, commonDir, gitDir, checkoutId, commonId, gitDirId }
}

export async function verifyBorrowedWorktree(identity: BorrowedWorktreeIdentity): Promise<void> {
  try {
    if (isDeepStrictEqual(await inspectBorrowedWorktree(identity.primary, identity.checkout), identity)) return
  } catch { /* An uncheckable checkout is not a safe destination. */ }
  throw new Error('The selected worktree changed or is unavailable. No work was redirected to the primary checkout.')
}

export async function prepareBorrowedGitWrite(identity: BorrowedWorktreeIdentity, command: string): Promise<BorrowedGitWrite> {
  await verifyBorrowedWorktree(identity)
  const ref = await readGit(identity.checkout, 'symbolic-ref', '--quiet', 'HEAD')
  if (!ref.startsWith('refs/heads/') || !inside(join(identity.commonDir, ref), join(identity.commonDir, 'refs', 'heads'))) {
    throw new Error('The worktree must be on a local branch for a sandboxed Git write.')
  }
  return { identity, command, ref }
}

export async function borrowedGitWritePaths(scope: BorrowedGitWrite): Promise<string[]> {
  // The Linux runtime ignores missing lockfile allow paths and cannot grant
  // these writes without also exposing other branch and checkout metadata.
  if (process.platform !== 'darwin') throw new Error(BORROWED_GIT_WRITE_UNAVAILABLE)
  const fresh = await prepareBorrowedGitWrite(scope.identity, scope.command)
  if (fresh.ref !== scope.ref) throw new Error('The worktree branch changed before the Git command could run.')
  const { gitDir, commonDir } = scope.identity
  const objects = join(commonDir, 'objects')
  const ref = join(commonDir, scope.ref)
  const log = join(commonDir, 'logs', scope.ref)
  for (const parent of [objects, dirname(ref), dirname(log)]) {
    if (await realpath(parent) !== parent) throw new Error('Git metadata paths must not be redirected.')
  }
  const index = ['index', 'index.lock'].map(name => join(gitDir, name))
  const files = scope.command.startsWith('git add ') ? index : [...index, ref, ref + '.lock', log,
    ...['HEAD.lock', 'logs/HEAD', 'COMMIT_EDITMSG', 'MERGE_HEAD', 'MERGE_MSG', 'MERGE_MODE', 'AUTO_MERGE'].map(name => join(gitDir, name))]
  for (const file of files) {
    const entry = await lstat(file).catch(error => {
      if (error.code !== 'ENOENT') throw error
    })
    if (entry && !entry.isFile()) throw new Error('Git metadata files must not be redirected.')
  }
  return [objects, ...files]
}
