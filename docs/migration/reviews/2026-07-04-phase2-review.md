# Phase-2 Whole-Phase Cold Review — transcript spine + Permissions domain — 2026-07-04

**Status: FINAL.** Lead review plus one delegated mechanical sweep
(`delegated/2026-07-04-phase2-fixture-anchor-audit.md`), whose load-bearing
claims were independently re-verified against source before acceptance (§8).

Reviewed cold, from `docs/migration/STATUS.md` into source, at working-tree HEAD
(`010e8ba`). Scope: P2-1 (`49abf37`), P2-2 (`c7ea717`), P2-3 (`356d63a`),
P2-4 (`010e8ba`), plus spine-regression checks against the already-GREEN P2-0
review (`reviews/2026-07-04-p2-0-projector-review.md`). Commit `983b57d` and
`src/components/Settings/` (unrelated in-flight feature) excluded per the review
brief.

## Executive verdict

**GREEN. Phase 3 is not blocked.** All four post-spine sessions do what their
STATUS rows claim; every gate re-ran green today; the security baseline shows no
regression and the two new permission frames (C2 in, C3 out) conform to
`decisions/PERMISSION-BOUNDARY.md` exactly, with the fail-closed ordering the
decision doc specifies. The three-way parallel merge on the projector files lost
nothing (verified by test-name union across branch tips). The known
carry-forwards reconcile: two remain open by design, two are fixed and verified.

Two Medium findings, neither gate-blocking. F1 (a reloaded renderer can be
stranded without a `permission.context` snapshot) should be folded into
P3-0/P3-4's replay work. F6 (four of the ~19 post-P2-0 fixture samples are
wrong-shaped — shapes the engine cannot emit — one of which masks a real
display gap for server-tool results) requires a small fixture-repair follow-up
**before Phase-4 row-family sessions copy the fixture as their reference**, per
the fixture's own charter as the acceptance artifact. Everything else is
Low/Info.

## Gates re-run (this review, from repo root, tree = HEAD)

| Gate | Claimed (P2-4 row) | Re-run result |
|---|---|---|
| `bun test app/` | 217 pass / 0 fail | **217 pass / 0 fail** (620 expect, 24 files) |
| `bunx tsc --noEmit -p app/tsconfig.json` | clean | **clean** (exit 0) |
| `bun run --cwd app typecheck:sidecar` | scoped pass | **pass** (5,549 upstream diagnostics ignored — the known P1-3 carry-forward) |
| `bun run --cwd app test:hardening` | 18/18 | **18/18** (production path incl. CSP, preload allowlist, nav lockdown) |

The sidecar typecheck wrapper was itself audited
([sidecar-typecheck.ts](../../../app/scripts/sidecar-typecheck.ts)): it fails on
any diagnostic matching `app/(sidecar|shared)/`, so P2-4's sidecar changes are
genuinely type-covered; `app/tsconfig.json` covers main/preload/supervisor/
renderer/shared/scripts. No file is outside both configs.

## Per-session verdicts

### P2-0 spine — NOT REGRESSED (was GREEN)

- The 15-discriminant `projectMessage` switch is intact with the compile-time
  `never` tripwire at `transcriptProjector.ts:479` and the fixture mapped-type
  tripwire at `sdkMessageFixtures.ts:105`. Renderer tsc is clean, which under
  the (previously fired-and-proven) tripwire mechanism certifies both sides
  still cover the full 19-member union. I did not re-run the negative tsc
  experiments — they require temporary source edits, which this review is
  barred from; the mechanism was independently proven under real tsc yesterday
  and all three projector sessions attest re-firing it.
- P2-0's review follow-ups F1/F3/F4 are APPLIED: `sdk-stdout-only` relabels on
  the `task_*`/`session_state_changed` samples, the `error_during_execution`
  anchor is `src/QueryEngine.ts:1143` (`sdkMessageFixtures.ts:1215`), and the
  P2-2 STATUS row no longer overstates the subagent-delta claim.

### P2-1 core transcript rows (`49abf37`) — GREEN

- All claimed row families exist in the projector with runtime narrowing and
  zero casts: thinking/redacted (`transcriptProjector.ts:1249-1281`, both
  `reasoning_kind`/`reasoningKind` spellings preserved), user text/image +
  command echo (`:1300-1344`, `<command-message>` parse at `:1366`), system
  notices/init/compact (`projectSystemFrame`, `:663-750`), result (`:625-661`).
  UUID dedupe via `seenFrameIds`; malformed blocks degrade to no row.
- The carry-forward doc (`2026-07-04-p2-1-transcript-seam-gaps.md`) is
  **accurate against source**: snip is an internal subtype only
  (`src/services/compact/snipProjection.ts:6-12`), tombstone is consumed
  without being yielded (`src/QueryEngine.ts:815-818`), and live local-command
  output is deliberately converted engine-side to synthetic assistant text
  (`src/utils/messages/mappers.ts:183-214`) — so `SnipBoundaryRow`/
  `TombstoneRow` stay typed-but-unminted and no frame is invented. Correct
  degraded posture.
- Caveat (F3 below): these rows are projector-layer only; `TranscriptView`
  renders none of them yet.
- Fixture caveat (F6): the "real tagged command echo" sample omits the
  `<command-name>` tag every real breadcrumb carries
  (`formatCommandInputTags`, `src/utils/messages.ts:577-584` mints three tags).
  Projection works on the real three-tag shape too (the parser keys on
  `<command-message>`), so behavior conclusions stand — but the sample fails
  the P2-0 realism bar.

### P2-2 tool cards + correlation (`c7ea717`) — GREEN

- **Status is genuinely derived, never stored**: the only writes are to the
  session's `toolResultsByUseId` map (`foldToolResultBlocks`,
  `transcriptProjector.ts:819-835`); `selectTranscriptRows` joins at read time
  (`:287-304`) with reference-stable memoization. Stored `ToolUseRow`s keep
  their minted `pending/null` defaults (`:1245-1246`) and are never mutated.
- Both correlation paths are real: `tool_result` blocks on `user` frames
  (`correlateToolResults`, fold-before-dedupe so replays stay idempotent) and
  server-tool results riding a LATER assistant frame (fold happens before the
  frame's own dedupe marker at `:514`, and result-block types are rowless by
  design, `:1283-1291`). The 8 result-block discriminants (`:846-860`) match
  the engine's own switch lists.
- `deriveToolFamily` (`:949-991`) uses the two real name vocabularies (client
  `*_TOOL_NAME` constants + the SDK's `ServerToolUseBlock` literals) with
  `mcp__` prefix → `'mcp'` and unknown → `'other'`.
- Diff extraction (`extractDiffProjection`, `:904-928`) runtime-narrows the
  FileEditTool `structuredPatch` shape hunk-by-hunk, degrading to `null` — the
  one-file-many-hunks model matches `FileEditTool`'s actual output type.
- D2/C4 nesting is a read-time transform (`selectNestedTranscriptRows`,
  `:319-350`) wired into the real UI (`App.tsx:88-91`, `TranscriptView.tsx:73-79`);
  orphaned children surface at top level. (Cycle edge: F2 below.)
- The mcp-type-gap flag (`reviews/2026-07-04-p2-2-mcp-tool-block-types.md`) is
  accurate: the projector handles `mcp_tool_use`/`mcp_tool_result` as runtime
  string literals (`:851-859`, `:1229`, `:1285`); only the typed fixture pair
  is missing, pending an SDK version bump. Non-blocking, correctly scoped.
- Fixture caveats (F6): two of the five added samples are wrong-shaped. The
  `web_search_tool_result` sample uses `content:[{type:'text',…}]`, which
  neither the SDK type (`web_search_result[]` with title/url/encrypted_content)
  nor the Codex adapter (`{title,url}` sources,
  `codex-fetch-adapter.ts:1998-2013`) can emit — and this masks a real display
  gap: `flattenToolResultContent` extracts only `type:'text'` parts, so a REAL
  web-search result flattens to an empty string on the tool card. The FileEdit
  `tool_result` sample uses a text-block array + explicit `is_error:false` +
  `isSynthetic:true`, while the real mapper emits plain STRING content with
  `is_error` omitted on a non-synthetic frame
  (`FileEditTool.ts:427-446`) — projection outcome is the same either way, but
  the sample certifies a shape the named producer cannot mint. Also the STATUS
  row's "+9 samples" is wrong: the commit adds **5** samples and renames the
  pre-existing `server_tool_use` entry (verified from the commit diff).

### P2-3 streaming/activity (`356d63a`) — GREEN

- Previews are keyed `(message.id, blockIndex)` (`streamingTextBlocks`,
  `streamBlockKey`) and the preview row id composes identically to the final
  full-frame row id, so the authoritative assistant frame replaces the preview
  in place via `upsertRows` and deletes its stream-block entry (`:551-563`).
- A late/duplicate delta cannot clobber a reconciled row:
  `upsertStreamingRows` only replaces rows still marked `isStreaming`
  (`:1157-1179`), and after `message_stop` the null `currentStreamMessageId`
  gates all delta handling.
- `result` is the only turn-end authority: `finalizeStreamingTurn` prunes
  orphan previews and clears stream state BEFORE the result row projects
  (`projectMessage` case `'result'`, `:411-418`) — so even a malformed result
  frame that fails row-narrowing still cleans up previews.
- Interleaved subagent full frames mid-stream don't disturb the stream tracker
  (different messageId takes the fallback-index path; tracker is read-only
  there). Tool-use blocks streamed via `input_json_delta` correctly produce no
  text preview but still advance the block index.
- Fixture caveat (F6): the `S1_STREAMING_TEXT_TURN` sequence — the session's S1
  acceptance artifact — is under-specified against the real seam: its six
  `stream_event` frames omit `session_id`/`parent_tool_use_id`, which
  QueryEngine's wrapper ALWAYS adds (`src/QueryEngine.ts:876-883`, re-verified),
  its `message_start.message` carries only `{id}` where the real event carries
  a full Message, and its authoritative assistant frame omits
  model/stop_sequence/usage. The projector ignores all the omitted fields, so
  the reconcile-behavior conclusions hold — but the sequence passes tsc only
  because `SDKPartialAssistantMessage.event` is `unknown` and the wrapper
  fields are optional in the type, i.e. the mapped-type tripwire does NOT
  certify this sequence's realism the way it certifies the main fixture's.

### P2-4 permissions domain (`010e8ba`) — GREEN (first code review; behavior was already live-verified)

The trust boundary (`app/sidecar/sidecarServer.ts`) implements the decision doc
faithfully, in the specified fail-closed order — envelope/version check →
sessionId address check → F10 strict key allowlist (`checkStrictKeys`, `:830` —
no `destination` key on setMode, prototype-key lookup hardened via `Map.get`) →
C2 local schema with explicit `bypassPermissions`/`auto` rejections BEFORE the
enum parse (`:424-490`) → shared Zod schema → dispatch. On
`permission.response`: T5a pending lookup (`:502-514`) → C1
`validateSuggestionSelection` from the RAW frame (integer/range/dup/size checks
against the pending request's own engine-minted `permission_suggestions`,
`:979-1036`) → T6/T6b sanitize (echo-or-empty check, then the GATED input is
forwarded, never renderer bytes; `updatedPermissions` stripped, `:586-635`) →
engine-object re-attach under `structuredClone` (`:548-551`). Verified engine-side:
the spread in `normalizePermissionResponse` carries the attached updates, apply+
persist fires only on non-empty updates
(`PermissionPromptToolResultSchema.ts:95-106`), and `supportsPersistence`
excludes `session`/`cliArg` (`PermissionUpdate.ts:208-216`). Zero `src/` changes
in the commit — as decided.

- **C2 apply idiom is the decision's, exactly**: `permissionDomain.ts:56-65`
  uses `transitionPermissionMode` over the same `appStateStore` the runtime
  enforces, not a bare mode assignment; same-mode is a reference-preserving
  no-op. Session-scoped by construction (no destination exists on the wire).
- **C3 snapshot** is built only from the engine's live context
  (`buildPermissionContextSnapshot`, `:929-950`; Map → entries array for
  JSON-safety), emitted on attach after `ready` and on store-subscription
  reference change, and passes the outbound secret-key guard like every frame
  (`send`, `:735-756`).
- **§8 defect fixed for real**: `loadSidecarToolPermissionContext`
  (`sessionController.ts:40-78`) mirrors the CLI bootstrap
  (`initialPermissionModeFromCLI` + `initializeToolPermissionContext` + both
  post-steps), with `isBypassPermissionsModeAvailable` pinned `false` until a
  trusted desktop grant surface exists. Dedicated test:
  `sessionController.test.ts` "PERMISSION-BOUNDARY §8 fix — settings rules and
  defaultMode actually load". (Boot-mode parity note: F4 below.)
- **Relay and preload stay fail-closed**: main's `coercePermissionResponse`
  drops a malformed `applySuggestions` wholesale rather than downgrading
  always→once (`main.ts:395-412`); an out-of-allowlist setMode is dropped, not
  forwarded (`main.ts:293-297`). Preload adds exactly one fixed channel
  (`CH_SET_MODE`); no generic sender appeared; hardening smoke's
  "bridge exposes exactly the allowlisted methods" re-passed.
- **Renderer C1 index integrity holds**: `PermissionPrompt` maps directly over
  the raw `request.permission_suggestions` (unfiltered, unreordered,
  `PermissionPrompt.tsx:76-146`) and sends `[index]`; `describeSuggestion`
  renders the engine's rule content verbatim (`ruleImplication` guesser
  confirmed absent from `app/`). `buildAllowResponse` sends the empty-echo
  sentinel, never the input bytes (`permissionState.ts:263-274`).
- **Test coverage is comprehensive**: 44 boundary tests
  (`sidecarServer.test.ts`) spanning every C1/C2/C3 contract point incl.
  destination-smuggling, probe-mode fail-closed, secret-guard on `ready`, and
  the concurrent-pendings selection-isolation case; 27 renderer permission
  tests incl. cross-session isolation and mass-deny; 4 domain tests proving
  the real engine transition runs.
- The supervisor change is type-widening only (`AppClientMessage` →
  `SidecarClientMessage`); `index.ts` injects the domain capability, absent in
  probe mode (fails closed, tested).

## Findings, ranked

| # | Sev | Where | Finding |
|---|-----|-------|---------|
| F1 | **Medium** | [replayBuffer.ts:63-65](../../../app/main/replayBuffer.ts) + [permissionState.ts:136-138](../../../app/renderer/src/permissionState.ts) | **A reloaded renderer can be stranded without a `permission.context` snapshot.** Only the `ready` frame is retained as a permanent replay head; `permission.context` frames ride the bounded ring (512 frames / 8 MB). The sidecar re-emits the snapshot only on SOCKET attach (`sidecarServer.ts:164-169`) — a renderer reload does not touch the socket. One long streamed turn easily exceeds 512 frames (every `stream_event` delta is a frame), evicting the last snapshot; after Cmd+R the replay then carries no snapshot, `context` stays `null`, and the rules editor shows "Waiting for the engine's permission context…" until the next context CHANGE (possibly never). The permission QUEUE is unaffected (pendings rehydrate from the `ready` head). The reducer comment "the context snapshot is re-emitted right after every ready frame" holds for socket attach but not renderer re-attach — the assumption the transport doesn't guarantee. Fix shape (Phase-3): retain the LATEST `permission.context` per session as a second replay head (it is an idempotent snapshot — latest-wins), or have main request a fresh snapshot on `rendererReady`. Belongs naturally to P3-0/P3-4's replay/eviction work; flag it there so it isn't lost. |
| F2 | Low | [transcriptProjector.ts:319-350](../../../app/renderer/src/transcriptProjector.ts) | `selectNestedTranscriptRows` silently DROPS rows on a cyclic `parentToolUseId` (self-parent or mutual cycle): such rows are neither top-level nor reachable from any top-level parent. The engine cannot mint this shape today (parent ids are the outer Task's tool_use id; child block ids are fresh), so this is tolerance-posture drift, not a live bug — but it contradicts the function's own "degraded not dropped" contract, and the same drift class the projector elsewhere guards against. Cheap guard: track visited ids and surface unplaced rows at top level. |
| F3 | Low | [TranscriptView.tsx:43-44](../../../app/renderer/src/TranscriptView.tsx) | P2-1's row families are data-layer only: `TranscriptRowView` renders `assistant-text` and `tool-use` (with children) and returns `null` for everything else — user text/images, command echoes, thinking, system notices, session-init, result, and compact boundaries are invisible in the actual UI. The code comment owns this as later presentation work and the Phase-2 gate ("real multi-tool transcript renders") is still honestly met — but the STATUS P2-1 row reads as if these rows are user-visible. Phase-4 visual work should treat P2-1 rendering as NOT started. |
| F4 | Info | [sessionController.ts:40-78](../../../app/sidecar/sessionController.ts) | Desktop boot mode follows the full CLI priority chain, so settings `permissions.defaultMode: bypassPermissions` (when not org-disabled) or the auto-mode fallback can boot the session in a mode OUTSIDE the 4-mode wire allowlist. This is deliberate CLI parity from a trusted surface (the user's own settings file — the renderer still cannot request or persist either mode), the RulesEditor renders an out-of-allowlist mode gracefully (`current: <mode>` chip, `PermissionRulesEditor.tsx:58-64`), and `isBypassPermissionsModeAvailable` stays pinned false. Recorded because the C2 allowlist reads as if these modes cannot occur at all; they can — by bootstrap, not by wire. |
| F5 | Info | [transcriptProjector.ts:402-409](../../../app/renderer/src/transcriptProjector.ts) | A REPLAYED user frame carrying `tool_result` blocks re-folds the correlation map before the `seenFrameIds` check, allocating a new (content-identical) state object — idempotent by value, but duplicate user frames are not reference-equal no-ops the way duplicate assistant frames are (`:504` checks first). Perf/consistency nit only. |
| F6 | **Medium** | [sdkMessageFixtures.ts](../../../app/renderer/src/sdkMessageFixtures.ts) | **Four of the ~19 post-P2-0 fixture samples are wrong-shaped** (delegated sweep, all four producer-side claims re-verified by the lead against source): (1) the P2-3 `S1_STREAMING_TEXT_TURN` frames omit the wrapper fields the seam always emits (`QueryEngine.ts:876-883`) and under-specify `message_start`; (2) the `web_search_tool_result` sample uses text-block content no real producer can emit — masking a real display gap: real web-search results flatten to an EMPTY tool-card content string (`flattenToolResultContent` extracts only text parts); (3) the FileEdit `tool_result` composite (text-block array / `is_error:false` / `isSynthetic:true`) cannot be minted by the FileEdit path it names (`FileEditTool.ts:427-446` emits string content, no `is_error`); (4) the command-replay sample omits the `<command-name>` tag every real breadcrumb carries (`messages.ts:577-584`). Runtime behavior conclusions all survive (the projector ignores or tolerates the divergent fields), so this does not reopen P2-1/2/3 — but the fixture is chartered as THE acceptance artifact and the reference for every later row-family session, and these samples fail P2-0's own realism bar ("no sample the engine could not emit"). Also: the P2-2 STATUS "+9 samples" claim is false (5 added + 1 renamed). **Required follow-up before Phase-4 row-family sessions consume the fixture:** repair the four samples, and decide whether the empty-content rendering for real server-tool results is acceptable P4 chrome scope. |
| F7 | Low | [PERMISSION-BOUNDARY.md](../decisions/PERMISSION-BOUNDARY.md) | Bulk anchor drift: 17 of the decision doc's `file:line` anchors are stale after P2-4 added code above the already-implemented C1 methods/tests (e.g. `validateSuggestionSelection` `:745`→`:979`, the seven C1 test anchors shifted +30, `coercePermissionResponse` `main.ts:294`→`:373`, `PermissionResponseInput` `protocol.ts:182`→`:289`). Every named behavior/symbol still exists (the doc's own "source wins" rule covers this); the §8 "sidecar loads no settings rules" prose is now opposite to source because P2-4 fixed it — expected staleness, not a defect. A one-pass anchor refresh of the decision doc would help Phase-3/4 sessions that navigate by it. Full drift table: `delegated/2026-07-04-phase2-fixture-anchor-audit.md` Part B. |

No Critical, no High. Nothing blocks Phase 3.

## Carry-forward ledger

| Item | Status at this review |
|---|---|
| P2-1 transcript seam gaps (`2026-07-04-p2-1-transcript-seam-gaps.md`) | **OPEN by design, doc verified accurate.** Snip/tombstone unmintable at the seam; live local-command identity degraded engine-side. Extend-engine-vs-change-UI decision still pending; rows stay typed-but-unminted. |
| P2-2 mcp tool-block type gap (`2026-07-04-p2-2-mcp-tool-block-types.md`) | **OPEN, non-blocking, doc verified accurate.** Runtime handling in place; typed fixture pair awaits an `@anthropic-ai/sdk` version bump. |
| PERMISSION-BOUNDARY §8 (empty permission context) | **FIXED in P2-4 + tested** (loader mirrors CLI bootstrap; live run showed settings rules in the C3 panel). |
| P2-0 review F1/F3/F4 | **APPLIED, verified in fixtures/STATUS.** |
| P2-0 review F2 (mega-commit hygiene) | Not repeated — P2-1..P2-4 each landed as their own commit (P2-2/P2-3 via clean merges; branch tips verified fully contained in the merge; branches deleted). |
| DR-2 settings-write last-writer-wins (Phase 3) | **Unchanged by Phase 2** — C1 reuses the engine's existing decision path; no new settings-write path was added. Still Phase-3 scope. |
| Sidecar tsc ≈5.5k upstream errors (P1-3) | Unchanged (5,549 today); wrapper proves zero owned-file diagnostics. |
| ESLint root config not covering `app/**` | Unchanged; Phase-5 CI scope. |

## Security baseline (SECURITY-MINIMUM) — no regression

T4 (`parseThreadGoal` on submit), T5a (pending-map lookup first), T6 (gated-input
forwarding, echo-or-empty), T6b (key rejected upstream + sanitizer strip; the
ONLY `updatedPermissions` producer is the C1 engine-object re-attach), T7 (frame/
rate/prompt caps, directional limits unswapped in `limits.ts`), F6 secret guard
on every outbound kind incl. `ready` and the new `permission.context`, F10
strict keys extended (not widened) for the two new frames. Renderer hardening
checklist re-certified by today's 18/18 smoke. The C2/C3 additions match the
PERMISSION-BOUNDARY threat analysis; `bypassPermissions` is unreachable from the
wire in both the mode enum and the explicit pre-parse rejection.

## Phase-3 gate statement

Nothing found blocks opening Phase 3. Three riders:

1. Fold **F1** (permission.context replay head) into P3-0's replay-eviction item
   or P3-4's replay demux — it is exactly that file territory.
2. P3-4/P3-5 renderer work should treat P2-1 row RENDERING (F3) as outstanding
   Phase-4 scope, not done.
3. **F6 fixture repair is a hard pre-condition for Phase-4 backlog generation**
   (not for Phase 3): the four wrong-shape samples + the two stale sample
   anchors must be fixed before row-family sessions copy the fixture as their
   reference, and the web-search empty-content rendering question needs an
   explicit disposition. Small, bounded, ANY-model task.

## §8 Delegated evidence (RECONCILED)

A mechanical sweep ran in a fresh session:
`delegated/2026-07-04-phase2-fixture-anchor-audit.md`. Results: Part A
(fixture realism, 19 post-P2-0 items) **13 HOLDS / 2 DRIFTED / 4 WRONG**;
Part B (anchor drift, 70 citations) **52 HOLDS / 17 DRIFTED / 1 WRONG**.

Lead reconciliation — treated as evidence, not authority:

- **All four Part-A WRONG claims were re-verified by the lead against engine
  source and CONFIRMED** (stream wrapper fields at `QueryEngine.ts:876-883`;
  Codex web-search `{title,url}` sources at `codex-fetch-adapter.ts:1998-2013`;
  FileEdit string-content mapper at `FileEditTool.ts:427-446`; three-tag
  breadcrumb at `messages.ts:577-584`; the fixture samples themselves at
  `:250-277`, `:842-864`, `:1428-1508`). Accepted → **F6 (Medium)**. The
  delegate flagged these as potentially verdict-flipping; the lead's judgment
  is they do NOT flip GREEN: every divergent field is one the projector
  ignores or tolerates, so no behavioral conclusion of P2-1/2/3 is invalidated,
  and the phase gate rests on live verification, not on these samples. What
  they do break is the fixture's acceptance-artifact charter — hence a
  required pre-Phase-4 follow-up rather than a phase re-block.
- **The "+9 samples" miscount was independently reproduced** from the
  `c7ea717` diff (5 added + 1 renamed) — folded into F6.
- **Part B's 17 DRIFTED anchors** are a uniform line-shift consequence of
  P2-4's additions; the delegate confirmed every named behavior still exists,
  and the lead had already source-verified the load-bearing subset
  (T5a/C1/T6/T6b logic, engine apply/persist path). Accepted → **F7 (Low)**.
  The single Part-B WRONG (`sessionController.ts:37` "loads no settings
  rules") is the §8 defect prose now describing a FIXED state — expected
  staleness, no action beyond the F7 refresh.
- The delegate's Part-A DRIFTED items (result-success fixture anchor
  `:1142`→`:1193-1212`; FileEdit tool-use sample citing the output schema
  instead of the input schema + assistant mint) are one-line anchor fixes,
  folded into the F6 follow-up.

## What I re-ran / re-derived (evidence trail)

- All four gates (table above), from repo root at HEAD.
- Merge integrity: test-name sets of `transcriptProjector.test.ts` at `49abf37`,
  `c7ea717`, `356d63a` vs merged HEAD — union fully contained, zero missing.
- Full read of: `sidecarServer.ts`, `permissionDomain.ts`,
  `sessionController.ts`, `protocol.ts`, `limits.ts`, `main.ts`,
  `attachmentGate.ts`, `replayBuffer.ts`, `preload.ts`, `permissionState.ts`,
  `PermissionPrompt/Queue/RulesEditor`, `App.tsx`, `TranscriptView.tsx`,
  `transcriptProjector.ts` (1,443 lines), sidecar-typecheck wrapper, both
  tsconfigs.
- Engine-side anchor spot-checks: `initialPermissionModeFromCLI`
  (`permissionSetup.ts:689-833` — bypass gating chain),
  `normalizePermissionResponse` spread, `PermissionPromptToolResultSchema.ts:95-112`
  apply+persist+empty-input semantics, `supportsPersistence`,
  `snipProjection.ts:6`, `QueryEngine.ts:815`, `mappers.ts:183`,
  `rawMessageLog.ts:5` (512 cap).
- P2-4 commit diff audit: zero `src/` changes; `engine-types.snapshot.d.ts`
  delta is a type-only re-export addition (no snapshot drift).
- Delegated-evidence reconciliation (§8): re-verified all four Part-A WRONG
  producer claims against `QueryEngine.ts:876-883`,
  `codex-fetch-adapter.ts:1998-2013`, `FileEditTool.ts:427-446`,
  `messages.ts:577-586`, and the three fixture samples; reproduced the P2-2
  added-sample count from the `c7ea717` diff.
