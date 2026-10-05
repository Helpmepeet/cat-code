# Resource-waste implementation review, 2026-10-04

Seven confirmed findings: **0 HIGH, 6 MEDIUM, 1 LOW** (5 user-visible,
1 internal, 1 prose). Five VALID fixes and two INHERITED fixes are verified
closed; none deferred. Two candidates were false positives for this scope.
Intent: all eight requested improvements remain implemented. Coverage is thin
for native renderer geometry/accessibility and full Electron lifecycle behavior;
those two groups of effects remain UNPROVEN, with operator steps below.

## Scope and provenance

This session implemented `ae101514`, the 63-file, 3,147-line performance change.
That commit's hunks and the original pasted request were the review scope, not
the whole shared branch. All five difficulty signals applied: reach, concurrency,
trust boundaries, runtime spread, and changed derivations. A fresh correctness
reviewer, an integration reviewer, an executing evidence reviewer, and root's
written-spec review provided four distinct lenses. The existing collaboration
thread limit required reusing two workers with new review assignments; integration
and execution prioritized other workers' implementation areas.

The spec was the original eight-finding request in the supplied `Pasted text.txt`,
not another repository plan. Its eight mechanisms are present: conservative
Markdown reuse, linear framing, bounded MCP diagnostics, outer mount limits,
idle worker/cache suppression, projection comparison, display-only child-read
budgets, and bounded timezone/calendar caches. The review repairs preserve the
architecture, raw events, full resume reader, and resource ceilings.

Concurrent commits `1d518b97` and `79b6eeca`, and the pre-existing untracked
skills, `.claude`, design HTML, and fixture were excluded and preserved. No tests
were deleted/skipped, no dependencies/lockfiles/build/CI/agent rules changed,
and no production build/install/GUI/provider/live-state operation was performed.
The implementation's replay test changed its DOM expectation to a bounded window
while preserving the full model assertion. Benchmark scripts, maintained maps,
ADRs, and dated reports implement the requested verification/documentation work.
The review's new `paneHeightOwnership.ts` has two production renderer consumers;
it is needed to repair correction ownership and introduces no test-only seam.

## Validated findings and closure

| # | Severity | Impact | Owner | Verdict | Problem and verified repair |
|---|---|---|---|---|---|
| 1 | MEDIUM | user-visible | `TranscriptView.tsx`, body-correction effect | VALID, fixed | A window move changed the leading spacer without changing document height. Subtracting that spacer movement generated writes `[9000, 472, 9000]`. The effect now excludes only prefix movement actually compensated by the keyed prepend anchor. Pure scrolling produces `[9000]`. |
| 2 | MEDIUM | user-visible | `markdownRenderPlan.ts`, settled-tree reuse | VALID, fixed | Unchanged source reused the old plugin output. Reuse now compares plugin identity and append policy as well as source/math/callout state; changing the pipeline renders its new class. |
| 3 | MEDIUM | user-visible | `sessionsCatalogRunner.ts`, source preflight | VALID, fixed | A fingerprint exception prevented the ordinary worker from recovering. Preflight failures now fall through to enumeration. An isolated `ENOTDIR` fixture changes from zero starts/error to a real worker start, exit 0, and delivered catalog. |
| 4 | MEDIUM | user-visible | `TranscriptView.tsx` and `BoundedMarkdown.tsx`, nested correction ownership | INHERITED, fixed | The new outer container exposed an existing assumption that all body reports were independent. A 40-pixel Markdown change was also counted by its parent, moving 80 pixels. Retained nearest nested owners' height changes are now excluded from parent reports, including across commits; separate scroll panes keep separate ownership. The production DOM probe moves 40 pixels. |
| 5 | MEDIUM | user-visible | `TranscriptView.tsx`, correction offset | INHERITED, fixed | The new outer caller exposed the old container-wide offset approximation: a lower append moved a reader of older content by 82 pixels. List edits now locate the correction at the first changed entry. Lower append produces no position write. |
| 6 | MEDIUM | internal | `mcpStderrCapture.ts`, disposal | VALID, fixed | Timeout acquisition cleanup cleared the excerpt before the failure handler consumed it. Disposal now detaches/stops collection but preserves the bounded excerpt until `take()`. A real stdio timeout fixture changes from `startupDiagnosticLogged:false` to `true`; connected retention remains zero. |
| 7 | LOW | prose | `sessionsCatalogRunner.ts`, cadence comment | VALID, fixed | The comment claimed focus gating. It now describes the actual hidden/minimized policy. |

Root validated every finding before editing. The last two anchoring probes were
added during root's check of the initial repair, then independently discriminated
with isolated mutations. No new review roster was started for those fixes.

Two excluded candidates are older unchanged paths: candidate metadata discovery
reads all `.meta.json` files, and load-earlier can skip an unpreparable middle
frame. Neither path or dependency was newly introduced by this task; source at
the parent commit has the same calls/handler. They are not hidden fixes or claims
that the implementation bounds metadata discovery. The aggregate work receipt
and limits apply to child transcript payload reads and selected/projected frames.

## Effects leaving the diff

- Catalog cache adds optional `sourceFingerprint`: sidecar writer → disk → main
  engine-free preflight. One-shot `unchanged` version-1 result crosses stdout
  NDJSON → receiving parser → runner → driver, without a desktop wire change.
- Display `sourceBytesRead` stays within the engine reader → child-join budget;
  engine resume remains separate. Projection subscriptions feed existing outbound
  snapshots; initial attachment and raw events are independent.
- `initialScrollRowKey` crosses pane → outer renderer window. Existing row keys
  support restoration; disclosure state is session-local memory. New
  `data-pane-height-owner` marks local DOM geometry ownership only.
- Bounded stderr and static preflight messages reach diagnostics, not model
  instructions or new tools. No model-routing description changed, so no scenario
  agent was applicable.
- Different lifecycle paths include connecting/success/failure/timeout/cancel/
  disconnect; cold/visible/hidden/return/in-flight/closed workers; complete/
  partial/rejected/nested child branches; scrolling/focus/prepend/append/remount.

### Installed cache writer

Root inspected the actual installed main bundle and the writer embedded in
`/Applications/Cat Code.app/Contents/Resources/sidecar/cat-code-sidecar`. Their
exact validator/writer functions were exercised against an isolated empty-catalog
copy, using local file IO instead of the durable-write helper. The installed
reader accepts the new top-level field and strips it; rewriting that accepted
snapshot preserves all catalog data but drops the optional fingerprint. The
new preflight treats a missing fingerprint as a cache miss, so the next run
rebuilds it. This establishes key compatibility, not a claim that the full
installed binary was launched or its durability/lifecycle was exercised.

## Execution and discrimination

- Final focused renderer/runner/MCP checks: **455 pass, 0 fail**, ten files.
- Final `bun test app/`: **5,300 pass, 3 skip, 5 fail**, 5,308 tests/365 files.
  The five failures reproduce against a clean export of pre-review `1d518b97`:
  **101 pass, 5 fail** in `App.test.tsx` (three source tripwires),
  `GoalMemoryPages.test.tsx` (waiting copy), and
  `PermissionRulesEditor.test.tsx` (unknown settings wording). Unchanged.
- `bun run build:dev:full`, both app typechecks, `renderer:build`, scoped MCP
  lint, `git diff --check`, and maps lint pass. Renderer retains the existing
  large-chunk warning; sidecar typecheck excludes existing upstream errors.
- Independent exact-commit evidence: 799 focused passes, 56 runner passes,
  four account/usage worker probe passes, and 25 real socket/lifetime passes.
  These sets overlap; counts are not summed. Socket fixtures required narrowly
  approved sandbox escalation. No Electron hardening/GUI execution occurred.
- The same four new regressions fail on isolated `ae101514` source for the
  intended reasons: plugin class missing, transient counter-scroll, preflight
  rejection, and erased failure excerpt. Current checks pass. Removing nested
  ownership yields `[9000, 9080]` instead of `[9000, 9040]`; restoring the old
  append offset adds `9122` to the position-write history. Both mutations fail.
- Root reran real catalog and MCP timeout probes after fixing them. New tests
  guard observable results and add no production injection seam. A geometry
  fixture initially failed because it omitted the logical position shift after
  prepend; corrected geometry passes, and the final broad suite includes it.

Measurements remain synthetic mechanism evidence. Final renderer probe:
78,406-character prose **14.60 ms full parse → 0.71 ms cached append**;
12,067-character fence **7.26 → 2.42 ms**; 5,000 retained rows → 15 SSR DOM rows.
The independent transport/history/background probes reproduce **3,386,834,960 →
54,460,432 copied bytes**, **100,670,620 → 4,194,304 child-read bytes**, and
**30,000 → 1 formatter constructions** with equal outputs. Stable warm catalog
starts zero workers. These are not whole-app or battery measurements.

## Unproven effects and operator steps

1. **Native layout, ResizeObserver timing, visual anchoring, animations and
   accessibility.** Prepare the synthetic parent/child JSONL fixture from
   `app/sidecar/subagentRestore.probe.test.ts` in an isolated config/workspace,
   with 240 mixed-height rows, code/math, images, and expanded cards. After a
   separately authorized GUI run, use:

   ```sh
   CLAUDE_CONFIG_DIR=/tmp/cat-resource-review-gui \
   CATCODE_TEST_CWD_ALLOWLIST=/tmp/cat-resource-review-workspace \
   CATCODE_INITIAL_CWD=/tmp/cat-resource-review-workspace \
   CATCODE_DEBUG_STATE=1 bun run --cwd app dev
   ```

   Wait for renderer ready, open the synthetic saved chat without a provider
   turn, scroll top/middle/tail, resize, expand cards/images, leave/re-enter rows,
   prepend earlier history, and keep keyboard focus while scrolling away. Check
   stable text, single anchor adjustments, no jumps on lower append, retained
   expansion/focus, proper spacing/highlighting, and no arrival replay.
2. **Electron end-to-end visibility/close lifecycle and packaged MCP success
   lifecycle.** In that isolated authorized dev run, minimize/hide and restore
   windows, keep a visible unfocused window, and close during a fixture worker
   read. Verify skipped intervals catch up once and no child survives teardown.
   Configure only a local fixture stdio MCP server that completes SDK startup;
   emit stderr after connect, disconnect/cancel, and verify draining/cleanup.
   Run `bun run --cwd app test:hardening` only with authorization for its
   Electron launch. Headless tests and the real timeout fixture do not prove
   these full GUI/packaged paths.
