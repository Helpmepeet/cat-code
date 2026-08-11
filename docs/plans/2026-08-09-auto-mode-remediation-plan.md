# Auto-mode remediation plan

> **Superseded 2026-08-09.** The operator ruled to port upstream wholesale
> instead; see `2026-08-09-auto-mode-design.md`. This file is kept as the record
> of how B1 and B2 were found. **Both are now closed:** B1 by the `$defaults`
> splice (`88a8e747`), B2 by the `autoMode.model` setting and the provider
> ladder (`776d638b`). The blocker text below describes the state before those
> landed; do not act on it.

Implements the verdict reached against
`docs/reports/2026-08-09-auto-mode-denial-analysis.md`. That report is neutral by
construction; this plan is not — it assumes the operative goal established from
written policy (CLAUDE.md §8/§10 hard gates enforced without exception,
everything else flowing, unattended runs legible).

**Read the two blockers first. One of them inverts the verdict's cheapest
recommendation from "zero risk" into "can silently delete every hard gate".**

## Blockers found while planning

### B1 — On this machine, `settings.autoMode` REPLACES the default rules, it does not extend them

The verdict proposes writing a `settings.autoMode` paragraph as a zero-risk fix
for problems 2 and 2a. It is not zero-risk as stated.

`buildYoloSystemPrompt` substitutes user values into the prompt with a regex
whose match **includes the delimiter tags and the defaults inside them**
(`yoloClassifier.ts:531-545`). The source comment states the consequence
outright:

> The external template wraps its defaults inside the tags, so user-provided
> values REPLACE the defaults entirely. The anthropic template keeps its defaults
> outside the tags … so user-provided values are strictly ADDITIVE.

This machine resolves to the **external** template (`isUsingExternalPermissions`
returns true whenever `USER_TYPE !== 'ant'`, `yoloClassifier.ts:72-78`).

So setting `autoMode.allow` deletes all 8 default allow rules, and setting
`autoMode.soft_deny` deletes all 13 default deny rules — including secrets,
`git push`, `sudo`, remote exfiltration, and persistence. A one-paragraph config
written the obvious way removes the hard gates the whole exercise was meant to
preserve.

Two ways out, and this is the first decision to make:

- **Restate-in-full.** The config carries the complete default list plus the
  additions. Works today, no code change. Cost: the list is now forked from
  upstream and drifts silently on every template change, with no mechanism that
  notices.
- **Make the external template additive**, matching the anthropic one (defaults
  outside the tags, empty tag pair at the end of each section). One-line
  structural change to `permissions_external.txt` per section. Cost: a code
  change in a security-relevant file, needing tests that prove defaults survive
  when user values are present.

The second is the smaller long-run liability, but it changes shared security
machinery, so it is an operator call rather than an implementation detail.

### B2 — There is no local lever for the classifier model

The verdict's step 3 says the `tengu_auto_mode_config.model` hook already exists.
It does, but not reachable from this machine's settings:

- `getClassifierModel()` (`yoloClassifier.ts:1044`) reads `CLAUDE_CODE_AUTO_MODE_MODEL`
  only when `USER_TYPE === 'ant'`, then a GrowthBook feature value
  `tengu_auto_mode_config.model`, then falls back to `getMainLoopModel()`.
- The settings-backed `getAutoModeConfig()` (`settings.ts:1036-1045`) exposes
  only `allow`, `soft_deny`, `deny`, `environment`. **No `model` key.**

So decoupling the classifier from the work pool requires a code change: either
extend the settings schema with a classifier-model key and read it in
`getClassifierModel`, or honour the env var outside `USER_TYPE === 'ant'`. Not
config.

### Confirmed non-blocker

`feature('TRANSCRIPT_CLASSIFIER')` gates `getAutoModeConfig`, and it is in
`defaultFeatures` (`scripts/build.ts:82`), so the settings path is compiled in
and live. Config work is not dead on arrival.

## Workstream 1 — Give denials a destination

Rationale: the classifier's stated safety model ("a blocked action is not
rejected forever — it is paused so the user can confirm") is unimplemented on the
path where auto mode runs. Until denials are observable, every later tuning
decision is guesswork, including whether this plan worked.

Cheaper than the verdict assumes, because **the recording half already exists**.
Every denial is already persisted in subagent JSONL with its full command,
reason, and `tool_use_id` — that is the source of the 208-row dataset. What is
missing is surfacing and escalation, not capture.

- **Retrospective surface** — a read-only view over existing transcripts
  answering "what did auto mode deny, in which run, and why". Buildable today
  against retained data with no instrumentation change, and it retroactively
  covers the whole analysed window. This is the piece that converts the next
  version of the analysis from judgement into measurement.
- **Escalation on the unavailable path** — `permissions.ts:875-885` returns
  before `recordDenial` at `:897`, so infrastructure denials never count toward
  `DENIAL_LIMITS`. Note from the report §4 what this fix does and does not buy:
  in the observed outage it would have stopped 12 of 55 denials, and the 9
  subagents that reached the cap would have raised `AbortError`
  (`permissions.ts:1041-1044`), not reached a human. Worth doing; not a circuit
  breaker.
- **Open design question, not decided here:** whether unattended runs need a
  session-wide breaker across parallel subagents, given denial state is
  per-subagent (`permissions.ts:976-994`). The report deliberately does not
  argue for one; several shapes exist (breaker, don't-fail-closed-on-outage,
  cache last verdict) and picking is a design decision.

## Workstream 2 — Describe this machine to the classifier

Blocked on B1's fork. Content, once the mechanism is settled:

- The harness scratchpad, and self-created temp files, as normal working state.
  Grounded in the report's provenance result: 40 of 45 temp-path denials named a
  path the same transcript created earlier, none with unestablished ownership.
- The CLAUDE.md §3 battery commands, which are already allow-listed in spirit
  but lose to the outside-workdir deny when their output lands outside the repo.
- The skill architecture — `~/.agents/skills/` canonical home and its mirrors as
  ordinary skill-maintenance territory. This is the 47-of-208 cluster (23% of
  denials reference skill machinery by path), and it is what makes skill runs
  strand mid-procedure.

**Security constraint, carried forward from the verdict and not to be
relitigated during implementation:** do not solve the skill problem by letting
SKILL.md contents authorize themselves. The classifier currently sees only the
skill *name* (`SkillTool.ts` `toAutoClassifierInput: ({ skill }) => skill ?? ''`)
and skill instructions arriving as `tool_result` are dropped from its transcript
entirely. Making those contents authoritative would turn skill-file poisoning
into privilege escalation. Operator-signed config is the channel; the skill file
is not.

Keep gated regardless: settings files, credential paths, anything under the
CLAUDE.md §8/§10 enumerated gates. The one denial that caught a genuine
self-permissioning attempt is the argument for that line.

## Workstream 3 — Decouple classifier availability from the work pool

Blocked on B2 (needs a code change, not config). The coupling is verified: the
classifier resolves to the main-loop model, so on a Codex-backed session a pool
cap turns permission checking fail-closed fleet-wide — 61 denials in the window,
55 of them in one two-minute window, 17 attributed to "No healthy Codex account".

One claim in the verdict is **unverified and should not drive design**: that the
classifier's own consumption materially contributes to the cap. 5.6M uncached
tokens across two weeks was never measured against pool consumption, and the
debug telemetry points the other way (`deltaVsMainLoop` around -160k per call —
the classifier prompt is far smaller than the main loop beside it). The coupling
argument stands on its own without this.

## Sequencing, and why

Workstream 1's retrospective surface comes first — not because it is the largest
problem but because it is the only one whose absence blocks evaluating the
others. Workstreams 2 and 3 both need an operator decision (B1's fork, B2's
mechanism) before any code is written, and both are independently landable
afterwards.

## Verification expectations

Per CLAUDE.md §3, per touched area. Specific to this work:

- Any change to `permissions_external.txt` or `buildYoloSystemPrompt` needs a
  test proving the default deny list survives when user values are present —
  that is the exact failure B1 describes, and it is silent without a test.
- Any change to `permissions.ts` denial flow needs a test that fails before and
  passes after, covering both the decision path and the unavailable path.
- Engine area: `bun run build:dev:full` plus focused suites
  (`src/utils/permissions/`). Root `bun run typecheck` is known-red and is not a
  gate.

## Open decisions for the operator

1. B1: restate-the-defaults in config, or make the external template additive?
2. B2: settings key for the classifier model, or honour the env var outside
   `USER_TYPE === 'ant'`?
3. Whether unattended runs need a session-wide outage breaker at all, or whether
   loud visibility (workstream 1) is the wanted answer.
