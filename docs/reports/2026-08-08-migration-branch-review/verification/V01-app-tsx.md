# A01 adversarial validation: renderer shell root

> **Verification provenance:** Independent `gpt-5.6-sol` subagent at max effort. `gpt-5.6-luna` was requested, but the runtime ignored the same-family downgrade from the Sol parent. Read-only source review; no tests or GUI run.

## Overall verdict

Reviewed the current `migration` branch at `a17e5e9`. The directly cited implementation files are clean; active uncommitted changes in `contextBreakdownState.ts` and `planState.ts` do not alter or obscure these findings. Of 11 findings, 5 are confirmed, 3 have a valid but narrower core, 1 is overstated, 1 duplicates the protocol report, and 1 is invalid. The most urgent A01 work is the root render boundary and modal/session-target correctness; the large `App()` decomposition is valid design debt but should be staged rather than executed as the proposed broad relocation.

## Finding classifications

1. **CONFIRMED — [HIGH] `App()` is a god component**

   **Evidence:** `/Users/pt/cat-code/app/renderer/src/App.tsx:429-3461` remains 3,033 lines with exactly 146 hook calls. The 400-line panel projection remains at `:2365-2766`; `SessionPane` remains at `:3542-4561`. `/Users/pt/cat-code/app/renderer/src/App.test.tsx:2064-2068` acknowledges that important App wiring is only source-text tested because the root cannot be mounted and fed.

   **Cost:** Cross-domain transport, lifecycle, layout, composer, account, and dialog behavior share one closure and dependency graph. This is concrete testability and review cost, even without a single triggering defect.

   **Disposition:** Decompose incrementally. The proposed one-shot fix is too broad: moving `SessionPane` shortens the file but not `App()` itself, while `/Users/pt/cat-code/app/renderer/src/App.tsx:4709-4713` deliberately keeps `reduceShell` separate from the event-only reducer. Preserve the locked raw-frame fan-out; first extract one coherent domain with a narrow API, then remeasure.

2. **PARTIALLY CONFIRMED — [MED] Per-session state is not pruned**

   **Evidence:** Paste, history, transport-error, reveal, removed-ID, and toast-dedup state are created at `/Users/pt/cat-code/app/renderer/src/App.tsx:458-474`, `:523-525`, `:726`, `:1547`, and `:1667`. The removal branch at `:958-972` clears none of the first four or either toast set. Paste deletion exists at `/Users/pt/cat-code/app/renderer/src/composerState.ts:205-213`; history has only a per-session 50-entry cap at `:312-347`.

   **Trigger/cost:** Cumulative registry reaps can leave arbitrarily many dead app IDs and request IDs resident. However, ordinary close does **not** emit `session-removed`; `/Users/pt/cat-code/app/renderer/src/App.tsx:1812-1818` explicitly retains the restorable row. The report’s simple close trigger is therefore wrong. `removedIdsRef` is also a correctness ledger for snapshot races, not indiscriminately disposable.

   **Disposition:** Add an explicit teardown operation for truly removed app IDs and bound dedup history. Do not merely skip `releasePendingSubmit`: that can silently lose unsent text; define a visible recovery disposition first.

3. **CONFIRMED — [MED] Shell shortcuts can mutate or retarget state under modals**

   **Evidence:** `/Users/pt/cat-code/app/renderer/src/App.tsx:2325-2355` handles Cmd/Ctrl shortcuts without an overlay guard. `/Users/pt/cat-code/app/renderer/src/overlayFocus.ts:198-219` recognizes only Escape and unmodified Tab. Metadata is a boolean at `/Users/pt/cat-code/app/renderer/src/App.tsx:516` and renders entirely from the current `activeSessionId` at `:3141-3165`.

   **Trigger/cost:** Open metadata for the active session, then press Cmd+2. The drawer immediately displays another session. Cmd+W can likewise close the underlying session while a branch/export modal remains bound to it.

   **Disposition:** Store the metadata app-session target explicitly and suppress session-mutating shell chords while a modal owns focus. Do not blindly suppress every popover or rely on the currently private `modalFocusStack`; preserve an intentional Cmd+K toggle separately if desired.

4. **CONFIRMED — [MED] No root render error boundary**

   **Evidence:** `/Users/pt/cat-code/app/renderer/src/main.tsx:23-37` renders providers and `App` without a boundary. The only boundary is markdown-local at `/Users/pt/cat-code/app/renderer/src/TranscriptView.tsx:685-707`.

   **Trigger/cost:** A current concrete render trigger exists: `/Users/pt/cat-code/app/renderer/src/agentIdentity.ts:244-255` prototype-indexes model-supplied agent text; `toString` produces an invalid tone that is dereferenced at `/Users/pt/cat-code/app/renderer/src/TranscriptView.tsx:1798-1860`. The uncaught render exception unmounts the desktop UI.

   **Disposition:** Fix that local trigger under its A17 owner and add a root boundary as defense in depth. Render a generic recovery/reload surface and report the diagnostic through a sanctioned channel; do not show raw error text, which can expose internal data. A boundary will not catch every event-handler or asynchronous bridge exception, so the report’s bridge example overstates its coverage.

5. **OVERSTATED — [MED] Renderer-created `account.result`**

   **Evidence:** The local failure frame remains at `/Users/pt/cat-code/app/renderer/src/App.tsx:1318-1336`, but the code explicitly states that it never crosses the wire. `/Users/pt/cat-code/app/renderer/src/AccountsPage.tsx:716-724` intentionally consumes it by request ID so a no-session dialog completes, and `/Users/pt/cat-code/app/renderer/src/App.test.tsx:2089-2100` pins that behavior.

   **Cost:** Reusing a wire-shaped value and empty session ID weakens provenance clarity, but it grants no sidecar authority and is not a security-baseline violation. The report omitted the primary consumer and incorrectly described filtering as accidental.

   **Disposition:** Optional cleanup: introduce a local rejected-outcome action when next changing this domain. Do not treat it as MED security remediation.

6. **DUPLICATE/DEPENDENT — [MED] Two ID spaces share `string`**

   **Evidence:** `/Users/pt/cat-code/app/shared/protocol.ts:82` still aliases `SessionId` to `string`; `/Users/pt/cat-code/app/renderer/src/sessionsCatalogState.ts:97-101` places engine `sessionId` beside app `appSessionId`. App currently passes the engine ID at `/Users/pt/cat-code/app/renderer/src/App.tsx:3020-3023` and stores it beside an app-ID dispatch at `:3291-3299`.

   **Cost:** Swapping either field type-checks and breaks rename/tag correlation.

   **Disposition:** Valid issue, but it duplicates `/Users/pt/cat-code/docs/reports/2026-08-08-migration-branch-review/A06-protocol.md:56-88`. A01 may rename local fields for clarity; branded IDs are a protocol-wide migration and should have one A06 owner, not an App-local refactor.

7. **CONFIRMED — [MED] Repeated bridge-verb error handling**

   **Evidence:** Near-identical synchronous wrappers remain at `/Users/pt/cat-code/app/renderer/src/App.tsx:2475-2482`, `:2542-2581`, `:2599-2606`, and `:2723-2730`.

   **Cost:** New simple verbs can omit either transport-error clearing or reporting, while deliberate deviations are difficult to identify among copied blocks.

   **Disposition:** Centralize only the truly identical synchronous `void` bridge calls. Do not force submit, permission, plan, ask-question, or best-effort context requests through the same helper; they have additional rollback or intentionally silent behavior. The report’s “~12 identical” count is too broad, but the core duplication is real.

8. **CONFIRMED — [MED] `workspacePanels` is built on non-chat renders**

   **Evidence:** `/Users/pt/cat-code/app/renderer/src/App.tsx:2365-2766` constructs the projection unconditionally. Non-chat branches use only its length at `:2779` and `:3366`; the element trees are consumed only at `:3403-3405`. Streaming frames update App-owned stores at `:827-867`.

   **Trigger/cost:** Leave a session streaming while viewing Settings, Sessions, Accounts, or Goals. Every meaningful frame render performs panel selectors, raw-log filtering, and closure/element allocation for up to three panels (`/Users/pt/cat-code/app/renderer/src/workspaceLayout.ts:4`), then discards them.

   **Disposition:** Derive `hasPanels` from `workspaceLayout` and skip the projection outside chat. A broad `useMemo` alone is insufficient because streaming state invalidates its dependencies; a chat-only child boundary is cleaner.

9. **PARTIALLY CONFIRMED — [MED] Direct state-internal reads**

   **Evidence:** Direct reads remain at `/Users/pt/cat-code/app/renderer/src/App.tsx:1362-1368`, `:1566`, `:1592`, `:3232`, `:3252`, `:3380-3382`, and `:3910-3912`.

   **Trigger/cost:** The broad claim is overstated: these are five modules, not eight, and their exported top-level fields are public state, not established private internals. The transcript case is real: stored `rows.length` does not represent hidden-row visibility or correlation-only tool-result updates. Consequently the at-bottom effect at `:3961-3965` can miss rendered height changes.

   **Disposition:** Drive scrolling from the rendered/nested selector’s identity or an explicit display revision. Do not add pass-through selectors for every scalar field merely to satisfy an invented opacity rule.

10. **PARTIALLY CONFIRMED — [LOW] Temporary debug text remains visible in development**

    **Evidence:** `/Users/pt/cat-code/app/renderer/src/App.tsx:4509-4534` still renders session IDs in every development run.

    **Cost:** It pollutes ordinary dev screenshots and displays internal IDs. However, it is removed from production, was explicitly operator-requested, and has no stated deletion date; the report mistakes its creation date for a deadline.

    **Disposition:** Delete it after its stated debugging condition is resolved, or gate it behind the existing opt-in mechanism used at `:3948-3960`. Production remediation is unnecessary.

11. **INVALID — [LOW] Preload queue rejection poisoning**

    **Evidence:** The chain has no outer catch at `/Users/pt/cat-code/app/renderer/src/App.tsx:759-815`, but `/Users/pt/cat-code/app/renderer/src/sessionPreload.ts:174-224` catches current preview failures and projection/`onLoad` failures. App’s remaining eligibility and capacity callbacks are synchronous reads over internally constructed state.

    **Trigger/cost:** No current source-backed rejection path was identified. This remains a speculative future failure, not a present finding.

    **Disposition:** No change. The proposed `.catch(() => {})` would silently erase diagnostics. If a genuinely fallible step is later added, recover per job while logging the error.

## Counts

| Classification | HIGH | MED | LOW | Total |
|---|---:|---:|---:|---:|
| CONFIRMED | 1 | 4 | 0 | 5 |
| PARTIALLY CONFIRMED | 0 | 2 | 1 | 3 |
| STALE/ALREADY FIXED | 0 | 0 | 0 | 0 |
| OVERSTATED | 0 | 1 | 0 | 1 |
| DUPLICATE/DEPENDENT | 0 | 1 | 0 | 1 |
| INVALID | 0 | 0 | 1 | 1 |
| **Original severity totals** | **1** | **8** | **2** | **11** |

## Prioritized confirmed remediation

1. Add a sanitized root render boundary; coordinate with the A17 owner to fix the current agent-type render throw.
2. Bind metadata to its opening app-session ID and prevent session-mutating shell shortcuts while a modal owns focus.
3. Skip workspace-panel construction outside the chat view.
4. Consolidate only identical synchronous bridge-verb error wrappers.
5. Stage `App()` decomposition behind narrow, behavior-owning seams; preserve the locked frame pipeline and the deliberate shell-reducer separation.
