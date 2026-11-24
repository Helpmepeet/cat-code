import type { NestedTranscriptRow } from './transcriptProjector.js'

type SubagentBranch = Extract<NestedTranscriptRow, { kind: 'tool-use' | 'orphaned-agent' }>
const branchesByRows = new WeakMap<readonly NestedTranscriptRow[], ReadonlyMap<string, SubagentBranch>>()

export function selectParentSubagentBranches(rows: readonly NestedTranscriptRow[]): ReadonlyMap<string, SubagentBranch> {
  const cached = branchesByRows.get(rows)
  if (cached) return cached
  const branches = new Map<string, SubagentBranch>()
  for (const row of rows) {
    if (row.kind === 'orphaned-agent') branches.set(row.missingToolUseId, row)
    if (row.kind !== 'tool-use') continue
    if (row.toolFamily === 'agent') branches.set(row.toolUseId, row)
    // A Script groups calls without owning workers; an Agent owns its own workers.
    else if (row.toolName === 'REPL') {
      for (const [id, branch] of selectParentSubagentBranches(row.children)) branches.set(id, branch)
    }
  }
  branchesByRows.set(rows, branches)
  return branches
}
