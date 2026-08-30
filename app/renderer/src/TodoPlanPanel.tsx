import type { TodoPlan, TodoPlanItem } from './todoPlan.js'

/**
 * The todo plan's two display halves: the compact readout that rides the
 * activity byline, and the panel it opens on hover.
 *
 * Both are read-only projections of `selectTodoPlan` (`todoPlan.ts`) — nothing
 * here is interactive, nothing here writes, and the plan is the engine's own
 * `TodoWrite` input rather than anything the renderer authored.
 *
 * The panel is deliberately NOT `POPOVER_PANEL`. The composer's popovers are
 * menus you act in; this is a readout you glance at, and the operator chose a
 * frameless treatment for it (2026-08-29): no border, the window-chrome ground,
 * and the `--card-ring` hairline the elevation tokens already pair with
 * (`theme.css:180-190` — "the hairline one card draws INSIDE its shadow"). The
 * one other floating surface that carries that ring is the question card
 * (`AskQuestionFlow.tsx:440`).
 */

/** Row tone by status. Literal classes only — the Tailwind v4 dynamic-class trap. */
const ROW_TEXT: Record<TodoPlanItem['status'], string> = {
  completed: 'text-text-ghost',
  in_progress: 'font-medium text-text-primary',
  pending: 'text-text-muted',
}

/**
 * The step marker. Completed is DIMMED rather than tinted green: `--tone-good`
 * means a success event, and a finished checklist item is not one — dimming
 * keeps the eye on the row that is actually running (operator call).
 */
function StepMark({ status }: { status: TodoPlanItem['status'] }) {
  if (status === 'completed') {
    return <span className="block h-[7px] w-[7px] rounded-full bg-text-ghost" />
  }
  if (status === 'in_progress') {
    return (
      <span className="block h-[7px] w-[7px] animate-pulse rounded-full bg-accent" />
    )
  }
  return (
    <span className="block h-[7px] w-[7px] rounded-full border border-text-ghost" />
  )
}

/**
 * One step. The connector dropping to the next marker is what makes the list
 * read as an ordered path rather than a set: solid behind the current step,
 * dashed ahead of it, because what is left is not queued-and-waiting so much as
 * not yet reached.
 */
function StepRow({ item, last }: { item: TodoPlanItem; last: boolean }) {
  const connector = last
    ? null
    : item.status === 'pending'
      ? 'absolute left-1/2 top-[13px] bottom-[-8px] -translate-x-1/2 border-l border-dashed border-white/10'
      : 'absolute left-1/2 top-[13px] bottom-[-8px] -translate-x-1/2 border-l border-white/[0.14]'
  return (
    <div className={`relative flex items-start gap-[11px] py-1 text-[12.5px] leading-[1.45] ${ROW_TEXT[item.status]}`}>
      <span className="relative flex h-[19px] w-[11px] shrink-0 items-center justify-center">
        <StepMark status={item.status} />
        {connector === null ? null : <span aria-hidden className={connector} />}
      </span>
      <span>{item.content}</span>
    </div>
  )
}

/**
 * The panel. `max-h` + scroll matches the account list's own cap
 * (`ComposerActionsBar.tsx:522`), because a plan has no upper bound on length.
 */
export function TodoPlanPanel({ plan }: { plan: TodoPlan }) {
  return (
    <div
      role="status"
      aria-label={`Todo, step ${plan.step ?? 0} of ${plan.total}`}
      className="absolute bottom-full right-0 z-40 mb-1.5 w-[380px] overflow-hidden rounded-[10px] bg-shell-chrome shadow-[var(--elev-popover),0_0_0_1px_var(--card-ring)]"
    >
      <div className="flex items-center justify-between px-[13px] pb-1.5 pt-[7px] text-[10px] font-semibold uppercase tracking-[0.03em]">
        <span className="text-accent">Todo</span>
        <span className="font-mono text-[10px] font-normal normal-case tracking-normal tabular-nums text-text-faint">
          {plan.step ?? 0}/{plan.total}
        </span>
      </div>
      <div className="max-h-[300px] overflow-y-auto px-[13px] pb-[11px] pt-0.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {plan.items.map((item, index) => (
          <StepRow
            item={item}
            key={`${index}:${item.content}`}
            last={index === plan.items.length - 1}
          />
        ))}
      </div>
    </div>
  )
}

/**
 * The byline readout plus its panel. `group` is the hover/focus host, and the
 * span is focusable so the panel is reachable without a pointer — the roster's
 * popover took the same `group-hover:/group-focus-within:` pair for the same
 * reason (`OrchestratorRoster.tsx:86-88`).
 *
 * `title` carries what the bare fraction cannot say on its own, the way the
 * context gauge and the token byline already do.
 */
export function TodoStepReadout({
  plan,
  readout,
}: {
  plan: TodoPlan
  readout: string
}) {
  return (
    <span className="group relative ml-auto shrink-0">
      <span
        className="cursor-default font-mono text-[11px] tabular-nums text-text-subtle outline-none"
        tabIndex={0}
        title={`Step ${plan.step ?? 0} of ${plan.total} in the current plan`}
      >
        {readout}
      </span>
      <span className="hidden group-hover:block group-focus-within:block">
        <TodoPlanPanel plan={plan} />
      </span>
    </span>
  )
}
