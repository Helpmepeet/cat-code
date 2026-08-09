# Auto-mode denial analysis, 2026-07-26 → 2026-08-09

Investigation only. No fixes proposed, no code changed.

**Revision 2.** An adversarial review found the first version's headline
proportion, its auditability claim, and its safety-valve consequence to be
wrong. All three were verified against source and data and are corrected here.
The correction changed the dataset itself: denials *are* recoverable from
session JSONL with their exact command, which supersedes the debug-log sampling
the first version relied on. Numbers below differ from revision 1 for that
reason. Revision-1 errors are recorded in the last section rather than quietly
dropped.

**Question asked:** is auto mode over-blocking?

**Answer:** partly, but it is not the main thing wrong. Over-blocking accounts
for roughly a fifth of denials and is concentrated in one behaviour — the
agent's own scratch files read as hostile filesystem activity, now proven rather
than assumed. Two larger effects dominate the data: **half of all denials are
the agent re-attempting a command already denied**, and **23% of denials never
reached a security judgment at all** because the classifier was unavailable.

## Method

Primary source is session and subagent JSONL under
`~/.cat-code/projects/`, filtered by **entry timestamp** (not file mtime) to
2026-07-26T00:00Z – 2026-08-10T00:00Z. Denials appear as `tool_result` blocks
carrying `Permission for this action has been denied. Reason: …`
(`buildYoloRejectionMessage`, `src/utils/messages.ts:273`) or, for the
infrastructure path, `…is temporarily unavailable, so auto mode cannot
determine…` (`buildClassifierUnavailableMessage`, `src/utils/messages.ts:294`).
Each is joined to its originating command by `tool_use_id`, so **every denial
below has its exact command attached**.

Debug logs (`~/.cat-code/debug/`) are a secondary source used only for classifier
cost and latency, which JSONL does not carry. Debug coverage is a strict subset
of JSONL coverage: the debug-based scan found 128 decision denials, the JSONL
scan finds 208.

A reproducibility manifest accompanies this report:
`2026-08-09-auto-mode-denial-manifest.tsv` — one row per denial with transcript,
timestamp, tool, category, and sha1 prefixes of command and reason. No commands
or reason text are copied into the repo.

## Volume

| Measure | Value |
| --- | --- |
| Classifier-decision denials | 208 |
| Infrastructure denials (classifier unavailable) | 61 |
| **Total denials** | **269** |
| Distinct transcripts affected | 44 |
| Denials that repeat an already-denied identical command | 103 (50% of decisions) |

From the debug-logged subset (1,669 classifier invocations):

| Measure | Value |
| --- | --- |
| Decision denials in that subset | 128 → **7.7%** of invocations |
| All denials in that subset (128 + 55) | **11.0%** of invocations |
| Uncached input tokens | 5.60M (avg 3,357/call) |
| Cache-read input tokens | 22.69M — **80% of total input** |
| Added latency | 154 min total, **mean** 5.54 s/call |

The classifier runs on `getMainLoopModel()` when unconfigured
(`yoloClassifier.ts:1044`), so these sessions classified on a frontier model. The
80% aggregate cache-read share is the honest figure; individual repeated calls
within one session reach 97%+, which is a different quantity.

## Finding 1: half of all denials are retries of an already-denied command

77 distinct retry loops. **103 of 208 decision denials (50%) are a repeat of a
byte-identical command already denied in the same transcript.** Worst loops:

```
 x6  Apply_patch  *** Update File: /Users/pt/.agents/skills/chatgpt-review-pr/SKILL.md
 x6  printf '%s' '1a0f26ba…' | openssl dgst -sha256
 x4  cd "/Users/pt/.agents/skills/chatgpt-review-pr" && uv run python - <<'PY'
 x4  test ! -e "/private/tmp/chatgpt-review-pr-stale-schema-fix" && cp -R …
```

This is measured from JSONL, grouped per transcript and per exact command, so it
is a count of real repeats rather than temporal coincidence. (Revision 1 used a
120-second clustering heuristic over shared debug logs; that metric could not
distinguish a retry from two unrelated subagents and has been discarded.)

A related behaviour: the agent sometimes rephrases to evade rather than repeat.
In `agent-afb3c65f635cdacac.jsonl:218-222`, `rm -f "/tmp/sidebar-focus-probe.ts"`
was denied, and the next attempt was `unlink "/tmp/sidebar-focus-probe.ts"` — the
same operation under a different verb. Also denied.

## Finding 2: 61 denials carry no security judgment

| Event | Count |
| --- | --- |
| Classifier-decision denials | 208 |
| Fail-closed denials (classifier unavailable) | 61 |

In the debug-logged outage session `24b1f79e` (2026-08-07), 55 fail-closed
denials ran from **18:22:53.710Z to 18:24:53.299Z — almost exactly 2 minutes**,
against 126 classifier calls in that session. Cause split: **38 connection
errors and 17 "No healthy Codex account is available"**. A 56th error at
18:25:54.511Z was the *handoff* classifier, not the permission classifier, and it
**allowed** output with a warning — it is not a denial and is excluded.

The account-pool cause is structural: because the classifier runs on the main
loop model, **a Codex-backed session's permission decisions inherit Codex
account-pool health.** Pool exhaustion becomes blanket denial.

The agent *can* distinguish the two kinds. The unavailable path returns its own
message with explicit retry guidance ("Wait briefly and then try this action
again… read-only operations do not require the classifier"), unlike the standard
rejection. Both stop the action; only one explains that retrying may work — which
plausibly contributes to Finding 1.

## Finding 3: three separate defects around the outage, not one

Revision 1 claimed a return-ordering bug defeated a three-strikes fallback that
would have turned the storm into a human decision. The ordering bug is real; the
consequence was wrong. Three distinct issues:

**3a — Availability is coupled to the model/account pool.** As above.

**3b — Unavailable denials bypass denial tracking.** The `unavailable` branch
returns its deny at `src/utils/permissions/permissions.ts:875-885`; `recordDenial`
is at `:897`, after that return. So infrastructure denials never increment the
counter. Real, and confirmed.

**3c — There is no session-wide circuit breaker across parallel subagents, and
the per-agent one does not prompt anyone in this configuration.** This is what
revision 1 got wrong:

- Async subagents keep *local* denial state, not a session-global counter
  (`permissions.ts:976-994`, `persistDenialState` → `context.localDenialTracking`).
- On hitting the limit in headless mode the code throws `AbortError`
  (`permissions.ts:1041-1044`); it does **not** prompt the operator. Only the
  interactive path falls back to prompting (`:1047-1075`).

The 55 denials were spread across 22 subagents, with per-subagent counts of
`[7,6,6,4,4,3,3,3,3,2,2,2,1,1,1,1,1,1,1,1,1,1]`. With `maxConsecutive: 3`
enforced, **43 of the 55 would still have occurred** and the affected subagents
would have aborted rather than asked. Fixing 3b alone removes 12 denials and
converts some subagent work into aborts. It is not a circuit breaker.

## Finding 4: scratch-file over-blocking, with ownership now proven

| Category | n | % | Assessment |
| --- | --- | --- | --- |
| Process kill / PID | 48 | 23.1% | Correct but redundant |
| GUI / external | 40 | 19.2% | Correct |
| Temp / scratch path | 34 | 16.3% | Over-blocking |
| Other (mixed) | 27 | 13.0% | Split |
| Secrets / credentials | 26 | 12.5% | Correct |
| Outside workdir, non-temp | 26 | 12.5% | Split |
| Remote / publish | 7 | 3.4% | Correct |

Roughly **73 denials (35%) are unambiguously correct** — secrets, remote
deploys, GUI launches under the repo's own per-run authorization rule. Roughly
**34–45 (16–22%) are over-blocking**, essentially all of it the scratch-path
category plus the read-only end of outside-workdir. The 48 process-kill denials
enforce the repo's shared-tree rule correctly but duplicate
`.claude/hooks/block-sweep-kill.sh`, which already denies discovery-paired kills
deterministically.

**Ownership is now established rather than assumed.** For the 45 denials
referencing an explicit temp path, I checked whether the same transcript
referenced that path in an earlier `tool_use`: **40 were created earlier by the
same agent in the same transcript**; the other 5 name no explicit path. Zero
cases where the path had unknown or pre-existing ownership. So this category is
the agent being denied access to state it created itself.

The root cause is a genuine conflict inside the prompt, not a classifier error:
`permissions_external.txt:11` allows "project build, lint, type-check, and
formatting commands", while `:23-24` denies "operating outside the user's working
and additional directories" and overwriting pre-existing files with `>`. Deny
always wins, so `renderer:build --outDir /tmp/…` loses on where its artifacts
land rather than on what it does.

**20 of 128 debug-captured reasons (16%) contain an explicit concession** — the
classifier names the mitigating fact and blocks anyway: "even for a temporary
verification directory", "even for likely build artifacts", "despite the prior
approval".

## Confirmed misreads

Two denials rest on the classifier misreading the command:

- `bun run maps:lint` — the project's own docs linter, squarely allow-listed.
- `git diff --check … && git show … | git apply --check --reverse` — denied as
  "ambiguously ordered `git apply --reverse --check` that could affect the shared
  working tree". `--check` is a dry run. The same reason also cites "bare
  `python3`", which does not appear in the command
  (`agent-ab9307c23a6ee836b.jsonl:57-62`).

## Where the gate earned its cost

Two denials caught the agent violating a boundary the *operator* had stated, not
a generic rule: editing a test file during a review required to stay read-only,
and mutating a tracked production file under the same boundary. Neither would
have been caught by a static allow/deny list — both required reading intent out
of the transcript.

## Revision-1 errors

Recorded rather than silently corrected:

1. **"About half of denials were over-blocking."** Wrong denominator. On the
   corrected dataset it is 16–22% of decision denials and ~13–17% of all 269.
2. **"Denials are not written to session JSONL; reason-text analysis is the
   ceiling."** False. Every denial is retained with its command, joinable by
   `tool_use_id`. I had actually extracted 67 such pairs earlier in the same
   investigation, then generalised from a failed grep against a *parent*
   transcript — the denials live in the *subagent* transcripts. The debug-log
   timestamp-pairing I built, retracted, and reported as an auditability limit
   was unnecessary work against the wrong source.
3. **"The three-strikes fallback would have made this a human decision."** Wrong
   scope and wrong outcome; see 3c.
4. **"56 fail-closed denials over 3m01s."** 55, over ~2 minutes; the 56th event
   was the handoff classifier allowing output. Error split is 38/17, not 38/18.
5. **"The agent cannot tell the difference."** It can; the messages differ.
6. **"44 blocks within 120s prove retry loops."** Invalid over shared debug logs.
   Replaced with the JSONL-verified count (103).
7. Nits: 5.54 s is a mean, not a median; aggregate cache-read share is 80%, not
   97%; the block log call is at `permissions.ts:901`.

## Uncertainty

- **No approval outcomes.** Logs record that an action was denied, never whether
  the operator subsequently approved it. The over-blocking judgement is mine on
  the merits of each action, not an observed disagreement rate.
- **Consistency remains unmeasured.** Whether the same action gets the same
  verdict twice is answerable from this JSONL dataset but I have not done it.
  Note that some variation would be *correct*: the system prompt instructs the
  classifier to weigh user intent from the transcript, so identical commands in
  different contexts may legitimately diverge.
- **Category boundaries are my judgement**, keyword-assisted over command +
  reason text. The `other` bucket (27) and the outside-workdir split are the
  softest.
- **The 61 infrastructure denials are dominated by one session.** The ordering
  defect (3b) and the missing circuit breaker (3c) are structural and permanent;
  the frequency of the trigger is a one-observation sample.
- **Debug-derived cost figures cover only debug-enabled sessions**, a subset of
  the JSONL population, and are not directly comparable to the 269 total.
