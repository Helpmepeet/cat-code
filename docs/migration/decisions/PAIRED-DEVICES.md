# D3 — Paired devices: back it or cut it

**Status: ARCHITECTURE RULED 2026-07-04 — PRODUCT CALL PENDING OPERATOR.** This rules the
architecture half of INVENTORY's D3 (the paired-device roster/wizard on the RemoteSettings
surface, `RemoteSettings.jsx`) and surfaces the product half for the operator. The row stays
open until the operator answers §4. All anchors verified against the working tree 2026-07-04;
where this doc and source disagree, source wins.

| # | Question | Verdict |
|---|---|---|
| **P1** | Is there a paired-device model in source? | **NO.** The prototype admits it (`RemoteSettings.jsx:36-38`: "no single 'paired devices' store upstream — this is a prototype convenience roster"). The only "paired device" in the tree is the Chrome-extension pairing record — a single `{pairedDeviceId, pairedDeviceName}` under `chromeExtension` (`src/utils/config.ts:530-533`, consumed `src/utils/claudeInChrome/mcpServer.ts:119-127`) — one browser pairing for claude-in-chrome, not a remote-client roster. Nothing to revoke against, no device identity, no per-device authz. |
| **P2** | What IS real underneath? | Three separate remote paths, none of which model devices: **(a)** Remote Control bridge (`src/hooks/useReplBridge.tsx`, `src/bridge/initReplBridge.ts`, `AppState.replBridgeEnabled`) with the inbound command filter (`BRIDGE_SAFE_COMMANDS` / `isBridgeSafeCommand`, `src/commands.ts:676-700`); **(b)** remote sessions (`src/remote/RemoteSessionManager.ts`); **(c)** direct-connect (`createDirectConnectSession`, `src/server/createDirectConnectSession.ts:26` — POST `{serverUrl}/sessions` + WS config; client hook `src/hooks/useDirectConnect.ts:39`; `src/server/directConnectManager.ts`). The wizard's SSH/proxy tabs also cite real substrate (`src/upstreamproxy/upstreamproxy.ts` exists) but are config surfaces, not device pairing. |
| **P3** | Architecture ruling | **The roster/wizard is prototype invention over real connection primitives.** Whatever the operator decides in §4, the v1-buildable surface without new models is: bridge on/off + status (real flag), the command filter rendered as read-only truth from `BRIDGE_SAFE_COMMANDS` (not a copied list), and a direct-connect form that calls the real `createDirectConnectSession`. The viewer/control `RemoteRolePill` has no per-client backing either — roles are not modeled per connection in source. |
| **P4** | Is "build the backing model" decided here? | **NO — explicitly not.** A device registry is new trust-plane state (identity, token issuance, revocation) adjacent to the secret owner. That is a product+security decision for the operator (§4), never a fait accompli in this doc. |

---

## 1. Recon detail

- The prototype roster (`MOCK_PAIRED_DEVICES`, `RemoteSettings.jsx:39-43`) carries
  name/kind/role/connected/last-seen/revoke — none of these fields exist anywhere in `src/`.
  A full-tree search for paired-device state found only the Chrome-extension pairing
  (`config.ts:530-533`), which is a different feature (one browser, no roster, no roles).
- The bridge publishes this process as a worker; clients attach through the bridge
  environment. There is no persisted list of *who* attached, no revocation primitive — turning
  the bridge off is the only "revoke everyone."
- Direct-connect is outbound (this app connecting to another cat-code server), so it is not
  even the same trust direction as "devices that can drive me" — the prototype's single panel
  fuses an inbound-authz story onto an outbound-connection primitive. The prototype's own
  header warns not to collapse the three paths (`RemoteSettings.jsx:5-14`); the roster does
  exactly that collapse.

## 2. Cost of each path (for the operator's call)

- **Cut down to the real surface (recommended):** bridge toggle + status, read-only command
  filter, direct-connect form. Cost ≈ one Phase-4 session; zero new models; zero new security
  surface beyond rendering existing state.
- **Build the backing model:** a device-identity store (issue + persist per-client identity),
  role assignment (viewer/control), revocation that actually severs a live connection, and a
  SECURITY-MINIMUM addendum (this is inbound control of a command-executing engine — T-class
  review mandatory, same rigor as T8/HC1–HC4). Cost ≈ a design decision + multiple sessions +
  a standing security liability. None of it exists upstream to adapt.

## 3. Recommendation (architecture's lean)

**Cut for v1.** The roster answers a question ("which devices can drive my agent, and how do I
revoke one?") that the product cannot yet pose: the bridge has no per-client identity to hang
it on. Building identity/revocation to justify a settings panel inverts the dependency —
if/when a real multi-client remote story ships (D6 v2 daemon, phone client), the device model
should be designed against *that* control plane (DR-4 discipline: design it once, on the real
API), not against a mock panel. Until then the honest UI is bridge state + filter truth +
direct-connect — all real today.

## 4. Product question for the operator (blocks closing this row)

> **Is per-device visibility/revocation a product requirement worth building a new
> identity/authz model now** (accepting §2's cost and a security-review obligation), **or does
> RemoteSettings cut down to the real surface** (bridge toggle/status + command filter +
> direct-connect form) **until the v2 always-on/multi-client milestone makes a device model
> meaningful?**
>
> Recommendation: cut down (option 2). If the operator picks option 1, the deliverable is a
> design decision doc + SECURITY-MINIMUM addendum first, not UI work.

> **✅ OPERATOR RULING 2026-07-04: cut to the real surface (option 2).** v1 RemoteSettings =
> bridge toggle/status + read-only command-filter truth + direct-connect form; no device
> identity/authz model. Deferred to the v2 always-on/multi-client milestone. This row is now
> CLOSED — Phase-4 RemoteSettings unblocked at cut scope.

## 5. Pressure test

- **"The Chrome-extension pairing proves a pairing store exists — extend it."** It is a
  single-record convenience for one browser extension, with no roles, no roster, no
  revocation semantics beyond overwrite (`mcpServer.ts:119-127`). Extending it into a remote
  trust plane would put inbound-control authz in a casual config corner — wrong home, wrong
  rigor. The counter fails.
- **"Without a roster the operator can't see who's attached — that's a security hole shipped
  by cutting."** The hole exists upstream today (the TUI bridge has the same blindness), so
  cutting preserves parity rather than regressing it; and the *visible* mitigations (bridge
  off by default, filter truth rendered honestly) survive the cut. The counter argues for the
  product feature — which is exactly why §4 sends it to the operator instead of burying it.
- **"You're deciding the product question by recommending."** The recommendation is
  labeled as a lean; the row stays open, nothing gets built either way until the operator
  rules, and the doc explicitly prices both paths (§2).

## 6. Carry-forwards

- If v2 (daemon / multi-client, `SESSION-LIFETIME.md` L4) arrives, device identity becomes a
  control-plane concern — design it against the host API surface (`REGISTRY.md` §6.1, DR-4
  watch-item), and revisit this doc then.
- The W4 RemoteSettings Phase-4 row should be generated per §3's cut-down scope unless the
  operator rules otherwise; `RemoteRolePill` survives only as a *label* where a real role
  exists (remote-session viewer/controller distinction, `RemoteSessionManager.ts`), not as a
  per-device control.
