# How GPT behaves as a code reviewer here, and what to feed it

Ten rounds of ChatGPT bug-hunting against this repository, every finding
independently verified before any code changed, plus one controlled-ish
comparison against the same model family running with tools through cat-code,
plus a literature check on both.

**Headline:** the mechanism-reading is trustworthy, the severity is not, and the
lane you route through matters for quota reasons more than quality ones.
73 findings, 42 real, 30 fixed and on `migration`.

---

## 1. What was run

| | Setup |
|---|---|
| Reviewer | ChatGPT via the My Mac Files connector, read-only, one shot per round |
| Target | `/Users/pt/cat-code` at branch `migration` |
| Rounds | 10, each with a growing ledger of already-closed findings |
| Verification | A separate agent per round, read-only, reading cited source before any verdict |
| Implementation | Separate agents, one file owned by exactly one agent, failing-first test required |

Fix commits run `a5c24667` through `deb5e9de`, plus merge `7a5e4e8b`.

## 2. Outcome

- **73 findings filed**
- **42 held up** (58%)
- **29 refuted** (40%)
- **2 unsettled from source alone**
- **30 fixed and on `migration`** (29 direct, 1 merged from a worktree), 12 deliberately left alone

Of the 12 left alone: five touch live credentials (one would have to delete a
real keychain entry), the rest are real defects nothing reachable exercises.

### Per round

| Round | Area | Findings | Real |
|---:|---|---:|---:|
| 1 | unguided | 6 | 3 |
| 2 | unguided | 10 | 6 |
| 3 | unguided | 10 | 3 |
| 4 | unguided | 3 | 0 |
| 5 | unguided | 6 | 4 |
| 6 | `src/tools/`, `src/commands/` | 9 | 3 |
| 7 | `src/codex-core/`, `src/services/api/` | 8 | 7 |
| 8 | `app/renderer/src/` | 5 | 4 |
| 9 | query pipeline, agents | 8 | 6 |
| 10 | settings, storage, host | 8 | 6 |

Rounds 1 to 5 ran against a growing exclusion ledger and nothing else. By round
4 that ledger had tripled in size, become mostly prohibitions, and sat ahead of
the actual task. Yield collapsed to three findings, none real. That was a fault
in the asking, not in the repository: the excluded-file list was 2% of the tree.

Inverting the ledger so the task came first, and naming one unexplored area per
round, moved yield 3 to 6 to 9. **Output volume tracks request shape closely
enough that a badly built prompt reads as an exhausted codebase.**

## 3. Its own severity label is worth something

| Claimed | Held up | Rate |
|---|---:|---:|
| `high` | 21 of 29 | 72% |
| `medium` | 19 of 42 | 45% |
| `low` | 2 of 2 | n too small |

Useful for ordering a verification queue. Never sufficient for ordering a
fixing queue.

## 4. The failure modes

All three main modes are one thing: **it reads a function correctly in
isolation and fails at every direction of context around it.**

- **Backward** (who calls this?) → 8 findings
- **Forward** (what absorbs this downstream?) → 9 findings
- **Upward** (why is it written this way?) → 7 findings

### Inflated consequence, 9 of 29

The dominant mode, and it extends past the refutations: roughly ten of the 42
*real* findings also had impact cut during verification, described as inert,
off any production path, or self-healing.

> Reported that a permanent rejection in the delivery acknowledgement queue
> strands every item after the first batch. The queue bug was exactly as
> described. But the payload is bounded primitives, about 22 KiB against a
> 128 KiB cap, so the rejection it depends on can never fire.

### Deliberate design read as defect, 7 of 29

Code whose own comment, one or two lines above, explains why it is that way.
It never says "this looks intentional but I think it is wrong."

> Reported that per-record rejection during transcript backfill is not fatal to
> the run. The opposite policy caused real harm here once, when a single
> unparseable record abandoned 30 of 32 queued caches, and the regression test
> pinning current behaviour says so in its comment.

**This is the dangerous class.** Acting on one of these without verification
reverses a protection someone installed on purpose.

### Never asks who calls it, 8 of 29

Reasons forward from a function without establishing anything reaches it.
Twice it filed findings in code with no live caller at all.

> Reported that an HTTP POST path lacks a per-attempt timeout. That function is
> unreachable: both construction sites route writes through a different client,
> which never calls it.

### Refiles rejections until told not to, 2 of 29

Round 4 spent two of three findings re-filing a claim refuted in round 2,
reframed. One sentence in the ledger, saying not to re-file under a new title
and instead name the evidence defeating the stated reason, ended it: **zero
refiles across rounds 5 to 10.**

### Rank by cost if you skip verification, not by frequency

1. **Deliberate-design** — actively destructive, undoes intentional protection
2. **Inflated consequence** — wrong fix order, misspent risk budget
3. **Unreachable** — wasted effort only

The third-most-frequent mode is the most dangerous.

## 5. What it did not get wrong

- **Zero fabricated citations in 73 findings.** Line numbers drifted as the tree
  moved; symbols were always real. This is better than the literature predicts
  (see §7) and is probably structural: a connector that forces real file reads
  cannot cite what it never opened.
- **Respected stated constraints.** Told which architectural decisions were
  closed, it never proposed reopening one. Given a contested-file list, it
  stopped filing against those files.
- **Strongest where correctness lives in interleavings** — accounts and
  credentials 7 of 8, query and subagent pipeline 6 of 8. Weakest on display
  logic, where a tolerant fallback is correct by design.

## 6. The tools comparison, and why it proves less than it looks

Same brief, same area (`src/tools/` + `src/commands/`), same required-response
format including "reachable execution path". Neither was told to name callers.

| | ChatGPT, connector | gpt-5.6-sol via cat-code |
|---|---:|---:|
| Findings | 9 | 10 |
| Held up | 3 (33%) | 8 (80%) |
| Unreachable / dead-code / bad-citation | — | **0 of 10** |
| Citations accurate | — | 9 of 10 |
| Named a real reachable path | — | 9 of 10 |
| Severity inflated | not measured | 6 of 10 |

**Do not read 33% as the connector's rate.** It is round 6 alone, which was one
of its weaker rounds against a 58% average and a 0 to 87% per-round range. Round
6 is quoted because it is the only round with a matched control. An average
round would have read 5 of 9 against 8 of 10, a far less dramatic gap than the
table implies, and both samples are about ten findings.

### Two corrections to my own first read

**A primed validator inflated the result.** My first verification agent was told
the 3-of-9 baseline and returned 10 of 10. A blind adversarial re-check,
told nothing and instructed that an all-real review is the exception, returned
**8 of 10**. Use 80%. Telling a checker not to anchor is not a control.

**The design is confounded.** It changed at least three variables at once:

1. tool access (none to full)
2. surface (ChatGPT product layer to the Codex/cat-code harness with its own
   system prompt, repo instructions, and execution loop)
3. possibly the deployed model itself

On (3): OpenAI's model catalog has a distinct **"ChatGPT models"** category
described as used in ChatGPT and *not recommended for API use* — verified
first-party. A stronger claim, that ChatGPT and Codex have sat on different
GPT-5.6 versions since August 2026, could not be verified (the OpenAI post
returns 403 to automated fetching), so treat it as unconfirmed.

**Therefore:** "tool access fixed the reachability failures" is one of three
live explanations, not an established one. A difference between the two
workflows is real, though its size is uncertain: 33 to 80 on the matched round,
nearer 58 to 80 against the connector's average. The causal attribution is not
supported by this design, and the routing conclusion in §8 does not rest on it.

### And it may invert the central claim

The tempting conclusion was "severity inflation is the model, everything else is
the pipe." Against that:

- A peer-reviewed *Nature* 2026 study found warmth-tuned model variants had
  10 to 30 percentage points higher error rates and were about 40% more likely
  to affirm incorrect user beliefs.
- The FlipFlop experiment: models flipped answers 46% of the time under a bare
  "are you sure?", losing 17% accuracy, with no new evidence supplied.
- OpenAI's own April 2025 sycophancy incident traced to a user-feedback reward.

If ChatGPT carries heavier agreeableness tuning than Codex, **severity inflation
may be a product trait rather than a model trait.** Honest position: it is
established on the ChatGPT surface at n=73; whether it persists in Codex is
unresolved. The Codex-side figure is n=10, and the two verifiers agreed on the
count of six while overlapping on only three of the specific items.

## 7. What the literature says

Citations below were spot-checked: 4 of 4 open-access ones matched their stated
numbers exactly. Nature and Springer links redirect to publisher auth and were
not verified.

**Our 42% false-discovery rate is normal.** Realistic repository studies land in
a 15 to 42% band. SWE-PRBench measures fabrication from 19.3% (GPT-4o) to 41.7%
(Llama 3.3 70B) across 350 real PRs and 8 models. RepoAudit reports ~21.6%
false discoveries at repository scale, *with* validators.

**Failure mode 3 has a name.** SemBench found models "confusing static
call-graph reachability with runtime feasibility, and confusing *unused* with
*unreachable*."

**Failure mode 2 is quantified elsewhere.** Jin & Chen's taxonomy of 4,190
false-rejection rationales puts "Added Requirement" at 14.1% and "Misread Spec"
at 11.7%. Ours was 24% of rejections.

**Someone else independently invented the deliberate-design register.** A
practitioner report says a "known acceptable patterns" prompt section became
essential because without it the model flagged intentional architectural
decisions as problems.

**More context is actively worse.** SWE-PRBench found all eight models degraded
*monotonically* from diff-only to file to full context, attributed to attention
dilution; a ~2,000-token diff beat a ~2,500-token richer prompt for every model.
OpenAI separately reports internal coding-agent evals where *simplifying* system
prompts improved scores 10 to 15% — independent corroboration of the round-4
ledger collapse above.

**Two gaps this work touches.** Severity inflation is "widely reported but less
formally quantified" with no clean published statistic. And no peer-reviewed
study does a clean same-model tools-versus-no-tools code-review ablation; the
missing experiment is described as holding model, prompt and target constant
while varying only tool access. §6 is a confounded attempt at exactly that.

Key sources: [SWE-PRBench](https://arxiv.org/abs/2603.26130) ·
[RepoAudit](https://proceedings.mlr.press/v267/guo25n.html) ·
[HalluJudge](https://arxiv.org/abs/2601.19072) ·
[OpenCodeReview](https://arxiv.org/abs/2608.09290) ·
[RevMate](https://arxiv.org/abs/2411.07091) ·
[FlipFlop](https://arxiv.org/abs/2311.08596) ·
[Sycophancy](https://arxiv.org/abs/2310.13548) ·
[OpenAI model catalog](https://developers.openai.com/api/docs/models/all)

## 8. What to actually do

**Generate on the connector, verify on cat-code.** Not "route review to cat-code":
that spends the scarce resource on the wrong stage. The two lanes draw on
different quota pools and only one is rate-limited. The connector runs on the
ChatGPT subscription, in parallel, competing with nothing, so it is the right
place for high-volume discovery even at a 58% hit rate. `cat-code -p --model
gpt-5.6-sol` runs on a five-hour rolling window, so quota-time is its scarce
unit and a USD cap is meaningless there. Spend it on the survivors, where
following a call graph and running tests is decisive.

The corollary is that the cost of a low hit rate is not paid where it is
generated. Verification labor lands on the Claude session, which has its own
clock-based limit. This run spent roughly 1.4M subagent tokens verifying 73
findings. A cheap filter inside the free call is therefore worth more than a
marginally better generator, which is what the artifact-demanding response
block below is for.

**Keep an independent verifier either way.** Inflated severity appeared on both
surfaces. Do not let the verifier see any prior score or baseline; that made
ours lenient by two findings out of ten.

**Context pack, small and ordered:**

1. Task first. Constraints and exclusions last, compressed to one line each.
2. Deployment facts: one user, one macOS machine, no MDM, which feature gates
   are compiled in, which env vars are never set.
3. A "looks wrong, is deliberate" register: the thing, why, what broke last time.
4. A severity rubric with worked examples. Neither tools nor context fixed
   severity on their own.
5. Assign one unexplored area per round. Left alone it re-treads high-traffic
   files and returns thin, which is not evidence the code is clean.
6. Ban re-filing explicitly, and ask it to name the evidence defeating a
   rejection rather than restating the claim.

**Do not add more source.** It read code fine; every failure was about what is
*not* in the source. Two independent findings say volume makes review worse.

## 9. Limits

- One repository, one reviewer, 73 findings, adjudicated by agents of the same
  family as the reviewer. A checker sharing a model's blind spots waves through
  the findings that exploit them, so the true rate is more likely below 58%
  than above it.
- The prompt changed mid-study. Rounds 6 to 10 got a restructured ledger and an
  assigned area, so the halves are not a controlled experiment. The recovery is
  equally consistent with the later areas simply being unexplored.
- Severity rates rest on 29 `high` and 42 `medium`. Enough to see a gap, not to
  put an interval on it.
- §6 is n=1 per condition, one area, and confounded three ways.
- Every fix carries a test that failed before and passed after, with its area
  battery green. That is evidence the fixes are correct, not that the findings
  mattered. Several would likely never have fired in practice.
