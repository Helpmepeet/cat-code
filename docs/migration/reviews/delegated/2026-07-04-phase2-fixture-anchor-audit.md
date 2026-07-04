# Phase-2 fixture realism and anchor audit — 2026-07-04

## Scope and method

Read-only cold sweep of `/Users/pt/cat-code` on branch `migration`, requested
HEAD `010e8ba`. I ignored `src/components/Settings/`, commit `983b57d`, the
known sidecar typecheck carry-forward, and all credential-consuming/app turns.
No source, test, fixture, or status file was changed.

Verdicts:

- **HOLDS** — the cited producer/type and claimed behavior are present, and the
  checked shape can be emitted.
- **DRIFTED** — the claim/symbol still exists, but the cited location or
  producer attribution is stale; the correct current location is given.
- **WRONG** — the named claim is absent/opposite in the current tree, or the
  fixture shape cannot be produced by the cited real path.

For Part A, “field-for-field” means structural wire fidelity. Deliberately
human-readable sentinel values (session IDs, UUID-like fixture IDs, timestamps,
paths, and prose) were not required to equal a particular runtime value; the
engine schema itself accepts these fields as strings. Required/always-attached
fields, discriminants, nesting, and producer-specific result payloads were
checked.

### Baseline/provenance command output

```text
$ git branch --show-current
migration
$ git rev-parse --short=7 HEAD
010e8ba
$ git log --oneline -- app/renderer/src/sdkMessageFixtures.ts
1ceb869 Merge branch 'migration-p2-3-streaming' into migration
8557d43 Merge branch 'migration-p2-2' into migration
49abf37 migration(P2-1): core transcript rows
356d63a migration(P2-3): streaming/activity engine
c7ea717 migration(P2-2): tool-card families + tool_use/tool_result correlation
1c9e5d7 migration(P2-0 review): apply F1/F3/F4 fixes from cold review
12a590d migration(pre-P2/P3): Phase-3 backlog + D2–D5 decisions
```

`12a590d` is therefore the requested P2-0 baseline. The three projector commits
are parallel children of `1c9e5d7`; their fixture diffs show:

```text
49abf37: 42 changed lines; no new SDK_MESSAGE_FIXTURE object
c7ea717: 168 changed lines; five new SDK_MESSAGE_FIXTURE objects
356d63a: 87 changed lines; one new S1_STREAMING_TEXT_TURN sequence (8 messages)
```

This exposes a provenance/count error in the P2-2 STATUS row:
`sdkMessageFixtures.ts` did **not** gain “+9 samples.” It gained five fixture
entries (and changed the pre-existing `server_tool_use` entry). The original
55-entry fixture therefore became 60 entries, plus P2-3's separate eight-message
sequence. I did not re-audit unchanged P2-0 samples. To make absence meaningful,
the P2-1 table lists every pre-existing sample whose P2-1 row contract changed,
but realism was re-opened only where P2-1 changed shape/meaning.

The pre-existing dirty worktree was:

```text
 M docs/codex/2026-07-04-usage-reset-design.md
 M src/components/Settings/Reset.tsx
 M src/components/Settings/redeemResetMachine.test.ts
 M src/components/Settings/redeemResetMachine.ts
?? docs/migration/reviews/2026-07-04-phase2-review.md
?? docs/reports/2026-07-04-workspace-map-usage-evaluation.md
```

## Part A — post-P2-0 fixture realism

### P2-1: every sample whose row contract changed (12)

| Item | Verdict | Current evidence and field comparison |
|---|---|---|
| `assistant: thinking block` | **HOLDS** | Fixture `sdkMessageFixtures.ts:169-195`. Codex mints `reasoning_kind` at `src/services/api/codex-fetch-adapter.ts:1422-1426`; `src/services/api/claude.ts:2192-2211` accepts only `summary`/`raw` and copies it to `reasoningKind`, then the full block is yielded at `:2371-2391` and wrapped at `src/utils/queryHelpers.ts:110-117`. The fixture's `type`, `thinking`, `signature`, `reasoningKind:'summary'`, null stop reason, usage, parent, session and UUID fields are all producible. |
| `assistant: redacted_thinking block` | **HOLDS** | Fixture `:198-218`; SDK `RedactedThinkingBlock` requires exactly `data` + `type` (`node_modules/@anthropic-ai/sdk/resources/messages/messages.d.mts:779-786`), and the normal assistant mint/wrap is `claude.ts:2371-2391` → `queryHelpers.ts:110-117`. The cited renderer case remains at `src/components/Message.tsx:538-551`. |
| `user: plain prompt` | **HOLDS** | Fixture `:674-685`; `normalizeMessage` emits role/content, null parent, session, UUID, timestamp, optional synthetic/result fields at `src/utils/queryHelpers.ts:203-217`. String content is accepted by `createUserMessage` at `src/utils/messages.ts:461-523`. |
| `user: text + image blocks` | **HOLDS** | Fixture `:815-839`; `SDKUserMessage.message.content` accepts `ContentBlockParam[]` (`coreTypes.generated.ts:299-312`), including text and base64 image blocks. QueryEngine emits the array unchanged through `queryHelpers.ts:203-217`; the cited user-image renderer case is still `src/components/Message.tsx:405-418`. |
| `user: command replay` | **WRONG** | Fixture `:842-864` contains only `<command-message>` and `<command-args>`. A real slash-command breadcrumb is minted by `formatCommandInputTags` at `src/utils/messages.ts:577-584` and always also contains `<command-name>/compact</command-name>`. The cited `processSlashCommand.tsx:795` formatter likewise includes `<command-name>`. `QueryEngine.ts:795-807` can replay an existing message verbatim, but neither cited command producer mints the fixture's claimed “real tagged command echo.” Correct the sample to the three-tag shape, or relabel it as arbitrary replay content and anchor only `QueryEngine.ts:795-807`/`:933-949`. `reach:'app-seam'` itself is correct. |
| `system: init` | **HOLDS** | Fixture `:884-907`; `buildSystemInitMessage` at `src/utils/messages/systemInit.ts:53-95` supplies the same required fields: cwd/session/tools/MCP/model/mode/commands/key source/betas/version/style/agents/skills/plugins/UUID plus `fast_mode_state`. Optional plugin `source` may disappear on JSON serialization when undefined. |
| `system: compact_boundary` | **HOLDS** | Fixture `:924-934`; current mint `src/QueryEngine.ts:993-999` supplies type/subtype/session/UUID and `toSDKCompactMetadata`, whose required trigger/pre-token shape matches. |
| `system: api_retry` | **HOLDS** | Fixture `:971-990`; current mint `src/QueryEngine.ts:1001-1013` supplies all shown retry fields, and `SDKAPIRetryMessageSchema` requires the same set at `src/entrypoints/sdk/coreSchemas.ts:1628-1643`. |
| `system: local_command_output` | **HOLDS** | Fixture `:993-1004`; correctly labeled `type-only`. `SDKLocalCommandOutputMessageSchema` at `coreSchemas.ts:1646-1657` requires exactly type/subtype/content/UUID/session. The live engine intentionally emits assistant text instead (`src/utils/messages/mappers.ts:196-214`), so `reach:'type-only'` is correct. |
| `result: success` | **DRIFTED** | Shape holds against `SDKResultSuccessSchema` (`coreSchemas.ts:1438-1454`) and the complete current terminal mint at `src/QueryEngine.ts:1193-1212`. Fixture anchor `QueryEngine.ts:1142` is stale; `:1142` is now the generic `type:'result'` line of the error path. Correct location: `QueryEngine.ts:1193-1212`. |
| `result: error_during_execution` | **HOLDS** | Fixture `:1214-1239`; current mint `src/QueryEngine.ts:1140-1174` includes every required result-error field. The fixture's permission-denial entry matches the SDK entry schema, and arbitrary diagnostic strings are permitted in `errors`. |
| `result: error_max_turns` | **HOLDS** | Fixture `:1242-1261`; current mint remains `src/QueryEngine.ts:909-930` and includes every shown field. |

P2-1 result: **10 HOLDS / 1 DRIFTED / 1 WRONG**.

### P2-2: all six fixture entries touched by the commit

This is the complete post-P2-0 set from the commit diff: one modified existing
entry plus five added entries. The STATUS “+9” figure is not supported by the
fixture diff.

| Item | Verdict | Current evidence and field comparison |
|---|---|---|
| Existing `assistant: server_tool_use block` | **HOLDS** | Fixture `:221-247`. The SDK param type permits `id`, `input`, the listed server-tool name and optional `caller` (`messages.d.mts:819-842`). Codex actually emits a caller-less `server_tool_use` at `src/services/api/codex-fetch-adapter.ts:2026-2037`, streams input JSON, and the normal assistant mint/wrap reaches the app seam. `reach:'app-seam'` is correct. |
| Added `assistant: web_search_tool_result block` | **WRONG** | Fixture `:250-277` uses `content:[{type:'text',text:...}]`. The public SDK allows either a `web_search_tool_result_error` or `web_search_result[]`; each result has `type:'web_search_result'`, `title`, `url`, `encrypted_content`, and optional `page_age` (`messages.d.mts:1622-1635,1738-1766`). CatCode's Codex adapter emits `content:sources`, where each source is `{title,url}` (`codex-fetch-adapter.ts:1976-2012,2061-2072`). Neither real producer can emit a text-block result. The cited `messages.ts:3137` is only a consumer switch and `:1306-1328` only orphan detection; neither validates the result payload. `reach:'app-seam'` is plausible, but the sample payload is impossible. |
| Added `assistant: FileEditTool diff result riding a user reply` (tool-use half) | **DRIFTED** | The assistant `tool_use` shape is valid: FileEdit input keys match `src/tools/FileEditTool/types.ts:5-19`, and generic assistant mint/wrap is `claude.ts:2371-2391` → `queryHelpers.ts:110-117`. The fixture anchor incorrectly cites the **output** schema (`FileEditTool/types.ts:63-80`), which cannot substantiate this assistant tool-use frame. Correct producer/type anchors: `FileEditTool/types.ts:5-19` and `claude.ts:2371-2391`. |
| Added `user: FileEditTool tool_result carrying structuredPatch` | **WRONG** | The `tool_use_result` object itself faithfully matches all required output fields at `FileEditTool/types.ts:63-80`; it is minted at `src/tools/FileEditTool/FileEditTool.ts:412-425`, and `structuredPatch` comes from `getPatchForEdit`. But the same real success path maps the user-visible block at `FileEditTool.ts:427-445` to **string** content `"The file … has been updated successfully."`, with `is_error` omitted. The fixture instead uses a text-block array, different prose, explicit `is_error:false`, and `isSynthetic:true`; normal tool execution creates this user message without `isMeta`, so `queryHelpers.ts:203-217` does not produce `isSynthetic:true`. This composite sample cannot be emitted field-for-field by the FileEdit path it names. |
| Added `user: tool_result error` | **HOLDS** | Structurally allowed by `ToolResultBlockParam` (`messages.d.mts:1160-1169`) and `SDKUserMessage` (`coreTypes.generated.ts:299-312`). The engine has a concrete error mint at `src/query.ts:133-157` (`tool_result`, string error content, `is_error:true`) and normalizes it at `queryHelpers.ts:203-217`. Text-array error content and the optional fields shown are SDK-valid. The fixture's anchor is weak—it is a read site, not a mint—but has not drifted (`queryHelpers.ts:478` still reads the flag). |
| Added `user: subagent-scoped tool_result` | **HOLDS** | The defining reach field is real: progress re-emission at `src/utils/queryHelpers.ts:141-153` emits user content unchanged and sets `parent_tool_use_id: message.parentToolUseID`; session, UUID, timestamp, optional synthetic/result fields follow there. Tool-result block fields are SDK-valid. `reach:'app-seam'` is correct. |

P2-2 result: **3 HOLDS / 1 DRIFTED / 2 WRONG**.

### P2-3: added `S1_STREAMING_TEXT_TURN` sequence

| Item | Verdict | Current evidence and field comparison |
|---|---|---|
| `S1 streaming text turn` (8-message sequence, fixture `:1428-1508`) | **WRONG** | Six `stream_event` frames omit `session_id` and `parent_tool_use_id`, although QueryEngine's only app-seam wrapper always adds both (`src/QueryEngine.ts:876-883`). Its `message_start.message` contains only `id`; a real `RawMessageStartEvent` requires a full SDK `Message` (`messages.d.mts:541-648,771-778`), and CatCode's Codex adapter concretely emits `id,type,role,content,model,stop_reason,stop_sequence,usage` (`codex-fetch-adapter.ts:1289-1307`). The sequence's authoritative assistant frame likewise omits `model`, `stop_sequence`, and `usage`, fields present on the real content-block-stop frame because `claude.ts:2371-2380` spreads that full message-start object. The text-start/delta/stop nested events themselves are producible (Codex adapter `:2087-2118`), and the terminal result is a valid success shape. Because seven of eight frames cannot be emitted field-for-field at the labeled app seam, the sequence as a realism fixture is wrong. The weakness is hidden by `SDKPartialAssistantMessage.event?:unknown` and optional wrapper fields (`coreTypes.generated.ts:114-120`), not validated by the mapped-type tripwire. |

P2-3 result: **0 HOLDS / 0 DRIFTED / 1 WRONG**.

### Part A totals

**13 HOLDS / 2 DRIFTED / 4 WRONG (19 checked items).**

The four WRONG items are the command replay, web-search result, FileEdit result,
and P2-3 streaming sequence. The P2-3 row counts as one exported fixture sample;
its seven malformed member frames are fully enumerated above rather than
inflating the item count.

## Part B — current-tree anchor drift

Repeated citations to the same file/range and same behavior are consolidated
once. A citation to the same range for a materially different claim is listed
separately. Unnumbered file references are not `file:line` anchors and are out
of this part's count.

### Phase-2 STATUS rows P2-1..P2-4

| Cited anchor / named behavior | Verdict | Current evidence |
|---|---|---|
| `src/utils/messages.ts:1306-1328` — unresolved server/MCP tool-use orphan handling (P2-2) | **HOLDS** | Exact region still marks unresolved `server_tool_use`/`mcp_tool_use` IDs errored. |
| `src/tools/FileEditTool/types.ts:63-80` — one-file FileEdit output with `structuredPatch` hunks (P2-2) | **HOLDS** | Exact output schema and required fields remain there. |
| `app/renderer/src/rawMessageLog.ts:5` — 512-message retention cap (P2-4) | **HOLDS — verified by lead, skipped** | Lead-supplied verification; current line 5 is `DEFAULT_MAX_RAW_MESSAGES = 512`. |

STATUS subtotal: **3 HOLDS / 0 DRIFTED / 0 WRONG**.

### `docs/migration/decisions/PERMISSION-BOUNDARY.md`

| Cited anchor / named behavior | Verdict | Correct current evidence |
|---|---|---|
| `src/utils/permissions/PermissionPromptToolResultSchema.ts:95-106` — apply and persist updates | **HOLDS — verified by lead, skipped** | Lead-supplied verification; region is unchanged. |
| `app/sidecar/sidecarServer.ts:678` — response-key allowlist / raw `updatedPermissions` rejection | **DRIFTED** | Correct current location `sidecarServer.ts:848-860` (allowlist) and `:872-875` (unexpected-key rejection). |
| `sidecarServer.ts:457` — sanitizer strips renderer updates | **DRIFTED** | Correct current location `sidecarServer.ts:586-602`. |
| `src/types/permissions.ts:206` — `suggestions?: PermissionUpdate[]` | **HOLDS** | Exact line. |
| `src/app-runtime/appRuntimeCanUseTool.ts:68` — request `permission_suggestions` | **HOLDS** | Exact line in request construction. |
| `src/entrypoints/sdk/coreTypes.generated.ts:478-489` — control permission request | **HOLDS** | Exact type and fields. |
| `BashPermissionRequest.tsx:346` — ordinary allow-once sends `[]` | **DRIFTED** | Line 346 is now the empty editable-prefix branch. Ordinary `case 'yes'` allow-once is `src/components/permissions/BashPermissionRequest/BashPermissionRequest.tsx:383-396`. |
| `BashPermissionRequest.tsx:399-404` — always-allow sends suggestions | **HOLDS** | Exact current switch arm and call. |
| `src/hooks/toolPermission/handlers/interactiveHandler.ts:154-166` — allow callback forwards updates | **HOLDS** | Exact region. |
| `interactiveHandler.ts:275` — `permanent` derives from non-empty updates | **HOLDS** | Exact line. |
| `app/shared/protocol.ts:182-196` — `PermissionResponseInput` contract | **DRIFTED** | `:182-196` now defines C3 context/frame. Correct current permission response type: `app/shared/protocol.ts:289-302`. |
| `app/sidecar/sidecarServer.ts:363` — `handlePermissionResponse` ordering | **DRIFTED** | Correct method `sidecarServer.ts:492-554`: pending lookup `:502-514`, selection `:522-530`, sanitize `:532-540`, attach `:548-551`, resolve `:553`. |
| `sidecarServer.ts:745` — `validateSuggestionSelection` | **DRIFTED** | Correct current function `sidecarServer.ts:979-1036`. |
| `app/shared/limits.ts:50` — max 16 selections | **HOLDS** | Exact line. |
| `sidecarServer.ts:419` — clone selected engine objects | **DRIFTED** | Correct current location `sidecarServer.ts:542-551`. |
| `sidecarServer.ts:393` — read selection from raw frame after Zod parse | **DRIFTED** | Shared parse is `sidecarServer.ts:279-291`; raw frame reaches the handler at `:327-329`, is read at `:516-526`, and field extraction is `:984-986`. |
| `src/app-runtime/AppSessionController.ts:87-100` — respond to pending request | **HOLDS** | Exact method. |
| `src/app-runtime/appRuntimeCanUseTool.ts:90-96` — normalized allow spreads response | **HOLDS** | Exact region. |
| `src/utils/permissions/PermissionUpdate.ts:196` — apply updates | **HOLDS** | Exact function. |
| `PermissionUpdate.ts:349` — persist update list | **HOLDS** | Exact function. |
| `PermissionUpdate.ts:208-216` — persistence destinations | **HOLDS — verified by lead, skipped** | Lead-supplied verification; exact region. |
| `src/tools/BashTool/bashPermissions.ts:2534` — suggested destination `localSettings` | **HOLDS** | Exact line. |
| `app/main/main.ts:294` — `coercePermissionResponse` | **DRIFTED** | Line 294 is now C2 mode validation. Correct function and fail-closed selection coercion: `app/main/main.ts:373-413`. |
| `BashPermissionRequest.tsx:348-357` — editable prefix update | **HOLDS** | Exact region. |
| `bashToolUseOptions.tsx:56` — editable-prefix option data | **HOLDS** | Exact field; option construction remains `:78-97`. |
| `BashPermissionRequest.tsx:368-377` — classifier-reviewed update | **HOLDS** | Exact region. |
| `ExitPlanModePermissionRequest.tsx:65-75` — allowed-prompt rules | **HOLDS** | Exact region. |
| `sidecarServer.test.ts:381` — C1 happy path | **DRIFTED** | Correct test begins `app/sidecar/sidecarServer.test.ts:411`; cloned/deep-equal/gated-input assertions `:440-449`. |
| `sidecarServer.test.ts:422` — empty selection | **DRIFTED** | Correct test begins `:452`. |
| `sidecarServer.test.ts:453` — out-of-range selection | **DRIFTED** | Correct test begins `:483`. |
| `sidecarServer.test.ts:484` — no suggestions | **DRIFTED** | Correct test begins `:514`. |
| `sidecarServer.test.ts:515` — malformed selections | **DRIFTED** | Correct test begins `:545`; all six cases are `:570-575`. |
| `sidecarServer.test.ts:555` — selection on deny | **DRIFTED** | Correct test begins `:585`. |
| `sidecarServer.test.ts:586` — two concurrent pending requests | **DRIFTED** | Correct test begins `:616`; own-request assertions `:665-673`. |
| `ExitPlanModePermissionRequest.tsx:57-77` — `buildPermissionUpdates` | **HOLDS** | Exact function. |
| `src/utils/permissions/permissions.ts:521-531` — `dontAsk` ask→deny | **HOLDS** | Exact region (message follows at `:533`). |
| `src/types/permissions.ts:28-36` — internal/feature-gated modes | **HOLDS** | Exact region. |
| `src/hooks/useReplBridge.tsx:427-440` — bypass double gate | **HOLDS** | Exact region. |
| `getNextPermissionMode.ts:42,62` — bypass cycle gates | **HOLDS** | Both exact lines still test availability. |
| `src/Tool.ts:142-150` — empty context disables bypass | **HOLDS** | Exact function. |
| `useReplBridge.tsx:449-461` — centralized mode transition | **HOLDS** | Exact region. |
| `src/utils/permissions/permissionSetup.ts:597` — `transitionPermissionMode` | **HOLDS** | Exact function start; transition cleanup continues through `:645`. |
| `app/sidecar/sessionController.ts:37-43` — `createSidecarSessionController` owns `appStateStore` | **DRIFTED** | P2-4 refactored/implemented the capability: settings context is loaded at `:40-77`, store is created in `createNormalSidecarQueryEngineConfig` at `:80-105`, and `createSidecarSessionController` starts at `:118`. |
| `app/sidecar/index.ts:53-60` — construction wiring | **HOLDS** | Exact region passes `{controller, permissions}` into `SidecarServer`. |
| `src/web/appSessionProtocol.ts:43-48` — shared client schema excludes app-owned mode frame | **HOLDS** | Exact union remains unchanged. |
| `src/web/AppSessionWebSocketServer.ts:113` — WS uses shared schema | **HOLDS** | Exact parse line. |
| `src/web/appSessionProtocol.ts:157-165` — engine-owned ready payload | **HOLDS** | Exact type; no permission context was added. |
| `src/state/store.ts:29-32` — subscribe | **HOLDS** | Exact implementation. |
| `src/utils/permissions/permissions.ts:443-452` — hooks persist/apply context changes | **HOLDS** | Exact region. |
| `src/types/permissions.ts:427-441` — context, including directory Map | **HOLDS** | Exact type. |
| `app/shared/jsonSafe.ts:135-137` — reject Map/non-plain objects | **HOLDS** | Exact tag check and rejection branch. |
| `app/shared/secretGuard.ts:52` — outbound secret scan | **HOLDS** | Function comment at `:52`, `scanForSecrets` at `:53-55`. |
| `src/app-runtime/AppSessionController.ts:102-125` — abort mass-denies and aborts | **HOLDS** | Exact method. |
| `AppSessionController.ts:213-219` — pending entry set once | **HOLDS** | Exact region (`set` starts at `:214`). |
| `appRuntimeCanUseTool.ts:62-74` — pending request carries suggestion object | **HOLDS** | Exact construction. |
| `src/state/AppStateStore.ts:535-538` — generic default app state uses empty permission context | **HOLDS** | Exact region. This remains true for the generic default store, but no longer describes sidecar bootstrap. |
| `src/utils/permissions/permissionSetup.ts:1000` — settings-rule application | **HOLDS** | Exact line. |
| `app/sidecar/sessionController.ts:37` — sidecar currently uses `getEmptyToolPermissionContext` and loads no settings rules | **WRONG** | The symbol appears only in the historical defect comment at `:35-38`. Current sidecar code does the opposite: `loadSidecarToolPermissionContext` at `:40-77` calls the real initializer, and the store uses it at `:80-85`. This is an implemented P2-4 fix, not anchor drift to another live defect location. |

Permission-decision subtotal: **40 HOLDS / 17 DRIFTED / 1 WRONG**.

Lead-skip ledger (not additional count): the supplied lead verification covered
`snipProjection.ts:6`, `QueryEngine.ts:815-818`, `mappers.ts:183-214`,
`rawMessageLog.ts:5`, `PermissionPromptToolResultSchema.ts:95-112`,
`PermissionUpdate.ts:208-216`, and a `permissionSetup.ts:689` region. The last
region is not itself a `file:line` citation in the current four source
documents, so it is not added to the count.

### `docs/migration/2026-07-04-p2-1-transcript-seam-gaps.md`

| Cited anchor / named behavior | Verdict | Current evidence |
|---|---|---|
| `src/services/compact/snipProjection.ts:6` — snip boundary helper | **HOLDS — verified by lead, skipped** | Lead-supplied verification. |
| `src/QueryEngine.ts:815-818` — tombstone consumed, not yielded | **HOLDS — verified by lead, skipped** | Lead-supplied verification. |
| `src/utils/messages/mappers.ts:183-214` — local-command output becomes synthetic assistant | **HOLDS — verified by lead, skipped** | Lead-supplied verification. |

Seam-gap subtotal: **3 HOLDS / 0 DRIFTED / 0 WRONG**.

### `docs/migration/reviews/2026-07-04-p2-2-mcp-tool-block-types.md`

| Cited anchor / named behavior | Verdict | Current evidence |
|---|---|---|
| `src/utils/messages.ts:1319-1320` — MCP/server tool-use consumer switch | **HOLDS** | Exact lines. |
| `src/utils/messages.ts:2762` — `mcp_tool_result` normalize pass-through | **HOLDS** | Exact line. |
| `src/utils/messages.ts:3140` — stream block-start consumer | **HOLDS** | Exact line. |
| `node_modules/@anthropic-ai/sdk/resources/messages/messages.d.mts:435` — public `ContentBlock` lacks MCP pair | **HOLDS** | Exact union; `ContentBlockParam` at `:439` also lacks the pair. |
| `src/entrypoints/sdk/coreTypes.generated.ts:1` — SDK `ContentBlockParam` import | **HOLDS** | Exact import. |
| `src/entrypoints/sdk/coreTypes.generated.ts:96` — assistant content is `unknown[]` | **HOLDS** | Exact line. |

MCP-note subtotal: **6 HOLDS / 0 DRIFTED / 0 WRONG**.

### Part B totals

**52 HOLDS / 17 DRIFTED / 1 WRONG (70 checked citation items).**

The many DRIFTED permission anchors are mostly a uniform consequence of P2-4
adding code above the already-implemented C1 methods/tests. The single WRONG
claim is deliberately stale historical defect prose: P2-4 fixed the sidecar
settings loader. No permission security symbol or test named by the decision is
absent.

## Ranked WRONG and materially DRIFTED findings

1. **P2-3 streaming sequence is wrong-shaped (Part A WRONG, phase-verdict
   material).** It omits wrapper fields QueryEngine always emits and full
   message fields the real stream/assistant producer supplies. Because the SDK
   alias types `event` as `unknown` and makes wrapper fields optional, current
   typechecks/tests do not establish fixture realism.
2. **P2-2 web-search result payload is impossible (Part A WRONG,
   phase-verdict material).** A text block is neither the SDK web-search result
   shape nor CatCode Codex adapter's `{title,url}` source shape.
3. **P2-2 FileEdit result composite is impossible for the named producer (Part
   A WRONG, phase-verdict material).** The structured output is correct, but the
   user block's content representation/prose and synthetic/error flags do not
   match FileEdit's real mapper.
4. **P2-1 command echo omits the required real command-name tag (Part A WRONG,
   phase-verdict material).** It tests the projector's heuristic with a shape
   neither cited command formatter mints.
5. **P2-2 STATUS “+9 samples” provenance/count is false (material audit
   accounting).** The commit adds five fixture entries and modifies one
   pre-existing entry. This does not itself break projection but makes the
   claimed coverage set unauditable without reconstructing the diff.
6. **Permission decision test/source anchors drifted in bulk (Part B
   DRIFTED, cosmetic/navigation impact).** The C1 tests moved from
   `:381/:422/:453/:484/:515/:555/:586` to
   `:411/:452/:483/:514/:545/:585/:616`; core sidecar methods moved similarly.
   All named behaviors remain.
7. **Permission §8 sidecar-empty-context claim is now opposite to source (Part
   B WRONG, non-regressive).** It is stale because P2-4 implemented the required
   fix at `app/sidecar/sessionController.ts:40-85`; STATUS already says the fix
   landed earlier in the same P2-4 row.
8. **Result-success and FileEdit tool-use producer anchors are stale or
   misattributed (Part A DRIFTED).** Correct locations are
   `QueryEngine.ts:1193-1212` and
   `FileEditTool/types.ts:5-19` + `claude.ts:2371-2391`.

## Final counts and GREEN impact

- Part A: **13 HOLDS / 2 DRIFTED / 4 WRONG**.
- Part B: **52 HOLDS / 17 DRIFTED / 1 WRONG**.

**Could this change a GREEN phase verdict? YES — the four Part A wrong-shape
fixture findings are verdict-material under the stated cold-review rule; the
Part B line drift is cosmetic, and its sole WRONG anchor records a fix that
landed rather than a missing load-bearing implementation.**
