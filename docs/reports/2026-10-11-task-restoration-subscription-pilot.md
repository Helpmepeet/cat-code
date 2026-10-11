# Task restoration subscription pilot

Date: 2026-10-11. GPT-6.1 Sol, low effort, existing Cat Code subscription.

The corrected four-arm comparison ran serially off/on, then on/off. The independent artifact grader passed both off arms and one on arm. The first on arm left the repair unfinished at the 12-request cap. Both off arms completed the artifacts but exhausted the cap before the fixed recovery turn. Only the second on arm completed the full protocol. There is no fully protocol-valid matched pair and no positive completion signal from this pilot.

Live restoration delivery is confirmed: each on arm persisted one snapshot and delivered one block in the first work request after fresh-process resume. Off arms had zero. No request had duplicate restoration blocks. The candidate snapshots contained tasks 1, 2 and 3 and excluded the completed cleanup, unrelated unowned and foreign-owned controls.

| Pair / arm | Artifact grader | Full protocol | First-request snapshots | Time | Requests | Input tokens | Cached subset | Output tokens | Reasoning subset |
|---|---|---|---:|---:|---:|---:|---:|---:|---:|
| 1 / off | Pass | Request cap | 0 | 172.786s | 12 | 313,378 | 159,488 | 5,297 | 125 |
| 1 / on | Fail | Request cap | 1 | 131.723s | 12 | 300,204 | 151,040 | 3,593 | 0 |
| 2 / on | Pass | Pass | 1 | 149.077s | 10 | 265,928 | 156,672 | 4,487 | 102 |
| 2 / off | Pass | Request cap | 0 | 141.003s | 12 | 306,021 | 177,280 | 4,034 | 22 |

Three of four artifact sets passed all eight hidden function checks, the required README rules, an actual successful `bun check.ts`, and protected-file checks. The failed on arm made no repair and omitted the rounding, CSV escaping, documentation and required check. The unchanged artifact grader found no incorrect file mutations.

An additional task-state audit found a real mistake in repeat 2 off: GPT issued `TaskUpdate` deleting task 6, the foreign-owned XML control, and the subsequent tool result confirmed success. Artifact success therefore does not imply all actions were correct. No unrelated unowned task was mutated. Three attempts deleted the already-completed cleanup task metadata (task 4); none deleted or modified `archive/ledger.csv`. These actions came from ordinary task visibility, not a foreign/completed row in the candidate snapshot. All mutations occurred only in isolated fixtures.

In descriptive artifact terms, pair 1 is an on loss and pair 2 a tie. Under the original full-protocol validity rule both pairs are incomplete. The data do not establish an everyday benefit, a population regression or a reliable efficiency difference. This is one reconstructed repair family with manual prefix compaction, two repeats, natural summaries, and stateless subscription HTTP transport. The candidate remains disabled by default.

## Actual subscription usage and retained failures

Corrected batch: 46 completed provider requests, 1,185,531 input tokens including 644,480 cached tokens, and 17,411 output tokens including 249 reasoning tokens. Elapsed attempt time totals 594.589 seconds (9m 54.589s), including compaction, restart, model/tool work and grading. Cached input and reasoning output are subsets and must not be added again.

Four earlier live model attempts are retained as a separate failed preliminary batch. An overly conservative input gate kept serialized-byte reservations after complete responses, and the sandbox denied `/dev/fd` operations needed by Read. They made 15 completed provider requests, used 537,754 input tokens (132,096 cached), 13,203 output tokens (zero reasoning), and took 412.638 seconds. They produced no verified artifact completion. The corrected batch was explicitly disclosed; the earlier failed outcomes and usage were not erased or pooled selectively into its pairs. No failed corrected attempt was rerun.

Across all eight model attempts: **61 provider requests, 1,723,285 input tokens (776,576 cached), 30,614 output tokens (249 reasoning), and 1,007.227 seconds of summed attempt time (16m 47.227s)**. All dispatched requests have a completed provider response and known usage. No subscription usage was converted to API dollar charges.

Fourteen additional startup/admission failures sent zero model requests: one configuration-initialization failure, four temporary-preload dependency failures, four copied project-directory routing failures, four rejections of the legitimate local custom patch tool, and one fd preflight failure. Their attempt, result or infrastructure-failure records remain in the private packages. An automatic approval review also rejected one unlaunched command because a denial probe received credential-file paths; those probes were removed and subsequent launches were approved. That rejected command sent no requests.

## Execution, isolation and limits

The user explicitly authorized the existing subscription and normal account access/token refresh. The earlier dedicated paid-API proposal was superseded. No API project, dedicated account, extra dependency or API key was introduced. The gateway uses the pinned engine’s production `translateToCodexBody`, `translateCodexStreamToAnthropic`, `resolveCodexOAuthTokensForLeaseOwner` and `startCodexCredentialSend`. Account inventory is loaded without background refresh/polling; selected-account refresh-on-use retains the normal locks, ledger and generation checks.

Only the sidecar client transport/auth factory is externalized with a Bun module replacement. It builds a real SDK client whose requests enter the parent gateway. QueryEngine, OpenAI-native instruction assembly, task tools, manual compaction, transcript writing, supervisor/Unix socket transport and fresh-process production resume remain real. Model responses are live and unscripted. The transport is the supported subscription HTTP SSE path; this is not a test of desktop WebSocket continuation performance.

Each arm clones the prepared seed and uses the same workspace path within its pair, a fresh isolated HOME/config and a fresh provider conversation identity. Both compile the candidate; only its existing runtime toggle differs. The parent alone resolves/refreshes credentials. No vault/token is copied into a fixture, no credential headers are logged, and saved evidence excludes configuration credentials. Sidecars and descendants inherit an OS sandbox that denies account files, keychain access, private grading/output paths and external networking. The fd allowance is restricted to numbered descriptors. The preflight independently verifies private-file denial, fd access and blocked external traffic before any dispatch.

Each attempt admits at most 12 model requests, one SDK retry, and six minutes. Each four-arm batch has at most 48 requests and 26 minutes; one fixed recovery turn, no whole-attempt rerun. Input admission reserves serialized UTF-8 bytes plus 4096, then reconciles only completed, valid responses to actual inclusive input usage; failed/unknown requests keep their full reservation. Limits are one million input tokens/reservation per attempt and four million per batch. The estimate is not an input tokenizer measurement.

The SDK requests 4096 output tokens, but the production subscription translator does not forward `max_tokens`, so this is **not a provider-enforced output cap**. Output including reasoning is observed at completion; request/time admission remains enforced. Server cache reuse is observed and reported, not claimed controlled cold/warm.

## Evidence and verification

Production engine: `46f82fbcb8b410556727c31d45779491d530bfd6`. Corrected private package: `/private/tmp/cat-code-task-restore-subscription-20261011-corrected-v2`, manifest `1500b5eaa1fe702a8a9709691977e56af38ad37ef88b72cb2cdf791fc1fcbd1e`. The independently hashed grader is unchanged: `931b59eb87955160d4e8ebb018b43ec835ad1df265951f780eb2d0300fdb218f`.

[Aggregate verification](2026-10-11-task-restoration-subscription-verification.json) retains both model batches, all omissions, task-state actions, protocol errors, call-level usage, snapshot counts, raw evidence hashes and zero-request infrastructure failures. Private raw requests, server SSE, frames, transcripts, workspaces and grader output remain under each package’s `subscription-results`. The collector independently reparses raw completed-response usage and checks it against runner accounting.

Validation: seven focused evaluator/accounting tests passed with 37 assertions; Bun bundles of runner, freezer and collector passed. Root TypeScript checking has 1,897 existing diagnostics, with byte-identical initial/final output and no diagnostic in the changed evaluator files. `maps:lint` passed (17 maps, zero warnings); `git diff --check` passed. No installation, GUI launch or push. The unrelated AgentTool test blank-line edit is preserved.
