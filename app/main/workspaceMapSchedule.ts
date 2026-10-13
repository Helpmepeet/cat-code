import { createHash, randomUUID } from 'node:crypto'
import { closeSync, existsSync, fsyncSync, linkSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { ScheduledTaskInput } from '../shared/scheduledTasks.js'

/** Explicit preset creation imports a completed legacy cursor once. Subsequent runs use only Cat Code state. */
export function workspaceMapSchedule(cwd: string, storageDir: string): ScheduledTaskInput {
  if (!existsSync(join(cwd, 'scripts/workspaceMapRefreshState.ts'))) throw new Error('This project does not contain the workspace-map refresh helper')
  const stateDir = join(storageDir, 'workspace-map-refresh', createHash('sha256').update(cwd).digest('hex').slice(0, 16))
  const stateFile = join(stateDir, 'state.json')
  const legacy = join(homedir(), '.codex/automations/refresh-workspace-routing-map/state.json')
  if (existsSync(stateFile)) {
    try {
      const state = JSON.parse(readFileSync(stateFile, 'utf8')) as { schemaVersion?: unknown; repositoryRoot?: unknown }
      if (state.schemaVersion !== 2 || state.repositoryRoot !== cwd) throw new Error('Invalid native state')
    } catch { throw new Error('Workspace-map state could not be read. Fix it before creating this task.') }
  } else if (existsSync(legacy)) {
    const raw = readFileSync(legacy, 'utf8')
    const state = JSON.parse(raw) as { schemaVersion?: unknown; repositoryRoot?: unknown; run?: { status?: unknown }; cursor?: unknown }
    if (state.schemaVersion === 2 && state.repositoryRoot === cwd) {
      if (state.run?.status === 'reviewing' || state.run?.status === 'committing') throw new Error('Finish or block the current workspace-map refresh before importing it')
      mkdirSync(stateDir, { recursive: true })
      const temp = join(stateDir, `${randomUUID()}.tmp`)
      try {
        const fd = openSync(temp, 'wx', 0o600)
        try { writeFileSync(fd, raw); fsyncSync(fd) } finally { closeSync(fd) }
        // Publish complete bytes exclusively: an existing native cursor must never be replaced.
        linkSync(temp, stateFile)
        const dir = openSync(stateDir, 'r')
        try { fsyncSync(dir) } finally { closeSync(dir) }
      } finally { try { unlinkSync(temp) } catch { /* A failed write may not have created the temporary file. */ } }
    }
  }
  const statePath = `'${stateDir.replaceAll("'", "'\\''")}'`
  return {
    name: 'Refresh workspace maps', enabled: false, model: '', effort: 'default', permissionMode: 'auto',
    schedule: { kind: 'daily', time: '03:00', timeZone: 'Asia/Bangkok', day: 0 },
    prompt: `Refresh docs/maps/ end to end in this project without check-ins. Edit only docs/maps/*.md. Preserve unrelated work and staging. Do not push, reset, discard work, or change source.\n\nThe refresh helper owns its state and commits reviewed map changes. Read its contract with bun run scripts/workspaceMapRefreshState.ts help. Every helper command must use --state-dir ${statePath}. Do not hand-edit helper state.\n\nRun start, read the resulting state.json, and use its captured source SHA and changed paths as authoritative. Read WORKSPACE_MAP.md, then the relevant focused maps and committed source. Review new, deleted, and renamed owners; for baseline or divergence review the full source-domain inventory. Leave an active review lease alone. If start refuses another owner's active lease, report blocked and stop without blocking that lease. Adopt dirty map paths only after proving they belong to this refresh and reviewing their diff.\n\nKeep the root map concise, preserve the canonical First Files To Inspect, Tests And Validation, and Traps And Stale Assumptions sections, and synchronize refresh dates only for substantive changes. Complete supported map creation, splitting, merging, and retirement in this run.\n\nRun check --run-id <id>, review the final diff, then finish with that run ID, its reviewed map hash, every changed map as an explicit --map, and a semantic --summary. Add --baseline-reviewed only after completing baseline or divergence review. A verified no-op creates no empty commit. Lint checks structure and references, not semantic completeness.\n\nIf blocked after acquiring your own run, use block --run-id <id> --blocker <reason> for that run and stop. If HEAD moved, block your run and restart against the new target after reviewing retained edits.\n\nReport complete, no-op, or blocked; routing changes, validation, source and map commit SHAs, cursor advancement, and actionable blockers.`,
  }
}
