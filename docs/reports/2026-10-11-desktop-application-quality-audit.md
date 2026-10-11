# Desktop application quality audit

2026-10-11. Scope: the desktop application, including visible behavior, workflows, UI/UX, input/state continuity, responsiveness, and failure recovery. Backend inspection followed application-visible issues; implementation stays in renderer owners and the existing extensions inventory adapter.

## Outcome

Fifteen distinct audit assignments identified 54 deduplicated findings. The repair pass fixed 48 bounded issues, including all nine P1 findings. Six findings remain explicit follow-up work below. The requested implementation review found seven additional repair/verification issues, all corrected and re-executed. Severity records impact if triggered, not measured frequency. Source, component/DOM, host-boundary, and native visual evidence are distinguished; this report does not certify every app state.

The agents worked in waves under the four-active-agent limit. Finished agents were reused for repair and review; no additional distinct agents were allocated.

| Assignment | Audit lens |
|---|---|
| A01 | Navigation and split workspace |
| A02 | Composer and attachments |
| A03 | Transcript and tool output |
| A04 | Settings and editing |
| A05 | Accounts and Analytics |
| A06 | Welcome and session catalog |
| A07 | Extensions and definitions |
| A08 | Plans, tasks, goals and memory |
| A09 | Permissions and questions |
| A10 | Overlays and accessibility |
| A11 | Visual layout and motion |
| A12 | State continuity and recovery |
| A13 | Desktop startup and integration |
| A14 | Responsiveness and dock history |
| A15 | Independent product flow and failure feedback |

## Findings and disposition

| ID | Priority | Status | Finding | Repair or follow-up |
|---|---|---|---|---|
| A01-1 | P1 | Fixed | Keyboard focus leaves split session action target stale | Focus entering pane B now selects B before shell shortcuts. |
| A01-2 | P2 | Fixed | Tab child actions intercepted on keyboard activation | Nested Close, Restart and Actions keep native activation keys. |
| A01-3 | P2 | Fixed | Managed Chat UUID shown as project | Managed Chat identity replaces storage UUID/project presentation. |
| A01-4 | P3 | Fixed | Parked split panes labeled crashed | Parked panes use the existing idle status presentation. |
| A02-1 | P1 | Fixed | File-only prompt dropped while reconnecting | File-only prompts are admitted into the held-submit store. |
| A02-2 | P1 | Fixed | Collapsed paste payload lost on renderer reload | Draft storage expands collapsed paste contents before writing. |
| A02-3 | P2 | Fixed | Mention completion leaves caret inside name | Mention selection restores the caret after the completed name. |
| A02-4 | P2 | Fixed | Slash buttons ignore keyboard and assistive clicks | Slash results select through Click, including keyboard/AT activation. |
| A03-1 | P2 | Fixed | Full-output copy strips genuine tabular output | Read prefix normalization is limited to Read; other output keeps its bytes. |
| A03-2 | P2 | Fixed | Encoded markdown paths fail to open | Workspace links decode once; host containment/literal-file policy remains authoritative. |
| A03-3 | P2 | Follow-up | Multi-file patches display only first diff | Existing capability gap: multi-file patches still expose the projected primary file. A separate projector/presentation change must preserve all file identities and bounded output. |
| A03-4 | P2 | Fixed | Long diff lines have no full-content route | Diff cards expose the existing full-output inspector and complete available patch copy. |
| A03-5 | P3 | Fixed | Search skips repeated matches on a long line | Search steps through occurrences with character offsets on one long line. |
| A04-1 | P2 | Fixed | Failed integer draft survives settings layer switch | Scope-keyed editor remounts discard a failed layer's stale draft. |
| A04-2 | P2 | Fixed | Settings and command palette compete for Cmd+K | Settings owns Cmd+K for search unless the palette is already open. |
| A04-3 | P2 | Fixed | Pending settings toggles allow duplicate stale writes | Pending writes disable their control through acknowledgement and inventory reload. |
| A04-4 | P3 | Fixed | Settings search loses target during inventory load | Search retains its destination until its inventory target is loaded. |
| A05-1 | P2 | Fixed | Unknown quota rendered green 0 percent | Unknown quota is neutral/unavailable and distinct from genuine zero. |
| A05-2 | P2 | Fixed | Quota durations ignored in Accounts labels | Duration-aware quota slots keep percentages and reset times paired. |
| A05-3 | P2 | Fixed | Refresh all conceals failed receipt | Matched refresh failures show their message and allow retry. |
| A05-4 | P2 | Fixed | Accounts cold-load failure remains indefinite loading | Existing bounded presentation handles missing pool data; Add and read Retry remain available. |
| A06-1 | P2 | Fixed | Bulk export loses completed legs and hangs | Bounded request-correlated export retention survives later Rename/Tag results. |
| A06-2 | P2 | Fixed | Missing-project Open and Restore controls do nothing | Openability uses the existing route; live and managed recovery remain available. |
| A06-3 | P2 | Fixed | Confirmed tags disagree with session filtering | Acknowledged tags drive filtering/search immediately; removed selected tags reset to All. |
| A07-1 | P1 | Fixed | Loaded plugin diagnostics bypass credential redaction | Matched loaded-plugin diagnostics pass through the existing credential sanitizer. |
| A07-2 | P2 | Fixed | Bundled skills omitted from inventory | Real bundled prompt skills appear while synthetic builtins remain excluded. |
| A07-3 | P2 | Fixed | Agent parse failures hide path and reason | Failed definitions show bounded sanitized reasons and copyable source paths. |
| A07-4 | P3 | Fixed | Skills instructions point to wrong configuration | Skill guidance identifies the actual definition files. |
| A08-1 | P1 | Fixed | Plan review hides non-list content | Plan review renders full bounded Markdown, including prose, headings and fences. |
| A08-2 | P2 | Fixed | Submitted plan remains actionable | Submitted plan controls and App callbacks refuse duplicate actions. |
| A08-3 | P2 | Fixed | Task rows ignore pointer selection and lack stop control | Task rows support pointer/focus selection and row-specific Stop. |
| A08-4 | P3 | Fixed | Memory processing mislabeled truncation | Memory's difference label explains loaded text processing truthfully. |
| A09-1 | P1 | Fixed | Permission steals focus and Enter behind modal | Active modal ownership blocks permission focus and shortcuts. |
| A09-2 | P2 | Fixed | Deny row promises feedback it does not collect | No longer promises feedback collection on a simple refusal. |
| A09-3 | P2 | Fixed | IME confirmation submits unfinished Other answer | IME composition guards preserve unfinished Other input. |
| A09-4 | P2 | Fixed | Permission dismissal drops keyboard focus | Dismissal restores connected prior focus when the card owned it. |
| A10-1 | P1 | Fixed | Palette typing stops task in underlying dialog | Tasks shortcuts only run while Tasks owns the modal keyboard. |
| A10-2 | P2 | Fixed | File submenu keys invoke parent default action | Child file actions retain their activation keys; Left restores host focus. |
| A10-3 | P2 | Fixed | Palette buttons do not activate via keyboard click | Palette results activate through Click with selection aligned to focus. |
| A10-4 | P2 | Fixed | Session Copy flyout extends offscreen | Copy flyout flips left near the viewport edge. |
| A11-1 | P2 | Follow-up | Narrow split composer controls and menus clipped | Source-confirmed narrow-split layout risk. Reproduce with populated 20/80 panes and open composer menus before choosing minimum widths or responsive controls; page captures did not exercise this state. |
| A11-2 | P3 | Fixed | Frosted Analytics overrides reduced motion | Reduced-motion CSS wins over frosted Analytics animation selectors. |
| A12-1 | P1 | Fixed | History recall loses original unsent draft on remount | App owns per-session history navigation; storage recovers the original draft. |
| A12-2 | P1 | Fixed | Held never-sent prompt lost on renderer reload | Held text is recovered as an unsent draft, without automatic submit replay. |
| A12-3 | P2 | Fixed | Question answer progress resets on remount | App owns per-session/request question step and answers; resolved requests clear them. |
| A12-4 | P2 | Fixed | Delayed edit reply overwrites newer composer | Delayed Edit/Branch restoration preserves current text, paste entries and attachments. |
| A13-1 | P2 | Follow-up | Initial renderer load failure misses recovery | Source-confirmed initial-load recovery gap. Requires an isolated native Electron first-document failure test and main-process recovery wiring. |
| A13-2 | P2 | Fixed | Multi-image drop attaches only the first distinct file | Distinct dropped images are prepared and attached serially. |
| A13-3 | P3 | Follow-up | Editor opening loses citation line and column | File opening preserves literal filename containment, but editor line/column navigation remains a capability gap. Requires editor-specific host launch support. |
| A13-4 | P3 | Follow-up | Folder links offer unsupported Finder actions | Folder links can advertise unavailable file-opening actions. Preserve the current host regular-file policy; a directory-aware availability contract is follow-up work. |
| A14-1 | P2 | Fixed | Dock eviction reconstructs older agents as newly finished | Bounded terminal history retains current-source run identity; cold restoration uses saved source anchors and completion evidence. Unordered completion, Clear and later resume/completion were exercised. |
| A15-1 | P2 | Fixed | Pending export never fails when its engine exits | Pending exports fail after engine termination; already-ready text remains readable. |
| A15-2 | P2 | Fixed | Settings inventory failures have no retry | Settings inventory failure offers Retry with stale-request suppression. |
| A15-3 | P2 | Follow-up | Diagnostics save failure is silent | Diagnostics save conflates cancellation with write failure. Requires a host/preload result contract that distinguishes them and both renderer consumers showing real failure. |

## Verification

Behavioral regressions were exercised before repairs at the real reducer, React component/DOM, rendered output, or host-file boundary. Focused suites cover routing, keyboard arbitration, draft storage/remounts, full plan rendering, permission ownership, composition, settings writes/retries, quota/result presentation, transcript output/link/search, and inventory redaction. The root also exercised actual App export interleavings, late Edit restoration, question remount/resolution, and pagehide recovery without submit replay.

A frozen initial baseline at `eee500463cfa24a3f91c8989458d64353e24eec4` ran 5,767 desktop tests: 5,755 passed, 3 skipped, 9 failed. The failures were idle-park quit bookkeeping, two effective-effort assertions, and six CreatePeer cases requiring absent authentication. Another session's committed runtime repair resolved the quit failure. Final checks use a clean snapshot of `be95038e58a4207ff782c35b0c862535e4164d60` plus 70 explicit task-owned paths, with isolated configuration and blank model credentials. Unrelated dirty shared-tree changes are excluded. The exact final baseline's three affected files ran 116 passing and eight failing tests. The final package run completed 5,851 tests across 393 files in 215.20 seconds: 5,840 passed, three skipped, eight failed. All eight failure identities match the exact baseline: two effective-effort cases in `app/sidecar/runControlsDomain.test.ts` and six CreatePeer cases in `app/sidecar/createPeerTool.test.ts`. There are no additional failures; the package suite is not fully green.

| Final check | Result |
|---|---|
| Desktop tests, isolated snapshot | 5,840 passed, three unchanged skips, eight exact baseline failures; no new failures |
| Desktop typecheck and Fast Refresh lint | Passed after review fixes |
| Sidecar typecheck | Scoped pass after review fixes; 5,573 existing upstream diagnostics excluded |
| Renderer production bundle | Passed after review fixes; existing large-chunk warning remains |
| Implementation review | Four lenses completed; seven findings corrected and symptoms re-executed |
| Documentation links/maps/whitespace | Passed: 17 maps, zero warnings; owned diff has no whitespace errors or unresolved local links |

## Visual evidence and limits

The existing never-shown Electron capture harness produced 18 Chromium page captures across Welcome, Goals, Accounts, Analytics and Settings categories at 1100x720 and 900x600. It used isolated app configuration and no engine sessions. Anthropic account metadata was read-only from the shared vault; captures stayed in temporary storage and no account identifiers are included in this report. No login, token refresh, account mutation, or model call was performed.

These captures cover default dark-theme page presentation and empty states. They do not cover populated long transcripts/charts, all themes/accents, the narrow split composer, native screen-reader behavior, Finder drag events, physical keyboard default activation, or real failure timing. DOM tests prove event routing and component state, not native visual acceptance.

Native follow-up checks: use a restarted development app; focus split pane B and close it with Cmd+W; activate tab/menu/palette buttons with Enter/Space; open the palette over Tasks and type k; receive a permission while a modal is open; review a plan with prose/code/rollback notes; compose with IME; drop two distinct screenshots; revisit a partially answered question and a recalled draft; open full diff output and search repeated long-line matches; open menus in narrow splits and at the right window edge. Live account and host-save checks require deliberate operator-controlled failure cases.

Draft recovery keeps the existing 32-draft/20,000-character bounds and version-1 string storage. Images and opaque picked-file tokens remain memory-only across a full reload; held text returns for review instead of being automatically sent. Diff inspection includes all content retained by the existing primary-file projection and cannot recover files omitted upstream. Cold dock suppression needs matching retained source identities or independent later task evidence; an entirely missing source join cannot establish which absent runs were previously capped without additional durable metadata.

## Follow-up scope

- **A03-3:** Existing capability gap: multi-file patches still expose the projected primary file. A separate projector/presentation change must preserve all file identities and bounded output.
- **A11-1:** Source-confirmed narrow-split layout risk. Reproduce with populated 20/80 panes and open composer menus before choosing minimum widths or responsive controls; page captures did not exercise this state.
- **A13-1:** Source-confirmed initial-load recovery gap. Requires an isolated native Electron first-document failure test and main-process recovery wiring.
- **A13-3:** File opening preserves literal filename containment, but editor line/column navigation remains a capability gap. Requires editor-specific host launch support.
- **A13-4:** Folder links can advertise unavailable file-opening actions. Preserve the current host regular-file policy; a directory-aware availability contract is follow-up work.
- **A15-3:** Diagnostics save conflates cancellation with write failure. Requires a host/preload result contract that distinguishes them and both renderer consumers showing real failure.

## Implementation review

The requested `review-impl` pass used four lenses: correctness/concurrent lifecycle, contracts/security, conversational requirements, and executing effect/evidence. Scope was the saved task-owned diff, excluding unrelated engine/runtime/report changes. All five risk signals applied. The evidence reviewer independently ran 1,034 focused tests across 41 suites, then executed 12 representative production-owner reverts/mutations that produced 25 intended regression failures and two passing controls. A failure in an early composite assertion was not treated as proof of its later assertions. The spec lens found no additional intent mismatch.

Coordinator triage was recorded before fixes: **seven findings, two HIGH, three MEDIUM, two LOW; five user-visible and two internal. Four VALID and three INHERITED were fixed. No new deferred or false-positive findings.** The original six audit follow-ups above remain open. These review findings strengthen repairs already in the 48 audit rows; the counts should not be added as distinct original audit findings.

| ID | Severity / impact | Owner | Confirmed problem | Correction and executed proof |
|---|---|---|---|---|
| R1 | HIGH / user-visible | App composer restoration and history persistence | Held/refused/recalled restoration merged into displayed history and left navigation active, omitting unsent text on reload | Restore into the original live draft, reset history on restoration/retirement. Actual App held H + draft D + history + exit + pagehide/remount preserved H and D without send replay. Refused recalled submission and queued recall siblings discriminated old/fixed behavior. |
| R2 | HIGH / user-visible | Extensions diagnostic sanitizer | Mixed-case HTTP(S) schemes bypassed redaction in loaded and error-only plugin rows | Case-insensitive matching. Twelve real projection matrix cases: eight intended failures before, all 25 owner tests passed after. Independent production probe removed fake userinfo/query/hash in every branch. |
| R3 | MEDIUM / user-visible | Settings inventory readback | Independent successful writes could finish in reverse order and leave a saved value rendered stale | Separate inventory read generation from latest-operation feedback. Reversed commit and delayed older-read DOM cases pass; original probe renders both final saved values. |
| R4 | MEDIUM / user-visible | Dock cold restoration | Completion order differed from launch order, resurrecting an evicted agent after Clear/reload | Use the last evidenced source position and newest retained completion; allow independent later task/run evidence. Real storage cold-Clear regression and original probe show no resurrected agent; delayed completion/resume positive controls pass. |
| R5 | MEDIUM / user-visible | Plan Markdown links | New workspace links requested a window that the host denies | Unsupported file/fragment/HTTP destinations remain readable text; HTTPS retains external anchors. Real Plan rendering plus production window policy probe confirms route availability. |
| R6 | LOW / internal | PermissionQueue sibling tests | Three assertions still required the removed feedback promise | Retained allow/refusal count assertions with the exact rendered No label; suite passes. |
| R7 | LOW / internal | Glass ground source guard | Descendant code-block background was mistaken for full-area ground | Match direct ground utility tokens. Current suite passes; removing a real WorkspacePanels ground marker in scratch still causes the intended failure. |

Provenance: three brittle source-text guards were replaced by actual drop, task-interaction and App pagehide/storage/remount checks. No tests were skipped, dependency/lockfile/build/CI/agent-rule changes added, or test-only production seams introduced. The older-settings-feedback fixture now preserves an acknowledged durable value on subsequent reads, while keeping all prior feedback/value assertions. The glass guard still discriminates a missing real ground marker.

Behavioral corrections are reachable through the production App/component/state owners and their symptoms were re-executed. The final clean snapshot repeats the applicable package gates. Coverage is thinner for native startup/failure timing, OS dialogs/clipboard/drag, AX/physical key defaults, populated large layouts, themes and accents. Those effects remain **UNPROVEN**, with operator steps below; a passing mocked bridge or DOM test does not establish the native hop.

Additional acceptance steps in a restarted isolated development app: hold a prompt while connecting, type another draft, recall history, fail the connection, then quit/reopen; submit a recalled prompt and force a matching refusal before reopening; take back queued text while browsing history; make two different settings writes settle out of order and compare their displayed saved values; reopen existing out-of-order history with more than 128 completed agents, Clear, reopen and resume one agent; review a plan containing local paths, section references and HTTPS links; load a malformed plugin fixture with mixed-case fake credential URLs and inspect its sanitized diagnostic. Use existing fixture history for the large dock case rather than spending quota to create it.
