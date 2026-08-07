# X01 — test quality audit

## Verdict

The `app/` suite is, per test, better than most: real engine stores instead of mocks, injectable
clocks, occurrence-counted source guards, `Record<Union, …>` tripwires that make tsc the enforcer,
and probe tests that spawn genuine multi-process sidecars and assert they actually raced. Zero
`mock.module` calls in the whole package — the single biggest reason `bun test app/` is safe to run
whole while `bun test src/` is not. But the **shape** of the suite is badly skewed: 1,800 of 2,754
`test()` call sites are renderer tests, and 752 of those (27% of the entire suite) render React to a
**string** via `renderToStaticMarkup` with no DOM at all. `react-dom/client` is not installed,
`document`/`window` do not exist under `bun test`, and no test in the package dispatches a single
event. Consequently **77 effects, 17 global `addEventListener` registrations, and ~274 inline event
handlers in production renderer code are never executed by anything**. That is the single most
important thing to fix, and it is a tooling decision (a DOM harness), not a test-writing one.

The second-order damage is that the suite has learned to test what it *can* reach instead of what
matters: 15 tests in `App.test.tsx` grep `App.tsx`'s own source text with ~103 string assertions,
and three files ship a test whose only assertion is the key list of an object literal declared two
lines above it. Meanwhile the trust boundary's rate cap, the `account.rename` verb, and the only
code that actually calls `createFork`/`saveCustomTitle` have no test at all.

## Findings

### [HIGH] The renderer's React layer has zero executable coverage — 27% of the suite is SSR strings

- **Where**: all 41 files matching `app/renderer/src/*.test.tsx`; harness fact documented in-source
  at `app/renderer/src/AccountsPage.test.tsx:25-36`
- **Type**: correctness (coverage)
- **What**: Every one of the 41 renderer component test files imports `react-dom/server` and asserts
  on the returned HTML string. Verified: **0 files** import `react-dom/client`, `createRoot`, or
  `hydrateRoot`; **0 files** call `dispatchEvent`, `fireEvent`, or `act()`. `AccountsPage.test.tsx`
  states the reason plainly: "This package has NO DOM test harness — `bun test` exposes no
  `document`/`window`, `react-dom/client` is not installed, and neither `@testing-library/react` nor
  happy-dom/jsdom is a dependency (adding one needs sign-off)."
- **Trigger / why it matters**: `renderToStaticMarkup` runs render functions only. Measured against
  production `app/renderer/src` (50 `.tsx` + 86 `.ts`, excluding tests), that leaves structurally
  unreachable:

  | Behavior class | Production count | Executable coverage |
  |---|---|---|
  | `useEffect` bodies | 73 | 0 |
  | `useLayoutEffect` bodies | 4 | 0 |
  | global `window`/`document.addEventListener` | 17 | 0 |
  | inline handlers (`onClick` 178, `onKeyDown` 30, `onChange` 25, `onBlur` 7, `onDrop` 6, `onFocus` 5, `onSubmit` 5, others 18) | ~274 | 0 via events |
  | focus movement / focus trapping | `.focus()` call sites across overlays | 0 |
  | scroll & measurement (`scrollIntoView` 2, `scrollTop` 4, `scrollHeight` 4, `getBoundingClientRect` 8) | 18 | 0 |
  | `requestAnimationFrame` sequencing | 4 | 0 |
  | selection / caret (`getSelection`) | 2 | 0 |
  | real `document.` / `window.` references | 30 / 76 | 0 |

  The two shipped bugs already established by the file-scoped reviews are exactly this class, and
  the harness could not have caught either:

  1. `app/renderer/src/AskQuestionFlow.tsx:150` — `if (target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA') return`.
     The composer is a `contentEditable` **div** (`app/renderer/src/ComposerInput.tsx:325`), so the
     guard never fires and typing into the composer sends Escape→deny and Enter→submit to the engine.
     The sibling that got it right is one file over: `app/renderer/src/PermissionPrompt.tsx:55`
     ends its check with `return (element as HTMLElement).isContentEditable === true`. **The suite
     cannot tell the two apart** — the listener is registered inside an effect
     (`AskQuestionFlow.tsx:199`) that SSR never runs. `AskQuestionFlow.test.tsx:43-47` says so
     itself: "the window keydown handler … is NOT exercised here."
  2. Global ⌘-shortcuts firing while a modal is open (retargeting the metadata inspector) — the
     listener lives at `App.tsx:2353` inside an effect. Same reason.

  These are not two unlucky bugs; they are the two that happened to be *noticed*. Every one of the
  17 global listeners and 77 effects carries the same exposure.
- **Fix**: install a DOM harness (happy-dom is the cheapest; it needs the sign-off the comment
  refers to) and convert the highest-risk surfaces first — the four files that register global
  keydown listeners (`AskQuestionFlow.tsx`, `TasksDialog.tsx:183`, `PermissionPrompt.tsx:290`,
  `App.tsx:2353`) plus `overlayFocus.ts`'s two. Nothing else in this report buys as much.

### [HIGH] The trust boundary's own rate cap (T7) has no test

- **Where**: `app/sidecar/sidecarServer.ts:3409-3417` (`checkRate`), called at `:789`
- **Type**: security
- **What**: `MAX_FRAMES_PER_WINDOW` (120) / `RATE_WINDOW_MS` (1,000) are enforced at the sidecar —
  the trust boundary — and nothing tests it. `sidecarServer.test.ts` imports `MAX_FRAME_BYTES` but
  never `MAX_FRAMES_PER_WINDOW`; grep for `checkRate`, `rate_limited`, or `MAX_FRAMES_PER_WINDOW`
  across every `app/**/*.test.ts` returns only `app/preload/rendererIpcGuard.test.ts`.
- **Trigger / why it matters**: the preload guard is defence-in-depth by the repo's own doctrine
  ("Everything is validated at the sidecar (the trust boundary), never at the preload",
  `protocol.ts:42-43`). A compromised renderer bypasses the preload entirely by writing frames to
  the socket. Delete the `if (!this.checkRate(connection))` branch at `:789` and the whole suite
  stays green — the T7 flood cap is currently a comment. `checkRate` also uses a raw `Date.now()`
  with no injectable clock, so a test would need one added; that is the actual work.
- **Fix**: add the injectable clock `rendererIpcGuard` already has (`createRendererIpcGuard({ now })`
  is the in-repo pattern) and port `rendererIpcGuard.test.ts:18-31` verbatim against `SidecarServer`.

### [HIGH] `account.rename` has no boundary test in either direction

- **Where**: `app/sidecar/sidecarServer.ts:3504` (strict-key entry), `:3682-3687` (Zod schema);
  `app/sidecar/sidecarServer.test.ts` — **zero** occurrences of `'account.rename'`
- **Type**: security
- **What**: I enumerated all 30 inbound message types and grepped the boundary suite for each.
  `account.rename` is the only one with **neither** an accept-valid **nor** a reject-invalid test.
  The generic strict-key test (`sidecarServer.test.ts:4295`) and the generic schema test (`:4311`)
  both use `account.switch`, and `checkStrictKeys` is a **per-type `Map`** (`:3487-3552`), so
  exercising one entry proves nothing about another. The only `account.rename` tests in the repo
  are three domain-level calls at `app/sidecar/accountsDomain.test.ts:487,495,505` — below the
  boundary, with the frame already parsed.
- **Trigger / why it matters**: `alias` is the one renderer-authored *string* on the account verbs
  and it is bounded by `accountAliasSchema` at `:3686`. Delete that bound, or delete
  `['account.rename', …]` from the strict-key map (making the Zod object silently *strip* extra keys
  rather than reject them, which is the exact failure mode F10 exists to prevent), and 2,799 stays
  green.
- **Fix**: three tests mirroring the `account.switch` trio — valid rename reaches the domain, extra
  key rejected `bad_request`, over-long alias rejected.

### [HIGH] The registry concurrency test documents the lost update instead of catching it

- **Where**: `app/host/registry.test.ts:940-970`
- **Type**: correctness (vacuous test)
- **What**: The test is named "atomic writes under a simulated concurrent writer never produce torn
  JSON". It creates two `SessionRegistry` instances over one file, interleaves 50 `upsertOnSpawn`
  calls, then asserts only: `doc.registryVersion` is right, `doc.sessions` is an array, and each row
  has a string `appSessionId` and `cwd`. It **never asserts `doc.sessions.length`**.
- **Trigger / why it matters**: `persist()` (`app/host/registry.ts:892-932`) writes `this.doc`
  wholesale under the lock and **never re-reads the file first**; `upsertOnSpawn`
  (`registry.ts:660+`) mutates only the instance's in-memory doc. So after this test, registry A's
  doc has 25 rows and B's has 25, and the file holds whichever wrote last — **25 rows, not 50**.
  Half the writes are gone and the test passes. Worse, every asserted property is guaranteed by
  `atomicWriteJson`'s temp-file + `renameSync` (`registry.ts:1033-1068`) alone: **remove the
  advisory lock entirely and this test still passes**, because `rename` is atomic on POSIX. The
  comment at `:951` states "last-writer-wins" as if it were the intended contract, which is how a
  reviewer reading only the test concludes the case is covered.
- **Fix**: change the assertion to `expect(doc.sessions).toHaveLength(50)`. It will fail, and that
  failure is the bug (read-merge-under-lock is the fix). If lost-update genuinely is accepted for
  now, rename the test to say so ("concurrent writers do not tear the file; the loser's rows are
  lost — see …") so it stops reading as coverage.

### [HIGH] The only code that touches the real engine ops for session actions is untested

- **Where**: `app/sidecar/sessionActionsDomain.ts:82-124` (`createRealSessionActionsExecutor`)
- **Type**: correctness (coverage)
- **What**: Two test layers, two fakes, zero real path. `app/sidecar/sessionActionsDomain.test.ts`
  injects a `fakeExecutor` and says so in its header ("The engine-op round-trip (saveCustomTitle /
  renderMessagesToPlainText / createFork) is not re-proven here"). One layer up,
  `sidecarServer.test.ts:5927-5946` injects a fake **domain** — so the boundary tests never even
  reach the real domain, let alone the real executor. Grep confirms `createRealSessionActionsExecutor`
  appears in exactly one place outside its own definition: `sessionActionsDomain.ts:146`.
- **Trigger / why it matters**: the branch path is a four-step real-engine sequence —
  `createFork()` → find first user message → `` `${deriveFirstPrompt(firstUser)} (Branch)` `` →
  `saveCustomTitle(fork.sessionId, title, fork.forkPath, 'user')`. Break any of it (wrong id, wrong
  transcript path, `deriveFirstPrompt` returning undefined) and the user gets an ack frame saying
  "Branched." for a fork that is unnamed, mis-titled, or written against the parent's transcript
  path. Nothing fails. This is CLAUDE.md §8 mistake #1 (stub context instead of the engine's real
  context) with the stub in the test rather than the product.
- **Fix**: one probe test in the `resumeSeed.probe.test.ts` / `spawnConfig.probe.test.ts` idiom —
  mint a transcript in a temp `CLAUDE_CONFIG_DIR`, run the real executor, assert a fork file exists
  with the derived title. The infrastructure for this already exists in the probe helpers.

### [HIGH] Three tests assert the key list of an object literal declared two lines above them

- **Where**: `app/renderer/src/extensionsState.test.ts:46-60`,
  `app/renderer/src/sessionsCatalogState.test.ts:57-70`,
  `app/renderer/src/agentConfigState.test.ts:70-92`
- **Type**: quality (vacuous test)
- **What**: The pattern is:

  ```ts
  const RENDERED_EXTENSIONS_SLICES: Record<keyof ExtensionsSnapshot, true> = {
    mcp: true, plugins: true, skills: true, hooks: true,
  }
  test('every extensions slice on the wire has a panel that renders it', () => {
    expect(Object.keys(RENDERED_EXTENSIONS_SLICES).sort()).toEqual(['hooks','mcp','plugins','skills'])
  })
  ```

  The `Record<keyof X, …>` annotation **is** a real tripwire and tsc enforces it — adding a wire
  slice without a key here fails the typecheck. That is good and should stay. The `test()` block is
  pure ceremony: it asserts a literal's own keys against a hand-copied list of the same keys. It can
  only fail if someone edits one half and not the other, in the same file, three lines apart.
- **Trigger / why it matters**: not the wasted execution — the **name**. None of these three files
  references a panel, a component, or a consumer. Delete every extensions panel from the renderer
  and all three stay green while claiming "every extensions slice on the wire has a panel that
  renders it". A reader auditing coverage will count these as evidence they are not.
- **Fix**: delete the three `test()` blocks and keep the typed constants. If the panel claim is
  worth pinning, the check has to be a grep for the consuming component (the
  `mainSourceGuards.test.ts` region idiom) or a render assertion, not the literal's own keys.

### [HIGH] `hardening-smoke` 19/19 covers no sidecar, and three of its XSS checks can report PASS vacuously

- **Where**: `app/scripts/hardening-smoke.ts:196-200, 227-229, 294-296, 391`;
  runner `app/scripts/run-hardening-smoke.ts:68-73`
- **Type**: security (test integrity)
- **What**: Three separate problems in the one artifact the repo treats as its security gate.
  1. **Zero frames reach a sidecar.** Every crafted frame is injected with
     `window.webContents.send(CH_SERVER_FRAME, …)` (`:192, :199, :207`), i.e. the harness *plays*
     main. It exercises renderer + preload + CSP + navigation + window-open. It exercises **none**
     of `sidecarServer.ts`'s inbound validation, which is where the security baseline actually
     lives. "hardening 19/19" and "the inbound allowlist is enforced" are unrelated claims.
  2. **Three vacuous checks.** `markdownScriptRan`, `markdownImgRan`, `markdownLinkRan` (`:227-229`)
     read `window.__MARKDOWN_*_RAN === true`. Those globals are undefined unless the crafted Markdown
     both rendered *and* executed, so if the frame never reaches the transcript all three report
     `PASS`. They are contained (check #1, `markerRendered`, fails and the run exits 1), but the
     printed line for each says PASS, and the containment is one assertion deep.
  3. **`app.exit()` at `:391`** terminates Electron without tearing down the real startup session's
     sidecar. `run-hardening-smoke.ts` also caps the child at `timeout: 20_000`. The repo ships
     `app/scripts/reap-orphan-sidecars.ts` specifically to clean up after this class of exit, which
     is confirmation, not mitigation.
- **Trigger / why it matters**: the concrete cost of (3) is a ~230 MB orphan per hardening run on a
  machine that also hosts the operator's live dev app. The concrete cost of (1) is that a reviewer
  who reads "test:hardening 19/19" as evidence for the T4–T7 inbound baseline is reading it wrong.
- **Fix**: rename the artifact to what it covers (renderer/CSP/preload hardening); make the three
  Markdown checks assert the payload was *present in the DOM and inert* rather than that a global is
  absent; replace `app.exit()` with a `BrowserWindow.close()` + `app.quit()` so main's own teardown
  runs.

### [MED] `App.test.tsx` spends 15 of its 51 tests grepping `App.tsx`'s source text

- **Where**: `app/renderer/src/App.test.tsx` — 15 `readFileSync(new URL('./App.tsx' …))` sites,
  ~103 `expect(source…).toContain(…)` assertions; e.g. `:149-151`, `:162-167`, `:217-219`
- **Type**: quality (restates the implementation)
- **What**: These pin exact code strings, including whitespace and nesting:
  `expect(preloadBody).toContain('window.requestAnimationFrame(() => {\n      timer = window.setTimeout(() => {')`.
  Any reindent, any rename of `preloadReservedBytesRef`, any change from `useCallback` to a plain
  function breaks a test with behavior unchanged.
- **Trigger / why it matters**: this is the tax the SSR-only harness levies, and the file is
  admirably honest about it ("LAYER HONESTY: … App cannot be mounted and none of these effects can
  be executed here … It therefore only asserts things source text can actually decide"). It is still
  net-negative maintenance: 103 assertions that must be edited for refactors they should not care
  about, and that prove text exists rather than that code runs. Note the same author's discipline
  elsewhere — `mainSourceGuards.test.ts` (see "What is good") deliberately deleted ~40 of exactly
  these and kept only *absence* claims, because absence is the one thing a grep proves honestly.
- **Fix**: do not rewrite them now. Apply `mainSourceGuards.test.ts`'s rule to the file — keep the
  region-anchored *absence* and *ordering* assertions, drop the "this call site exists" positives —
  and retire the rest as the DOM harness lands.

### [MED] `secretGuard.test.ts` closes with an assertion on an object the test just built

- **Where**: `app/shared/secretGuard.test.ts:141-160`
- **Type**: quality (vacuous test)
- **What**: The test builds a `projected` literal, runs `scanForSecrets(projected)` (real, fine),
  then asserts `expect(Object.keys(projected).sort()).toEqual(['kind','result','status','summary','toolUseId','usage'])`.
  The second assertion re-states the literal on the previous ten lines.
- **Trigger / why it matters**: the comment says the point is that the projection carries
  `result`/`usage`/`toolUseId` and no longer carries `taskId`/`outputFile` — a claim about
  **production** code (the task-notification projection). The test asserts it about a **fixture**.
  Add `outputFile` back to the real projection and this stays green. The rest of this file is the
  best security unit test in the package; this one assertion is the exception.
- **Fix**: import the real projection function and scan its output, or delete the key assertion and
  keep only `expect(scanForSecrets(projected).ok).toBe(true)`.

### [MED] `as unknown as` casts in reducer tests disable the type tripwire they sit next to

- **Where**: 28 occurrences across 14 renderer test files; worst offenders
  `previewTranscriptState.test.ts` (7), `sessionActionRuntimeState.test.ts` (3),
  `overlayFocus.test.ts` (3). Example: `sessionActionRuntimeState.test.ts:80, :92, :101`
- **Type**: quality
- **What**: `sessionActionRuntimeState.test.ts` builds a perfectly valid `LifecycleFrame`
  (`{kind:'lifecycle', protocolVersion, sessionId, status:'disconnected'}` — matches
  `protocol.ts:2288-2297` exactly) and then casts it `as unknown as ServerFrame` anyway. The same
  for a valid `pong` frame at `:101`.
- **Trigger / why it matters**: the repo's stated design is that closed unions are policed by tsc
  (`Record<Union,…>` tables, `default: const _x: never = …`). An `as unknown as` in a test that
  consumes a union is the one thing that switches that off: add a required field to `LifecycleFrame`
  and every one of these fixtures silently keeps compiling with the field missing, so the reducer is
  tested against a frame shape that can no longer occur. The contract's "zero `as` casts in
  projector-style code" applies to the tests that guard the projector too.
- **Fix**: drop the casts where the literal is already valid (most of them); where it is not, the
  cast is hiding a real mismatch and should be fixed rather than suppressed.

### [MED] The context-breakdown freshness-floor test only ever sees a successful analysis

- **Where**: `app/sidecar/contextBreakdownBoundary.test.ts:133-157`, fixture `countingDomain()` at
  `:~90-104`
- **Type**: correctness (coverage)
- **What**: `countingDomain()` always returns `BREAKDOWN`. Every one of the six tests in the file
  uses it. The floor test proves five requests inside the window are answered from one analysis —
  on the success path only.
- **Trigger / why it matters**: the untested branch is what happens to the floor when the analysis
  **fails**. If a failed analysis still arms the floor, the panel is stuck showing (or showing
  nothing for) the freshness window with no way to retry; if a failure leaves the coalescing latch
  set, subsequent requests are dropped silently. Neither is observable today.
- **Fix**: a seventh test with a domain whose first call rejects — assert an error frame is sent and
  the *next* request re-runs the analysis.

### [MED] `preloadBundle.test.ts` runs a full Electron build inside a unit test

- **Where**: `app/preload/preloadBundle.test.ts:6-10`
- **Type**: quality (determinism)
- **What**: `spawnSync('bun', ['run', 'scripts/build-electron.ts'])` inside `test()`. It writes
  `app/preload/preload.cjs`, `app/preload/preload.dev.cjs`, and `app/main/main.js` into the working
  tree as a side effect of `bun test app/`.
- **Trigger / why it matters**: three costs. (a) It mutates the repo during a read-only-looking
  command, on a tree the CLAUDE.md says is shared with concurrent sessions. (b) It is the slowest
  single test in the package and its result depends on the build toolchain, not on the code it
  claims to test. (c) It creates an implicit ordering contract — any later test reading those
  artifacts depends on this one having run first, which `bun test`'s file order does not guarantee.
- **Fix**: move it to `run-hardening-smoke.ts`, which already builds both bundles at `:41-47` and is
  the right place for a build-artifact assertion.

### [MED] Why the account suites only pass file-isolated: `mock.module` is process-global and irreversible

- **Where**: `src/codex-core/accounts.test.ts:77-115` (13 `mock.module` calls);
  `src/codex-core/accountRefreshContention.probe.test.ts`; 26 `src/**` test files total.
  **`app/` has zero.**
- **Type**: correctness (determinism)
- **What**: Bun's `mock.module` patches the process-wide module registry. `bun test` loads all
  matched files into one process, so a file that mocks `../services/api/codexAccountPool.js` changes
  what every *later-loaded* file imports. `accounts.test.ts` tries to undo it (`:76-86`) by
  re-mocking with `{ ...realPoolModule }` — a **plain-object snapshot** of the exports taken in
  `beforeEach` — then calling `mock.restore()`. That restores *values*, not the live module record:
  any module that already captured a binding during the mocked window keeps the mock, and later
  files get a frozen copy rather than the real module. `codexAccountPool`'s in-memory pool state
  (`resetCodexAccountPoolForTest`, `seedCodexAccountPoolForTest`) compounds it.
- **Trigger / why it matters**: this is the whole mechanism behind CLAUDE.md's "some suites (Codex
  account suites) only pass file-isolated". The affected set is the 26 `src/**` files using
  `mock.module`, with `src/codex-core/accounts.test.ts` (13), `src/components/Settings/Settings.test.tsx`
  (13), `src/components/Settings/Usage.test.tsx` (12) and `src/hooks/useDeferredContinuation.test.ts`
  (8) the heaviest. `app/`'s dependency-injection style (`{ executor }`, `{ acquireLock }`,
  `{ now }`) is precisely the reason `bun test app/` is safe as one command — that is a genuine
  architectural win worth stating out loud.
- **Fix**: nothing in `app/`. In `src/`, treat `mock.module` as a file-isolation marker: any file
  using it needs its own `bun test <file>` line in the routing table, and new tests should prefer
  the injection style `app/` uses.

### [MED] `makeServer(…, undefined ×11, domain)` makes the boundary suite fragile by position

- **Where**: `app/sidecar/sidecarServer.test.ts:5931-5944` (and ~8 similar call sites)
- **Type**: quality
- **What**: The session-actions server is built by passing eleven consecutive `undefined`s to reach
  the twelfth positional domain slot.
- **Trigger / why it matters**: this is the test helper for the file that is the security gate.
  Insert a new domain parameter anywhere in `makeServer`'s signature and every one of these call
  sites silently binds its domain to the wrong slot — the tests keep passing (a missing domain
  fails closed to `internal_error`, and several tests assert exactly that), while the tests that
  were supposed to exercise a real domain quietly stop doing so.
- **Fix**: one options object. `makeServer({ controller, sessionActions })`.

### [MED] `effort.set` has no schema-level reject test

- **Where**: `app/sidecar/sidecarServer.ts:3526` (strict-key entry), `:3800-3804` (Zod);
  `sidecarServer.test.ts` — `'effort.set'` appears twice, both accept-path
- **Type**: security
- **What**: `model.set` gets a non-string reject (`:2462`), `fast.set` gets a non-boolean reject
  (`:2481`), `effort.set` gets neither. `:2433` ("a well-typed unsupported effort returns a
  correlated failed result") is a *domain* outcome on a frame that already passed the schema. `:2519`
  ("rejects a run-control verb carrying an unexpected key") uses a different verb, and `checkStrictKeys`
  is per-type.
- **Fix**: one test — `{type:'effort.set', requestId:'r', effort: 42}` → `bad_request`, no domain call.

### [LOW] `AskQuestionFlow.test.tsx:69` asserts the HTML contains the digit `1`

- **Where**: `app/renderer/src/AskQuestionFlow.test.tsx:68-69`
- **Type**: quality (vacuous assertion)
- **What**: `// Numbered pick affordance (option 1 badge, cursor starts at row 0).` followed by
  `expect(html).toContain('1')`. The rendered markup contains `id="ask-question-perm-1"` from the
  test's own `requestId="perm-1"`, so the assertion is satisfied before any badge is rendered.
- **Fix**: `expect(html).toContain('>1<')` — the file already uses that exact idiom correctly three
  tests later (`:84`, `:103`).

### [LOW] `backpressuredSocket.probe.test.ts` silently passes if the Bun global is missing

- **Where**: `app/sidecar/backpressuredSocket.probe.test.ts:17`
- **Type**: quality
- **What**: `if (!BunRt?.listen) return` — an early return with zero assertions reported as a pass.
  Cannot trigger under `bun test`, so the risk is theoretical; noted because the same file is
  otherwise the *best* anti-vacuity example in the repo (`expect(drainCalls).toBeGreaterThan(0)` at
  `:80` explicitly proves the test exercised what it claims to).
- **Fix**: `test.skipIf(!BunRt?.listen)`, so a skip prints as a skip.

### [LOW] `limits.ts` cites the wrong file as enforcing the replay alignment invariant

- **Where**: `app/shared/limits.ts:120` — "Enforced by test (historyReplay.test.ts)"
- **Type**: convention (doc drift)
- **What**: The invariant (`MAX_HISTORY_REPLAY_*` strictly below `DEFAULT_MAX_BUFFERED_*`) **is**
  enforced, at `app/main/historyReplayReload.test.ts:59-60`. `app/sidecar/historyReplay.test.ts`
  never imports either `DEFAULT_MAX_BUFFERED_*` constant.
- **Trigger / why it matters**: a maintainer following the citation finds no such assertion and
  reasonably concludes the invariant is unguarded (or, worse, adds a duplicate).
- **Fix**: one-word correction to the comment.

### [LOW] `permissionDomain.test.ts:99` is dead after the throw above it

- **Where**: `app/sidecar/permissionDomain.test.ts:96-99`
- **Type**: quality
- **What**: `if (exitCode !== 0) { throw new Error(...) }` immediately followed by
  `expect(exitCode).toBe(0)`. The throw is the assertion; the `expect` can never fail. Harmless, but
  it makes the subprocess probe look like it has an assertion when the real check is the throw.

## Correction to a lead I was given

`app.abort` **does** have a reject-direction boundary test:
`app/sidecar/sidecarServer.test.ts:381` ("T7 — rejects an app.abort reason over the text cap (no
abort)"), which asserts both the `bad_request` frame and `aborts === 0`. The accept path is at
`:347`. The test's own comment at `:348-349` records that it "had no boundary test in either
direction" — past tense; the gap was closed. Both directions are now covered.

## Boundary-test coverage table

All 30 inbound message types reachable via `SidecarClientMessage` (`app/shared/protocol.ts:474-487`
plus the engine's `appClientMessageSchema` vocabulary), checked against
`app/sidecar/sidecarServer.test.ts` and `app/sidecar/contextBreakdownBoundary.test.ts`.

| Inbound type | Accept-valid | Reject-invalid | Note |
|---|---|---|---|
| `app.submit` | ✅ `:865`, `:5761` | ✅ `:327` T7, `:1448`/`:1200` T4, `:3468` F10, `:5727` untrusted cwd, `:5782` null trust | strongest |
| `app.abort` | ✅ `:347` | ✅ `:381` | lead corrected |
| `app.ping` | ✅ `:318` | ✅ `:335` | |
| `permission.response` | ✅ `:2608`, `:2638`, `:3628` | ✅ `:2566` T5a, `:2577` T6, `:2671` T6b, `:2834`/`:2865`/`:2896`/`:2936` C1, `:3486`, `:3607` | strongest |
| `permission.setMode` | ✅ `:3837`, `:3912`, `:3984` | ✅ `:4015`, `:4039`, `:3947` | |
| `askUserQuestion.answer` | ✅ `:3089`, `:3128` | ✅ `:3148`–`:3434` (13 tests) | strongest |
| `account.switch` | ✅ `:4241`, `:4564` | ✅ `:4295`, `:4311`, `:4610` | |
| **`account.rename`** | ❌ **none** | ❌ **none** | **HIGH — see finding** |
| `account.delete` | ⚠️ none (only the reject) | ✅ `:4327` confirm-required | accept path unproven |
| `account.logout` | ⚠️ indirect only | ⚠️ generic only | thin |
| `account.touchAll` | ⚠️ indirect only | ⚠️ generic only | thin |
| `account.login` | ✅ `:4370`, `:4396` | ✅ `:4453`, `:4481` | |
| `account.oauthPasteCode` | ✅ `:4630` | ✅ `:4703` | |
| `account.oauthAlias` | ✅ `:4630` | ✅ `:4682` | |
| `account.oauthCancel` | ✅ `:4517` | ✅ `:4542` | |
| `workspace.trust` | ✅ `:5597`, `:5636` | ✅ `:5667` HC1, `:5699` | |
| `remoteSettings.bridgeToggle` | ✅ `:4748`, `:4777` | ✅ `:4940` | |
| `remoteSettings.directConnect` | ✅ `:4804`, `:4841` | ✅ `:4878` T3, `:4966` | |
| `settings.setValue` | ✅ `:5026`, `:5061`, `:5200`, `:5308` | ✅ `:5090`, `:5114`, `:5141`, `:5229`, `:5263`, `:5354` | strongest |
| `agent-mode.set` | ✅ `:1742`, `:1788` | ✅ `:1812`, `:1831`, `:1850` | |
| `task.stop` | ✅ `:1915`, `:2047` live | ✅ `:1969`, `:1988`, `:2007` | |
| `model.set` | ✅ `:2248`, `:2313` | ✅ `:2462`, `:2500`, `:2519` | |
| **`effort.set`** | ✅ `:2373` | ❌ **no schema reject** | MED — see finding |
| `fast.set` | ✅ `:2373` | ✅ `:2481` | |
| `session.rename` | ✅ `:5951` | ✅ `:6086`, `:6108` | fake domain (see HIGH) |
| `session.export` | ✅ `:5981` | ✅ `:6131` | fake domain |
| `session.branch` | ✅ `:6061` | ✅ `:6154` | fake domain |
| `session.tag` | ✅ `:6180`, `:6208` | ✅ `:6232`, `:6255` | fake domain |
| `context-breakdown.request` | ✅ `contextBreakdownBoundary.test.ts:108` | ✅ `:160`, `:188` | different file |
| `app.park` | ✅ `:540` | ✅ `:552`, `:570` | plus 8 gate tests |

Cross-cutting rejects that apply to all types: wrong `protocolVersion` `:292`, wrong `sessionId`
`:301`, unallowlisted type `:310`, prototype-name type (`constructor`) `:3590`.

**HIGH: `account.rename`.** **MED: `effort.set`**; `account.delete` accept, `account.logout` /
`account.touchAll` (only reachable through generic tests that use a *different* type against a
per-type key map).

## Concurrency / probe tests

Twelve `*.probe.test.ts` files. They genuinely spawn processes — these are not sequential tests
wearing a concurrency label.

| Probe | Genuinely races? | Evidence |
|---|---|---|
| `spawnConfig.probe.test.ts:419` | ✅ | Two real sidecars spawned, both awaited to `ready` **before** the signal (a deterministic barrier, not a sleep), then `process.kill(pidA,'SIGKILL')` on an owned pid; survivor proven live by a framed ping round-trip, not by a status field. |
| `spawnConfig.probe.test.ts:375` | ✅ | Two sidecars at different cwds; the negative arm asserts a distinguishable exit code (4) **and** rejects if a `ready` frame ever appears — so a silent Potemkin restore fails loudly. |
| `backpressuredSocket.probe.test.ts` | ✅ | Real Bun unix socket, 3 MB frame forcing the drain loop, and an explicit anti-vacuity assertion `expect(drainCalls).toBeGreaterThan(0)` (`:80`). The model for how to write these. |
| `accountsPoolWorker.probe.test.ts` | ✅ | Real subprocess; `assertHermeticHome()` (`:81-91`) mirrors the production vault-path formula and **throws** if the fake `HOME` could ever collide with the real one — an enforced isolation invariant instead of a comment. |
| `resumeSeed` / `restoreAntiPotemkin` / `subagentRestore` / `transcriptBackfillWorker` / `sessionsCatalogWorker` / `idleTtl` / `lifetimeChain` / `idleParkLifecycle` | ✅ | All spawn real processes against temp `CLAUDE_CONFIG_DIR`s with explicit timeouts and readiness barriers. |

**Vacuous-under-contention:** the one test that *names* contention and does not test it is not a
probe at all — `app/host/registry.test.ts:940` (HIGH above). It is also in-process (two objects in
one process), so it does not model the DR-2 cross-process scenario its comment cites.

## Determinism

- **No real network anywhere.** Every URL in the suite is a fixture string or `localhost:5173` in a
  pure policy test. `accountsPoolWorker.probe.test.ts:26-29` explicitly documents *why* the worker
  makes zero HTTP requests (zero accounts loaded → nothing to fetch usage for).
- **No fake timers anywhere in `app/`** — and that is deliberate, not an oversight. The house
  pattern is an injectable clock: `createRendererIpcGuard({ now: () => now })`
  (`rendererIpcGuard.test.ts:20`), `h.setNow(h.now() + SPAWN_RATE_WINDOW_MS + 1)` (`host.test.ts:618`).
  Where that pattern is applied, timing tests are fully deterministic. Where it is not —
  `SidecarServer.checkRate` (`sidecarServer.ts:3410` uses a bare `Date.now()`) — there is no test at
  all (HIGH above). The absence of a clock seam and the absence of a test are the same fact.
- **Real `setTimeout` sleeps**: 18 in `sidecarServer.test.ts` (mostly `flush()` =
  `setTimeout(…, 0)`, which is a microtask drain, not a wall-clock wait — fine), 7 in
  `spawnConfig.probe.test.ts`, 5 in `supervisor.test.ts`. Probe timeouts are generous (45–180 s) and
  paired with readiness barriers rather than fixed sleeps, so these are slow rather than flaky.
- **Filesystem**: 25 files use `mkdtempSync(join(tmpdir(), …))`. `settingsDomain.test.ts` and
  `sessionController.test.ts` mutate `process.env.CLAUDE_CONFIG_DIR` but both save/restore correctly
  (`settingsDomain.test.ts:289-301` `afterEach`; `sessionController.test.ts:88-109` try/finally).
  Two exceptions worth noting: `backpressuredSocket.probe.test.ts:19` writes to
  `/tmp/catcode-bp-probe-${process.pid}.sock` directly (pid-scoped, so collision-safe), and
  `preloadBundle.test.ts` writes build artifacts into the repo tree (MED above).
- **Inter-file order dependence in `app/`: none found**, because `app/` uses zero `mock.module` and
  zero module-level global mutation outside the guarded env cases above. The only ordering coupling
  is the `preloadBundle.test.ts` build artifact.
- **Inter-file order dependence in `src/`: real and structural** — the `mock.module` mechanism
  described in the MED finding. That is the file-isolation answer the prompt asked for.

## What is good here — copy these

- **`app/preload/preloadSource.test.ts:92`** — `expect(source.match(/sendGuard\.assertAllowed/g)).toHaveLength(29)`.
  An *occurrence count*, not a presence check: adding a 30th sender without guarding it fails, which
  a `toContain` never could. `:126-144` goes further and extracts every `ipcRenderer.invoke(X)`
  argument and asserts each is in a `CH_HOST_*` allowlist. `:150-152` strips comments before the
  negative checks so prose describing a forbidden pattern cannot trip it. This is how to write a
  source-text test that is worth its maintenance cost.
- **`app/main/mainSourceGuards.test.ts:4-26`** — the header explains why the file deliberately
  *deleted* ~40 assertions: "A grep proves nothing in the other direction. Asserting that main's
  source CONTAINS a call proves the text exists: not that it runs… The call could sit inside
  `if (false)`". It keeps only absence claims, ordering claims (`:102-104`), and occurrence counts
  (`:91`), and its `region()` helper **throws** rather than asserts when an anchor moves, so a
  relocated region fails loudly instead of narrowing to an empty string that satisfies every `not`.
  Apply this rule to `App.test.tsx`.
- **`app/main/replayBuffer.ts:101` + `replayBuffer.test.ts:272`** — `FRAME_RETENTION:
  Record<ServerFrame['kind'], FrameRetention>` makes tsc fail when the protocol union grows, and the
  test then cross-checks the *derived production* `STICKY_FRAME_KINDS` against a *test-local*
  `ATTACH_BURST_KINDS`. Two independently-authored lists compared against each other is a real
  drift alarm — the opposite of the three vacuous slice tests above, which compare a literal to
  itself.
- **`app/sidecar/backpressuredSocket.probe.test.ts:78-80`** — an explicit anti-vacuity assertion
  (`drainCalls > 0`) proving the test exercised the mechanism it names. Every probe should carry one.
- **`app/sidecar/accountsPoolWorker.probe.test.ts:73-91`** — `assertHermeticHome()` re-derives the
  production vault-path formula and throws if the fake `HOME` could collide with the real one, so
  isolation is an enforced invariant rather than a claim in a comment. The file also documents *why*
  a negative counterpart deliberately does not exist (`:152-159`) — the right way to record a gap.
- **`app/sidecar/permissionDomain.test.ts:28-40`** — "setMode runs the REAL engine transition, not a
  bare mode assignment", asserting `prePlanMode` is cleared. A discriminating assertion: it fails if
  someone swaps the engine idiom for an equivalent-looking shortcut. Built on the engine's real
  `createStore`, not a fake.
- **`app/renderer/src/tabStatus.test.ts:104-113`** — every tricky case has a paired **control**
  ("a crash is still a crash — the same descriptor without the parked connection"). Pinning both the
  positive and its near-miss is what makes the distinction real rather than incidental.
- **`app/renderer/src/userVisibleText.test.ts` and `fastRefreshBoundaries.test.ts`** — repo-wide
  sweeps that replace per-file discipline nobody remembers with one test that cannot be forgotten.
  `userVisibleText.test.ts:39-46` even states its own known limits.
- **Dependency injection over `mock.module`, package-wide.** `{ executor }`, `{ acquireLock }`,
  `{ now }`, `{ log }` — zero global module patching in 359 `app/` tests. This is why `bun test app/`
  is one safe command.

## What "2799 pass / 0 fail" licenses a reader to claim

**It licenses this.** The inbound wire boundary is genuinely well guarded: 28 of 30 message types
have both an accept-valid and a reject-invalid test at the sidecar, including the hard ones (T5a
request-id matching, T6 `updatedInput` echo-only, T6b `updatedPermissions` stripping, C1
selection-by-index with out-of-range/duplicate/non-integer rejects, C5's thirteen answer-shape
rejects, the settings write allowlist). The pure logic layer of the renderer — 1,047 tests over
reducers, selectors, and formatters — is real, executable, and mostly well-written. Frames survive
a real multi-process round-trip: real sidecars spawn, resume from real transcripts, refuse to resume
from the wrong cwd with a distinguishable exit code, and survive a sibling's SIGKILL. Secrets do not
cross the outbound serializer. Type-level tripwires mean several classes of protocol drift fail the
typecheck before they can reach a test.

**It does not license this.**

1. **It says nothing about whether the app responds to input.** 752 of those 2,799 tests render React
   to a string. No test in the package has ever fired an event, moved focus, scrolled, or run an
   effect. 77 effects and 17 global keyboard listeners are dead code as far as this number is
   concerned. Both the AskQuestionFlow tag-name bug and the modal-shortcut bug were fully green.
   "2,799 pass" and "keyboard handling works" are unrelated statements.
2. **It says nothing about concurrent writers.** The one test that names contention asserts only
   that the JSON is not torn — and half the writes in it are provably lost.
3. **It over-counts.** At least four tests can only fail if someone edits two adjacent lines of the
   same file inconsistently, and three of those are named after a property they do not check.
4. **It is thinner at the engine seam than at the wire seam.** For session actions, the boundary test
   fakes the domain and the domain test fakes the executor, so the code that actually calls
   `createFork` / `saveCustomTitle` / `renderMessagesToPlainText` is covered by nothing.
5. **`test:hardening 19/19` is a different claim than people read it as.** It sends zero frames to a
   sidecar. It is a renderer/CSP/preload result, not an inbound-baseline result.

The honest one-line summary: **2,799 pass / 0 fail means the wire contract and the pure logic are in
good shape; it is silent about everything that happens after a user touches the keyboard, and about
what happens when two writers meet.**

## Not reviewed / uncertain

- **I did not run the suite.** Every count here is from source (`rg`/`grep` over the tree at the
  time of writing) or from reading the file. The `2,754` `test()` call sites vs. the operator's
  `2,799` reported tests differ because `test.each` expands at runtime; I did not reconcile the
  exact delta.
- **I sampled ~25 high-consequence files closely plus ~10 renderer files.** 359 `app/` test files
  exist. Files I read only by test-name listing: `host.test.ts` (1,823 lines), `transcriptProjector.test.ts`
  (2,867), `agentIdentity.test.ts` (434), `workspaceLayout.test.ts` (216) and most of `app/main/`.
  There are very likely more instances of the three vacuous shapes I named in files I did not open.
- **The `sessionActionRuntimeState` ↔ `sessionActionDialogState` seam bug** was given to me as
  established and I confirmed the *ingredients* (latest-only per-session storage at
  `sessionActionRuntimeState.ts:42-47`; `selectBulkExportOutcome` returning `waiting` on a
  non-matching slot at `sessionActionDialogState.ts:189`; neither test file importing the other). I
  did **not** independently re-derive the hang, and I did not find a second confirmed instance of
  the exact "two modules, two green tests, one false shared assumption" shape. The closest structural
  candidates — the `transcriptBackfill` trio (`app/shared`, `app/main`, `app/main/…Composition`) and
  the `sessionsCatalog` worker/runner/cache trio — each already have a composition-level test, which
  is the right defence. A systematic hunt would mean diffing every hand-built fixture against the
  producing module's own asserted output; that is a mechanical pass worth building a script for.
- **Whether the context-breakdown freshness floor actually mis-arms on failure** is unverified — I
  established only that no test covers the failure path. Resolving it needs a read of the floor/latch
  code in `contextBreakdownDomain.ts`, which A-scope reviewers covered.
