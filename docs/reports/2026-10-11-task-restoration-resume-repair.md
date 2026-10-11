# Task restoration after fresh-process resume

Date: 2026-10-11. Production repair committed locally as
`46f82fbcb8b410556727c31d45779491d530bfd6`. No live model calls, live credentials,
install, GUI launch or push. The unrelated AgentTool test edit is preserved.
The opt-in candidate remains disabled by default.

## Cause and repair

The omission was in production transcript selection, not the evaluator.
[`loadTranscriptFile`](../../src/utils/sessionStorage.ts) selected an assistant
tip inside the suffix retained by prefix compaction. The compact boundary's
logical parent belonged to the summarized prefix, so the existing parent/root
test rejected that boundary as an active continuation. Resume selected the old
tip; subsequent compact summary, local command messages and restoration
attachment were excluded from the outgoing history. The attachment was on disk.

The reader now follows a compact boundary that demonstrably preserves the
selected tip in the same session. It uses the existing resolved preserved-segment
UUIDs, with the existing legacy tail fallback. It does not widen ancestry to
discarded branches, introduce persisted fields or change prompt generation.
The existing reader test was extended with summarized, explicit preserved and
legacy preserved cases. The preserved case failed on the old code and passes
with the fix. No substantial redesign was necessary for this delivery failure.

## Observed failure and corrected delivery

The runner exercised `SidecarSupervisor -> Unix socket -> sidecar -> QueryEngine`,
normal task tools, manual prefix compaction, durable transcript persistence,
supervisor shutdown, and fresh-process production resume. Only transport
responses were scripted. Request bodies were captured at the provider boundary;
persisted attachments were independently counted from transcripts.

| Fresh-process on arm | Persisted snapshots before | First request before | Persisted snapshots after | First request after |
|---|---:|---:|---:|---:|
| Repeat 1 | 1 | 0 | 1 | 1 |
| Repeat 2 | 1 | 0 | 1 | 1 |

The exact comparison retained the original seeds, evaluator, dependency content
and schedule; only the source repair was overlaid. Copied project/configuration
paths were rebased consistently in both arms. All 16 attempts were valid and
passed independent artifact grading before and after. This deliberately shows
that scripted completion alone could miss a delivery defect.

A separate, newly prepared frozen package strengthens the negative controls:
cancellation now crosses process restart; the completed task has a successful
tracked TaskCreate in the summarized history and a completed status on disk;
an unrelated unowned pending task tests evidence scoping independently of the
foreign-owner control. All 16 attempts passed. Across the 32 repaired attempts:

- Each on-arm unfinished-work request received one restoration snapshot after
  compaction, both in process and after restart; off arms received zero.
- No request contained two restoration snapshots. Cancellation/review and
  ordinary short-conversation arms received zero candidate snapshots.
- Candidate snapshots excluded completed, unrelated unowned and foreign-owned
  tasks. Independent artifact checks found no cancelled mutations, archive
  deletion or replacement export format.

These assertions concern the candidate restoration block. Existing normal
task-list reminders can include completed rows; their presence elsewhere in a
request is not a restoration revival. The unchanged hidden grader hashes the
required artifacts and validates check execution independently of the reminder.
No task model-behavior improvement follows from scripted transport results.

## Frozen evidence and validation

The committed [aggregate verification](2026-10-11-task-restoration-repair-verification.json)
records all attempts, raw result hashes and limitations. Private local packages:

| Package | Local root | Manifest SHA-256 |
|---|---|---|
| Reproduced failure | `/private/tmp/cat-code-task-restore-repair-before` | `ad3d9e744733302fee0b7df8eecfe2013d1afd4a157e57ac9c89eaa8dac8d57a` |
| Exact repaired comparison | `/private/tmp/cat-code-task-restore-repair-after` | `a3871c800f45e69f3d12fbb76e971c005e5136797e2fa220989c364f26f15884` |
| Repaired source plus stronger controls | `/private/tmp/cat-code-task-restore-repaired-frozen-v2` | `3fbed50eaf1a79e22d364f2a97bf12d81884ac71e813f3fbc079f7c9d880d01a` |

The final package is prepared from the pinned repair commit, with evaluator
support, Bun binary, installed dependencies, fixture/configuration seeds and
source inventory independently hashed. It was not installed. Grader SHA-256
remains `931b59eb87955160d4e8ebb018b43ec835ad1df265951f780eb2d0300fdb218f`.
The [v2 proposal](../../scripts/harness-design-eval/task-restore-manifest.v2.json)
pins this lock and verification hash; proposal SHA-256 is
`3d0b4a588812d9d5dbb37188ad3f6cd57fe3c0541d2ea368047756ff3f1fb9d9`.

Raw provider requests, transcripts and grades live under each package's
`offline-results`. The independent analysis command was
`bun /private/tmp/verify-task-restoration-repair.ts`; its content hash is in the
aggregate. The final real-path run was:

```sh
bun scripts/harness-design-eval/task-restore/run.ts /private/tmp/cat-code-task-restore-repaired-frozen-v2 --offline
bun scripts/harness-design-eval/task-restore/collect.ts /private/tmp/cat-code-task-restore-repaired-frozen-v2/offline-results
```

Initial listener denial, dependency symlink drift and an incorrectly rebased
copied seed were retained as infrastructure failures. They dispatched no model
requests and are not silently counted as successful trials or model outcomes.

Validation used temporary HOME/configuration and disabled nonessential traffic:

- Storage suite: 74 passed. Candidate restoration suite: 5 passed, 36 assertions.
- Evaluator: 5 passed, 33 assertions, including live refusal before any manifest
  or credential path is read.
- Broader storage/compact/reactive/auto/query checks: 173 passed, 1 skipped,
  2 failed. The pre-fix frozen baseline has the same two failures (171 passed):
  stale Sonnet model expectation and an unrelated cua-driver permission mock.
- `build:dev:full` passed, including maps, lint, undefined names and dev bundle.
  Root typecheck has 1,897 diagnostics on both baseline and repaired source,
  unchanged after normalizing line offsets and source-root paths.

The test-audit authoring gate was applied: reader coverage protects durable
selected-history composition and detects the actual omitted continuation;
provider-boundary evidence separately protects process delivery. Existing
table-driven coverage was extended, no production test seam added, and grading
was not weakened. The live admission assertion protects a distinct authorization
boundary. OpenClaw-specific skill commands are absent here; repository Bun
checks were used. No broad test audit or unrelated test cleanup was performed.

## GPT-6.1 Sol pilot proposal only

Historical authorization state below. The user subsequently authorized Cat
Code subscription usage and normal account refresh. The subscription extension
and actual four-attempt outcomes are recorded in
[the pilot report](2026-10-11-task-restoration-subscription-pilot.md). This earlier
paid-API proposal did not constrain the newly authorized subscription route.

The user's daily model is GPT-6.1 Sol, and the user chose to leave execution
blocked. Cat Code catalogs and routes it through Codex OAuth. That route does
not establish dedicated OpenAI API project access. The existing evaluator
accepts only Anthropic Messages and cannot test GPT by changing a model string.
[Official model documentation](https://developers.openai.com/api/docs/models/gpt-6.1-sol)
documents Responses/tool support and low reasoning effort. No account access
was probed.

A paid GPT implementation needs separately scoped Responses transport,
admission, usage/cache accounting and durable budget integration while preserving
the real sidecar/resume path. That expansion was not undertaken. The current
runner refuses all live execution before reading manifests, approvals or keys.

Exact schedule: pair 1 off then on; pair 2 on then off. All four attempts use
`task-resume`, `gpt-6.1-sol`, Standard/default global tier, standard reasoning
mode, low effort. Each arm clones the same frozen seed within its pair, obtains
a natural manual-prefix summary, shuts down, then resumes in a new process
before the first work request. Both compile the candidate; only its runtime
toggle differs. The independent hidden artifact grader remains unchanged.

[Current API prices](https://developers.openai.com/api/docs/pricing), checked
2026-10-11, in USD per million tokens:

| Input context | Input | Cached input | Cache write | Output |
|---|---:|---:|---:|---:|
| At most 272K | 2.00 | 0.10 | 2.50 | 10.00 |
| Above 272K | 4.00 | 0.20 | 5.00 | 15.00 |

Proposed ceilings: $6 per attempt, $24 total pre-tax API charges; 12 inference
requests per attempt, 48 total including summaries/helpers/retries; 1,000,000
actual input tokens per attempt, 4,000,000 total; 4,096 output tokens per request
including reasoning; one API retry, one fixed recovery turn, no whole-attempt
reruns; six minutes per attempt, 26 minutes total. No hosted paid tools or
fast/ultrafast, regional, pro-reasoning or alternative-model modifiers.

An enforceable proposal requires a serial sole-key-holding gateway with a
durable fsynced reservation ledger before dispatch. Charge every input token
at the highest $5/M long-context cache-write rate and reserve every output cap
at $15/M. Never refund reservations for failed/incomplete calls. Under verified
token/output admission the worst-case model-token bound is
`4,000,000 × $5/M + 48 × 4,096 × $15/M = $22.94912`
($5.73728 per attempt). All ancillary charges must fit within the same $24 cap.

The [Responses input-token count API](https://developers.openai.com/api/reference/resources/responses/subresources/input_tokens/methods/count)
must count the exact final stateless input, including instructions, tools and
retained reasoning. Hidden server history and changes after counting must be
rejected. Count-call billing must be established and reserved before execution;
a byte estimate is not proof of a billable-token bound.

Use a dedicated project with no other workload and an enforced $24 project
limit. [OpenAI spending-limit documentation](https://developers.openai.com/api/docs/guides/spend-limits)
distinguishes enforced limits from alerts and says enforcement can lag and
overshoot. This is a backstop; the local conservative admission bound is also
required. Neither spending control is verified or implemented for this GPT
proposal. Unknown usage, delivery gaps/duplicates, incorrect actions, pricing
drift or broken isolation must stop execution without replacing attempts.

The [authorization example](../../scripts/harness-design-eval/task-restore-gpt-authorization.example.json)
is deliberately unapproved. Execution requires separate implementation and
offline final-Responses-boundary proof, confirmed project access/rates/count
billing/limits, a newly frozen runnable digest, and explicit human approval of
that digest. This proposal digest cannot authorize live execution.

Exact proposed spending authorization:

> After the runnable GPT package and spending controls are independently verified and its new manifest digest is explicitly approved, authorize only the four serial task-resume attempts in this schedule on gpt-6.1-sol, Standard/default tier, standard reasoning mode, low effort, maximum 24 USD pre-tax API charges total and 6 USD per attempt, 48 inference requests including summaries/helpers/retries, 4096 output tokens per request including reasoning, one fixed recovery turn, at most one API retry, no whole-attempt reruns, and a 26-minute suite cap. Use only a dedicated OpenAI API project/key with an enforced 24 USD project limit and verified durable local admission. No Codex account/vault use, installs, GUI, push, default changes or other paid services. No live authorization is granted now.
