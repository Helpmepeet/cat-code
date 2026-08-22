# Appendix D — Yield normalization, trend, and battery-catchability

Companion to [the main audit](2026-08-22-review-impl-finding-quality-audit.md).

This lane supplies the denominators. It also corrects the corpus figures used elsewhere in
this report set; §1 is the correction and takes precedence.

---

## 1. Corpus correction

**The real corpus is 34 review runs, not 30, and 38 invocations.**

- `index.txt`'s 41 lines include 6 unrelated subagent transcripts (`agent-acompact-*`, dated
  April and June, before the skill existed) and one forked duplicate (`84680d00` duplicates
  `463ff374`'s single invocation).
- **Four sessions were almost entirely missed by the scrape** because their validation tables
  use `F1` / `C1` / `H2`-style ids rather than integers: `76e10e2b` (12 findings, scraped as 1),
  `cc9feb6e` (13, prose report, 0 scraped), `97b04c6f` (11, 0 scraped), `1ba97aa9` (10, 0
  scraped).
- **Four sessions ran `/review-impl` twice** — `05d68ce0`, `62445105`, `8f9051b7`, `3d21ec77`.

**`rows.txt` also double-counts.** The same finding is routinely listed once in the Step-3
validation table and again in a Step-4/5 summary. 382 scraped rows collapse to **~341 distinct
findings** (~10% restatement, concentrated in `3d21ec77` 33→~26, `77fbf5d0` 33→~22, `970c440d`
20→~18, `a9454c20` 17→~16).

**Best estimate of distinct findings across all 34 runs: ~375.** The scraped count is a floor in
one direction and inflated in another; both corrections are roughly a wash at corpus scale, but
neither should be quoted without the other. Figures below use raw rows so they stay comparable
to the 382 used elsewhere — discount ~10% for the true rate.

### One review found nothing

**`f6a7c289` (2026-08-09, 121-line diff, 1 agent) returned zero findings.** Its report walks
four specific claims and clears each. This is a real zero, not a scrape gap — which retires the
premise that the skill "always finds a problem."

---

## 2. Per-run table

`prov`: **S** = stated by the agent in-transcript · **G** = recovered from git using the exact
SHAs or file list handed to the reviewers · **P** = partial (patch-file line count only).

| session | date | diff | prov | agents | findings | VALID | f/100 | area |
|---|---|---:|---|---|---:|---:|---:|---|
| cc9feb6e | 07-26 | 694 | P | 2 | 13 | 13 | 1.87 | app |
| 379fa640 | 07-28 | 158 | S+G | 2 | 12 | 12 | 7.59 | app |
| 66f06b65 | 07-30 | 427 | G | 2 | 10 | 7 | 2.34 | src |
| a9454c20 | 07-30 | 1411 | S+G | 2 | 17 | 13 | 1.20 | src |
| d595a8ba | 08-02 | 210 | S+G | 2 | 8 | 5 | 3.81 | app |
| 55b8f9c3 | 08-02 | 820 | S+G | 2 | 14 | 10 | 1.71 | app |
| 2d7b530b | 08-04 | 515 | S+G | 2 | 9 | 5 | 1.75 | src |
| 62445105 | 08-04 | 1751 | S+G | 2+2 | 19 | 18 | 1.09 | app |
| 05d68ce0 | 08-04 | ~1300 | **P** | 2+2 | 16 | 15 | 1.23 | app |
| 970c440d | 08-05 | 406 | G | 3+3 | 20 | 16 | 4.93 | app |
| 6d0ce8ac | 08-05 | 518 | **G only** | 2 | 8 | 5 | 1.54 | app |
| 3dd55442 | 08-07 | 225 | S | 2 | 7 | 6 | 3.11 | app |
| 8f9051b7 | 08-07 | 1905 | G | 2+1 | 28 | 27 | 1.47 | app |
| 9b55eb47 | 08-07 | 620 | S | 2 | 10 | 9 | 1.61 | app |
| 1ba97aa9 | 08-08 | 140 | S+G | 1 | 10 | 8 | 7.14 | app |
| 2d5da6ab | 08-08 | 120 | S (soft) | 1 | 9 | 4 | 7.50 | app |
| 3aacc503 | 08-08 | 243 | S+G | 2 | 9 | 6 | 3.70 | src |
| f9b104ec | 08-08 | 530 | S+G | 2 | 11 | 11 | 2.08 | app |
| 23f4d3f7 | 08-09 | 868 | S+G | 2 | 12 | 6 | 1.38 | app |
| 4326538f | 08-09 | 384 | S+G | 2 | 7 | 6 | 1.82 | src |
| 76e10e2b | 08-09 | 358 | G | 2 | 12 | 11 | 3.35 | app |
| 97b04c6f | 08-09 | 316 | S+G | 2 | 11 | 10 | 3.48 | app |
| **f6a7c289** | 08-09 | 121 | **G only** | 1 | **0** | 0 | **0.00** | app |
| 77fbf5d0 | 08-10 | 2446 | G | 3+1 | 33 | 19 | 1.35 | app |
| 64fa9c9e | 08-13 | 277 | S+G | 2 | 6 | 4 | 2.17 | app |
| 36e61c86 | 08-13 | 1517 | **G only** | 2 | 6 | 3 | 0.40 | src |
| aee64f62 | 08-15 | 91 | S+G | 1 | 12 | 10 | 13.19 | app |
| 77a1d024 | 08-15 | 937 | S+G | 2 | 11 | 8 | 1.17 | app |
| 3d21ec77 | 08-16 | 4277 | G | 4+5 | 33 | 32 | 0.77 | app |
| 463ff374 | 08-17 | 379 | S+G | 2 | 11 | 5 | 2.90 | src |
| 3da947dd | 08-19 | 364 | S+G | 2 | 8 | 6 | 2.20 | app |
| 48a3d62b | 08-21 | 1604 | S+G | 4 | 10 | 5 | 0.62 | src |
| b7b41510 | 08-21 | 623 | S+G | 2 | 15 | 12 | 2.41 | app |
| 5df08177 | 08-22 | 192 | S+G | 2 | 10 | 6 | 5.21 | src |

**Zero UNKNOWN denominators.** 25 are stated-and-git-confirmed, 4 git-only, 3 genuinely soft.

---

## 3. The finding that undermines "findings per 100 lines"

- Findings per 100 lines: median **1.97**, IQR 1.32–3.54, mean 2.89
- VALID per 100: median **1.51**, IQR 0.95–2.77
- Pooled: 427 findings / 26,747 lines = **1.60 per 100**

**Spearman(diff size, findings per 100) = −0.78.** Spearman(diff size, *absolute* findings) is
only **+0.53**. A 4,277-line review produced 33 findings; a 91-line review produced 12.

**The reviewers return a roughly fixed budget of findings — median 10, IQR 8–13 — almost
regardless of how much code they were given.** Median by size band: 4.51 (&lt;300 lines), 2.20
(300–700), 1.22 (700–1600), 1.09 (&gt;1600).

Two consequences worth stating plainly:

1. **"Findings per 100 lines" is not a size-invariant quality metric here.** It is largely a
   proxy for `1/diff-size`. Any argument built on it — including the instinct to normalize that
   motivated this lane — has to be discounted accordingly.
2. **The absolute count is partly a property of the reviewer's reporting budget, not purely of
   defect density.** A review that reports ~10 items will report ~10 items on a clean 90-line
   diff and on a messy 4,000-line one. This is the strongest available explanation for why the
   count *feels* constant and alarming: to a first approximation, it is constant.

### Outliers

**High.** `aee64f62` 13.19/100 is the smallest diff in the corpus (91 lines) and half its rows
are restatements — really ~6.6/100, all six findings being comment-accuracy items on a logging
change, the cheapest class to find per line. `379fa640` 7.59 is likewise a restatement artifact
(→ ~3.8). **`1ba97aa9` 7.14/100 is the genuine high**: a small model-display fix where two `??`
operators each resurrected a stale override because `null` was a meaningful value.

`2d5da6ab`'s 7.50 is **elevated but imprecise, and should not be counted as a top-four
outlier.** Its denominator brackets 120 to ~310 lines (see §8), putting the true rate somewhere
in **3.0 to 7.5 per 100**. That stays above the corpus median of 1.97 across the whole range,
but at the upper end it lands mid-pack, below `d595a8ba` and `3aacc503`.

**Low.** `f6a7c289` 0.00 (the real zero). `36e61c86` 0.40 — 1,517 lines, 6 findings, **3 of them
false positives**, and 682 of those lines are a docs audit report. `3d21ec77` 0.77 has the
largest diff, the most agents, the lowest normalized yield **and the highest VALID ratio in the
corpus** — the size penalty is mechanical, not a quality signal.

---

## 4. Trend over four weeks: flat

- Spearman(date, findings per 100) = **−0.06**
- Spearman(date, absolute findings) = **−0.09**
- Spearman(date, diff size) = **−0.04**

All three are noise.

| | window | median diff | median findings | median f/100 | pooled f/100 |
|---|---|---:|---:|---:|---:|
| T1 | 07-26 → 08-05 (n=11) | 518 | 13.0 | 1.75 | 1.78 |
| T2 | 08-07 → 08-09 (n=11) | 358 | 10.0 | 3.11 | 2.21 |
| T3 | 08-09 → 08-22 (n=12) | 501 | 10.5 | 1.76 | 1.21 |

**Neither story the main report asked us to distinguish is true.** Diffs did not get bigger
(median 518 → 358 → 501, correlation ≈ 0) and raw counts did not rise (13 → 10 → 10.5, a mild
decline if anything). T2's median bump is entirely that window containing the corpus's cluster
of small diffs. T3's *pooled* drop is one session — `3d21ec77`'s 4,277-line denominator is 32%
of all lines in T3; remove it and T3 pools to 1.53.

**Over four weeks and 34 runs the yield is statistically indistinguishable.** The code is not
getting sloppier, and the review is not getting stricter.

---

## 5. Reviewer count does not inflate findings

The skill's 1-or-2 rule was followed in **27 of 34 runs**. Seven exceeded it, and every one
announced the deviation in-transcript — `77fbf5d0` split Agent 1 into app-runtime and
engine-runtime lanes because *"~2,000 lines of engine and desktop code would be spread too
thin"*; `3d21ec77` round 2 stated *"I'll go with 5 agents"*. Four runs used 1 agent, all
correctly under the 150-line threshold.

Comparing within the only band where both counts occur (diffs under 250 lines):

| | n | median diff | median findings | median f/100 |
|---|---:|---:|---:|---:|
| 1 agent | 4 | 120 | 9.5 | 7.32 |
| 2 agents | 5 | 210 | 9.0 | 5.21 |

**Same absolute yield.** The raw Spearman(agents, f/100) = −0.35 is pure confound: agent count
is *assigned by* diff size, and f/100 is dominated by diff size.

The second agent adds a **lens**, not volume — visible in composition rather than count.
`8f9051b7` rows 16–21 are all Agent-2A ledger and parity findings that Agent 1 structurally
cannot see. Findings per agent falls monotonically: 9.5 (1 agent) → 5.0 (2) → 4.0 (3+).

---

## 6. Battery-catchability: 1 in 210

**Rubric, stated because the answer hinges on it.** Each of 416 rows was classified *behavioral*
(the running system does the wrong thing) or *non-behavioral* (comment wrong, doc stale, missing
coverage, dead code, undisclosed deviation). **210 of 416 (50%) are behavioral.** A behavioral
defect counts as gate-catchable if `build:dev:full`, `bun test app/` or the focused engine
suites, `bun run --cwd app typecheck`, or `test:hardening` would have gone red *without someone
first writing a new test*. Per CLAUDE.md §3, no credit was given to root `bun run typecheck`
(known-red, 1,974 pre-existing errors, explicitly not a gate), the sidecar wrapper's ~5.5k
upstream diagnostics, or `bun run lint` (all 19 rules are `createNoopRule()` stubs).

**Result: 1 of 210 behavioral defects — 0.5%.** On the widest defensible reading, 3 of 210
(1.4%).

- **The one clean catch** — `463ff374`: *"switch-account.test.ts:451 — test still asserted
  Terra; I committed it red."* The gate existed, was skipped, and the review substituted for it.
- **Two only under gates the repo has deliberately switched off** — a genuinely new `TS2305`
  (`UUID` imported from `types/ids.ts`, which exports no such member; `import type` erases at
  runtime so no test fails, and root typecheck is known-red), and a module mock that contaminates
  combined suites, which a combined `bun test src/tools/` would expose except CLAUDE.md forbids
  running suites combined.

**~33 rows (8% of the corpus) are findings about the gates themselves being blind:** inert
tripwires (`case undefined:` killing narrowing under `strictNullChecks:false`), 8 ×
`as unknown as SDKMessage` making fixtures unchecked, *"3 of 4 new tests do not fail on
revert"*, *"my own new tripwire passed vacuously"*, and one case where deleting a single token
(`assertAllowed(payload, 'diagnostics')`) kept 1,958 tests green while restoring the exact
starvation the decision exists to prevent.

### Four defects no gate could plausibly have caught

1. **Closing a parked tab that holds a queued prompt re-spawns a real, billed engine process
   and sends the message into it.** Costs money every time. The renderer suite is SSR-only and
   cannot execute the effect.
2. **A requeued prompt is destroyed on restore** — `drainOneQueuedPrompt` re-enqueues the same
   command after a failed turn, so the log reads `enqueue A · dequeue A · enqueue A` and the real
   function returns `[]`. A test covered the area and stayed green; the defect is in the
   interaction of two correct-looking primitives.
3. **`loadConversationForResume` is not a reader** — it runs SessionStart hooks, appends their
   output, trips `suppressNextSkillListing`, and copies plan and file history to disk. It was
   called from a **display** path. No gate can express "this function that typechecks fine has
   side effects the caller does not want."
4. **A line-capped read now satisfies the read-before-write gate**, so the model can overwrite a
   file it only ever saw two thirds of. A data-integrity regression created by a correctly-typed,
   fully-tested change to a limit constant.

---

## 7. Area split: findings track where the code was

| area | findings | share | reviewed diff | share | findings/100 |
|---|---:|---:|---:|---:|---:|
| `app/` | 307 | 73.8% | 18,897 | 71.1% | **1.62** |
| `src/` | 103 | 24.8% | 6,540 | 24.6% | **1.57** |
| `docs/` | 6 | 1.4% | 1,137 | 4.3% | 0.53 |
| `web/` | 0 | 0% | 0 | 0% | — |

**Once normalized the concentration disappears.** `app/` looks dominant only because it was 71%
of the reviewed code; engine and desktop yield the same rate to within 3%. `web/` never appeared
in any reviewed diff.

Note the asymmetry: findings *about* docs vastly outnumber findings *in* docs. A large share of
the `app/`- and `src/`-attributed rows are stale comments, wrong `file:line` citations, and
ledger drift living inside code files.

---

## 8. How much rests on inference

**The denominators are the strongest part.** 25 of 34 are corroborated twice — stated in
transcript *and* reproduced from git. Where the two disagreed, git won and the disagreement is
recorded: `66f06b65` (agent said ~800, git 427 — it counted `+++`/`---` patch headers),
`77fbf5d0` (agent ~2,000, git 2,446), `8f9051b7` (agent 1,268, git 1,252).

**Four are git-only**, reconstructed from the exact file or SHA list in the command that built
the reviewers' packet; the risk there is wrong scope, not wrong arithmetic. A follow-up scan
over the wider pattern set (prose `~N lines`, `+N/-M`, `N added, M removed`, and full Agent
prompt bodies) confirmed the scope choice on the two that carried the most risk:

- **`36e61c86`** — the whole dirty tree at that moment was 55 files / 3,111 lines, and the agent
  reviewed only its three commits (287 + 437 + 793 = **1,517**). The scope matches what was
  actually handed to the reviewers.
- **`6d0ce8ac`** — full commit `b74b583` is 8 files / 556 lines; the **518** used here is the
  6-code-file subset passed to the reviewers. The 38-line gap is docs. Both bounds now on record.

**Three are genuinely soft.**

`2d5da6ab` is the one to treat with care, and an earlier draft of this appendix overstated the
problem by comparing incompatible units. The bracket:

| Basis | Lines | Rate |
|---|---:|---:|
| Agent's own count of its *added* lines | 120 | 7.50/100 |
| `git diff --stat` added+removed on `ComposerActionsBar.tsx`, contaminated by a concurrent session's edits to the same file | 191 | 4.71/100 |
| 3-file scope, converting 521 *patch* lines at a typical 40–60% signal ratio | ~210–310 | 3.0–4.3/100 |

The earlier claim that this was "understated 2–4×" reasoned from the 521 patch-line figure,
which counts context and headers and is not comparable to added+removed. **True rate: 3.0 to 7.5
per 100.** The other high outliers are unaffected — `aee64f62` and `379fa640` have
exactly-verified denominators, and `1ba97aa9` is verified with no restatement.

`3dd55442`'s 225 is an agent-scoped estimate after excluding a third session's hunks (raw
numstat 336). `05d68ce0`'s second round is inferred from a 1,940-line patch containing six whole
new modules, so ~1,300 could be off by ±300.

None of this touches §4 (flat trend), §5 (agent count), §6 (gate-catchability), or §7 (area
split): `2d5da6ab` contributes 9 rows to a 416-row corpus and sits near none of those
conclusions' hinges.

**The finding counts are weaker than the denominators.** `rows.txt` double-counts restated
findings (~10%) and silently drops every table whose `#` column is non-numeric — which is how a
12-finding review appears as 1 and three whole reviews appear as 0. Four such sessions were
recovered; an estimated further ~28 non-numeric rows scattered across sessions already in the
table were not (7 of them are `8f9051b7`'s round-2 `F1`–`F7`, which would raise that row from 28
to ~36). **The finding column is a floor.**

**The battery-catchability count is the most judgment-laden number here.** A different reader
drawing the behavioral line differently on perf and user-visible-text findings could move the
210/206 split by ±25 either way. The conclusion is robust to that: at 250 behavioral defects the
catch rate is 0.4%, at 150 it is 0.7%. Exactly one finding's text says a running gate would have
gone red, and the lane went looking specifically for more.
