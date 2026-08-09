# A02 Sidecar Security: Adversarial Second-Pass Review

> **Verification provenance:** Independent `gpt-5.6-sol` subagent at max effort. `gpt-5.6-luna` was requested, but the runtime ignored the same-family downgrade from the Sol parent. Read-only source review; no tests or GUI run.

## Overall verdict

On the current `migration` working tree, two findings are fully confirmed, three retain a narrower confirmed core, two duplicate findings in other A01–A20 reports, and one overstates an honest test-diagnostic issue. The strongest proven security issue is unrestricted `remoteSettings.directConnect` egress, not the reported cross-user socket takeover: Darwin requires write permission on the socket inode, so pre-creating its parent directory alone does not establish the claimed exploit.

The directly cited owner files are clean relative to `HEAD`. Adjacent uncommitted changes in `app/sidecar/permissionDomain.ts` and `app/sidecar/sessionController.ts` change permission-mode assumptions but resolve none of these findings; consequently, A02’s exact post-connect escalation sequence should not be treated as stable evidence. No tests were run because source inspection settled every classification.

## Findings

### 1. [HIGH] Socket peer authentication and predictable `/tmp` path
**Classification: PARTIALLY CONFIRMED**

- **Evidence:** `/Users/pt/cat-code/app/supervisor/supervisor.ts:188-196` uses predictable `/tmp/catcode-<pid>` and accepts an existing directory without ownership or mode checks; `:239` uses predictable `s<N>.sock`. `/Users/pt/cat-code/app/sidecar/index.ts:273-296` unlinks, binds, and admits every connection; `/Users/pt/cat-code/app/sidecar/sidecarServer.ts:573-678` immediately sends identity, state, snapshots, and replay with no handshake or connection cap.
- **Trigger/cost:** Same-UID processes, or another user when the socket inode is writable, can connect and receive/control the session. An attacker owning the parent can always unlink or replace the pathname, causing path substitution or denial of service.
- **Challenge:** A02’s cross-user takeover proof is incomplete. Darwin’s current `unix(4)` documentation says a `connect(2)` destination must be writable. Owning the containing directory permits unlink/replace but does **not** bypass the socket inode’s permissions. Socket mode was not observed, so directory pre-creation alone does not prove access under an ordinary umask. Randomness and `0600` also are not peer authentication against same-UID code.
- **Disposition:** Close the narrower directory-integrity issue already reported in A10: private `0700` creation plus owner/mode validation and `0600` socket mode, failing closed on an unsafe existing path. Coordinate any random naming with `/Users/pt/cat-code/app/scripts/reap-orphan-sidecars.ts:97-115`, which only recognizes `catcode-<pid>`. Add peer credentials or a handshake token only if same-UID adversaries are explicitly in scope. Keep the locked Unix-socket architecture.

### 2. [MED] Null context-breakdown results bypass the freshness floor
**Classification: PARTIALLY CONFIRMED**

- **Evidence:** `/Users/pt/cat-code/app/sidecar/sidecarServer.ts:3003-3008` gates on both timestamp and a non-null cached result; `:3043-3048` records both only after success; `:3060-3064` immediately reruns pending work. `/Users/pt/cat-code/app/sidecar/contextBreakdownDomain.ts:187-193` converts every analyzer throw to `null`.
- **Trigger/cost:** Sustained requests during repeated null-producing analyses can keep one expensive analysis running sequentially. Empty transcripts instead repeat comparatively cheap transcript checks.
- **Challenge:** A transient token-count error is **not** sufficient: `/Users/pt/cat-code/src/services/tokenEstimation.ts:145-205` converts primary count failures to `null`, and `/Users/pt/cat-code/src/utils/analyzeContext.ts:83-145` catches the fallback and uses local display estimates. Also, A02’s proposed fix cannot work: updating only `contextBreakdownComputedAt` leaves `contextBreakdownLast && ...` false.
- **Disposition:** Use a separate last-attempt/completion timestamp, gate independently of the cached snapshot, and send the cached value only when one exists. Add a null-result cooldown test. This duplicates the correctly scoped fixes in A03 and A13.

### 3. [MED] Result-frame error text bypasses path redaction
**Classification: CONFIRMED**

- **Evidence:** `/Users/pt/cat-code/app/sidecar/sidecarServer.ts:3391-3405` redacts only `error` frames. Result messages are forwarded unchanged at `:1742-1753`, `:1926-1934`, `:1993-2001`, `:2099-2134`, `:2179-2190`, and `:2271-2279`. `/Users/pt/cat-code/app/sidecar/sessionActionsDomain.ts:154-220` interpolates raw exceptions. The text is user-visible at `/Users/pt/cat-code/app/renderer/src/AccountsPage.tsx:742` and `/Users/pt/cat-code/app/renderer/src/App.tsx:1633-1637`.
- **Trigger/cost:** An unreadable or missing transcript/settings/vault file produces an `ENOENT`/`EACCES` message containing its absolute path; that crosses into the untrusted renderer and is shown verbatim. `/Users/pt/cat-code/app/shared/secretGuard.ts:90-95` checks key names, not strings.
- **Disposition:** Redact and bound **failure** messages before constructing result/progress frames, with path and length tests. Do not blindly rewrite every result message inside `send()`: successful messages intentionally include user titles or server URLs.

### 4. [MED] `remoteSettings.directConnect` has no host policy
**Classification: DUPLICATE/DEPENDENT**

- **Evidence:** `/Users/pt/cat-code/app/sidecar/sidecarServer.ts:3853-3885` explicitly defers host policy. `/Users/pt/cat-code/app/sidecar/remoteSettingsDomain.ts:205-211` invokes direct connect with the session cwd; `/Users/pt/cat-code/src/server/createDirectConnectSession.ts:47-58` posts it to the renderer-selected host.
- **Trigger/cost:** A compromised renderer can exfiltrate cwd to an external host or issue POST requests to loopback/LAN services, receiving distinguishable success/failure information.
- **Disposition:** This is the same live issue as A11’s MED finding and the 2026-08-03 review; assign one owner. Make an explicit product/security decision: implement a robust destination policy, including redirects and resolved-address checks, or record accepted risk. A loopback-only rule conflicts with the deliberately retained remote-server form in `/Users/pt/cat-code/docs/migration/decisions/PAIRED-DEVICES.md:65-68`; a two-line hostname check is also insufficient against redirects and DNS rebinding.

### 5. [LOW] Sidecar T7 rate cap lacks boundary coverage
**Classification: PARTIALLY CONFIRMED**

- **Evidence:** `/Users/pt/cat-code/app/sidecar/sidecarServer.ts:3409-3417` implements a fixed window, despite `/Users/pt/cat-code/app/shared/limits.ts:28-32` calling it sliding. `:789-798` rejects over-cap frames but keeps the connection. No sidecar test references the constant, state, or `"rate limit exceeded"`; only `/Users/pt/cat-code/app/preload/rendererIpcGuard.test.ts:18-30` tests it.
- **Trigger/cost:** A regression in the sidecar comparison/reset logic would remove the real trust-boundary cap unnoticed. The current tumbling window also admits two boundary-adjacent bursts.
- **Disposition:** Add the proposed sidecar test and call the algorithm fixed-window unless a true sliding policy is required. Do **not** automatically drop the socket: rejected frames are not dispatched, while disconnecting the sole supervisor connection creates a reliable session DoS and `/Users/pt/cat-code/app/supervisor/supervisor.ts:509-555` does not reconnect it.

### 6. [LOW] `dispatch` lacks a `never` exhaustiveness tripwire
**Classification: DUPLICATE/DEPENDENT**

- **Evidence:** `/Users/pt/cat-code/src/web/appSessionProtocol.ts:43-48` defines the closed four-member union; `/Users/pt/cat-code/app/sidecar/sidecarServer.ts:1035-1076` handles four cases without a default.
- **Trigger/cost:** Adding a schema member and strict-key entry without extending `dispatch` accepts and then silently drops the frame.
- **Disposition:** Add a `never` default, with a runtime `bad_request` fallback if desired. This is an exact subset of A03’s MED finding; do not couple the one-line safety fix to A03’s broader routing refactor.

### 7. [LOW] Permission-denial free text has no field-specific cap
**Classification: CONFIRMED**

- **Evidence:** `/Users/pt/cat-code/src/utils/permissions/PermissionPromptToolResultSchema.ts:65-72` accepts an unbounded string; `/Users/pt/cat-code/app/sidecar/sidecarServer.ts:2385-2388` returns it unchanged. The only effective limit is the 128 KiB frame cap.
- **Trigger/cost:** One valid pending permission can receive an approximately 128 KiB denial that enters the engine decision/model context, unnecessarily consuming context and widening an intended feedback channel.
- **Correction:** It is not repeatable at 120 accepted responses per second for one request: `/Users/pt/cat-code/src/app-runtime/AppSessionController.ts:95-107` synchronously deletes the pending ID on the first response. It also grants no new privilege because the renderer can already deny and submit prompts.
- **Disposition:** Reject denial messages over `MAX_TEXT_FIELD_CHARS` at the sidecar, leaving the request pending, and add a boundary test. Do not silently truncate hostile inbound input.

### 8. [LOW] Hardening checks are conditionally vacuous
**Classification: OVERSTATED**

- **Evidence:** `/Users/pt/cat-code/app/scripts/hardening-smoke.ts:289-296` records the render marker separately from three execution flags. If rendering fails, those flags can print `PASS`; however, `:378-391` still counts the failed marker and exits non-zero.
- **Trigger/cost:** Output can show one decisive failure beside three weakly reassuring lines, but the suite cannot falsely pass.
- **Disposition:** No sidecar test belongs in this renderer/Electron harness. Optionally make those lines dependent/skipped and relabel the summary with its renderer/main scope, as A20 already recommends. This is diagnostic clarity, not a sidecar security remediation.

## Counts

| Classification | HIGH | MED | LOW | Total |
|---|---:|---:|---:|---:|
| CONFIRMED | 0 | 1 | 1 | 2 |
| PARTIALLY CONFIRMED | 1 | 1 | 1 | 3 |
| DUPLICATE/DEPENDENT | 0 | 1 | 1 | 2 |
| OVERSTATED | 0 | 0 | 1 | 1 |
| STALE/ALREADY FIXED | 0 | 0 | 0 | 0 |
| INVALID | 0 | 0 | 0 | 0 |
| **Original totals** | **1** | **3** | **4** | **8** |

## Prioritized confirmed remediation

1. Decide and enforce or explicitly accept the direct-connect egress policy, with one shared owner for A02/A11.
2. Redact and bound engine-derived failure text on result/progress frames.
3. Harden socket-directory ownership and modes without treating path randomness as peer authentication or breaking orphan cleanup.
4. Make the context-breakdown cooldown apply to null attempts and test that branch.
5. Add the sidecar rate-cap test and correct the fixed/sliding terminology.
6. Add the `dispatch` exhaustiveness tripwire and reject oversized permission-denial messages.
