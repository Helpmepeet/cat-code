# `cat-code -p` exited 0 after ending mid-work with no deliverable

Status: observation report, cause NOT determined. Handoff for a debugging session.
Observed 2026-08-27 (UTC), written 2026-08-28.

## What happened

A single non-interactive delegation was launched from `/Users/pt/cat-code`:

```
timeout 2400 cat-code -p --model gpt-5.6-sol --permission-mode auto "<7.2KB review brief>"
```

The process exited **0**. Its entire stdout was one sentence:

> I'm still recomputing the corpus-wide counts before issuing the per-claim verdict.

No review, no verdict, no partial findings. The caller was told the run succeeded.

## Evidence

Session: `~/.cat-code/projects/-Users-pt-cat-code/cc171835-160c-4b2b-bae4-a531e731745d.jsonl`
Span `2026-08-27T17:00:57.173Z` to `2026-08-27T17:02:58.003Z` (2m 1s).

| Fact | Value |
|---|---|
| Human turns | 1 |
| Assistant lines | 41 |
| Tool calls | 34 (Grep 13, Read 12, Bash 6, Skill 2, Glob 1) |
| Errored tool calls | 0 |
| Terminal interruption recorded | none |
| Pending / failed tool calls | none |
| Compact boundaries | none |
| Assistant **text** blocks in the whole transcript | **zero** |

The run did real work: 34 successful tool calls over two minutes. It simply never
emitted a final answer.

Two details worth carrying into the debug:

1. **The printed sentence is not in the transcript as an assistant message.**
   `session-inspect final` reports `Last assistant text: none found`. The string
   reached stdout but no assistant text message was persisted. Whatever stdout
   printed came from somewhere other than a recorded assistant turn.

2. **The transcript ends immediately after a request was issued.** The last
   records are six `tool_result` lines (L107-112), then
   `{"type":"system","subtype":"codex_request_start"}` at L113, then
   `{"type":"last-prompt"}` at L114. There is no matching
   `codex_stream_surface` for that request. The process ended between issuing a
   request and recording any response to it.

Also present, unexplained: two `queue-operation` records at L1/L2 (enqueue then
dequeue) in a run that had exactly one prompt and no interactive input.

## What is NOT established

- Why the process ended. No error, no interruption marker, no failed tool.
- Whether the run hit a turn cap, a budget guard, a stream failure, or something
  else. Nothing in the transcript names a limit.
- Whether the stdout sentence and the missing assistant message share a cause
  with the delta-less text-drop defect diagnosed the same day in
  `src/services/api/codex-fetch-adapter.ts` (that one is a separate, confirmed
  bug; the resemblance here is unverified and may be coincidence).

Do not carry any of the above into the fix as an assumption.

## A near-miss to rule out, not a second data point

A second run (`1b937a37-a6ef-4979-bcaa-efa4eabe77d0`, started
`2026-08-27T17:04:15Z`) has a superficially identical tail: 28 tool calls, then
`codex_request_start` with no response. That one was **killed by an operator
interrupt**, so its shape is explained. It is useful only as a control showing
what an interrupted run looks like, which is indistinguishable from cc171835 in
the transcript. That indistinguishability is itself part of the problem.

## Why this needs a change regardless of cause

The exit status is the part that bites callers, and it is wrong independently of
whatever ended the process.

Standing guidance for delegating to `cat-code -p` (user's global `CLAUDE.md`)
already says to wrap the call in `timeout`, check exit status, and report the
result faithfully. Exit 0 defeats all three: the delegating agent checks the
status, sees success, and has no signal that the deliverable is missing short of
reading the output and noticing it is a status update rather than an answer. An
automated caller would not notice at all.

Suggested direction, for the debugging session to accept or reject:

- `-p` should exit non-zero when a run terminates without producing a final
  assistant message. "Ran tools and stopped" is not success.
- Failing that, stdout should carry an explicit machine-detectable marker that
  the run ended without a final answer, so a caller can distinguish it from a
  short but complete reply.

Prompt-side mitigation exists but does not fix this: restating the deliverable
requirement in the brief can reduce the chance a model ends its turn early, and
it does nothing about a process that dies mid-request or about the exit code.

## Reproduction status

Not reproduced on demand. One confirmed occurrence. Frequency across historical
`-p` runs has not been measured; a sweep of `~/.cat-code/projects/` for sessions
with tool calls and zero assistant text blocks would establish it.
