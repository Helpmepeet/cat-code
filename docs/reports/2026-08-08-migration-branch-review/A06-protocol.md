# A06 — shared wire contract (protocol.ts, hostApi.ts)

## Verdict

This contract is in genuinely good shape on the axes it was designed to defend: every one of
the 30 inbound message kinds is on a closed sidecar allowlist with a local Zod schema, a
doc-comment citing its decision, and at least one boundary test; the three error unions
(`HostErrorCode`, `ErrorFrame['code']`, `SaveTextErrorCode`) are provably unmerged; there are
zero `any` and zero `as` casts in `app/shared/*.ts`; and the additive-only versioning
discipline is honoured with real reasoning recorded per addition. The single most important
thing to fix is the **failure path's correlation hole**: every one of the 22 app-owned verbs
carries a mandatory `requestId` so the UI can match an outcome, but the only frame that
reports a *rejection* — `ErrorFrame` — has `requestId` optional, and every boundary-rejection
call site leaves it undefined, so a rejected verb produces a frame no renderer state module
consumes and the user's click resolves to nothing, forever, with no message. Secondary: the
two-id model that the architecture treats as locked has **zero type-system support** —
`SessionId` is a bare `string` alias, so passing an `engineSessionId` where an `appSessionId`
is required compiles clean — and there is ~1 KB of dead wire surface (six fields no consumer
reads) in a file whose sibling module already ships the exact idiom that would have caught it.

## Findings

### [HIGH] A rejected inbound frame is uncorrelatable and therefore invisible to the user

- **Where**: `app/shared/protocol.ts:605-621` (`ErrorFrame.requestId?: string`); rejection
  call sites `app/sidecar/sidecarServer.ts:843`, `:857`, `:875`, `:790`
- **Type**: correctness / design
- **What**: Every app-owned verb in this protocol carries a renderer-minted `requestId`
  explicitly so a UI can correlate the outcome — the file says so 8 times ("T5a-analog — every
  verb carries a renderer-minted `requestId` echoed on the resulting `*.result` frame, so a UI
  can correlate the outcome", protocol.ts:189-191, and repeated at :1379, :1433, :1496, :1750,
  :2371). But the frame that reports a *boundary rejection* makes `requestId` optional, and
  all four rejection paths pass `undefined` for it. There is no `*.result` frame on a
  rejection — the `ErrorFrame` is the whole reply.
- **Trigger / why it matters**: Renderer sends any verb that fails the envelope check
  (`sidecarServer.ts:843`), the session-address check (`:857`), `checkStrictKeys` (`:875`), or
  the inbound rate cap (`:790`). The sidecar replies with
  `{kind:'error', code:'bad_request', requestId: undefined, …}`. Renderer-side, that frame
  reaches exactly three consumers and all three drop it:
  `connectionState.ts:261-268` maps only `session_not_found` / `session_not_ready` /
  `session_disconnected` and returns state unchanged for `bad_request`;
  `permissionState.ts:162` short-circuits on `frame.requestId` being falsy;
  `verbAckResultState.ts:56-61` only matches the four `*.result` kinds. Net effect: the user
  clicks "Stop worker" / a settings toggle / a model switch, the frame is rejected, the UI
  neither updates nor errors. The rate-cap path is the live one — it does not close the
  socket, it `continue`s (`sidecarServer.ts:797`), so a burst of legitimate verbs silently
  loses the overflow with the pane still reading healthy. The strict-key path becomes live the
  first time protocol.ts and the sidecar allowlist drift (see next finding).
- **Fix**: Echo the id. In `sendError`, when `frame.message` is a record whose `requestId` is a
  string within the existing text cap, pass it through instead of `undefined`; the value is
  already at a fixed top-level position and is echo-only (it authors nothing), so no new trust
  is granted. Then make `requestId` required on `ErrorFrame` for the `bad_request` code, or add
  a `bad_request` branch to `verbAckResultState` so a rejection surfaces the sidecar's
  already-redacted `message`.

### [MED] `SessionId` is a bare `string` alias — the locked two-id model has no type-system support

- **Where**: `app/shared/protocol.ts:82` (`export type SessionId = string`);
  `app/shared/hostApi.ts:74-75`, `:265-290`
- **Type**: quality / design (primitive obsession on ids)
- **What**: The repo treats `appSessionId` (address) vs `engineSessionId` (transcript key) as a
  locked architectural distinction, but `SessionId` is a transparent alias for `string` and
  `engineSessionId` is declared as plain `string` everywhere. Nothing in `app/shared/` brands
  either. Corroborating the other reviewer's finding from the protocol side: the two host
  methods that take the two different ids are **structurally identical** —
  `restoreSession(appSessionId: SessionId): Promise<HostResult<SessionDescriptor>>` and
  `openHistorySession(engineSessionId: string): Promise<HostResult<SessionDescriptor>>`
  (protocol.ts:2952 and :3002). `bridge.openHistorySession(descriptor.appSessionId)` and
  `bridge.restoreSession(cache.header.engineSessionId ?? '')` both type-check clean.
- **Trigger / why it matters**: The protocol makes the confusion *easier*, not harder, by
  spelling three different id spaces the same way: `SessionCatalogEntry.sessionId`
  (protocol.ts:2497) is the ENGINE id; `TranscriptCacheHeader.appSessionId` (:2734) is the app
  id; `RemoteSettingsResultFrame.directConnect.sessionId` (:2263) is a *remote server's*
  session id. `SessionActionResultFrame.branchEngineSessionId` (:1836) is a fourth id space
  (a fork's engine id). The renderer's `MergedSessionRow` carries both an engine
  `sessionId` and an `appSessionId: SessionId | null` on one object
  (`sessionsCatalogState.ts:97-101`) — the exact shape where a swap is a one-character
  mistake. Today the routing is correct because `SessionOpenRoute` is a discriminated union
  with differently-*named* fields (`sessionsCatalogState.ts:409-420`, consumed at
  `App.tsx:2010-2013`) — i.e. the safety is naming discipline, re-applied by hand at each new
  call site, not a compile-time property. The cost is that every future call site is one
  reviewer's attention away from a wrong-id bug that ships green.
- **Fix**: Two branded aliases in `protocol.ts` beside the existing one:
  `export type AppSessionId = string & { readonly __brand: 'appSessionId' }` and
  `EngineSessionId` likewise, with the existing `SessionId` re-pointed at `AppSessionId`.
  Every value entering the app from disk/wire already passes a validator (`registry.ts`,
  `sessionsCatalogWorker.ts` `parseEntry`, `transcriptCache.ts` `parseTranscriptCache`), so
  those are the natural (and few) mint points; the rest of the graph gets the check for free.

### [MED] Dead wire surface: six fields the sidecar sets that no consumer reads

- **Where**: `app/shared/protocol.ts:1164` (`TasksSnapshot.foregroundedTaskId`), `:1106`
  (`TaskSnapshotItem.totalPausedMs`), `:1122` (`TaskSnapshotItem.isUltraplan`), `:1904`
  (`AccountStatus.planType`), `:1901` (`AccountStatus.lastRefreshIso`), `:856`
  (`AgentConfigDefinition.provider: 'runtime'`)
- **Type**: dead-code
- **What**: Each is produced by a sidecar domain and serialized on every broadcast, and has
  zero production consumers:
  - `foregroundedTaskId` — set at `sidecar/tasksDomain.ts:77`; the only readers repo-wide are
    `tasksDomain.test.ts:184,283`. The sidecar has *already* filtered that task out of `items`
    on the same line, so the field is informational only, and nothing consumes the information.
  - `totalPausedMs` — set at `sidecar/tasksDomain.ts:131`; **zero** other occurrences anywhere,
    not even a test assertion.
  - `isUltraplan` — set at `sidecar/tasksDomain.ts:145`; the renderer branches on
    `ultraplanPhase` only (`agentIdentity.ts:384`, `tasksState.ts:158`) and never on the flag.
  - `planType`, `lastRefreshIso` — set at `sidecar/accountsDomain.ts:404,406`, additionally
    key-gated and narrowed at the worker boundary (`shared/accountsPoolWorker.ts:179-181`,
    `:220-222`, `:240-242`); the only renderer occurrences are fixture literals in
    `WelcomeScreen.test.tsx:35,37`. No production renderer file mentions either name.
  - `provider: 'runtime'` — a single-member union carrying zero bits, set at
    `sidecar/agentConfigDomain.ts:71`, read nowhere (the `option.provider` hit in
    `ComposerActionsBar.tsx:241` is `RunControlModelOption`, a different type).
  Separately, `AgentConfigSnapshot.availableMcpServers` (protocol.ts:885) is a *knowing*
  case — `agentConfigState.test.ts:76-82` classifies it `'unread'` — but it is shipped because
  `sessionController.ts:319` hard-codes it to `[]` behind the documented MCP-runtime deferral,
  so what crosses the wire is an always-empty array.
- **Trigger / why it matters**: This is not merely bytes. `tasks.snapshot` and
  `accounts.snapshot` are broadcast on every store change to every attached connection, each
  frame is `secretGuard`-scanned and `MAX_OUTBOUND_FRAME_BYTES`-bounded, and each of these
  fields is additionally hand-maintained at a second place (`accountsPoolWorker.ts`'s
  `hasExactKeys` list — removing `planType` from the protocol *requires* editing the worker
  validator or every pool refresh fails closed and the Accounts page goes blank). That is real
  maintenance weight for zero reader.
- **Fix**: The repo already has the mechanism and it works — `agentConfigState.test.ts:70-92`
  declares `Record<keyof AgentConfigSnapshot, 'panel' | 'unread'>`, so adding a slice fails tsc
  until someone classifies it, and its comment records that `notes` was deleted because of it.
  Apply the same table to `TasksSnapshot`, `TaskSnapshotItem`, `AccountStatus` and
  `SessionCatalogEntry`, then delete the fields that classify `unread`.

### [MED] Nothing binds the inbound union to the sidecar allowlist, and the drift fails silently

- **Where**: `app/shared/protocol.ts:474-487` (`SidecarClientMessage`) vs
  `app/sidecar/sidecarServer.ts:3487-3552` (`checkStrictKeys`'s `allowedByType` map)
- **Type**: design
- **What**: The inbound vocabulary is declared twice — once as a TypeScript union of 30
  message types in `protocol.ts`, once as a runtime `Map<string, Set<string>>` of type → allowed
  keys in the sidecar. I verified all 30 types and every field are currently in sync, so this is
  not a live bug. But nothing forces it: the map is keyed by `string`, not by
  `SidecarClientMessage['type']`, and the value sets are string literals with no relation to the
  message types' keys.
- **Trigger / why it matters**: The two field additions this file records as precedent —
  `AccountSwitchMessage.provider?` (protocol.ts:228) and `SettingsSetValueMessage.value: null`
  (`:416`, P4-41) — are exactly the edit that breaks this. Add such a field, wire the renderer
  half, forget `sidecarServer.ts:3487`: tsc is green (the map is `string`-keyed), the domain
  tests are green (they construct the domain input directly), and at runtime *every* frame of
  that verb is rejected. Combined with the HIGH above, the rejection is a `bad_request` frame
  with no `requestId` that no renderer module consumes — so the feature ships, does nothing,
  and reports nothing. The blast radius is the whole verb, not one field.
- **Fix**: Key the map with the union:
  `const allowedByType: Record<SidecarClientMessage['type'], ReadonlySet<string>>`. That alone
  makes a missing entry a tsc error. Tightening the value sets to
  `ReadonlySet<keyof Extract<SidecarClientMessage, {type: K}>>` closes the field half.

### [MED] The transcript cache pins the global wire version, so a `PROTOCOL_VERSION` bump destroys every cache

- **Where**: `app/shared/protocol.ts:2737` (`TranscriptCacheHeader.protocolVersion`), read gate
  at `app/main/transcriptCache.ts:333-336`
- **Type**: design
- **What**: `TranscriptCache` is explicitly "NOT a wire frame" (protocol.ts:2686-2695) — it is
  an at-rest disk artifact whose `frames` array is restricted by a distill allowlist to
  `event` frames plus the single truncation `error` frame (`main/transcriptCache.ts:112-140`).
  Yet its header stamps the *global* `PROTOCOL_VERSION` and the read gate discards any cache
  whose stamp differs.
- **Trigger / why it matters**: A future breaking change to any of the ~30 non-transcript frame
  kinds — say `RunControlsSnapshot` — obliges a `PROTOCOL_VERSION` bump per this file's own
  rule (`:74`). Every cache on disk then fails `transcriptCache.ts:334` and is deleted, even
  though not one of them contains a `run-controls.snapshot` frame. The whole instant-open
  feature (M2) cold-starts on the next launch, for a change that cannot have affected it. The
  file already has the right instrument next to it — `guardVersion` (`:2741`) and
  `runFactsVersion` (`:2759`) are independently-versioned concerns, and the doc-comment on
  `runFactsVersion` records that keying on the wrong signal was "a silent bug".
- **Fix**: Give the cache its own `cacheFormatVersion` constant, bumped only when the distilled
  frame set or the header shape changes, and gate the read on that. Keep `protocolVersion` in
  the header as the diagnostic stamp its neighbour `appVersion` already is.

### [LOW] `PROTOCOL_VERSION` is enforced on 1 of 31 outbound frame kinds

- **Where**: `app/shared/protocol.ts:74-75`; enforced at `app/sidecar/sidecarServer.ts:841`
  (inbound, all kinds) and `app/supervisor/supervisor.ts:588` (outbound, `ready` only)
- **Type**: quality
- **What**: Answering the versioning question directly: the constant is **not** decorative, but
  its coverage is asymmetric. Inbound is fully gated — a wrong `protocolVersion` on any client
  frame is rejected `bad_request` before the message is inspected. Outbound, only the `ready`
  handshake is validated; the other 30 `ServerFrame` kinds stamp the field and no reader ever
  compares it (verified: `rg protocolVersion` across `supervisor/`, `main/`, `renderer/src/`
  returns only *producers* plus that one `ready` check). The disk artifact is separately gated
  (`transcriptCache.ts:334`).
- **Trigger / why it matters**: Not a live failure — sidecar and renderer ship in one bundle,
  so they cannot disagree in practice. The cost is that 30 of 31 stamps are ceremony every
  producer must remember and every frame pays for, while reading as a version gate that
  does not exist. Also note the mechanism cannot express a disagreement even in principle:
  `protocolVersion: typeof PROTOCOL_VERSION` is the literal type `1`, so after a bump no code
  in the tree can construct or hold a v1 frame — there is no negotiation path, only the
  additive-only discipline (which the file states and follows scrupulously).
- **Fix**: Either validate the stamp once at the supervisor's frame-ingress for all kinds
  (same place `validateReadyFrame` already runs) and drop the frame with a logged
  `bad_request`, or state in the header that the field is a diagnostic on the outbound
  direction and a gate on the inbound one, so future producers know which it is.

### [LOW] `sessions.snapshot` is a `ServerFrame` variant with no producer and no consumer

- **Where**: `app/shared/protocol.ts:2580-2595` (`SessionsCatalogSnapshotFrame`)
- **Type**: dead-code
- **What**: Self-documented as superseded by catalog decision #4 and "NO LONGER EMITTED".
  Confirmed: the only production references repo-wide are the type declaration, its membership
  in the `ServerFrame` union (`:2680`), and one retention-policy row
  (`main/replayBuffer.ts:126`) that exists solely because `FRAME_RETENTION` is an exhaustive
  `Record<ServerFrame['kind'], …>`.
- **Trigger / why it matters**: Low, and honestly recorded — I am listing it because the
  stated reason to keep it ("removing a `ServerFrame` variant is a breaking protocol change")
  is weaker than it looks: a variant that was never produced cannot appear in any peer's
  frames, and it cannot appear in a transcript cache either, because the distill allowlist
  (`main/transcriptCache.ts:117-131`) admits only `event` and one `error`. So the removal is
  additive-safe today and gets less so with time.
- **Fix**: Drop the variant and the `replayBuffer.ts:126` row in the next touch of this file;
  keep `SessionsCatalogSnapshot` itself, which is live on the `HostEvent` plane.

### [LOW] `hostApi.ts` carries a type group its own comment argues does not belong there

- **Where**: `app/shared/hostApi.ts:143-188` (`SaveTextErrorCode` / `SaveTextResult` /
  `SaveTextInput`) vs the file header at `:1-25` and `HostApi` at `:264-291`
- **Type**: design
- **What**: The header defines this module as "the app's session control plane" whose methods
  are `createSession / restoreSession / closeSession / listSessions / subscribe`. The file-sink
  types then arrive with a comment stating, correctly, that a save "is not a session
  control-plane call: it names no session, touches no registry row, mints no process, and
  reaches no host method" — and indeed `SaveTextInput`/`SaveTextResult` appear nowhere in the
  `HostApi` interface; they are reached only through `CatCodeBridge.saveTextToFile`
  (protocol.ts:3017), a main-owned capability.
- **Trigger / why it matters**: Small but real: the module's own reasoning for keeping
  `SaveTextErrorCode` as a third union is that planes must not be conflated, and the placement
  conflates them at the file level. A future reader looking for "what the host plane does"
  reads `hostApi.ts` and finds a main-process file dialog.
- **Fix**: Move the three types to a `mainFileSink.ts` beside `hostApi.ts`, or add one line to
  the header naming the file as "host control plane + the main-owned capabilities the same
  preload surfaces", so the scope is stated rather than contradicted.

### [LOW] Literal tab characters inside the `ErrorFrame` code union

- **Where**: `app/shared/protocol.ts:616-618`
- **Type**: convention
- **What**: The last three members of `ErrorFrame['code']` (`session_not_found`,
  `session_not_ready`, `session_disconnected`) are indented with a tab plus four spaces; the
  rest of the file is spaces-only.
- **Trigger / why it matters**: Reporting it only because this repo's `bun run lint` enables
  zero rules (all 19 custom rules are `createNoopRule()` stubs), so nothing will catch it, and
  it sits in the union three separate renderer modules pattern-match on. Cosmetic.
- **Fix**: Re-indent the three lines to four spaces.

### [LOW] Two outbound frames ship with no doc-comment at all

- **Where**: `app/shared/protocol.ts:905-929` (`ThreadGoalStatus` / `ThreadGoalSnapshot` /
  `ThreadGoalSnapshotFrame`) and `:931-997` (the memory snapshot types and
  `MemorySnapshotFrame`)
- **Type**: convention
- **What**: Every other frame kind in this file carries prose naming its decision doc, its
  engine source, and its secret posture. These two carry a one-line section header
  ("Goals + memory read-seams (P4-10) — read-only snapshots") and nothing else — no engine
  source citation, no redaction argument, unlike the `AgentMemorySnapshot` block nested inside
  the second one (`:957-974`), which is exemplary.
- **Trigger / why it matters**: The repo's stated rule (`CLAUDE.md` §6) binds doc-comments to
  *inbound* frames, so these are not rule violations. The cost is asymmetric review: both are
  live (`goalMemoryState.ts:26,33`, rendered at `GoalsPage.tsx:72-77` and
  `MetadataInspector.tsx:174-178`) and both carry filesystem paths (`MemoryInstructionFile.path`,
  `AutoMemoryHeader.filePath`, `AgentMemorySnapshot.directory`) with no recorded argument for
  why those are safe outbound, in a file where every other path-bearing field has one
  (`WorkspaceTrustSnapshot.trustRoot` at `:2317-2338` is the model).
- **Fix**: One paragraph each, citing the engine source the sidecar reads and the reason the
  paths are display-only.

## Inbound frame audit table (kind → decision doc-comment → sidecar schema → boundary test)

All 30 inbound kinds pass all three columns. No gaps found.

| kind | decision cited in protocol.ts | sidecar-local schema | boundary test (reject direction) |
|---|---|---|---|
| `app.submit` | SECURITY-MINIMUM §2 (:35-43) | engine `appClientMessageSchema` + `checkStrictKeys` incl. nested `options` | `sidecarServer.test.ts:3468` (`options` extra key) |
| `app.abort` | SECURITY-MINIMUM §2 | engine schema + strict keys | accept only (`:372`, `:396`) — see note below |
| `permission.response` | PERMISSION-BOUNDARY C1, T6/T6b (:3042-3049) | engine schema + nested `response` key allowlist | `:3486` (`toolUseID`), `:3628` (legit deny passes) |
| `app.ping` | SECURITY-MINIMUM §2 A4 (:590-593) | strict keys + nonce cap | `:1043` nonce-too-long path |
| `permission.setMode` | PERMISSION-BOUNDARY §3, C2 (:88-121) | `permissionSetModeMessageSchema` (`:3620`) | `:4029` (`mode:'yolo'`), `:3969` (auto gate) |
| `askUserQuestion.answer` | ASK-USER-QUESTION-ANSWER.md, C5 (:123-155) | sidecar-local strict inner schema | `:3416` (nested), `:3434` (top-level) |
| `account.switch` | inline P4-5 record (:157-215) | `accountVerbSchema` union | `:4295` (generic), `:4481` (unknown provider) |
| `account.rename` | idem | idem | `:4295` |
| `account.delete` | idem, `confirm:true` fail-closed (:186-188) | idem | `:4295` |
| `account.logout` | idem | idem | `:4295` |
| `account.touchAll` | idem | idem | `:4295` |
| `account.login` | idem + P4-15 (:196-199) | idem | `:4481` |
| `account.oauthPasteCode` | P4-15 (:267-279) | idem | `:4542` pattern |
| `account.oauthAlias` | P4-15 (:281-293) | idem (`alias` allows `''` — skip path, `:3719`) | `:4682` |
| `account.oauthCancel` | P4-15 (:295-299) | idem | `:4542` |
| `workspace.trust` | STARTUP-GATES §1.1 / D4, HC1 (:2353-2375) | sidecar-local schema | `:5667` (renderer-authored path) |
| `agent-mode.set` | AGENT-MODE-TOGGLE.md (:1359-1381) | sidecar-local schema | `:1850` |
| `task.stop` | AGENT-CHROME §2 + PARITY-LEDGER §20/21 (:1407-1438) | sidecar-local schema | `:2007` |
| `model.set` | COMPOSER-RUN-CONTROLS.md (:1469-1498) | sidecar-local schema | `:2519`, `:2313` (null default) |
| `effort.set` | idem | idem | `:2519` |
| `fast.set` | idem | idem | `:2519` |
| `session.rename` | P4-6b inline (:1704-1755) | sidecar-local schema | `:6086`, `:6108` |
| `session.export` | idem | idem | `:6131` |
| `session.branch` | idem | idem | `:6154` |
| `session.tag` | P4-29 (:1756-1772) | idem (`tag` allows `''` — remove, `:3841`) | `:6255` |
| `remoteSettings.bridgeToggle` | PAIRED-DEVICES §4 / D3 (:312-349) | sidecar-local schema | `:4940` |
| `remoteSettings.directConnect` | idem, HC1 on cwd (:335-341) | idem | `:4940` |
| `settings.setValue` | P4-19 + P4-41 (:375-398) | sidecar-local schema + `EDITABLE_SETTINGS` allowlist | `:5090`, `:5292` |
| `context-breakdown.request` | inline cost argument (:421-437) | sidecar-local schema | `contextBreakdownBoundary.test.ts:170-176` (4 malformed shapes) |
| `app.park` | IDLE-PARK §2/§3/§6 (:452-467) | `appParkMessageSchema` (`:3639`) | `:552` (extra key), `:570` (non-string id) |

Note on `app.abort`: the only kind without a dedicated reject test. Its keys are covered by
`checkStrictKeys` and its values by the engine's shared Zod schema, so the gap is thin, but it
is the one row where the reject direction is inferred rather than exercised.

## What is good here

- **`engineTypeDriftCheck.ts` is the best pattern in this area and should be copied.**
  `app/sidecar/engineTypeDriftCheck.ts:22-29` asserts mutual assignability between the
  type-only snapshots and the *real* engine modules, and it sits in `app/sidecar/**` — an
  owned path for `app/scripts/sidecar-typecheck.ts` — so snapshot drift is a hard red gate, not
  a convention. That is what makes the "never hand-edit the snapshot" rule enforceable rather
  than aspirational. (Both snapshots are `import type` only, so nothing pulls them in at
  runtime; confirmed.)
- **Error-plane separation is real, not just asserted.** Three unions (`HostErrorCode`,
  `ErrorFrame['code']`, `SaveTextErrorCode`) with a written argument for each split, and the
  code matches: `HostErrorCode` appears only in `hostApi.ts` and `host/host.ts`, never in a
  frame; `ErrorFrame['code']` is referenced only from doc-comments. The overlap on the
  `session_not_found` *literal* between the first two is deliberate and explained
  (`hostApi.ts:20-24`). No cross-import, no merge.
- **The `agentConfigState.test.ts` slice-consumer table is the right instrument for wire
  drift** — `Record<keyof AgentConfigSnapshot, 'panel' | 'unread'>` makes an unread field a
  deliberate admission and its comment records a field (`notes`) actually deleted because of
  it. It is the fix for the dead-surface finding above; it just needs to be applied to the
  other four payload types.
- **`settingsEditable.ts` is a genuinely single source of truth.** One `EDITABLE_SETTINGS`
  list drives the sidecar's key allowlist, the sidecar's per-key validator, and the renderer's
  control rendering; the module is engine-free so all three planes import it. The `null`-means-
  clear reasoning (`:57-78`) is unusually rigorous — it argues the choice at three layers (type,
  validator, engine schema) and explains why a string sentinel would collide.
- **The worker boundary validators fail closed with no `as` casts.** Both
  `accountsPoolWorker.ts` and `sessionsCatalogWorker.ts` narrow field-by-field and reconstruct
  the object, and both handle an additive optional field by accepting the record with *or*
  without it while still rejecting any third key — the right shape for a closed vocabulary that
  must tolerate version skew.
- **Exhaustiveness tripwires exist where they matter.**
  `Record<ServerFrame['kind'], FrameRetention>` (`main/replayBuffer.ts:101`) fails tsc on a new
  outbound kind, and `settingsEditable.ts:392-395` uses the `never` idiom on the control union.
  `PERMISSION_SET_MODE_MODES` is the one constant all four planes import (main, sidecar,
  renderer ×2) rather than four copies of the list.

## Not reviewed / uncertain

- **`sessionsCatalogWorker.ts` `parseEntry` has no `hasExactKeys` gate** (contrast
  `accountsPoolWorker.ts` `parseAccountStatus:164`, which does). Extra keys on a catalog entry
  are silently dropped rather than failing the record. I could not decide whether that is
  deliberate (entries come from a worker whose schema evolves faster) or an oversight; the
  function's own doc-comment at `:50-56` says "extra keys … fails the WHOLE record", which is
  true at the top level and not true at the entry level. Resolved by asking whoever wrote the
  catalog worker whether entry-level extra keys should fail closed like account rows do.
- **Whether a stale sidecar can ever face a newer main** (the scenario in which the missing
  outbound version check would bite). That depends on the packaging/auto-update path and the
  die-with-window lifetime, which I did not read. If an in-place update can leave a live
  sidecar from the previous build attached, the LOW above becomes a MED; `app/main/main.ts`
  spawn path plus the updater config would settle it.
- **`AgentConfigSnapshot.availableMcpServers` being permanently `[]`** —
  `sidecar/sessionController.ts:319` hard-codes it behind the documented MCP-runtime deferral,
  which means every agent definition declaring a required MCP server ships
  `available: false` with all of them in `missingMcpServers` (`agentConfigDomain.ts:55,89`).
  Whether the Agents page renders that as an honest "MCP runtime not wired here" or as a
  misleading per-agent "unavailable" is a renderer question outside my scope; flagging it for
  whoever holds `AgentsPage.tsx`.
- I did not review `limits.ts`, `secretGuard.ts`, `framing.ts`, `jsonSafe.ts` (assigned
  elsewhere), and I read `sidecarServer.ts` only for the validation and rejection paths the
  protocol's own guarantees depend on.
