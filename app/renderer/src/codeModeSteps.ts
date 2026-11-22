import { visibleAutoModeReason } from './autoModeReview.js'
import { codeModeInput, type CodeModeCall } from './codeMode.js'
import { scopedTranscriptFilePath } from './transcriptFileScope.js'
import { deriveToolFamily, type NestedToolUseRow, type ToolFamily } from './transcriptProjector.js'
import { displayFilePath, singlePatchFile, toolCardFilePath } from './transcriptToolTarget.js'
import { countDiff, selectToolDiffs } from './toolDiffs.js'

type Member = {
  call: CodeModeCall
  child?: NestedToolUseRow
  family: ToolFamily
  line?: number
  error?: string
  file: string | null
  cwd: string | null
  status?: string
}

export type CodeModeStep = {
  key: string
  members: Member[]
  changedPaths: Set<string>
  adds: number
  dels: number
}

function codeModeStepPath(row: Pick<NestedToolUseRow, 'toolFamily' | 'toolName' | 'input' | 'result'>): string | null {
  if (row.toolFamily === 'edit' && (row.result?.fileDiffs?.length ?? 0) > 1) return null
  return toolCardFilePath(row) ?? (row.toolFamily === 'edit' ? singlePatchFile(row) : null)
}

export function codeModeStepHasError(status?: string): boolean {
  return status === 'failed' || status === 'blocked' || status === 'cancelled'
}

export function codeModeMcpName(name: string): string {
  const [, server, ...rest] = name.split('__')
  const joined = rest.join('_')
  const prefix = `${server}_`
  const tool = (joined.startsWith(prefix) ? joined.slice(prefix.length) : joined).replaceAll('_', ' ')
  if (!server || !tool) return name
  return `${server} · ${tool}`
}

export function codeModeStepDirectory(step: CodeModeStep): string {
  const first = step.members[0]!
  if (!first.file) return ''
  const path = displayFilePath(first.file, first.cwd)
  const prefix = path.slice(0, Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1)
  return step.members.every(member => member.file && displayFilePath(member.file, member.cwd).startsWith(prefix) &&
    !/[/\\]/.test(displayFilePath(member.file, member.cwd).slice(prefix.length))) ? prefix : ''
}

export function codeModeSteps({ parent, calls, lineCount, cwd, scopes, generation }: {
  parent: NestedToolUseRow; calls: readonly CodeModeCall[]; lineCount: number; cwd: string | null
  scopes?: ReadonlyMap<string, string>; generation?: string
}) {
  const children = new Map<string, NestedToolUseRow>()
  for (const child of parent.children) {
    if (child.kind === 'tool-use' && child.sessionId === parent.sessionId &&
        (!generation || !child.codeMode || child.codeMode.cellId === parent.toolUseId && child.codeMode.generation === generation)) {
      children.set(child.toolUseId, child)
    }
  }
  const steps: CodeModeStep[] = []
  const listedPaths = new Set<string>()
  const reasons = new Set<string>()
  const families = new Map<NestedToolUseRow['toolFamily'], number>()
  let lastEditedPath: string | null = null
  for (const call of calls) {
    const child = children.get(call.toolUseId)
    const family = deriveToolFamily(call.name)
    const sourceCwd = (child && scopes?.get(child.id)) ?? cwd
    const line = call.line && call.line <= lineCount ? call.line : undefined
    const file = codeModeStepPath({ toolFamily: family, toolName: call.name, input: codeModeInput(call), result: child?.result ?? null })
    const settled = call.error || child?.result?.isError ? 'failed' : undefined
    const state = call.status === 'completed' ? settled
      : call.status === 'pending' ? 'running' : call.status === 'error' ? 'failed' : call.status
    const status = state === 'failed' && child?.autoModeReview?.outcome === 'blocked' ? 'blocked' : state
    const member: Member = { call, child, family, line, error: call.error, file, cwd: sourceCwd, status }
    const editPath = family === 'edit' && file ? scopedTranscriptFilePath(file, sourceCwd ?? undefined) : null
    const last = steps.at(-1)
    const first = last?.members[0]
    const repeat = first && (editPath ? editPath === lastEditedPath
      : family !== 'edit' && !!line && first.line === line && first.call.name === call.name)
    const step: CodeModeStep = repeat && last ? last : {
      key: call.toolUseId, members: [], changedPaths: new Set(), adds: 0, dels: 0,
    }
    if (step !== last) steps.push(step)
    step.members.push(member)
    lastEditedPath = editPath

    const diffs = selectToolDiffs(child?.result)
    for (const diff of diffs) {
      const counts = countDiff(diff)
      step.adds += counts.adds
      step.dels += counts.dels
    }
    if ((status === undefined || status === 'success') && (family === 'edit' || family === 'write' || family === 'notebook')) {
      const input = codeModeInput(call)
      const paths = diffs.length ? diffs.map(diff => diff.filePath) : file ? [file]
        : family === 'notebook' && typeof input.notebook_path === 'string' ? [input.notebook_path] : []
      for (const path of paths) {
        const scoped = scopedTranscriptFilePath(path, sourceCwd ?? undefined)
        step.changedPaths.add(scoped)
        listedPaths.add(scoped)
      }
    }
    if (codeModeStepHasError(status)) {
      if (call.error) reasons.add(call.error)
      if (child?.result?.isError && child.result.content) reasons.add(child.result.content)
      const review = visibleAutoModeReason(child?.autoModeReview)
      if (review) reasons.add(review)
    }
    families.set(family, (families.get(family) ?? 0) + 1)
  }
  return { steps, listedPaths, reasons, families }
}
