import { isAbsolute, relative, resolve, sep } from 'node:path'

const REPO = '/Users/pt/cat-code'

export function isRepositoryPath(path: string, cwd: string, repo = REPO): boolean {
  const fromRepo = relative(resolve(repo), resolve(cwd, path))
  return fromRepo !== '' && fromRepo !== '..' && !fromRepo.startsWith(`..${sep}`) && !isAbsolute(fromRepo)
}
