# SendMessage structured-message failures: schema advertises what the validator always rejects

Date: 2026-08-10
Area: engine (`src/tools/SendMessageTool/`)
Status: fixed — options 1 and 2 shipped in `ebc751a8`; the cycle they exposed in `7cfb04df`
Reproduce: `bun docs/reports/2026-08-10-sendmessage-scan.ts`

## Summary

The reported symptom was "resuming an agent fails every time in cat-code". `ResumeAgent`
is not the failing surface: 102 of 103 recorded calls succeeded, and the single failure
was a genuinely absent transcript (characterized below). The surface that fails **100% of
the time** is `SendMessage` when the `message` argument is a structured protocol object
rather than a string. Every such call in the transcript corpus failed, in every session
that attempted one, over a month of history.

Two independent defects produce it:

- **A.** `inputSchema` exposes the structured-message union unconditionally, while the
  validator rejects every structured message unless Agent Teams is enabled. The schema
  offers a capability that cannot succeed in this build, and it is the *only* place in
  this build that offers it.
- **B.** The `@`-recipient check runs before the structured-message check and reports a
  recipient-format error for what is actually a message-shape problem. The model follows
  that error, retries with a corrected recipient, and only then learns the real reason.

## Evidence

Method: parse all session transcripts under `~/.cat-code/projects/`, pair each `tool_use`
block with its `tool_result` by `tool_use_id`, bucket `SendMessage` outcomes by message
shape and recipient form. The script is committed alongside this report at
`docs/reports/2026-08-10-sendmessage-scan.ts`; the figures below are its output on
2026-08-10 against 1,883 transcripts. The corpus grows, so re-running will not reproduce
the absolute totals. The split is the claim, not the totals.

| `message` shape | `to` form | ok | err |
|---|---|---|---|
| plain text | `@Name` | 34 | 0 |
| plain text | bare name | 20 | 0 |
| structured | `@Name` | 0 | 13 |
| structured | bare name | 0 | 10 |

Plain text never failed. Structured never succeeded. All 23 failures were
`type: "shutdown_request"`, spread across 9 distinct sessions and 2 projects
(`-Users-pt-cat-code`, `-Users-pt-Desktop-pt2nd`), from 2026-07-11 to 2026-08-09.

The paired-call signature is visible in most affected sessions. From
`7c2fe259-0a0e-4cfd-a456-96895128f13e`:

```
17:38:40.817  to="@Ritchie"  shutdown_request  -> to must be a bare teammate name or "*" — there is only one team per session
17:38:40.831  to="@Kay"      shutdown_request  -> to must be a bare teammate name or "*" — there is only one team per session
17:38:45.208  to="Ritchie"   shutdown_request  -> structured messages require Agent Teams
17:38:45.311  to="Kay"       shutdown_request  -> structured messages require Agent Teams
```

Four failed calls to stop two agents, roughly four seconds apart. The same shape appears
in `e818b062` (2026-07-11), `f2982cc2` (2026-07-12), `132aa9f7` (2026-07-15),
`d29e9c90` (2026-08-09), and others. The retry is common but not universal: 13 `@`-form
failures against 10 bare-form failures means three `@` failures had no bare retry
recorded, so "two calls per attempt" is the usual cost, not an invariant.

### The one ResumeAgent failure

2026-07-06T12:59:57, session `b23bc4b4`, agent `@Franklin`:
`Agent "@Franklin" has no transcript to resume; it may have been cleaned up.` The same
agent had been resumed successfully in the same session 84 minutes earlier (11:35:48,
`~176k / 272k tokens`). The run was operating in `.worktrees/account-system-20260706`.
The transcript was genuinely gone by the second call, so the tool reported correctly.
I did not determine what removed it, and that question is out of scope here.

## Defect A: unconditional structured-message variant in the input schema

`src/tools/SendMessageTool/SendMessageTool.ts:104-107`

```ts
message: z.union([
  z.string().describe('Plain text message content'),
  StructuredMessage(),
]),
```

`StructuredMessage()` (`SendMessageTool.ts:68`) is a discriminated union containing
`shutdown_request`, `shutdown_response`, and `plan_approval_response`. Nothing gates it.

The validator rejects all three whenever Agent Teams is off
(`SendMessageTool.ts:1116-1122`):

```ts
if (!isAgentSwarmsEnabled()) {
  ...
  if (typeof input.message !== 'string') {
    return { result: false, message: 'structured messages require Agent Teams', errorCode: 9 }
  }
```

`isAgentSwarmsEnabled()` (`src/utils/agentSwarmsEnabled.ts`) returns true unconditionally
when `process.env.USER_TYPE === 'ant'`. Otherwise it requires opt-in via
`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` or `--agent-teams`, and is additionally
killswitched on the `tengu_amber_flint` GrowthBook gate. It is false in this install,
which is why the error fires at all.

### The schema is the only affordance in this build

This matters, because the obvious rival explanation is that the tool prompt taught the
model the `shutdown_request` shape. It did not:

- `getPrompt()` returns early at `prompt.ts:9` when swarms is off.
- The `## Protocol responses` section that documents `shutdown_request` lives at
  `prompt.ts:68` onward, inside the teams branch only.
- The non-teams branch explicitly lists structured protocol messages under
  "Requires Agent Teams" (`prompt.ts:26-31`).
- `isEnabled()` returns `true` unconditionally (`SendMessageTool.ts:992`), so the tool
  and its schema are always present regardless of the gate.

So in a non-teams build the prompt says the capability is absent, and the JSON schema
says it is present. A model resolving that conflict follows the schema, because the
schema is the contract it is constrained to emit against. Nothing else in the build
mentions the shape.

### Not evidence: the duplicate flattened keys

An earlier draft of this report cited the extra top-level keys seen in the recorded
inputs, for example `"type"`, `"recipient"`, and `"content"` sitting alongside
`"message"`, as a sign the model was guessing at the shape. That reading is wrong and is
recorded here so it is not rediscovered.

Those keys are written by the tool's own observability hook,
`backfillObservableInput` (`SendMessageTool.ts:1000-1024`), which for a structured
message sets `input.type = msg.type`, `input.recipient = input.to`, and
`input.content = msg.reason ?? msg.feedback` — a 1:1 match with the observed keys. The
backfilled clone is what reaches the transcript: `query.ts:813-830` yields a cloned
block when backfill added fields, and `toolExecution.ts:799` handles the same clone. The
keys would appear identically on a *successful* structured send in an Agent Teams build.
They say nothing about model confusion.

## Defect B: misordered validation reports the wrong cause

`src/tools/SendMessageTool/SendMessageTool.ts:1080-1100`

```ts
if (input.to.includes('@')) {
  const isSingleLeadingAt =
    input.to.startsWith('@') && !input.to.slice(1).includes('@')
  let isLocalAgentTarget = false
  if (isSingleLeadingAt && typeof input.message === 'string') {
    isLocalAgentTarget = (await resolveAgentTarget({ ... })) !== null
  }
  if (!isLocalAgentTarget) {
    return {
      result: false,
      message: 'to must be a bare teammate name or "*" — there is only one team per session',
      errorCode: 9,
    }
  }
}
```

`isLocalAgentTarget` is only ever computed when the message is a string. With a
structured message, `resolveAgentTarget` is skipped entirely, the flag stays `false`, and
the function returns the **recipient-format** error. The blocker was the message shape,
which is checked 20 lines later.

Whether `@Ritchie` and the other recipients were in fact valid local subagents is
unverifiable from these transcripts, precisely because the code never checks: the
resolution is skipped on the structured path, and the bare-name retry does not enter this
block at all. That does not weaken the defect. The error names a cause the code did not
establish, and it is the wrong cause.

The error text is not merely unhelpful, it is instructional. It tells the caller to drop
the `@`, the caller complies, and the corrected call fails for the reason that was true
all along. This is what converts a one-call failure into the two-call sequence seen in
most affected transcripts.

## Why this reads as "resume is broken"

The trigger is a routine instruction: telling the session to stop delegated work. The
model reaches for `shutdown_request` because the schema offers it, burns two round-trips,
then falls back to another path. Nothing in the resume machinery is broken. The failure
simply lands on the "re-engage an already-running agent" surface, which is where an
operator would notice it and reasonably call it a resume problem.

## Out of scope but observed

In session `2cfa365c`, three consecutive resumes of the same subagent terminated with:

```
API Error: Stream interrupted after visible output started; the turn was not replayed to
avoid duplicate output or tool calls. Original error: websocket closed by server before
response.completed (code=1006 reason=Connection ended)
```

This is transport, not resume: it affects fresh spawns identically. The fourth attempt
completed normally. Recorded here only so it is not conflated with the defects above.

## Fix options

Options 1 and 2 shipped together in `ebc751a8`; see Resolution below for what changed
and what implementing them uncovered. Option 3 was not taken. The three are kept as
written so the reasoning that led to the choice stays legible.

### Option 1: gate the union (addresses defect A)

```ts
message: isAgentSwarmsEnabled()
  ? z.union([z.string().describe('Plain text message content'), StructuredMessage()])
  : z.string().describe('Plain text message content'),
```

Two caveats the fix must account for, neither of which appeared in the first draft:

- **This is not the same pattern as the existing `to` branch.** `to`'s description
  branches on `feature('UDS_INBOX')` (`SendMessageTool.ts:94-96`), a build-time bundle
  macro resolved by `scripts/build.ts`. `isAgentSwarmsEnabled()` is runtime state
  (`process.argv`, env vars, a GrowthBook read). This would be the first runtime
  dependency in this schema, not a continuation of an established convention.
- **`lazySchema` memoizes for the process lifetime** (`src/utils/lazySchema.ts`:
  `cached ??= factory()`). Deferral to first access is the *risk* here, not a
  reassurance: the gate result freezes at whatever the first caller saw. Harmless for
  the diagnosed non-teams case, since the env/flag test short-circuits before any
  GrowthBook read. But for an opted-in user the killswitch defaults to `true`, so a
  schema constructed before feature values load would freeze structured-on and never
  re-evaluate.

It also degrades the error. Once the union is gated, a model that still emits
`{"type":"shutdown_request"}` fails zod parsing and receives a generic input-validation
error. The legible `structured messages require Agent Teams` string becomes unreachable
on the normal path. Option 1 alone trades a wrong-but-specific error for a correct-but-
generic one.

### Option 2: reorder the validation (addresses defect B)

Move **only** the three-line structured-message check so it runs before the `@`-recipient
block, under its own `!isAgentSwarmsEnabled()` guard:

```ts
if (!isAgentSwarmsEnabled() && typeof input.message !== 'string') {
  return { result: false, message: 'structured messages require Agent Teams', errorCode: 9 }
}
```

Do **not** hoist the enclosing `if (!isAgentSwarmsEnabled())` block at
`SendMessageTool.ts:1101-1130`. That block ends in `return { result: true }`, so moving it
above line 1080 would make the entire `@`-recipient resolution unreachable on the
non-teams path, and `@nonexistent-agent` would start validating successfully. That is a
validation regression, not a refactor.

### Option 3: reorder and sharpen, keep the union

Cheapest of the three. Leave the schema alone, apply option 2's reordering, and rewrite
the surviving message to say what to do instead — that structured protocol messages need
Agent Teams and that stopping a local subagent goes through a different path. The model
still emits one doomed call, but it gets one legible refusal instead of two misleading
ones, and no runtime state enters the schema.

Options 1 and 2 compose; option 1 without option 2 is not recommended, for the
error-legibility reason above.

### Test impact

The first draft claimed `SendMessageTool.test.ts` "already asserts both error strings and
would need updating alongside." That is wrong in both halves.

- Only `structured messages require Agent Teams` is asserted
  (`SendMessageTool.test.ts:256`). `rg 'bare teammate|one team per session'` across all
  test files in `src/` returns no matches, so defect B's error string has no coverage at
  all.
- That test calls `SendMessageTool.validateInput?.()` directly with a pre-typed object
  literal, which bypasses zod entirely. Option 1 therefore does not touch it. Neither
  does option 2: its `to` is `'team-lead'`, which never enters the `@` block.

So no existing test needs updating. The real gap is the opposite: **defect B has no
regression test**, and any fix touching the ordering needs a new one asserting that a
structured message to an `@`-prefixed recipient reports the message-shape error rather
than the recipient-format error.

## Resolution

`ebc751a8` shipped options 1 and 2. The `lazySchema` freeze objection to option 1 was
resolved by gating on a narrower predicate than the one the option proposed: a new
`isAgentTeamsOptedIn()` in `src/utils/agentSwarmsEnabled.ts` reads only env, argv, and
`USER_TYPE`, all fixed at process start, so memoizing them is correct rather than
hazardous. The GrowthBook killswitch stays out of the schema path and is still enforced
by `isAgentSwarmsEnabled()` at validation time, which option 2's reordering now reports
legibly. `isAgentSwarmsEnabled()` semantics are unchanged for its 32 consumers.

### What implementing it uncovered

Building the two-process probe required a process with Agent Teams opted in from launch.
That crashed at import (verbatim pre-fix trace; `Tool.ts:799` is the spread as it stood
then, not a current line):

```
ReferenceError: Cannot access 'envOverridesParsed' before initialization
  at getEnvOverrides (src/services/analytics/growthbook.ts:171)
  at isAgentSwarmsEnabled (src/utils/agentSwarmsEnabled.ts:47)
  at AgentTool.tsx:468 -> lazySchema.ts:7 -> buildTool (Tool.ts:799)
```

`buildTool()` spread its definition by value, and a spread reads accessors, so every
`get inputSchema()` ran during `buildTool` — at import time, since tools call `buildTool`
at module scope. That defeated the `lazySchema` deferral in 112 tool modules, and on this
import cycle it re-entered `growthbook.ts` mid-initialization and hit the temporal dead
zone on its module-level `let`s. Value-import cycle:

```
growthbook -> utils/http -> utils/auth -> utils/model/providers -> utils/messages
  -> utils/api -> tools.ts -> AgentTool.tsx -> agentSwarmsEnabled -> growthbook
```

Two of growthbook's ten direct imports reach `AgentTool.tsx` (`utils/http.ts` and
`utils/user.ts`), both through `utils/auth.ts`, so cutting a single growthbook edge would
not have been sufficient. `7cfb04df` fixes `buildTool` to copy property descriptors
instead, preserving precedence and restoring the laziness the pattern already assumed —
including at `AgentTool.tsx:472`, whose comment reasons explicitly about
"GrowthBook-in-lazySchema" being safe, an invariant the builder had been silently
breaking.

Effect: an **external** opt-in from process start, by `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS`
or `--agent-teams`, died at import. `USER_TYPE=ant` was never affected: the old gate
returned true on its first line, before the GrowthBook read, so it never reached the
cycle. The crash was specific to the external path, which is the one this install uses
(`USER_TYPE` unset).

That explains why the corpus contains no Agent Teams session, and it means the affordance
this report is about was gated behind a feature that could not start here. Supporting
evidence, all consistent: zero transcripts carry teammate records, and the only Agent
Teams artifact on disk is `~/.cat-code/teams/default/inboxes/explore-prior.json` dated
2026-05-02, whose contents (`"continue prior work"`, `"follow up"`) are verbatim fixtures
from `SendMessageTool.test.ts:653` — a test writing into the real user home, not a real
session. Worth fixing separately; not investigated here.

### Verification

`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1 bun run src/entrypoints/cli.tsx --agent-teams --help`
prints usage instead of the `ReferenceError`. A real opted-in process, with no preloaded
growthbook stub, now advertises `shutdown_request` in the generated schema, and an
opted-out process does not — which retires the caveat that the shipped probe's opted-in
case only passed because it stubbed around the crash above. `bun test src/tools/` 363/0,
`bun test ./src/Tool.test.ts` 2/0, `bun run build:dev:full` green.

## Uncertainty

- Agent Teams is now startable but has still never run a real session. This report says
  nothing about whether structured messages behave correctly end to end once the gate is
  on; it establishes only that the schema and the validator now agree in both states.
- The 23 failures are all `shutdown_request`. `shutdown_response` and
  `plan_approval_response` are in the same union and would have failed identically by
  inspection, but neither appears in the transcripts, so that is reasoning from source,
  not observation.
- `bun test app/` was not a clean signal when this landed: 11 live-sidecar probes failed
  on a missing `ANTHROPIC_API_KEY`/`CLAUDE_CODE_OAUTH_TOKEN` in the shell, and
  `app/sidecar/` carried another session's uncommitted work. Neither was attributable to
  these changes, and neither was re-checked with credentials present.
