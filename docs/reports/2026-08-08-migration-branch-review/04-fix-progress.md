# High/Medium fix progress — 2026-08-09

This is a live implementation ledger for the review. The original scope reports
remain historical evidence; this file records only fixes made after the review
and their verification. Entries are appended as checkpoints land.

**Progress: Fix 31/242** — counted against the review's original 61 High and
181 Medium findings. A checkpoint can resolve related findings together; the
count tracks individually verified findings, not commit count.

| Review finding(s) | Status | Implementation commit | Verification |
|---|---|---|---|
| A12 HIGH bypass-permissions launch gate | fixed | `82a43ae` | `sidecarServer` focused boundary tests |
| S04 / X02a credential-vault permissions and atomic Claude credential persistence | fixed | `7dced85`, `fd8e5eb`, `7744aa2` | focused account-pool tests; root development build |
| S07 / X02a transcript tombstone concurrency | fixed | `d2d35bb` | focused session-storage tests |
| X02a plugin-registry durability | fixed | `45d93d6` | focused plugin-registry tests |
| A09 host registry lost updates and restart rate cap | fixed | `4957f31`, `fab3254` | focused host registry/restart tests |
| A08 malformed frame session-id rejection | fixed | `dbb8e0a` | focused host IPC tests |
| S08 HIGH `--bare` policy bypass | fixed | `39f34c5` | Claude and GPT prompt-policy tests |
| A11 credential-bearing extension endpoint/hook details | fixed | `4401961` | sidecar extension snapshot tests |
| A02/A10 private sidecar socket allocation | fixed | `c8200f5` | focused supervisor test; app typecheck and renderer build |
| S02 HIGH mailbox truncate-write | fixed | `5baaaf8` | `teammateMailbox` suite (35 pass) and development build |
| A06 rejected-frame request correlation | fixed | `bc10e96` | focused protocol tests; app typecheck and renderer build |
| A12 HIGH restored-agent catalog; A12 MED restored goals/state and worktree cwd | fixed | `30d97ee` | app typecheck; controller + real-process resume probes (18 pass) |
| A12 MED subagent restore fan-out/budget; related replay dedupe/oversized-branch behavior | fixed | `71d0309` | app typecheck; `subagentHistory` suite (13 pass) |
| A12/A14 MED catalog failure diagnostics and unbounded transcript run-facts reads | fixed | `7c885b0` | app typecheck; catalog + run-facts suites (48 pass) |
| A03 HIGH removed sidecar connections can still submit late frames | fixed | `c4fa7c9` | app typecheck; focused regression passes (full boundary suite: 193 pass, 3 pre-existing account-snapshot failures) |
| A15 HIGH rejected/undeliverable session actions are invisible | fixed | `a0485b0` | app typecheck; session-action state/dialog suites (40 pass); renderer build |
| A05 HIGH replayed tool-result-only frame invalidates transcript projection caches | fixed | `f29949d` | app typecheck; full transcript-projector suite (74 pass) |
| S02 HIGH mailbox acknowledgement retry can redeliver one message per poll | fixed | `6408091` | poller suite (11 pass); mailbox suite (35 pass); focused lint; app typecheck |
| S02 MED mailbox lock stale/compromise handling | mitigated (not counted) | `6408091` | 60-second stale window and compromise logging; an explicit post-compromise recovery path remains |
| S02 MED unrenderable permission requests are acknowledged while the worker waits forever | fixed | `44347f7` | callback-registry regression (1 pass); poller + mailbox suites (46 pass); focused lint; app typecheck |
| S02 MED unacknowledgeable structured mailbox entries pin idle pollers | fixed | `7f8d65b` | poller + mailbox suites (46 pass); focused lint; app typecheck |
| A15 HIGH bulk export hangs when a session dies before its first result; related stale lifecycle reset can prematurely save a partial export | fixed | `3e38524` | session-action dialog/runtime suites (41 pass); app typecheck; renderer build |
| S03 HIGH post-launch spawn failure leaves a teammate running but unaddressable | fixed | `330089d` | spawn lifecycle regression (3 pass); focused lint; app typecheck |
| S03 HIGH pane teammate reports success when initial task-prompt delivery fails | fixed | `1768c62` | spawn + mailbox suites (38 pass); focused lint; app typecheck |
| S03 HIGH team-file reads can observe torn JSON during a write | fixed | `cb7e9c6` | swarm + mailbox suites (51 pass); focused lint; app typecheck |

## Known verification limitation

The full real-process sidecar restore/supervisor probe reaches Unix-domain
socket bind, which this sandbox denies. The resume and controller probes pass;
the socket-dependent process probe must be rerun in an environment that permits
Unix socket binding. GUI hardening verification is also still outstanding.

## Next active review item

Continue auditing the remaining confirmed High findings, prioritizing correctness
and security boundaries over structural refactors.
