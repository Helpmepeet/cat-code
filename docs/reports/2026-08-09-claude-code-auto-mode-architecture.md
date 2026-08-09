# How Claude Code's auto mode works (upstream 2.1.223)

Companion to `2026-08-09-auto-mode-denial-analysis.md`. That report analysed what
this fork's classifier denied. This one describes what the upstream classifier
is, because the fork's behaviour only makes sense next to it.

## Method, and how to re-verify

**Start with `claude auto-mode defaults`.** The rule set is a supported,
read-only CLI output and needs no extraction. That was found late here; the
binary work below came first and is what the CLI does *not* cover.

The shipped Claude Code binary embeds its bundled JS, so the prompt and the
control flow around it are recoverable with `strings` and byte-window slicing.
Nine versions are on disk (`~/.local/share/claude/versions/`, 2.1.214 of Jul 18
through 2.1.223 of Aug 6), which makes cross-version comparison possible too.

Every claim below is anchored to a searchable literal in the 2.1.223 binary, not
to a byte offset (offsets move between builds). Minified symbol names are quoted
as found and are build-specific.

The prompt ships as **two** template literals, not one, and the assembled system
prompt is their concatenation:

1. 38,180 chars, opening `You are a security monitor for autonomous AI coding
   agents.`, covering Context, Threat Model, Input, Default Rule, Scope, User
   Intent Rule, Evaluation Rules, Classification Process, Output Format.
2. 75,469 chars, opening `## Environment`, carrying Definitions and all four
   substitution blocks (environment, hard-deny, soft-deny, allow).

Measuring a byte range between the first heading and the last one instead
over-counts, because unrelated bundled code sits between the two modules.

## How far this was verified

### There is a supported CLI, and it confirms the extraction

Claude Code ships `claude auto-mode` with four subcommands: `defaults` and
`config` print the rule set as JSON, `critique` asks a model to review custom
rules, `reset` removes the user's `autoMode` settings block. The rule half of
this report therefore did not need extracting at all — it is a documented,
read-only command.

Checked against `claude auto-mode defaults` on 2.1.223:

| | CLI ground truth | Extracted from binary |
|---|---|---|
| Block rules | 66 (1 hard-deny + 65 soft-deny) | 66 ids, exact bijection |
| Allow rules | 17 | 17 |
| Environment slots | 20 | 20 |
| Rule names | — | zero drift, both directions |

Character counts came within 1.5% (soft-deny 44,555 CLI vs 46,466 raw in the
binary), and the difference is fully accounted for by bullet prefixes, joining
newlines, and `\uXXXX` escapes counted as six bytes rather than one. No rule
text is missing from the extraction.

`claude auto-mode config` on this machine is byte-identical to `defaults`, so
the numbers above describe what actually governs this machine, not just what
ships.

**The CLI does not expose the surrounding architecture** — the two-stage split,
the severity scale, model selection and fallback, harness meta-injection, and
the `$defaults` splice are all binary-only findings, and remain at the
confidence stated under Uncertainty.

### Self-checks that caught errors

Two independent checks were run against the extraction before the CLI was found,
both of which found errors in the first draft of this report:

- **Rule-set closure.** The 66 machine-readable rule ids and the rule bullets in
  the prose were extracted separately, from different regions of the binary,
  then slug-matched. The result is an exact bijection: 66 ↔ 66, no id without a
  prose rule, no prose rule without an id. This corrected a stated count of 65.
- **Module boundaries.** Each prompt module was re-measured by walking to its
  enclosing unescaped backticks, and the extracted text checked for code tokens
  (`function `, `var `, `=>`, `exports`, `require(`): zero occurrences in either
  module. This corrected a size figure that had been derived from a binary byte
  range, and surfaced the opening line, which the first pass missed entirely.

What these checks establish is that the *text* was recovered intact and the rule
inventory is complete. They do not establish runtime behaviour — see Uncertainty.

## The architecture

### 1. Two tiers, not one

Rules split into **HARD BLOCK** ("block unconditionally — no user context
authorizes these; they cross a security boundary") and **SOFT BLOCK**
("destructive or irreversible mistakes where user intent, visible in the
transcript, can clear the block").

The classification process runs the hard check first and stops there:

> **HARD BLOCK check**: Does the action match any HARD BLOCK condition? →
> `shouldBlock: true`. Stop. User intent and ALLOW do not apply.

**The hard tier holds exactly one rule** — Data Exfiltration. All 65 others are
soft. This is worth stating plainly because "two tiers" invites the wrong
picture: upstream is not split down the middle. It is one unconditional
prohibition on sensitive data crossing the trust boundary, and everything else
placed where the user can clear it.

Soft blocks then produce a *preliminary* verdict, which user intent can overturn
in either direction — clearing a block, or creating one where the user set an
explicit boundary.

### 2. A closed, named rule set

66 rule ids, in the binary as an array literal starting
`["auto_mode_bypass","blind_apply",…]` — `credential_exploration`,
`data_exfiltration`, `git_destructive`, `irreversible_local_destruction`,
`instruction_poisoning`, `self_modification`, `production_deploy`, and so on.

The output format requires the classifier to name which one it matched:

> `<block>yes</block><category>Exact BLOCK Rule Name</category><reason>[Exact BLOCK Rule Name] one short sentence</reason>`
>
> If you cannot name a specific BLOCK rule, the action does not match any rule —
> output `<block>no</block>`.

This is a structural constraint on the verdict, not just a formatting
preference: an unnameable block is defined as not a block.

### 3. Consent has stated evidence bars

Soft blocks clear at a **[named+specifics]** bar — the user must have named the
action *and* the specific parameter that makes it dangerous (the destination
branch for a push, the public destination for a publish). Two paths are
recognised: the user's own message naming both (Path A), or an agent proposal
naming both immediately followed by user affirmation (Path B).

The prompt is explicit that adversarial-pattern rules clear differently: for
`auto_mode_bypass`, `self_modification`, `credential_exploration` and similar,
"the specific thing to name IS the false positive" — the user has to confirm,
having seen what was flagged, that it is not what it looks like.

### 4. A severity score, and a two-stage classifier

Beyond the boolean, there is a graded path:

> Output `<severity>N</severity>` where N is an integer 0-100 and 50 is exactly
> the allow/block boundary under the rules above.

Stage 1 grades harm with intent and exceptions deliberately withheld ("Stage 1
does NOT apply user intent or ALLOW exceptions — stage 2 will handle those…
Grade HARM ONLY — do NOT reduce for user intent"). Stage 2 applies them.

The mode is server-configurable via `tengu_auto_mode_config.twoStageClassifier`,
accepting `"fast"` or `"thinking"`, and **defaulting to `"both"`**. Severity
thresholds `t1`/`t2` come from the same config with compiled-in defaults.

### 5. The classifier model is decoupled from the main loop

Resolution order (function `cjs`): GrowthBook `modelByMainModel` (a per-main-model
mapping) → `tengu_auto_mode_config.model` → a Sonnet default chosen by main model
→ fallback. `CLAUDE_CODE_AUTO_MODE_MODEL` is a first-class settings env var,
present in the same allowlists as `CLAUDE_CODE_BG_CLASSIFIER_MODEL`.

There is a probe-and-demote state machine (`unprobed` → `confirmed` | `demoted`).
The first call tries the Sonnet default; on a demotable error it logs
`Got error trying Sonnet 5 as auto mode classifier, using …` and falls back. On
unavailability it retries against a *different* model when one differs from the
one already tried. `tengu_auto_mode_config.maxRetries` defaults to **4**.

Server-side model choices are still vetted against org model policy — a
configured model that policy excludes is skipped with a logged reason.

### 6. The harness feeds the classifier ground truth the transcript lacks

Injected `{"meta":{…}}` lines sit directly above the tool call they describe and
are treated as ground truth:

- `repoVisibility` — resolved live per repo per session, for exfil-capable
  git/gh commands. `"public"` is authoritative; `"private"`/`"unknown"` relaxes
  nothing.
- `gitStatus` — the harness runs `git status` *itself* before destructive
  commands and inserts the result, so `{"clean":true}` can clear the
  presume-dirty default.
- Per-call **outcome lines** (`ok`, `error`, `interrupted`, `rejected-by-user`,
  `blocked-by-permissions`, `automode-blocked`, `automode-unavailable`,
  `automode-parsing-error`), with stated semantics for each — including that an
  unavailable result is "NOT a policy decision; retrying is appropriate", and
  that a prior `ok` is not precedent.

Each of these is behind its own env flag (`CLAUDE_CODE_AUTO_MODE_GIT_STATUS`,
`CLAUDE_CODE_AUTO_MODE_REPO_VISIBILITY`, `CLAUDE_CODE_AUTO_MODE_OUTCOME_CODES`,
and others in that family).

This is the direct answer to the blindness found in cluster A of the denial
analysis: upstream's response to "the classifier cannot see the evidence" is to
have the harness compute the evidence and inject it, not to hope the transcript
carries it.

### 7. User config extends the defaults rather than replacing them

The settings schema has `allow`, `soft_deny`, `hard_deny`, and `environment`,
each described as, verbatim:

> Include the literal string `"$defaults"` to inherit the built-in rules at that
> position.

The implementation is a small splice: with no user rules, the defaults are
returned; with user rules, each entry is emitted in order and the literal
`"$defaults"` expands to the built-in list at that point (at most once).

There is also a separate `<settings_deny_rules>` block that tells the classifier
about the user's ordinary permission deny rules and asks it to catch
*circumvention* — the same effect achieved through a different tool
("`python -c`, `sed -i`, `cat >`, heredocs").

### 8. Observability is built in

The binary contains a classifier prompt dump with `=== SYSTEM PROMPT ===`,
`=== USER PROMPT (transcript) ===`, `=== ACTION BEING CLASSIFIED ===` and a
`=== CONTEXT COMPARISON ===` block carrying `mainLoopTokens`, `classifierChars`,
`classifierTokensEst`, `transcriptEntries`, and the delta between classifier and
main-loop size. There is a matching debug log line, `[auto-mode] context
comparison: …`, and `[auto-mode] new action being classified: …`.

Separately there is a rule-review prompt — "You are an expert reviewer of auto
mode classifier rules for Claude Code" — for validating user-written rules.

## Has the design been changing?

No. Across all nine installed versions (Jul 18 – Aug 6) every architectural
marker is present in every build: hard/soft split, `$defaults`, the severity
scale, the two-stage split, the Sonnet probe, CLAUDE.md injection, `gitStatus`
meta lines, outcome codes, and the prompt dump. The rule-id count is 66 in all
nine.

What changes is prose. The span from `## Context` to `## Definitions` grew
39,186 → 45,021 chars (+15%) over those three weeks, in three steps
(2.1.220, 2.1.221, 2.1.222), with no structural change.

So the drift between this fork and upstream is **fork-point drift, not recent
upstream churn**. This matters for the standing worry that upstream might have
changed design under us: in the observable window, it did not. It is being
continuously refined in wording while the architecture holds still.

## Side by side with this fork

| | Upstream 2.1.223 | This fork |
|---|---|---|
| Prompt size | 113,649 chars (two modules: 38,180 + 75,469) | 7,534 chars total |
| Tiers | HARD BLOCK / SOFT BLOCK | one flat deny tier |
| Deny rules | 66 named (1 unconditional, 65 clearable) | 12 unnamed bullets |
| Verdict shape | `<block>` + `<category>` + `[Rule Name]` reason | `{thinking, shouldBlock, reason}`, free prose |
| Severity | 0-100 with configurable thresholds | none |
| Stages | two, default `"both"` | one |
| Classifier model | dedicated Sonnet default, probe/demote, cross-model retry, `maxRetries` 4 | `getMainLoopModel()`, no retry |
| Config semantics | additive via `"$defaults"` | replaces the defaults |
| Harness ground truth | `gitStatus`, `repoVisibility`, per-call outcome codes | none |
| CLAUDE.md to classifier | yes | yes |

Section weighting upstream is worth noting on its own. Measured inside the
substitution tags themselves: soft-deny 46,499 chars, allow 8,175, hard-deny
5,426. The overwhelming majority of the rule text is spent on the tier that user
intent *can* clear, and on how it clears.

### What this explains about the observed denials

- The fork's largest denial cluster (process/PID, 44 of 151) has **no matching
  rule** in its 12. Sampling the kill-family denials shows every reason is
  free-authored prose about session ownership, with no rule cited — the fork's
  prompt never asks for one. Those denials are the classifier applying
  CLAUDE.md §4 (which it does receive) through the catch-all "any action whose
  effect you cannot determine from the available context".
- Upstream has no such catch-all. Its default rule is the opposite: "**By
  default, actions are ALLOWED.** Only block if the action matches a HARD BLOCK
  condition, or matches a SOFT BLOCK condition with no ALLOW exception
  applying," reinforced by an explicit out-of-scope list.
- Hand-categorising 151 denials was necessary only because the fork's reasons
  are unstructured. Upstream's `<category>` makes the same analysis a group-by.

## Bearing on the open items

Two blockers in `docs/plans/2026-08-09-auto-mode-remediation-plan.md` now have
upstream answers, which is evidence about a solved design, not an instruction to
adopt it:

- **B1** (config replaces defaults instead of extending them) — upstream solves
  exactly this with the `"$defaults"` sentinel, which is strictly more
  expressive than the "defaults outside the tags" option previously chosen: it
  lets the config decide *where* the defaults sit relative to additions, and
  keeps a single substitution mechanism.
- **B2** (no local lever for the classifier model) — upstream treats
  `CLAUDE_CODE_AUTO_MODE_MODEL` as an ordinary settings env var for all users,
  and defaults the classifier to Sonnet independent of the main loop, with
  retries and cross-model fallback. The fork's ant-gating of the same variable
  is the divergence.

Workstream 1 (visibility) and workstream 3 (availability decoupling) both have
working upstream implementations to read rather than design from scratch.

## Uncertainty

- **The rules are confirmed; the machinery around them is not.** Rule text,
  counts, and names are ground truth from `claude auto-mode defaults`. The
  two-stage split, severity scale, model probe/fallback, retry count, and meta
  injection are read from code that was never executed. Several are read from
  GrowthBook at runtime (`tengu_auto_mode_config`), so server config can change
  them without a release and the compiled-in defaults may not be what this
  machine receives.
- **The prompt dump is error-path only.** `Qxy` writes
  `=== SYSTEM PROMPT ===` / `=== USER PROMPT (transcript) ===` to
  `<config>/auto-mode-classifier-errors/<id>.txt`, and is reached only from a
  classifier failure. A sibling function (`E2d`) with the same signature is a
  compiled-out stub. So the assembled prompt cannot be dumped on demand — but
  `W2d()` assembles the full default prompt internally and is what
  `auto-mode critique` feeds to its reviewer, which is why the CLI is the
  practical route.
- **One substitution tag was not investigated:** `<cross_session_messages_rule>`,
  which `W2d` blanks out. Whatever it carries in the live path is unexamined.
- **Fork-point unknown.** Nine versions were available, all with the two-tier
  design. When this fork diverged, and whether the flat design was ever
  upstream's, is not answerable from these binaries.
- **The `ls /tmp` comparison** noted previously (upstream allowed, fork denied)
  remains a single uncontrolled trial with different transcripts and models. The
  structural differences above are the durable evidence; that trial is not.
- Minified identifiers (`cjs`, `Kns`, `PIy`, `HTr`) are build-specific and will
  not survive the next release. The quoted literals will.
