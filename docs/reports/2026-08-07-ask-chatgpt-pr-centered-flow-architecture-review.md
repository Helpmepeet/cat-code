# `ask-chatgpt`: PR-Centered Delegation Flow Architecture Review

- **Date:** 2026-08-07
- **Status:** Revised after adversarial review; implementation remains gated
- **Decision under review:** Replace the review-only `chatgpt-review-pr` identity with a repository-task skill named `ask-chatgpt`, while retaining a pull request as the mandatory context and result channel.
- **No implementation is authorized or claimed by this report.**

## Executive summary

The current system contains two materially different transports under one skill directory:

1. A shipped GitHub-connector lane that creates an isolated draft PR, submits a prompt to the ChatGPT product, and accepts a strictly correlated GitHub comment or review.
2. A general-purpose local MCP Bridge that serves immutable briefs and typed result schemas through a public tunnel, without requiring a PR.

The present `SKILL.md` exposes only the GitHub-connector lane, while the Bridge implementation and tests remain in the same directory. The current skill contract test explicitly rejects Bridge terminology and requires `launchReview.ts`. This is not merely naming drift: the directory retains two trust models, two receive mechanisms, two fallback models, and two operational lifecycles.

For the requested product concept—**ChatGPT performs a repository-grounded task through an isolated PR**—the intended public workflow remains PR-centered with only two candidate task contracts:

- `review`: structured findings plus `APPROVED` or `REVISE`;
- `task`: a requested repository-grounded deliverable plus `COMPLETE` or `BLOCKED`.

The first version of this report proposed removing baseline capture, the 15-second settlement delay, persistent lineage locks, repeated scope identity, and the operator's repeated reconciliation loop. Adversarial review found that proposal unsafe and factually incomplete. The current implementation accepts an agent-supplied ID and checks only its shape; baseline state also supplies the polling cursor; active lineage rows protect setup mutation and removal; a live PR does not prove which head ChatGPT read; and late collection requires persisted expected-run state.

The revised recommendation is **separation, not immediate retirement**:

- build `ask-chatgpt` as the PR-centered public workflow only if two feasibility probes pass;
- preserve the Bridge as a separately named private-delegation skill if private worktree transfer, typed tool-boundary results, or audited repository reads remain valuable;
- do not keep both transports behind one skill contract or in one ownership directory.

The two gating probes are:

1. Can the ChatGPT GitHub connector read relevant repository files outside the PR diff at the exact PR ref?
2. What is the practical `?q=` prompt budget for a non-review task while preserving byte-exact prompt hashing and composer comparison?

Until both pass, calling the PR transport "universal" is an unvalidated product claim.

## Adversarial review disposition

| Original claim | Disposition | Correction |
|---|---|---|
| Random `runId` plus author makes full baseline capture unnecessary | **REVISE** | The CLI does not generate the ID today. Generate it internally, reject caller-supplied IDs, and replace full-history capture with a cheap persisted high-water cursor rather than deleting cursor state. |
| Lineage locking can be removed because run IDs separate results | **REVISE** | Correlation does not require per-lineage ownership tokens, but active-run state is required to guard key/config mutation and PR close. Persist an authoritative run record and retain hard lifecycle guards. |
| Accept the first valid result without settlement | **NOT ESTABLISHED** | The cited no-duplicate evidence came from the MCP Bridge, not GitHub connector writes, and five runs are statistically weak. Retain settlement until connector-specific live evidence supports changing it. |
| A moved PR head should yield a stale result rather than rejection | **REJECTED** | The GitHub connector reads live PR state. Unlike the Bridge, nothing proves that ChatGPT saw only the captured head. Keep head-move rejection unless a probe establishes immutable ref access and observed use. |
| One `task` contract plus `review` is enough | **UNPROVEN** | It is a reasonable minimal contract design only after repository-access and prompt-budget probes prove that non-review tasks are feasible through this transport. |
| Two transports under one skill are costly | **ACCEPTED** | Separate the PR and private Bridge products. Do not infer that the Bridge must be deleted; it buys capabilities the PR lane does not reproduce. |

The attached adversarial review is treated as a design input, not as an implementation authorization.

## Sources examined

Current skill and implementation:

- `/Users/pt/.agents/skills/chatgpt-review-pr/SKILL.md`
- `/Users/pt/.agents/skills/chatgpt-review-pr/automationCore.ts`
- `/Users/pt/.agents/skills/chatgpt-review-pr/githubWatcher.ts`
- `/Users/pt/.agents/skills/chatgpt-review-pr/launchReview.ts`
- `/Users/pt/.agents/skills/chatgpt-review-pr/lineageLock.ts`
- `/Users/pt/.agents/skills/chatgpt-review-pr/setup.ts`
- `/Users/pt/.agents/skills/chatgpt-review-pr/userscriptSource.ts`
- `/Users/pt/.agents/skills/chatgpt-review-pr/launchTask.ts`
- `/Users/pt/.agents/skills/chatgpt-review-pr/taskRun.ts`
- `/Users/pt/.agents/skills/chatgpt-review-pr/bridgeServer.ts`
- `/Users/pt/.agents/skills/chatgpt-review-pr/profiles/prReview.ts`
- `/Users/pt/.agents/skills/chatgpt-review-pr/skillContract.test.ts`

Historical design and operational evidence:

- `docs/superpowers/plans/2026-07-13-zero-click-chatgpt-pr-review.md`
- `docs/superpowers/specs/2026-07-15-chatgpt-bridge-design.md`
- `docs/superpowers/reports/2026-07-16-bridge-live-validation.md`
- `docs/reports/2026-07-27-chatgpt-cat-code-app-stale-tool-schema-bug-report.md`
- `/Users/pt/.codex/attachments/f1a4e77a-adca-421e-8e58-c7aa8d01cb63/pasted-text.txt` (adversarial review received 2026-08-07)

## Current-state findings

### 1. The directory contains two complete transports

The GitHub lane uses:

- `launchReview.ts` for capability signing, browser launch, GitHub watching, and fallback;
- `githubWatcher.ts` for comment/review collection, parsing, settlement, and head validation;
- `automationCore.ts` for prompt-bound launch capabilities and the review envelope;
- an isolated draft PR as the durable context and result record.

The Bridge lane uses:

- `launchTask.ts` for composition, disclosure, launch, batch execution, reconciliation, and fallback;
- `bridgeServer.ts` for a local MCP server and control plane;
- `taskRun.ts` for a generic typed task state machine;
- `repositorySnapshot.ts` and `scopeBuilder.ts` for immutable local repository evidence;
- a public tunnel and ChatGPT developer-mode app instead of GitHub as the task transport.

The Bridge was not speculative dead code. It passed live validation and was enabled on 2026-07-18. That validation also found multiple real defects that unit tests missed, including partial control-socket writes that hung large reviews, prose/schema mismatches that rejected every model result, lock-recovery failures, and a leaked lock token in printed output.

On 2026-07-27, the Bridge lane was again unable to complete repository-aware reviews because the ChatGPT-side app exposed a stale four-tool schema instead of the six tools required by the local implementation. The reported recovery required refreshing or recreating the ChatGPT app and re-running live validation.

The current `SKILL.md` has since returned to a GitHub-connector-only contract, and `skillContract.test.ts` requires that it not mention the Bridge or `launchTask.ts`. The remaining Bridge implementation therefore carries maintenance and security cost without being part of the current user-facing workflow.

### 2. The GitHub flow's security core is sound

The following controls have distinct, defensible purposes and should remain:

- External-send disclosure before repository material or prompts leave the machine.
- Exact PR readback after creation, including changed-file and commit-scope verification.
- A cryptographically random per-run ID generated by the trusted CLI, not supplied by the invoking agent.
- Validation of the connector's GitHub author identity.
- A prompt-bound, expiring, signed browser capability.
- A one-use nonce claimed by the userscript before it clicks Send.
- Strict opening and closing result markers.
- Independent local triage of all returned claims.
- No automatic merge, fix, login, approval, or confirmation behavior.

The signed capability and nonce are not considered overengineering while automatic browser submission remains a requirement. Without them, an untrusted URL or duplicate browser state could cause an undisclosed submission. The honest simplification is manual submission, not weaker authentication.

### 3. Run identity must be generated, not merely described

The current CLI requires `--run-id` and validates only `/^[A-Za-z0-9_-]{8,128}$/`. The random value generated in `createLaunchPayload` is the browser capability nonce, not the review run ID. Therefore the current system does not enforce the `SKILL.md` claim that each run ID is cryptographically random and unique.

The redesigned CLI must generate the run ID internally during `prepare` and refuse a caller-selected ID. Later commands may accept only a run ID that resolves to an existing locally issued run record. Only after that change can the run ID safely carry freshness and collision arguments.

The current result identity also includes `reviewRunId`, `lineageId`, `round`, PR number, head SHA, an ordered commit list, and a digest of the ordered commit list. Some fields may eventually be simplified, but not before the connector-scope probe establishes what repository state ChatGPT can actually inspect.

### 4. Replace full baseline enumeration, not the high-water cursor

`captureBaseline` performs complete paginated reads of all issue comments and submitted reviews. The resulting state serves two functions:

1. freshness exclusion through complete prior object-ID sets;
2. an efficient high-water cursor used by `fetchAppend` to stop backward pagination.

Deleting the baseline without replacing the cursor would make every poll scan history. The smarter target is the expensive full-history enumeration, not cursor state itself.

Subject to API-ordering tests, capture only the current high-water object ID for the configured write channel by reading its last page. Persist that cursor with the run record. Retain full baseline behavior until the replacement is proven equivalent for polling and freshness.

The simplified freshness argument depends on all of the following:

1. the CLI generates the `runId` after the high-water cursor is captured;
2. the ID is cryptographically random and never reused;
3. the validated connector identity cannot be spoofed by another GitHub actor;
4. the watcher examines only objects beyond the persisted high-water cursor;
5. GitHub endpoint ordering and ID monotonicity match the cursor algorithm.

If any condition is unproven, retain full baseline capture.

### 5. Per-lineage ownership is overcomplicated, but active-run lifecycle protection is required

The SQLite lineage lock enforces one active round per lineage and also prevents installation mutation while runs are active. It creates the following failure and recovery concepts:

- lock ownership tokens;
- token-safe persistence;
- timeout retention;
- reconcile windows;
- explicit abandon;
- force-abandon by lineage after process death;
- installation lifecycle states and removal refusal;
- cross-lane lock sharing between GitHub and Bridge runs.

Live validation demonstrated that these mechanisms fail in consequential ways when a process dies before a recoverable state is persisted. The system required a force-abandon command specifically because correct ownership information could be stranded.

Result correlation alone does not require per-lineage ownership tokens. However, hard active-run state protects two separate invariants:

- setup must not rotate keys, disable submission, regenerate the userscript, or remove installation state while a signed capability and watcher are active;
- `close` must not close or delete a workflow PR while any run for that PR is pending.

Replace the lock-token/reconcile ownership model only if an authoritative persisted run record supplies those guards. A possible simpler model is one run table keyed by CLI-generated `runId`, containing repository, PR, expected scope, expected author/channel, high-water cursor, and state. Setup mutation requires zero active rows; close requires zero active rows for that PR. A hard uniqueness rule may also keep one pending run per workflow PR until concurrent GitHub runs are deliberately validated.

This retains hard lifecycle safety while making recovery addressable by `runId`, without a separate secret ownership token that can be stranded.

### 6. Settlement remains until GitHub-specific evidence supports removal

The watcher waits 15 seconds after the first valid result to detect duplicate or conflicting posts. The signed userscript consumes its submission nonce once, but that controls prompt submission, not connector write retries after ChatGPT begins acting.

The original report incorrectly transferred five no-duplicate observations from typed Bridge posts to GitHub connector writes. The transports have different acknowledgement, error, and retry behavior. Five runs would also be inadequate evidence of rarity even if they used the same transport.

Retain settlement for the initial PR-centered implementation. Reconsider it only after connector-specific live validation covers duplicate tabs, connector retries, a corrected second post, and conflicting same-run bodies.

### 7. A moved PR head remains a disclosure and scope failure

The current GitHub watcher rejects an otherwise valid result if the PR head changed before receipt. That rejection is correct for the current connector lane because ChatGPT fetches a live PR at an unobserved time. If the head moved before its fetch, ChatGPT may have inspected repository material that was never part of the disclosed scope.

The Bridge's `staleAgainstCurrent` behavior does not transfer: the Bridge serves an immutable local snapshot and can prove which revision was available. The GitHub lane cannot make that proof today.

Keep head-move rejection unless the connector-scope probe demonstrates immutable ref access and the workflow gains evidence that ChatGPT used the pinned ref. Preserve the ordered commit echo and scope digest until an equally strong replacement exists.

### 8. Setup should persist validated connector facts through a coordinated config version

The current skill says the connector write action and GitHub login are not recorded and must be recovered from an earlier accepted review. This creates per-run discovery, ambiguity, and failure when no prior lineage exists.

One-time live validation should persist:

- the connector's exact GitHub login;
- the validated write channel: top-level PR comment or submitted review body;
- the validation timestamp and protocol version.

Normal runs should read these values and fail early if they are absent. A changed identity or write channel should require revalidation rather than heuristic recovery.

`launchReview.ts` currently rejects unknown configuration keys. Adding these fields therefore requires a coordinated configuration-version bump, setup migration, validation update, status output, and tests. It is not a prose-only change.

### 9. Separate common identity from task semantics conservatively

The existing envelope requires a full ordered commit list, changed files, unavailable material, web-search status, command/test status, a fixed `GitHub write action: available-and-used` token, findings prose, and a final review verdict.

A generic repository task does not always have findings or a verdict. Review-only semantic fields should move into the review contract, but existing scope and write-channel forcing fields should not be removed merely because they duplicate observable facts.

- `GitHub write action: available-and-used` is redundant as post-hoc evidence but also prompts the model to complete the required in-band write; retain it until prompt experiments prove it unnecessary.
- The ordered commit list and scope digest are currently the only returned evidence, albeit self-reported, tying the result to the disclosed commits; retain them while the connector reads live PR state.
- Web-search and command/test declarations may become task-contract-specific only after the generic contract is validated.

The common envelope should validate transport identity and completeness. The selected task contract should validate semantic structure.

## Proposed product boundary

### Skill identity

Use the user-facing name `ask-chatgpt`.

Suggested trigger description:

```yaml
---
name: ask-chatgpt
description: Use when the user explicitly wants the ChatGPT product to perform a repository-grounded task through its GitHub connector and a pull request. Supports repository review and custom analysis tasks. Do not use the Codex account pool.
---
```

The description should remain narrow enough that ordinary references to ChatGPT do not trigger an external-send workflow.

### Transport boundary

Do not expose two transports through one skill. Use two separately named products if both survive:

- `ask-chatgpt`: GitHub connector plus an isolated draft PR by default;
- a separately named private-delegation skill: local MCP Bridge for material that must not be published to GitHub or tasks requiring typed results and observed reads.

Do not retire or migrate the Bridge until the two PR feasibility probes pass and the operator decides whether its unique capabilities are still required.

### Task contracts

If the PR feasibility probes pass, start its public workflow with two contracts only:

1. `review`: requires inspection coverage, structured findings, non-blocking notes, and `APPROVED` or `REVISE`.
2. `task`: requires evidence, a deliverable, limitations, and `COMPLETE` or `BLOCKED`.

Planning, diagnosis, architecture analysis, migration design, documentation analysis, and comparison tasks should initially use the generic `task` contract. Add another contract only after observed failures show that a materially different machine-validated shape is necessary.

### Scope modes are probe-gated

Change scope is already supported. Snapshot scope is a hypothesis:

1. **Change scope:** the PR contains the exact commits or isolated patch being examined.
2. **Candidate snapshot scope:** the code is unchanged, so the workflow creates an isolated branch with one generated task-capsule file solely to make the repository state addressable through a draft PR.

The task-capsule branch would never be merged. The capsule must be clearly identified as transport material so ChatGPT does not mistake it for a proposed product change.

Before designing this path, run a real connector probe that asks ChatGPT to cite repository files outside the capsule-only PR diff at the exact PR ref. If the connector cannot do that reliably, a capsule PR is not repository grounding and the PR workflow remains change/review-shaped. In that case, non-review repository tasks belong on the Bridge or another transport.

## Proposed minimal run identity

Use:

- repository owner/name;
- PR number;
- exact `baseSha`;
- exact `headSha`;
- cryptographically random CLI-generated `runId`;
- configured connector author;
- configured write channel;
- task contract (`review` or `task`).

Potential later simplifications, not approved for v1:

- a public `lineageId` separate from the dedicated PR;
- a protocol-significant round number;
- removing the repeated ordered commit list from the result;
- removing the model-echoed commit-scope digest.

The local CLI may display a human round number. `lineageId` and round may become local metadata rather than public protocol fields, but only after follow-up and recovery tests prove that the dedicated PR plus persisted run records provide equivalent sequencing.

## Candidate result envelope

Generic task:

```text
<!-- ask-chatgpt:v1 run=<runId> base=<baseSha> head=<headSha> scope=<scopeDigest> kind=task outcome=complete -->

## Evidence
...

## Deliverable
...

## Limitations
...

GitHub write action: available-and-used

<!-- /ask-chatgpt:v1 -->
```

Review:

```text
<!-- ask-chatgpt:v1 run=<runId> base=<baseSha> head=<headSha> scope=<scopeDigest> kind=review outcome=complete -->

## Inspection
...

Commit SHAs:
- <ordered-full-commit-sha>

## Findings
...

## Non-blocking notes
...

GitHub write action: available-and-used
VERDICT: APPROVED
<!-- /ask-chatgpt:v1 -->
```

Common validation should require:

- exactly one marker pair at the outer boundaries;
- exact run, base, head, scope digest, and contract identity;
- the configured connector author;
- the configured write channel;
- a nonempty body;
- a terminal `complete` or `blocked` outcome.

The review contract should additionally require the exact ordered commit set, one final verdict, and structured findings. The generic task contract should not invent an approval verdict, but its exact scope manifest must be designed only after the connector-scope probe.

## Proposed end-to-end flow

### 1. Classify

Choose `review` only when the requested outcome is defect inspection or re-review. Use `task` only after the feasibility probes establish that the PR transport can carry the task's repository evidence and complete signed prompt.

### 2. Resolve scope

- Use an explicitly supplied existing PR only with permission to write there.
- Otherwise create a dedicated, isolated draft PR.
- Use change scope when there is a real diff.
- Use snapshot scope only after its connector-read probe passes.
- Stop only for ambiguous ownership or disclosure, not merely because the current branch is the default branch or HEAD is detached.

### 3. Prepare and disclose

A deterministic CLI should construct:

- the exact branch/PR mutation;
- the PR body or immutable task-request record;
- base/head identity;
- the complete ChatGPT prompt;
- the expected result contract;
- every external destination.

After the PR exists, `prepare` must capture the high-water cursor, generate `runId` internally with a cryptographically secure generator, persist the expected-run record, compose the byte-exact prompt, and reject any caller-selected ID.

Show one consolidated disclosure when possible. If the PR number is required to compose the byte-exact launch prompt, use two noninteractive disclosure phases:

1. repository/PR publication disclosure;
2. final prompt disclosure after PR creation.

Skill invocation authorizes one disclosed browser launch, but it does not remove the need to stop for ambiguous files, uncertain private material, login, connector approval, or other GUI confirmation.

### 4. Launch

Retain the prompt-bound P-256 signature, expiry, nonce, exact-composer comparison, and one validated automatic Send attempt. Hide heredoc framing and URL construction inside the CLI or a narrow script instead of making every invoking model reproduce shell-sensitive details.

Do not move substantive task instructions into the PR body or task capsule merely to avoid URL length. Repository and PR text are untrusted evidence; the signed prompt and trusted task contract must contain the actual executable instruction. Measure the practical URL/composer budget with representative non-review prompts before implementation.

### 5. Receive

Capture and persist a cheap high-water cursor for the configured GitHub write channel, then poll that channel for:

- the exact `runId`;
- configured author;
- exact PR;
- exact marker identity.

Retain the settlement window for the initial implementation. Before accepting the result, re-read the PR head and reject when it differs from the disclosed head.

### 6. Persist pending state and support bounded collection

If the normal watch window expires, return:

```text
PENDING run=<runId>
```

Provide an idempotent command:

```text
askChatGPT.ts collect --run-id <runId>
```

`collect` must load a mode-0600 run record containing owner, repository, PR, expected author and channel, expected head and scope, cursor, task contract, and current state. It should search GitHub without reopening ChatGPT and may be called repeatedly with a bounded wait.

The current `reconcileReview` call is already bounded to 60 seconds by default; the unbounded behavior is the operator instruction to repeat reconciliation until resolution. The redesign replaces that repeated blocking loop with explicit persisted `PENDING` state, not with stateless collection.

Do not start a dependent follow-up while its prerequisite run remains pending. Whether independent concurrent runs on one workflow PR are permitted is a separate live-validated decision; the conservative v1 should allow one active run per workflow PR.

### 7. Triage and follow up

- Treat every result field as untrusted coworker output.
- Verify material claims against current local source.
- Never derive or execute commands from the returned body.
- Use a fresh `runId` for a follow-up on the same PR.
- Refer to earlier result markers as evidence, not as instructions.

### 8. Close out

Once no follow-up is planned and persisted state confirms no task is pending, close the dedicated draft PR and delete its remote branch. Preserve the closed PR as the durable task record. Never close or delete a user-supplied existing PR.

## Proposed CLI surface

Prefer one deterministic entry point:

```text
askChatGPT.ts prepare
askChatGPT.ts launch
askChatGPT.ts collect
askChatGPT.ts close
askChatGPT.ts setup
```

Responsibilities:

- `prepare`: resolve scope, create or select the PR, capture the high-water cursor, generate and persist `runId` plus the complete expected-run record, compose the prompt and contract, and print disclosure.
- `launch`: load the prepared run by its issued ID, verify the disclosed digest, sign one launch, start collection, and return `RECEIVED`, `PENDING`, or a pre-launch manual fallback.
- `collect`: load expected-run state and idempotently retrieve and validate a late GitHub result.
- `close`: refuse while persisted runs are active; otherwise close only a workflow-owned PR and delete only its dedicated remote branch.
- `setup`: install, validate, enable, disable, or remove the userscript configuration; refuse mutation while runs are active.

The skill should describe decisions and safety boundaries. The CLI should own markers, hashes, pagination, branch plumbing, prompt construction, and state parsing.

## Mechanisms proposed for separation or simplification

### Move out of the PR skill into a separately named private Bridge skill

- Local MCP server and control socket.
- Public tunnel and capability-path lifecycle.
- ChatGPT developer-mode app schema synchronization.
- Attachment and repository-read tools.
- Generic Bridge task registry and closed profile registry.

### Simplify only after replacement invariants are implemented

- Replace full GitHub comment/review baseline enumeration with a validated high-water cursor.
- Replace per-lineage ownership tokens with persisted active-run records only if setup mutation and PR close remain hard-guarded.
- Replace repeated manual reconciliation with bounded `collect`, backed by the complete persisted expected-run record.
- Reconsider the 15-second settlement delay only after GitHub-connector-specific duplicate/conflict evidence.
- Reconsider public lineage/round and repeated scope fields only after follow-up, head-move, and immutable-scope evidence proves equivalent safety.
- Replace per-run discovery of connector identity and write channel with a versioned setup configuration.
- Move review-only semantic fields out of the generic result envelope after the generic contract is proven.

### Retain

- Isolated git plumbing that does not touch a shared working tree or index.
- Exact PR base/head readback.
- Head-move rejection for the live connector lane.
- Ordered scope evidence and digest until immutable connector reads are proven.
- A high-water polling cursor.
- A settlement window pending connector-specific evidence.
- Persisted expected-run state for collection.
- Hard setup-mutation and PR-close guards while runs are active.
- External-send disclosure.
- Connector-author validation.
- Signed one-shot browser submission.
- Strict result markers.
- Local source verification and untrusted-output handling.
- Manual fallback when automatic delivery is unavailable before a browser submission.

## Important losses and counterarguments

### Loss 1: Uncommitted work no longer stays off GitHub

The Bridge can serve a disclosed worktree snapshot without committing or pushing it. A PR-centered flow must publish whatever ChatGPT is expected to inspect to GitHub. This may be unacceptable for sensitive, experimental, or not-yet-shareable work, even in a private repository.

Possible responses:

- Explicitly declare that `ask-chatgpt` supports only material approved for GitHub publication.
- Keep a separately named manual/Bridge skill for private worktree delegation.
- Retain the Bridge and accept its complexity.

The proposal does not silently solve this tradeoff.

### Loss 2: Result validation becomes textual

The Bridge validates a closed JSON schema at the tool boundary and can reject malformed results while the model is still active. GitHub comments are text parsed after posting. A strict envelope detects identity and shape errors, but it cannot provide the same interactive schema-repair loop.

The reviewer should assess whether review findings and generic task deliverables remain reliable enough under a text contract.

### Loss 3: Repository-read auditing weakens

The Bridge records every attachment fetch, search, and repository-file read. The GitHub connector does not expose equivalent local audit evidence. "Files examined" becomes model self-report.

If observed inspection coverage is a hard requirement, the PR-only design is a regression.

### Loss 4: Product-only capabilities may narrow

The Bridge design anticipated browsing, Deep Research, and other ChatGPT product capabilities under profile-specific contracts. A GitHub-connector prompt may still ask ChatGPT to use available product capabilities, but the workflow no longer controls them through a typed app contract.

### Loss 5: Removing settlement changes conflict behavior

This removal is no longer recommended for the initial implementation. The risk remains documented as the reason settlement stays until GitHub-specific validation supports a change.

### Loss 6: Removing hard lineage locks permits concurrent semantic work

Per-lineage ownership tokens may be replaceable, but hard active-run state is retained. The conservative initial design permits one active run per workflow PR, guards setup mutation globally, and guards PR close per PR.

## Alternatives

| Alternative | Benefits | Costs and risks |
|---|---|---|
| **A. PR-only `ask-chatgpt`** | One transport, no public tunnel, durable GitHub record, simpler setup and recovery, matches the requested concept | Publishes all inspectable material to GitHub; textual result validation; weaker read audit |
| **B. Bridge-only `ask-chatgpt`** | Typed results, private worktree scope, repository-read audit, extensible product profiles | Public endpoint and tunnel, app-schema drift, larger attack and failure surface, no mandatory PR |
| **C. Dual-lane skill** | Maximum capability and fallback coverage | Highest cognitive and maintenance cost; two disclosure models, two receive paths, two recovery systems; current source already demonstrates drift |
| **D. PR default plus separately named private Bridge skill** | Clear user choice; PR flow remains simple; private delegation remains available | Two maintained products, but without hiding both behind one skill contract |

The current recommendation is **D** until both PR feasibility probes pass and the operator explicitly decides that the Bridge's private/typed/audited capabilities are unnecessary. Even after the probes pass, **A** is an optional retirement decision, not an automatic consequence of creating `ask-chatgpt`.

## Implementation constraints if the proposal survives review

1. Do not rename prose while leaving review-only types and markers behind.
2. Do not add plan, diagnosis, design, and research profiles before real tasks prove the generic contract inadequate.
3. Do not weaken the signed browser-launch capability.
4. Do not silently publish local-only context to make a PR task possible.
5. Do not accept an existing PR as workflow-owned unless ownership is explicit.
6. Reject a GitHub-connector result when the live head moved unless immutable connector access and observed use are proven.
7. Do not claim a result is correct merely because its envelope is valid.
8. Do not carry Bridge setup, tunnel, or schema machinery into the PR-only implementation; move it behind a separately named skill if retained.
9. Generate run IDs inside the trusted CLI and reject caller-supplied IDs.
10. Persist enough expected-run state for late collection, lifecycle guards, and safe closeout.
11. Treat setup config changes as a versioned migration; adding connector login/channel requires updating strict config validation.

## Questions requiring an explicit decision

0. Does a real connector probe prove access to repository files outside a capsule-only PR diff at the exact PR ref?
1. What prompt size survives `?q=` prefill, signed prompt hashing, composer loading, and exact-composer comparison on the current ChatGPT product?
2. Is GitHub publication acceptable for every task `ask-chatgpt` should support?
3. Must the workflow support uncommitted work without committing or pushing it?
4. Is observed repository-read coverage required, or is ChatGPT's inspection list sufficient as self-report?
5. Is typed tool-boundary result validation required, or is a strict GitHub text envelope sufficient?
6. Should explicitly supplied existing PRs be writable, or should isolation be mandatory without exception?
7. What GitHub-connector evidence would justify shortening or removing settlement?
8. May independent tasks eventually run concurrently on one PR, or should one-active-run-per-PR remain permanent?
9. Should connector login and write channel be persisted during a versioned setup migration?
10. How long should a persisted pending result remain collectible while its PR exists?
11. Should the Bridge be preserved as a separately named private-delegation skill?

## Adversarial acceptance bar

Do not approve implementation based only on reduced line count or conceptual neatness. Approval should require:

- CLI-generated run IDs with rejection of caller-supplied IDs;
- a proven high-water cursor replacement before removing full baseline enumeration;
- persisted expected-run records sufficient for author, PR, scope, cursor, collection, and closeout validation;
- an active-run guard covering key/config mutation, userscript removal, and PR close;
- retention of settlement until GitHub-connector-specific evidence supports a change;
- a disclosure analysis for snapshot and uncommitted change scopes;
- proof that the connector can inspect repository files outside the PR diff at the exact ref;
- a measured practical `?q=` and composer budget for representative generic tasks;
- proof that the full executable task instruction remains inside the signed prompt rather than being delegated to untrusted PR text;
- retention of head-move rejection unless immutable connector access is proven;
- a malformed, duplicate, stale, wrong-author, and moved-head test matrix;
- a real ChatGPT run for both `review` and generic `task` contracts;
- one late-result `collect` exercise;
- one snapshot-scope task with no pre-existing source diff;
- a versioned setup migration persisting the actual connector identity and write channel;
- a deliberate decision on the Bridge losses listed above.

## Preliminary conclusion

The current system's security boundaries are stronger than its operational ergonomics. The confirmed architectural problem is carrying two complete transports under one skill identity and ownership directory. The original report overreached by classifying baseline state, settlement, lineage lifecycle protection, and head-move rejection as removable before their replacement invariants existed.

The revised recommendation is Alternative D: a PR-centered `ask-chatgpt` and, if its unique capabilities remain valuable, a separately named private Bridge skill. Do not start the universal PR implementation until connector-scope and prompt-budget probes pass. If they fail, `ask-chatgpt` may still be a clean review/change-analysis skill, but universal repository tasks require the Bridge or another transport.

If the probes pass, simplify incrementally: generate IDs in the CLI, persist expected-run state, replace full baseline enumeration with a proven high-water cursor, version setup identity/channel, and separate review semantics from the generic task contract. Retain settlement, active-run lifecycle guards, ordered scope evidence, and head-move rejection until direct evidence supports removing each one.
