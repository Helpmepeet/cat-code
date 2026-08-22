# Desktop turn error rendering audit

**Date:** 22 August 2026
**Scope:** Source-only investigation of desktop transcript rendering for provider authentication failures and user-requested turn interruption. No application code was changed.

## Summary

The desktop application conflates distinct turn outcomes and loses error semantics at the engine-to-renderer boundary.

1. At the time of this audit, a revoked OAuth credential delivered as a 401 was not recognized by the engine's revoked-token branch, then reached the desktop as ordinary assistant prose plus a generic failed-turn footer.
2. A user-requested cancellation is persisted as a synthetic user message and is consequently rendered as if the operator typed it. The same abort is then classified as `error_during_execution`, so the desktop labels it as an execution failure.
3. Every terminal error result carries structured diagnostic strings, but the desktop result row deliberately suppresses them. Several failure classes therefore end as a label, duration, and cost without their cause.

These are presentation and outcome-classification defects. This report records the observed behavior and source evidence only; it does not prescribe an implementation.

## 1. Revoked OAuth credentials degrade to generic authentication prose

At the time of this audit, the engine's dedicated revoked-OAuth branch matched only an `APIError` with status `403` and a message containing the exact phrase `OAuth token has been revoked`.

The observed failure is materially different:

```text
Failed to authenticate. API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"OAuth access token has been revoked."},"request_id":null}
```

It has status `401` and the phrase `OAuth access token has been revoked.`, so it then entered the generic 401/403 handler. In a non-interactive session, that handler created the displayed `Failed to authenticate. API Error: …` text.

**Post-audit update, 22 August 2026:** `src/services/api/errors.ts` now recognizes both 401 and 403 responses containing either revoked-token phrase. The same response is classified as `token_revoked` and receives the existing revoked-token message. The remaining desktop problem is presentation: that normalized message still reaches the renderer as ordinary assistant prose and is followed by the generic failure seam.

That text becomes an internal assistant API-error message. At the terminal boundary, `QueryEngine` treats its last assistant message as an API error and emits a terminal `result` with `subtype: 'success'` and `is_error: true` (`src/QueryEngine.ts:1260-1295`).

The desktop cannot preserve the error category:

- `normalizeMessage()` serializes assistant content and its optional low-level `error` object, but not `isApiErrorMessage` (`src/utils/queryHelpers.ts:119-136`).
- `SDKAssistantMessageSchema` has no API-error marker (`src/entrypoints/sdk/coreSchemas.ts:1445-1457`).
- The transcript projector therefore creates ordinary assistant text rows from the content (`app/renderer/src/transcriptProjector.ts:1480-1576`), and `TranscriptView` renders that content through normal assistant Markdown (`app/renderer/src/TranscriptView.tsx:939-947`, `:1086-1164`).
- `ResultSeam` labels any unknown error subtype, including the `success` subtype paired with `isError: true`, as `Turn failed` (`app/renderer/src/TranscriptView.tsx:4741-4770`).

Before the post-audit normalization, the observable outcome was raw provider diagnostic prose followed by a generic failure seam. The UI still does not retain the fact that the credential was revoked as a renderer-visible category, so it cannot give authentication failures a distinct desktop treatment.

## 2. Live user interruption renders as a fake user turn and an execution error

The query loop represents an abort by minting the synthetic user text `[Request interrupted by user]`:

- The marker is defined by `createUserInterruptionMessage()` in `src/utils/messages.ts:579-594`.
- It is yielded after an aborted model stream in `src/query.ts:1140-1191`.
- It is also yielded after aborting during tool execution in `src/query.ts:1662-1707`.

This internal representation supports interruption persistence and recovery. The interrupted-turn recovery tests explicitly describe the literal marker as a historical implementation detail (`src/utils/conversationRecovery.interruptedTurn.test.ts:236-258`). It is nevertheless not user-authored input.

The desktop projector has no live interruption case. It sends every user frame through the ordinary user-frame path (`app/renderer/src/transcriptProjector.ts:1578-1673`), so the marker becomes a regular user-text row and is rendered as a user bubble. The only desktop interruption notice is generated for a **restored** session whose `ready` frame carries `turnInterrupted: true` (`app/renderer/src/transcriptProjector.ts:695-707`); live `abort.status` events do not produce a transcript row.

The abort is also classified incorrectly at the terminal-result layer. `isResultSuccessful()` accepts assistant content, tool-result-only user messages, or a model `end_turn` with no content. It does not accept the text-only interruption marker (`src/utils/queryHelpers.ts:52-98`). Consequently, `QueryEngine` emits an erroneous terminal result with `subtype: 'error_during_execution'` (`src/QueryEngine.ts:1222-1257`). The desktop maps that exact subtype to `Errored during execution` (`app/renderer/src/TranscriptView.tsx:4727-4770`).

The observable outcome is therefore both incorrect forms of attribution:

```text
[Request interrupted by user]
Errored during execution
```

The first is presented as operator-authored transcript content. The second presents a voluntary cancellation as a runtime/execution failure.

An earlier audit already identified the fake-user-row half of this behavior: `docs/migration/reviews/2026-07-31-app-ux-gap-audit.md:263-278`. The current investigation confirms it remains present and identifies the related terminal-result misclassification.

## 3. Result-level failure diagnostics are stored, then discarded by rendering

The SDK result-error contract requires an `errors: string[]` payload for these terminal subtypes:

- `error_during_execution`
- `error_max_turns`
- `error_max_budget_usd`
- `error_max_structured_output_retries`

See `src/entrypoints/sdk/coreSchemas.ts:1529-1555`.

`QueryEngine` supplies those diagnostics for each outcome:

- maximum turns: `src/QueryEngine.ts:985-1007`
- maximum budget: `src/QueryEngine.ts:1121-1141`
- structured-output retries: `src/QueryEngine.ts:1164-1187`
- execution failures, including turn-scoped in-memory errors: `src/QueryEngine.ts:1222-1257`

The desktop projector retains the `errors` array on its `ResultRow` (`app/renderer/src/transcriptProjector.ts:1698-1734`). However, the row renderer passes only error state, subtype, duration, and cost to `ResultSeam` (`app/renderer/src/TranscriptView.tsx:1003-1011`). `ResultSeam` does not receive or render `result` or `errors` (`app/renderer/src/TranscriptView.tsx:4741-4770`).

The behavior is intentional in the present tests. `app/renderer/src/TranscriptView.test.tsx:2348-2372` asserts that detailed error text is absent from the rendered result seam.

This has the following observable effects:

- execution errors have no result-level explanation in the transcript;
- a maximum-turn error does not expose the configured limit recorded by the engine;
- a budget error does not expose the reached budget recorded by the engine;
- a structured-output failure does not expose its retry count;
- failures without a separately emitted assistant-text message collapse to a generic label plus duration and cost.

## Test coverage gap

The existing desktop tests verify result labels and verify that detailed result errors are hidden. They do not cover either user-visible failure flow documented here:

- a 401 revoked OAuth response flowing through the app-session seam into the desktop transcript;
- a live user abort producing a non-error terminal outcome and a non-user-authored transcript representation.

The desktop flows above remain untested end-to-end. A post-audit engine regression test covers normalization of the observed 401 response.

```text
VERIFICATION
- git diff --check → clean
- cited source-path existence checks → all cited paths exist
- bun run maps:lint → passed: 18 maps, 7 pre-existing section-structure warnings
- bun test src/services/api/errors.test.ts → 1 pass / 0 fail
- bun run build:dev:full → passed: 438 pre-existing ignored-file warnings / 0 errors; cli-dev version printed
Stale-reference sweep: the observed wording appears in the two updated engine classifiers, their test, this historical report, and one existing plan. Legacy phrase matches remain in distinct retry/HTTP paths that already retry all 401 responses.
Not run: desktop end-to-end tests. The transcript-design work remains intentionally deferred.
```
