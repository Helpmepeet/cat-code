# Lane 03 — The projector and the core transcript rows

**Auditor verdict:** GREEN
**Rows audited:** 4 · TRUE 3 · OVERSTATED 1 · FALSE 0 · STALE 0 · UNVERIFIABLE-HEADLESS 0

Audited against committed `HEAD` = `d85f770`. `transcriptProjector.ts` itself is
CLEAN in the working tree; `sdkMessageFixtures.ts` (+1) and
`transcriptProjector.test.ts` (+122) carry a concurrent session's in-flight
`agent_name` coverage work (follow-on to `d85f770`) — noted as context, audited
at `HEAD`.

## Row verdicts

### P2-0 — Projector completeness + exhaustive `SDKMessage` fixture
**Verdict:** TRUE

**Claims checked:**
1. Union census = exactly 19 members / 15 top-level discriminants.
2. Renderer snapshot union has no drift from the engine.
3. Projector switches over all 15 discriminants; the rest are documented no-ops.
4. `default` = compile-time `never` tripwire + runtime drift tolerance.
5. Fixture mapped type is the mirror tripwire (tsc enforces both sides).
6. Fixture is consumed by `transcriptProjector.test.ts`, per-variant `expectRows`.
7. `microcompact_boundary` is uninhabitable in the type.
8. Subagent FULL frames reach the seam with non-null `parent_tool_use_id`.
9. Several members can't arrive at the app seam today (stdout-only / type-only).

**Evidence:**
- (1) Re-counted from source today: `src/entrypoints/sdk/coreTypes.generated.ts:793-812`
  lists 19 members. Collapsing `system` (3), `result` (2), `user` (2) gives 15
  discriminants. Projector cases at `app/renderer/src/transcriptProjector.ts:848-928`
  are exactly those 15.
- (2) `app/shared/sdk-types.snapshot.d.ts:813-832` is member-for-member identical
  to the engine union, and `SDKSystemMessage.subtype?` (`:194-210`) is identical
  to `coreTypes.generated.ts:174-190` (16 subtypes). Drift is not asserted, it is
  *enforced*: `app/sidecar/engineTypeDriftCheck.ts:22-28` mutually-assignability-
  checks the snapshot's `SDKMessage`/`AppSessionEvent`/`AppClientMessage`/
  `AppReadyPayload` against the real engine modules; the file lives under
  `app/sidecar/`, which is exactly what `app/scripts/sidecar-typecheck.ts:1`
  (`OWNED_DIAGNOSTIC`) fails on. A new engine member *or* a new `system` subtype
  literal breaks `typecheck:sidecar`.
- (3)(4) Tripwire confirmed at `transcriptProjector.ts:929-937`:
  `const _exhaustive: never = message` inside `default`, with `return state` after
  it. Reasoned, not mutated (shared tree): the switch has no case for a
  hypothetical new discriminant, so `message` narrows to that member, which is not
  assignable to `never` → TS2322. The runtime arm still returns `state`.
- (5) `sdkMessageFixtures.ts:104-108`: `{ readonly [K in SDKMessage['type']]: … }`
  — a **required** mapped type (no `?`), so a new discriminant yields TS2741
  "Property 'x' is missing". Both sides confirmed present.
- (6) `transcriptProjector.test.ts` (HEAD) `:461-484` asserts the 15 keys by name;
  `:517-530` drives EVERY sample through the real reducer entry point
  (`projectServerFrame` → `selectTranscriptRows`) and throws on any row-count
  mismatch; `:535+` asserts documented no-ops stay reference-equal. This is a live
  reducer path, not a shape assertion.
- (7) Re-proved today: `SDKSystemMessage.subtype?` (`coreTypes.generated.ts:174-190`)
  does **not** contain `microcompact_boundary`, and `SDKCompactBoundaryMessage`
  (`:235-237`) is `SDKSystemMessage & { subtype: 'compact_boundary' | 'microcompact_boundary' }`
  — the intersection collapses to `'compact_boundary'`. Still uninhabitable.
- (8) `src/utils/queryHelpers.ts:154` and `:165` yield assistant/user frames with
  `parent_tool_use_id: message.parentToolUseID` on the agent/skill progress path.
  Preserved by the projector at `transcriptProjector.ts:973-978`.
- (9) Verified independently rather than taken from the row: `enqueueSdkEvent`
  short-circuits unless `getIsNonInteractiveSession()` (`src/utils/sdkEventQueue.ts:80-82`)
  and `drainSdkEvents` has call sites **only** in `src/cli/print.ts:2320,2342,2476,2568`.
  `hook_started|hook_progress|hook_response|status|files_persisted|elicitation_complete`
  are minted only inside `src/cli/print.ts` (`:691,:701,:714,:1152,:1453,:2306,:2365`);
  `post_turn_summary` has **no** mint site anywhere in `src/`. So none of the 11
  `system` subtypes the projector no-ops can reach the app seam today.

**Reachable-path trace:** sidecar `AppSessionEvent{type:'message'}` → main
`deliver` → preload `subscribe` → `applyServerFrameBatch`
(`serverFrameBatch.ts:115` `dispatchTranscript`) → `App.tsx:435-437`
`useReducer(reduceLiveTranscriptState)` → `previewTranscriptState.ts:95`
`projectServerFrameBatched` → `projectServerFrame` → `TranscriptView`
(`TranscriptView.tsx:205` `selectNestedTranscriptRows`) →
`TranscriptRowsView` render arms. Preview/restore path is the same projector via
`previewTranscriptState.ts:126-130`.

**Anchor drift:** STATUS cites `coreTypes.generated.ts:760` for the union; actual
is `:793`. STATUS cites `queryHelpers.ts:127-140` for the progress re-emit; that
range is now the plain `assistant` case and the progress yields are at `:154`/`:165`.
Same stale anchors are copied into `sdkMessageFixtures.ts:8` and `:72`. Counts and
behavior are still correct. (F2)

---

### P2-1 — Core transcript rows
**Verdict:** TRUE (one enumerated row later cut by P4-23, see F4)

**Claims checked:** thinking · redacted-thinking · user text · user image ·
tagged command echo · system notice · session-init · compact boundary · result ·
Codex `reasoningKind` preserved · UUID dedupe · malformed blocks tolerated ·
`SnipBoundaryRow`/`TombstoneRow` typed-but-unminted.

**Evidence (all `app/renderer/src/transcriptProjector.ts`):** thinking with
runtime narrowing + both `reasoning_kind`/`reasoningKind` spellings `:1855-1878`;
redacted-thinking `:1880-1887`; user text `:1994-2001`; user image `:2004-2014`
(`projectUserImageSource:2020`); command echo `:1968-1978` via `parseCommandEcho:2040`
(real `<command-message>`/`<command-args>`/`<skill-format>` tags, `false` when the
tag is present but empty); system notice `:1276-1293` + `:1237-1269`; compact
boundary `:1216-1235`; result `:1143-1179`; UUID dedupe via `seenFrameIds`
(`:957`, `:1046`, `:1151`, `:1187`, `:1300`); malformed-block tolerance is the
`return null` on every failed narrow plus `default: return null` at `:1899-1903`.
`SnipBoundaryRow`/`TombstoneRow` at `:379-380` have no mint site anywhere in
`app/` (grepped) — typed and unminted exactly as the row says.

Contract checks the lane was asked to prove:
- **Status derived at read time, stored rows never mutated:** `selectTranscriptRows:562-580`
  computes `status` from `toolResultsByUseId` and returns `{...row, status, result, agentCompletion}`
  — a copy — and returns the original row unchanged when nothing differs. The
  hidden-tier mark is likewise a copy (`markHidden:585-587`).
- **Zero `as` casts:** grep for `as <Type>` / `as unknown` / `as any` over the whole
  file returns only two prose comments (`:699`, `:1057`). Confirmed clean.
- **Unknown variants degrade, never throw:** projector `default` `:936`; block-level
  `default` `:1902`; and the display side renders a tolerant fallback row rather
  than throwing (`TranscriptView.tsx:597-604`).

**Reachable-path trace:** every one of the 14 `TranscriptRow` kinds has a render
arm in `TranscriptView.tsx:503-587` (`assistant-text`, `user-text`, `command-echo`,
`user-image`, `thinking`, `redacted-thinking`, `system-notice`, `task-notification`,
`injected-turn`, `result`, `compact-boundary`, `snip-boundary`, `tombstone`,
`tool-use`), closed by a second `never` tripwire at `:595`. Mounted via
`TranscriptView` ← `SessionPane` ← `WorkspacePanels` ← `App`.

**Anchor drift:** none in the row itself. The row's `session-init` claim no longer
matches source — intentionally, per P4-23 — but P2-1 carries no supersession note.

---

### P4-21 — Engine-vocabulary parity fixtures (drift-risk sweep)
**Verdict:** OVERSTATED

**Claims checked:**
1. 8 vocab-parity families landed.
2. Each has a "drift-fails-loud" tripwire.
3. `src/` evolution **fails `bun test app/`** loudly.
4. 2 review blockers fixed (reverted a `roundtrip.probe` masking edit;
   de-tautologized the goals-status drift test).
5. The one true dup — empty MCP runtime at `sessionController.ts:172-187` — is
   P4-12's owned deferral.

**Evidence:**
- (1) All 8 families present at `HEAD`, all still importing the REAL engine
  modules: settings sources/labels/order (`app/sidecar/settingsDomain.test.ts:31,34`),
  agent taxonomy + task/worker statuses (`app/sidecar/agentConfigDomain.test.ts:33-76`),
  MCP/hook/skill/plugin taxonomy (`app/sidecar/extensionsDomain.test.ts:26-57`),
  goal statuses + memory types (`app/sidecar/goalMemoryDomain.test.ts:27-46`),
  `PermissionUpdate` variants (`app/renderer/src/PermissionPrompt.test.tsx:643-701`),
  tool-inspector summaries (`agentConfigDomain.test.ts:7-13` imports each tool's
  real `getToolUseSummary`), protocol mirrored unions (`extensionsDomain.test.ts`),
  host-registry transcript-path codec (`app/host/registry.test.ts:1035,1047`).
- (2) Real, not tautological. The goals test pins hard-coded labels AND calls the
  engine's own `formatThreadGoalStatus` (`goalMemoryDomain.test.ts:86-95`), with an
  in-file comment explaining why deriving the expected string would catch nothing —
  claim (4)'s de-tautology is visible in source. The tool-inspector family imports
  live engine runtime (`BashTool`, `GenerateImageTool`, five `getToolUseSummary`s),
  so those genuinely fail `bun test`.
- (3) **FAILS.** Twelve of the tripwires are *type-level* assertions of the form
  `type X = AssertAssignable<Exclude<Engine, Wire> extends never ? true : false>`
  (`goalMemoryDomain.test.ts:26-46`, `extensionsDomain.test.ts:30-52`,
  `agentConfigDomain.test.ts:33-76`, `settingsDomain.test.ts:31,34`). `bun test`
  transpiles without typechecking, so real engine drift in those families produces
  a **green** `bun test app/` run. They fire under `bun run --cwd app typecheck`
  and `typecheck:sidecar` instead — verified reachable: `app/sidecar/tsconfig.json`
  includes `./**/*.ts` (test files included) and `app/scripts/sidecar-typecheck.ts:1`
  flags any `app/sidecar|shared` diagnostic; `app/tsconfig.json` includes
  `renderer/src/**/*.tsx` and `host/**/*.ts`. So the insurance is live — the row
  just names the wrong gate. (F1)
- (5) **Anchor drift.** At `HEAD`, `app/sidecar/sessionController.ts:172-187` is
  `loadCommandCatalog`. The empty MCP runtime is at `:325-326`
  (`const mcpClients: [] = []`, `const availableMcpServers: string[] = []`) and
  `:383-386` (`mcpTools: []`, `mcpCommands: []`, `mcpResources: {}`). The dup itself
  still exists, consistent with the stated P4-12 deferral. (F3)

**Reachable-path trace:** N/A by design — the row declares itself TEST-ONLY. The
gate it feeds is the §3 battery, and both halves of that battery are wired (above).

**Anchor drift:** `sessionController.ts:172-187` → `:325-326` / `:383-386`.

---

### P4-23 — Remove the ✦ "Session started" transcript banner
**Verdict:** TRUE

**Claims checked:**
1. `SessionInitBanner` + `MetaPair` + the `case 'session-init'` render arm deleted.
2. `SessionInitRow` type + union member deleted.
3. Projector `case 'init'` STILL runs and still captures the P3-7 slash catalog.
4. Fixture init sample `expectRows` 1 → 0.
5. Banner tests dropped, catalog-survives assertions added.
6. PARITY-LEDGER §5 re-tagged ✂️ cut.
7. Both exhaustiveness tripwires still compile.

**Evidence:**
- (1)(2) Repo-wide grep for `SessionInitBanner|SessionInitRow|session-init|Session started`
  over `app/`, `src/`, `web/` returns only *comments* recording the removal
  (`transcriptProjector.ts:1196`, `TranscriptView.test.tsx`, `transcriptProjector.test.ts`,
  `sdkMessageFixtures.ts`). No production code, no re-add anywhere.
  `TranscriptRow` (`transcriptProjector.ts:382-396`) has 14 members and no
  `SessionInitRow`.
- (3) `transcriptProjector.ts:1190-1213`: `case 'init'` still validates
  `cwd`/`model`/`tools`/`permissionMode`, then returns state with
  `seenFrameIds[frameId]` marked and `slashCommands` stored — emitting zero rows.
- (4) `sdkMessageFixtures.ts:1146-1153` — `expectRows: 0` on the init sample, with
  the P4-23 rationale inline.
- (5) `transcriptProjector.test.ts:1347-1405` "captures the init frame slash_commands
  catalog per session (P3-7)" asserts an empty catalog before the frame, a populated
  catalog after, **and** (`:1397-1399`) that the frame emits no visible row; plus a
  second no-row assertion at `:1629`.
- (6) `docs/migration/PARITY-LEDGER.md:409` — `✂️ cut (operator, 2026-07-09)`.
- (7) Projector tripwire `:932`, TranscriptView tripwire `:595`, fixture mapped
  type `:104-108`: all three intact and consistent with a 14-member row union.

**Reachable-path trace (the surviving behavior):** `system/init` frame →
`projectSystemFrame` `case 'init'` → `slashCommands` → `selectSlashCommands`
(`transcriptProjector.ts:612`) → `App.tsx:3652` → `SlashCommandPicker`. The
catalog the removal had to preserve is still consumed on a real user path.

**Anchor drift:** the STATUS row's `TranscriptView.tsx:117,352` /
`transcriptProjector.ts:197,234,714-730` anchors describe pre-removal code and are
correctly historical. PARITY-LEDGER:409 cites `transcriptProjector.ts:714` for the
surviving `case 'init'`; it is now `:1190` (nit, not a finding against this row).

## Findings

| # | Severity | Row | Defect | Evidence | Failure scenario |
|---|---|---|---|---|---|
| F1 | Medium | P4-21 | Row names the wrong gate: 12 of the parity tripwires are compile-time type assertions that `bun test app/` cannot evaluate. They fire only under `typecheck` / `typecheck:sidecar`. | `app/sidecar/extensionsDomain.test.ts:30-52`, `goalMemoryDomain.test.ts:26-46`, `agentConfigDomain.test.ts:33-76`, `settingsDomain.test.ts:31,34` (all `type … = AssertAssignable<…>`, `void (null as unknown as …)`) | Engine adds an MCP transport / hook source / memory type. A session follows P4-21's own sentence, runs `bun test app/` only, sees 2799/0 green, and ships a renderer that silently drops the new row family. |
| F2 | Low | P2-0 | Anchor drift: `coreTypes.generated.ts:760` → `:793`; `queryHelpers.ts:127-140` → `:154`/`:165`. Copied into `sdkMessageFixtures.ts:8,72`. | `src/entrypoints/sdk/coreTypes.generated.ts:793`; `src/utils/queryHelpers.ts:154,165` | A future session re-verifying the census opens `:760` (mid-`SDKPromptSuggestionMessage`) and concludes the row is wrong. |
| F3 | Low | P4-21 | Anchor drift: empty MCP runtime cited at `sessionController.ts:172-187`, which is now `loadCommandCatalog`. | `app/sidecar/sessionController.ts:325-326,383-386` | P4-12's deferral guardrail points at unrelated code; the extract-setup check is aimed at the wrong function. |
| F4 | Low | P2-1 | Row still enumerates a `session-init` row among what it built; P4-23 cut it. No supersession note on the P2-1 row. | `transcriptProjector.ts:1196-1199`; `PARITY-LEDGER.md:409` | A reader of STATUS infers the desktop renders a session-start banner and files a bug when it does not, or re-adds it. |
| F5 | Low | P2-0 | "Coverage is total" is total at the *discriminant* level only. `projectSystemFrame` handles 5 of 16 `system` subtypes; the other 11 hit `default: return state` with no compile-time alarm. | `transcriptProjector.ts:1189-1273` vs `coreTypes.generated.ts:174-190` | Mitigated today (all 11 are stdout-only/no-mint, and the fixture carries a sample for every one of the 16). But an engine change that starts emitting e.g. `files_persisted` in-proc drops silently: the snapshot drift check would flag a *new* literal, not a newly-reachable existing one. |

## Operator steps required (UNVERIFIABLE-HEADLESS rows only)

None. All four rows were settled from source plus the existing headless suites.

## Nits

- `PARITY-LEDGER.md:409` cites `transcriptProjector.ts:714` for the surviving
  `case 'init'`; it is now `:1190`.
- `TranscriptView.tsx:601-603` renders `Unrecognized transcript row: {kind}` to the
  user. "Transcript row" plus a raw union literal is internal vocabulary on a
  user-visible surface; a neutral "This message could not be displayed" would match
  the 2026-07-27 operator rules better. Degraded-path only.
- Em-dash sweep of the four owner renderer files: only two hits
  (`transcriptProjector.ts:350`, `serverFrameBatch.ts:45`), both inside doc
  comments — exempt. No user-visible string violations found in this lane.
- Concurrent edit in flight (not a finding): `sdkMessageFixtures.ts` +1 line
  (`agent_name: ' @Ada '`) and `transcriptProjector.test.ts` +122 lines of
  running-agent-name tests, following `d85f770`.
