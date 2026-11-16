import { parse } from 'acorn'
import type { CodeModeEnvelope, CodeModeStep } from './codeMode.js'

// Source parsing belongs to Script presentation, not the shared audit projector.
const stepsCache = new WeakMap<CodeModeEnvelope, readonly CodeModeStep[]>()
type SourcePlan = { sourceLines: string[]; comments: { line: number; label: string }[] }
const sourcePlans = new Map<string, SourcePlan>()
const MAX_SOURCE_PLANS = 8
const MAX_SOURCE_PLAN_CHARS = 512 * 1024
let sourcePlanChars = 0

function sourcePlan(code: string): SourcePlan {
  const cached = sourcePlans.get(code)
  if (cached) {
    sourcePlans.delete(code)
    sourcePlans.set(code, cached)
    return cached
  }
  const sourceLines = code.split('\n')
  let comments: { line: number; label: string }[] = []
  // Parse rather than regex-match strings, regex literals, and nested comments.
  // Incomplete or invalid source still has a useful per-call/line fallback.
  if (code.length <= 256 * 1024) try {
    const candidates: { line: number; label: string; start: number }[] = []
    const program = parse(code, {
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
  const plan = { sourceLines, comments }
  if (code.length <= 256 * 1024) {
    sourcePlans.set(code, plan)
    sourcePlanChars += code.length
    while (sourcePlans.size > MAX_SOURCE_PLANS || sourcePlanChars > MAX_SOURCE_PLAN_CHARS) {
      const oldest = sourcePlans.keys().next().value!
      sourcePlans.delete(oldest)
      sourcePlanChars -= oldest.length
    }
  }
  return plan
}

/** Standalone comments label the following observed calls; comments alone never imply execution. */
export function codeModeSteps(cell: CodeModeEnvelope): readonly CodeModeStep[] {
  const cached = stepsCache.get(cell)
  if (cached) return cached
  const { sourceLines, comments } = sourcePlan(cell.code)
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
