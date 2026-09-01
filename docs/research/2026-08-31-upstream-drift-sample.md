# Upstream drift: what 164 versions of unshipped bug fixes left behind

**Method:** sampled 60 of upstream Claude Code's post-fork bug fixes and checked each
against this fork's source. **23 are live defects here.** One is a permission bypass.

Fork point **2.1.87**. Upstream head at time of writing **2.1.251**. 130 released versions
in between, carrying **3,040 changelog entries of which 1,828 are fixes** — none of which
reached this fork.

Assembled changelog: `tmp/upstream-drift-changelog.md` (from tag `v2.1.222` plus current
`main`; the published file retains only 2.1.223+, so the older half came from the tag).
Sample: `tmp/upstream-fix-sample.md`.

## Why this works

A bug fixed upstream after 2.1.87 was, in most cases, a bug present at 2.1.87 — and this
fork inherited it. The changelog is therefore a pre-triaged defect list, free, with the
version that fixed each one.

The counter-case is real and cost about a quarter of the sample: a fix may repair code
upstream *introduced* after 2.1.87, or code this fork replaced wholesale. Those show up
below as `ABSENT-CODE`.

## Measured hit rate

| Area | PRESENT | ABSENT-CODE | ALREADY-FIXED | N/A | UNRESOLVED |
|---|---|---|---|---|---|
| permissions / hooks | 6 | 3 | 0 | 5 | 1 |
| sessions / resume | 7 | 3 | 1 | 3 | 1 |
| tools | 5 | 5 | 3 | 1 | 1 |
| agents / tasks | 5 | 5 | 3 | 2 | 0 |
| **Total** | **23** | 16 | 7 | 11 | 3 |

**Raw 23/60 = 38%.** Discounting items that are real but unexercised, documented as
deliberate, or reachable only via hand-edited config gives a conservative **~25%**.
Sampling error to note: sessions items 3 and 12 were the same upstream fix listed twice.

**362 candidates** survive a tight filter (concrete fixes, inherited subsystems, excluding
Windows/enterprise/Bedrock). At 25-38%, that implies **90-140 further live defects**.

---

# P0 — permission bypass

## 1. A Bash command of only variable assignments is allowed with no prompt

Upstream fixed at **2.1.251**. `src/tools/BashTool/bashPermissions.ts:2368`.

Four links, each verified directly in this session:

1. **Parser.** A command that is only assignments yields an empty subcommand list.
   Driving the real parser module: `"x='a[$(echo HI)]' && OPTIND=x"` -> `simple`,
   `commands=[]`. So does `"OPTIND=1"`. (`git status` correctly yields one command.)
2. **Permission.** With `astSubcommands = []`, the command-injection re-check is skipped
   and `subcommandPermissionDecisions.every(_ => _.behavior === 'allow')` is **vacuously
   true** -> `behavior: 'allow'`. A second vacuous `.every` sits at `:2456`.
3. **Shell.** Bash performs arithmetic evaluation when assigning to integer-attributed
   variables (`OPTIND`, `RANDOM`, `SECONDS`), and arithmetic evaluation expands array
   subscripts, which runs command substitution. Confirmed:
   `/bin/bash -c "x='a[$(echo PWNED-VERIFIED >&2)]' && OPTIND=x"` prints `PWNED-VERIFIED`.
4. **Reachability.** `TREE_SITTER_BASH` is in `fullExperimentalFeatures`
   (`scripts/build.ts:46`), compiled in by `--feature-set=dev-full` (`:102-105`) — the
   `./cli-dev` binary in daily use. Default permission mode on this machine is `auto`.

**Net: one Bash tool call of that shape executes an arbitrary command with no prompt.**

Not a tradeoff: the fork already catches the direct form. `OPTIND=a[$(id)]` returns
`too-complex "Contains command_substitution"`, and `declare -i x=1+1` is caught with the
reason "declare flag -i changes assignment semantics". Indirecting the payload through a
plain string variable defeats both, because the textual `$(` never appears in the
assignment that evaluates.

---

# P1 — silent data loss and broken subsystems

## 2. Attachments are never written to disk

Upstream **2.1.97**. `src/utils/sessionStorage.ts:5816-5831`.

`isLoggableMessage` drops every attachment for non-`ant` users, and `scripts/build.ts:139`
hard-defines `USER_TYPE` as `'external'`, so the exception is dead code. Upstream now
ships the same function with an **empty** denylist — they persist all attachments.

Corpus proof: **0 attachment entries across all 2,051 transcripts** in `~/.cat-code/projects/`.

Consequences, all confirmed as separate sample items:
- Text typed while a turn is in flight becomes a `queued_command` attachment
  (`src/utils/attachments.ts:1056-1094`), is sent to the model, and is then filtered out on
  the way to disk. It exists nowhere afterwards.
- A resumed session's reconstructed prefix cannot match what was cached, because the live
  request carried attachment content the transcript does not.
- Remote Control messages sent mid-turn vanish from both transcripts — the outbound bridge
  forwarder (`src/hooks/useReplBridge.tsx:701-707`) also skips attachments.

**Coupling to watch:** `src/utils/conversationRecovery.ts:526-539` accesses
`message.attachment.type` unguarded. Today no fork-written transcript can contain a
malformed attachment, because none contains any. Fixing this finding makes that live.

## 3. `EnterWorktree` gives every hook a nonexistent transcript path, permanently

Upstream **2.1.141**. `src/tools/EnterWorktreeTool/EnterWorktreeTool.ts:93-96`.

The tool calls `setOriginalCwd(getCwd())` after chdir'ing into the worktree.
`getTranscriptPath()` (`src/utils/sessionStorage.ts:272-274`) then resolves under
`projects/<sanitized-worktree-path>/`, while the writer latched `sessionFile` once at
materialization and keeps writing to `projects/<sanitized-repo-path>/`. Every hook
invocation thereafter receives `transcript_path` pointing at a file that does not exist
(`src/utils/hooks.ts:322`).

Reachable: `isWorktreeModeEnabled()` hard-returns `true`. Same divergence hits
`getAgentTranscriptPath`, `listAgentMetadataForSession`, and `getRemoteAgentsDir`. The fork
already fixed the sibling resume/branch case (comment at `sessionStorage.ts:278-289`); the
worktree case slipped through because it mutates `originalCwd` rather than setting
`sessionProjectDir`.

## 4. One malformed hooks entry silently discards the entire settings file

Upstream **2.1.122**. `src/utils/settings/settings.ts:220-232`.

Only invalid *permission rules* are pre-filtered. Everything else goes to
`SettingsSchema().safeParse`, and on failure the function returns `settings: null` — the
whole file. A mistyped hook shape silently drops `model`, `env`, `permissions`,
`statusLine`, `enabledPlugins`, and the session runs on defaults with no indication.

Same site, same mechanism: an invalid enum value does the same (upstream **2.1.121**).
`{"permissions":{"defaultMode":"<bogus>"}}` nukes the file. The fork applies
`.catch(undefined)` to three of its own enums (`types.ts:716-738`) but not to inherited ones.

## 5. Agent-type hooks fail on every event except Stop

Upstream **2.1.118**. `src/utils/hooks.ts:2262-2266`.

Throws `Messages are required for agent hooks. This is a bug.` when `messages` is absent.
Of the 26 `executeHooks` call sites in that file, only `executeStopHooks` passes them. So a
valid `{"PreToolUse":[{"hooks":[{"type":"agent","prompt":"..."}]}]}` in settings.json is
accepted by the schema (`src/schemas/hooks.ts:128,176-206`) and fails at runtime every
time. `SubagentStart` dies one line earlier, at `:2258`, for want of `toolUseContext`.

## 6. `PreToolUse` additionalContext is discarded when the tool call fails

Upstream **2.1.110**. `src/services/tools/toolExecution.ts:1613,1742-1762`.

Hook output accumulates into `resultingMessages`; the success path returns it, the `catch`
returns a freshly constructed array. Everything a hook injected before `tool.call()` threw
is lost silently. Triggers on any failing Bash command, missing file, or aborted MCP call.

---

# P2 — wrong behavior, recoverable

## 7. Sub-agent summaries re-run every 30 s on a static transcript

Upstream **2.1.128**. `src/services/AgentSummary/agentSummary.ts:61-160`.

`runSummary` fires on a 30 s timer with the only skip being `messages.length < 3`. There is
no comparison against the previous tick. A sub-agent blocked on a long test run or a
permission prompt costs a full forked-agent request carrying its entire context, every 30
seconds, indefinitely. Upstream added a transcript fingerprint (`${len}:${lastUuid}`) and
returns early when unchanged.

This is the optimization finding that the optimization hunt missed.

## 8. `--rename`/`--color` metadata lost on `--resume <uuid>`

Upstream **2.1.108**. `src/utils/sessionStorage.ts:5267`.

`getLastSessionLog()` does not read `agentNames`/`agentColors` from the transcript, and
`loadSessionFile`'s return type omits both. Its two sibling loaders (`loadFullLog:4077`,
`loadAllLogsFromSessionFile:6143`) read them correctly. `--continue` and the `/resume`
picker are unaffected — only the bare-uuid path.

## 9. Skills re-execute after auto-compaction

Upstream **2.1.119**. `src/utils/messages.ts:3833-3851`, `src/services/compact/compact.ts:1602-1642`.

The post-compaction `invoked_skills` attachment re-injects the full SKILL.md, including its
original `## Input`, as meta user content saying "Continue to follow these guidelines" —
with nothing marking it historical. Upstream added an explicit "Do NOT re-execute these
skills or perform their one-time setup actions again; the Input sections are NOT the user's
current message", plus a dedup pass keyed on prior injections that this fork lacks.

## 10. Subagent `model` and `effort` overrides are lost on resume

Upstream **2.1.211**. `src/tools/AgentTool/resumeAgent.ts:262`.

Hardcodes `model: undefined`, and the override was never persisted — `AgentMetadata`
(`sessionStorage.ts:372-388`) has no `model` or `effort` field. A subagent spawned with an
explicit model silently continues on the parent's model after resume.

## 11. `--agents` silently swallows invalid JSON

Upstream **2.1.243**. `src/main.tsx:1999-2008`.

`safeParseJSON` returns falsy and the `if (parsedAgents)` guard skips past it. Invalid
definitions are swallowed one layer deeper (`loadAgentsDir.ts:521-536`). The session starts
normally with zero CLI agents. Contrast, in the same file: `--mcp-config` collects
validation errors, writes them to stderr and `process.exit(1)` (`:1464-1471`).

## 12. `cd x && cmd >/dev/null` prompts every time

Upstream **2.1.207**. `src/tools/BashTool/pathValidation.ts:935-944`.

The `compoundCommandHasCd && redirections.length > 0` guard returns `ask` five lines
*before* the `/dev/null` skip at `:947`. Upstream: `redirects.some(o => o.target !== "/dev/null")`.

## 13. `cut -d /` and friends read the delimiter as a path

Upstream **2.1.98**. `src/tools/BashTool/pathValidation.ts:282-290`.

`cut`, `paste`, `column`, `awk` use bare `filterOutFlags`, which has no flags-with-arguments
set. Probes: `cut -> ["/","data.txt"]`, `awk -> ["{print $1}","data.txt"]`. The delimiter
becomes a path outside the working directory, so the command prompts.

Same item, second half: `src/utils/permissions/pathValidation.ts:423-427` fires
`cleanPath.includes('%')` unconditionally and before any cwd-allow, so a filename like
`report%20.txt` inside the project prompts. Upstream gated the `%` check to Windows.

## 14. Editing a recalled history entry loses the edit

Upstream **2.1.149**. `src/hooks/useArrowKeyHistory.tsx:124-196`.

The composer draft is saved only at `targetIndex === 0`. Once inside history, both handlers
overwrite from the cache and never write the edited text back. Up, edit, Up again — the
edit is gone. Trivially reproducible.

## 15. Background subagents running at exit are never reported on resume

Upstream **2.1.157**. `src/utils/cleanupRegistry.ts:71-110`.

A `stall-detected` diagnostic record is written, but it is a log type, not one of the five
replayed transcript-message types, so nothing surfaces it. On `--resume`, `AppState.tasks`
starts empty and no notice is emitted. Missing report rather than lost work — the subagent
transcripts survive on disk.

## 16. Permission rule matchers are recompiled on every check

Upstream **2.1.208**. `src/utils/permissions/filesystem.ts:1013-1032`.

`matchingRuleForInput` re-derives every rule and builds a fresh `ignore().add(patterns)`
matcher per filesystem permission check. Upstream added an LRU keyed on the rule arrays.
**No symptom today** — this machine has 10 allow rules and zero deny/ask rules, and
upstream's cache only covers deny/ask. Listed for completeness; do not prioritize.

## 17. Crash on resume from a non-string `file_path`

Upstream **2.1.229**. `src/utils/queryHelpers.ts:411,424,438`.

`expandPath(input.file_path, cwd)` guarded by truthiness, not type; `src/utils/path.ts:37`
throws `TypeError`. A persisted `tool_use` whose `file_path` is a truthy non-string kills
`restoreReadFileState` inside an unguarded mount effect (`src/screens/REPL.tsx:2203-2212`)
— error screen on every resume of that session. Note the contrast one function later:
`command` *is* type-checked at `queryHelpers.ts:570`.

## 18. Parser diagnostics reach user-visible text

Upstream **2.1.136**. `src/utils/bash/ast.ts:408-455`.

Strings like `Contains simple_expansion` and `declare flag -i changes assignment semantics
(nameref/integer/array)` flow through `bashPermissions.ts:1745` into the `tool_result`
error content shown in the transcript and sent to the model. Surfaces only on auto-denial
(`-p` / non-interactive), not the interactive dialogs. Several also violate this repo's own
§7 rules (em dash, internal vocabulary).

## 19. Hook `if:` conditions fire on every command containing `$()` or `$VAR`

Upstream **2.1.163**. `src/tools/BashTool/BashTool.tsx:453-457`.

Non-`simple` parses fail open, returning a matcher that is `true` for every pattern.
Measured: `ls $HOME` -> `too-complex: Contains simple_expansion`, so a hook scoped
`if: "Bash(git *)"` runs on it. The fail-open is documented as intentional here; upstream
chose to narrow the parser instead. Currently unexercised — no `if:` conditions configured.

## 20. Remote Control messages sent mid-turn vanish

Upstream **2.1.238**. `src/hooks/useReplBridge.tsx:200-214,701-707`.

Shares the attachment root cause (finding 2) plus its own gate: the outbound forwarder
handles only `user`, `assistant`, and `system/local_command`. The `ptclove-bridge` state
under `~/.cat-code/` shows this bridge is in use.

## 21. Stale-worktree cleanup destroys untracked files

Upstream **2.1.98**. `src/utils/worktree.ts:1099-1104`.

The safety gate runs `git status --porcelain -uno`. `-uno` hides untracked files, so a
worktree whose only content is uncommitted new files passes the clean check and is then
removed with `--force`. Upstream runs the same check without `-uno`.

**Needs adjudication rather than a blind fix:** the comment at `:1051-1053` documents the
choice — "untracked files in a 30-day-old crashed agent worktree are build artifacts;
skipping the untracked scan is 5-10x faster on large repos". That reasoning came from the
2.1.87 snapshot, and upstream has since rejected it.

## 22-23. Two more sampled items

Rate-limited/errored subagent partial-result reporting and `/stats` subagent accounting both
came back **ALREADY-FIXED** in this fork. Counted in the tally, not detailed here.

---

# What ABSENT-CODE teaches for the next pass

Sixteen of sixty were fixes to code this fork does not have. Four of the five in the tools
area were fixes to machinery upstream **added after 2.1.87** (per-worktree sandbox deny
paths, Bash worktree isolation) or that this fork **replaced wholesale** (tree-sitter ->
pure-TS bash parser, the provider layer).

So changelog lines about the bash parser internals, sandbox profile construction, worktree
isolation, `claude agents` session management, and the Cowork/daemon surfaces are
systematically inapplicable here and can be filtered out before any agent reads them.

# Unresolved

Three items could not be settled and are recorded rather than guessed:

- **`/tmp/claude-*-cwd` leak on kill** (2.1.238). Our unlink is byte-identical to unfixed
  upstream, but no triggering path could be constructed — `#doKill` SIGKILLs the group and
  the file is never created. Zero such files on disk. Would need an instrumented kill.
- **Compound-redirect parsing** (2.1.216). The 2.1.215->2.1.216 delta was isolated in the
  binaries; our `walkRedirectedStatement` is the pre-fix shape, but every probe still routed
  the redirect target to `checkPathConstraints`.
- **Resume cache miss** (2.1.90). The fork runs the pre-fix configuration of the machinery
  upstream moved, with both cache-safe designs present but gated off. Could not establish a
  resume-*specific* first-request miss.

# Provenance

Sample generated and stratified by the orchestrating session; 60 items investigated by four
agents, one per area, each read-only. The orchestrator independently re-verified against
source: the permission bypass (all four links), attachment persistence (code plus the
2,051-transcript corpus sweep), the EnterWorktree path chain, the summary timer, the agent
hooks throw, the resume model drop, the `--agents` swallow, and the worktree `-uno` gate.
Remaining findings carry their investigating agent's evidence as reported.
