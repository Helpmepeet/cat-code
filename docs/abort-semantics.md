# Abort Semantics

PTClove sends `abort_turn` to the active cat-code session. The bridge handler
routes it to the same cancel path as the local REPL interrupt.

| Tool family | In-flight work stops? | Notes |
| --- | --- | --- |
| Bash | Yes for foreground subprocesses | `BashTool` passes `abortController.signal` into `exec(...)`, and interrupted results are handled explicitly. Backgrounded shell tasks may continue by design. |
| Edit / Write | Mostly prevents next work | These tools are short-lived synchronous project mutations. The shared tool executor checks the abort signal before tool execution; cancellation during the tiny write window is not a reliable kill switch. |
| Read / Glob / Grep | Mostly prevents next work | Read-only operations are short-lived. The executor honors abort before starting work; mid-operation cancellation depends on the individual helper. |
| Task / subagent | Partial | The streaming executor creates child abort controllers from the turn controller, so queued and cooperative sub-work sees cancellation. Work already delegated to independent background machinery may finish. |
| Unknown tool | Yes for the turn | `toolExecution.ts` aborts the turn when it cannot resolve a tool name. |

UI wording: PTClove labels the button `Stop turn`. It should be understood as
the same interrupt as pressing cancel in the REPL: Bash foreground work is
interrupted, queued/future tool work is stopped, and already-backgrounded work
may finish.
