import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { ScheduledTaskInput } from '../shared/scheduledTasks.js'

/** Explicit preset creation imports a completed legacy cursor once. Subsequent runs use only Cat Code state. */
export function workspaceMapSchedule(cwd: string, storageDir: string): ScheduledTaskInput {
  if (!existsSync(join(cwd, 'scripts/workspaceMapRefreshState.ts'))) throw new Error('This project does not contain the workspace-map refresh helper')
  const stateDir = join(storageDir, 'workspace-map-refresh', createHash('sha256').update(cwd).digest('hex').slice(0, 16))
  const legacy = join(homedir(), '.codex/automations/refresh-workspace-routing-map/state.json')
  if (!existsSync(join(stateDir, 'state.json')) && existsSync(legacy)) {
    const raw = readFileSync(legacy, 'utf8')
    const state = JSON.parse(raw) as { schemaVersion?: unknown; repositoryRoot?: unknown; run?: { status?: unknown }; cursor?: unknown }
    if (state.schemaVersion === 2 && state.repositoryRoot === cwd) {
      if (state.run?.status === 'reviewing' || state.run?.status === 'committing') throw new Error('Finish or block the current workspace-map refresh before importing it')
      mkdirSync(stateDir, { recursive: true })
      writeFileSync(join(stateDir, 'state.json'), raw, { flag: 'wx', mode: 0o600 })
    }
  }
  // JSON quoting keeps paths with spaces readable in a prompt; this is instruction text, never executed by main.
  const statePath = JSON.stringify(stateDir)
  return {
    name: 'Refresh workspace maps', enabled: false, model: '', effort: 'default', permissionMode: 'auto',
    schedule: { kind: 'daily', time: '03:00', timeZone: 'Asia/Bangkok', day: 0 },
    prompt: `Refresh docs/maps/ end to end in this project without check-ins. Edit only docs/maps/*.md. Preserve unrelated work and staging. Do not push, reset, discard work, or change source.\n\nThe refresh helper owns its state and commits reviewed map changes. Read its contract with bun run scripts/workspaceMapRefreshState.ts help. Every helper command must use --state-dir ${statePath}. Do not hand-edit helper state.\n\nRun start, read the resulting state.json, and use its captured source SHA and changed paths as authoritative. Read WORKSPACE_MAP.md, then the relevant focused maps and committed source. Review new, deleted, and renamed owners; for baseline or divergence review the full source-domain inventory. Leave an active review lease alone. Adopt dirty map paths only after proving they belong to this refresh and reviewing their diff.\n\nKeep the root map concise, preserve the canonical First Files To Inspect, Tests And Validation, and Traps And Stale Assumptions sections, and synchronize refresh dates only for substantive changes. Complete supported map creation, splitting, merging, and retirement in this run.\n\nRun check --run-id <id>, review the final diff, then finish with that run ID, its reviewed map hash, every changed map as an explicit --map, and a semantic --summary. Add --baseline-reviewed only after completing baseline or divergence review. A verified no-op creates no empty commit. Lint checks structure and references, not semantic completeness.\n\nIf blocked, use block --run-id <id> --blocker <reason> and stop. If HEAD moved, block and restart against the new target after reviewing retained edits.\n\nReport complete, no-op, or blocked; routing changes, validation, source and map commit SHAs, cursor advancement, and actionable blockers.`,
  }
}
