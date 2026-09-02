# The ChatGPT connector's tool surface, measured against what we actually ask it

Evaluation of the twelve tools `~/chatgpt-mcp` exposes to ChatGPT through the
My Mac Files connector, against the served folder as of 2026-09-02
(`/Users/pt/cat-code`, branch `migration`) and against the 35 real requests in
the outbox. Companion to `2026-08-30-chatgpt-review-behavior.md`, which measured
what came back; this measures what the model could see while producing it.

**Headline.** The descriptions and server instructions are sound. The binding
constraint is coverage: `grep_files` stops after 2,000 files in path-name order
and cat-code serves 4,766, so an unscoped content search never reaches most of
`src/`. That is the mechanism behind the failure the behaviour note recorded as
"never asks who calls it" (8 of 29 refutations, two findings filed in code with
no live caller). Fixing it is cheap: a full-tree scan costs 0.6 s in the current
Python, 0.05 s with ripgrep.

---

## 1. Method

- Read `mcp_server.py` (tools/list, `SERVER_INSTRUCTIONS`, every handler and
  its limits), `launch_handoff.ts` (prompt template), `AGENT-GUIDE.md`,
  `DEPLOYMENT-NOTES.md`.
- Imported the server module in a separate process against the deployed
  `.env` and called the tool handlers directly. The running server was not
  touched; the one budget change below was a process-local patch.
- Read all 94 reply chunks in `~/chatgpt-mcp/outbox/.chunks/` (41 request ids,
  35 real) and both standing request files in `chatgpt-handoff/`.
- The server log could not be used: `serve.sh` truncates it on every restart
  and it held 7 lines. See §6.

## 2. The surface as advertised

| Tool | Key limits | Notes |
|---|---|---|
| `list_files` | default depth 10, 200 entries/page, max 1000; files only | `sort=modified`; `structuredContent` experiment still unmeasured live |
| `search_filenames` | substring on **basename** only, case-insensitive | `model/providers` returns nothing |
| `read_file` / `fetch` | 20,000 bytes default, 200,000 max; `start_line`/`end_line` | header first, `[TRUNCATED]` marker names the resume point |
| `read_multiple_files` | 20 files, 200,000 bytes total | manifest first |
| `grep_files` | literal substring; **2,000-file scan budget**; 100 results default, 500 max; 3 context lines; `include` glob only | budget applied after `include`, before scan |
| `git_status` `git_branch` | | |
| `git_log` | 20 default, 100 max; `path` filter; no `ref`, no range, no stat | |
| `git_diff` | single `ref` (working tree vs commit) or `staged`; no `base..head` | 200 KB cap |
| `git_show` | one commit, no path filter | 200 KB cap; message and patch as separate blocks |
| `submit_agent_response` | 16 KB per chunk, 256 chunks, 4 MB per request | |

Tool list: 12,871 bytes, about 3,200 tokens. Server instructions: 1,191 chars.
No rate limit applies to `tools/call`; only the OAuth endpoints are limited.
`search` is accepted but not advertised, because the ChatGPT connector layer
calls it unprompted.

## 3. Measurements against the served tree

| Measurement | Value |
|---|---|
| Servable files | 4,766 (20 directories pruned) |
| By top-level dir | `src` 2,412 · `tmp` 918 · `docs` 688 · `app` 605 · `ds-bundle` 81 · `scripts` 27 |
| Files a bare grep ever reaches | 2,000 (42%) |
| Where the budget ends | all of `app/`, `docs/`, `ds-bundle/`, `scripts/`; `src/` only through 188 of 404 files in `src/components` |
| `src/` dirs never reached by a bare grep | 47 dirs, 1,631 files: `src/utils` (708), `src/tools` (287), `src/services` (210), `src/hooks` (111), `src/ink` (99), `src/query.ts`, `src/main.tsx`, `src/screens` … |
| `grep path=src` | still budget-hit; `src/utils` reached 302/708, `src/vim` and `src/voice` never |
| Bare grep for `export function resolveRequestProvider` | 0 matches (reads as "not defined") |
| Same with `path=src/utils` | 1 match, `src/utils/model/providers.ts` |
| Bare grep `resolveRequestProvider`, budgeted vs full | 64 vs 164 matches |
| Full-tree scan, budget removed, current Python | 0.55 to 0.67 s (3,837 text files) |
| `rg -F -c` same query | 0.055 s |
| Files > 20 KB default read window | 1,002 (21%); 389 of 2,107 non-test `src/*.ts(x)` |
| Files > 200 KB max read | 51 (`src/screens/REPL.tsx` is 935 KB) |
| `list_files` default first page | 200 of 4,766, all under root or `app/`; `src` not visible |
| `list_files depth=1` | 94 entries, files only |
| Scratch dirs served | `tmp/` + `ds-bundle/` = 999 files (21%) |
| Per-call latency, every tool | under 0.7 s |

Ignoring `tmp/` and `ds-bundle/` alone leaves 3,767 files, still over the
budget. The ignore list helps; it does not fix coverage on its own.

## 4. The real requests, and what each required field needs from the tools

Reply inventory (first line of chunk 0 of every request): 28 area-scoped bug or
perf hunts of cat-code, 3 web-research requests, one fix plan, one plan
critique, plus 7 probes. The 28 hunts share the two standing request files in
`chatgpt-handoff/` (`bug-hunt-ledger.md`, `perf-hunt-ledger.md`).

| Required field in the request | Tool it needs | Status |
|---|---|---|
| `file:line` of the defect | line-addressed `read_file` | works |
| adjacent comment or test, quoted verbatim | `read_file` around the line; `search_filenames` for `<module>.test` | works |
| "search that area thoroughly first" | `list_files`/`grep_files` with `path` | works for areas under 2,000 files; `src/` overflows |
| "what n actually is in THIS repo, with evidence" | `list_files` totals | works |
| **"paste the calling line and its file path"** (bug hunt) · **"who calls it and how often"** (perf hunt) | whole-tree backward search for a symbol | **broken by the budget** |
| out of scope `tmp/`, `.worktrees/` | server-side ignore | `tmp/` is served anyway; `.worktrees/` is a dot dir and already invisible, so that clause is inert |

Caller search for symbols in the perf-hunt area `src/utils/permissions/`:

| Symbol | Budgeted | Full tree | Caller files hidden |
|---|---|---|---|
| `hasPermissionsToUseTool` | 11 matches, 7 files | 36 matches, 17 files | 10, incl. `src/hooks/useCanUseTool.tsx`, `src/entrypoints/mcp.ts` |
| `useCanUseTool` | 18 matches, 10 files | 48 matches, 36 files | 26, incl. `src/query.ts` |
| `checkPermissions` | 14 matches, 6 files | 81 matches, 41 files | 35, incl. `src/services/tools/toolExecution.ts`, `src/tools/AgentTool/AgentTool.tsx` |

The `scan_note` does say the tree was not fully searched and to narrow with
`path`. On this repo every unscoped grep carries it, so it is constant noise,
and narrowing to a directory the model does not yet know is the very thing it
was searching for.

**Corroboration from the replies.** Across 30 replies ChatGPT cited 250
existing files, 138 in `src/`. Only 16 of those 138 are inside bare-grep reach.
It got there because the prompt named the directory; it could not have found
their callers by search. There were zero fabricated citations, consistent with
the behaviour note.

## 5. What to change, ranked

1. **Fix grep coverage.** Minimum: raise or drop `GREP_MAX_FILES`; the full
   scan is 0.6 s here. Better: back `grep_files` with ripgrep, already at
   `/opt/homebrew/bin/rg`, using the fixed-argv, no-shell, timeout discipline
   the git tools already use. That buys regex on a linear-time engine (the
   literal-only DoS rationale no longer applies; keep `-F` as the default),
   `.gitignore` awareness, and speed. Preserve the deny-list twice, as rg
   `--glob` exclusions and as a post-filter on returned paths, the same
   belt-and-braces `_git_pathspec_args` uses. Add: `exclude` glob (the hunts
   want non-test source; there is no way to say `*.ts` but not `*.test.ts`),
   a `count` mode returning per-file match counts so caller distribution is
   one small call, and `whole_word`.
2. **Stop serving scratch.** For the cat-code deployment set `IGNORE_DIRS` to
   the default list plus `tmp`, `ds-bundle`, `scratchpad`. `IGNORE_DIRS`
   replaces the default list, so restate all of it. Honouring `.gitignore`
   would do this generically and is free with rg.
3. **Orientation.** The default first page shows nothing about `src/`. Add
   directory entries with file counts, or a `dirs_only` mode, and let
   `search_filenames` match the relative path rather than the basename.
4. **Telemetry.** `serve.sh` writes the log with `>` and the handler logs only
   the tool name. Append per call to a JSONL outside `BASE_DIR`: tool,
   parameter names, query/path lengths, `files_searched`,
   `scan_budget_reached`, `truncated`, reply bytes, duration. Every tuning
   decision here, including the still-unmeasured stage-2 structured-output
   experiment in DEPLOYMENT-NOTES, is blind without it.
5. **Git range and stat.** `base`/`head` on `git_diff`; a `stat` or
   `name_only` mode on `git_log` and `git_show` so the model can learn which
   files a commit touched without pulling a 66 KB patch. Lower priority: none
   of the 28 review requests needed history.
6. **Prompt hygiene, once 2 lands.** Delete the `.worktrees/` clause from both
   ledgers now (inert) and the `tmp/` clause after the ignore list changes.

### Not a lever

- **The response path.** 35 multi-chunk replies assembled with zero index gaps
  and zero conflicts; chunk sizes median 6.9 KB, max 15.3 KB. The
  "multi-chunk untested" lines in the skill and `AGENT-GUIDE.md` are stale.
  The 16 KB cap sits under a measured single-request floor; leave it.
- **Latency.** Every call measured under 0.7 s.
- **Descriptions and instructions.** Stage 1 already routes content questions
  to `grep_files` and front-loads integrity markers. After item 1 the
  instructions need only a line on scoping and on citing `path:line`.

## 6. Unverified

- No persisted call log exists, so the coverage-to-failure link is mechanism
  plus corroboration (§3, §4), not a per-call trace of what ChatGPT called in
  each round. Item 5.4 is what would settle it.
- ChatGPT-side truncation of large tool results is unmeasured; the server's own
  notes say so, and the stage-2 experiment depends on it.
- The 16 KB "experimentally measured single-request floor" for submit chunks
  is cited in a code comment; the measurement itself was not found.

## Reproduce

From `~/chatgpt-mcp/chatgpt-custom-mcp-for-local-files`, in a separate process
(the deployed `.env` is read; nothing is written):

```bash
./venv/bin/python -c "
import json,logging; logging.disable(logging.CRITICAL)
import mcp_server as m
items,_=m.list_files(); paths=[i['path'] for i in items]
print(len(paths), paths[m.GREP_MAX_FILES-1])
p=json.loads(m.tool_call_grep_files({'query':'export function resolveRequestProvider'})['content'][0]['text'])
print(p['total_matches'], p['scan_budget_reached'])
m.GREP_MAX_FILES=10**6
p=json.loads(m.tool_call_grep_files({'query':'export function resolveRequestProvider'})['content'][0]['text'])
print(p['total_matches'], p['files_searched'])
"
```
