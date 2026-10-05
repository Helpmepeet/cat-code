# Resource-waste improvements, 2026-10-04

The subsequent [fixing review](2026-10-04-resource-waste-review.md) closed seven
findings, including scroll-correction ownership, cache configuration changes,
catalog preflight recovery, and MCP timeout diagnostics. It records final checks.

All eight audited mechanisms were revalidated in the current checkout and
addressed. Work stayed on the existing branch with three GPT-6-Luna collaboration
workers and root integration. The original audited SHA predates the current
source; baseline comparisons below use a clean source export of `da493b7f` with
the same installed dependencies. Another session's commit and pre-existing
untracked files were preserved.

## What changed

| Finding | Like five | Technical detail |
|---|---|---|
| 1. Streaming Markdown | Keep the coloring already finished; add simple new words without rereading the whole page. | `markdownRenderPlan.ts` extends a cached plain-text paragraph only for conservative suffixes and trusted plugins. Syntax, references, autolinks, tables, math/callouts, fence transitions, and edits use the whole-document parser. `markdownPlugins.ts` caches highlighted fence trees with language-sensitive keys and cloned output: at most 32 blocks, 256,000 source characters, and 16,000 characters per cached block. Large blocks still highlight normally. |
| 2. Socket copying | Grow the box when needed instead of copying everything into a new box for every spoonful. | `FrameDecoder` validates fragmented headers before accumulating bodies, decodes complete frames directly, grows unfinished storage geometrically within the configured frame allocation ceiling, and releases it after consumption/error/disconnect. Fatal UTF-8, JSON errors, coalesced frames, and length caps remain enforced. |
| 3. MCP stderr | Listen to the pipe, but stop saving chatter after startup. | `captureMcpStartupStderr` keeps an 8,192-character startup excerpt with a truncation notice. Successful connection clears retention while the data listener keeps draining. Acquisition failure, cancellation, and disconnect dispose the listener. Character counts are not fixed byte-allocation claims. |
| 4. Outer transcript | Put nearby pages on the desk and keep the others' places bookmarked. | Outer transcript entries now use the existing measured window machinery with an 80-row viewport/overscan cap plus one focused row when needed. The complete bounded history model remains retained. Stable row identities, remembered anchors, prepend compensation, row spacing, focus retention, and disclosure state support remounting; inner Markdown and composite virtualization remain in place. |
| 5. Idle workers/catalog | Check whether the books changed before hiring someone to reread them. | Engine-free main preflight avoids spawning an unchanged catalog worker; the worker rechecks before engine imports. Transcript metadata, relocation records, and workspace existence invalidate the fingerprint. Unchanged runs skip enumeration, durable cache rewrite, and publication, preserving the real enumeration's `capturedAtMs`. Recurring account/catalog/usage work pauses only when all windows are hidden/minimized, catches up skipped ticks on return, and keeps visible-unfocused cadence, cold reads, explicit refresh, single-flight, and last-good results. Disposable workers remain disposable. |
| 6. Duplicate snapshots | Tell the screen when the picture changes, not when an unrelated counter moves. | Task, worker, goal, and lease subscriptions structurally compare projected values. Foreground-task state participates in task comparison so delivery still wakes correctly. Initial attachment snapshots and raw engine event forwarding remain separate. Projection still runs to establish equality; unchanged encoding/socket/IPC/reducer work is avoided. |
| 7. Child history | Set one reading allowance for all the little books, including books too big to use. | A display-only agent reader accounts for actual bounded tail bytes, including the alignment probe. Child joins share 4 MiB source bytes, 4,000 selected messages, and remaining projected bytes/frames across siblings and nested waves. Rejected reads consume allowance. Partial branches retain the existing unavailable-history card. Reachability, compaction projection, ancestry, accepted UUID deduplication, and splicing remain; the full agent-resume reader is unchanged. |
| 8. Calendar work | Reuse the same clock and the answer for a day already checked. | `usageWindow.ts` keeps 16 timezone formatters per formatter kind and 512 cached entries per calendar-boundary kind. Date/timezone and exact rolling cutoff inputs key reuse. Existing DST/skipped/repeated-hour and unusual-offset algorithms remain; indexed source verification, accounting deduplication, recovery, and privacy projection are unchanged. |

## Reproducible mechanism measurements

Run each probe separately from the repository root so timing samples do not
compete with other test/build processes:

```sh
bun scripts/benchmarks/resourceWasteRenderer.ts
bun scripts/benchmarks/resourceWasteTransport.ts
bun scripts/benchmarks/resourceWasteBackground.ts
bun scripts/benchmarks/resourceWasteHistory.ts
```

The probes create synthetic data; background/history probes set isolated
`CLAUDE_CONFIG_DIR` directories and remove them afterward. No live private
transcripts, credentials, provider calls, or GUI are needed.

| Mechanism | Before | After | Interpretation |
|---|---:|---:|---|
| 78,406-character prose, growing append sequence | 14.56 ms median full parse | 0.68 ms median cached append | Both use production transcript plugins, math, and callout mode. Synthetic local timing, about 21 times faster for this shape. Syntax-sensitive shapes still parse fully. |
| Growing 12,067-character TS fence/math/callout document | 6.61 ms median direct highlighting | 2.32 ms median cached highlighting | Both parse the whole growing document. Settled highlighting is reused, about 2.9 times faster for this fixture. |
| 5,000 retained outer rows | 5,000 actual SSR DOM entries | 15 actual SSR DOM entries | Same fixture run against the clean baseline and new code, counting the stable row-key attribute. Initial estimated geometry, with an 80-row cap plus optional focused row. This is not a real-layout measurement. |
| One 20,971,536-byte frame, 321 chunks of up to 64 KiB | 3,386,834,960 copied bytes | 54,460,432 copied bytes | Before is the exact old concatenation model, including borrowing the first chunk; after counts actual `Buffer.copy` bytes. One frame decodes. |
| Connected MCP fixture, 512 × 32 KiB ASCII chunks | 16,777,216 retained characters | 0 retained characters | Current data listener remains installed until disposal; real MCP lifecycle tests cover cancellation/disconnect. This measures string length, not resident bytes. |
| 1,000 source replacements with unchanged display projection | 1,000 notifications | 0 notifications | The structural subscription fixture still emits once for a real status transition; domain tests cover actual task/worker/goal/lease behavior and attachment. |
| Stable warm catalog | Disposable worker start | 0 spawn attempts | Real nonempty worker fixtures additionally preserve cache inode/capture time, then refresh after external transcript and relocation changes. Metadata preflight still does filesystem work. |
| 60 hidden-window timer callbacks per driver after cold read | One start per callback | 0 starts | Each driver starts once on return. Visible unfocused windows continue their normal cadence. This is not a claim of zero work for all idle visible windows. |
| 12 rejected two-message child files, each about 8 MiB | 100,670,620 actual fd-read bytes | 4,194,304 actual fd-read bytes | Both variants accept zero branches under the one-frame fixture allowance. Full engine resume still reads complete history. |
| 30,000 timezone date conversions | 30,000 formatter constructions | 1 construction | Every output matches the uncached reference. A local run was 510 ms versus 40 ms; this is conversion-only timing. |

Timing observations are synthetic medians or local probe runs with Bun 1.4.0 on
macOS arm64;
they are not whole-app CPU, memory, or battery-life measurements.

## Verification and limits

- `bun run build:dev:full`: passed, including maps and undefined-name gates.
- `bun test app/`: 5,297 pass, 3 skip, 5 pre-existing failures, 365 files.
- Root affected desktop/shared suites: 426 pass; focused engine suites: 151
  pass. Additional final framing, MCP/display-reader, and timezone checks pass.
  These counts overlap the broad suite and each other, so they are not summed.
- Renderer worker focused checks: 461 pass across ten suites. Root independently
  ran the integrated broad suite, app typecheck, and renderer build.
- Isolated real process/lifetime/subagent restore checks: 25 pass.
- `bun run --cwd app typecheck`, `typecheck:sidecar`, and `renderer:build`:
  passed. The scoped sidecar check excludes existing upstream engine diagnostics;
  the renderer build retains its existing large-chunk warning.
- Full root TypeScript check: 1,919 existing diagnostics both before and after;
  file/code/message multisets match after normalizing source-root paths and line
  shifts. It remains failing globally, with no added diagnostic signatures/counts.
- Scoped lint for changed engine modules, `git diff --check`, and `bun run
  maps:lint`: passed (17 maps, zero warnings).

Verification uses temporary config/state roots. Process probes use the bundled
Node runtime on PATH and a visibly synthetic authentication placeholder, without
running model turns or provider probes. Unix-socket fixtures require sandbox
permission to bind their isolated temporary socket.

An initial storage-test invocation missed the config-directory override and hit
a sandbox-denied `chmod` on the live transcript-lease directory, before the
transcript materialization step. The invocation was corrected; all reported
storage and process outcomes use isolated reruns. The denied attempt is not
counted as verification evidence.

Regression evidence against the clean source export includes retained framing
storage, duplicate domain publications, catalog startup/cache invalidation,
rejected child source/message/output budgets, and timezone formatter/boundary
reuse. New tests fail on the old implementation for those intended reasons.
Renderer baseline checks additionally produce six intended failures for plain
append work reuse and bounded outer mounts. The integration allocation-ceiling
test fails on the unclamped geometric variant (2,097,152 bytes allocated for a
1,048,580-byte maximum frame), and passes after clamping growth.
Existing tests cover malformed UTF-8/JSON, limits, initial attachment/reconnect,
prompt delivery, real resumed child transcripts, compaction, accounting identity,
prefix edits followed by append, corruption recovery, and DST behavior.

The broad desktop suite's five pre-existing failures reproduce against
`da493b7f` using the same environment (101 pass, 5 fail across the three affected
files):

- `App.test.tsx`: CC-16 submit parking source tripwire, foreground subagent source
  tripwire, D5 refused-submit source tripwire.
- `GoalMemoryPages.test.tsx`: `renders memory waiting state without fixtures`.
- `PermissionRulesEditor.test.tsx`: unread settings snapshot wording assertion.

Those unrelated tests were preserved. The replay batching test now checks the
complete retained model and bounded visible tail rather than requiring all 200
entries to be mounted. No production-build, install, push, dependency addition,
or live session launch was performed.

Electron `test:hardening` and GUI acceptance were not run: this request explicitly
forbids GUI launches/driving. DOM tests inject geometry because happy-dom has no
layout engine. Browser/Electron measurement, native ResizeObserver timing,
visual scroll smoothness, accessibility navigation, and real battery impact
remain unverified. Headless proof does not imply visual acceptance.

For a separately authorized operator GUI check, use an isolated synthetic saved
chat (the main/child JSONL fixture construction in
`app/sidecar/subagentRestore.probe.test.ts` is the preparation reference), with
at least 200 mixed-height rows and completed code fences. Launch only Cat Code
Dev with an isolated config home and allowlisted temporary workspace:

```sh
CLAUDE_CONFIG_DIR=/tmp/cat-resource-gui-config \
CATCODE_TEST_CWD_ALLOWLIST=/tmp/cat-resource-gui-workspace \
CATCODE_DEBUG_STATE=1 \
bun run --cwd app dev
```

After `[main] renderer ready`, open the synthetic saved chat from Sessions without
sending a provider turn. Scroll top/middle/tail; expand a tool card and image
preview; leave and return to that row; switch tabs and return; request earlier
history while reading the middle; resize the window; and use keyboard focus on
a row control while wheel-scrolling away. Look for the same anchored text,
retained expansion/focus, readable viewport content, correct spacing, complete
code styling, and no replayed arrival animation. These are operator steps, not
claims of checks performed.
