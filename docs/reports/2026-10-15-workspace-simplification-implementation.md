# Workspace simplification implementation

Date: 2026-10-15. Baseline: `008dc331`.
Spec: [verified eleven-finding audit](2026-10-15-workspace-simplification-audit.md).

## Implemented scope

| Finding | Result | Preserved boundary |
|---|---|---|
| F1 | Retired per-session Memory/Extensions feeds and unread renderer stores. | Host Settings inventory, shared builders and presentation helpers. |
| F2 | Removed legacy stats query, snapshot, sender, and renderer cache. | Independent retained-history Usage worker and terminal statistics. |
| F3 | Removed session OAuth state/feed; chat account verbs accept switch only. | Host management worker, broad domain verbs, redaction, sign-out/deletion invalidations. |
| F4 | Dormant project classifier runtime replaced by recovery-only state and resend/cancel. | Tolerant legacy disk reader, full payload/attachments/cwd, receipts, uncertainty and fences. |
| F5 | Removed unread persisted active-worker index. | Known-worker history, write serialization, atomic rename and legacy reads. |
| F6 | Removed duplicate standalone Analytics/history stores. | Parent ownership and state across remounts. |
| F7 | Removed ignored goal update arguments and dead completion helper. | Goal creation objective and lifecycle fences. |
| F8 | Unified worker-name allocation after reproducing and fixing its async reservation race. | Local claim before awaited team allocation, release on failure, external ownership and retry. |
| F9 | Deleted test-only credential authorization wrapper. | Real send boundary; denied callbacks cannot initiate a request. |
| F10 | Removed twelve obsolete renderer-theme/typecheck harness files and generator target. | Active renderer snapshots, theme and generator output. |
| F11 | Replaced two cleanup source checks with behavioral runner cases; fixed setup leaks. | No-focus, isolation, shutdown/security, blank-frame guards and requested output. |

The coordinated wire removal bumps the desktop session protocol to v4; see its
[decision record](../migration/decisions/SESSION-PROTOCOL-V4.md). There is no
stored-data migration, new dependency, generic transport, or replacement framework.

## Provenance and exclusions

The shared checkout contains concurrent lid-closed and other desktop work. The
implementation is validated from a task-only snapshot, using saved preimages and
owned patches; unrelated hunks are excluded from review and commits.

Deleted tests covered retired session feeds or removed standalone modes. Retained
host builders, account management, receiving-schema rejection, redaction, recovery,
and controlled component behavior have focused coverage. Three credential tests
now execute the real send boundary. F11 retains independent lifetime/security
guards and adds bounded child-process behavior checks. Obsolete stats-only tests
are removed with their API. Protocol fixtures use v4; malformed-version fixtures
remain malformed. No test skip is added.

Build/config changes remove only the obsolete generator output and twelve legacy
harness files, including their lockfile/config. CLAUDE.md and maps drop their
obsolete references. No new package or dependency is added.

## Validation and review

The explicit `review-impl` pass used three fresh agents: correctness/lifecycle
plus design-versus-audit coverage; external contracts plus security; and execution
plus test discrimination. The parent read and validated all proposed findings
before fixes. No HIGH finding, user-visible defect, inherited dependency defect,
false positive, or deferred finding was established in this pass.

| Review finding | Severity / impact | Correction | Verification |
|---|---|---|---|
| Hardening inventory still expected removed queryStats in the isolated patch. | MEDIUM / internal | Restored the omitted inventory deletion; shared source already contained it. | Preload source/inventory suite: 13 pass. |
| Two transcript helper frames still used protocol3 in the isolated patch. | MEDIUM / internal | Included their omitted protocol4 updates, excluding concurrent transcript work. | Desktop typecheck passes. |
| Legacy worker-history fixture widened its status to string. | MEDIUM / internal | Preserve the completed literal type. | Worker-state 9 pass; root TypeScript comparison has no new diagnostic. |
| Session OAuth parking getter became unused. | LOW / internal | Remove getter and stale comment; retain actual host OAuth state. | Accounts domain 57 pass; desktop and scoped sidecar typechecks pass. |

All four are fixed and verified closed. The snapshot omissions were found before
staging; neither requires a foreign source change. The source implementation
matches all eleven findings. Mechanical fixture changes were spot-checked in
review and covered by the integrated typecheck; source/contracts received the
main review effort. GUI and live provider acceptance remain outside this pass.

| Check | Result |
|---|---|
| `bun run build:dev:full` | Passed: map/undefined-name gates, applicable root lint, dev-full bundle and CLI version. Root lint reports ignored-file warnings for paths outside its configuration; desktop lint/typechecks run separately. |
| `bun run --cwd app typecheck` | Passed after restoring both fixture updates. |
| `bun run --cwd app typecheck:sidecar` | Passed after the getter removal; 5574 upstream diagnostics outside the scoped ownership boundary are ignored by the repository wrapper. |
| `bun run --cwd app renderer:build` | Passed; existing large-chunk advisory remains. |
| Root `bun run typecheck`, compared to baseline | Known-red baseline 1897 diagnostics; final 1895. Normalized snapshot paths and line offsets: zero new diagnostics, two removed. |
| Engine focused ownership/goal/credential suites | 369 unique passing tests across 18 files, including real temporary-file team ownership and file-isolated account lifecycle/adapter tests. |
| Real network-blocked project-routing process suite | 4 pass: live/inactive conversation identity, revoked trust, and pre-ready journal recovery. |
| Independent execution review | 106 focused passes. Seven cases fail against reverted or minimally broken code:two naming races, three setup leaks, one revived retired receiver, one disabled cwd fence. |
| Renderer/recovery and metadata/receiver checks | 162 focused passes plus 460 follow-up passes; overlapping review runs are not added to a grand total. |
| Tooling and generator checks | 30 focused passes; current 11-case lifetime table passes. Baseline setup code fails three cases; cleanup mutant fails six. Both active generated outputs match baseline byte for byte. |
| Full desktop suite | 5920 pass, 3 existing skips, 9 failures. Untouched baseline: 5930 pass, 3 skips, the same 9 failures across 412 files. No new failure names; see below. |
| Documentation | 18 maps lint clean; changed local links resolve; task-only diff whitespace check passes. |

The nine baseline failures comprise the global-skill path assertion in
`app/shared/sessionRelocationRepeat.storage.test.ts` and the effort setter / effort
snapshot expectations in `app/sidecar/runControlsDomain.test.ts`, plus six peer
creation tests in `app/sidecar/createPeerTool.test.ts` that omit an auth fixture.
Isolated baseline runs reproduce the same failures (0 pass/1 fail, 16/2, and 10/6).
The peer suite passes 16/0 with a dummy credential and external fetches blocked.
The complete baseline comparison has the same nine failing test names and the
same three existing skips. These files and their production mechanisms were not
changed for this task.

No real Electron, provider request, token refresh, or installed app was used.
Unix-socket process tests ran with isolated configuration and network-blocking
preloads; sandbox-denied socket attempts were rerun with the required execution
permission. No automatic approval rejection remains unresolved.

## Unverified boundaries

Electron has not been launched, installed, or restarted. No real OAuth, account
refresh, provider request, GUI acceptance, or physical lid test is performed by
this task. To verify the visible surfaces, launch a build with protocol v4 and
check Settings inventories, host login/cancel, composer account switching,
Analytics selection, history navigation, and recovery resend/cancel.
