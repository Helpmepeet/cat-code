import type { ThreadGoalSnapshot } from '../../shared/protocol.js'

export function GoalsPage({
  snapshot,
  sessionLabel,
}: {
  snapshot: ThreadGoalSnapshot | null
  sessionLabel?: string
}) {
  return (
    <main className="flex min-h-0 flex-1 overflow-auto px-8 py-7">
      <div className="mx-auto w-full max-w-[760px]">
        <header className="mb-5 flex items-start justify-between gap-4">
          <div>
            <h1 className="text-lg font-semibold tracking-tight text-text-primary">
              Goals
            </h1>
            <p className="mt-1 text-[13px] text-text-subtle">
              Current thread goal from the live engine session.
            </p>
            {sessionLabel ? (
              <p className="mt-1 font-mono text-[11px] text-text-subtle">
                {sessionLabel}
              </p>
            ) : null}
          </div>
          <span className="rounded-full border border-shell-seam bg-shell-hover px-2.5 py-1 text-[11px] font-medium text-text-subtle">
            Read-only snapshot
          </span>
        </header>

        {!snapshot ? <EmptyGoal /> : <GoalCard goal={snapshot} />}

        <div className="mt-4 rounded-lg border border-shell-seam bg-shell-hover/40 px-4 py-3 text-[12px] leading-relaxed text-text-subtle">
          Create, replace, pause, resume, and clear remain on the engine's
          existing <code className="font-mono">/goal</code> command path. No
          desktop writer boundary is exposed in this tranche.
        </div>
      </div>
    </main>
  )
}

function EmptyGoal() {
  return (
    <section className="rounded-xl border border-dashed border-shell-seam bg-shell-hover/35 px-8 py-10 text-center">
      <div className="text-sm font-semibold text-text-muted">
        No active thread goal
      </div>
      <p className="mx-auto mt-2 max-w-[420px] text-[12.5px] leading-relaxed text-text-subtle">
        This session has no persisted goal snapshot. Goals appear here after the
        engine creates one through its real goal machinery.
      </p>
    </section>
  )
}

function GoalCard({ goal }: { goal: ThreadGoalSnapshot }) {
  return (
    <section className="rounded-xl border border-shell-seam bg-shell-chrome p-5">
      <div className="mb-4 flex items-center gap-2">
        <StatusBadge status={goal.status} />
        <span className="font-mono text-[11px] text-text-subtle">
          {goal.goalId}
        </span>
      </div>

      <h2 className="mb-4 text-base font-semibold leading-snug text-text-primary">
        {goal.objective}
      </h2>

      <div className="grid gap-3 sm:grid-cols-3">
        <Metric label="Tokens used" value={formatNumber(goal.tokensUsed)} />
        <Metric
          label="Token budget"
          value={goal.tokenBudget === undefined ? 'unbounded' : formatNumber(goal.tokenBudget)}
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

function StatusBadge({ status }: { status: ThreadGoalSnapshot['status'] }) {
  const label = status === 'budget_limited' ? 'budget limited' : status
  const tone =
    status === 'active'
      ? 'border-tone-good/30 bg-tone-good/10 text-tone-good'
      : status === 'complete'
        ? 'border-accent/30 bg-accent/10 text-accent'
        : status === 'budget_limited'
          ? 'border-tone-warn/30 bg-tone-warn/10 text-tone-warn'
          : 'border-shell-seam bg-shell-hover text-text-subtle'
  return (
    <span
      className={`rounded-full border px-2.5 py-1 text-[11px] font-semibold uppercase tracking-[0.07em] ${tone}`}
    >
      {label}
    </span>
  )
}

function formatNumber(value: number): string {
  return value.toLocaleString('en-US')
}
