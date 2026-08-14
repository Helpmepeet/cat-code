# Accounts Page Anti-Potemkin Data-Truth Cold Review

**Date:** 2026-08-14  
**Scope:** `app/renderer/src/AccountsPage.tsx`, `app/renderer/src/AccountsPage.test.tsx`, `app/renderer/src/accountsPageModel.ts`, `app/renderer/src/accountsState.ts`, `app/shared/protocol.ts`  
**Reviewer:** Antigravity (unsparing, adversarial cold review)  
**Final Verdict:** **GREEN** (Strict Source-Grounded Anti-Potemkin Data-Truth Confirmed)

---

## 1. Executive Summary & Verdict

| Review Lane | Status | Summary |
|---|:---:|---|
| **Contract Conformance** | **PASS** | Follows P4-5 / #14 specification, `STATUS.md` line 63 (CC-20), `PARITY-LEDGER.md` (rows 1065–1086), and `CLAUDE.md` §0. |
| **Anti-Potemkin Audit** | **PASS** | ZERO fake, hardcoded, simulated, or Potemkin usage data, fake SVG graphs, or fabricated history anywhere in `AccountsPage.tsx` or `app/renderer/src/`. |
| **Untracked File Elimination** | **PASS** | All untracked/fake files (`AccountsCharts.tsx`, `AccountsUsageSection.tsx`, `accountsUsageModel.ts`, `accountsUsageModel.test.ts`) are 100% absent from workspace and unreferenced. |
| **Live Wire IPC & Snapshot Truth** | **PASS** | 100% of data rendered connects directly to live redacted fields in `AccountsSnapshot` and real wire IPC verbs via `onVerb`. |
| **Account Lifecycle Integrity** | **PASS** | All dialogs (`AddAccountDialog`, `TouchAllDialog`, `RenameAccountDialog`, `DeleteAccountDialog`, `LogoutAccountDialog`), menus, and pool rows are intact, undamaged, and tested. |
| **Fast Refresh & Linting** | **PASS** | TSX exports React components only (`fastRefreshBoundaries.test.ts` passes); TypeScript and ESLint pass with 0 errors. |
| **Automated Test Battery** | **PASS** | 22/22 tests pass in `AccountsPage.test.tsx`; 1,980/1,980 tests pass across `app/renderer/src`. |

**Verdict: GREEN.** The Accounts page strictly adheres to the repository's Anti-Potemkin doctrine. Deferred usage-analytics features are explicitly declared and withheld rather than faked with Potemkin data.

---

## 2. Established Contract & Invariants

1. **Anti-Potemkin Rule (`CLAUDE.md` §0 & `.agents/skills/cat-code-cold-review`):**
   - No mock data or synthetic graph generation may stand in for missing backend sources. If a data source does not exist on the wire, the feature must be explicitly deferred rather than faked.
2. **`STATUS.md` line 63 (CC-20):**
   - Accounts is a host-plane read driven by `accountsPoolWorker` / `accountsPoolRunner` emitting `accounts-pool` host events (60s interval) into `accountsState.ts`.
   - Explicitly records that the prototype's usage-analytics half (4-column stat grid, time-series charts, 7d/30d toggles, breakdowns) does NOT exist on the desktop wire (`AccountStatus` carries only current window used-percent, not token history) and is deferred.
3. **`PARITY-LEDGER.md` (rows 1065–1086):**
   - Rows 1065–1079, 1081–1086 are cataloged as `⬜ deferred — blocked-on-seam / owner-flagged`.
   - Row 1080 (`HeadroomBar`) is `✅ built (P4-5)`.
4. **Data-Gap Fidelity (`AccountsPage.tsx:24-28`):**
   - Wire protocol `AccountStatus` exposes a single `usageResetAt` (the primary 5h window). The ↺ reset indicator is rendered only on the 5h bar and intentionally left blank on the weekly bar.
5. **No Optimistic UI & Strict IPC Correlation (`AccountsPage.tsx:29-33`):**
   - Dialogs dispatch verbs via `onVerb` with unique `requestId`s and only close/toast upon arrival of matching `account.result` (`lastResult`).

---

## 3. Detailed Audit Findings & Evidence

### 3.1 Anti-Potemkin & Fake Data Sweep
- **SVG / Canvas Graphics Search:** Rigorous regex search for `<svg`, `<canvas`, `<polyline`, `<path`, `<rect` in `AccountsPage.tsx` returned **0 results**.
- **Mock Token History / Synthetic Series Search:** Zero mock arrays, synthetic token counts, random number generators, or placeholder graphs exist in `AccountsPage.tsx` or any `app/renderer/src/` module.
- **Untracked File Elimination Verification:**
  - `app/renderer/src/AccountsCharts.tsx`: **ABSENT**
  - `app/renderer/src/AccountsUsageSection.tsx`: **ABSENT**
  - `app/renderer/src/accountsUsageModel.ts`: **ABSENT**
  - `app/renderer/src/accountsUsageModel.test.ts`: **ABSENT**
  - Entire repo grep for these symbol and file names returned **0 matches**.

### 3.2 Live Wire IPC Seam & Snapshot Data Truth
Every rendered element maps 1-to-1 with typed `AccountsSnapshot` fields:

| UI Component / Element | Data Source (`protocol.ts` / `AccountsSnapshot`) | Wire IPC Verb / Seam | Verified Behavior |
|---|---|---|---|
| **Active Headroom (5h & Weekly)** | `AccountStatus.usagePrimary`, `AccountStatus.usageWeekly`, `AccountStatus.usageResetAt` | N/A (read-only snapshot) | Renders exact percentages; 5h renders `↺ in Xm` via `formatResetLabel`, weekly is blank. Width inline style strictly isolated to bar fill percentage. |
| **Cap Banner** | `AccountStatus.status === 'capped' \|\| account.usageLimitReached` | `account.switch` (`switchVerb`) | Displays capped account alias, offers instant switch to next available switchable account, or shows reset label. |
| **Anthropic Pool Section** | `AccountsSnapshot.anthropicAccounts`, `anthropicReadyCount`, `anthropicPoolCount`, `anthropicRouteAvailable` | `account.login` (`loginVerb('anthropic')`), `account.switch` (`switchVerb(id, 'anthropic')`) | Renders honest status ("route configured" vs "N of M ready"); displays healthy/dead status dots, subscription types, and switch affordance. |
| **Codex Pool Section** | `AccountsSnapshot.accounts`, `readyCount`, `poolCount` | `account.touchAll` (`touchAllVerb`), `account.login` (`loginVerb('openai')`) | Hero row for active account (`isDefault`), followed by pool accounts. |
| **PoolRow Dot & Label** | `statusDotTone(account)` (pink for default, danger for capped, warn for dead/pressured, good for healthy) | N/A | Dot carries pink active glow; Label tone is strictly decoupled to reflect true underlying status (`statusLabelTone`). |
| **PoolRow Headroom Bars** | `account.usagePrimary`, `account.usageWeekly`, `account.usageResetAt` | N/A | Rendered for healthy accounts; non-healthy capped accounts render reset text. |
| **Row Action Menu (`⋯`)** | `selectAccountMenuItems(account)` | Dispatches to dialog or `account.switch` | Gated on `switchable`, `hasVaultProfile`, `isDefault`. |

### 3.3 Lifecycle Dialogs & Wire Verbs
All dialog implementations are 100% wired to real protocol verbs with asynchronous request correlation:

1. **`AddAccountDialog` (`AccountsPage.tsx:240-286`):**
   - Submits `loginVerb('openai')` (`type: 'account.login'`, `provider: 'openai'`).
   - Explains OAuth localhost `127.0.0.1:1455` capture; transitions to spinner state upon authorization initiation.
2. **`TouchAllDialog` (`AccountsPage.tsx:408-482`):**
   - Submits `touchAllVerb()` (`type: 'account.touchAll'`).
   - Correlates with incoming `lastResult.touchAllResults` and displays live per-account token refresh outcomes (`OK` in green, `LOCKED` in grey, `FAILED` in red).
3. **`RenameAccountDialog` (`AccountsPage.tsx:288-336`):**
   - Validates alias using `renameError` (1–32 alphanumeric chars, `-`, `_`, uniqueness against `takenAliases` excluding current).
   - Submits `renameVerb(id, alias)` (`type: 'account.rename'`).
4. **`DeleteAccountDialog` (`AccountsPage.tsx:338-375`):**
   - Warns user if deleting the active default account with/without alternative switchable accounts (`selectHasOtherSwitchable`).
   - Submits `deleteVerb(id)` (`type: 'account.delete'`, `confirm: true`).
5. **`LogoutAccountDialog` (`AccountsPage.tsx:377-406`):**
   - Submits `logoutVerb()` (`type: 'account.logout'`).
6. **No Leaky Engineering Vocabulary (`CLAUDE.md` §7):**
   - `WaitingState` renders `"Loading accounts…"`. Tests verify it contains none of `sidecar`, `prototype`, `redacted`, or `snapshot`.

---

## 4. Test & Verification Battery Execution

The complete test battery was executed on the local system with the following results:

### 1. `AccountsPage.test.tsx` Unit & Integration Suite
```bash
bun test app/renderer/src/AccountsPage.test.tsx
```
**Result:** ✅ **22 pass, 0 fail (77 assertions, 36.00ms)**
- Pool rows & ready label rendering from snapshot
- Menu gating on `switchable`, `hasVaultProfile`, and `isDefault`
- `switchVerb` & `loginVerb` multi-provider construction
- Redacted Anthropic pool rendering & honest route fallback
- `deleteVerb` with `confirm: true`
- Null snapshot waiting state without internal vocabulary leakage
- `resultToastTone` mapping
- Cap banner rendering & reset formatting
- Status dot & label tone decoupling (preventing pink label regression)
- Precedence handling for default+capped accounts
- Single `usageResetAt` handling (5h active, weekly blank)
- `renameError` alias validation rules

### 2. Full Renderer Test Suite
```bash
bun test app/renderer/src
```
**Result:** ✅ **1,980 pass, 0 fail (6,865 assertions, 123 files, 839.00ms)**

### 3. Fast Refresh Boundary Compliance
```bash
bun test app/renderer/src/fastRefreshBoundaries.test.ts
```
**Result:** ✅ **1 pass, 0 fail (53.67ms)**
- `AccountsPage.tsx` exports only React components (`AccountsPage`). Model logic and pure functions reside in `accountsPageModel.ts` and `accountsState.ts`.

### 4. TypeScript Strict Compilation
```bash
./node_modules/.bin/tsc --noEmit -p app/tsconfig.json
```
**Result:** ✅ **0 errors (Exit code 0)**

### 5. ESLint Static Analysis
```bash
./node_modules/.bin/eslint "app/renderer/src/**/*.tsx"
```
**Result:** ✅ **0 errors, 0 warnings (Exit code 0)**

---

## 5. Findings Table

| ID | Severity | Description | Evidence Anchor | Disposition |
|---|:---:|---|---|---|
| — | — | *No findings identified during this audit.* | `app/renderer/src/AccountsPage.tsx` | Clean |

---

## 6. Cold Review Conclusion

The current state of `app/renderer/src/AccountsPage.tsx` and its supporting modules represents an exemplary realization of data truth and the Anti-Potemkin rule:
- All rendered data derives from authentic backend snapshot streams.
- Missing upstream time-series data is cleanly acknowledged and deferred without fabricating visual charts.
- All IPC verbs, lifecycle dialogs, and menu interactions operate under strict asynchronous correlation.
- The entire testing and verification battery is 100% green.

**Final Audit Verdict:** **GREEN**
