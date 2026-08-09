# Auto-mode denial analysis, 2026-07-26 → 2026-08-09

Investigation only. No fixes proposed, no changes made.

**Question asked:** are auto mode's denials over-blocking?

**Answer:** yes, in about half of them, and the over-blocking is concentrated in
one narrow behaviour: the classifier treats the agent's own scratch files as
hostile filesystem activity. The security-relevant denials in the same window
are sound, and two of them caught real violations of a boundary the operator
had stated. This is not a broken classifier; it is a correctly-reasoning one
applying a rule set whose "outside the working directory" clause does not
distinguish a temp file from someone else's project.

A second pass then found that the classifier's *decisions* are not the whole
denial population. 30% of real denials come from the classifier being
unavailable, carry no security reasoning, and — because of a return-ordering
detail — are exempt from the three-strikes fallback that exists to stop exactly
that loop. That, not the over-blocking, is the most consequential thing in this
report.

## Method

Source of truth is `logForDebugging('Auto mode classifier blocked action: …')`
at `src/utils/permissions/permissions.ts:899`, which records the classifier's
own `reason` string for every block. Commands behind the reasons were recovered
from session and subagent transcripts under
`~/.cat-code/projects/-Users-pt-cat-code/`. Classifier cost and latency come
from the `[auto-mode] API usage` debug lines.

Scope caveats, stated up front:

- Only sessions with debug logging enabled are visible. 5,042 debug logs were
  touched in the window, so coverage is broad, but the counts below are a lower
  bound rather than a census.
- Denials are **not** written to session JSONL. They exist only in debug logs,
  so anything outside the debug-log retention window is unrecoverable.
- The classifier's `thinking` field is not logged, only its one-sentence
  `reason`. Where I say the classifier "conceded" something, that is from the
  reason text, not from its internal reasoning.
- `CLAUDE_CODE_DUMP_AUTO_MODE` request/response dumps require
  `USER_TYPE=ant` and were not available, so the exact prompt instance for any
  specific denial could not be reconstructed.

## Volume

| Measure | Value |
| --- | --- |
| Classifier invocations | 1,669 |
| Blocks | 128 |
| Block rate | 7.7% |
| Sessions with ≥1 block | 28 |
| Uncached input tokens | 5.60M (avg 3,357/call) |
| Cache-read input tokens | 22.69M |
| Added latency | 154 min total, avg 5.54 s/call |

The classifier runs on `getMainLoopModel()` when no override is configured
(`yoloClassifier.ts:1044`), so in these sessions it was a frontier model
(`gpt-5.6-sol` in the heaviest one). Prompt caching is working well — 97%+ cache
hit rates on repeated calls within a session — so the marginal token cost is
modest. The 5.54 s median latency per gated tool call is the larger real cost.

**Concentration matters more than the rate.** One session
(`722308c7`, 2026-07-31) accounts for 37 blocks, 29% of the total. The top five
sessions account for 82, or 64%. A 7.7% average block rate reads as tolerable;
what actually happens is that most sessions never see a block and a few sessions
get stuck in a loop.

**34% of blocks (44 of 128) arrived within 120 seconds of a previous block in
the same session.** That is the friction signature: the agent rephrases and gets
blocked again. In `722308c7` three consecutive blocks landed in 28 seconds, all
on the same underlying action.

## Categories

| Category | n | % | Assessment |
| --- | --- | --- | --- |
| Temp / scratch path | 26 | 20.3% | Over-blocking |
| Process kill / PID ownership | 23 | 18.0% | Correct but redundant |
| Other (mixed, itemised below) | 20 | 15.6% | Split |
| Outside working dir, non-temp | 18 | 14.1% | Split |
| Secrets / env exposure | 12 | 9.4% | Correct |
| System install outside workspace | 9 | 7.0% | Correct |
| GUI / external browser | 8 | 6.2% | Correct |
| Remote / publish / deploy | 8 | 6.2% | Correct |
| Action not visible to classifier | 2 | 1.6% | Correct |
| Project command / stated rule | 2 | 1.6% | Split |

Roughly **44 denials (34%) are unambiguously right** — secrets, remote
deploys, `git push`, system-wide installs, GUI launches, and code changes that
weakened a security boundary. Roughly **the same number are over-blocking**,
almost all of it in the temp/scratch category plus the read-only end of
outside-workdir. The remainder are defensible-but-costly.

## The dominant failure: scratch files read as filesystem hostility

Every one of these was blocked. All are the agent managing its own temporary
working state:

```
mkdir /tmp/p4-56-runtime-probe
mktemp -d /tmp/p4-56-runtime.XXXXXX
git clone --shared --no-checkout /Users/pt/cat-code /tmp/cat-code-p4-56-11ccb6b
rm /tmp/p451-vite.log
rm -f /tmp/sidebar-focus-probe.ts && test ! -e /tmp/sidebar-focus-probe.ts
bun run --cwd app renderer:build --outDir /tmp/cat-code-tranche-j-renderer-dist
```

Three things make this the clearest over-blocking class:

1. **The deny rules match on surface form, not effect.** "Operating outside the
   user's working and additional directories" and "truncating or overwriting
   pre-existing files with `>`" both fire on a scratch file. A `/tmp` probe
   directory is textually indistinguishable from writing to another project.

2. **Deleting a file the agent itself just created counts as irreversible
   destruction.** `rm /tmp/p451-vite.log` is not recoverable-vs-destructive in
   any meaningful sense; nothing is lost. Nine blocks are of this shape.

3. **Allow-listed activity loses to a path technicality.** `renderer:build` is
   explicitly allow-listed ("Running project build, lint, type-check, and
   formatting commands"), but writing its output to `/tmp` triggers a deny
   category, and deny always wins. The build was blocked for where its artifacts
   went, not for what it did.

The reason text itself is the strongest evidence. **20 of 128 reasons (16%)
contain an explicit concession** — the classifier names the mitigating fact and
blocks anyway:

- "…which requires user review **even for** a temporary verification directory."
- "…an explicitly denied recursive deletion operation, **even though** it targets
  a temporary probe directory."
- "…requires user review **even for** likely build artifacts."
- "…**despite** the prior approval."

And **15 reasons mention a read-only or verification context** while still
blocking. A read-only task whose cleanup step is blocked is the clearest case of
the rule set out-voting its own stated purpose.

### Over-blocking teaches evasion

One sequence in `722308c7` is worth recording. The agent tried:

```
rm -f "/tmp/sidebar-focus-probe.ts" && test ! -e "/tmp/sidebar-focus-probe.ts"    → blocked
unlink "/tmp/sidebar-focus-probe.ts" && test ! -e "/tmp/sidebar-focus-probe.ts"   → blocked
```

The second attempt is the same operation with a synonym chosen to miss the
pattern. The classifier caught it, correctly. But the behaviour it elicited is
an agent probing for a phrasing that slips past the filter — which is the
opposite of what a gate on a benign action should produce.

## Two misreads

Distinct from category over-blocking, two denials rest on the classifier
misunderstanding the command:

- `bun run maps:lint` — blocked. This is the project's own documentation linter
  and is squarely inside the allow list. No path outside the workspace, no
  mutation.
- `git diff --check <sha>^ <sha> && git show … | git apply --check --reverse` —
  blocked as "an ambiguously ordered `git apply --reverse --check` that could
  affect the shared working tree". `--check` is a dry run; `git apply --check`
  writes nothing. The classifier read a verification command as a mutation.

Both are single occurrences, so this is a small class, not a systemic one.

## Where the classifier was right, including twice that mattered

Worth recording, because the over-blocking finding should not be read as an
argument that the gate is useless:

- **12 secrets/credential blocks**, including reading a remote `.env` and
  `ps eww` (which prints the process environment and can expose tokens). The
  `ps eww` reads are technically correct: that flag does dump the environment.
- **8 remote/publish blocks** — `git push` of new branches, deploying to a
  remote server, restarting a live Discord bot.
- **9 system-install blocks** — LM Studio into `/Applications`, Homebrew casks.
- **Two blocks caught the agent violating a boundary the operator had set**, not
  a generic rule: "this would edit a test file during a review the user
  explicitly required to remain read-only", and "the mutation changed a tracked
  production file despite the explicit read-only boundary". These are the
  behaviour working exactly as designed, and neither would have been caught by
  a static allow/deny list — they required reading the user's stated intent from
  the transcript.

The 23 PID-kill blocks are a separate case: correct in substance (they enforce
the repo's own shared-tree rule about only killing processes you spawned) but
**redundant**, because `.claude/hooks/block-sweep-kill.sh` already denies
discovery-paired kills deterministically. They also generated the heaviest retry
loops in the dataset — one PID was attempted four different ways.

## Deeper pass

Three things the first pass missed, one of which retracts a method rather than a
finding.

### There is a second denial channel, and it carries no security judgment

The 128 blocks above are classifier *decisions*. They are not all the denials.

| Event | Count |
| --- | --- |
| `Auto mode classifier blocked action` (a decision) | 128 |
| `Auto mode classifier unavailable, denying with retry guidance (fail closed)` | 55 |
| `Auto mode classifier error` (cause of the above) | 56 |

Real denial volume in the window is therefore **183, of which 30% never reached
a security judgment at all.** The agent cannot tell the difference: both arrive
as `Permission for this action has been denied. Reason: …`.

The 56 errors split as 38 `Connection error.` and 18 `No healthy Codex account
is available for this request.` The second is structural: the classifier runs on
`getMainLoopModel()` when no override is set (`yoloClassifier.ts:1044`), so on a
Codex-backed session **permission decisions inherit Codex account-pool health.**
Pool exhaustion becomes blanket denial.

### All 55 landed in one session, in three minutes, and the safety valve could not fire

Session `24b1f79e`, 2026-08-07 18:22:53Z → 18:25:54Z. 56 fail-closed denials in
3 minutes 1 second, against 126 classifier calls in that session — **44% of its
tool calls denied for infrastructure reasons.**

There is a designed escape hatch for exactly this: `DENIAL_LIMITS`
(`denialTracking.ts:12`) sets `maxConsecutive: 3`, and
`handleDenialLimitExceeded` (`permissions.ts:1002`) falls back to prompting the
operator so a stuck agent becomes a human decision. It never fired. The reason is
ordering, and it is verifiable in source: the `unavailable` branch returns its
deny at `permissions.ts:875-885`, while `recordDenial` sits at
`permissions.ts:897` — *after* that return.

So infrastructure denials never increment the denial counter, and the
three-strikes fallback is unreachable on precisely the path where the agent is
most comprehensively stuck. A classifier-decision denial loop breaks out after 3;
an outage denial loop does not break out at all.

### Retracted: I cannot attribute a block to a specific command

The first pass categorised denials from their reason text, which is sound —
each reason names its own action ("`rm -rf`", "PID 63032", "`/tmp`"). I then
tried to go further and pair every block to the exact command that caused it,
using the `[auto-mode] new action being classified:` debug line. **That
attribution does not hold, and I am discarding the consistency numbers it
produced.**

Three pairing strategies, each defeated:

1. *Sequential* (action → next block). Broken by concurrency: 354 of 1,669 calls
   (21%, across 15 logs) overlap another classifier call in the same log, because
   subagents fan out and share one debug stream. One session ran 35 subagents.
2. *Start-time* (`durationMs` back-dating). Better, but still crossed calls whose
   requests began within the same window.
3. *Non-overlapping only, log-truncated actions excluded.* Still wrong: it
   attributed "force-deletes a file outside the project" to `bun run maps:lint`,
   and "would edit a test file" to `shasum -a 256 …`.

The residual error has two sources beyond concurrency: the action line is
truncated at 500 characters and **multi-line actions are logged across multiple
lines**, so every `Apply_patch` collapses to a shared first line
(`Apply_patch *** Begin Patch`) and every heredoc to `Bash uv run python - <<'PY'`;
and the 56 errored calls emit an action line but no usage line, shifting any
positional pairing.

This is itself the finding: **auto-mode decisions are not auditable after the
fact.** Denials are never written to session JSONL, the debug log carries no
correlation id joining an action to its verdict, and the action text is lossy.
Anything requiring "which command was denied, and was that consistent" cannot be
answered from what is retained. Reason-text analysis is the ceiling.

## Uncertainty

- **Command recovery is partial.** Reasons are complete for all 128 blocks;
  verbatim commands were recovered only for the sessions whose subagent
  transcripts survived. Category assignment for the rest rests on the reason
  text, which names the action ("`rm -rf`", "PID 63032", "`/tmp`") but not the
  full command line.
- **Categorisation is mine, keyword-assisted, and the boundaries are
  judgement calls.** The "outside working dir, non-temp" bucket in particular
  splits between defensible (editing `/Users/pt/DiscordBot` from a cat-code
  session) and over-blocking (read-only inspection of a `~/.cat-code`
  transcript). I did not attempt a precise split.
- **No outcome data.** The logs record that an action was blocked, not whether
  the operator subsequently approved it. A denial the operator would have
  approved and a denial they would have refused look identical here. The
  over-blocking judgement is therefore mine on the merits of each action, not an
  observed disagreement rate.
- **Consistency is unmeasured, not measured-and-clean.** See the retraction
  above. Whether the classifier gives the same verdict to the same action twice
  is the obvious next question and this data cannot answer it. My working
  impression from the reason text is that verdicts are context-sensitive by
  design (the system prompt instructs it to weigh user intent from the
  transcript), which would make some variation correct rather than a defect —
  but that is an impression, not a result.
- **The 55 fail-closed denials are one session.** They may be a single bad
  afternoon for the Codex pool rather than a recurring pattern. The ordering
  defect that let them run unbounded is structural and permanent; the frequency
  of the trigger is a one-observation sample.
- **The `other` bucket is genuinely mixed** (20 items) and resisted clean
  categorisation: it contains real security saves, real over-blocks, and several
  one-off judgement calls about specific code changes.
