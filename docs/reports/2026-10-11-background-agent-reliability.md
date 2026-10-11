# Background agent reliability

Ten subagent assignments investigated existing orchestration and recovery
boundaries. Five concrete defects were reproduced and repaired. Three discovery
lanes found sufficient existing safeguards and made no changes; two independent
validation lanes checked the original and repaired owners.

## Confirmed defects and repairs

| Defect | Reproduction and resulting behavior | Production owner |
|---|---|---|
| Queued input failed without a visible outcome | A framed mid-turn submit was accepted, then its fallback turn rejected. Previously clients received no error. Terminal rejection now reaches every attached reader through the existing error frame. Input not yet acknowledged gets one retry; acknowledged input is never retried. | `app/sidecar/sidecarServer.ts` |
| Failed or stopped worker output was lost during finalization | Restoring the persisted prefix while the real lifecycle was paused at cleanup recovered zero failed/stopped outcomes. The existing terminal notification now preserves partial output, error/status, and undelivered instruction reports before awaited bookkeeping or cleanup. Parent persistence deduplicates subsequent restore. | `src/tools/AgentTool/agentToolUtils.ts` |
| Peer creation bypassed the existing pending cap | Other senders filled a newly addressable peer's 50 slots before its host creation call resolved. Its opening prompt became message 51. Creation now uses the existing slot guard and reports the existing `failedStep: 'prompt'` when full. | `app/main/peerRequestPlane.ts` |
| Compaction dropped queued input from recovery | A real 5,248,199-byte transcript retained waiting text/images before compaction, but cold resume lost their enqueue records. Queue recovery now reads archival history with the existing `keepCompactedHistory` option. Consumed/recalled input stays absent and the model seed stays compacted. | `src/utils/sessionStorage.ts` |
| Failed handshake left an unreachable engine alive | Missing engine identity or a frame before ready marked a sidecar failed while its tracked PID remained alive. Both branches now use the existing termination helper, including its forced-kill fallback. | `app/supervisor/supervisor.ts` |

These are local repairs using existing state, formats, limits, and helpers.
There are no new dependencies, protocol versions, durable fields, exported test
seams, or orchestration frameworks. The five production owners have a combined
net increase of 35 lines after the review repair below; the remaining code
changes extend existing tests and their transcript/process fixtures.

## Assignment outcomes

| Lane | Outcome |
|---|---|
| 1. Local worker instruction delivery | No confirmed defect; 55 focused tests passed. |
| 2. Worker completion and resume | Repaired failed/stopped outcome persistence; 7 recovery cases with classifier enabled and 54 sibling tests passed. |
| 3. Turn admission and input queues | Repaired terminal queue rejection visibility; 331 owner/sibling tests passed. |
| 4. Workspace handoff recovery | No confirmed defect; 35 tests passed, including real checkpoint and cold-sidecar restoration. |
| 5. Desktop peer delivery | Repaired creation cap bypass; 98 owner tests and one real socket probe passed. |
| 6. Transcript recovery | Repaired queue ledger loss across compaction; 111 focused tests passed, including separate cold processes. |
| 7. Host restore and process lifetime | Repaired orphaned failed-handshake processes; 25 supervisor and 105 host/parking tests passed. |
| 8. SDK and replay delivery | No confirmed defect; 82 queue/replay/attachment tests passed. |
| 9. Independent durable acceptance proof | Original source failed the three worker-finalization cases and large-compaction recovery case; repaired source passed. Also found the internal loader type omission, which was corrected. |
| 10. Independent concurrent boundary proof | Original source failed queued rejection visibility, peer cap, and process-death assertions; repaired owners passed 430 tests with explicit temporary configuration. |

Counts overlap across assignments and are not a unique-test total.

## Validation and limits

The original production owners were independently compared with byte-verified
`870b7630` source while using the new regression tests. Full desktop validation
uses frozen baseline and repaired snapshots of `eee50046`, preserving a
concurrent renderer merge and excluding live shared-tree changes from the run.
The frozen full-suite comparison completed across 388 files:

| Snapshot | Passed | Skipped | Failed |
|---|---:|---:|---:|
| Baseline `eee50046` | 5,756 | 3 | 8 |
| Baseline plus the eleven owned code/test files | 5,764 | 3 | 8 |

The eight failing test names are identical: two run-controls expectation
mismatches and six CreatePeer cases requiring absent authentication fixture
state. Both groups also reproduce when run separately with temporary
configuration. They were left outside this repair; no new full-suite failures
were introduced.

The dev-full build, changed engine-file lint, desktop typecheck, and scoped
sidecar typecheck passed. Root TypeScript retained the same 1,058 normalized
diagnostic keys as the original baseline, with zero new keys. Local socket
tests required sandbox escalation and used synthetic sidecars.

Worker finalization interruption is proven by pausing the real lifecycle and
restoring its actual saved prefix. This does not establish power-loss/fsync
durability. Queue compaction uses separate cold Bun processes; handshake
termination checks actual tracked process death, including a child ignoring
SIGTERM. Queue recovery reads archival history; memory and latency beyond the
5 MiB fixture were not benchmarked. No GUI or live provider probes were run,
and the installed app was not replaced or restarted.

An independent validation run initially omitted the configuration override and
may have read default 30-day transcript statistics. No live writes or network
probes were observed; its reportable pass counts come from corrected isolated
reruns. Module initialization was not traced at the syscall level.

## Review follow-up

Two further agents reviewed all five repairs with separate source/contract and
execution lenses. The original owner suites passed 439 tests, and each original
regression failed against the earlier production owner. The review found one
high severity result-loss race in the worker repair and the existing completed
path: the lifecycle saved a terminal notification, then awaited worker-state
bookkeeping while its entry remained in the active registry. The parent exit
sweep could append a later `stall-detected` terminal without that notification;
restore selected the latest terminal and omitted the saved output and instruction
reports.

The follow-up unregisters terminal workers immediately after the synchronous
terminal append succeeds, before awaited bookkeeping. It uses the existing
registry helper and reduces production code by two lines. The other four
repairs had no confirmed review findings.

Four new table cases invoke the real exit sweep at the first bookkeeping await
for completed, failed, API-error, and killed outcomes. All four failed against
`69e8d179`; all eleven recovery cases now pass with the classifier enabled,
alongside 80 worker lifecycle, registry, state, and restore tests. The tests use
a microtask to reproduce the exit interleaving deterministically, real terminal
persistence and actual resume/deduplication. They do not run full process
shutdown or establish power-loss durability.

The frozen dev-full build, changed-file lint, desktop typecheck, and scoped
sidecar typecheck passed. Root TypeScript retains the same 1,058 normalized
baseline diagnostics with no additions or removals. Temporary archive builds
lack Git provenance; the changed engine file was linted directly. No GUI or
live provider probes were added.

Final full desktop runs used frozen `69e8d179` baseline and repaired snapshots
with separate temporary configuration and short socket paths:

| Snapshot | Passed | Skipped | Failed |
|---|---:|---:|---:|
| Baseline `69e8d179` | 5,762 | 3 | 10 |
| Baseline plus the review repair | 5,767 | 3 | 9 |

No failing test names were introduced. The nine shared failures include the
earlier eight and a repeated-relocation skill-path expectation, also reproduced
separately on the baseline. A task-subscription test failed only in the broad
baseline run; its 18-test owner suite passed separately on both snapshots.
That pass is not attributed to this repair. The first repaired broad run used
an overly long temporary path and hit four socket-length guards; corrected
short-path runs supply the acceptance totals above.

For full shutdown acceptance, terminate a synthetic parent while a terminal
worker is awaiting bookkeeping, cold-resume its transcript, and verify one
outcome with the saved output and unresolved instructions. This review proves
that interleaving through the real exit sweep and storage/resume owners, rather
than terminating the entire parent process.
