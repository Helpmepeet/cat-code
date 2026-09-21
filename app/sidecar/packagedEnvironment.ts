import { delimiter, dirname, join } from 'node:path'

export function packagedBinPath(execPath: string): string {
  return join(dirname(dirname(execPath)), 'bin')
}

export function prependPackagedBinToPath(
  execPath: string,
  currentPath: string | undefined,
): string {
  const bin = packagedBinPath(execPath)
  const existing = (currentPath ?? '')
    .split(delimiter)
    .filter(entry => entry.length > 0 && entry !== bin)
  return [bin, ...existing].join(delimiter)
}
