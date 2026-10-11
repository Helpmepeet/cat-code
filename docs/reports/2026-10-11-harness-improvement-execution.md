# Harness improvement execution

Date: 2026-10-11

Execution baseline: `b0bbbaa94aafbec6b04c009748a0ee74d0619cb3`, branch `main`.
HEAD was verified before work; no reset, branch, worktree, push, installation or
GUI launch was performed. `CLAUDE.md` and the workspace map were read first.
The unrelated blank-line edit in `src/tools/AgentTool/runAgent.test.ts` was
rechecked and left untouched. Validation baselines used a plain `git archive`
of this commit in temporary storage, with dependencies linked from the checkout.

Implementation commits:

- `5c69d686cab389b7de717b002f3628658161f5fd`: sanitized read-only audit, source-policy hashes and aggregate artifact.
- `59771b502e9c7e153c599c4b0860b588542615ad`: gated task restoration, durable reader/restore repair and focused behavior coverage.

The documentation commit following these slices records this report and updates
the original plan. Neither implementation commit stages the unrelated AgentTool edit.

## Decisions

| Workstream | Verdict | Evidence and delivered work |
|---|---|---|
| P0a log audit | Change: completed | Small read-only extractor, verified identity joins, manifest and sanitized report. Coverage limitations are explicit. |
| P0b evaluation support | Keep the minimal offline support; defer generalized live runner | Existing diagnostics plus real compaction/tool/persistence fixtures resolve the reproduced defect. This does not satisfy the plan's full paired desktop runner exit or measure model quality. |
| P1 pressure/cold-boundary elision | Defer | Old-output volume exists, but there are no recorded automatic threshold crossings and only one matched manual boundary in historical builds. No causal cache/recovery savings or verified completions. No projection contract or runtime elision was added. |
| P2 task restoration | Change: implement an experimental candidate; keep default off | Offline reproduction confirmed missing explicit unfinished state on the first request after compaction. Scoped restoration and durable resume now pass. No measured model improvement or default promotion. |
| P3 lean tool interface | Keep full interface; defer experiment | Combined overhead is observable, but tool-schema overhead and interface-related failures cannot be isolated. |
| Repeated-failure nudge/termination | Defer | Logs do not establish repeated equivalent failing actions with unchanged underlying state or recovery cost. |
| Summary slimming | Keep current prompt; defer experiment | Summary-fork markers are not summary request counts or downstream rereading evidence. |
| Recall/storage, automatic diagnostics, every-request planning injection | Keep existing behavior; defer additions | No independently verified failure/cost evidence meeting the respective gates. |

These decisions close the authorized offline execution slices. Live screening,
confirmation and default promotion remain deferred. No authorization request is
pending and no quota-consuming evaluation ran.

## P0a observed cohort

Reproduce with the committed extractor:

```sh
bun scripts/harness-design-eval/audit.ts \
  --debug-dir /Users/pt/.cat-code/debug \
  --projects-dir /Users/pt/.cat-code/projects \
  --production-composition \
  --out /private/tmp/cat-code-harness-audit-2026-10-11
```

The [sanitized JSON](2026-10-11-harness-log-audit.json) records hashes, byte
lengths, event dates and anonymous boundary locations. All inputs were stable
during this read. Rerunning against appended logs need not produce the same
artifact; reproduce exact inputs by their manifest hashes, not current mtimes.
Raw inputs are not committed.

| Observed quantity | Result |
|---|---|
| Non-symlink debug logs / bytes | 128 / 41,478,897 |
| Actual debug event dates | 2026-10-06T05:08:56.137Z through 2026-10-11T09:51:17.431Z |
| Request markers / usage responses | 6,463 / 6,458 |
| Model request markers | gpt-6-luna 3,389; gpt-6.1-sol 2,596; gpt-6-astra 478 |
| Threshold checks / recorded crossings | 4,384 / 0 |
| Effective windows in threshold records | 1,030,000; maximum tokens/threshold 0.6047 |
| Recorded combined non-message overhead | 11,016 through 29,988 estimated tokens |
| Verified main-transcript joins | 44; 84 logs lack a verified main-transcript join |
| Persisted boundaries within matching log dates | 1, in 1 of the 44 matched sessions |
| Boundary | Manual, 2026-10-08T11:36:34.424Z, build `2.1.280-desktop.shab79a1dfb`, log-88 / transcript-34 line 5958 |
| Boundary metadata | preTokens 597,230; messagesSummarized 1,984; preserving strategy, exact prefix/session-memory/partial selection unresolved |
| Compact-fork markers | 9 received assistant messages; 1 finished fork |
| Debug send markers | 340 full / 3,979 incremental |
| Debug cache tokens | 592,477,312 cached / 624,026,463 input, weighted 94.9443% |
| Response cache categories | 478 cached=0; 5,342 at least 80% cached; 638 partial |
| Duplicate identical timestamped lines removed | 41,997 across all event types |

This is censored descriptive coverage, not a population compaction rate. The
one-of-44 figure counts matched session identities, not independently verified
tasks. Request markers lack request IDs; neither 6,463 nor the fork-message
count establishes unique calls. Zero recorded crossings does not mean zero
compactions outside this instrumentation. Debug ownership separates 3,560
main-thread, 463 unowned and 2,435 other-owner usage records; desktop/terminal
and worker identities are unresolved. Observed build strings do not attest the
currently installed build or a current-HEAD model cohort. The July report was
not remeasured and was not used to infer current savings.

Within verified transcript/log date overlaps, diagnostic rows provide 2,020
model-attempt starts, 2,019 ends and 2,014 identified logical calls. Joined
attempt outcomes are 2,001 succeeded, 17 failed, 1 cancelled and 1 incomplete.
These are API outcomes, not verified task success. There are 6,478 request-start,
6,474 stream-surface and 3,422 tool-execution start/end rows each. The 4,198
send-path rows split 315 full / 3,883 incremental; same-record usage totals
541,986,215 input / 518,482,944 cached tokens (95.6635%), with 80,044,003
recorded stream milliseconds. These joins improve transport coverage but do not
reliably attribute cache trajectories to compaction or label task completion.
No entrypoint origins were recorded in this cohort.

## Composition estimate and P1 gate

A simple parent walk initially rejected the boundary due to 216 unmatched tool
calls. The optional production-reader child recovered parallel exchanges from
a frozen, verified pre-boundary prefix without changing the source transcript.
Its selected chain has 1,512 messages and complete tool pairing. Metadata says
1,984 summarized messages, so this remains a composition proxy, not the exact
historical API request or a complete reconstruction of dynamic instruction state.

Under the verified current GPT wire cap, recovered tool text totals 1,162,274
UTF-16 characters both before and after per-result truncation. The optimistic
eligible-old-output upper bound is 1,081,945 characters, with 80,329 protected
or ineligible and two exempt outputs. Thus aggregate small outputs can survive
the existing cap. Eligibility here means non-error Read/Bash/Grep/Glob text
outside the newest three assistant rounds; it does not prove safe removal of
Read evidence, mutation prerequisites, active handles, authorization or recovery
information. No bytes were actually elided and no token or monetary savings
were measured.

Source verification confirmed the 48,000-character cap and ToolSearch,
unknown-origin and image exemptions in `codex-fetch-adapter.ts`. Full resend is
not synonymous with a cache miss. High cached-input fractions and rare observed
pressure leave the economic gate unresolved even though the upper bound is large.
P1 therefore remains deferred. Any future candidate must first resolve the
internal projection return contract and prove replay, Read/mutation and provider
continuation behavior specified in the plan. No early warm-cache threshold was
introduced, and no deterministic projection has been claimed proven.

Missing: exact historical/current serialized prompt composition, isolated tool
schema overhead, compaction attempts/failures/strategy, robust boundary-to-usage
attribution, redundant-action semantics, output billing, failure recovery and
independent task oracles. Cost per verified completion, including recovery, is
**not estimable** from this artifact.

## P2 implementation and offline evidence

Normal Todo/Task reminders did not supply current unfinished work on the first
post-compaction request when the tracking exchange was removed. The regression
fixtures failed before the repair with an expected snapshot missing; a separate
fresh-process reproduction found that trailing attachment metadata was lost
when the active conversation tip was the summary. Both owners were repaired.
The final Todo/Task first-request tests were also overlaid onto the plain
`b0bbbaa` archive and run with `--test-name-pattern 'first post-compact request'`:
both fail at the intended assertion, expected one snapshot and received zero.
The repaired suite passes both cases. This negative control changes only the
temporary archive's test file, not its production source or the shared checkout.

The common final assembly in `appendPostCompactRuntimeAttachments` now adds
restoration after selected runtime attachments. Auto, manual, reactive,
session-memory and both partial directions supply the actual source messages;
discarded fallback candidates do not restore task state. The candidate requires
both `COMPACT_TASK_RESTORE` and `CAT_CODE_EVAL_COMPACT_TASK_RESTORE=1`.
The build flag is available in dev-full and desktop sidecar launch arguments;
the environment opt-in is absent by default. No experimental default was enabled.

Todo state is scoped to the session or agent; Task state is scoped to the task
list and session/agent, limited to successful activity in the current request.
Unrelated shared-list work, completed/internal tasks, foreign owners and failed
writes are excluded. Disk state is read after summary/runtime hooks so later
task changes win. A new genuine user request resets eligibility unless it has
new tracking activity. This conservative rule can omit still-relevant older
work; live behavior has not been evaluated.

Equivalent preserved reminders/writes are deduplicated. The model-facing text
includes existing current steps/blockers, prioritizes in-progress work, clips
fields and is bounded below 3,000 characters; a 1,000 estimated-token reserve is
included in session-memory acceptance, and actual post-compact estimates include
attachments. Full existing attachment content stays durable, so resume does not
hydrate a truncated Todo list. This bounds model input, not persisted JSON size.
Task creation, normal reminder frequency, file-state invalidation and compaction
strategy/fallback ordering are retained.

Existing reminder types gain optional `compactState` framing. The selected
transcript reader retains only matching session/agent task snapshots along the
metadata descendants before the next conversation continuation. It does not
resurrect arbitrary metadata or discarded conversation branches. Session restore
hydrates the full Todo list from the latest durable snapshot; retained workers
can use an already scoped snapshot after their AppState slot is released. A
copied parent snapshot cannot assign its work to a differently identified agent.
No wire protocol or database/migration was added. Persisted snapshots remain
readable with the opt-in disabled, including in a fresh process without the flag.

Test-audit authoring gates were applied: the primary assembly tests protect
first-request visibility/scope/bounds, selected-path cases catch missed callers,
and the real writer/fsync/new-process reader catches loss at the active-tip
boundary. They exercise production normalization, actual TaskUpdate execution
and disk state, and assert that compaction removed the tracked exchange.
Summary transport is mocked offline; it supplies summary text, not restoration.
No test-only production seam was added. Desktop fork/handoff/supervisor checks
are existing lifecycle regression coverage, not proof of model-driven task quality.

## Validation ledger

All tests used isolated temporary configuration; no real credentials were
used for model calls. Summary fixtures use a fake API key and mocked transport.
Local socket process tests required approved sandbox escalation. No automatic
approval rejection left work blocked. GUI/hardening runs were not authorized.

| Check | Result |
|---|---|
| Audit fixture | 1 pass; identity rejection, symlink exclusion, sanitization and post-cap proxy |
| Gated task-restoration fixture | 5 pass; 36 assertions, including writer/fsync/fresh-process resume |
| Selected compaction paths (`COMPACT_TASK_RESTORE`, `REACTIVE_COMPACT`) | 19 pass; 54 assertions, including full/manual/auto/session-memory/reactive/partial-from/partial-up-to |
| FileRead / Codex continuation | 78 / 8 pass |
| Session storage | 72 pass, also 72 on baseline |
| Reactive compiled feature | 17 pass, 1 skip |
| Main launch decisions | 89 pass |
| Selected desktop controller/history/task domains | 77 pass |
| Fork, workspace handoff restore, supervisor processes | 29 pass; 111 assertions, isolated processes and Unix sockets |
| Query | 37 pass, 2 fail; same two baseline failures |
| Compact/auto/reactive/micro/context-window, ordinary flags | 57 pass, 3 skip, 8 fail; same eight credential-setup failures on baseline |
| Complete desktop directory (`bun test ./app/`) | Current and baseline: 5,865 pass, 3 skip, same 8 fail across 400 files; no added failure |
| Dev-full build | Pass: maps 17/0 warnings, undefined names 0, 5,489-module dev bundle and CLI version smoke; no installed app changed |
| Root typecheck | 1,896 diagnostics on each snapshot; no added diagnostic by file and TS code, changed-owner differences inspected |
| Desktop / scoped sidecar typechecks | Pass / pass (5,574 upstream diagnostics ignored by the existing wrapper) |
| Explicit changed-engine ESLint | Pass; scripts and main-process files are excluded by existing ESLint configurations and were not lint-covered |
| Documentation | `git diff --check`, maps lint and changed local-link checks pass |

Commands for the candidate fixtures:

```sh
CLAUDE_CONFIG_DIR=/private/tmp/harness-final-task-state \
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 \
  bun --feature=COMPACT_TASK_RESTORE test ./src/services/compact/taskRestoration.test.ts
CLAUDE_CONFIG_DIR=/private/tmp/harness-final-compact-state \
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1 \
  bun --feature=COMPACT_TASK_RESTORE --feature=REACTIVE_COMPACT \
  test ./src/services/compact/compact.test.ts
```

The two query failures concern resolved plan-mode compaction model and command
permission substitution in the cua-driver guard. Eight microcompaction failures
lack API/OAuth fixture setup on both snapshots. The desktop baseline has eight
failures: two `runControlsDomain` cases (effort/fast routing and graceful snapshot
fallback), and six `createPeerTool` cases (creation result and refusal/unanswered
failure reporting). Focused current/baseline runs each produce 26 pass / 8 fail.
These were not repaired as part of this slice. The first broad `bun test app/`
filter additionally discovered an ignored archived fixture under `tmp/` and
failed its import; the final directory run uses `bun test ./app/`.

## Resume notes and remaining gates

Implementation, audit and offline validation are delivered. Elision, tool
ablation, combined candidates and default promotion remain deferred. No live
manifest was executed or represented as approval-ready: task-level cache costs
and verified-completion outcomes are still missing. Future screening must first
author immutable pre-fix fixtures with hidden behavioral oracles, select trigger
and ordinary cohorts before candidate results, and capture actual executing
model/config/request identities. P2 pairs must assert that compaction removes
tracking state; no-trigger pairs must be reported separately.

Before any live call, prepare the exact versioned manifest, catalog-resolved
models/providers, dedicated account isolation (not the user's live account),
maximum attempts/retries, per-run and total token/cost/time caps and stopping
rules, then request the user's authorization. Keep P2 independent of P1/P3.
Recovery and failed attempts must be charged to cost per verified completion;
token reduction or passing unit tests cannot promote the candidate. GUI behavior
requires separately authorized Cat Code Dev observation after a full restart.

Temporary validation logs live under `/private/tmp/harness-*.log`; they are local
diagnostic evidence, not sanitized shareable reports. The committed aggregate
artifact and this ledger are the durable handoff. Raw task/session data was not
copied into prompts or repository documentation.
