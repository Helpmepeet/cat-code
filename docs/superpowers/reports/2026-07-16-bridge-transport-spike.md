# ChatGPT Bridge transport spike

Status: PASS (B-0 complete). Executed 2026-07-16 against a throwaway
developer-mode ChatGPT app and echo-only MCP server. No repository material was
served.

## Binding tunnel decision

The spike used ngrok because it was the only configured and operational tunnel
on this machine: cloudflared was absent and the installed Tailscale client could
not load preferences or provide Funnel. This is the binding B-0 choice for the
implementation unless the operator later replaces it deliberately.

ngrok terminates TLS at ngrok's edge. The capability path, disclosed task
material, and returned results therefore transit ngrok in plaintext at that hop.
Every bridge disclosure must name OpenAI and ngrok as transit parties. The spike
served throwaway strings only.

## Transport evidence

| Check | Result | Observation |
|---|---|---|
| Public HTTPS endpoint | PASS | ChatGPT created the development app through the ngrok endpoint and displayed the advertised `echo` tool. |
| `initialize` | PASS | Multiple real ChatGPT initialization requests completed with HTTP 200 SSE responses. |
| `notifications/initialized` | PASS | ChatGPT sent initialized notifications; the server returned HTTP 202. |
| `tools/list` | PASS | ChatGPT listed the single `echo` tool. |
| `tools/call` | PASS | Three echo calls returned the exact supplied text with HTTP 200 and `text/event-stream`. |
| SSE framing | PASS | ChatGPT accepted immediate, single-message `event: message` responses that closed after the result. |
| Session persistence | PASS, stateless | ChatGPT did not send `Mcp-Session-Id`; independent initialize/list/call requests completed without server-side transport sessions. The production server must continue to support optional passthrough but cannot depend on it. |
| `initialize.instructions` | PASS | A signed prefill named the app and supplied input text without naming `echo`; ChatGPT followed the server instruction to call `echo` and returned the exact result. |
| Tool confirmation UI | NONE for read-only spike | No Allow/Confirm UI appeared for `echo`. The write-tool confirmation question remains B-4 gate 3. |
| Signed `?q=` prefill | PASS | The existing v1 userscript submitted automatically from Chrome. |
| App auto-selection | PASS | The prompt named `Cat Code Bridge B0`; ChatGPT selected the app and invoked `echo` without manual attachment or clicks. |

## Exact live observations

1. Manual app creation showed one public action, `echo`, with authorization
   `None` and development review status.
2. A manually submitted app-attached prompt returned
   `b0-roundtrip-2026-07-16`; the local trace showed one matching `tools/call`
   and matching SSE result.
3. A signed prefill returned `b0-prefill-roundtrip-2026-07-16` without the
   operator pressing Send or selecting the app.
4. A signed prefill relying on server instructions returned
   `b0-instructions-roundtrip-2026-07-16`; the local trace showed a matching
   `tools/call` and matching SSE result.

ChatGPT displayed `Output schema recommended` because the throwaway echo
descriptor intentionally kept the spike minimal. Production B-1 descriptors
must include the design's strict input/output schemas, all three required tool
annotations, and `securitySchemes` at both current and compatibility locations.

## Implementation consequence

Hand-rolled Streamable HTTP is sufficient for the observed ChatGPT transport.
No MCP SDK dependency is required. B-1 may proceed, retaining these constraints:

- immediate SSE support from the first production server revision;
- stateless correctness with optional `Mcp-Session-Id` passthrough;
- concise, self-contained server instructions in the first 512 characters;
- idempotent handlers and strict schemas/annotations;
- capability-path rejection before exposing JSON-RPC behavior.

The scratch capability URL was disclosed in the task transcript and is retired.
It must never be reused for the production bridge.
