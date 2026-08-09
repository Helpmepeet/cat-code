# Auto-mode denials, 2026-07-26 → 2026-08-09

Investigation. No code changed, no fixes proposed.

**Revision 3.** Restructured so the observations stand without a verdict
attached. Revisions 1–2 interleaved measurement with judgement — findings were
phrased as defects and absences ("no circuit breaker", "bypasses tracking"),
which names a desired state and therefore its repair. A problem statement is a
state plus a goal, and revisions 1–2 never declared the goal they were measuring
against, so the goal was smuggled in and the solution space narrowed silently.

Sections 1–6 are observations: facts recoverable from data or source, stated
without asserting anything should change. Section 7 records which observations
change meaning under which goal, without selecting a goal. Nothing here
identifies a problem or proposes work; whether any of this warrants action is a
separate decision, deliberately left open. Revision-2 numbers are unchanged.

## Method

Primary source is session and subagent JSONL under `~/.cat-code/projects/`,
filtered by **entry timestamp** to 2026-07-26T00:00Z – 2026-08-10T00:00Z.
Denials appear as `tool_result` blocks carrying `Permission for this action has
been denied. Reason: …` (`buildYoloRejectionMessage`, `src/utils/messages.ts:273`)
or `…temporarily unavailable, so auto mode cannot determine…`
(`buildClassifierUnavailableMessage`, `src/utils/messages.ts:294`). Each is joined
to its originating command by `tool_use_id`, so every denial counted here has its
exact command attached.

Debug logs supply classifier cost and latency only, which JSONL does not carry.
Debug coverage is a strict subset: the debug scan finds 128 decision denials, the
JSONL scan 208.

Companion manifest: `2026-08-09-auto-mode-denial-manifest.tsv`, one row per
denial with transcript, timestamp, tool, category, and sha1 prefixes of command
and reason.

## 1. Volume

| Measure | Value |
| --- | --- |
| Classifier-decision denials | 208 |
| Denials issued when the classifier was unavailable | 61 |
| Total | 269 |
| Distinct transcripts affected | 44 |

From the debug-logged subset (1,669 classifier invocations):

| Measure | Value |
| --- | --- |
| Decision denials in subset | 128 (7.7% of invocations) |
| All denials in subset | 183 (11.0% of invocations) |
| Uncached input tokens | 5.60M (mean 3,357/call) |
| Cache-read input tokens | 22.69M (80% of total input) |
| Latency added | 154 min total, mean 5.54 s/call |

The classifier resolves to `getMainLoopModel()` when unconfigured
(`yoloClassifier.ts:1044`); these sessions therefore classified on a frontier
model.

## 2. Repeated commands

**103 of the 208 decision denials repeat a byte-identical command already denied
earlier in the same transcript.** 77 distinct commands were denied more than
once. Highest repeat counts:

```
 x6  Apply_patch  *** Update File: /Users/pt/.agents/skills/chatgpt-review-pr/SKILL.md
 x6  printf '%s' '1a0f26ba…' | openssl dgst -sha256
 x4  cd "/Users/pt/.agents/skills/chatgpt-review-pr" && uv run python - <<'PY'
 x4  test ! -e "/private/tmp/chatgpt-review-pr-stale-schema-fix" && cp -R …
```

A related sequence, not a byte-identical repeat: at
`agent-afb3c65f635cdacac.jsonl:218-222`, `rm -f "/tmp/sidebar-focus-probe.ts"`
was denied and the following attempt was `unlink "/tmp/sidebar-focus-probe.ts"`
— the same effect under a different command name. Also denied.

## 3. Denials issued without a classifier decision

61 of the 269 denials were issued because the classifier did not return a
verdict. In the debug-logged session `24b1f79e` (2026-08-07), 55 of these ran
from **18:22:53.710Z to 18:24:53.299Z**, about 2 minutes, within a session making
126 classifier calls. Causes: **38 connection errors, 17 "No healthy Codex
account is available"**. A 56th error at 18:25:54.511Z came from the *handoff*
classifier and allowed sub-agent output with a warning; it is not a denial and is
excluded from all counts here.

Because the classifier resolves to the main-loop model, classifier availability
in a Codex-backed session tracks Codex account-pool health.

The two denial kinds carry different text. `buildClassifierUnavailableMessage`
states the model is temporarily unavailable and adds retry guidance ("Wait
briefly and then try this action again… read-only operations do not require the
classifier"). `buildYoloRejectionMessage` gives the classifier's reason and no
retry guidance.

## 4. Control flow around denial tracking

Stated as control flow, since the same facts support more than one reading.

- The unavailable branch returns its deny at
  `src/utils/permissions/permissions.ts:875-885`. `recordDenial` is called at
  `:897`. Denials issued on the unavailable path therefore do not reach
  `recordDenial` and do not increment `DENIAL_LIMITS` counters
  (`denialTracking.ts:12`, `maxConsecutive: 3`, `maxTotal: 20`).
- Async subagents hold denial state locally rather than session-globally
  (`permissions.ts:976-994`, `persistDenialState` writing to
  `context.localDenialTracking`).
- On reaching the limit, headless execution raises `AbortError`
  (`permissions.ts:1041-1044`). The prompt-the-operator path is reached only in
  interactive mode (`:1047-1075`).

Applying these to the session in §3: the 55 denials were distributed across 22
subagents, per-subagent counts
`[7,6,6,4,4,3,3,3,3,2,2,2,1,1,1,1,1,1,1,1,1,1]`. Had each subagent's counter
incremented on this path, 9 of the 22 would have reached a `maxConsecutive: 3`
cap and 5 would have exceeded it, leaving **43 of the 55 denials still issued**
and those 9 subagents raising `AbortError` rather than reaching an operator.

## 5. What was denied

| Category | n | % |
| --- | --- | --- |
| Process kill / PID | 48 | 23.1% |
| GUI / external (Electron, browser, ChatGPT launcher) | 40 | 19.2% |
| Temp / scratch path | 34 | 16.3% |
| Mixed / uncategorised | 27 | 13.0% |
| Secrets / credentials | 26 | 12.5% |
| Outside working dir, non-temp | 26 | 12.5% |
| Remote / publish | 7 | 3.4% |

**Path provenance.** For the 45 denials naming an explicit temp path, I checked
whether the same transcript referenced that path in an earlier `tool_use`: **40
were referenced earlier in the same transcript**; 5 name no explicit path; none
had a path with no prior reference.

**Process kills.** These enforce the same constraint as
`.claude/hooks/block-sweep-kill.sh`, which denies discovery-paired kills
deterministically before the classifier runs.

**Two denials cite an operator-stated boundary** rather than a standing rule:
editing a test file during a review the operator required to remain read-only,
and mutating a tracked production file under the same boundary. Both are stated
in the transcript, not in the rule set.

## 6. Rule interaction and reason-text mismatches

`permissions_external.txt:11` lists project build, lint, type-check and format
commands as allowable. `:23-24` lists operating outside the working directory,
and overwriting pre-existing files with `>`, as deniable. The base prompt states
that a deny category always wins over an allow category. A build command writing
output outside the working directory satisfies both.

Two denials carry reason text that does not match the command:

- `bun run maps:lint` was denied with a reason describing a force-delete outside
  the project.
- `git diff --check … && git show … | git apply --check --reverse` was denied
  with a reason citing "bare `python3`" and a mutation risk. The command contains
  no `python3`, and `git apply --check` performs no write
  (`agent-ab9307c23a6ee836b.jsonl:57-62`).

**20 of the 128 debug-captured reasons (16%) state a mitigating fact alongside
the denial** — "even for a temporary verification directory", "even for likely
build artifacts", "despite the prior approval".

## 7. What the reading depends on

The measurements above are stable. What they mean is not, because most of them
change sign depending on what auto mode is for. Recorded here so the dependency
is visible rather than assumed.

**If the operative goal is unattended throughput** — maximum useful work per
operator interruption — then §2 and §3 are the dominant quantities: half of all
denials spent re-denying an already-denied command, and 61 issued with no verdict
behind them. §5's temp-path group reads as denial of access to state the agent
itself created, given the provenance result.

**If the operative goal is limiting blast radius** — an unsupervised agent on a
tree shared with other sessions and the operator — then the same rows read
differently. §5's temp-path denials are the rule set applying as written; §2's
repeats are the expected cost of a conservative gate; §3's fail-closed behaviour
is the designed response to an unevaluable action, with the retry guidance in
`buildClassifierUnavailableMessage` as the intended recovery path.

The two readings diverge on §2, §3 and §5, and converge only on §6's two
mismatched reason texts, which are inaccurate about the command under either
goal.

Which goal is operative is not established here, and nothing in §1–6 settles it.

## Revision history

Revision 1 → 2 corrected seven errors found by adversarial review. Recorded
rather than dropped:

1. "About half of denials were over-blocking" — a verdict, and on a denominator
   that did not match the report's own counts. Revision 3 removes the verdict
   rather than restating it at a corrected figure.
2. "Denials are not written to session JSONL; reason-text analysis is the
   ceiling" — false. Every denial is retained with its command, joinable by
   `tool_use_id`. I had extracted 67 such pairs earlier in the same
   investigation, then generalised from a failed grep against a *parent*
   transcript; the denials live in the *subagent* transcripts. The debug-log
   timestamp-pairing built on that mistake was discarded.
3. "The three-strikes fallback would have made this a human decision" — wrong
   scope and outcome; see §4.
4. "56 fail-closed denials over 3m01s" — 55, over ~2 minutes; the 56th was the
   handoff classifier allowing output. Error split 38/17, not 38/18.
5. "The agent cannot tell the difference" — the two messages differ.
6. "44 blocks within 120s prove retry loops" — invalid over shared debug logs;
   replaced with the JSONL-verified count of 103.
7. Nits: 5.54 s is a mean; aggregate cache-read share is 80%; the block log call
   is at `permissions.ts:901`.

Revision 2 → 3 changed framing only. No number changed.

## Uncertainty

- **No approval outcomes.** Logs record that an action was denied, never whether
  the operator later approved it. Nothing here measures agreement or
  disagreement with the classifier.
- **Consistency is unmeasured.** Whether the same command gets the same verdict
  twice is answerable from this dataset; I have not done it. Some variation
  would be expected by design: the system prompt directs the classifier to weigh
  user intent from the transcript, so identical commands in different contexts
  may legitimately diverge.
- **Category boundaries are mine**, keyword-assisted over command and reason
  text. The 27-item mixed bucket and the outside-workdir split are the softest.
- **The 61 unavailable denials are dominated by one session.** The control-flow
  facts in §4 are permanent; the frequency of the trigger is a one-observation
  sample.
- **Debug-derived cost figures cover only debug-enabled sessions** and are not
  comparable to the 269 total.
