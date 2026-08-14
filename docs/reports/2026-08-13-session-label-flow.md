# Session label flow

Date: 2026-08-13

## Scope

This report explains how Cat Code names a session, persists that name, carries it into the desktop application, and chooses the final label rendered in the tab bar, sidebar, and Sessions page.

Authentication and OAuth handling are intentionally out of scope. Provider selection is discussed only where it changes the title request or response shape.

Source is authoritative. Some older comments still use “Haiku title” as a historical name, but the current generator selects the active provider's small, fast model.

## Executive summary

A session label is a **derived display value**, not a single field with one owner.

Three concepts must be kept separate:

1. **Recorded transcript title**: an `ai-title` or `custom-title` entry in the engine transcript.
2. **Desktop registry title**: the app-owned title stored on the host registry row for immediate and restorable desktop display.
3. **Display fallback**: summary, first prompt, workspace basename, or `New session` when no recorded title exists.

For a fresh desktop session, the intended flow is:

```text
first human prompt
  -> first turn settles
  -> sidecar asks the active provider's small model for {title}
  -> sidecar validates the result
  -> engine transcript receives an ai-title entry
  -> sidecar emits session-title
  -> Electron main calls host.setTitle(appSessionId, title)
  -> host registry stores title + titleUpdatedAt
  -> host emits an updated SessionDescriptor
  -> renderer recomputes the winning title
  -> tab, sidebar, and Sessions page repaint
```

If any step before persistence fails, the catalog can still label the row with the first prompt. That fallback can look like a successful naming policy even though AI title generation failed.

## 1. The data model

### 1.1 Engine transcript title

The engine transcript supports two title record types:

- `ai-title`: generated automatically.
- `custom-title`: written by a user rename.

`saveAiGeneratedTitle()` appends an `ai-title` entry (`src/utils/sessionStorage.ts:3485-3517`). `saveCustomTitle()` appends a `custom-title` entry and updates the current-session cache (`src/utils/sessionStorage.ts:3462-3477`).

The distinction is load-bearing. Readers prefer a custom title over an AI title regardless of append order. The AI title is not re-appended as current user metadata on resume, which prevents an old generated title from overwriting a later manual rename (`src/utils/sessionStorage.ts:3485-3505`).

The lightweight transcript reader resolves the recorded title in this order:

```text
customTitle from tail
customTitle from head
aiTitle from tail
aiTitle from head
```

See `src/utils/sessionStorage.ts:5872-5880`.

### 1.2 Desktop registry title

Each desktop session also has a host registry row. Its projected `SessionDescriptor` carries:

```ts
title: string | null
titleUpdatedAt: number | null
```

The contract is defined in `app/shared/hostApi.ts:71-89`.

The registry title gives the desktop app an immediate label without waiting for the global transcript catalog to refresh. `registry.setTitle()` writes both the string and a timestamp (`app/host/registry.ts:768-783`). The timestamp records when the app last received title intent.

This is a second durable copy, not the transcript authority. The two stores are reconciled in the renderer because terminal `/rename` can update only the transcript while a desktop-generated title or desktop rename updates the registry too.

### 1.3 Catalog display title

The sessions catalog derives a display title for every transcript. Its fallback order is:

```text
recorded transcript title
summary
first prompt
workspace basename
null
```

See `resolveEntryTitle()` in `app/sidecar/sessionsCatalogDomain.ts:266-283`.

The catalog exposes two related fields:

- `transcriptTitle`: only a real recorded custom or AI title.
- `title`: the broader display cascade, which may be only a summary, first prompt, or basename.

Keeping these separate is essential. A first-prompt fallback must never outrank a real registry title during reconciliation (`app/sidecar/sessionsCatalogDomain.ts:197-207`).

## 2. Automatic title generation

### 2.1 Shared generator

`generateSessionTitle()` is the shared engine entry point (`src/utils/sessionTitle.ts:89-194`). It:

1. Rejects an empty description.
2. Defines the closed schema `{ title: string }`.
3. Selects the active provider's small, fast model.
4. Builds provider-specific instruction assembly.
5. Requests structured output.
6. Parses and schema-validates the result.
7. Trims the title and returns `string | null`.

The prompt asks for a concise sentence-case title of three to seven words (`src/utils/sessionTitle.ts:68-78`).

The structured-output mechanism differs by provider:

- **Anthropic path**: register and force the synthetic `StructuredOutput` tool, then read its `tool_use.input`.
- **Codex/OpenAI path**: send native `output_config.format` JSON schema, then parse the returned text block as JSON.

The provider split is in `src/utils/sessionTitle.ts:106-180`. The Codex adapter converts `output_config.format` into the Responses API `text.format` contract (`src/services/api/codex-fetch-adapter.ts:1350-1375`).

Generation errors and invalid output return `null`; they do not throw to the caller (`src/utils/sessionTitle.ts:185-190`).

### 2.2 Terminal timing and retry policy

The terminal REPL finds the first real, non-meta human message and skips synthetic slash-command, local-command, and bash breadcrumbs (`src/screens/REPL.tsx:3004-3021`). It schedules title generation when the input will actually query the model (`src/screens/REPL.tsx:3072-3089`).

If generation succeeds, the REPL updates its local title and writes `ai-title`, provided a custom title was not set while generation was running. If generation returns `null`, the terminal clears its attempted flag and may retry on a later real prompt.

### 2.3 Desktop timing and retry policy

The desktop sidecar owns a separate one-shot policy wrapper around the shared generator (`app/sidecar/sessionTitleGen.ts:52-107`).

For a fresh session:

1. A human submit starts through the sidecar's common turn path with `generateTitle: true` (`app/sidecar/sidecarServer.ts:1746-1751`).
2. When the turn promise settles, the sidecar calls `maybeGenerate()` with that prompt (`app/sidecar/sidecarServer.ts:1460-1469`).
3. The wrapper skips resumed sessions, missing engine IDs, existing titles, and empty prompts.
4. On success it writes `ai-title` and invokes the live title callback.

The desktop wrapper marks itself attempted before the request and does not reset on `null` (`app/sidecar/sessionTitleGen.ts:74-96`). Therefore desktop generation is strictly one-shot. It also never generates for a resumed session (`app/sidecar/sessionTitleGen.ts:82-83`).

This differs from the terminal retry behavior and explains why an old or failed desktop session cannot be used to verify a generator fix. Verification requires a brand-new session.

## 3. Live desktop propagation

After the sidecar has a title, it broadcasts a `session-title` frame (`app/sidecar/sidecarServer.ts:3425-3445`). The frame contains:

```ts
{
  kind: 'session-title'
  protocolVersion
  sessionId // appSessionId
  title
}
```

The frame type is defined in `app/shared/protocol.ts:2676-2694`.

Electron main intercepts this frame. It does not forward the frame directly to the renderer. Instead it calls `host.setTitle(appSessionId, title)` (`app/main/main.ts:1420-1433`).

The host:

1. Validates the app session ID.
2. Length-caps the display title.
3. Persists it through the registry.
4. Emits an updated session status/descriptor.

See `app/host/host.ts:547-567`.

The renderer already consumes host descriptor events, so no special title-only renderer state is needed. The updated descriptor causes normal shell state and selectors to recompute.

## 4. Manual rename

A desktop rename uses the same engine persistence primitive as terminal `/rename`.

`createRealSessionActionsExecutor().rename()` calls `saveCustomTitle()` for the current engine session and transcript (`app/sidecar/sessionActionsDomain.ts:82-95`). After the operation succeeds, the sidecar reuses `broadcastSessionTitle()` so the desktop registry and live renderer update immediately (`app/sidecar/sidecarServer.ts:2407-2412`).

Thus a successful desktop rename writes both sides:

```text
engine transcript custom-title
and
desktop registry title + titleUpdatedAt
```

A terminal rename writes the transcript but cannot directly write the Electron registry. The catalog reconciliation rule handles that case.

## 5. Reconciliation: choosing the winning real title

The renderer merges registry descriptors with the global transcript catalog in `selectMergedSessionRows()` (`app/renderer/src/sessionsCatalogState.ts:173-249`).

For a registry-backed row, `pickTitle()` chooses the winner (`app/renderer/src/sessionsCatalogState.ts:287-305`):

1. A non-empty recorded transcript title wins if the catalog snapshot was captured after the registry's `titleUpdatedAt`.
2. Otherwise a non-empty registry title wins.
3. Otherwise the catalog display title wins.
4. Otherwise the resolved title is `null`.

The timestamp comparison solves two opposite races:

- A newer terminal rename must eventually replace an older registry title.
- A stale catalog snapshot must not temporarily revert a fresh desktop rename.

Only `transcriptTitle` can win by timestamp. The broader catalog `title` cannot, because it may merely contain the first prompt.

For tab surfaces that begin with a single `SessionDescriptor`, `withResolvedTitle()` applies the same rule before `tabLabel()` is called (`app/renderer/src/sessionsCatalogState.ts:308-325`; `app/renderer/src/App.tsx:1148-1154`).

## 6. Final display fallback

After reconciliation, display components still require a non-empty string.

For tabs and workspace-panel selectors, `tabLabel()` uses:

```text
descriptor.title
workspace basename
"New session"
```

See `app/renderer/src/tabBarModel.ts:4-10`.

For merged sidebar and Sessions-page rows, `resolveSessionLabel()` applies the same title/basename/fallback rule (`app/renderer/src/sessionsCatalogState.ts:156-165`). The resulting `displayLabel` is rendered by the sidebar (`app/renderer/src/Sidebar.tsx:1533-1535`) and Sessions page (`app/renderer/src/SessionsPage.tsx:681-698`).

For a history-only transcript, the catalog has no registry descriptor to merge. Its catalog `title` is used directly, so the visible label may legitimately be its summary or first prompt when no title record exists.

## 7. Restore and history behavior

A normal registry restore reuses the row's existing title. Automatic generation is disabled because the sidecar is resumed.

Opening a history-only catalog row creates a desktop session from the catalog's engine session ID and workspace. Main may seed the new registry row with the catalog display title (`app/main/openHistorySession.ts:85-120`). Because this value can be a fallback, the renderer's later merge still distinguishes a recorded `transcriptTitle` from the broader display title.

No automatic backfill generates titles for old sessions. Existing sessions without `ai-title` or `custom-title` continue to use summary, first prompt, or workspace fallback unless manually renamed.

## 8. Why a first message appears as the label

Seeing the first message does not prove that generation used the first message as its successful title. It can mean either:

1. The generated title happened to resemble the prompt.
2. No recorded title exists, so the catalog selected `firstPrompt` as a fallback.

The second case is the important failure mode. Because the fallback is useful and non-empty, the UI does not show an error or blank state. A failed model request, invalid structured response, failed transcript write, or missing live frame can therefore look like normal naming.

To distinguish the cases, inspect whether the transcript contains `ai-title` or `custom-title`, and whether the desktop registry row has a title with `titleUpdatedAt`. The displayed string alone is insufficient evidence.

## 9. Recent Codex failure chain

The recent desktop defect had two sequential blockers:

1. The title request initially selected an Anthropic small model during a Codex session. The request failed and returned `null`.
2. After provider routing was corrected, the request reached Codex, but the caller still used the synthetic `StructuredOutput` tool. The Codex adapter intentionally filters that internal tool and changes its forced choice to `auto` (`src/services/api/codex-fetch-adapter.ts:708-743`). Codex returned normal text, while the caller parsed only a tool call, so the successful response was discarded.

The current implementation resolves the second mismatch by using native JSON-schema output on Codex and retaining the synthetic-tool path for Anthropic (`src/utils/sessionTitle.ts:106-180`).

The bug survived earlier tests because the generator test mocked `queryModelWithoutStreaming()` to return the ideal Anthropic tool-call shape. It did not cross the adapter boundary that removed the tool. Current tests pin both contracts:

- Provider-specific request and response parsing: `src/utils/sessionTitle.test.ts`.
- Codex adapter translation from `output_config.format` to native `text.format` while filtering `StructuredOutput`: `src/services/api/codex-fetch-adapter.test.ts`.
- Desktop one-shot persistence and frame propagation: `app/sidecar/sessionTitleGen.test.ts` and the P4-6 title tests in `app/sidecar/sidecarServer.test.ts`.

## 10. Failure points and observability

| Stage | Failure effect | Visible result |
|---|---|---|
| First prompt classification | No generation attempt | Catalog fallback |
| Provider/model routing | Generator returns `null` | Catalog fallback |
| Structured-output request | Provider returns incompatible shape | Catalog fallback |
| JSON/tool parsing | Result rejected | Catalog fallback |
| Existing-title guard | Generation skipped | Existing title or fallback remains |
| `ai-title` transcript write | Live callback still runs best-effort | Label updates now, but may not survive catalog/restore |
| `session-title` frame with no connection | Frame is not replayed | Registry may remain unchanged until another source supplies a title |
| Host registry write | Descriptor is not updated | Renderer keeps previous label |
| Catalog refresh | Transcript rename/title arrives late | Registry title or fallback remains temporarily |
| Resume | Generation intentionally skipped | Existing title/fallback remains |

The generator logs a success/failure telemetry event and writes a debug error when the request throws, but its public contract remains `string | null`. The desktop wrapper also treats persistence as best-effort and does not surface a title-generation error to the UI. This keeps naming non-blocking, but it makes end-to-end verification important.

## 11. Practical verification

A valid end-to-end desktop check requires:

1. Start a **brand-new** desktop session, not a restored one.
2. Submit a real human prompt.
3. Wait for the first turn to settle.
4. Confirm the tab/sidebar changes to a concise generated title.
5. Confirm the engine transcript contains an `ai-title` entry.
6. Confirm the registry row carries the same title and a non-null `titleUpdatedAt`.
7. Close and restore the session, then confirm the label survives.

A unit test that mocks only the final `AssistantMessage` cannot prove this path. At minimum, tests must pin the provider-specific request contract and the adapter's actual response representation.

## 12. Ownership map

| Concern | Owner |
|---|---|
| Title prompt, provider-specific request, parsing | `src/utils/sessionTitle.ts` |
| Transcript title persistence and read preference | `src/utils/sessionStorage.ts` |
| Terminal first-message trigger and retry | `src/screens/REPL.tsx` |
| Desktop one-shot policy | `app/sidecar/sessionTitleGen.ts` |
| Desktop turn trigger and title frame | `app/sidecar/sidecarServer.ts` |
| Desktop frame contract | `app/shared/protocol.ts` |
| Main-process title interception | `app/main/main.ts` |
| Registry persistence and timestamp | `app/host/registry.ts`, `app/host/host.ts` |
| Catalog title and first-prompt fallback | `app/sidecar/sessionsCatalogDomain.ts` |
| Registry/catalog precedence | `app/renderer/src/sessionsCatalogState.ts` |
| Final tab fallback | `app/renderer/src/tabBarModel.ts` |
| Sidebar and Sessions-page rendering | `app/renderer/src/Sidebar.tsx`, `app/renderer/src/SessionsPage.tsx` |

## Conclusion

The key mental model is:

```text
A generated title is persisted metadata.
A registry title is the desktop's immediate copy.
A session label is the renderer's resolved presentation.
The first prompt is only a fallback.
```

When diagnosing naming, verify each layer separately. A non-empty label proves only that fallback resolution worked; it does not prove that title generation, persistence, propagation, or reconciliation succeeded.
