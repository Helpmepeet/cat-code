# Post-Compact Context Refresh — Implementation Plan

## Problem statement

After compaction, context indicators do not refresh until the next assistant response. This affects at least:

- the status line ctx display
- the prompt footer / notification-side ctx display
- any other surface that derives "current context" from the last assistant usage record

The core issue is that compaction replaces the conversation immediately, but the post-compact message set usually contains:

- a compact boundary system message
- one or more compact summary user messages
- optional kept messages / attachments / hook results

It does **not** usually contain a fresh assistant message with new usage metadata. UI code that reads context from the last assistant usage therefore keeps showing pre-compact numbers until the next real assistant turn.

## Diagnosis summary

Confirmed relevant paths:

- Query switches to post-compact messages immediately: `src/query.ts`
- REPL applies compact boundaries immediately: `src/screens/REPL.tsx`
- Post-compact message shape comes from `buildPostCompactMessages(...)`: `src/services/compact/compact.ts`
- Status line reads current usage through `getCurrentUsage(messages)`: `src/components/StatusLine.tsx`
- Footer ctx display reads `tokenCountFromLastAPIResponse(...)`: `src/components/PromptInput/Notifications.tsx`
- Shared token helpers currently look only for assistant usage: `src/utils/tokens.ts`

## Chosen approach

### Use compact-boundary metadata as the post-compact display source, but only through a new UI-facing helper

This is the best approach because it fixes all affected context displays without changing the meaning of existing API-usage helpers.

### Why this approach is better than the alternatives

#### Better than changing `tokenCountFromLastAPIResponse()` globally

That helper is used in non-UI code where the current meaning matters: "usage from the last real API response." Making it return estimated boundary data would blur semantics and increase regression risk.

#### Better than inventing a synthetic assistant usage message

A fake assistant message would be more invasive and could affect:

- transcript semantics
- assistant identity logic
- memoized render triggers tied to assistant messages
- resume / serialization behavior
- analytics assumptions

#### Better than patching each component separately

That would duplicate context-recovery logic and almost certainly miss hidden consumers.

## Design

### 1. Extend compact boundary metadata with post-compact display usage

Add a new optional field to `CompactMetadata` that carries estimated post-compact context usage for display purposes.

Recommended shape:

```ts
postCompactDisplayUsage?: {
  inputTokens: number
  outputTokens: number
  cacheCreationInputTokens: number
  cacheReadInputTokens: number
  estimated: true
}
```

Notes:

- Keep it explicitly display-oriented and explicitly estimated.
- Use internal camelCase naming in app types.
- Map to SDK schema with existing compact-boundary serialization.

### 2. Populate this metadata during compaction

When building the compact boundary, compute estimated post-compact context usage from the final post-compact message set.

For standard compaction, include:

- `boundaryMarker`
- `summaryMessages`
- `messagesToKeep` if present
- `attachments`
- `hookResults`

For session-memory compaction, do the same so both compaction paths behave consistently.

Important: do **not** base this on only the summary text. It must reflect the full post-compact message payload that the UI will actually hold.

### 3. Add new UI-facing helpers in `src/utils/tokens.ts`

Do **not** change the semantics of:

- `tokenCountFromLastAPIResponse()`
- `getCurrentUsage()`

Instead add new helpers with display semantics, for example:

- `getCurrentDisplayUsage(messages)`
- `tokenCountForDisplay(messages)`
- `getDisplayUsageSignature(messages)`

Behavior:

1. Look for the newest real assistant usage that is newer than the latest compact boundary.
2. If none exists, fall back to the latest compact boundary's `postCompactDisplayUsage`.
3. If neither exists, return the same fallback behavior the current UI effectively uses today.

This preserves the meaning of API-usage helpers while giving the UI an immediate post-compact source of truth.

### 4. Update only ctx display surfaces to use the new helpers

#### `src/components/StatusLine.tsx`

Update:

- `buildStatusLineCommandInput(...)` to use `getCurrentDisplayUsage(...)`
- `getLatestUsageSignature(...)` to use `getDisplayUsageSignature(...)`

This is important because the bug is not only stale data; the refresh trigger is also tied to assistant-usage identity.

#### `src/components/PromptInput/Notifications.tsx`

Update footer ctx display / warning computation to use `tokenCountForDisplay(...)` against `getMessagesAfterCompactBoundary(messages)`.

#### `src/screens/REPL.tsx`

Update `emitWebStatus()` to use the display helper so web status matches terminal UI behavior.

## Exact file changes

### Type / schema / serialization

- `src/types/message.ts`
  - extend `CompactMetadata`
- `src/utils/messages.ts`
  - if helpful, allow `createCompactBoundaryMessage(...)` to accept optional post-compact display usage
- `src/utils/messages/mappers.ts`
  - map new compact-boundary metadata to and from SDK shape
- `src/entrypoints/sdk/coreSchemas.ts`
  - extend `SDKCompactBoundaryMessageSchema`
- `src/remote/sdkMessageAdapter.ts`
  - verify compact-boundary metadata keeps round-tripping correctly if adapter uses the schema directly
- `src/QueryEngine.ts`
  - verify SDK compact metadata writer path stays aligned with mapper/schema changes

### Compaction producers

- `src/services/compact/compact.ts`
  - compute and attach post-compact display usage for normal compaction
- `src/services/compact/sessionMemoryCompact.ts`
  - compute and attach post-compact display usage for session-memory compaction

### Shared display helpers

- `src/utils/tokens.ts`
  - add display-oriented usage helpers
  - keep existing real-API helpers unchanged

### UI consumers

- `src/components/StatusLine.tsx`
- `src/components/PromptInput/Notifications.tsx`
- `src/screens/REPL.tsx`

## Implementation steps

1. Extend `CompactMetadata` with `postCompactDisplayUsage`.
2. Extend compact-boundary SDK serialization and schema validation.
3. In normal compaction, compute estimated display usage from the final post-compact message array and attach it to the boundary marker.
4. In session-memory compaction, attach the same kind of display usage.
5. Add `getCurrentDisplayUsage`, `tokenCountForDisplay`, and `getDisplayUsageSignature` in `src/utils/tokens.ts`.
6. Update `StatusLine.tsx` to use the display helpers for both data and refresh signature.
7. Update `Notifications.tsx` to use the display token count.
8. Update `REPL.tsx` web status emission to use the display usage helper.
9. Verify all affected surfaces update immediately after compaction.

## Verification plan

### Manual verification

1. Start a conversation near auto-compact threshold.
2. Trigger manual `/compact`.
3. Confirm immediately, before another assistant reply:
   - status line ctx changes
   - footer ctx / warning changes
   - any web status derived from context changes
4. Trigger auto-compact via threshold crossing.
5. Confirm the same immediate update.
6. Trigger session-memory compaction if available.
7. Confirm the same immediate update.
8. Send one more prompt after compaction and confirm the next real assistant usage supersedes the boundary estimate cleanly.

### Code-level verification

- compact boundary metadata round-trips through:
  - internal message model
  - SDK message mapping
  - schema validation
  - resume / remote paths
- old transcripts without the new metadata still work
- existing non-UI callers of `tokenCountFromLastAPIResponse()` remain unchanged in behavior

## Risks and edge cases

### Estimated vs real usage

This new field is estimated, not API-reported. That is acceptable for UI context displays, but it should not leak into code paths that assume real response usage.

### Partial compact / preserved segment cases

If `messagesToKeep` exists, the estimate must include it. Otherwise the UI will still under-report immediately after compaction.

### Serialization drift

If `CompactMetadata`, mapper code, and SDK schema are not updated together, compact boundaries may silently lose the new field on resume or remote transport.

### Hidden ctx consumers

There may be additional surfaces beyond status line and footer. Before implementing, grep for any use of:

- `getCurrentUsage(`
- `tokenCountFromLastAPIResponse(`
- `getLatestUsageSignature(`

and classify whether each is a real-API semantic consumer or a display consumer.

## Out of scope

- changing billing / analytics semantics
- adding fake assistant messages
- broad refactors of token helper architecture
- changing compact transcript structure beyond boundary metadata

## Success criteria

A compacted conversation updates all user-facing ctx indicators immediately after compaction, without requiring another message, while preserving the existing semantics of real API usage helpers.