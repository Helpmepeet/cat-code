# High/Medium fix progress — 2026-08-09

This is a live implementation ledger for the review. The original scope reports
remain historical evidence; this file records only fixes made after the review
and their verification. Entries are appended as checkpoints land.

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

## Known verification limitation

The full real-process sidecar restore/supervisor probe reaches Unix-domain
socket bind, which this sandbox denies. The resume and controller probes pass;
the socket-dependent process probe must be rerun in an environment that permits
Unix socket binding. GUI hardening verification is also still outstanding.

## Next active review item

Continue auditing the remaining confirmed High findings, prioritizing correctness
and security boundaries over structural refactors.
