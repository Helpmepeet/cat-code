# CatCode desktop-app migration

Coordination hub for migrating CatCode from the Ink terminal REPL to a dedicated
Electron desktop app. The app code lives in [`app/`](../../app/); these docs plan and
track that work. Moved here from the prototype repo (`catcode_prototype/audit/migration/`)
on 2026-07-02 now that the production code lives in this repo.

## Start here

- **[STATUS.md](STATUS.md)** — single source of truth for "what's done." Read this first.
- **[PROGRAM-PLAN.md](PROGRAM-PLAN.md)** — the phased plan (Phases 0–5) and how sessions are generated.
- **[INVENTORY.md](INVENTORY.md)** — what exists in the prototype/engine to migrate (surface-level).
- **[PARITY-LEDGER.md](PARITY-LEDGER.md)** — *(CC-1 ✅ landed 2026-07-07 — 1,894 rows, 126 ❓ danger items)* element/UX-state + flow coverage across all 30 prototype surfaces + 8 flows, disposition-tagged; the "nothing silently dropped" instrument + the Phase-4 parity-gate measure (Part D).

## Layout

| Folder | Contents |
|---|---|
| (root) | `STATUS`, `PROGRAM-PLAN`, `INVENTORY`, `PARITY-LEDGER` (CC-1) — the living canonical docs |
| [`decisions/`](decisions/) | Locked, load-bearing decision records — see the list below |
| [`specs/`](specs/) | Focused design specs feeding specific sessions (streaming, permission-update, GUI harness, slash-catalog) |
| [`reviews/`](reviews/) | Dated point-in-time reviews — archival, not edited after the fact |
| [`backlog/`](backlog/) | Active per-phase session backlogs (`phase0-1.md`, `phase3.md`, `phase4.md`) |
| [`process/`](process/) | Live how-to scaffolding: `GUI-VERIFICATION.md` (the only current process doc) |

`MIGRATION-DOMAINS.md` and `MIGRATION-STRATEGY.md` are earlier strategy notes carried over
from the prototype's `audit/` root; they partly predate and overlap `PROGRAM-PLAN` /
`INVENTORY` and should be reconciled into them (or retired) as a follow-up.

## Decision records (`decisions/`)

Locked unless a status line inside the doc says otherwise. Grouped by the phase that produced them.

**Foundational (Phases 0–2, locked):**
- `TRANSPORT.md` — P0-1: Electron + Bun sidecar, per-session Unix socket, raw `SDKMessage` (the topology bake-off).
- `SECURITY-MINIMUM.md` — P0-5: renderer threat model, default-deny IPC allowlist, engine-only secrets (T4/T5a/T6/T7, HC1–HC4).
- `SEAM-SPIKE.md` / `SHELL.md` — the original seam + shell spikes; **historical reference**, superseded by `PROGRAM-PLAN`/`TRANSPORT` where they disagree.
- `PERMISSION-BOUNDARY.md` — C1–C4: how the rich permission protocol crosses the sidecar (feeds P2-4).

**Phase-3 pre-work (decided + implemented):**
- `REGISTRY.md` — D1: the desktop session registry (spawn / multiplex / persist / restore).
- `SESSION-LIFETIME.md` — D6: sessions die with the window (v1); the quit/relaunch-restore gate line.
- `PROTOCOL-ENVELOPE.md` — F3: v1 envelope sufficiency for N-session multiplexing + additive gaps.
- `RESTORE-HISTORY.md` — F2: replay-on-attach; the one wire change restored history required.

**Phase-4 pre-work:**
- `AGENT-CHROME.md` — D2: which Agent-Mode chrome survives (DECIDED).
- `PAIRED-DEVICES.md` — D3: back paired devices or cut them (**product call pending operator**).
- `STARTUP-GATES.md` — D4: are the startup GUI gates real requirements (**product call pending operator**).
- `WELCOME-LAUNCHER.md` — D5: does welcome-launcher state persist (**product call pending operator**).

## Where the code is

- Scaffold + walking skeleton: [`app/`](../../app/)
- The P1-0 scaffold review that gated P1-1: [`reviews/2026-07-02-p1-0-desktop-scaffold-review.md`](reviews/2026-07-02-p1-0-desktop-scaffold-review.md)
</content>
</invoke>
