# Bug RCA: `gpt-5.6-luna` subagent/side requests die with HTTP 404 "Model not found"

- **Date:** 2026-07-12
- **Status:** Diagnosed — root cause + HTTP-refusal mechanism confirmed (source, logs, openai/codex#31967); minimal HTTP fix identified (`version` header only, ~80%, pending a confirming probe). **Durable fix (1)+(2) committed on `migration` (`9cfed13`, pushed; PR #8 for review) with review follow-ups applied — true per-account sticky storage + streaming-only 404-retry; not yet live-verified. Trigger fix (3) was implemented and automatically verified on 2026-07-15; see `docs/reports/2026-07-15-codex-subagent-single-usable-account-failure.md`. Currency fix (4) and the confirming probe remain open.**
- **Area:** Engine — Codex transport (`src/services/api/codex-*`), account lease pool.
- **Severity:** High. Silently kills subagent (Explore) spawns and title-generation
  side queries whenever a WebSocket blip forces the HTTP fallback while the
  session model is `gpt-5.6-luna`. Surfaces to the user as `Tool execution failed`.

## TL;DR

The "use HTTP instead of WebSocket" sticky flag is keyed by **conversation only**,
but it actually reflects the health of **one account's** WebSocket. When a
subagent's first request fails WS on a bad account (a dead `token_invalidated`
token), the pool reassigns the lease to a healthy account — but the stale
conv-keyed flag makes the retry **skip WS on the healthy account too**, and the
HTTP fallback channel cannot serve `gpt-5.6-luna`, so the 404 is terminal.

It is **not** account-scoped model availability (both `main`/`onbi` serve luna
fine over WS) and **not** a 5.6-family gap (`gpt-5.6-sol` completes over the same
HTTP fallback). It is one model, `gpt-5.6-luna`, that the HTTP channel refuses,
intersected with a fallback path that a lease reassignment fails to unstick. The
refusal itself is header-keyed client-cohort resolution (openai/codex#31967):
cat-code's HTTP identity — `originator: codex_cli_rs` with no version header —
lands in a cohort where luna's slug resolves to a dead engine, while WS's beta
value reaches the modern cohort.

The subagent correlation is real but **indirect**: subagents cold-connect to
`spread`-selected, unvalidated non-main accounts, so they trip the bad-account WS
failure far more often — and a dead subagent is *visible* while a dead title
query fails silently.

## Symptom

Spawning an Explore subagent from a session on model `gpt-5.6-luna` shows:

```
⏺ Explore(Trace stale memory framing)
  Initializing…
  Tool execution failed
```

Underlying error (Codex/ChatGPT-backed provider, HTTP path):

```
Codex API error (404): {"error":{"message":"Model not found gpt-5.6-luna",
  "type":"invalid_request_error","param":"model","code":null}}
```

Primary evidence log: `~/.cat-code/debug/4633e2e0-fe25-4a47-a20a-463fe9a5d204.txt`.

## What is settled (verified this session)

**The failure is transport-bound, and luna-specific — not account/model-availability.**

- Across all ~1,240 debug logs, the string `Model not found` names exactly one
  model, **`gpt-5.6-luna`, 32/32 occurrences** — never sol/terra/5.5/5.4-mini.
  *(verified: `rg -o "Model not found gpt-…"` over `~/.cat-code/debug`.)*
- Every one of those 32 is immediately preceded by a `falling back to HTTP`
  marker for the same conversation. The 404 never occurs on a WebSocket request.
- Same account + same model, opposite transports, opposite outcome:
  - `ca889574` (main) serves luna fine over **WS** (`f8136fb5.txt:160`,
    `fdd837b0.txt:162`).
  - `14f2f119` (onbi) — which serves luna over WS in the failing session — **404s**
    it over **HTTP** in `1302243a.txt:404`.
- `gpt-5.6-sol` (also a 5.6 preview model) **completes over the same sticky HTTP
  fallback**, same account, same session, ~14s after luna 404'd there:
  `f2982cc2.txt` `awaiting_initial_output transport=http` →
  `initial_output_ready transport=http elapsed_ms=3246` (05:28:58→05:29:01).
  So the HTTP channel's rejection is scoped to luna, not the 5.6 family.
- The HTTP responses even carry `x-codex-safety-buffering-faster-model=gpt-5.6-luna`
  (`f2982cc2.txt`, `e818b062.txt`) — the HTTP plane *knows* luna and uses it
  internally as its fast drafting model, but will not accept it as a *requested*
  model. This reads as a requestable-model allowlist gap, not "luna absent from
  HTTP infra."

Both transports POST the identical URL and an identically-built body:
- URL `https://chatgpt.com/backend-api/codex/responses` — WS `CODEX_WS_URL`
  (`codex-websocket-transport.ts:68`), HTTP `CODEX_BASE_URL`
  (`codex-fetch-adapter.ts:3102`).
- Body built once by `buildCodexRequest` (`codex-fetch-adapter.ts:1186-1317`,
  `model` at `:1207`); `mapClaudeModelToCodex('gpt-5.6-luna')` returns it
  unchanged (`:499-506`, luna is in `CODEX_MODELS` `:481-489`).
- The one documented difference is the `OpenAI-Beta` header:
  WS `responses_websockets=2026-02-06` (`codex-websocket-transport.ts:70-71`) vs
  HTTP `responses=experimental` (`codex-fetch-adapter.ts:3229`).

## Root cause — a five-link chain

Each link cites source (verified in this pass) and the matching log evidence.

**1. Subagents lease *away* from the main account.**
`resolveDefaultLeaseStrategy` returns `follow-main` for `ownerType === 'main'`
and `spread` for every other owner (`codexAccountLeaseManager.ts:593-599`). The
`spread` comparator explicitly penalizes the main account
(`codexAccountLeaseManager.ts:520-527`) and otherwise prefers the fewest-live-leases
account — i.e. the least-recently-exercised pool account, whose latent problems
(dead token, cold route) are the least likely to have been discovered yet. In the
observed subagent incidents the subagent was first-leased to `93ce612e` while main
rode a different, healthy account. *(spread/penalty: verified in source; per-incident
lease target: from log-corpus analysis.)*

**2. A fresh conversation key ⇒ a cold WS connect.**
A subagent's transport conversation id is `${sessionId}/${agentId}`
(`codex-fetch-adapter.ts:174-175`). WS sessions are keyed by conversation id, so a
subagent's first request always opens a brand-new socket (no warm reuse). In
`4633e2e0.txt` the connect to `93ce612e` failed immediately; the HTTP responses
from that account show why: `x-openai-authorization-error=401`
`x-openai-ide-error-code=token_invalidated` (lines 459, 462) — the account's token
was dead in that window. (`93ce612e` is not chronically broken; it has many WS
successes across the corpus — it was broken *then*.)

**3. A generic WS failure sets a conv-keyed, account-agnostic sticky flag.**
`stickyHttpFallback` is a `Map<string, StickyFallbackEntry>` keyed by
**conversation id alone** (`codex-fetch-adapter.ts:75`, `markStickyHttpFallback`
`:104-118`), TTL 60s. A dead-token WS upgrade surfaces as a generic
`WebSocket connect error`, classified `APIConnectionError` — **not**
`CodexAccountAuthError`. Only cap/auth errors `throw` to `withRetry` for a clean
account failover (`codex-fetch-adapter.ts:3380-3398`); everything else falls
through to the HTTP fallback and marks the conversation sticky
(`:3400-3403`). The reason a header-only `token_invalidated` misses the auth
branch: `classifyCodexHttpAccountError` inspects only status + body, never the
`x-openai-*` response headers (`codex-fetch-adapter.ts:372-392`).

**4. Account failover does not clear the sticky flag. (This is the crux.)**
HTTP on the dead account 401s twice; the pool then reassigns the lease to healthy
`ca889574` (`4633e2e0.txt:463` "Reassigned lease … on connection error"). But the
retry re-enters the streaming branch at `codex-fetch-adapter.ts:3332`,
`if (!hasStickyHttpFallback(conversationId))` — finds the still-valid flag for the
**same conversation key** — and skips WS on the now-healthy account. The design
comment at `:3374-3379` states the assumption explicitly: the turn "replays over
HTTP now and WS resumes … after the sticky window," i.e. HTTP is treated as a
transparent substitute for WS. The flag reflects the *old* account's WS health but
is applied to the *new* account.

**5. HTTP cannot serve luna → terminal.**
The 404 is returned as a plain `Response` (`codex-fetch-adapter.ts:3416-3438`);
`withRetry`'s classifier has no 404 branch (only 400/401/403/408/429/5xx), so it is
non-retryable; the streaming→non-streaming degrade in `claude.ts` retries the
*same* HTTP transport, which 404s again; terminal throw. The "HTTP is equivalent"
assumption from link 4 held for every model until luna shipped (first seen
2026-07-10 in the corpus).

## Why only Explorer/subagents die — and a normal session doesn't

Direct answer: **the bug is not Explorer-specific.** A normal session's main thread
stays on **one account it is already using successfully** (`follow-main`) and keeps
a **warm WebSocket** to it, so it never enters the HTTP fallback where luna dies. An
Explorer subagent is structurally forced toward the conditions that do — for two
independent reasons, and only the subagent hits both at once:

1. **Different, unvalidated account (the primary reason).** The main thread leases
   its own account (`follow-main`); a subagent is deliberately steered to a
   *different* one by `spread`, which penalizes the main account
   (`codexAccountLeaseManager.ts:520-527`, `:593-599`) and picks the
   least-recently-used account — precisely the one whose latent problems haven't
   surfaced this session. In all three subagent incidents the subagent was pushed
   onto `93ce612e`, whose token was dead in that window, while the main thread rode a
   healthy account and never touched it. (With an all-healthy pool the subagent's
   connect succeeds like main's — the failure *requires* a bad account in the pool,
   which `spread` is the most likely to expose.)
2. **Cold connect (the amplifier).** The main thread's WebSocket is opened once and
   reused (conv key = session UUID); it is already proven. A subagent's conv key is
   `${sessionId}/${agentId}` (`codex-fetch-adapter.ts:174-175`), so its first request
   **must open a brand-new socket** — and a dead token rejects that fresh handshake
   immediately, whereas a warm socket to a good account keeps working. So the
   subagent both lands on the bad account *and* cold-connects to it, surfacing a
   failure the main thread's warm-socket-to-a-good-account never sees.

That failed WS → sticky HTTP fallback → luna 404 → terminal (links 3–5). The main
thread of the *same* session — itself luna in `4633e2e0`, on healthy `14f2f119` —
never falls to HTTP, so it never meets the 404.

**Two things that are NOT the reason**, to be exact:
- **Not per-account model availability** — luna works on every account over WS.
- **Not main-thread immunity** — a main conversation on luna *would* die identically
  if its own account's WS failed and it fell to HTTP. It just never does in the
  corpus: its account is proven and its socket stays warm. (Sol-running main threads
  *did* fall to sticky HTTP in the same windows and survived only because sol
  resolves over HTTP; luna would not have.)

So the failing class is "**luna requests whose conv-keyed WS is unavailable**."
Subagents are the loudest members (they always cold-connect to a spread-selected,
unvalidated account); title-generation side queries are the quiet ones. The 8
incident logs split into 3 *visible* subagent deaths (`Tool execution failed`) + 5
*silent* title-query deaths — so **visibility, not mechanism, is why it looks
Explorer-only.**

## Confidence

- ~97% that the failure is transport-bound (HTTP fallback), not account/model
  availability. *(verified triangulation.)*
- ~90% in the full five-link chain for the observed incidents — every link has both
  a source citation and a matching log line.
- ~95% that the failing class is "luna requests whose conv-keyed WS is unavailable,"
  not anything subagent-specific.

## Why the HTTP channel refuses luna — RESOLVED (~90%)

Not a WS-only backend, and not a per-channel allowlist. The ChatGPT/Codex backend
resolves the public model slug to an internal engine name **per client cohort,
keyed on request headers**; a cohort it doesn't recognize resolves `gpt-5.6-luna`
to an engine that doesn't exist.

External confirmation — openai/codex#31967, a controlled A/B over this exact HTTP
`responses` endpoint (third-party client, valid ChatGPT OAuth):

| `originator` | `version` | result |
|---|---|---|
| `pi` | omitted | Model not found |
| `codex_cli_rs` | omitted | **Model not found** |
| `pi` | `0.144.1` | Model not found |
| `codex_cli_rs` | `0.144.1` | **Success** |

The failure returns a server-generated engine name (`Model not found
gpt-5.6-luna-free-1p-codexswic-ev3`) that appears in no client — proof the slug is
resolved server-side per cohort, not matched against a client-sent list.

This is a near-exact reproduction of cat-code's failing request: cat-code's HTTP
path sends `originator: codex_cli_rs` (`codex-fetch-adapter.ts:3208`) and **no
version header** (verified by grep) — i.e. row 2, "Model not found." WS succeeds
without a version header because its `responses_websockets=2026-02-06` beta value
signals the modern cohort on its own; HTTP sends the legacy `responses=experimental`
and no version, landing in a cohort with no live luna engine. Older models
(sol/5.5/5.4-mini) predate the cohort tightening, so they resolve in every cohort —
which is why only luna dies. Luna's model metadata declares
`minimal_client_version: 0.144.0` / `use_responses_lite: true` — it shipped with
client-cohort requirements the legacy HTTP identity does not meet. This also
explains the `x-codex-safety-buffering-faster-model=gpt-5.6-luna` header: luna
exists on the HTTP plane's infrastructure; only the slug resolution for our cohort
fails.

**Minimal HTTP fix identified — `version` header only (~80%).** The follow-up
question ("version-only vs the full responses-lite protocol") is closed by the
source of the #31967 table: the reporter's client (earendil-works/pi) sends the
**same shape cat-code sends** on its HTTP SSE path — `OpenAI-Beta:
responses=experimental`, plain non-lite body — differing only in `originator`. So
the Success row (`codex_cli_rs` + `version: 0.144.1`) is cat-code's failing request
**plus one header**, non-lite, and it completed a function-tool round-trip (relevant
because cat-code always sends tools). Lite is **not** an availability gate: the
reporter found "the Responses Lite header alone did not change the result,"
cat-code's WS serves luna with no lite, and upstream gates lite on the model-catalog
flag `use_responses_lite` (semantics — restricted tool surface / stripped image
detail), not on transport. **The beta header does not need to change** (Success was
on `responses=experimental`; this reverses an earlier working hypothesis that the
beta value was the lever). Soft spot (why ~80%, not ~95%): the issue does not print
the transport per table row, so if the Success row ran over WS rather than SSE it
would not prove the HTTP case — judged unlikely (coherent identity-isolation table,
HTTP-POST repro instructions, row 2 matching our HTTP corpus 32/32), and the probe
in fix option 4 kills it.

## Fix status and remaining recommendation

**Durable — implemented (model/version-agnostic; break link 4, the only link that
turns a transient blip on a *bad* account into a terminal failure on a *good* one):**

1. **Primary:** key the sticky flag by `conversation + account`, or clear it on
   lease/account reassignment. Then the reassigned-to healthy account retries WS
   (which serves luna). Touch points: the map + helpers (`codex-fetch-adapter.ts:75`,
   `:104-118`), the gate (`:3332`), and the reassignment path. This alone would have
   fixed all three observed subagent incidents.
2. **Backstop:** treat HTTP `404 Model not found` as "retry over WS" rather than
   terminal (`codex-fetch-adapter.ts:3416-3438` + `withRetry` classification).
3. **Implemented 2026-07-15 — removes the trigger:** classify the header-only `token_invalidated` as
   `CodexAccountAuthError` by inspecting the `x-openai-ide-error-code` /
   `x-openai-authorization-error` response headers in `classifyCodexHttpAccountError`
   so the dead-token WS failure enters account-bound refresh/dead-mark/failover
   instead of transient connection handling. Related prior work:
   `docs/reports/2026-07-10-codex-token-invalidated-recovery.md`.

Minimal robust PR: (1) + (2).

**Currency — optional, brittle (makes the HTTP fallback actually serve luna today):**

4. **Restore the HTTP fallback for luna (optional currency):** add a client
   `version` header (`0.144.1`, or the current upstream release) to `authHeaders`
   (`codex-fetch-adapter.ts:3205-3210`) — **that one line, beta unchanged**
   (`responses=experimental` stays; the modern-cohort Success in openai/codex#31967
   used it). cat-code already sends `originator: codex_cli_rs`, so this matches its
   existing posture, not a new impersonation. Lite is not required (availability vs
   semantics — see the mechanism section); WS needs nothing. **Brittle:** the pinned
   version ages out with the next preview model, so track it against upstream
   releases — currency maintenance, not a root fix. Do not treat (4) as a substitute
   for (1)+(2).

   *Confirming probe (designed, NOT run — burns one live request, needs operator
   authorization):* one request from cat-code's exact HTTP builder
   (`codex-fetch-adapter.ts:3219-3232`) + `version: 0.144.1` only, beta unchanged.
   `200`/SSE → one-line fix confirmed; `404 Model not found` → version-only
   insufficient, escalate one variable at a time (beta →
   `responses_websockets=2026-02-06`, then the lite flag, then a lite body), with a
   no-version control run to confirm the baseline held.

## Falsifiers

- **For "fallback-only":** a luna `Model not found` 404 in a log *not* preceded by a
  `sticky_http_fallback` / `falling back to HTTP` marker for that same conversation
  key (i.e. on a first-choice HTTP request or an active WS). Would break the premise
  the whole chain rests on. Checked: all 32 luna 404s sit inside a marked fallback
  window; none found.
- **For "luna-specific channel gate":** a `terra` HTTP completion would sharpen it; a
  `terra` HTTP 404 would push back toward a family gate with sol as the exception.
  Neither is present in the current corpus (terra never 404'd, and no completed terra
  HTTP request was found).
- **For "WS-only / no HTTP shape works":** needs a live probe — a single HTTP `200`
  for luna under any header falsifies it and makes the fix a header change.
- **For the `spread` link:** a subagent incident whose first lease was the main
  account. All three observed incidents first-leased `93ce612e`.

## Method & provenance

- Log-corpus triangulation over ~1,240 files in `~/.cat-code/debug/`.
- Direct source verification (this pass): the sticky-flag scoping and gate
  (`codex-fetch-adapter.ts:75/104-118/3332/3364-3403`), the 404 return + classifier
  (`:372-392/3416-3438`), the beta headers and URLs, the once-built body, the lease
  strategy (`codexAccountLeaseManager.ts:520-527/593-599`), and the subagent
  conversation-id shape (`codex-fetch-adapter.ts:174-175`).
- Four independent stronger-model (`gpt-5.6-sol`) passes: (i) a decorrelated
  verification of the transport-bound conclusion (which corrected an initial
  over-broad "5.6-family" mechanism to luna-specific via the sol-over-HTTP
  counter-fact); (ii) a root-cause pass that produced the five-link chain; (iii) a
  mechanism/external-research pass that resolved (a)-vs-(b) via openai/codex#31967;
  (iv) a closing pass that established the minimal HTTP fix as version-only —
  anchored on the #31967 reporter's client (earendil-works/pi) sending cat-code's
  exact HTTP shape (`responses=experimental`, non-lite), with lite ruled out as an
  availability gate. Aggregate corpus counts (per-incident lease targets, the
  3-subagent/5-title split, WS success totals) are from those passes and were not
  each independently re-counted this session; the crux links (3–5), the byte-level
  request delta, the decisive A/B facts, and openai/codex#31967 (verified via
  WebFetch — its A/B header table quoted above) were checked directly here.
- Sources: openai/codex#31967 (header-keyed slug resolution A/B, verified);
  openai/codex#31882; anomalyco/opencode#36140 · PR#36143 (a confirmed luna fix
  scoped to `{sol,terra,luna}`); openai/codex `client.rs` (main).
