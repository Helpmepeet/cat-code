# Usage activity, tool errors, and chart interactions

Implemented the operator-requested activity heatmap and tool-error chart, following
a generated image reference, with the existing neutral black app surfaces.

- Activity is canonical tool requests by UTC date/hour, including subagents.
  Every day has 24 bounded counts reconciling to its request total. Future hours
  are outlined as not yet recorded. Hover/focus shows a tooltip; click pins a
  cell and selects that day in the existing charts. Arrow keys navigate the grid.
- Tool errors counts `tool_result.is_error === true` for results matched by tool
  ID within the same project/session/subagent scope. Omitted flags are non-error
  results per the engine's result shape; invalid flags are excluded. Result text
  is never inspected or retained. Counts describe reported tool outcomes, not
  inferred subprocess exit codes. Denied/interrupted outcomes may be errors too.
- Count and Rate change sorting and bar scale. Rate is errors / matched results,
  not errors / all requests. Clicking a row exposes non-error, error, and unmatched
  request counts. Missing results are not assumed successful. The existing top
  tool grouping retains exact error/result sums in Other.
- Token bars now inspect on hover; keyboard arrows move actual focus. Cache points
  respond to hover, keyboard, and click with date/value readouts. Donut legend
  buttons highlight a model and show its token count in the center.

Accounting matches the first retained result to the canonical request, handles
result-before-request file order, deduplicates copies, excludes future results,
and attributes outcomes to the request's date/window. Orphan results cannot enter
the denominator. Main and subagent namespaces remain separate. Only request IDs,
result flags, and timestamps enter the derived index, never result bodies.
Counting version 3 and index-v3.sqlite rebuild old derived state. Existing retained
history and user processes remain untouched. A full desktop restart loads the
new main-process validator.

Verification: 41 focused accounting/index/schema/summary/UI/text tests and 20
worker/boundary/reader/window tests passed. App typecheck, scoped sidecar typecheck,
renderer build and development engine build passed. Hidden isolated Electron
captures inspected at /tmp/usage-activity-additions/usage-activity.png and
usage-activity-narrow.png. The narrow heatmap scrolls horizontally, preserving
legible cells. Fixture data is illustrative. No provider calls, live-state edits,
commits, pushes, or live app restarts.

Reference: built-in image generation, ui-mockup prompt for a teal 30-day by 24-hour
activity matrix and coral tool-error bars with Count/Rate controls on black panels.
The generated reference is displayed in the task. The implementation follows its
panel hierarchy, grid, tooltip treatment, palette, and compact error rows while
using real counts and the native app typography. Visual operator acceptance is
still open; no blanket fidelity approval is claimed.

## Applied mockup refinements

The later image-only revisions had not changed the renderer. Applied them after
the operator identified that gap: the two panels now share an asymmetric desktop
row with independent heights, collapse on narrow screens, and the heatmap uses
fixed 10px square cells with 3px gaps and five solid charcoal/pink intensity steps.
No gradients, shadows or bevels apply to cells. Desktop and narrow actual-renderer
captures inspected at /tmp/usage-flat-pink/usage-activity.png and
usage-activity-narrow.png. Nine UI tests and renderer build passed. The final date
label was right-aligned after inspection to prevent SVG-edge clipping.

The 7-day layout now transposes the matrix: seven date rows and 24 hour columns,
using responsive square cells. This removes the narrow vertical strip and excess
empty space. The 30-day orientation stays unchanged. Keyboard directions follow
the displayed axes. Nine UI tests and renderer build passed; actual desktop and
narrow captures inspected under /tmp/usage-week-layout/.

Applied page-wide compact sizing after the operator flagged that the previous
fix only changed heatmap orientation: content maximum width 1360→1120px, metric
minimum height 100→82px, reduced panel padding/gaps, daily plot 200→170px, cache
plot 135→115px, smaller donut and summary values, and denser tool-error rows.
SVG plot geometry was reduced with the containers to preserve readable labels.
Nine UI tests and renderer build passed; desktop and narrow captures inspected
under /tmp/usage-compact-page/.
