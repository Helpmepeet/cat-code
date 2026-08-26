import type { ThreadGoalStatus } from '../../shared/protocol.js'
import type { ThreadGoalRow } from './goalMemoryState.js'
import {
  formatGoalNumber,
  goalStatusLabel,
  goalStatusTone,
  groupGoalRowsByWorkspace,
  isTerminalGoalStatus,
} from './goalsPageModel.js'

export function GoalsPage({
  rows,
}: {
  rows: readonly ThreadGoalRow[]
}) {
  const ongoingRows = rows.filter(row => !isTerminalGoalStatus(row.goal.status))
  const completeRows = rows.filter(row => isTerminalGoalStatus(row.goal.status))

  return (
    <main className="flex min-h-0 flex-1 overflow-auto px-8 py-7">
      <div className="mx-auto w-full max-w-[760px]">
        <header className="mb-5 flex items-start justify-between gap-4">
          <div>
            <h1 className="text-lg font-semibold tracking-tight text-text-primary">
              Goals
            </h1>
            <p className="mt-1 text-[13px] text-text-subtle">
              One goal per session across all sessions. {ongoingRows.length} ongoing,{' '}
              {completeRows.length} complete.
            </p>
          </div>
          <span className="rounded-full border border-shell-seam bg-shell-hover px-2.5 py-1 text-[11px] font-medium text-text-subtle">
            Read-only
          </span>
        </header>

        {rows.length === 0 ? (
          <EmptyGoal />
        ) : (
          <>
            <GoalSection label="Ongoing" rows={ongoingRows} />
            <GoalSection label="Complete" rows={completeRows} />
          </>
        )}

        <div className="mt-4 rounded-lg border border-shell-seam bg-shell-hover/40 px-4 py-3 text-[12px] leading-relaxed text-text-subtle">
          Use the <code className="font-mono">/goal</code> command to create,
          replace, pause, resume, or clear a goal.
        </div>
      </div>
    </main>
  )
}

function EmptyGoal() {
  return (
    <section className="rounded-xl border border-dashed border-shell-seam bg-shell-hover/35 px-8 py-10 text-center">
      <div className="text-sm font-semibold text-text-muted">
        No session goals
      </div>
      <p className="mx-auto mt-2 max-w-[420px] text-[12.5px] leading-relaxed text-text-subtle">
        Set a goal with the <code className="font-mono">/goal</code> command and
        it appears here when its session is available.
      </p>
    </section>
  )
}

function GoalSection({
  label,
  rows,
}: {
  label: string
  rows: readonly ThreadGoalRow[]
}) {
  if (rows.length === 0) return null
  const groups = groupGoalRowsByWorkspace(rows)

  return (
    <section className="mb-6">
      <div className="mb-3 flex items-center gap-2">
        <h2 className="text-[11px] font-bold uppercase tracking-[0.1em] text-text-muted">
          {label}
        </h2>
        <span className="text-[10.5px] text-text-subtle">{rows.length}</span>
      </div>
      {groups.map(group => (
        <div key={`${label}-${group.workspace}`} className="mb-4 last:mb-0">
          <div className="mb-2 flex items-center gap-2 px-0.5">
            <span className="font-mono text-[10px] font-semibold text-text-subtle">
              {group.workspace}
            </span>
            <div className="h-px flex-1 bg-shell-seam" />
            <span className="text-[10px] text-text-subtle">{group.rows.length}</span>
          </div>
          <div className="flex flex-col gap-2">
            {group.rows.map(row => (
              <GoalCard key={row.appSessionId} row={row} />
            ))}
          </div>
        </div>
      ))}
    </section>
  )
}

function GoalCard({ row }: { row: ThreadGoalRow }) {
  const { goal } = row
  return (
    <section className="rounded-xl border border-shell-seam bg-shell-chrome p-5">
      <div className="mb-4 flex flex-wrap items-center gap-x-2 gap-y-1">
        <StatusBadge status={goal.status} />
        <span className="text-[12px] text-text-muted">{row.displayLabel}</span>
        <span className="font-mono text-[11px] text-text-subtle">
          {goal.goalId}
        </span>
        <div className="basis-full text-[11px] text-text-subtle">
          Workspace <span className="font-mono">{row.cwd}</span>
        </div>
      </div>

      <h2 className="mb-4 text-base font-semibold leading-snug text-text-primary">
        {goal.objective}
      </h2>

      {goal.statusNote ? (
        <p className="mb-4 text-[13px] leading-relaxed text-text-muted">
          {goal.statusNote}
        </p>
      ) : null}

      <div className="grid gap-3 sm:grid-cols-4">
        <Metric label="Tokens used" value={formatGoalNumber(goal.tokensUsed)} />
        <Metric
          label="Token budget"
          value={
            goal.tokenBudget === undefined
              ? 'unbounded'
              : formatGoalNumber(goal.tokenBudget)
          }
        />
        <Metric
          label="Automatic turns"
          value={`${goal.continuationTurns} of ${goal.maxContinuationTurns}`}
        />
        <Metric label="Time used" value={`${goal.timeUsedSeconds}s`} />
      </div>

      <pre className="mt-5 whitespace-pre-wrap rounded-lg border border-shell-seam bg-app-bg p-4 font-mono text-[12px] leading-relaxed text-text-muted">
        {goal.summary}
      </pre>
    </section>
  )
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-shell-seam bg-shell-hover/40 px-3 py-2">
      <div className="text-[10px] font-bold uppercase tracking-[0.08em] text-text-subtle">
        {label}
      </div>
      <div className="mt-1 font-mono text-[13px] text-text-muted">{value}</div>
    </div>
  )
}

function StatusBadge({ status }: { status: ThreadGoalStatus }) {
  // Tolerant fallback: an unknown status from a newer engine renders neutrally
  // rather than throwing, and still never borrows the success tone.
  const label = goalStatusLabel(status)
  const tone = goalStatusTone(status)
  return (
    <span
      className={`rounded-full border px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.07em] ${tone}`}
    >
      {label}
    </span>
  )
}
