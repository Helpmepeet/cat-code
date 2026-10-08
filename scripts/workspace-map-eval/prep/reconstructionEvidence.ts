import { isAbsolute, resolve } from 'node:path'

export function hasTaskTimeEvidence(diffMatches: boolean[], numberedChangedSupport: number, contradictions: number): boolean {
  return contradictions === 0
    && diffMatches.every(Boolean)
    && (diffMatches.some(Boolean) || numberedChangedSupport > 0)
}

export function isFileAssociatedOutput(command: string, rel: string, root: string): boolean {
  let input: unknown
  try { input = JSON.parse(command) } catch { return false }
  if (typeof input === 'string') {
    try { input = JSON.parse(input) } catch { return false }
  }
  const target = resolve(root, rel)
  const matches = (value: unknown): boolean => {
    if (Array.isArray(value)) return value.some(matches)
    if (!value || typeof value !== 'object') return false
    return Object.entries(value).some(([key, item]) => {
      if (['file_path', 'notebook_path', 'path'].includes(key) && typeof item === 'string') {
        const candidate = isAbsolute(item) ? resolve(item) : resolve(root, item)
        if (candidate === target) return true
      }
      return matches(item)
    })
  }
  return matches(input)
}

export function supportsChangedLines(
  numberedRun: [number, string][],
  candidateLines: string[],
  baseLines: string[],
): boolean {
  return numberedRun.every(([line, text]) => candidateLines[line - 1] === text)
    && numberedRun.some(([line, text]) => baseLines[line - 1] !== text)
}
