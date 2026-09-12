# PR #22 review follow-up

The user requested independent GPT-5.6-Sol verification of the seven supplied
findings, followed by fresh GPT-5.6-Sol fix passes for confirmed defects. This
follow-up concerns those findings and affected integration paths, not a new
review of every file in [PR #22](https://github.com/Helpmepeet/cat-code/pull/22).

## Validation before fixes

Verified snapshot: `73c4dad393c31abadc9d75c74c3d44828c40beab`; actual PR base:
`2453710d1a1d58cb29a0065b10583d35bfeed2bc`. Three Sol verification agents
executed isolated production-module probes. The orchestrator read their
evidence and relevant caller, persistence, and cleanup paths and accepted all
seven findings before production edits. There are two high-severity and five
medium-severity findings, all with user-visible effects.

Line references in this validation table refer to the reviewed snapshot.

| ID | Severity | Impact | Source | Finding | Verdict |
|---|---|---|---|---|---|
| F1 | HIGH / P1 | user-visible | `src/tools/AgentTool/runAgent.ts:202` | A child cwd substitutes an unapproved MCP configuration for an inherited approved server name. | VALID |
| F2 | HIGH / P1 | user-visible | `src/utils/sessionStorage.ts:4952` | Null-root replacement history after editing the first prompt disappears from cold-resume context. | VALID |
| F3 | MEDIUM / P2 | user-visible | `src/tools/AgentTool/runAgent.ts:780` | Terminal handoff aborts a borrowed parent controller when the child lacks its own controller. | VALID |
| F4 | MEDIUM / P2 | user-visible | `src/tools/AgentTool/runAgent.ts:584` | A startup delivery outcome reaches the first resume but is omitted from persistence and the next resume. | VALID |
| F5 | MEDIUM / P2 | user-visible | `app/renderer/src/composerState.ts:1203` | A known refusal stays hidden behind a later missing reply and cleanup discards the retained input. | VALID |
| F6 | MEDIUM / P2 | user-visible | `src/utils/statsCache.ts:14` | A version-3 session-day cache overlaps the new event-day pass on upgrade. | VALID |
| F7 | MEDIUM / P2 | user-visible | `src/utils/stats.ts:583` | Adding daily session fragments overcounts unique sessions and truncates session duration. | VALID |

### Observed effects

- F1: the unapproved fixture stdio server launched; the approved server's marker
  remained absent. Configuration lookup, connection identity, handshake, and
  child tool discovery were production code.
- F2: a separate cold-resume process constructed the real QueryEngine with zero
  seeded messages instead of the replacement user/assistant pair.
- F3: synchronous terminal handoff aborted the parent with `terminal_handoff`;
  the asynchronous owned-controller control left the parent alive.
- F4: the first resumed request contained the startup outcome and removed its
  queued record, but stored history and the second request omitted it. An
  ordinary SendMessage fact survived both resumes.
- F5: production composer reducers retained a refused text/image submission
  behind a pending submission, then cleanup removed the hidden copy.
- F6: an actual cache produced by the PR base reported 1 session, 2 messages,
  and 200 input tokens. The reviewed head accepted it unchanged and reported
  2 sessions, 3 messages, and 300 input tokens.
- F7: a fresh cache reported 2 sessions and zero duration for one two-hour
  session. Daily rollovers increased the session count from 1 to 2 to 3.

### Verification boundaries

The verification used isolated fixture configuration, harmless local MCP
servers, scripted model output, and synthetic transcripts. It did not access
live accounts or launch Electron. F1 traced, rather than executed, the entire
desktop approval and public AgentTool caller chain. F2 minted the production
rewind persistence effects without invoking the renderer edit action. F3
executed the disabled-background caller shape without invoking the public
environment-controlled caller. F5 executed production reducers and traced App
wiring without mounting React or disconnecting a real sidecar. These are
unexercised integration hops, not additional findings.

The legacy analytics cache contains aggregate-only data. It cannot distinguish
all overlapping available transcript contributions from history whose
transcripts have aged out. Migration must preserve that durable history and
state any irreducible legacy attribution limit; a silent cache reset is not an
acceptable fix.

Local scratch evidence is under
`tmp/pr22-review-followup-2026-09-12/{engine,restore,analytics}/` and is not
committed. Exact-base source archives were moved outside the repository to
avoid duplicate test discovery; their locations and recovery commit are in
`tmp/pr22-review-followup-2026-09-12/snapshot-locations.json`.

## Fix and integration status

F1, F3, and F4 are fixed in `6c17a347` and independently re-executed by the
orchestrator. Named MCP authorization reuses the exact inherited client;
synchronous workers own a controller that follows parent cancellation in one
direction and detaches on setup failure or completion; initial persistence is
selected after startup outcome attachments have been assembled.

The three file-isolated regression suites pass: 6 tests, 40 assertions. The
same committed tests were copied into an external archive of reviewed
production source `73c4dad3`: F1 failed because the substituted server started;
both terminal-handoff tests failed because the parent was aborted; F4 failed
because persisted history and the second resume lacked the startup outcome.
Thus these tests discriminate the fixes from the reviewed implementation.
The parent-cancellation control passed on both versions. The fixed tests also
assert approved tool discovery and exactly one startup outcome in stored
history and the second resumed request.

F2, F5, F6, F7 and final integration verification remain in progress in this
checkpoint. Parent integration inspection found that the first F5 fix reversed
forward-arriving refusals across batches; that implementation is being
corrected before closure. Analytics migration must also account for future
activity in legacy sessions rather than permanently excluding those sessions.

## Additional type baseline validation

Raw root typechecking at the actual PR base reported 1,875 diagnostics, versus
1,906 at the reviewed head. A new integration test imports the desktop sidecar
into the root graph. Adding only that production sidecar import to an isolated
base archive reproduced the 22 additional desktop diagnostics, leaving 1,897
at the base with the same graph. Desktop correctness remains governed by its
separate strict app and scoped sidecar checks.

After normalizing archive paths and checking changed diagnostic text against
the underlying source, nine added occurrences remain: one UUID annotation in
the terminal-handoff cancellation guard, four fetch-fixture annotations, and
four piped subprocess stream annotations. These are validated type-contract
defects in the PR; the cancellation annotation belongs to the F3 fix, and a
separate Sol pass will repair the fixture annotations. Three AgentTool schema
diagnostics changed their printed types but have the same inherited causes.
This comparison supersedes using only the later local baseline for a claim
about the entire PR.
