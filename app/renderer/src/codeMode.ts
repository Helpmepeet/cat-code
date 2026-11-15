import { parse } from 'acorn'

export type CodeModeStatus = 'completed' | 'failed' | 'cancelled' | 'blocked' | 'yielded' | 'running'
export type CodeModeCall = { toolUseId: string; name: string; input: unknown; status: string; line?: number; result?: unknown; error?: string }
export type CodeModeEnvelope = {
  kind: 'code-mode'; cellId: string; generation: string; description: string; code: string
  status: CodeModeStatus; output: string; calls: CodeModeCall[]
  changedFiles: { path: string; additions?: number; deletions?: number }[]; error?: string; line?: number
}
/** Audit-shaped data from any other tool is ordinary output, not host provenance. */
export function codeModeForRow(row: { toolName: string; toolUseId: string; result: { codeMode?: CodeModeEnvelope } | null }): CodeModeEnvelope | undefined {
  return row.toolName === 'REPL' && row.result?.codeMode?.cellId === row.toolUseId ? row.result.codeMode : undefined
}
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value)
const line = (value: unknown) => value === undefined || (Number.isSafeInteger(value) && (value as number) > 0)
const count = (value: unknown) => value === undefined || (Number.isSafeInteger(value) && (value as number) >= 0)
const statuses = new Set(['completed', 'failed', 'cancelled', 'blocked', 'yielded', 'running'])
const callStatuses = new Set(['completed', 'failed', 'cancelled', 'blocked', 'running'])
/** Only the host audit envelope is accepted, never JSON parsed from selected output. */
export function parseCodeMode(value: unknown): CodeModeEnvelope | null {
  if (!object(value) || value.kind !== 'code-mode' || typeof value.cellId !== 'string' || !value.cellId ||
    typeof value.generation !== 'string' || !value.generation || typeof value.description !== 'string' ||
    typeof value.code !== 'string' || typeof value.output !== 'string' || typeof value.status !== 'string' || !statuses.has(value.status) ||
    !line(value.line) || (value.error !== undefined && typeof value.error !== 'string') ||
    !Array.isArray(value.calls) || !Array.isArray(value.changedFiles)) return null
  if (!value.calls.every(call => object(call) && typeof call.toolUseId === 'string' && !!call.toolUseId &&
    typeof call.name === 'string' && 'input' in call && typeof call.status === 'string' && callStatuses.has(call.status) && line(call.line) &&
    (call.error === undefined || typeof call.error === 'string'))) return null
  if (!value.changedFiles.every(file => object(file) && typeof file.path === 'string' && count(file.additions) && count(file.deletions))) return null
  if (new Set(value.calls.map(call => call.toolUseId)).size !== value.calls.length) return null
  return value as CodeModeEnvelope
}
export type CodeModeStep = { key: string; label: string; line?: number; calls: CodeModeCall[] }
export function codeModeInput(call: CodeModeCall): Record<string, unknown> {
  return object(call.input) ? call.input : {}
}
const stepsCache = new WeakMap<CodeModeEnvelope, readonly CodeModeStep[]>()
/** Standalone comments label the following observed calls; comments alone never imply execution. */
export function codeModeSteps(cell: CodeModeEnvelope): readonly CodeModeStep[] {
  const cached = stepsCache.get(cell)
  if (cached) return cached
  const sourceLines = cell.code.split('\n')
  let comments: { line: number; label: string }[] = []
  // Parse rather than regex-match strings, regex literals, and nested comments.
  // Incomplete or invalid source still has a useful per-call/line fallback.
  if (cell.code.length <= 256 * 1024) try {
    const candidates: { line: number; label: string; start: number }[] = []
    const program = parse(cell.code, {
      ecmaVersion: 'latest', sourceType: 'script', locations: true,
      allowAwaitOutsideFunction: true, allowReturnOutsideFunction: true,
      onComment: (_block, text, start, _end, location) => {
        if (location && /^\s*\/[/*]/.test(sourceLines[location.line - 1] ?? '') && text.trim()) {
          candidates.push({ line: location.line, label: text.trim().split('\n')[0]!, start })
        }
      },
    })
    let statement = 0
    comments = candidates.filter(comment => {
      while (statement < program.body.length && program.body[statement]!.end <= comment.start) statement++
      return statement >= program.body.length || program.body[statement]!.start > comment.start
    })
  } catch {
    comments = []
  }
  const groups = new Map<string, CodeModeStep>()
  for (const call of cell.calls) {
    const sourceLine = call.line !== undefined && call.line <= sourceLines.length ? call.line : undefined
    let comment: { line: number; label: string } | undefined
    if (sourceLine !== undefined) {
      let lo = 0, hi = comments.length
      while (lo < hi) {
        const mid = (lo + hi) >>> 1
        if (comments[mid]!.line <= sourceLine) lo = mid + 1
        else hi = mid
      }
      comment = comments[lo - 1]
    }
    const key = comment ? `comment:${comment.line}` : sourceLine ? `line:${sourceLine}` : `call:${call.toolUseId}`
    let group = groups.get(key)
    if (!group) {
      group = { key, label: comment?.label ?? (sourceLine ? sourceLines[sourceLine - 1]?.trim() || call.name : call.name), line: sourceLine, calls: [] }
      groups.set(key, group)
    }
    group.calls.push(call)
  }
  const result = [...groups.values()]
  stepsCache.set(cell, result)
  return result
}
const digestCache = new WeakMap<CodeModeEnvelope, string>()
export function codeModeCallCompleted(call: CodeModeCall): boolean {
  return (call.status === 'completed' || call.status === 'success') && !call.error &&
    !(object(call.result) && call.result.isError === true)
}
export function codeModeStepDigest(calls: readonly CodeModeCall[]): string | null {
  if (calls.length === 0) return null
  if (calls.every(call => call.name === 'Read')) {
    const files = new Set(calls.filter(codeModeCallCompleted).map(call => codeModeInput(call).file_path ?? codeModeInput(call).path).filter(path => typeof path === 'string'))
    return files.size ? `${files.size} ${files.size === 1 ? 'file' : 'files'} read` : null
  }
  if (calls.every(call => call.name === 'Bash' && /^\s*(?:test\s+-[efdrw]\s|\[\s+-[efdrw]\s)/.test(String(codeModeInput(call).command ?? '')))) {
    const completed = calls.filter(codeModeCallCompleted).length
    return completed ? `${completed} ${completed === 1 ? 'check' : 'checks'}` : null
  }
  if (calls.length === 1 && calls[0]!.name === 'Glob' && object(calls[0]!.result)) {
    const call = calls[0]!
    const receipt = call.result as Record<string, unknown>
    // CodeModeDispatch retains effective built-in structured data explicitly.
    // Missing/incomplete data and selected text cannot supply a file count.
    if (!codeModeCallCompleted(call) || receipt.isError !== false || receipt.dataComplete !== true || !object(receipt.data)) return null
    const files = receipt.data.numFiles
    if (Number.isSafeInteger(files) && Number(files) >= 0) return `${files} ${files === 1 ? 'file' : 'files'}`
  }
  return null
}
export function codeModeDigest(cell: CodeModeEnvelope): string {
  const cached = digestCache.get(cell)
  if (cached !== undefined) return cached
  let errors = 0, blocked = 0, stopped = 0
  for (const call of cell.calls) {
    if (call.status === 'blocked') blocked++
    else if (call.status === 'cancelled') stopped++
    else if (call.error || call.status === 'failed' || call.status === 'error') errors++
  }
  const reads = cell.calls.filter(call => ['Read', 'read_file'].includes(call.name) && codeModeCallCompleted(call))
  const files = new Set(reads.map(call => codeModeInput(call).file_path ?? codeModeInput(call).path).filter(path => typeof path === 'string'))
  const completed = cell.calls.filter(codeModeCallCompleted).length
  const parts = [cell.changedFiles.length ? `${cell.changedFiles.length} ${cell.changedFiles.length === 1 ? 'file' : 'files'} changed` : files.size ? `${files.size} ${files.size === 1 ? 'file' : 'files'} read` : codeModeStepDigest(cell.calls) ?? `${completed} ${completed === 1 ? 'call' : 'calls'}`]
  if (errors) parts.push(`${errors} ${errors === 1 ? 'error' : 'errors'}`)
  if (blocked) parts.push(`${blocked} blocked`)
  if (stopped) parts.push(`${stopped} stopped`)
  const result = parts.join(' · ')
  digestCache.set(cell, result)
  return result
}
