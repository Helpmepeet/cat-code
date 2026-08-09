# V06 adversarial validation: shared wire contract + sidebar/tabs/workspace shell

> **Verification provenance:** Claude Opus 5, high effort. Source review plus four
> scratch repros that import the real repo modules (renderer reducers, the four
> persistence modules), one repo test file run in isolation
> (`bun test app/renderer/src/WorkspacePanels.test.tsx` — 5 pass / 0 fail), and a
> programmatic diff of the sidecar allowlist against the inbound union. No GUI, no
> desktop app started, no full suite, no repo file edited. Two evidence-gathering
> subagents ran in parallel; every load-bearing claim they returned was
> independently re-derived here before being used. Branch `migration` at `a1012b1`.
>
> **Dirty-tree note:** every file cited in A06 and A07 is branch-new (absent from
> `main`) and **clean** in `git status`. Two files touched by neighbouring
> reasoning are DIRTY with another session's work and were read as-is:
> `app/main/main.ts` (so `forward()` line numbers below may shift) and
> `app/sidecar/sessionController.ts` (cited by A06's "Not reviewed" section).

## Overall verdict

Both reports are substantially right on mechanism and substantially wrong on two
headline consequences. **A06's HIGH is OVERSTATED and its audit table is its worst
defect**: a rejected `bad_request` frame with no `requestId` is *not* invisible —
`rawMessageLog.ts:116` consumes every error frame regardless of `requestId` and
`App.tsx:4305-4306` paints its message in danger text directly above that
session's composer, which I reproduced at runtime. The report enumerated "exactly
three consumers" and missed the one that renders. Worse, its closing table asserts
"All 30 inbound kinds pass all three columns. No gaps found" while three of its
cited boundary tests exercise a *different verb than the row they are credited to*
(`account.rename` and `account.touchAll` have no boundary reject test at all), and
the one gap it does confess (`app.abort`) is covered at
`sidecarServer.test.ts:381`. A07 fares better: its HIGH is real and reachable in
the **default single-panel** workspace, but it cited five render sites of which
three are split-only and missed the one that is always live. A07's clean bills
survive on Tailwind and em dashes and **fail on reference identity** — I
reproduced four counterexamples in `workspaceLayout.ts`, two of them uncompensated
in `App.tsx`, which means every mousedown inside the active panel mints a fresh
layout object and re-renders the workspace.

The one thing in this scope that most deserves action is not either HIGH. It is
that the sidecar's raw internal diagnostics (`unexpected key "foo" on
settings.setValue`, `rate limit exceeded`) are already rendered verbatim to the
user at `App.tsx:4306` — a CLAUDE.md §7 violation that exists *because* the
correlation hole A06 describes is real but its surfacing conclusion was inverted.

## Summary

| # | Sev | Finding (short) | Verdict | One-line reason |
|---|-----|-----------------|---------|-----------------|
| **A06-1** | HIGH | Rejected inbound frame uncorrelatable, therefore invisible | **OVERSTATED** | `rawMessageLog.ts:116` → `App.tsx:4305` renders it without a `requestId`; proven at runtime |
| A06-2 | MED | `SessionId` is a bare `string` alias | CONFIRMED | `protocol.ts:82`; both host methods take `string`; runtime lookups fail closed |
| A06-3 | MED | Six dead wire fields | CONFIRMED | All six have zero production readers; two producer lines transposed |
| A06-4 | MED | Nothing binds inbound union to sidecar allowlist | PARTIALLY CONFIRMED | Map is `string`-keyed and unbound; "reports nothing" half is false |
| A06-5 | MED | Transcript cache pins global `PROTOCOL_VERSION` | CONFIRMED | `transcriptCache.ts:334` discards + `unlinkSync`; latent, no current trigger |
| A06-6 | LOW | `PROTOCOL_VERSION` enforced on 1 of 31 outbound kinds | CONFIRMED | Only `supervisor.ts:588`; the count is 32, not 31 |
| A06-7 | LOW | `sessions.snapshot` has no producer and no consumer | CONFIRMED | Zero emitters repo-wide; only the type, the union, one retention row, one test |
| A06-8 | LOW | `hostApi.ts` carries the file-sink types | PARTIALLY CONFIRMED | Placement mismatch real; the file already carries the section banner the fix asks for |
| A06-9 | LOW | Literal tabs in the `ErrorFrame` code union | CONFIRMED | Exactly 3 tab-indented lines in `app/shared/**`, all at `protocol.ts:616-618` |
| A06-10 | LOW | Two outbound frames with no doc-comment | CONFIRMED | Both bare; small overreach on "no recorded argument" for one of three paths |
| **A06-T** | — | Audit table: "all 30 pass, no gaps found" | **INVALID** | 2 genuine gaps, 1 false gap, 3 misattributed test citations |
| **A07-1** | HIGH | Panel labels hand-build status from plane vocabulary | **CONFIRMED** | Repo's own green test asserts the exact strings; live in the default 1-panel state |
| A07-2 | MED | Raw session ids rendered, including as visible text | PARTIALLY CONFIRMED | aria-label ids always live; the visible pill id is split-only *and* descriptor-missing |
| A07-3 | MED | Parked-then-closed session's agent-mode snapshot retained | CONFIRMED | Reducer sees only frames; no `session-removed`; no lifecycle frame on a parked close |
| A07-4 | MED | `Sidebar.tsx` god component + duplicated reorder blocks | CONFIRMED | 2219 lines; diff shows the two 80-line blocks differ only as described; 15 icons exact |
| A07-5 | LOW | Hidden-workspace self-heal reads the filtered subset | CONFIRMED | `allGroups` sits unused one line above the filtered `groups`; trigger constructed |
| A07-6 | LOW | Three dead exports | CONFIRMED | All three have zero production callers/readers |
| A07-7 | LOW | `SessionGroup` drop handler has no MIME guard | CONFIRMED | Asymmetry real; unreachable, exactly as the report itself said |
| A07-8 | LOW | `role="tablist"` non-tab children; divider exposes no value | CONFIRMED (understated) | No `role="tab"` is a *child* of the tablist at all; an interposed generic breaks ownership |
| A07-9 | LOW | Recency computed at render with no ticker | CONFIRMED | `Date.now()` at `Sidebar.tsx:1953`; no `setInterval` in the file |
| A07-10 | LOW | Raw palette colours bypass tone tokens | CONFIRMED | Static classes, not `style={{}}`; the escalation I tested for does not apply |
| **A07-C** | — | Clean bills (4) | **1 REFUTED, 1 PARTIAL, 2 HOLD** | Reference-identity claim false for `workspaceLayout.ts` (4 counterexamples) |

## Per finding

### A06-1 — [HIGH] A rejected inbound frame is uncorrelatable and therefore invisible to the user

- **Verdict**: **OVERSTATED**
- **Cited location holds?**: Yes for the mechanism, no for the scope.
  `protocol.ts:605-621` does declare `requestId?: string` on `ErrorFrame` (and, as
  A06-9 notes, lines 616-618 are the tab-indented ones). The four cited rejection
  sites are real and do pass `undefined`: `sidecarServer.ts:790` (rate cap), `:843`
  (envelope), `:857` (session address), `:875` (`checkStrictKeys`).
  **But "every boundary-rejection call site leaves it undefined" is false.** I
  extracted the second positional argument at all 49 `this.sendError(...)` call
  sites programmatically: **41 pass a real id, 8 pass `undefined`.** The eight are
  `:782` (framing decode — no frame exists to read an id from, and the socket is
  closed), `:790`, `:843`, `:857`, `:875`, `:1022` (engine `appClientMessageSchema`
  failure), `:1043` (`app.ping` nonce cap — `app.ping` carries no `requestId`
  at all, it correlates by `nonce`), `:1561` (`app.park`, with an explicit comment
  choosing `undefined` because "the field it carries is not trustworthy here"),
  plus `:3338` (the outbound `secretGuard` block, an internal error). Every
  app-owned verb handler already implements the exact fix A06 proposes: it reads
  `raw.requestId` defensively *before* the schema parse and echoes it
  (`handleSetMode:1639-1641`, `handleWorkspaceTrustVerb:1785-1787`,
  `handleSettingsVerb:2216-2218`, and the account/session/run-control/task
  families).

- **Reachable in production?**: The five kind-agnostic pre-dispatch sites are
  reachable; nothing is env- or flag-gated. But the consumer claim is what fails.

  **Per-kind table (which kinds can hit a rejection site that drops `requestId`):**

  | Rejection site | Kinds affected | `requestId` echoed? | Note |
  |---|---|---|---|
  | `:782` framing decode | all (pre-parse) | no | socket closed immediately; no frame parsed |
  | `:790` rate cap | all | no | `continue`, connection survives |
  | `:843` envelope version | all | no | renderer cannot normally mint a wrong version |
  | `:857` session address | all | no | one sidecar per sessionId; routing bug or forgery |
  | `:875` `checkStrictKeys` | all | no | the drift path (see A06-4) |
  | `:1022` engine schema | `app.submit`, `app.abort`, `app.ping`, `permission.response` | no | the only *kind-specific* residual |
  | `:1043` nonce cap | `app.ping` | n/a | `app.ping` has no `requestId` field |
  | `:1561` `app.park` schema | `app.park` | no, deliberately | host-originated; no preload channel forwards it |
  | all 41 other sites | the other 25 kinds | **yes** | incl. every pre-parse defensive read |

  So the answer to the sharpened question is: `requestId` is genuinely absent for
  **four kinds at a kind-specific site** (`app.submit`, `app.abort`,
  `permission.response` via `:1022`; `app.park` via `:1561`, by design), and for
  **all kinds at the five kind-agnostic pre-dispatch sites**. For the other 25
  kinds every kind-specific rejection is correlatable.

- **Trigger**: I constructed it and it produces the *opposite* of the claimed
  outcome. Feeding the exact frame the sidecar sends
  (`{kind:'error', code:'bad_request', requestId: undefined, message:'rate limit exceeded'}`)
  through the real reducers:

  ```
  rawMessageLog.error  = "rate limit exceeded"
  => App.tsx:4305 renders it? YES (visible danger text above composer)
  connectionState changed?  false
  ```

- **Counter-arguments considered**: The report says the frame "reaches exactly
  three consumers and all three drop it." I re-derived the consumer set with
  `rg "kind === 'error'" app/renderer/src --glob '!*.test.*'` and got **four**
  hits, not three: `connectionState.ts:261`, `permissionState.ts:162`,
  `rawMessageLog.ts:116`, plus `verbAckResultState.ts` matching by kind. The three
  the report names do behave as described (`connectionState` maps only the three
  session codes and returns state unchanged for `bad_request`; `permissionState`
  short-circuits on falsy `requestId`; `verbAckResultState` matches only the four
  `*.result` kinds). The missed one is decisive: `rawMessageLog.ts:116` stores
  `error: frame.message` on the session keyed by `frame.sessionId`, with no
  `requestId` involvement, and `App.tsx:2487` passes that per-panel log into
  `SessionPane` as `activeLog`, which renders
  `<div className="text-sm text-tone-danger">{activeLog.error}</div>` at
  `App.tsx:4305-4306`. `<WorkspaceLayout>` (and therefore `SessionPane`) is mounted
  unconditionally in the `activeView === 'chat'` branch at `App.tsx:3403` — not
  dev-gated, not preview-gated.
  I also checked the report's "the rate-cap path is the live one." It is the least
  live of the five: `MAX_FRAMES_PER_WINDOW = 120` over `RATE_WINDOW_MS = 1_000`
  (`app/shared/limits.ts:29,32`). A human clicking cannot produce 120 inbound
  frames per second; that path needs automation or a renderer bug.

- **True consequence**: A rejected frame *is* surfaced — in the correct session's
  pane, in danger tone, with the sidecar's redacted message. What is genuinely lost
  is (a) per-request correlation, so a specific control cannot revert its optimistic
  state, and (b) any framing: the user sees the raw engineering string. The residual
  defect is real but it is a **UX-quality** finding, not the "resolves to nothing,
  forever, with no message" the report describes. The `error` field is also sticky —
  `rawMessageLog.ts:100-118` clears it only on an `app.ready` frame — so the message
  persists until the session re-attaches, which makes it *more* visible, not less.

- **Evidence**: scratch repro
  `/private/tmp/.../scratchpad/v06/errframe.ts` (output above);
  `python3` extraction of all 49 `sendError` argument-2 values;
  `app/renderer/src/rawMessageLog.ts:116-122`; `app/renderer/src/App.tsx:2487`,
  `:3403`, `:4305-4306`; `app/shared/limits.ts:29,32`.

- **Disposition**: **Do not apply the report's fix as written.** Its first half
  (echo `requestId` in `sendError` by sniffing `frame.message`) adds a
  message-shape probe to the one function that must stay trivially safe, and the
  25 app-owned kinds already echo. Instead:
  1. Add the same three-line defensive read the verb handlers use to the two
     pre-dispatch sites where a parsed object exists (`:875` after `checkStrictKeys`,
     `:1022` after the engine schema fails). Leave `:782`, `:790`, `:843`, `:857`
     alone — there is no trustworthy id to echo at any of them.
  2. Fix the surfacing, which is the larger defect: `App.tsx:4306` must not print a
     raw sidecar diagnostic. Route `bad_request` through a written user sentence and
     keep the raw text in the debug export (`buildDebugExport`, `appModel.ts:384`)
     where it already belongs. See **Missed-1** below.
  3. Do **not** make `requestId` required on `ErrorFrame` for `bad_request` — the
     framing/rate/envelope paths structurally cannot supply one, so the type would
     be a lie.

### A06-2 — [MED] `SessionId` is a bare `string` alias

- **Verdict**: **CONFIRMED** (severity slightly overstated)
- **Cited location holds?**: Yes. `protocol.ts:82` is exactly
  `export type SessionId = string`. `hostApi.ts` / `protocol.ts:2952` is
  `restoreSession(appSessionId: SessionId): Promise<HostResult<SessionDescriptor>>`
  and `:3002-3004` is `openHistorySession(engineSessionId: string): …`. Structurally
  identical; a swap type-checks trivially because the alias is transparent.
- **Reachable in production?**: The type gap is unconditional. The *bug* it enables
  is hypothetical (no current wrong-id call site was claimed and I found none).
- **Trigger**: `bridge.openHistorySession(descriptor.appSessionId)` compiles.
- **Counter-arguments considered**: I looked for a runtime backstop and found two.
  `openHistorySession` validates a strict UUID shape
  (`app/main/openHistorySession.ts:52`), and `restoreSession` is registry-mediated.
  I then checked whether the shape check discriminates: it does **not** — both id
  spaces are `randomUUID()` (`app/host/host.ts:285`, `:413`), so a swapped id passes
  the regex. What actually stops it is the *lookup*: an engine id is absent from the
  registry and an app id is absent from the sidecar-written baseline cache, so both
  directions fail closed with a typed error the renderer renders honestly. I also
  confirmed the report's claim that today's routing safety is naming discipline:
  `SessionOpenRoute` is a discriminated union with differently-named fields.
- **True consequence**: A wrong-id call ships green at compile time and then fails
  closed at runtime with a user-visible typed error. That is a real quality gap, not
  the silent-corruption reading "a wrong-id bug that ships green" invites.
- **Evidence**: `protocol.ts:82`, `:2952`, `:3002`; `app/host/host.ts:285,413`;
  `app/main/openHistorySession.ts:52`.
- **Disposition**: Apply the report's fix (two branded aliases minted at the three
  existing validators). It is cheap and correct. Do not raise the severity on the
  strength of the "ships green" phrasing — the runtime already fails closed, so this
  buys review time, not a prevented outage.

### A06-3 — [MED] Dead wire surface: six fields the sidecar sets that no consumer reads

- **Verdict**: **CONFIRMED**
- **Cited location holds?**: Yes for all six protocol lines. **Two producer lines
  are transposed**: `accountsDomain.ts:404` is `lastRefreshIso` and `:406` is
  `planType`, the reverse of the report's "set at `accountsDomain.ts:404,406`" in
  `planType, lastRefreshIso` order.
- **Reachable in production?**: All six are on frames broadcast on every store
  change; none is behind a flag.
- **Trigger**: n/a (dead-code finding). The claim is the absence of a reader.
- **Counter-arguments considered**: I hunted for indirect readers — spreads,
  `Object.keys/entries`, worker pass-through, serialization into the debug export,
  and consumers in `app/main`, `app/preload`, `app/supervisor`, `app/host` rather
  than only `app/renderer/src`. Two near-misses resolved *for* the report:
  `tasksState.ts:123-131` passes whole `TaskSnapshotItem`s through `groupTaskItems`,
  but the only downstream field consumer `toTaskAgentSource` (`tasksState.ts:139-161`)
  copies fields explicitly and copies the sibling `ultraplanPhase` while skipping
  `isUltraplan` and `totalPausedMs`. The many `src/` hits for these names are the
  *engine's own* AppState fields — the input to `tasksDomain.ts`, not a consumer of
  the protocol field. The strongest case is `provider: 'runtime'`: neither
  `AgentsPage.tsx` nor `agentConfigState.ts` contains the token `provider` at all,
  and `protocol.ts:855` concedes in prose that provider "is not an agent definition
  field," while the field is declared **required**, so every fixture must carry it.
- **True consequence**: As described. Note the report already flagged the
  `accountsPoolWorker.ts` `hasExactKeys` dependency for `planType`/`lastRefreshIso`,
  which is the one thing that makes those two not freely deletable — that caveat is
  correct and load-bearing.
- **Evidence**: `tasksDomain.ts:77,131,145`; `accountsDomain.ts:404,406`;
  `agentConfigDomain.ts:71`; `protocol.ts:855-856`, `:1106`, `:1122`, `:1164`,
  `:1901`, `:1904`; `accountsPoolWorker.ts:179-181,220-222,240-242`;
  `tasksState.ts:139-161`.
- **Disposition**: Apply the report's fix (the `agentConfigState.test.ts` slice-
  consumer table idiom, extended to `TasksSnapshot`/`TaskSnapshotItem`/
  `AccountStatus`/`SessionCatalogEntry`). Delete the four genuinely free fields.
  For `planType`/`lastRefreshIso`, classify them `unread` in the table but **keep
  them** until someone edits `accountsPoolWorker.ts` in the same change — removing
  either without that edit makes `parseAccountStatus` return `null` and blanks the
  Accounts page.

### A06-4 — [MED] Nothing binds the inbound union to the sidecar allowlist

- **Verdict**: **PARTIALLY CONFIRMED**
- **Cited location holds?**: Yes. `sidecarServer.ts:3487` is literally
  `const allowedByType = new Map<string, Set<string>>([…])` — keyed by `string`,
  values are string-literal `Set`s with no relation to the message types' keys. No
  test binds the two: `rg "allowedByType|SidecarClientMessage\['type'\]"` over
  `app/**/*.test.*` returns only prose mentions and per-verb boundary tests.
- **Reachable in production?**: Yes; `checkStrictKeys` runs on every inbound frame.
- **Trigger**: The report's is correct. I additionally verified the *current* state
  it claims: a scratch script that parsed the union out of `protocol.ts` and the map
  out of `sidecarServer.ts` found 30 union kinds and 30 map entries, **zero missing,
  zero extra** — so this is a latent binding gap, not a live drift, exactly as
  stated. On drift, `allowedByType.get(type)` returns `undefined` and
  `sidecarServer.ts:3576` returns `unknown message type: <type>`; a missing *field*
  yields `unexpected key "<k>" on <type>` at `:3580`.
- **Counter-arguments considered**: I checked whether tsc catches it some other way
  (it does not — the map is a runtime value), whether a boundary test would
  (they construct verbs individually, so a *new* verb has no test by definition),
  and whether the blast radius claim survives. **It does not, in half.** The report
  says the drifted feature "ships, does nothing, and reports nothing." Per A06-1 the
  rejection *is* reported: the developer gets `unexpected key "foo" on
  settings.setValue` rendered in danger text above the composer, which is a rather
  good diagnostic. What is true is that it is silent to **tsc and CI**, which is the
  part that matters.
- **True consequence**: A drifted verb is rejected wholesale at runtime and reports
  a raw but accurate reason on screen. Nothing in the build catches it.
- **Evidence**: `sidecarServer.ts:3480-3552`, `:3575-3582`; scratch union-vs-map
  diff; `rg` over `app/**/*.test.*`.
- **Disposition**: Apply the report's fix, but only its first half —
  `Record<SidecarClientMessage['type'], ReadonlySet<string>>` makes a missing entry
  a tsc error for one line of change. The second half
  (`ReadonlySet<keyof Extract<…>>`) is more expensive than it looks: several kinds
  intentionally omit keys from the allowlist that exist on the type (`app.ping`
  allows `type`/`nonce` only) and several allow keys the strict schema then narrows,
  so a naive `keyof` binding would either fail to compile or force the allowlist to
  widen. Do the key half only if someone can carry it without loosening a set.

### A06-5 — [MED] The transcript cache pins the global wire version

- **Verdict**: **CONFIRMED** (latent — no current trigger)
- **Cited location holds?**: Yes. `protocol.ts:2737` declares
  `protocolVersion: typeof PROTOCOL_VERSION` on `TranscriptCacheHeader`, and
  `transcriptCache.ts:333-336` discards on
  `cache.header.protocolVersion !== PROTOCOL_VERSION`. `discard()` at `:395-401`
  calls `unlinkSync` — the cache file is genuinely deleted, not just skipped.
- **Reachable in production?**: The gate runs on every preview read. The *failure*
  requires a `PROTOCOL_VERSION` bump, which has not happened (the constant is still
  `1` and the file's own rule is additive-only). So: mechanism live, trigger future.
- **Trigger**: Bump `PROTOCOL_VERSION` for a breaking change to any of the ~30
  non-transcript frame kinds. Every cache on disk is then unlinked on first read.
- **Counter-arguments considered**: I checked whether the header's neighbours
  already decouple this and they do — `guardVersion` and `runFactsVersion` are
  independently versioned, and `runFactsVersion`'s own doc-comment records that
  keying on the wrong signal "was a silent bug," which is the same mistake one level
  up. I also checked whether the distill allowlist could ever admit a frame whose
  shape a bump would break: `transcriptCache.ts:112-140` admits only `event` frames
  plus one truncation `error`, so no non-transcript kind can be in a cache. The
  report's reasoning is sound.
- **True consequence**: On some future bump, the whole instant-open (M2) feature
  cold-starts once. No data loss beyond a rebuildable cache, no user-visible error.
- **Evidence**: `protocol.ts:2733-2760`; `transcriptCache.ts:333-336`, `:395-401`,
  `:112-140`.
- **Disposition**: Apply the fix as written (own `cacheFormatVersion`, keep
  `protocolVersion` as a diagnostic stamp beside `appVersion`). It is a
  five-line change and it is cheapest to do before the first bump, not after.

### A06-6 — [LOW] `PROTOCOL_VERSION` is enforced on 1 of 31 outbound frame kinds

- **Verdict**: **CONFIRMED** (count is off by one)
- **Cited location holds?**: Yes. `rg protocolVersion` across `supervisor/`,
  `main/`, `renderer/src/` excluding producers returns exactly two readers:
  `supervisor.ts:588` (inside `validateReadyFrame`, so `ready` only) and
  `transcriptCache.ts:334` (the disk gate). Every other occurrence is
  `protocolVersion: PROTOCOL_VERSION` or the literal type.
- **Reachable in production?**: n/a — the finding is the *absence* of a check.
- **Trigger**: None today; sidecar and renderer ship in one bundle.
- **Counter-arguments considered**: I checked the report's own escape hatch — that
  `protocolVersion: typeof PROTOCOL_VERSION` is the literal type `1`, so no code in
  the tree can construct a v1 frame after a bump. That is correct and it means the
  finding really is about ceremony, not a gate. I also counted the union: **32**
  `ServerFrame` members, matched by 32 `FRAME_RETENTION` entries, so the headline
  should read "1 of 32."
- **True consequence**: 31 of 32 outbound stamps are unread ceremony that reads like
  a gate.
- **Evidence**: `supervisor.ts:585-590`; `transcriptCache.ts:334`; programmatic
  count of `ServerFrame` members vs `replayBuffer.ts` `FRAME_RETENTION` entries.
- **Disposition**: Take the report's *second* option only — one line in the
  `protocol.ts` header stating the field is a gate inbound and a diagnostic
  outbound. Do **not** add supervisor-side validation for all kinds: it buys nothing
  while both halves ship in one bundle, and it adds a drop path on the hot frame
  route. Revisit only if the packaging question in A06's "Not reviewed" section
  (can a stale sidecar face a newer main?) is ever answered yes.

### A06-7 — [LOW] `sessions.snapshot` is a `ServerFrame` variant with no producer and no consumer

- **Verdict**: **CONFIRMED**
- **Cited location holds?**: Yes. `protocol.ts:2582-2595` carries the
  "SUPERSEDED … NO LONGER EMITTED" comment and the type.
- **Reachable in production?**: `rg -a "kind: 'sessions\.snapshot'"` across `app/`
  returns exactly two hits: the type declaration and `sessionsCatalogDomain.test.ts:343`.
  No production emitter exists.
- **Trigger**: n/a.
- **Counter-arguments considered**: I checked whether the retention row is really
  forced rather than meaningful — `FRAME_RETENTION` is
  `Record<ServerFrame['kind'], FrameRetention>` (`replayBuffer.ts:101`) with 32
  entries for 32 kinds, so `'sessions.snapshot': 'ring'` at `:126` exists only to
  satisfy exhaustiveness, and the comment above it says so. I also tested the
  report's removal-safety argument: the distill allowlist
  (`transcriptCache.ts:117-131`) admits only `event` and one `error`, so the variant
  cannot appear in any at-rest artifact either. The argument holds.
- **True consequence**: One dead union member plus one forced retention row.
- **Evidence**: `protocol.ts:2582-2595`, `:2680`; `replayBuffer.ts:97-126`;
  `rg -a "sessions\.snapshot" app/`.
- **Disposition**: Fine to drop on the next touch of `protocol.ts`, as proposed.
  Not worth its own commit. **Rider:** while removing it, fix the stale citation at
  `app/main/sessionsCatalogBaseline.ts:16`, which points at
  `app/sidecar/sidecarServer.ts:2209` for the emitter — that line is now the
  settings-verb handler (see Missed-4).

### A06-8 — [LOW] `hostApi.ts` carries a type group its own comment argues does not belong there

- **Verdict**: **PARTIALLY CONFIRMED**
- **Cited location holds?**: Yes. `hostApi.ts:1-25` defines the module as "the
  app's session control plane" and names its five methods;
  `SaveTextErrorCode`/`SaveTextResult`/`SaveTextInput` sit at `:157`, `:174`, `:185`
  and appear nowhere in the `HostApi` interface — they are reached only through
  `CatCodeBridge.saveTextToFile` (`protocol.ts:3017`), a main-owned capability.
- **Reachable in production?**: n/a (organizational finding).
- **Trigger**: n/a.
- **Counter-arguments considered**: This is where the finding weakens. The file
  already carries a banner at `:143-145` —
  `P4-35 — the file sink (operator ruling 2026-07-30)` — which is substantially the
  "one line naming the scope" the report's own fix asks for; it is just at the
  section rather than the top. And the header's stated reason for the file's
  existence ("These types live in `app/shared/` beside the wire protocol because
  they cross the main↔renderer boundary via preload") covers the file-sink types
  exactly as well as the host ones. So the contradiction is between the header's
  first sentence and the file's contents, not between the file's reasoning and its
  layout.
- **True consequence**: A reader who stops at the first paragraph of the header is
  briefly surprised. That is the whole cost.
- **Evidence**: `hostApi.ts:1-25`, `:143-145`, `:157-190`, `:264-291`;
  `protocol.ts:3017`; `rg SaveText` across `app/`.
- **Disposition**: Take the one-line header amendment, not the file move. Moving
  three types to a new `mainFileSink.ts` costs four import-site edits across
  `preload/`, `main/`, `protocol.ts` and `renderer/src/sessionActionDialogState.ts`
  to fix a sentence.

### A06-9 — [LOW] Literal tab characters inside the `ErrorFrame` code union

- **Verdict**: **CONFIRMED** (exactly)
- **Cited location holds?**: Yes. `grep -nP '^\t' app/shared/protocol.ts` returns
  precisely three lines — `:616`, `:617`, `:618` — the last three members of
  `ErrorFrame['code']`, each indented with a tab plus four spaces.
- **Reachable in production?**: n/a (whitespace).
- **Trigger**: n/a.
- **Counter-arguments considered**: I checked the "rest of the file is spaces-only"
  half rather than taking it: those three are the *only* tab-indented lines in
  `protocol.ts`, and every other file in `app/shared/` has zero. I also confirmed
  the report's reason for bothering — `bun run lint` enables zero rules, so nothing
  in CI will ever flag it.
- **True consequence**: Cosmetic.
- **Evidence**: `grep -cP '^\t'` over all of `app/shared/*.ts`.
- **Disposition**: Re-indent the three lines in the next touch of the file. Not
  worth a standalone commit, and not worth a lint rule.

### A06-10 — [LOW] Two outbound frames ship with no doc-comment at all

- **Verdict**: **CONFIRMED** (one small overreach)
- **Cited location holds?**: Yes. `protocol.ts:900-902` is a bare section banner
  ("Goals + memory read-seams (P4-10) — read-only snapshots"), and
  `ThreadGoalStatus`/`ThreadGoalSnapshot`/`ThreadGoalSnapshotFrame` (`:905-929`)
  and the memory types plus `MemorySnapshotFrame` (`:931-997`) carry nothing else.
  The nested `AgentMemorySnapshot` block at `:957-974` is indeed exemplary.
- **Reachable in production?**: Both frames are live —
  `goalMemoryState.ts:26` and `:33` consume them, and `GoalsPage.tsx` renders the
  goal. Confirmed.
- **Trigger**: n/a (convention).
- **Counter-arguments considered**: I checked whether CLAUDE.md §6 makes these rule
  violations and it does not — the doc-comment rule binds *inbound* frames, which
  the report states correctly. I then tested its sharper sub-claim, that all three
  path-bearing fields ship "with no recorded argument for why those are safe
  outbound." **That is wrong for one of the three**: `AgentMemorySnapshot.directory`
  is covered by the very block the report calls exemplary, which states "Directory
  path and file COUNT only — memory bodies never cross the boundary." The claim
  survives for `MemoryInstructionFile.path` and `AutoMemoryHeader.filePath`.
- **True consequence**: Two of three path-bearing fields lack a redaction argument,
  in a file where `WorkspaceTrustSnapshot.trustRoot` (`:2317-2338`) sets the model.
- **Evidence**: `protocol.ts:900-997`, `:2317-2338`; `goalMemoryState.ts:26,33`.
- **Disposition**: One paragraph each, as proposed — but the argument only needs to
  cover the two uncovered paths, not all three.

### A06-T — Inbound frame audit table: "All 30 inbound kinds pass all three columns. No gaps found."

- **Verdict**: **INVALID** as a blanket claim
- **Cited location holds?**: The *first two* columns hold. A scratch script that
  parsed `SidecarClientMessage` out of `protocol.ts` and `allowedByType` out of
  `sidecarServer.ts` found 30 union kinds against 30 map entries with zero missing
  and zero extra, and each kind has either a sidecar-local Zod schema or the
  engine's shared one. The **third column is where it fails.**
- **Reachable in production?**: n/a — this is a coverage claim.
- **Trigger**: I spot-checked six rows chosen as least likely to be covered, then
  extended to the whole account family. Results:

  | Row | Report's claim | Reality |
  |---|---|---|
  | `app.abort` | "the only kind without a dedicated reject test" | **False.** `sidecarServer.test.ts:381` `'T7 — rejects an app.abort reason over the text cap (no abort)'` asserts `bad_request` **and** `aborts === 0`. |
  | `account.rename` | test `:4295` | **False.** `:4295` sends `account.switch` (`:4306`). `account.rename` appears **zero** times in `sidecarServer.test.ts`; the only hits are `accountsDomain.test.ts:487,495,505`, direct `domain.runVerb` calls that never cross `checkStrictKeys`. **Genuine gap.** |
  | `account.touchAll` | test `:4295` | **False.** Same test, same verb. `account.touchAll` appears only at `:723`/`:742`, both IDLE-PARK **accept**-path tests. **Genuine gap.** |
  | `fast.set` | test `:2519` | Line wrong (`:2519` sends `model.set` at `:2531`), verdict right — the real test is `:2481`. |
  | `remoteSettings.directConnect` | test `:4940` | Line wrong (`:4940` sends `remoteSettings.bridgeToggle` at `:4956`), verdict right — real tests at `:4878` and `:4966`. |
  | `session.tag` | test `:6255`, schema note `:3841` | **Fully accurate**, both verified. |

- **Counter-arguments considered**: I checked whether the family-level test could
  fairly be credited to each member — it cannot: `checkStrictKeys` is keyed per
  `type` with a *per-verb* key `Set`, so a rejection proven for `account.switch`
  proves nothing about `account.rename`'s own set. I also checked the rest of the
  account family before generalizing: `account.delete` has a real reject test
  (`:4351`, `confirm:false`), `account.logout` (`:4362`), `account.login` (`:4376`),
  `account.oauthCancel` (`:4528`), `account.oauthPasteCode` (`:4713`) and
  `account.oauthAlias` (`:4693`) are all genuinely covered. So the gap is exactly
  two verbs, not the family.
- **True consequence**: Two inbound kinds cross the trust boundary with no test
  exercising the reject direction, and a reader of this table would not know. The
  table's headline is the single most misleading sentence in either report, because
  its purpose is to let a reviewer *stop looking*.
- **Evidence**: `sidecarServer.test.ts:381`, `:723`, `:742`, `:2481`, `:2519`,
  `:4295-4308`, `:4351`, `:4878`, `:4940-4956`, `:4966`, `:6255`;
  `accountsDomain.test.ts:487-521`.
- **Disposition**: Add two boundary tests — an unexpected-key rejection for
  `account.rename` and for `account.touchAll`, modelled on `:4295`. Correct the
  three misattributed line citations. Delete the `app.abort` note. Do **not** trust
  the "no gaps found" framing anywhere downstream of this report.

### A07-1 — [HIGH] Panel labels hand-build status text from internal plane vocabulary

- **Verdict**: **CONFIRMED**
- **Cited location holds?**: Yes at `WorkspacePanels.tsx:434-437`:
  `` return `host ${host}, connection ${panel.connection.status}` `` with
  `const host = panel.descriptor?.status ?? 'missing'`. **The render-site list is
  partly wrong.** `:305` (the `<select>`) and `:327` (the close button) are inside
  `PanelHeader`, which is gated on `isSplit = panels.length > 1`
  (`WorkspacePanels.tsx:145`, `:167-178`) — split-only. `:404` (`Divider`) renders
  only when a `next` panel exists — split-only. `:425` is not a render site at all;
  it is a line inside the `panelAriaLabel` *function*. The site the report missed is
  the one that matters: **`:164`**, `aria-label={panelAriaLabel(panel, index, active)}`
  on the `<section>`, outside every gate.
- **Reachable in production?**: Yes, in the **default single-panel** workspace.
  `<WorkspaceLayout>` is mounted unconditionally in the `activeView === 'chat'`
  branch at `App.tsx:3403` — no dev gate, no `import.meta.env.DEV`, no flag. A
  `<section>` carrying an accessible name is an ARIA `region` landmark, so the
  string is exposed to assistive tech, unlike the two `DropEdge` labels (`:371`)
  which sit on bare `<div>`s with no role and are therefore largely ignored.
- **Trigger**: Open the app. The single panel's landmark reads
  `Panel 1 session <title> (<sessionId>), host ready, connection ready, active`.
- **Counter-arguments considered**: I tried three ways out. (a) Is `WorkspacePanels`
  dev-only or split-only as a whole? No — `App.tsx:3403`, unconditional. (b) Are the
  labels a deliberate debugging affordance (the possibility A07 itself raises)? I
  found no decision doc and no comment either way, but the strings are asserted by
  the module's own shipped test as product behaviour, which argues against
  "diagnostic leftover." (c) Do the labels perhaps never render? Refuted decisively
  by the repo's own green test.
- **True consequence**: A screen-reader user hears the two-plane transport model
  instead of the session's state, on the default surface. `sessionStatusVisual.ts:1-6`
  exists to prevent exactly this, and its `:42-47` comment already records catching
  a fifth drifted copy at the TabBar.
- **Evidence**: `bun test app/renderer/src/WorkspacePanels.test.tsx` → **5 pass /
  0 fail**, with `:40`, `:43`, `:47` asserting verbatim
  `'Panel 1 session Alpha (session-a), host ready, connection ready, active'`,
  `'Drop tab on left edge of panel 1 showing Alpha (session-a), host ready, connection ready to split'`
  and the `Resize split between panel 1 …` string. Also
  `WorkspacePanels.tsx:145`, `:164`, `:167`, `:371`, `:404`, `:434-437`;
  `App.tsx:3403`; `sessionStatusVisual.ts:1-6`, `:42-47`.
- **Disposition**: Apply the report's fix, with two corrections. Use
  `sessionStatusVisual(panel.descriptor.status, panel.descriptor.restorable, true).label`
  — the real signature is `(status, restorable, inRegistry)`
  (`sessionStatusVisual.ts:36-40`), not the two-arg form implied. And the call sites
  to change are **six**, not five: `:164`, `:305`, `:327`, and both `DropEdge`
  instances plus the `Divider`. Update the three assertions in
  `WorkspacePanels.test.tsx:40,43,47` in the same change or the suite goes red.

### A07-2 — [MED] Raw session ids rendered to the user, including as visible on-screen text

- **Verdict**: **PARTIALLY CONFIRMED**
- **Cited location holds?**: Yes for all three. `workspaceLabel` at `:440-447` falls
  back to `panel.sessionId.slice(0, 8)`; `sessionIdentity` at `:428-432` appends
  `` `(${panel.sessionId})` ``; the pill `title` at `:297` falls back to the bare
  `panel.sessionId`.
- **Reachable in production?**: **Split unevenly.** The `sessionIdentity` id suffix
  rides on `panelAriaLabel` (`:164`), which is ungated — so **full session ids are
  in the DOM of the default single-panel workspace**, and the repo's own test
  asserts `(session-a)` in three labels. That half is fully live. The *visible*
  8-char id and the `title` fallback are both inside `PanelHeader`, gated on
  `isSplit` (`:145`, `:167`), **and** additionally require `panel.descriptor?.cwd`
  to be absent. So the report's headline "visible on-screen text" needs two
  conditions the report does not mention: a split workspace **and** a panel whose
  descriptor has not landed.
- **Trigger**: For the aria-label half: open the app. For the visible half: split
  the workspace, then hit the P3-6 relaunch window before descriptors arrive.
- **Counter-arguments considered**: I checked whether `descriptor` can actually be
  `undefined` in practice — it is `tabDescriptorsById.get(sessionId)`
  (`App.tsx`, inside the `workspacePanels` map), typed
  `SessionDescriptor | undefined` at `WorkspacePanels.tsx:25`, so yes. I also
  checked whether the pill has a non-id fallback elsewhere and it does not. And I
  confirmed the report's comparison points are real: `tabBarModel.ts` returns
  `'New session'` and `Sidebar.tsx:1383` returns
  `'Sessions with no recorded workspace'`, so a word-fallback house style exists.
- **True consequence**: Full session ids reach the accessibility tree on the default
  surface; an 8-char id fragment reaches the screen only in a split workspace during
  a descriptor gap.
- **Evidence**: `WorkspacePanels.tsx:25`, `:145`, `:164`, `:167`, `:297`,
  `:428-432`, `:440-447`; `WorkspacePanels.test.tsx:40,43,47`; `tabBarModel.ts:9`;
  `Sidebar.tsx:1383`.
- **Disposition**: Apply both halves of the report's fix — drop the
  `` `(${sessionId})` `` suffix from `sessionIdentity` entirely (`tabLabel` plus the
  panel number already disambiguate), and fall back to a word rather than an id in
  `workspaceLabel` and the `title`. Fold this into the A07-1 change; it touches the
  same two helpers and the same three test assertions.

### A07-3 — [MED] A parked-then-closed session's full agent-mode snapshot is retained for the life of the window

- **Verdict**: **CONFIRMED**
- **Cited location holds?**: Yes. `orchestratorState.ts:37-56`
  (`reduceOrchestratorState`) handles exactly two kinds: `agent-mode.snapshot` sets
  `bySession[sessionId]`, `lifecycle` assigns `undefined` without `delete`, and
  everything else returns `state`. No `session-removed` branch.
- **Reachable in production?**: Yes. `dispatchOrchestrator` has exactly two
  occurrences in `App.tsx` — the `useReducer` at `:668` and the frame-batch fan-out
  at `:855`. It never receives a `HostEvent`; `session-removed` is handled
  separately at `App.tsx:958`, on a different plane.
- **Trigger**: Run an orchestrator session with N workers → it idle-parks → the
  operator closes it. No `lifecycle` frame arrives, so the whole `AgentModeSnapshot`
  (every `AgentModeWorkerItem` with descriptions and handles) stays pinned in
  `bySession` until the window dies.
- **Counter-arguments considered**: I looked for a reaper anywhere else and found
  none — the two dispatch sites above are the complete set. I checked the report's
  premise about parked closes rather than taking it: `App.tsx:1893-1896` states it
  first-party ("a parked session never receives a lifecycle frame when it is closed
  (the host deregisters the record before the child dies, so the exit is dropped)")
  and the surrounding code exists to compensate for that exact fact. I could not
  drive the host to prove the frame is dropped, so this premise rests on a
  first-party comment plus the compensating code around it, not on a live trace.
  Note it does not matter to the verdict: even when a `lifecycle` frame *does*
  arrive, the key is retained (only the value is released), so `bySession` grows
  monotonically in key count either way.
- **True consequence**: A bounded per-session retention leak of one snapshot object
  for the window's lifetime, plus a needless fresh `bySession` allocation on every
  `lifecycle` frame for sessions never in the map. Not user-visible; real.
- **Evidence**: `orchestratorState.ts:37-56`; `App.tsx:668`, `:855`, `:958`,
  `:1893-1896`.
- **Disposition**: Apply the fix as written — `delete` the key, return `state`
  unchanged when the key is absent, and add a `{ type: 'session-removed' }` action
  dispatched alongside the existing shell fold. All three parts are needed; the
  first two alone do not close the parked-close path.

### A07-4 — [MED] `Sidebar.tsx` is a god component, and its two reorder blocks are near-verbatim duplicates

- **Verdict**: **CONFIRMED**
- **Cited location holds?**: Yes, and unusually precisely. `wc -l` gives **2219**.
  A `diff -u` of `:572-615` against `:617-653` shows the two handler objects differ
  only in the state atom (`headerDrag`/`pinDrag`), the reducer trio, the refocus ref
  (`refocusCwd`/`refocusRowId`), plus a `mime` field on the pinned variant and an
  `allGroupCwds` argument on the workspace one. The three `commitX` wrappers at
  `:554-570` are byte-identical modulo the store. The icon block is exactly as
  claimed: **15** components from `:1964` (`PawLogo`) through `:2211` (`KebabIcon`),
  spanning 256 lines.
- **Reachable in production?**: n/a (design finding).
- **Trigger**: n/a.
- **Counter-arguments considered**: I tried to knock down the "near-verbatim"
  framing by diffing rather than eyeballing — the diff is 44 lines against 37 with
  every difference being a rename or the two extra fields, which is duplication by
  any reading. I also re-counted the icons because the report's "fifteen" looked
  like a round number; it is exact (my first count of 14 missed `PawLogo`, which
  the report's `:1964` start line correctly includes).
- **True consequence**: As described. The `RowReorderHandlers`/`WorkspaceReorderHandlers`
  type pair (`:224-233` vs `:199-208`) is the visible cost, and the SSR-only suite
  cannot see a drag at all, so both copies are untested at the interaction level.
- **Evidence**: `wc -l`; `diff -u` of the two extracted blocks; `awk` enumeration of
  every top-level `function` after `:1900`.
- **Disposition**: Take seam (a) — `useReorderList` in an adjacent `.ts` file — and
  seam (c) — move the icons to `sidebarIcons.tsx`. Both are mechanical and (c) is
  required anyway by the Fast Refresh boundary rule if anything else moves. **Skip
  seam (b)**: `usePersistedState` would abstract three five-line functions into a
  generic hook, which is a net complexity increase, and the three call sites read
  fine as they are.

### A07-5 — [LOW] Hidden-workspace self-heal reads activity off the search-filtered row subset

- **Verdict**: **CONFIRMED**
- **Cited location holds?**: Yes. `Sidebar.tsx:516` builds `groups` as
  `groupByWorkspace(groupRows.filter(matchesQuery), activeCwd)` when a query is
  present, and `:528-537` feeds that into `selectVisibleWorkspaceGroups`, whose
  `activityOf` callback reduces `sidebarActivityKey` over `group.rows` — the
  filtered rows. The unfiltered `allGroups` is memoized at `:505-512` and is not
  passed.
- **Reachable in production?**: Yes; plain search behaviour, no gate.
- **Trigger**: Hide project P at time T. Later work a session in P so its activity
  is `> T` and P self-heals back onto the rail. Now type a query matching only an
  older session B of P (activity `< T`). `activityOf(P)` returns B's key,
  `sidebarHiddenWorkspaces.ts:217` (`activityOf(group) <= hiddenAt`) re-classifies P
  as hidden, P vanishes from its own search results, and the rail reads
  "Show 1 hidden project" for a project that is not hidden.
- **Counter-arguments considered**: I checked whether `selectVisibleWorkspaceGroups`
  might re-derive activity internally from something unfiltered — it does not, the
  callback is the only source. I checked whether clicking the restore button could
  do harm — it re-clears an entry that no longer applies, which is a no-op, so the
  report's "transient display lie rather than data loss" is right. And I checked
  `sidebarHiddenWorkspaces.ts:198`, which does describe the argument as "how a group
  reports its most recent work" — a description the filtered subset violates.
- **True consequence**: A transient wrong hidden-count and a disappearing project,
  for the duration of a search. Self-corrects when the query clears.
- **Evidence**: `Sidebar.tsx:505-519`, `:528-537`, `:955-957`;
  `sidebarHiddenWorkspaces.ts:198`, `:217`.
- **Disposition**: Apply the fix as written — compute the activity key from
  `allGroups`, keyed by cwd. It is a one-argument change and `allGroups` is already
  memoized one line above.

### A07-6 — [LOW] Three dead exports, one of them the function whose misuse was a fixed bug

- **Verdict**: **CONFIRMED**
- **Cited location holds?**: Yes for all three.
  `sidebarHiddenWorkspaces.ts:166` `reduceHiddenWorkspacesCleared` — repo-wide
  references are its definition and `sidebarHiddenWorkspaces.test.ts:7,82,84` only;
  the live restore button calls `reduceHiddenWorkspacesShown`
  (`Sidebar.tsx:947`), and the test file at `:88`/`:108` records that calling
  `Cleared` there *was* the bug. `shellState.ts:239` `selectSession` — referenced
  only from `shellState.test.ts`. `MergedRowVisual.tone` — assigned at
  `sidebarState.ts:237`; the sole production consumer of `deriveMergedRowVisual` is
  `Sidebar.tsx:1521`, which reads `.openable` (`:1533`), `.intent`
  (`:1542,1547,1548`), `.label` (`:1574`) and `.kind` (`:1579,1581`) and never
  `.tone`.
- **Reachable in production?**: They are exported and therefore callable; none is
  called.
- **Trigger**: n/a — the hazard is the next person wiring an "unhide all"
  affordance reaching for the plausibly-named wrong function.
- **Counter-arguments considered**: For `.tone` I specifically checked whether the
  sidebar dot might read it indirectly — it does not; `Sidebar.tsx:1721` paints a
  hardcoded `bg-tone-good` off `row.live`, consistent with the O1 one-tone ruling.
  For `reduceHiddenWorkspacesCleared` I checked whether some other surface (the
  Sessions page, the command palette) might call it; nothing does.
- **True consequence**: One loaded footgun with a green test vouching for it, plus
  two harmless dead symbols.
- **Evidence**: `sidebarHiddenWorkspaces.ts:166`; `sidebarHiddenWorkspaces.test.ts:88,108`;
  `Sidebar.tsx:947`, `:1521`, `:1533-1581`, `:1721`; `shellState.ts:239`;
  `sidebarState.ts:219,237`.
- **Disposition**: Delete `reduceHiddenWorkspacesCleared` and its tests — that one
  is worth doing on its own, because the hazard is the name. `selectSession` and
  `.tone` can wait for the next touch of their files. Do **not** also drop `export`
  from `reduceWorkspaceShown` and `panelIndexForSession` as the report suggests:
  both have tests that import them, so un-exporting them turns a green suite red.

### A07-7 — [LOW] `SessionGroup`'s drop handler has no MIME guard while every sibling handler does

- **Verdict**: **CONFIRMED** (as the consistency finding the report itself claimed;
  the defect is genuinely unreachable, not merely unproven)
- **Cited location holds?**: Yes. `Sidebar.tsx:1303-1310` calls `preventDefault()`
  and `reorder.onDrop(group.cwd)` unconditionally, while `:1279-1285` (the group's
  own `dragover`) and `:1633-1639` (`SidebarRowItem`'s `onDrop`) both check
  `dataTransfer.types`.
- **Reachable in production?**: **No**, and I pushed harder than the report did to
  make it so. Three independent blockers: (1) `SidebarRowItem` is rendered inside a
  group at `:1436-1452` **without** a `reorder` prop, so `reorderable` is false
  (`:1536`) and all of its drag handlers are `undefined` (`:1587-1647`) — no
  descendant of a `SessionGroup` cancels `dragover`, which is a precondition for
  `drop` to fire. The reorderable rows are the pinned ones (`:833`), which live in a
  separate `<section>` at `:818`, outside any group. (2) The only window-level drag
  listeners in the renderer are `WorkspacePanels.tsx:74-75` (`drop`/`dragend`),
  neither of which calls `preventDefault`. (3) `reorderHandlers.onDrop`
  (`:585-598`) is wrapped in `if (headerDrag)`, non-null only during a
  workspace-header drag.
- **Trigger**: None exists.
- **Counter-arguments considered**: This is the finding where the counter-argument
  *is* the verdict, so I inverted the exercise and tried to build a trigger rather
  than refute one. The three blockers above are what I found instead.
- **True consequence**: The invariant that keeps the three drag MIMEs
  (`text/workspace-cwd`, `text/pinned-session-id`, `text/sessionId`) apart is
  present in three of four handlers and reads as accidental. No behavioural bug.
- **Evidence**: `Sidebar.tsx:585-598`, `:818`, `:833`, `:1279-1285`, `:1303-1310`,
  `:1436-1452`, `:1536`, `:1587-1647`; `WorkspacePanels.tsx:74-75`.
- **Disposition**: Copy the four-line guard from `:1633-1639` into the group's
  `onDrop`. Zero risk, and it converts an accidental invariant into a stated one.
  Do not raise the severity — there is nothing to exploit today.

### A07-8 — [LOW] `role="tablist"` contains non-tab children; the resize divider exposes no value

- **Verdict**: **CONFIRMED**, and **understated**
- **Cited location holds?**: Yes, and the real structure is worse than described.
  `role="tablist"` sits on `TabBar.tsx:120`. Its direct children are a generic
  `<div>` at `:123` and the Split/Unsplit cluster `<div>` at `:153-181`. The "+"
  button (`:142-150`) *and every tab* live inside that generic wrapper — the only
  two `role=` attributes in the whole file are `:120` (`tablist`) and `:262`
  (`tab`). So **no `role="tab"` element is a child of the tablist at all**; the
  interposed generic breaks ARIA ownership outright, rather than merely diluting the
  list with an extra button as the report says. The wrapper carries no
  `role="presentation"`.
  The divider half holds exactly: `WorkspacePanels.tsx:396-409` has
  `role="separator"`, `aria-orientation`, an `aria-label`, `tabIndex={0}` and
  `onKeyDown`, and a grep for `aria-value|aria-controls` across both files returns
  zero hits.
- **Reachable in production?**: Yes; both surfaces render unconditionally.
- **Trigger**: Navigate either surface with a screen reader.
- **Counter-arguments considered**: I checked whether `aria-owns` might restore the
  tablist relationship from elsewhere (no `aria-owns` anywhere in the file) and
  whether the generic wrapper might carry `role="presentation"`/`"none"` (it does
  not — it carries only layout and scrollbar-hiding classes).
- **True consequence**: A tablist that owns no tabs, and a focusable keyboard-
  operable splitter that reports no value after ArrowLeft.
- **Evidence**: `TabBar.tsx:118-126`, `:140-156`, `:262`, and `grep -n "role="` over
  the file; `WorkspacePanels.tsx:396-409`.
- **Disposition**: The report's fix is right but insufficient. Moving the "+" and
  the split cluster out is necessary; the *load-bearing* change is putting
  `role="tablist"` on the wrapper at `:123` that actually contains the tabs (or
  giving that wrapper `role="presentation"`), so the tabs are owned. Then add
  `aria-valuenow`/`valuemin`/`valuemax` to `Divider` from `layout.widths[index]`.

### A07-9 — [LOW] Recency text is computed at render time with no ticker

- **Verdict**: **CONFIRMED**
- **Cited location holds?**: Yes. `formatRecency` at `Sidebar.tsx:1951-1960` calls
  `Date.now()` at `:1953`, and it is invoked during `SidebarRowItem` render at
  `:1527`.
- **Reachable in production?**: Yes, on every sidebar row.
- **Trigger**: Leave the rail untouched; a row reading `5m` stays `5m`.
- **Counter-arguments considered**: I looked for a ticker rather than assuming its
  absence — the only timers in the file are the nav hover show/hide delays
  (`:389-390`, `:417`, `:424`, `:445`); there is no `setInterval` and no
  time-derived state. I also checked the report's mitigating claim that the rail
  re-renders on hover, which is true (the hover/pin state machine at `:415-452`
  drives it), so the operator rarely sees a stale value.
- **True consequence**: The subtitle is a render-time artifact. Harmless today; it
  becomes a frozen string the moment `SidebarRowItem` is memoized.
- **Evidence**: `Sidebar.tsx:1527`, `:1951-1960`, `:389-452`.
- **Disposition**: Do nothing now, exactly as the report says. The valuable output
  here is the note itself — record it as a comment on `formatRecency` so a future
  memoization does not silently freeze it.

### A07-10 — [LOW] Raw palette colours bypass the tone tokens the rest of the shell uses

- **Verdict**: **CONFIRMED**
- **Cited location holds?**: Yes. `OrchestratorRoster.tsx:51-55` `COUNT_TONE_CLASS`
  maps to `text-blue-400` / `text-stone-400` (and one token, `text-text-faint`);
  `:129` is `animate-pulse bg-blue-400`; `WorkspacePanels.tsx:296` carries
  `border-[#60a5fa]/25 bg-[#60a5fa]/10 … text-[#93c5fd]`.
- **Reachable in production?**: Yes, but note `WorkspacePanels.tsx:296` is inside
  `PanelHeader`, so that one is split-only.
- **Trigger**: n/a (convention).
- **Counter-arguments considered**: I specifically tested the escalation this
  *could* have been — whether `:296` uses an inline `style={{}}`, which the repo
  forbids outright. It does not: these are static arbitrary-value classes in a plain
  string `className`, statically analyzable and immune to the Tailwind v4 dynamic-
  class trap. The file's only inline style is `:155` (`flexBasis`), which carries an
  explicit `§0 EXCEPTION` comment for data-driven geometry. So the finding is
  exactly the token bypass and no more, which is what the report says.
- **True consequence**: Four spots that a theme change will leave behind.
- **Evidence**: `OrchestratorRoster.tsx:50-55`, `:129`; `WorkspacePanels.tsx:151-155`,
  `:296`.
- **Disposition**: Route through the existing tone tokens. Lowest priority item in
  either report — bundle it with the A07-1 change, which touches the same file.

### A07-C — The four clean bills

Clean bills are as falsifiable as defects, so I re-derived each rather than
accepting them.

**C1 — "zero interpolated Tailwind arbitrary-value classes": HOLDS.** A sweep for
`[${` across the scope's `.tsx` files returns exactly one hit,
`Sidebar.tsx:259`, and it is a comment *warning against* the pattern. Every dynamic
class construction goes through a static map or selects between complete static
strings: `TabBar.tsx:376` → `toneDotClass` (a switch returning whole classes,
`:400-411`); `OrchestratorRoster.tsx:260` → `COUNT_TONE_CLASS[item.tone]` (a
`Record` literal); `Sidebar.tsx:1850` → `NAV_UNFOLD_DELAY` (an array of static
classes). One qualification the report's "zero" phrasing hides: there are two inline
`style={{}}` uses (`Sidebar.tsx:1147` menu anchor px, `WorkspacePanels.tsx:155`
`flexBasis` %), both carrying explicit `§0 EXCEPTION` comments for runtime geometry
Tailwind cannot express. Those are sanctioned, not silent, but "zero" is true of
interpolated *classes*, not of inline styles.

**C2 — "zero user-visible em dashes": HOLDS.** A comment-stripping pass over the
twelve scope files found **162 em dashes, 0 outside comments**, and no `'—'`
no-value placeholder anywhere in scope.

**C3 — "the invented status word-chips are already gone from both the tab and the
sidebar row": PARTIALLY REFUTED.** Visually, yes: the tab renders a bare
`aria-hidden` tone dot (`TabBar.tsx:373-380`) and the sidebar row a live-only
`aria-hidden` dot (`Sidebar.tsx:1717-1724`), with row text reduced to title plus
`time · model`. **But the status word still ships on both surfaces as an
aria-label**: `TabBar.tsx:269` is
``aria-label={`Session ${title}, ${visual.label}…`}`` and `Sidebar.tsx:1574` is
``aria-label={`session ${title}, ${visual.label}…`}``, where `visual.label` is the
full vocabulary from `sessionStatusVisual.ts:47-66` —
`preview | history | starting | live | crashed | disconnected | closed`. This is
deliberate and documented (`TabBar.tsx:370-371`: "The word still reaches assistive
tech through the tab's `aria-label`"), so it is a scope-of-claim gap rather than a
defect — but it materially changes the picture for anyone reading this report to
decide whether the chip-reduction work is finished. It is not, for screen-reader
users. Note the interaction with A07-1: the same vocabulary the panel labels are
faulted for *not* using is itself the invented vocabulary.

**C4 — "the four persistence modules are pure, bounded, self-evicting, and every one
returns the same reference on a no-op": REFUTED on the reference half.** Purity
holds for all four (no `Date.now`/`Math.random`/direct `localStorage`; storage is an
injected `Pick<Storage,…>`; `hiddenAt` is supplied by the caller at
`Sidebar.tsx:1075`; no input mutation). Caps exist and their eviction directions are
correctly opposed to their insertion ends. But I ran the real modules and got four
counterexamples:

```
focusWorkspacePanel(same index)                same ref? false
setWorkspaceWidths(same widths)                same ref? false
resizeWorkspaceDivider(delta 0)                same ref? false
reconcileWorkspaceLayout(no-op)                same ref? false
reduceWorkspaceHidden(identical hiddenAt)      same ref? false
reduceWorkspaceShown(absent cwd)               same ref? true
```

`workspaceLayout.ts:300 workspaceLayoutsEqual` exists precisely *because* the module
does not preserve references, which is internal evidence against the claim. Two
sub-claims survive intact (caps enforced at the storage boundary only, deliberately
and with comments; dangling entries skipped at read time rather than reaped). See
**Missed-2** for the live consequence.

## Findings the original reports missed

**Missed-1 — Raw sidecar diagnostics are rendered verbatim to the user
(`App.tsx:4306`).** This is the exact inverse of A06's HIGH and it is a CLAUDE.md §7
violation. `rawMessageLog.ts:116-122` stores every `ErrorFrame`'s `message` and
`App.tsx:4305-4306` renders it as `text-tone-danger` prose directly above the
composer. The strings the sidecar produces there are engineering vocabulary:
`rate limit exceeded`, `sessionId does not address this sidecar`,
`unexpected key "foo" on settings.setValue`, `missing or wrong protocolVersion`.
`redactErrorMessage` (`sidecarServer.ts:3460-3468`) strips absolute paths and caps
length — it does not translate. The field is also sticky: it clears only on an
`app.ready` frame (`rawMessageLog.ts:100-118`), so the string persists until the
session re-attaches. Fix: keep the raw text in `buildDebugExport`
(`appModel.ts:384`) and render a written sentence at `:4306`.

**Missed-2 — `focusWorkspacePanel` and `setWorkspaceWidths` mint a fresh layout on
every no-op, uncompensated, so every mousedown in the active panel re-renders the
workspace.** `App.tsx:1156` correctly guards the third such path
(`workspaceLayoutsEqual(current, next) ? current : next` around
`reconcileWorkspaceLayout`), which proves the hazard was known. But
`focusWorkspacePanelSession` (`App.tsx:1681-1687`) and `updateWorkspaceWidths`
(`App.tsx:1744-1746`) both call `setWorkspaceLayoutState` with an unconditionally
fresh object. `onFocusPanel` is wired to `onMouseDown` on every panel `<section>`
(`WorkspacePanels.tsx:165`), and mousedown bubbles from the transcript, so clicking
anywhere inside the already-active panel mints a new layout, re-renders `App`, and
recomputes `workspacePanels` for every pane. Fix: either apply the same
`workspaceLayoutsEqual` guard at both call sites, or make the two
`workspaceLayout.ts` functions return `state` on a no-op (preferable — it restores
the property the module's own callers already assume, e.g.
`commitHiddenWorkspaces` at `Sidebar.tsx:566-570`).

**Missed-3 — `allowedByType` (one `Map` plus 30 `Set`s) is reconstructed on every
inbound frame.** `checkStrictKeys` begins at `sidecarServer.ts:3480` and builds the
map at `:3487`, inside the function body. It is called once per inbound frame, so at
the `MAX_FRAMES_PER_WINDOW` ceiling that is 120 map-and-31-set allocations per
second per connection. Bounded and not a correctness issue, but it is free to hoist
to module scope — and A06 reviewed this exact function without noting it.

**Missed-4 — Stale line citation in a production doc-comment.**
`app/main/sessionsCatalogBaseline.ts:16` cites `app/sidecar/sidecarServer.ts:2209`
as the `sessions.snapshot` emitter. That line is now the middle of
`handleSettingsVerb`, and per A06-7 there is no emitter at all. Worth fixing
alongside A06-7 since it is the same dead concept.

## Uncertainty

- **A07-3's premise rests on a first-party comment, not a live trace.** That a
  parked session receives no `lifecycle` frame on close is asserted at
  `App.tsx:1893-1896` and corroborated by the compensating code around it, but I did
  not drive the host to observe the dropped exit. It does not change the verdict
  (the key is retained either way), but a reader wanting the leak's exact size
  should confirm it. Driving `app/host/host.ts` through a park-then-close in a probe
  test would settle it.
- **A06's own "Not reviewed" item about a stale sidecar facing a newer main** is
  still open and still gates whether A06-6 is LOW or MED. I did not read the
  packaging or auto-update path either. Note that `app/sidecar/sessionController.ts`
  — cited in that same section for the `availableMcpServers: []` hard-code — is
  **DIRTY** with another session's uncommitted work, so `:319` may have moved.
