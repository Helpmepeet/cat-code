# X29 adversarial validation: test quality audit

> **Verification provenance:** Claude Opus 5, high effort. Independent recount of every
> quantitative claim with the exact `rg`/`python3` commands shown; four scratch Bun test
> scripts written to the scratchpad that import real repo modules (`SidecarServer`,
> `SessionRegistry`, `react-dom/client`) and exercise the claimed behaviour directly; full
> source review of every cited `file:line`. **No repo file was edited, no git write, no GUI,
> no full suite, and no repo test file was executed** — notably I deliberately did NOT run
> `app/preload/preloadBundle.test.ts`, because running it writes build artifacts into the
> shared tree, which is itself finding F12. Branch `migration` at `a17e5e9`; `app/` tree
> dirty with 17 other-session files, none of which touch the modules under review.

## Overall verdict

The report is **substantially right about what the suite cannot do, and repeatedly wrong
about why and by how much.** Of 19 findings (the dispatch brief said 20; the source
document has 7 HIGH / **8** MED / 4 LOW), 14 are CONFIRMED, 3 are PARTIALLY CONFIRMED and
2 are OVERSTATED. Nothing is INVALID — every gap it names is a real gap. Its arithmetic is
mostly excellent: `useEffect` 73, `useLayoutEffect` 4, `scrollIntoView` 2, `scrollTop` 4,
`scrollHeight` 4, `getBoundingClientRect` 8, `requestAnimationFrame` 4, `getSelection` 2,
`document.` 30, `window.` 76, `onClick` 178, `onKeyDown` 30, `onChange` 25, `onBlur` 7,
`onDrop` 6, `onFocus` 5, `onSubmit` 5, 28 `as unknown as` across 14 files, 26 `src/`
`mock.module` files with 13/13/12/8 at the top, zero `mock.module` in `app/`, 15 of 51
`App.test.tsx` tests grepping source — **all reproduce exactly.**

Three numbers do not. **`react-dom/client` IS installed and IS importable** (proven by
scratch script); the report repeated a false comment from `AccountsPage.test.tsx:27` as its
own verdict. **Global `window`/`document.addEventListener` is 12, not 17** — 17 is the count
of *all* `addEventListener` including five element-level ones in `composerDom.ts`. **`app/`
has 189 test files, not the 359 the report states twice.**

The single most consequential correction is to F1's remedy. The report's evidence points at
a DOM harness; the code points somewhere cheaper. Three of the four global-keydown surfaces
already extract their key decision into a pure, unit-tested module —
`permissionKeyIntent`/`permissionKeysAreLive`, `tasksDialogKeyAction`,
`overlayEscapeAction`/`modalKeyAction`. The two surfaces that keep the decision inline in an
effect are `AskQuestionFlow.tsx` and `App.tsx:2325` — **exactly the two shipped bugs the
report cites.** The house pattern that would have caught both already exists in the repo.

The one thing that most deserves action is **F4**: I reproduced the lost update. 25 of 50
registry writes vanish and the test passes, and every assertion it makes still passes with
the advisory lock replaced by a no-op.

## Summary

| # | Sev | Finding (short) | Verdict | One-line reason |
|---|-----|-----------------|---------|-----------------|
| F1 | HIGH | Renderer React layer has zero executable coverage | PARTIALLY CONFIRMED | SSR-only is real; `react-dom/client` IS installed, listeners are 12 not 17, and 3 of 4 keydown surfaces already extract tested logic |
| F2 | HIGH | T7 rate cap (`checkRate`) has no test | CONFIRMED | `'rate limit exceeded'` exists only at the production site; but no clock seam is needed — 121 frames run in 4 ms |
| F3 | HIGH | `account.rename` has no boundary test either direction | OVERSTATED | Absence real; both stated triggers wrong — `checkStrictKeys` fails closed, and the alias is re-validated 1–32 chars downstream by a tested guard |
| F4 | HIGH | Registry concurrency test documents the lost update | CONFIRMED | Scratch repro: 25 rows on disk, all of B's 25 writes lost, and the assertions pass with the lock removed |
| F5 | HIGH | Real session-actions executor is untested | CONFIRMED | 14 domain tests inject a fake executor, boundary tests inject a fake domain, one non-definition reference |
| F6 | HIGH | Three tests assert an object literal's own keys | CONFIRMED | All three located and read verbatim; fix is safe (`noUnusedLocals` is off) |
| F7 | HIGH | `hardening-smoke` 19/19 covers no sidecar; vacuous XSS checks | PARTIALLY CONFIRMED | (1) true, lines mis-located; (2) true and *undercounted* (5 vacuous, not 3); (3) orphan is bounded to 15 min by CC-3 idle TTL |
| F8 | MED | `App.test.tsx` spends 15 of 51 tests grepping source | CONFIRMED | 15 sites in 51 tests; assertion count brackets 95–122, the report's "~103" sits inside |
| F9 | MED | `secretGuard.test.ts` asserts an object it just built | CONFIRMED | Verbatim at `:135-162`; no real projection function is imported |
| F10 | MED | `as unknown as` casts disable the type tripwire | CONFIRMED | 28 across 14 files, 7/3/3 offenders exact; the `LifecycleFrame` literal is already valid |
| F11 | MED | Context-breakdown floor test only sees success | OVERSTATED | Gap real, but "every one of six tests" is 4 of 6, and both consequences are guarded by the existing try/catch/finally |
| F12 | MED | `preloadBundle.test.ts` runs a build inside a unit test | PARTIALLY CONFIRMED | Build is real; artifacts are gitignored so the shared-tree pollution cost is much smaller than framed |
| F13 | MED | `mock.module` is process-global and irreversible | CONFIRMED | 26 files, 13/13/12/8, spread-snapshot restore at `:61` — every number exact |
| F14 | MED | `makeServer(…, undefined ×11, domain)` | CONFIRMED | 11 consecutive `undefined`s verified; 48 of 129 call sites pad positionally, 11 of them by ≥8 |
| F15 | MED | `effort.set` has no schema-level reject test | CONFIRMED | Both `effort.set` sites are accept-path; `:2433` is a domain outcome, not a schema reject |
| F16 | LOW | `toContain('1')` is satisfied by the test's own requestId | CONFIRMED | `requestId="perm-1"` → `titleId = ask-question-perm-1` |
| F17 | LOW | `backpressuredSocket.probe` early-returns as a pass | CONFIRMED | At `:18` (report said `:17`); anti-vacuity assertion at `:80` confirmed |
| F18 | LOW | `limits.ts` cites the wrong enforcing test file | CONFIRMED | `historyReplay.test.ts` imports neither `DEFAULT_MAX_BUFFERED_*` constant |
| F19 | LOW | `permissionDomain.test.ts:99` is dead after the throw | CONFIRMED | Verbatim at `:96-99` |

**Tally: 14 CONFIRMED · 3 PARTIALLY CONFIRMED · 2 OVERSTATED · 0 INVALID · 0 DUPLICATE · 0 UNPROVEN.**

## Recount of the headline numbers (the operator's explicit list)

Every command below was run from `/Users/pt/cat-code` at `a17e5e9`.

| Claim | Report | My recount | Command | Verdict |
|---|---|---|---|---|
| total `test()` call sites | 2,754 | **2,759** | `rg -c --no-filename -e '^\s*test(\.\w+)?\s*\(' app --glob '*.test.ts' --glob '*.test.tsx' \| awk '{s+=$1} END {print s}'` | immaterial (+5; tree is dirty and has moved since) |
| renderer `test()` call sites | 1,800 | **1,802** | same, scoped to `app/renderer` | immaterial (+2) |
| tests using `renderToStaticMarkup` | 752 (27%) | **753** in the 41 `*.test.tsx`; **880** if you include the 4 `.test.ts` files that also use it; **484** raw call occurrences across 45 files | `rg -c … app/renderer/src/*.test.tsx` | the report's figure is the `.test.tsx` subtotal, off by 1 → **27.3% confirmed** |
| `useEffect` bodies | 73 | **73** | `rg --no-filename -o 'useEffect\(' app/renderer/src -g '*.ts' -g '*.tsx' -g '!*.test.ts' -g '!*.test.tsx' \| wc -l` | exact |
| `useLayoutEffect` bodies | 4 | **4** | same pattern | exact |
| "77 effects" | 77 | **77** | 73 + 4 | exact |
| global `addEventListener` | 17 | **12** | `rg -o '(window\|document)\.addEventListener' …` | **WRONG — 17 is ALL `addEventListener`; 5 of them are element-level (`composerDom.ts:256,257,258,267,268`)** |
| inline event handlers | ~274 | **~313** by a full DOM-prop enumeration; the report's seven named props (178/30/25/7/6/5/5) reproduce **exactly** and sum to 256 | `rg --no-filename -o '\bon[A-Z][A-Za-z]*=\{' app/renderer/src -g '*.tsx' -g '!*.test.tsx' \| sed 's/={$//' \| sort \| uniq -c` | conservative — the true figure is higher, so the conclusion strengthens |
| `mock.module` in `app/` | zero | **0** | `rg -n 'mock\.module' app --glob '!node_modules' \| wc -l` | exact |
| no test dispatches an event | zero | **0** `dispatchEvent`, **0** `fireEvent`, **0** real `act()` (the only two `act(` hits are the literal string `'An update was not wrapped in act(...)'` inside `TranscriptView.test.tsx:1633-1635`) | `rg -n 'dispatchEvent\|fireEvent\|\bact\(' app --glob '*.test.ts*'` | exact |
| `document`/`window` absent under `bun test` | yes | **yes** — `typeof document = undefined`, `typeof window = undefined` | scratch `domharness.test.ts` | exact |
| `react-dom/client` not installed | claimed | **FALSE — it is installed and importable**: `app/node_modules/react-dom/client.js`, exports `createRoot,default,hydrateRoot,version`; `createRoot({})` throws `Target container is not a DOM element`, i.e. the DOM is the blocker, not the package | scratch `domharness2.test.ts` | **REFUTED** |
| `app/` test files | 359 (stated twice) | **189** (`app/host` 3, `app/main` 17, `app/preload` 3, `app/renderer/src` 115, `app/scripts` 5, `app/shared` 7, `app/sidecar` 38, `app/supervisor` 1) | `find app -name '*.test.ts' -o -name '*.test.tsx' \| grep -v node_modules \| wc -l` | **WRONG by ~90%** (repo-wide is 719; `src/` is 175) |
| 2,754 → 2,799 delta explained by `test.each` | asserted, unreconciled | **mostly reconciled**: 6 `.each` blocks expanding to 4+10+8+6+4+5 = 37 cases, i.e. +31 runtime tests over static sites → 2,790 of the operator's 2,799 | `rg -n 'test\.each\|describe\.each\|it\.each' app --glob '*.test.ts*'` | direction correct; ~9 unexplained |
| `hardening-smoke` 19/19 | 19 | **19 on a green run** — there are 20 `add()` sites but the 20th (`:371`) is inside the `catch`, so it only fires on failure | `rg -n "^\s+add\(" app/scripts/hardening-smoke.ts` | exact |

**Bottom line on the numbers:** the report's arithmetic survives almost everywhere. The two
that fail — `react-dom/client` and the listener count — are both in the *headline verdict
paragraph*, which is the worst place for them, but neither changes the direction of F1.

## Per finding

### F1 — [HIGH] The renderer's React layer has zero executable coverage — 27% of the suite is SSR strings

- **Verdict**: PARTIALLY CONFIRMED
- **Cited location holds?**: Yes for the harness fact. `app/renderer/src/AccountsPage.test.tsx:25-36` says verbatim what the report quotes. All 41 `app/renderer/src/*.test.tsx` files import `react-dom/server` — I checked each individually and none is missing. `AskQuestionFlow.tsx:150` is verbatim
  `if (target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA') return`;
  `ComposerInput.tsx:325` is `contentEditable={editable}`; `PermissionPrompt.tsx:55` is
  `return (element as HTMLElement).isContentEditable === true`; the listener is registered at `AskQuestionFlow.tsx:199` inside an effect; the self-documenting comment is at `AskQuestionFlow.test.tsx:43-47`. All exact.
- **Reachable in production?**: Not a defect claim — a coverage claim. Established by running the harness myself rather than reading about it.
- **Trigger**: Scratch `domharness.test.ts` run under `bun test` from `app/`: `typeof document = undefined`, `typeof window = undefined`. Scratch `domharness2.test.ts`: `import('/Users/pt/cat-code/app/node_modules/react-dom/client.js')` → `IMPORTED. keys = createRoot,default,hydrateRoot,version`; `createRoot({})` → `Target container is not a DOM element`.
- **Counter-arguments considered**:
  1. *Is `react-dom/client` really missing?* **No — it is installed** (`app/package.json:34` `react-dom: ^19.2.4`, resolved at `app/node_modules/react-dom/client.js`) and imports cleanly. The report repeated `AccountsPage.test.tsx:27`'s claim as its own. The operative blocker is the absent DOM, which is real. This does not change the conclusion but it does change the *fix estimate*: the missing dependency is a DOM implementation only, not react-dom.
  2. *Is the listener count right?* No. Twelve `window`/`document.addEventListener` sites (`WorkspacePanels.tsx:74,75,96,97`, `PlanPanel.tsx:334`, `composerPopover.ts:51`, `AskQuestionFlow.tsx:199`, `TasksDialog.tsx:183`, `PermissionPrompt.tsx:290`, `App.tsx:2353`, `overlayFocus.ts:345,405`). The other five are element-level in `composerDom.ts`.
  3. **The strongest counter, and the one the report missed: the handler *decision logic* is not uniformly unreachable.** Three of the four global-keydown surfaces already extract it into a pure module and unit-test it —
     - `permissionPromptModel.ts:35 permissionKeyIntent(event: KeyLike)` and `:106 permissionKeysAreLive(target)`, tested at `PermissionPrompt.test.tsx:811+`;
     - `tasksState.ts:88 tasksDialogKeyAction(event)`, tested at `TasksDialog.test.tsx:135-144` including the exact `⌘K` chord bail;
     - `overlayFocus.ts` `overlayEscapeAction`/`modalKeyAction`, tested across nine tests at `overlayFocus.test.ts:108-291` with `{key, defaultPrevented}` literals.
     The two that keep the decision inline in the effect are `AskQuestionFlow.tsx:145-199` and `App.tsx:2325-2355`. **Those are precisely the two shipped bugs the report cites.** So "77 effects and 17 global keyboard listeners are dead code as far as this number is concerned" is too strong: the registrations and effect bodies are untested, but the branch logic for most of them is covered by the repo's own extract-and-test pattern.
  4. *Do the other table rows hold?* Yes, all of them, to the digit (see recount table).
- **True consequence**: There is genuinely no DOM, no event dispatch, and no effect execution in `app/`. Focus movement (21 `.focus()` sites), scroll/measurement (18 sites), `requestAnimationFrame` sequencing (4) and selection (2) have no executable coverage at all and no extracted-model escape hatch. But *keyboard decision logic* is ~75% covered by pure modules, and the coverage hole that produced both cited bugs is narrower and cheaper to close than "install a DOM harness".
- **Evidence**: scratch `domharness.test.ts` / `domharness2.test.ts` (outputs above); `rg` counts in the recount table; `app/renderer/src/permissionPromptModel.ts:35,106`, `app/renderer/src/tasksState.ts:88`, `app/renderer/src/overlayFocus.test.ts:108-291`, `app/renderer/src/TasksDialog.test.tsx:135-144`, `app/renderer/src/PermissionPrompt.test.tsx:811+`.
- **Disposition**: **Do not lead with the DOM harness — the report's proposed order is backwards.** Step 1 (hours, no dependency, no sign-off): extract `AskQuestionFlow.tsx:145-199`'s keydown decision into `askQuestionFlowModel.ts` as a pure `askQuestionKeyIntent(event, target)` mirroring `permissionKeyIntent`, and reuse `permissionKeysAreLive`'s `isContentEditable` predicate rather than the tag-name test — that closes the shipped bug *and* pins it. Do the same for `App.tsx:2325-2355`'s shell chords, which also need the overlay guard V01 finding #3 identified. Step 2, separately and with sign-off: happy-dom, aimed at the classes that genuinely cannot be extracted — focus trapping, scroll/measurement, `requestAnimationFrame`. Correct the source comment at `AccountsPage.test.tsx:27` while you are there: `react-dom/client` is installed.

### F2 — [HIGH] The trust boundary's own rate cap (T7) has no test

- **Verdict**: CONFIRMED (the absence). The report's *disposition* is wrong.
- **Cited location holds?**: Yes. `checkRate` is at `app/sidecar/sidecarServer.ts:3409-3417`, called at `:789` inside `handleData` (`:778`). `MAX_FRAMES_PER_WINDOW = 120` at `app/shared/limits.ts:29`, `RATE_WINDOW_MS = 1_000` at `:32`.
- **Reachable in production?**: Yes, and — importantly — reachable *from the existing test harness*: `sidecarServer.test.ts` drives the server with `server.handleData(conn, frame)`, which is the same entry point that contains `:789`. The cap is not structurally bypassed; it is simply never exceeded (the deepest existing test, `:1147` "T7 — the mid-turn queue has a DEPTH cap, not just a rate cap", sends `MAX_QUEUED_PROMPTS + 2` = 34 frames, well under 120).
- **Trigger for the absence**: `rg -n 'rate limit exceeded' app --glob '!node_modules'` returns exactly three hits: the production site at `sidecarServer.ts:794`, and two hits at `App.test.tsx:1420,1428` which assert a **different** string (`'renderer IPC rate limit exceeded'`) in a bridge test. `checkRate` / `MAX_FRAMES_PER_WINDOW` / `RATE_WINDOW_MS` appear in exactly one test file package-wide: `app/preload/rendererIpcGuard.test.ts`. No probe test drives >120 frames on one connection (the only loops ≥100 in `app/` are two depth chains in `secretGuard.test.ts:80,90`).
- **Counter-arguments considered**: (a) *Is the cap tested by behaviour under a different name?* I searched by error string, by constant, by test-name keyword (`flood|rate|too many|throttl`), and by loop bound. The only rate-cap test in `app/` is the preload one. (b) *Is the preload guard sufficient?* No, by the repo's own doctrine — `protocol.ts:42-43` puts validation at the sidecar because a compromised renderer writes to the socket directly. (c) *Is the cap even correct?* I verified it fires: 121st frame → `{"kind":"error","code":"bad_request","message":"rate limit exceeded","retryable":true}`. The mechanism works; only the guard against its removal is missing.
- **True consequence**: Deleting the `if (!this.checkRate(connection))` branch at `:789` leaves the entire suite green. The T7 flood cap is currently unguarded by any test.
- **Evidence**: scratch `ratecap.test.ts` importing the real `SidecarServer` and `AppSessionController`:
  ```
  elapsed ms for 121 frames = 4
  total frames received = 122
  rate-limit error frames = 1 {"kind":"error",…,"message":"rate limit exceeded","retryable":true}
  ```
- **Disposition**: Add the test — but **not** the report's version. The report says *"`checkRate` also uses a raw `Date.now()` with no injectable clock, so a test would need one added; that is the actual work."* **That is false, and following it would add an unnecessary production seam to the security-critical file.** 121 frames execute in **4 ms**, three orders of magnitude inside the 1,000 ms window, so the window never rolls and the assertion is deterministic without touching production code. The correct fix is a ~15-line test in `sidecarServer.test.ts` that loops `MAX_FRAMES_PER_WINDOW + 1` `app.ping` frames through `handleData` and asserts exactly one `bad_request` / `'rate limit exceeded'` error — precisely my scratch script. Adding a `{ now }` seam is scope the finding does not need.

### F3 — [HIGH] `account.rename` has no boundary test in either direction

- **Verdict**: OVERSTATED
- **Cited location holds?**: Yes. Strict-key entry at `app/sidecar/sidecarServer.ts:3504`; Zod member at `:3682-3687` with `alias: accountAliasSchema` (`:3673`, `z.string().min(1).max(MAX_TEXT_FIELD_CHARS)` = 4,096). `checkStrictKeys` is a per-type `Map` at `:3487+`.
- **Reachable in production?**: The verb is live. The *absence* is real and I confirmed it exhaustively: `rg -n "account\.rename" app --glob '!node_modules'` yields exactly three test hits, all at `app/sidecar/accountsDomain.test.ts:487,495,505`, all domain-level with the frame already parsed. Zero occurrences in `sidecarServer.test.ts`. The generic tests at `:4295` (strict-key) and `:4311` (schema) do both use `account.switch`, exactly as claimed.
- **Trigger**: The report offers two, and **both are wrong**:
  1. *"delete `['account.rename', …]` from the strict-key map (making the Zod object silently strip extra keys rather than reject them)"* — **factually incorrect.** `checkStrictKeys` fails **CLOSED** on a missing map entry: `sidecarServer.ts:3577-3580` reads `const allowed = allowedByType.get(type); if (!allowed) { return \`unknown message type: ${type}\` }`. Deleting the entry makes every `account.rename` frame rejected outright. That is a silent *total functional break*, not a silent widening — the opposite failure mode from the one F10 exists to prevent.
  2. *"Delete that bound [`accountAliasSchema`]"* — technically no boundary test fires, but the consequence is nil. `accountsDomain.ts:866-874` re-validates with the engine's own `validateCodexAccountAlias` (`src/services/api/codexAccountPool.ts:893-911`), which enforces **1–32 characters of `[A-Za-z0-9_-]` plus a live-pool uniqueness check** — vastly stricter than the boundary's 4,096-char cap — and that path **is** tested, at `accountsDomain.test.ts:492` ("rename rejects an invalid alias (regex) before dispatch"). A 5,000-character alias that slipped the boundary would be refused one layer down by a covered guard.
- **Counter-arguments considered**: I looked for a generic loop test over the whole inbound allowlist (none exists), for a compile-time `Record<ClientMessageType, …>` exhaustiveness tripwire over the strict-key map (none — it is a plain `Map<string, Set<string>>`, so a deletion does compile), and for downstream re-validation (found, and it is the decisive one). I also checked whether `alias` is really "the one renderer-authored string on the account verbs" — it is not; `accountId` and `requestId` are also renderer-authored strings, though `alias` is the only free-form user text.
- **True consequence**: A genuine coverage gap whose realistic failure mode is that a future edit to the strict-key map or the union member silently breaks account rename with the whole suite green. It is **not** a security-surface widening: the security property is held by a tested downstream guard. Severity: HIGH/security → **MED/coverage** at most.
- **Evidence**: `app/sidecar/sidecarServer.ts:3504,3577-3580,3673,3682-3687`; `app/sidecar/accountsDomain.ts:855-878`; `src/services/api/codexAccountPool.ts:893-911`; `app/sidecar/accountsDomain.test.ts:487,492,505`; exhaustive `rg` above.
- **Disposition**: Add the accept-valid test — that is the one that matters, because it is the only thing that would catch the strict-key deletion. The over-long-alias reject test is optional defence-in-depth with a tested backstop; write it if it is free, but do not describe its absence as a security gap. The report's "three tests mirroring the `account.switch` trio" is fine as work, wrong as justification. The same reasoning applies to the report's table rows for `account.delete` (accept), `account.logout` and `account.touchAll`.

### F4 — [HIGH] The registry concurrency test documents the lost update instead of catching it

- **Verdict**: CONFIRMED
- **Cited location holds?**: Yes, `app/host/registry.test.ts:940-970`. The test is named "atomic writes under a simulated concurrent writer never produce torn JSON"; it creates two `SessionRegistry` instances over one `storageDir`, interleaves 25+25 `upsertOnSpawn` calls, and asserts only `doc.registryVersion`, `Array.isArray(doc.sessions)`, and per-row `typeof appSessionId === 'string'` / `length > 0` / `typeof cwd === 'string'`. `doc.sessions.length` is never asserted. The comment at `:951-952` does say "last-writer-wins" as if it were the contract.
- **Reachable in production?**: `persist()` at `app/host/registry.ts:892-932` writes `this.doc` wholesale under the lock and never re-reads the file — confirmed by reading it. `upsertOnSpawn` mutates only the instance's in-memory doc.
- **Trigger**: I reproduced the exact test body in a scratch file and added the one assertion it omits.
- **Counter-arguments considered**: (a) *Does `SessionRegistry` reload from disk on some path before writing, making the loss theoretical?* No — the scratch run settles it empirically, not by reading. (b) *Is the lock doing something the test would notice?* No — I re-ran with `acquireLock` replaced by a no-op and **every assertion the real test makes still passed**, because `atomicWriteJson`'s temp-file + `renameSync` (`registry.ts:1033-1068`) alone guarantees an untorn document on POSIX. The report's claim that the lock could be removed with the test still green is correct. (c) *Is this in-process rather than the DR-2 cross-process case its comment cites?* Yes — two objects in one process — which the report also notes.
- **True consequence**: 25 of 50 writes are silently lost and the test reports success. A reviewer reading only the test name concludes concurrent-writer safety is covered.
- **Evidence**: scratch `registrylost.test.ts` →
  `rows on disk = 25  fromA = 25  fromB = 0` / `WOULD toHaveLength(50) PASS? -> false`;
  scratch `registrynolock.test.ts` → `NO-LOCK rows on disk = 25` with all of the real test's assertions passing.
- **Disposition**: The report's fix is right and I would apply it, with one addition. Change the assertion to `expect(doc.sessions).toHaveLength(50)`; it will fail, and the failure is the bug — the fix is read-merge-under-lock in `persist()`. Until that lands, do **not** leave the test as-is with the current name: rename it to state the loss explicitly, and add `expect(doc.sessions.length).toBeLessThan(50)` as a deliberate, self-documenting pin so the day someone fixes `persist()` the stale expectation fails loudly instead of rotting. Also note this test cannot see the cross-process DR-2 case at all; a `*.probe.test.ts` is the only honest home for that claim.

### F5 — [HIGH] The only code that touches the real engine ops for session actions is untested

- **Verdict**: CONFIRMED
- **Cited location holds?**: Yes. `createRealSessionActionsExecutor` is at `app/sidecar/sessionActionsDomain.ts:82-124`; the four-step branch path is verbatim at `:110-121` (`createFork()` → find first user message → `` `${deriveFirstPrompt(firstUser)} (Branch)` `` → `saveCustomTitle(fork.sessionId, title, fork.forkPath, 'user')`).
- **Reachable in production?**: Yes, and only via one path: `createSidecarSessionActionsDomain` at `:146` when `options.executor` is absent. `rg -n 'createRealSessionActionsExecutor' app` returns exactly two hits — its definition and `:146`. Nothing else references it, including no test.
- **Trigger**: All **14** `createSidecarSessionActionsDomain(...)` call sites in `sessionActionsDomain.test.ts` (`:45,57,72,84,98,111,126,139,152,167,183,196,208,218`) pass `{ executor }`, so the real executor is never constructed. One layer up, `makeSessionActionsServer()` at `sidecarServer.test.ts:5928-5947` injects a fake **domain**, so the boundary tests do not reach the real domain either. The header at `sessionActionsDomain.test.ts:1-6` states the exclusion in its own words: "The engine-op round-trip (saveCustomTitle / renderMessagesToPlainText / createFork) is not re-proven here."
- **Counter-arguments considered**: (a) *Is it covered by a probe?* I searched all twelve `*.probe.test.ts` files and the whole package for the symbol — nothing. (b) *Is it covered indirectly through a real `SidecarServer` boot in `spawnConfig.probe.test.ts`?* Those probes spawn real sidecars but never send a `session.branch` frame. (c) *Does the executor have a cheap type-level guard instead?* No — its four methods are plain async functions over engine imports.
- **True consequence**: Break the id, the transcript path, or `deriveFirstPrompt`, and the user gets an ack frame reading "Branched." for a fork that is unnamed, mis-titled, or written against the parent's transcript path, with nothing red. This is CLAUDE.md §8 mistake #1 with the stub in the test rather than the product.
- **Evidence**: `app/sidecar/sessionActionsDomain.ts:82-124,146`; `app/sidecar/sessionActionsDomain.test.ts:1-6` and its 14 injection sites; `app/sidecar/sidecarServer.test.ts:5928-5947`.
- **Disposition**: Apply the report's fix as written — one probe test in the `resumeSeed.probe.test.ts` / `spawnConfig.probe.test.ts` idiom, minting a transcript in a temp `CLAUDE_CONFIG_DIR`, running the real executor, and asserting a fork file exists with the derived title. Cover `branch` first; it is the only one of the four with derived state rather than a single pass-through call, so it carries all the risk. `rename`/`tag` are one-line engine calls and can stay at the domain layer.

### F6 — [HIGH] Three tests assert the key list of an object literal declared two lines above them

- **Verdict**: CONFIRMED
- **Cited location holds?**: Yes for all three, with the constants and tests a line or two off the cited ranges:
  - `extensionsState.test.ts:46-51` constant, `:53-60` test — `expect(Object.keys(RENDERED_EXTENSIONS_SLICES).sort()).toEqual(['hooks','mcp','plugins','skills'])`, named "every extensions slice on the wire has a panel that renders it".
  - `sessionsCatalogState.test.ts:58-62` constant, `:64-70` test — named "every sessions-catalog slice on the wire is read by the renderer".
  - `agentConfigState.test.ts:70-83` constant, `:85-92` test — named "every agent-config slice on the wire is classified by what reads it".
- **Reachable in production?**: N/A (test-quality). The `Record<keyof X, …>` annotations are real tsc tripwires and the report is right that they should stay.
- **Trigger**: Each test compares a literal declared in the same file, ~3 lines above, to a hand-copied list of its own keys. Delete every extensions panel from the renderer and all three stay green while their names claim panel coverage.
- **Counter-arguments considered**: (a) *Does the test add anything the annotation does not?* It catches editing one half without the other, in one file, three lines apart — a failure mode with no plausible cause. (b) *Would the report's fix (delete the `test()`, keep the const) break the typecheck by leaving an unused local?* I checked: `app/tsconfig.json` sets `strict: true` but **not** `noUnusedLocals`/`noUnusedParameters`, so the constant can stand alone. The fix is safe as written — worth stating, because it is the obvious objection.
- **True consequence**: Three assertions of zero information, two of which are named after a property they never check. The runtime cost is nil; the cost is a reviewer counting them as evidence.
- **Evidence**: the three files at the lines above; `app/tsconfig.json`.
- **Disposition**: Apply the report's fix (delete the three `test()` blocks, keep the typed constants and their comments — the comments carry the actual contract). But **this is not a HIGH.** No behaviour is at risk, no bug can hide behind it, and the fix is three deletions. It is a LOW/MED naming defect. If the panel claim is worth keeping, `mainSourceGuards.test.ts`'s `region()` grep idiom is the right instrument, as the report says.

### F7 — [HIGH] `hardening-smoke` 19/19 covers no sidecar, and three of its XSS checks can report PASS vacuously

- **Verdict**: PARTIALLY CONFIRMED (sub-claim 1 confirmed but mis-located; 2 confirmed and *understated*; 3 confirmed in mechanism, overstated in consequence)
- **Cited location holds?**: **Partly — the line numbers for sub-claim 1 are wrong.** The report cites `:192, :199, :207` for the `window.webContents.send(CH_SERVER_FRAME, …)` calls; they are actually at `:286, :293, :299`. `:227-229` for the three `__MARKDOWN_*_RAN` reads is correct. `:391` for `app.exit()` is correct. `run-hardening-smoke.ts` `timeout: 20_000` is at `:72`, within the cited `:68-73`.
- **Reachable in production?**: The harness launches the real `app/main/main.js` under `electron --require`, with `app.isPackaged` forced true, so it does exercise the real packaged renderer/CSP/navigation branch. That part of its claim is honest.
- **Trigger, sub-claim 1 (no sidecar)**: Confirmed. Every crafted frame is injected renderer-side via `window.webContents.send(CH_SERVER_FRAME, [...])`; the harness plays main. Nothing in the file constructs a client frame or writes to the sidecar socket, so `sidecarServer.ts`'s `checkStrictKeys`, Zod union, T4/T5a/T6/T6b/T7 path is entirely unexercised. "hardening 19/19" and "the inbound allowlist is enforced" are indeed unrelated claims.
- **Trigger, sub-claim 2 (vacuity)**: Confirmed, **and the report undercounts by two.** `markdownScriptRan`/`markdownImgRan`/`markdownLinkRan` (`:294-296`) read globals that are undefined unless the payload executed, so an unrendered frame prints PASS. But so do two more in the same class that the report did not name:
  - `:297-301` `add('Markdown javascript: URL was removed', !unsafeLink?.href?.toLowerCase().startsWith('javascript:'))` — `unsafeLink` is `links.find(l => l.text === 'unsafe')`; if the link never rendered, `!undefined` is `true` → PASS.
  - `:302-306` `add('raw target=_blank HTML was not rendered as an active link', rawTargetBlank === undefined)` — passes when the element is absent for *any* reason, including "nothing rendered".
  So **five** of the nineteen checks are absence-shaped. Containment is real: check #1 `markerRendered` (`:289`) fails and `app.exit(failed === 0 ? 0 : 1)` at `:391` exits 1. It is also tighter than the report implies — the marker and all three payloads sit in the **same text block** of the same frame (`:58-64`), so a rendered marker strongly implies rendered payloads. The residual risk is a renderer that shows only the first line (a collapsed/preview row) — then the marker is present and the payload elements are not.
- **Trigger, sub-claim 3 (orphan)**: Confirmed mechanically. `app.exit()` bypasses both `window-all-closed` (`main.ts:1903`) and `before-quit` (`main.ts:1927`), each of which calls `shutdownRuntime()` → `host.shutdownAll()`. Main's own comment at `:1881-1888` documents this exact route for SIGTERM.
- **Counter-arguments considered**: (a) *Does anything else clean up the orphaned sidecar?* **Yes, and this is the decisive one the report missed.** `app/sidecar/index.ts:58` sets `DEFAULT_SIDECAR_IDLE_TTL_MS = 15 * 60 * 1000`, wired at `:215, :244, :250`; `sidecarServer.ts:546-562` self-exits after that long with zero supervisor connections, logging "self-exiting (CC-3)". The orphan is **time-bounded to ~15 minutes**, not indefinite. The report's framing — "the repo ships `reap-orphan-sidecars.ts` specifically to clean up after this class of exit, which is confirmation, not mitigation" — reads the reaper as the only defence; CC-3 is the actual mitigation and the reaper is the manual one-shot for pre-existing fleets (its own header, `:1-27`, says so). (b) *Is 19 the right number?* Yes: 20 `add()` sites, the 20th at `:371` inside the `catch`, so a green run prints 19/19.
- **True consequence**: (1) A real and important labelling problem — the artifact is a renderer/CSP/preload/navigation result and is routinely cited as inbound-baseline evidence. (2) Five contained-but-vacuous PASS lines. (3) One ~15-minute-lived orphan sidecar per hardening run. I did **not** measure the ~230 MB figure — that would need launching Electron, which the contract forbids — so treat it as unverified.
- **Evidence**: `app/scripts/hardening-smoke.ts:18,58-64,173,286,289-318,294-306,371,391`; `app/scripts/run-hardening-smoke.ts:66-72`; `app/main/main.ts:1844-1849,1881-1888,1903,1927`; `app/sidecar/index.ts:45-58,215,244,250`; `app/sidecar/sidecarServer.ts:546-562`; `app/scripts/reap-orphan-sidecars.ts:1-27`.
- **Disposition**: Take the report's first fix — rename the artifact and its STATUS/report citations to "renderer/CSP/preload hardening" — that is the highest-value change here and it costs a string. Take the third fix (`BrowserWindow.close()` + `app.quit()`), noting the cost it avoids is 15 minutes of one orphan, not a permanent leak. **Modify the second fix:** rather than rewriting three checks to assert DOM presence-and-inertness, add one `add('crafted payload elements are present in the DOM', …)` gate covering all five absence-shaped checks — same protection, one assertion instead of five rewrites, and it covers the two the report missed.

### F8 — [MED] `App.test.tsx` spends 15 of its 51 tests grepping `App.tsx`'s source text

- **Verdict**: CONFIRMED
- **Cited location holds?**: Yes. `rg -c -e '^\s*test(\.\w+)?\s*\('` on the file gives **51**; `rg -n "readFileSync\(new URL\('\./App\.tsx'"` gives **15** (all 15 `readFileSync(new URL(…))` sites target `./App.tsx`; the file has 19 `readFileSync` total). The verbatim example assertion is at `:150`:
  `'window.requestAnimationFrame(() => {\n      timer = window.setTimeout(() => {'`. `:149-151`, `:162-167`, `:217-219` are all inside those tests.
- **Reachable in production?**: N/A. The file's own "LAYER HONESTY" header is at `:2064-2068` and says what the report quotes.
- **Trigger**: I parsed the file with a scratch script that walks `test()` blocks by indentation and counts assertions inside the 15 source-reading ones: **157 `expect()` and 122 `.toContain()`**. A narrower heuristic (receiver variable containing `source`/`body`/`src`) gives **95**. The report's "~103" sits inside that bracket; some of the 122 assert on rendered HTML in mixed tests, which is why the honest range is 95–122.
- **Counter-arguments considered**: (a) *Are these actually load-bearing?* Several are — `:1969` `expect(effectBody).toContain('if (!permissionKeysAreLive(event.target)) return')` pins that the effect calls the tested predicate, which is genuinely the only reachable check for that wiring under SSR. That is the good half. (b) *Is the whitespace-exact assertion at `:150` really as brittle as claimed?* Yes — it embeds `\n` and six spaces of indentation, so a reindent breaks it with behaviour unchanged. The surrounding comment argues the nesting order matters, which is fair, but the assertion pins formatting to prove ordering.
- **True consequence**: ~100 assertions that must be edited for refactors they should not care about and that prove text exists rather than that code runs. Net-negative maintenance, honestly labelled.
- **Evidence**: scratch `counttests.ts` (per-test breakdown printed); `app/renderer/src/App.test.tsx:115-186,145-151,1939-2062,1969,2064-2112`.
- **Disposition**: Agree with the report — do not rewrite now. Apply `mainSourceGuards.test.ts`'s rule (`:4-26`): keep region-anchored *absence* and *ordering* assertions and the ones that pin a call to an independently-tested predicate (`:1969` is the model); drop the bare "this call site exists" positives; delete the whitespace-exact ones outright, since the ordering they defend can be asserted with two ordered `indexOf` comparisons instead of one formatted string.

### F9 — [MED] `secretGuard.test.ts` closes with an assertion on an object the test just built

- **Verdict**: CONFIRMED
- **Cited location holds?**: The test is at `:135-162` (report said `:141-160` — the block is slightly wider). It builds a `projected` literal at `:142-149`, runs `expect(scanForSecrets(projected).ok).toBe(true)` (real and valuable), then at `:155-161` asserts `expect(Object.keys(projected).sort()).toEqual(['kind','result','status','summary','toolUseId','usage'])` — the same six keys written ten lines above.
- **Reachable in production?**: The claim the comment makes is about production: the real projection keeps `status/summary/toolUseId/result/usage` and drops `taskId`/`outputFile`, documented at `app/shared/protocol.ts:549-551`. The test asserts it about a fixture.
- **Trigger**: Add `outputFile` back to the real projection and this test stays green, because it never imports it.
- **Counter-arguments considered**: (a) *Is a real projection function importable, making the report's first fix viable?* I searched: the narrowing is described in `protocol.ts:549-551` and the origin is minted at `sidecarServer.ts:1212` (`queuedCommandOrigin(command) ?? { kind: 'task-notification' }`); there is no single exported `projectTaskNotification(...)` to import. So the report's preferred fix ("import the real projection function") may not be available without extracting one. (b) *Is the first assertion vacuous too?* No — `scanForSecrets(projected).ok` runs the real guard over a realistic shape. The rest of the file is genuinely strong (the depth-limit fail-closed tests at `:80-95` are excellent).
- **True consequence**: One assertion of zero information at the end of the package's best security unit test.
- **Evidence**: `app/shared/secretGuard.test.ts:135-162`; `app/shared/protocol.ts:549-551`; `app/sidecar/sidecarServer.ts:1212`.
- **Disposition**: Take the report's *second* option, not its first: delete the key assertion and keep `expect(scanForSecrets(projected).ok).toBe(true)`. The first option (import the real projection) requires extracting a function that does not currently exist, which is scope this finding does not justify. If the drop of `taskId`/`outputFile` is worth pinning, pin it where it is decided — a `Record<keyof …, true>` tripwire or a source-region guard next to `protocol.ts:549`, not in a fixture.

### F10 — [MED] `as unknown as` casts in reducer tests disable the type tripwire they sit next to

- **Verdict**: CONFIRMED
- **Cited location holds?**: Exactly. **28** occurrences across **14** renderer test files; the three named offenders reproduce to the count: `previewTranscriptState.test.ts` 7, `sessionActionRuntimeState.test.ts` 3, `overlayFocus.test.ts` 3. The example at `sessionActionRuntimeState.test.ts:75-80` builds `{kind:'lifecycle', protocolVersion: PROTOCOL_VERSION, sessionId: OTHER, status:'disconnected'}` and casts it `as unknown as ServerFrame`; the `pong` frame at `:101` does the same.
- **Reachable in production?**: N/A (test-quality), but the *contract* is a production one — `protocol.ts:2288-2297` defines `LifecycleFrame` as exactly `{kind, protocolVersion, sessionId, status, exit?}`, so the literal at `:75-80` is already assignable and the cast is gratuitous.
- **Trigger**: Add a required field to `LifecycleFrame` and every one of these fixtures keeps compiling with the field missing, so the reducer is exercised against a frame shape that can no longer occur on the wire.
- **Counter-arguments considered**: (a) *Are the casts load-bearing anywhere?* `previewTranscriptState.test.ts` (7) is the one file I would not assume is gratuitous without checking each site — the report's own fix acknowledges this ("where it is not [valid], the cast is hiding a real mismatch"). (b) *Does the repo contract actually cover tests?* CLAUDE.md §7 says "zero `as` casts in projector-style code"; extending that to the tests that guard the projector is the report's inference, and a sound one. (c) *Is 28 inflated by `as unknown as` inside deliberate malformed-input tests?* Some of it will be — a malformed-frame tolerance test legitimately needs one. The count is a ceiling, not a defect count.
- **True consequence**: An unknown fraction of 28 fixtures are pinned to shapes tsc would otherwise police. Real, bounded, and mechanical to triage.
- **Evidence**: `rg -c 'as unknown as' app/renderer/src --glob '*.test.ts*'`; `app/renderer/src/sessionActionRuntimeState.test.ts:75-80,96-101`; `app/shared/protocol.ts:2288-2297`.
- **Disposition**: As the report says — drop the casts where the literal already satisfies the type (start with `sessionActionRuntimeState.test.ts`'s three, which I verified are valid), and treat each surviving cast as a question rather than a deletion. Do this as one mechanical pass with the typecheck as the oracle; it is the cheapest item in this report per unit of protection restored.

### F11 — [MED] The context-breakdown freshness-floor test only ever sees a successful analysis

- **Verdict**: OVERSTATED
- **Cited location holds?**: Yes, off by one: the freshness test is `:134-158` (cited `:133-157`), `countingDomain()` is `:91-105` (cited `:~90-104`). It does default to returning `BREAKDOWN`.
- **Reachable in production?**: The failure path exists — `contextBreakdown.snapshot()` can throw or return `null`.
- **Trigger**: The absence is real: no test in the file supplies a **rejecting** domain. All six tests use a resolving one or none.
- **Counter-arguments considered**: three, and two of them land.
  1. *"`countingDomain()` … Every one of the six tests in the file uses it."* — **False.** It is used by **4** of 6 (`:109, :135, :161, :189`). `:210` builds its own inline domain (`:216-221`) that resolves after a gate, and `:245` passes no domain at all. Also, `countingDomain` takes `result: ContextBreakdownSnapshot | null = BREAKDOWN`, so it does not structurally "always return BREAKDOWN" — no caller happens to override it.
  2. *"If a failed analysis still arms the floor…"* — **Refuted.** `sidecarServer.ts:3043-3049`: `contextBreakdownComputedAt` is assigned only after `const raw = await this.contextBreakdown.snapshot()` returns truthy, inside the `try`. A throw skips it; a `null` returns early at `:3044-3046`. A failure can never arm the floor.
  3. *"if a failure leaves the coalescing latch set, subsequent requests are dropped silently"* — **Refuted.** `:3060-3065` is a `finally` that unconditionally clears `contextBreakdownInFlight` and drains `contextBreakdownPending` with a recursive `void this.broadcastContextBreakdown()`.
- **True consequence**: A gap in test coverage over a path that, on inspection, already behaves correctly. Neither consequence the finding predicts can occur. To the report's credit, its own "Not reviewed" section flags this as unverified.
- **Evidence**: `app/sidecar/contextBreakdownBoundary.test.ts:91-105,108-158,210-242,245-259`; `app/sidecar/sidecarServer.ts:3030-3065`.
- **Disposition**: **The report's proposed fix would fail as written.** It says "assert an error frame is sent and the *next* request re-runs the analysis" — but the `catch` at `:3052-3059` only calls `this.log(...)`; **no error frame is sent**, deliberately (a background refresh failing is not a renderer-actionable error). Write the test to match reality: a domain whose first `snapshot()` rejects, then assert (a) no `context-breakdown.snapshot` frame, (b) no `error` frame, (c) the next request re-invokes the domain — which pins the `finally` and the unarmed floor. Severity MED → LOW: this is regression-proofing correct code, not uncovering a defect.

### F12 — [MED] `preloadBundle.test.ts` runs a full Electron build inside a unit test

- **Verdict**: PARTIALLY CONFIRMED
- **Cited location holds?**: Yes. `app/preload/preloadBundle.test.ts:5-10` — `spawnSync('bun', ['run', 'scripts/build-electron.ts'], { cwd: new URL('..', import.meta.url) })` inside `test()`. `app/scripts/build-electron.ts:28` writes with `outdir: appRoot`, producing `app/preload/preload.cjs`, `app/preload/preload.dev.cjs` and `app/main/main.js`.
- **Reachable in production?**: N/A. It runs on every `bun test app/`.
- **Trigger**: The build runs and writes three files into the working tree as a side effect of a read-only-looking command.
- **Counter-arguments considered**: **The shared-tree cost is much smaller than the report frames it.** All three artifacts are **gitignored and untracked** — `app/.gitignore:2` (`main/main.js`), `:3` (`preload/preload.cjs`), `:4` (`preload/preload.dev.cjs`); `git ls-files` returns nothing for them. So they cannot appear in another session's `git status`, cannot be swept into a commit, and cannot be lost by a `git checkout`. Cost (a) as stated — "mutates the repo … on a tree the CLAUDE.md says is shared" — is materially overstated. Costs (b) and (c) stand: the result depends on the build toolchain rather than the code, and any later test reading those artifacts inherits an unguaranteed ordering contract. **A real hazard the report missed:** `run-hardening-smoke.ts:66-72` and `app/scripts/dev.ts` write the *same three paths*, so a concurrent `bun test app/` and hardening/dev run can interleave writes to a bundle another process is reading.
- **True consequence**: A slow, toolchain-dependent test with an implicit ordering contract and a cross-process write race against the dev/hardening builds — not a source-tree pollution problem.
- **Evidence**: `app/preload/preloadBundle.test.ts:5-18`; `app/scripts/build-electron.ts:28`; `app/.gitignore:2-4`; `git ls-files` (empty); `app/scripts/run-hardening-smoke.ts:66-72`. I did **not** run the file — doing so would write into the tree, which the verification contract forbids and which is the finding itself; so "slowest single test in the package" remains unmeasured.
- **Disposition**: Apply the report's fix — move the two assertions to `run-hardening-smoke.ts`, which already builds both bundles at `:66-72`. But justify it on determinism and the write race, not on repo pollution: the pollution argument is wrong and will be rejected by anyone who checks `.gitignore`.

### F13 — [MED] Why the account suites only pass file-isolated: `mock.module` is process-global and irreversible

- **Verdict**: CONFIRMED
- **Cited location holds?**: Yes, and every number is exact. **26** `src/**` test files use `mock.module`; the heaviest are `src/components/Settings/Settings.test.tsx` **13**, `src/codex-core/accounts.test.ts` **13**, `src/components/Settings/Usage.test.tsx` **12**, `src/hooks/useDeferredContinuation.test.ts` **8**. `app/` has **0**. The restore mechanism is where claimed: `accounts.test.ts:61` `realPoolModule = { ...require('../services/api/codexAccountPool.js') }` in `beforeEach` (a plain-object spread snapshot, exactly as described), re-mocked from that snapshot at `:77-82`, then `mock.restore()` at `:83`.
- **Reachable in production?**: N/A. This is an accurate description of CLAUDE.md's documented "some suites only pass file-isolated" rule, and the report is right to name the mechanism.
- **Trigger**: A file that mocks `../services/api/codexAccountPool.js` changes what every later-loaded file in the same `bun test` process imports; restoring from a value snapshot rebinds exports but not the live module record, so a module that captured a binding during the mocked window keeps the mock.
- **Counter-arguments considered**: (a) *Is `mock.restore()` enough on its own?* The test file itself does not think so — it re-mocks from the snapshot *before* calling `restore()`, which is only necessary if `restore()` alone is insufficient. That is the strongest available evidence for the report's reading. (b) *Is `app/`'s zero really architectural rather than accidental?* The DI style is pervasive and deliberate: `{ executor }`, `{ acquireLock }`, `{ now }`, `{ log }`, `{ reloadPool }` all appear as constructor/factory options across the sidecar and host. Accidental absence across 189 files is not credible.
- **True consequence**: Exactly as described. This is the best-evidenced finding in the report and its conclusion — that `app/`'s injection style is why `bun test app/` is safe as one command — is a genuine architectural win worth stating.
- **Evidence**: `rg -c 'mock\.module' src --glob '*.test.ts*' | sort -t: -k2 -rn`; `src/codex-core/accounts.test.ts:45-47,61-63,77-86`.
- **Disposition**: Apply as written. Nothing to change in `app/`. In `src/`, add a per-file `bun test <file>` line to `docs/maps/build-release-testing.md` §Test Routing for each of the 26 files, and prefer the injection style for new tests. One addition: make the marker mechanical rather than remembered — a repo-wide sweep test in the `userVisibleText.test.ts` / `fastRefreshBoundaries.test.ts` idiom that fails when a file using `mock.module` is absent from the routing table.

### F14 — [MED] `makeServer(…, undefined ×11, domain)` makes the boundary suite fragile by position

- **Verdict**: CONFIRMED
- **Cited location holds?**: Yes. `makeSessionActionsServer()` at `app/sidecar/sidecarServer.test.ts:5928-5947` passes the controller followed by exactly **11** consecutive `undefined`s and then `domain`. `makeServer`'s signature is at `:191-206` — fifteen positional parameters, of which `sessionActions` is the **13th parameter / 12th optional** (the report's "twelfth positional domain slot" is off by one in a way that does not matter).
- **Reachable in production?**: N/A, but this is the helper for the file that is the security gate.
- **Trigger**: Insert a new domain parameter anywhere before `sessionActions` in `makeServer`'s signature and every padded call site silently binds its domain to the wrong slot. A missing domain fails closed to `internal_error`, and several tests assert exactly that — so the suite stays green while the tests meant to exercise a real domain quietly stop doing so.
- **Counter-arguments considered**: (a) *Would tsc catch a shifted binding?* Not necessarily — all the padded slots are optional and several domain types are structurally distinct but not mutually unassignable at the `undefined` positions; a shift from `sessionActions` to `runControls` would be caught, but a shift by one into an adjacent optional of a compatible shape would not, and a shift that lands on `undefined` never errors. (b) *Is it really ~8 call sites?* I counted all 129 `makeServer(` invocations with a balanced-paren parser: **81** pass no `undefined`, **48** pass at least one, and **11** pass eight or more (three pass exactly 11, one passes 12, one passes 13). The report's "~8 similar call sites" is conservative.
- **True consequence**: 48 call sites in the security-gate suite are position-coupled to a 15-parameter signature; 11 of them deeply so.
- **Evidence**: `app/sidecar/sidecarServer.test.ts:191-206,5928-5947`; balanced-paren count script output above.
- **Disposition**: Apply the report's fix (`makeServer({ controller, sessionActions })`). It is a pure test-helper change with no production impact and the diff is mechanical — `makeServer`'s body already spreads a named options object into `new SidecarServer({...})` at `:209-227`, so the destructuring is a ten-line edit and 48 call-site rewrites, most of which get shorter.

### F15 — [MED] `effort.set` has no schema-level reject test

- **Verdict**: CONFIRMED
- **Cited location holds?**: Yes. Strict-key entry at `app/sidecar/sidecarServer.ts:3526`; Zod member at `:3800-3804` with `effort: z.string().min(1).max(MAX_TEXT_FIELD_CHARS)`. `'effort.set'` appears in `sidecarServer.test.ts` at exactly three places: `:2373` (test title, accept path), `:2383` (the accept frame), and `:2444` — and `:2444` is inside the test at `:2433`, "a well-typed unsupported effort returns a correlated failed result", which asserts a `run-control.result` with `ok: false`, i.e. a **domain** outcome on a frame that already passed the schema. There is no `bad_request` test for the verb.
- **Reachable in production?**: Yes — it is a live inbound verb.
- **Trigger**: The sibling coverage confirms the asymmetry: `model.set` has a non-string reject at `:2462` (`model: 42` → `bad_request`, no domain call) and `fast.set` has a non-boolean reject at `:2481` (`active: 'yes'`). `effort.set` has neither.
- **Counter-arguments considered**: (a) *Does `model.set`'s reject prove the union rejects for `effort.set` too?* No — `runControlsMessageSchema` is a `z.discriminatedUnion` and each member owns its field schemas, so deleting `effort`'s `z.string()` would not be caught. (b) *Is there generic cover?* `:2500` ("rejects `model.set` missing `requestId`") and `:2519` ("rejects a run-control verb carrying an unexpected key") both use a different verb, and `checkStrictKeys` is per-type. (c) *Is the residual risk large?* No — the field is a bare bounded string with no downstream trust, and `:2433` already proves an unsupported *value* is refused by the domain. This is a thin, cheap gap.
- **True consequence**: One union member's field schema is unguarded by any test.
- **Evidence**: `app/sidecar/sidecarServer.ts:3526,3800-3804`; `app/sidecar/sidecarServer.test.ts:2373,2383,2433-2459,2462-2479,2481-2498`.
- **Disposition**: Apply the report's fix verbatim — one test, `{type:'effort.set', requestId:'r', effort: 42}` → `bad_request` with no domain call, sitting beside the two existing sibling rejects. Severity MED → LOW: the gap is a single field schema with a tested domain-level backstop directly behind it.

### F16 — [LOW] `AskQuestionFlow.test.tsx:69` asserts the HTML contains the digit `1`

- **Verdict**: CONFIRMED
- **Cited location holds?**: Yes — `app/renderer/src/AskQuestionFlow.test.tsx:68-70`: the comment `// Numbered pick affordance (option 1 badge, cursor starts at row 0).` followed by `expect(html).toContain('1')`.
- **Reachable in production?**: N/A.
- **Trigger**: The test helper passes `requestId="perm-1"` (`:55`), and `AskQuestionFlow.tsx:206` builds `const titleId = \`ask-question-${requestId}\`` → `ask-question-perm-1`, which is rendered as an id. The digit `1` is therefore present in the markup before any badge exists.
- **Counter-arguments considered**: (a) *Could the assertion still fail usefully if the whole component failed to render?* Marginally — but the four surrounding assertions in the same test (`'Which date library should we use?'`, `'Library'`, `'date-fns'`, `'luxon'`) already cover that, so it contributes nothing. (b) *Is the proposed fix idiom actually in the file?* Yes, used correctly three tests later: `expect(html).toContain('>3<')` at `:85`, and `expect(html).not.toContain('>10<')` / `expect(html).toContain('>o<')` at `:103-104` (report cited `:84`/`:103`).
- **True consequence**: One assertion satisfied by the test's own fixture id.
- **Evidence**: `app/renderer/src/AskQuestionFlow.test.tsx:48-55,68-70,85,103-104`; `app/renderer/src/AskQuestionFlow.tsx:206`.
- **Disposition**: Apply as written — `expect(html).toContain('>1<')`.

### F17 — [LOW] `backpressuredSocket.probe.test.ts` silently passes if the Bun global is missing

- **Verdict**: CONFIRMED
- **Cited location holds?**: Off by one — the early return is at `:18` (`if (!BunRt?.listen) return // Bun-only path`), inside the test opened at `:17`. `BunRt` is defined at `:13`.
- **Reachable in production?**: N/A, and unreachable under `bun test` by construction, exactly as the report says.
- **Trigger**: None available in this runtime. The report itself calls the risk theoretical.
- **Counter-arguments considered**: (a) *Is the file otherwise weak?* No — it is the best anti-vacuity example in the package: `expect(drainCalls).toBeGreaterThan(0)` at `:80` with the comment "Prove the test actually exercised backpressure (not a trivial pass)", verified verbatim. (b) *Does the early return leave the socket path dirty?* No — it returns before creating it (`:20`).
- **True consequence**: A zero-assertion pass that can only occur outside `bun test`. Cosmetic.
- **Evidence**: `app/sidecar/backpressuredSocket.probe.test.ts:13,17-18,78-80`.
- **Disposition**: Apply as written — `test.skipIf(!BunRt?.listen)`. Zero risk, and it makes the file's own anti-vacuity discipline consistent with itself.

### F18 — [LOW] `limits.ts` cites the wrong file as enforcing the replay alignment invariant

- **Verdict**: CONFIRMED
- **Cited location holds?**: Exactly. `app/shared/limits.ts:120` reads "Enforced by test (historyReplay.test.ts)".
- **Reachable in production?**: N/A (doc drift).
- **Trigger**: `app/sidecar/historyReplay.test.ts` imports only `MAX_HISTORY_REPLAY_BYTES` and `MAX_HISTORY_REPLAY_FRAMES` (`:17-18`) and never `DEFAULT_MAX_BUFFERED_FRAMES`/`DEFAULT_MAX_BUFFERED_BYTES`, so it cannot assert the alignment. The invariant is enforced at `app/main/historyReplayReload.test.ts:56-61`, in a test literally named "ALIGNMENT INVARIANT: history replay caps sit strictly below the replay-buffer budgets", which imports all four constants (`:13-14,19-20`) and asserts both `toBeLessThan` relations at `:59-60`.
- **Counter-arguments considered**: (a) *Could the citation mean the sidecar file enforces a different half?* No — `historyReplay.test.ts` only exercises the caps against themselves (`:130,147,157`). (b) *Is the invariant unguarded, making this worse than doc drift?* No — it is guarded, just elsewhere. The finding is exactly what it says.
- **True consequence**: A maintainer following the citation finds nothing and may conclude the invariant is unguarded, or add a duplicate.
- **Evidence**: `app/shared/limits.ts:114-121`; `app/sidecar/historyReplay.test.ts:17-18,130,147,157`; `app/main/historyReplayReload.test.ts:13-14,19-20,56-61`.
- **Disposition**: Apply — change the comment to cite `app/main/historyReplayReload.test.ts`. Note the report calls it a "one-word correction"; it is a filename change plus the `app/main/` path, since the file lives in a different area than the one currently named, which is the whole point of the drift.

### F19 — [LOW] `permissionDomain.test.ts:99` is dead after the throw above it

- **Verdict**: CONFIRMED
- **Cited location holds?**: Exactly. `app/sidecar/permissionDomain.test.ts:96-99`:
  `if (exitCode !== 0) { throw new Error(\`feature-enabled sidecar probe failed:\n${stderr}\`) }` immediately followed by `expect(exitCode).toBe(0)`.
- **Reachable in production?**: N/A.
- **Trigger**: The `expect` can never observe a non-zero `exitCode` — the throw has already left the block.
- **Counter-arguments considered**: (a) *Does the `expect` serve as an assertion-count guard so bun does not report a zero-assertion pass?* Plausible as intent, but the file has other assertions and bun does not fail on zero assertions anyway, so it does not earn its place. (b) *Is the throw worse than an assertion?* No — it is better, because it carries `stderr` into the failure message, which `toBe(0)` would not. The throw is the right check; the `expect` is the redundant one.
- **True consequence**: Harmless. It makes the subprocess probe look like it has an assertion when the real check is the throw.
- **Evidence**: `app/sidecar/permissionDomain.test.ts:92-99`.
- **Disposition**: Lowest priority in the report. If touched, delete the `expect` and keep the throw — not the reverse, since the throw carries the diagnostic. Fold it into the next edit to the file rather than raising a change for it.

## The report's own "Correction to a lead" — verified

The report corrects an earlier reviewer's claim that `app.abort` has no reject test. **That
correction is right.** `app/sidecar/sidecarServer.test.ts:381` is "T7 — rejects an app.abort
reason over the text cap (no abort)", sending `reason: 'x'.repeat(MAX_TEXT_FIELD_CHARS + 1)`
and asserting both the `bad_request` frame and `aborts === 0`. The accept path is at `:347`,
and its comment at `:348-349` records the past-tense gap exactly as the report describes.
Both directions are covered. This is the shape of error the verification contract warns
about, and X01 caught it before I had to.

## Findings the original report missed

Verified to the same bar as the above.

1. **`app/renderer/src/AccountsPage.test.tsx:27` states a falsehood that the report then
   propagated.** The comment says `react-dom/client` "is not installed". It is:
   `app/package.json:34` declares `react-dom: ^19.2.4`, it resolves at
   `app/node_modules/react-dom/client.js`, and a scratch import returns
   `createRoot, default, hydrateRoot, version`. `createRoot({})` fails with `Target container
   is not a DOM element` — the DOM is the blocker, not the package. The comment is the
   canonical explanation every renderer test file defers to, so the error propagates by
   design. Fix the comment; it changes the cost estimate for the DOM-harness decision the
   whole of F1 rests on.

2. **Two more vacuous checks in `hardening-smoke.ts` of the same class the report named.**
   `:297-301` (`!unsafeLink?.href?.toLowerCase().startsWith('javascript:')`) and `:302-306`
   (`rawTargetBlank === undefined`) both report PASS when the element is absent for any
   reason, including "nothing rendered". Five of the nineteen checks are absence-shaped, not
   three. Same containment, same fix.

3. **`app/preload/preloadBundle.test.ts` races the dev and hardening builds, not the git
   index.** `bun test app/`, `app/scripts/run-hardening-smoke.ts:66-72` and `app/scripts/dev.ts`
   all write `app/main/main.js` and `app/preload/preload*.cjs`. On this machine, where the
   operator's dev app and other agent sessions run concurrently (CLAUDE.md §0), a test-run
   rebuild can land mid-read of a bundle another process is loading. This is the real
   determinism hazard; the git-pollution one the report leads with does not exist, because
   all three paths are gitignored (`app/.gitignore:2-4`).

## Uncertainty

- **The `~230 MB` orphan figure in F7 is unverified.** Measuring it requires launching
  Electron, which the verification contract forbids. What I did establish is that the orphan
  is real and that it is bounded to ~15 minutes by the CC-3 idle TTL, which is the part that
  changes the finding.
- **`preloadBundle.test.ts` being "the slowest single test in the package" is unverified.**
  Timing it means running it, and running it writes into the shared tree.
- **Roughly 9 of the 45-test gap between the static count (2,759) and the operator's runtime
  count (2,799) is unexplained.** Six `test.each` blocks account for +31. The remainder is
  most likely tree drift between the report's snapshot and the operator's run; I did not run
  the suite to close it, and no finding depends on it.
- **The 28 `as unknown as` casts (F10) are a ceiling, not a defect count.** I verified that
  the three in `sessionActionRuntimeState.test.ts` are gratuitous by reading the
  `LifecycleFrame` type; I did not individually adjudicate the other 25, and some (notably
  in malformed-input tolerance tests) will be legitimate.
