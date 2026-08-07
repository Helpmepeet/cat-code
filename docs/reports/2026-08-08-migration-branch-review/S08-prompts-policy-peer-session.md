# S08 — prompts, core policy, provider keying

> Produced by a separate Claude session working from the handoff prompt in this
> review set. Reproduced here verbatim so the finding set is complete. Its HIGH
> was independently re-verified in source by the review lead, and amplified —
> see the note at the end.

## Verdict

RED. The provider-aware routing and shared prompt-policy work are broadly sound,
and the focused suite passed, but the live `--bare` path bypasses the entire
policy core. The most important fix is to give bare mode a minimal
safety/authority/action assembly and test its real assembled prompt.

## Findings

### [HIGH] `--bare` bypasses every new policy invariant
- **Where**: `src/constants/prompts.ts:696`
- **What**: The `CLAUDE_CODE_SIMPLE` branch returns one 59-byte prompt containing
  only identity, CWD, and date. It omits cyber policy, tool-output provenance,
  prompt-injection handling, instruction authority, risky-action consent, and
  truthful outcome reporting. The policy module says these are invariants, but
  its tests explicitly delete `CLAUDE_CODE_SIMPLE` before every assembly at
  `src/constants/corePolicy.test.ts:46`.
- **Trigger**: `--bare` is a public CLI option at `src/main.tsx:1029`, and bare
  mode still exposes Bash, Read, and the provider's edit tool at
  `src/tools.ts:306`. Reading an untrusted repository file can therefore present
  imperative content without any tool-output-is-data or prompt-injection rule.
- **Fix**: Include a deliberately minimal provider system/actions/core assembly
  before returning, then assemble bare prompts for both Claude and GPT in
  `corePolicy.test.ts`.
- **Touches uncommitted lines**: No.

### [MED] The dirty Apply_patch path fix misses two modes where the tool can remain live
- **Where**: `src/constants/promptStyles/gpt.ts:227`, `:243`, `:293`
- **What**: The new working-directory rule exists only in
  `getGPTUsingToolsSection` after its REPL early return. The dedicated Agent Mode
  builder has no equivalent. REPL also hides `Edit` but not its OpenAI alias
  `Apply_patch`: `src/tools/REPLTool/constants.ts:37` omits
  `FILE_PATCH_TOOL_NAME`, while `src/tools.ts:354` filters solely through that
  set.
- **Triggers**: (a) GPT Agent Mode receives `Apply_patch` and its tool section
  omits the path-base rule. (b) An ant-native interactive GPT session enables
  REPL by default; `Apply_patch` survives direct-tool filtering, but the GPT tool
  builder returns before emitting the new rule. The dirty regression test at
  `src/utils/providerPromptRegressions.test.ts:393` calls only the normal
  builder, so both gaps remain green.
- **Fix**: Put the path-base statement in `getFilePatchToolDescription`, where
  every exposed instance receives it, and add `FILE_PATCH_TOOL_NAME` to
  `REPL_ONLY_TOOLS`. Test actual Agent Mode and REPL tool assemblies.
- **Touches uncommitted lines**: Yes (the new GPT rule and its regression test;
  the supporting REPL omission is not).

### [LOW] The output-style policy test does not exercise an output-style assembly
- **Where**: `src/constants/corePolicy.test.ts:210`
- **What**: The test named "an output style that drops coding instructions still
  gets reporting and retry" calls `getCorePolicySection` directly, then checks
  three unrelated source substrings. It never configures an output style or calls
  `getSystemPrompt` under that state.
- **Failure it would miss**: reverse the fallback condition at
  `src/constants/prompts.ts:887`, so the core is emitted when doing-tasks is
  present and omitted when an output style removes it. Every current assertion
  still passes because the checked strings remain in the file.
- **Fix**: Inject or mock an output style with `keepCodingInstructions: false`,
  build both provider prompts, and assert the final assembly contains
  `OUTCOME_REPORTING_RULE` and `RETRY_RULE`.
- **Touches uncommitted lines**: No.

### [LOW] The dirty verification test proves wording removal, not the behavior its name claims
- **Where**: `src/constants/corePolicy.test.ts:292`
- **What**: "Normal prompt styles do not require an automatic verification
  worker" only checks that two exact legacy strings are absent. An equivalent
  mandatory contract with different wording would pass. Gated runtime behavior
  still orders the model to spawn a verification worker after closing three tasks
  at `src/tools/TodoWriteTool/TodoWriteTool.ts:78` and
  `src/tools/TaskUpdateTool/TaskUpdateTool.ts:341`.
- **Trigger**: enable `VERIFICATION_AGENT` and `tengu_hive_evidence`, then close
  the last of three tracked tasks without a verification task. The suite remains
  green while the runtime still imposes automatic verification.
- **Fix**: Name the test narrowly as removal of the static legacy contract, and
  add a behavioral test for the intentional just-in-time tool-result nudge.
- **Touches uncommitted lines**: Yes.

## What is good here

- Provider style selection correctly follows the request model through
  `resolveRequestProvider(model)` in both normal and Agent Mode assemblies.
- `corePolicy.ts` is genuinely wired into default Claude/GPT, Agent Mode, and
  proactive assemblies; it is not a dead new module.
- Section-cache keys capture model, tools, skills, mode, directories, and
  output-style inputs, and volatile sections neither read nor seed cached
  entries.
- The dirty away-summary and teleport changes use the provider-aware small model
  at the actual request boundary. Their new tests capture the model/provider sent
  to `queryModelWithoutStreaming`.
- Focused scoped suite passed: 64 tests, 0 failures. The four provider-routing
  test files also passed in both requested file orders.

## Not reviewed / uncertain

- `bun run build:dev:full` was not run because it writes a generated repository
  artifact in this shared tree. No live API or GUI verification.
- Coordinator mode and normal main-thread custom agents replace the default
  prompt wholesale and therefore do not inherit `corePolicy.ts`. Coordinator mode
  is not in the repo's `dev-full` feature set, and whether user-authored
  replacement prompts should retain the policy core is an explicit product
  decision, so neither was scored as a defect.
- No source or git state was changed.

## Lead re-verification note — the HIGH is amplified in this repo

Every leg confirmed in source:

- `--bare` sets `CLAUDE_CODE_SIMPLE=1` (`src/main.tsx:1073`; the option's own
  help text states it).
- `prompts.ts:696` early-returns identity + CWD + Date, before any policy
  assembly.
- `corePolicy.test.ts:56` runs `delete process.env.CLAUDE_CODE_SIMPLE` inside the
  shared `withPromptEnv` helper, so **every** policy test in that file is
  structurally incapable of observing the bare path.

The reviewer framed the trigger as "reading an untrusted repository file". In
this repository the exposure is more concrete than that: **`CLAUDE.md` §12
instructs agents to use `cat-code -p --bare` as the standard GPT
second-opinion path**, piping a diff into the prompt. That is the project's own
documented workflow routing attacker-influenceable content through the one
assembly that omits prompt-injection handling and tool-output-is-data rules.

Two mitigating details, stated for accuracy: the documented reviewer command
uses `--tools ""`, so that specific invocation has no tool surface; and §12's
rationale for `--bare` (no recursion, no CLAUDE.md re-discovery, no hooks, no
auto-memory) is sound and worth preserving. But §12 also documents a
`--permission-mode plan --add-dir .` variant "if it must open other files",
which restores Read on the unprotected assembly. The fix the reviewer proposes —
a deliberately minimal safety/authority/action core that survives the early
return — preserves every reason `--bare` exists while closing this.

This finding also belongs to the review's broader test-integrity theme: like the
752 SSR-only renderer tests in `X01`, the guard here is not weak, it is
*unreachable by construction* — the test helper deletes the very condition that
would exercise it.
