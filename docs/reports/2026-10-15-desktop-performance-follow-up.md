# Desktop performance follow-up — 2026-10-15

Baseline revision: `008dc331ee27d8467cc584a648e235d5ba0454b1` in a shared, dirty checkout. Before editing, SHA-256 values for the primary owners were:

| File | SHA-256 |
| --- | --- |
| `app/renderer/src/transcriptProjector.ts` | `8b7b3d3e16d5c68b69d83087f0f33ec50d9efb07e76eda216daacd4cd7e7ee21` |
| `app/renderer/src/todoPlan.ts` | `5fbdd01ce5968fed40b08db5d04e598ea22b6e6ac7a369fb3da05eb3f0b59cf1` |
| `app/renderer/src/subagentDockState.ts` | `e295c7a4f95b242a352289f763cc2e1fa1e00b161472f2b3e01d3243237614db` |
| `app/main/main.ts` | `17dc4eba3eb45e0027863ec9c62e13c795f6399bf143bd770a9b59b006394351` |
| `app/renderer/src/App.tsx` | `814ffa6f5bbe9022f4888cb96abb58105d1440029e2c86f045ccf262f0db89ff` |
| `app/main/deliveryTraceSink.ts` | `7bb167880825a3612a7fef6bf5d75a9c572f070c4232462fdea09c6af7c8ed21` |

## Changes and evidence

1. **Completed tool rows.** The read-time result join now weak-caches derived wrappers by the immutable source row and invalidates on result, agent completion, resumed-agent identity/name/usage, or hidden presentation changes. Normal and revealed views have separate entries. In a synthetic stream with 256 completed Read/Bash/Agent calls, 32 pending tools, four nested agents, and 100 prose deltas, the baseline recreated 25,600 completed wrappers and reported a changed range beginning at row 0. The changed code recreated none; the changed range began at row 288. Producer-frame regressions cover pending completion, late enrichment, cancellation, reset/replacement, hidden views, and nested descendants.
2. **Repeated transcript scans.** Todo selection (including null) and top-level agent candidate extraction now cache by immutable row-array identity. Worker/task and prior dock-state joins still run on each call. Across 200 repeated calls with the same 289 rows, broad Todo visits fell from 57,800 to 289, and broad dock visits from 231,200 to 289. Tests cover changed row arrays and live worker updates; existing dock lifecycle tests cover settling, Clear/resume, and identity migration.
3. **Analytics first use.** Main no longer schedules the usage worker at launch. The App document activates it once on first Analytics visit, after host subscription setup. Driver `start()` alone restores the saved snapshot and starts fresh collection; the first request no longer also queues `refreshNow()`. DOM and driver tests cover no launch work, first activation, repeat visits, StrictMode, manual refresh, retained results, and the off switch. This changes when collection begins, not the source transcripts or the five-minute cadence after activation.
4. **Replay trace diagnostics.** Source/socket gap and order checks remain source-sequence based. Renderer order now follows bounded per-document dispatch ordinals, with delivery-stage identity scoped to document and subscription epoch. Old contexts and evicted sequences release bookkeeping; late source marks no longer replace the current replay trace identity. Regressions use the production replay buffer and attachment gate for descending replay, repeated reloads, subsequent live traffic, late source evidence, and genuine inverted acknowledgement order. The official synthetic tracing probe was checked against the current main-process mark/ack flow before use.

## Same-runtime synthetic comparison

Baseline and changed modules were bundled into the same Node/V8 fixture using the baseline revision's module text and current source, respectively. Reproduce with `node docs/reports/2026-10-15-desktop-performance-follow-up.probe.mjs /private/tmp/NEW_EMPTY_DIRECTORY`; the script pins the baseline revision and writes both variants there. One-run times below indicate work reduction, not a stable UI latency estimate:

| Probe | Baseline | After |
| --- | ---: | ---: |
| Renderer projection, 100 prose deltas | 13.32 ms | 8.31 ms |
| Repeated Todo selection | 2.42 ms | 0.08 ms |
| Repeated dock selection | 11.78 ms | 1.27 ms |
| 300-message replay, zero partials: false order warnings | 1,794 | 0 |
| 300-message replay, zero partials: trace records | 2,094 | 300 |
| 300-message replay, zero partials: probe median | 17.14 ms | 7.02 ms |
| 1,000-message replay, zero partials: false order warnings | 5,994 | 0 |
| 1,000-message replay, zero partials: probe median | 57.92 ms | 24.10 ms |

The renderer fixture mixed completed and pending tools, nested agents, and streamed prose. The tracing comparison used all 11 synthetic scenarios from `docs/reports/2026-10-06-performance-measurements/run.ts` under the same runtime; the changed official probe also passed all 11 scenarios. Source order diagnostics, rejected acknowledgements, and partial-delivery controls remain active. No real-data probe ran.

## Verification and limits

The exact staged patch, applied to an isolated archive of the later shared-branch tip `b087eee1`, passed root `typecheck`, `typecheck:sidecar`, `renderer:build`, `maps:lint`, and all 270 affected tests. Its full `bun test app/` run had 5,946 passes, three skips, and one failure: `app/shared/sessionRelocationRepeat.storage.test.ts:137` expected an invoked skill path under the test config home. The same test fails at the same assertion in an unmodified `b087eee1` archive. `git diff --check` passed in the shared checkout.

The shared checkout's earlier full run had nine reported failures amid concurrent native-power/protocol edits, a temporary-path alias, and an unrelated stale test tree under `tmp/`. One Analytics mock failure was caused by this change and fixed. Root `typecheck` in that changing checkout last reported an `@electron/asar` call in the concurrently edited `app/scripts/packagedBundleScan.ts`; the isolated staged patch typechecks. The remaining baseline failure prevents a clean full-suite claim.

React commit/render time and native GUI responsiveness were not measured. Object identity, row visits, trace volume, and synthetic timings establish reduced repeated work; they do not establish a noticeable long-chat UI improvement. Cross-tab Markdown plan caching and transcript-cache persistence remain deferred as requested.
