# Research Report: What Should Be Reviewed in Agent-Written and Agentic Code?

**Date:** 22 August 2026

## Executive summary

AI coding agents change the risk profile of code review.

Normal code review still matters: reviewers should check design, functionality, complexity, tests, maintainability, documentation, edge cases, and concurrency. Google's long-standing review guidance continues to emphasize these areas and specifically notes that user-facing behavior sometimes needs to be exercised directly because source inspection alone cannot show what the user will experience.

However, AI-generated code introduces additional failure modes. Current GitHub and OWASP guidance highlights problems such as hallucinated APIs and dependencies, unrelated file changes, weakened tests, modifications to build or CI configuration, unsafe tool use, prompt-injection exposure, and excessive permissions.

Code that implements an AI agent requires another review layer again. Reviewers need to examine tool permissions, untrusted context, memory, approval boundaries, multi-agent trust, output validation, resource limits, monitoring, and failure propagation. OWASP's current agent-security guidance treats these as distinct risks of systems that can reason, use tools, maintain state, and perform actions.

The main conclusion is:

> Agent code review should not simply be a larger version of ordinary static code review. It should explicitly review observable behavior, dependency contracts, failure transitions, evidence quality, change provenance, and trust boundaries.

## 1. Two different meanings of "agent code"

It is useful to separate two categories.

### 1.1 Code written by an AI coding agent

Examples include code produced by tools such as Copilot, Claude Code, Codex, Cursor, or other autonomous coding systems.

The application itself may be completely ordinary software.

The special risk comes from how the code was produced.

An AI coding agent can:

- modify many files autonomously;
- run shell commands;
- add dependencies;
- modify tests;
- change configuration;
- infer requirements incorrectly;
- use APIs that look plausible but are wrong;
- make unrelated changes while solving the requested task.

GitHub therefore recommends reviewing AI-generated code for intent, architecture, dependencies, hallucinated APIs, ignored constraints, and deleted or skipped tests, not simply checking whether it compiles.

OWASP goes further and treats unexpected edits, dependency installation, rules-file changes, test weakening, and CI/build changes as security-relevant risks of agentic coding.

### 1.2 Code that implements an AI agent

This is software containing things such as:

- model calls;
- prompts;
- tools;
- MCP servers;
- memory;
- subagents;
- planning;
- autonomous actions;
- approval flows;
- persistent context.

Here the code may have been written by a human or an AI. The additional risk comes from what the software is capable of doing.

OWASP describes agent systems as having risks including prompt injection, tool abuse, privilege escalation, data exfiltration, memory poisoning, goal hijacking, excessive autonomy, cascading multi-agent failures, resource exhaustion, and supply-chain attacks.

These two categories overlap frequently, but they should not be treated as the same review problem.

## 2. Ordinary code review remains the baseline

AI does not remove the need for normal software engineering review.

Google's review guidance identifies several core areas:

- design;
- functionality;
- complexity;
- tests;
- naming;
- comments;
- style;
- documentation;
- system context.

It also tells reviewers to think about edge cases and concurrency, and to verify actual behavior when source inspection is not sufficient, particularly for user-facing changes.

Another important principle is that review should improve code health without demanding perfection. Minor improvements should not receive the same weight as changes that materially affect correctness or maintainability.

This is especially relevant for automated review systems: a reviewer that reports every technically valid observation with equal weight can be accurate while still producing a poor review.

## 3. Additional risks when an AI agent wrote the code

### 3.1 Intent and assumption errors

AI-generated code can be internally consistent while solving the wrong problem.

A reviewer should ask:

- Did it implement the actual request?
- What unstated assumptions did it introduce?
- Did it silently remove or change existing behavior?
- Did it choose an architecture that conflicts with the surrounding system?

GitHub explicitly recommends checking the generated implementation against project intent, architecture, requirements, and established patterns.

The important principle is:

**Plausible code is not evidence that the correct problem was solved.**

### 3.2 Hallucinated or unsafe dependencies

An AI can suggest a package that:

- does not exist;
- has the wrong name;
- is abandoned;
- contains known vulnerabilities;
- has an incompatible license;
- is malicious.

GitHub recommends independently verifying AI-suggested packages, their maintenance status, licensing, and provenance.

OWASP treats hallucinated dependencies as a specific AI coding supply-chain risk because attackers can register package names that models commonly invent. It also recommends auditing AI-selected dependency versions for known vulnerabilities.

A review should therefore treat every newly introduced dependency as an explicit decision rather than routine generated code.

### 3.3 Unexpected or out-of-scope changes

Coding agents can touch files that were not necessary for the task.

Examples include:

- lockfiles;
- tests;
- CI workflows;
- configuration;
- unrelated source files;
- formatting;
- agent instruction files.

OWASP identifies review anchoring as a major problem: the reviewer concentrates on the requested feature and overlooks unrelated modifications made by the agent.

This leads to an important review rule:

> Pre-existing unrelated dirty changes can be excluded. Changes created by the agent during this task should not be ignored merely because they appear unrelated. They should instead be explained or flagged.

### 3.4 Test fabrication and test weakening

A coding agent has access to both production code and often the tests that judge it.

That creates a dangerous feedback loop:

1. implementation fails;
2. agent sees the failing test;
3. agent changes either production code or the test;
4. suite becomes green.

A green suite therefore does not necessarily provide independent evidence.

OWASP specifically warns about:

- deleted tests;
- weakened assertions;
- excessive mocks;
- tests that simply assert the generated behavior;
- tests modified to make CI green.

GitHub similarly recommends looking for deleted or skipped tests in AI-generated changes.

The stronger review question is therefore:

**Would this test actually fail if the production bug returned?**

Where practical, reviewers can verify this by reverting or minimally breaking the fix and checking whether the regression test fails.

## 4. Additional risks when the software itself is agentic

### 4.1 Tool authority and least privilege

An agent that can call tools is effectively operating with capabilities.

A review should inspect:

- which tools the agent can access;
- what resources each tool can reach;
- whether read/write/delete permissions are separated;
- whether tool arguments are validated;
- whether sensitive operations require approval.

OWASP recommends granting agents only the tools required for their task and explicitly authorizing sensitive operations.

Reviewers should therefore ask not merely:

**Does the tool call work?**

but:

**Should this agent have been able to perform this action at all?**

### 4.2 Prompt and context trust boundaries

Agent systems consume more than the user's instruction.

They may read:

- repository files;
- web pages;
- email;
- issues;
- pull requests;
- tool output;
- logs;
- retrieved documents;
- other agents' messages.

OWASP recommends treating external data as untrusted because it can contain instructions that alter agent behavior.

The review therefore needs to identify where data becomes instructions.

A useful question is:

**Can content controlled by somebody outside this trust boundary influence what tools the agent executes?**

## 5. Memory and persistent state

Memory creates risks that normal request/response software may not have.

A bad value can survive the request that introduced it and affect later decisions.

Review should examine:

- who can write memory;
- who can read it;
- whether users or sessions are isolated;
- expiration;
- size limits;
- sensitive-data handling;
- validation before persistence;
- whether retrieved memory is trusted as instruction or merely data.

OWASP specifically identifies memory poisoning and recommends validation, isolation, expiration, and size controls.

## 6. Human approval must be an actual security boundary

For agents that can perform high-impact actions, an approval dialog is not sufficient by itself.

Reviewers should verify:

- what actions require approval;
- whether approval is bound to the exact parameters shown;
- whether the action can change after approval;
- whether stale approvals expire;
- whether retries can bypass approval;
- whether alternative tool paths can bypass the control.

OWASP recommends explicit approval and action previews for sensitive or irreversible operations, along with clear autonomy boundaries and audit trails.

The important review question is:

**Can the system reach the same dangerous effect through another path that does not pass the approval gate?**

## 7. State, failure, retries and cancellation deserve their own review

Agent systems are often asynchronous and stateful.

A typical workflow may contain:

`queued → running → tool call → waiting → retry → resumed → completed`

but also:

- `running → cancel`
- `tool call → timeout`
- `owner fails → failover`
- `partial success → retry`
- `worker dismissed → worker resumes`

These transitions create bugs involving:

- duplicate actions;
- lost messages;
- stale state;
- incorrect ownership;
- double settlement;
- retrying an irreversible operation;
- cleanup that never runs;
- cancellation races.

Traditional "edge case" review is often too broad to force careful reasoning about these transitions.

For agent software, **State, Failure & Lifecycle** should be a first-class review dimension.

This is consistent with general review guidance that concurrent behavior often requires deliberate reasoning rather than simple test execution.

## 8. Multi-agent systems require explicit trust boundaries

Subagents introduce another form of dependency.

An agent may receive output from another agent and treat it as:

- trusted evidence;
- instructions;
- tool arguments;
- code;
- state.

OWASP identifies cascading failures as a risk where a compromised or incorrect agent influences other agents. Its security guidance specifically includes multi-agent communication and adversarial tests for multi-agent chaining.

A reviewer should therefore ask:

- Is subagent output validated?
- Can one agent increase another agent's authority?
- Are identities and ownership clear?
- Can a failed subagent leave shared state inconsistent?
- Can instructions propagate across agents unexpectedly?

## 9. Runtime effect is different from static correctness

One of the strongest themes across conventional review guidance and the `/review-impl` audit is that reading code is not always enough.

Google explicitly notes that user-facing changes may need to be exercised because it can be difficult to understand their real effect only from source.

The audit of `/review-impl` reached the same conclusion from actual failures. It found that the review mainly used static evidence even though some defects appeared only when the real feature executed.

Two important escaped defects were one dependency hop outside the diff: new code relied on existing code whose real behavior did not satisfy the new feature's assumptions.

This suggests an important review principle:

> For important behavior, the reviewer should identify the smallest real execution path that proves the claimed effect.

Depending on the change, this may mean:

- invoking the production entry point;
- rendering and interacting with a UI;
- exercising a real state transition;
- using the actual provider/configuration;
- running an integration test instead of only a mocked unit test.

## 10. Review contracts in both directions

Traditional blast-radius review often asks:

**I changed X. Who uses X?**

That is necessary but incomplete.

Agent-generated code frequently introduces the reverse risk:

**I added X. What existing behavior does X depend on?**

The correct model is bidirectional:

`Consumers ← changed code → dependencies`

For consumers, check whether the new behavior breaks existing assumptions.

For dependencies, check whether existing functions actually guarantee what the new code assumes.

Important contract details include:

- return values;
- null and sentinel values;
- thrown errors;
- side effects;
- ordering;
- ownership;
- provider-specific behavior;
- mode-specific behavior;
- persistence;
- cancellation behavior.

This bidirectional contract review directly addresses the structural gap identified by the `/review-impl` audit.

## 11. Observability is part of correctness for agents

Traditional application code can sometimes fail locally.

Agents can fail across several steps while still producing a plausible final result.

Review should examine whether the system records enough information to answer:

- which agent acted;
- which tool was called;
- with what relevant parameters;
- what state transition occurred;
- what failed;
- whether a retry occurred;
- whether user approval was used;
- how much work/cost was consumed.

OWASP includes monitoring and observability as a core agent-security practice and recommends maintaining clear audit trails for agent decisions and actions.

Observability is therefore not merely operational convenience. In autonomous systems it can be required to determine whether the system behaved correctly.

## 12. Resource and autonomy limits

An ordinary function usually terminates because its control flow is fixed.

An autonomous agent may decide to continue:

`reason → tool → observe → reason → tool → ...`

Reviewers should inspect bounds on:

- retries;
- iterations;
- tool calls;
- recursive agent spawning;
- token usage;
- memory growth;
- time;
- network activity;
- financial cost.

OWASP explicitly identifies excessive autonomy and resource-exhaustion risks in agent systems.

A robust review should therefore ask:

**What guarantees that this process eventually stops?**

## 13. What this means for `/review-impl`

The current `/review-impl` skill already covers a substantial part of ordinary code review.

Agent 1 examines correctness, code quality and performance.

Agent 2A checks implementation against a written or conversational specification.

Agent 2B checks caller blast radius, reinvention, integration with neighboring code, regression tests and stale references.

The research suggests that the largest missing areas are not more generic style checks. They are:

1. Observable behavior / runtime effect
2. Bidirectional contracts: callers and dependencies
3. State, failure, cancellation, retry and lifecycle
4. Test independence and test integrity
5. Unexpected agent-created changes
6. Security and dependency risk
7. Agent-specific trust boundaries when agent infrastructure is touched
8. Severity and impact classification

There is also a structural issue: when a large task has a specification, the current skill uses Agent 2A for Design vs Spec instead of Agent 2B for Integration & Fit.

A specification does not remove integration risk.

The research therefore supports making integration/contract review mandatory, while treating specification comparison as an additional intent check rather than a replacement for integration review.

## 14. Recommended review model

A practical agent-aware review can be reduced to eight questions.

**1. Intent**
Did we build the right thing?
Check requirements, constraints and unwanted scope expansion.

**2. Effect**
Does the real system actually do it?
Exercise important user-visible or runtime-sensitive paths where practical.

**3. Contracts**
Do both sides of every changed relationship still agree?
Check callers and dependencies, including error and sentinel semantics.

**4. Failure**
What happens when the happy path stops halfway?
Check concurrency, cancellation, retries, failover, partial completion and cleanup.

**5. Evidence**
Do the tests independently prove the behavior?
Do not treat green tests written by the same agent as sufficient evidence.

**6. Provenance**
Did the agent change anything we did not ask it to change?
Inspect all task-created changes, especially tests, dependencies, rules, CI and build files.

**7. Trust**
Did this change cross a security or agent authority boundary?
Check tools, permissions, prompts, untrusted context, memory, approvals, secrets and multi-agent communication.

**8. Code health**
Is the resulting system understandable, maintainable and reasonably efficient?
Only after the higher-impact questions should the review spend significant attention on ordinary abstraction, duplication, naming and performance issues.

## Conclusion

The research does not support building an agent-code review by simply adding more conventional checklist items.

The important change is where the reviewer looks and what counts as evidence.

Traditional review asks whether the changed code looks correct.

Agent-aware review must additionally ask:

- whether it actually produces the claimed effect;
- whether its dependencies satisfy its assumptions;
- whether failure transitions remain correct;
- whether the tests genuinely prove anything;
- whether the agent changed anything unexpected;
- and whether tool, context, memory or permission boundaries can be abused.

For code that implements agents, the review boundary must expand from individual functions to authority, state and information flow.

That is the main difference between ordinary code review and mature review of agent-written or agentic software.

## Primary sources

- GitHub, *Review AI-generated code* — functional checks, intent, architecture, dependencies and AI-specific review failures.
- OWASP, *Secure Coding with AI Cheat Sheet* — risks specific to agentic coding tools, including dependencies, prompt injection, MCP, rules files, out-of-scope edits, test manipulation and build/CI changes.
- OWASP, *AI Agent Security Cheat Sheet* — tool security, prompt/context trust, memory, human approval, output validation, observability, multi-agent security and adversarial validation.
- OWASP, *Top 10 for Agentic Applications 2026* — current peer-reviewed security framework for autonomous agent systems.
- Google Engineering Practices, *What to Look For in a Code Review* and *The Standard of Code Review* — baseline review principles for functionality, design, tests, concurrency, complexity and code health.
