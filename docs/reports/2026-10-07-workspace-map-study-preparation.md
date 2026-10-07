# Workspace map study: preparation notes

Date: 2026-10-07

Status: offline preparation complete for the
[evaluation plan](2026-10-06-workspace-map-evaluation-plan.md); model runs await
approval. These notes record how the pairs were built and where the plan changed.
Raw prompts, transcripts, task inputs, working copies, and verification output
live outside the repository in `~/workspace-map-study/`.

## Selection

The frozen 935-task inventory had three extraction defects, so it was repaired
(`taskInventory.ts`) and re-labeled before selection:

- Codex client context blocks (`<recommended_plugins>`, app and browser
  context) were read as the request, and the 150-character dedup then merged
  every such session into one entry.
- A local slash command (`/compact`, `/login`, `/switch-account`) was read as
  the request instead of the prompt that followed it.
- Codex session ids were cut to eight characters, which collide.

The repaired inventory has 1,227 entries plus 2 carried forward from the frozen
one whose transcripts were deleted after 2026-10-06. Every entry was labeled by
hand; 686 are eligible. Allocation by the plan's rule: review 2 brief / 2 user,
fix 3 / 2, diagnosis 0 / 3, understanding 0 / 2, design 1 / 1. The diagnosis
split is marginal (0.495 against 0.505 of a place). One candidate was passed
over because it needs a week of commit history.

## Building a pair

Each pair is a history-free export of the task-time commit plus the files that
were dirty in the shared checkout at the prompt:

- The dirty set comes from a reliable full-tree `git status` printed by the
  task's own session, or the nearest one from any main-checkout session, rolled
  forward or back to the prompt with the edit index and intervening commits.
  Path-limited statuses, and Codex outputs that list nothing (often truncated),
  are not evidence.
- Each dirty file is rebuilt by the first method that verifies: a session's
  `git diff` applied to the base and checked against its blob hash; the next
  commit touching the file when no logged edit falls in between; or replay of
  logged edits checked against what sessions printed. Files that fail and are
  unrelated to the task are omitted and recorded.
- Codex attachment wrappers become the form the desktop composer sends: pasted
  text inline, images as image blocks. Paths to the live checkout become the
  run's working directory.
- Home inputs (session transcripts, relocation records, a skill) are cut to the
  prompt time. A pull request the task reads is served by an offline `gh`
  stand-in from a pre-request snapshot; the real `gh` cannot execute in runs.

## The no-map setup

The plan's scope (loaded guidance and supplied material) left map directions
reachable through linked docs, reports, and inputs. The no-map setup now has:

- no map files or map tooling, and CLAUDE.md without map clauses;
- every map direction removed from repository text by the smallest unit that
  carries it (path, sentence, list item, row), with a residual check that fails
  the build; product source code is left intact;
- the same treatment for prompts, transcript inputs, and the pull-request
  snapshot (its diff is regenerated between no-map trees);
- an engine clone without the conditional routing sentence that the engine adds
  to general-purpose, implementor, and plan worker prompts. That six-line
  removal is the only engine difference.

Both setups drop earlier map-study conclusions (four reports and one DONE
entry), so neither arm reads prior verdicts on the maps.

## Verification

Startup checks run through the production sidecar path with provider calls
replaced by a scripted local fake and outbound network denied. For every pair:
nudge in mandatory and none in no-map, no map text in any no-map request (main,
workers, auxiliary), the routing sentence only in mandatory worker prompts,
every enabled worker finishing in both, identical tools, no classifier errors,
and no forbidden access in any run transcript. `statusline-setup` cannot be
reached offline (it is pinned to an Anthropic model) and fails identically in
both setups. Planted contamination makes the checks fail.

The headless CLI is not a faithful substitute: it compiles a different feature
set, lacks the desktop prompt addendum and six desktop tools, and adds Explore
and Plan text the desktop path does not have.

## Tools

`scripts/workspace-map-eval/prep/` is a snapshot of the preparation pipeline;
the copy that built and verified the pairs is frozen in the working folder. In
order: `prepDirty.ts` (dirty set and rebuilt files, via `restoreFile.ts`),
`makePrompts.ts`, `prepareImages.ts`, `makeInputs.ts`, `makeSpecs.ts`,
`buildPair.ts` (copies, with `noMapTree.ts` and `scrubMaps.ts`), `verifyPair.ts`
(`harness/harness.ts`, `harness/compare.ts`, `detect.ts`), and
`runManifest.ts`. The harness's `--live` mode is the run launcher; it has not
been exercised, because that needs provider calls.

## Runs awaiting approval

32 runs (16 tasks, both setups back to back, arm order alternating by task),
plus up to four reserved reruns: GPT-6.1 Sol, high effort, auto permission
mode, fast mode off, production sidecar path. Caps per run: 60 minutes and 40M
input tokens (t8: 180 minutes, 150M). The original sessions suggest about 210M
input tokens per setup, most of it t8 and most of it cached.
