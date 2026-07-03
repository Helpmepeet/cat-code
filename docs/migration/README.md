# CatCode desktop-app migration

Coordination hub for migrating CatCode from the Ink terminal REPL to a dedicated
Electron desktop app. The app code lives in [`app/`](../../app/); these docs plan and
track that work. Moved here from the prototype repo (`catcode_prototype/audit/migration/`)
on 2026-07-02 now that the production code lives in this repo.

## Start here

- **[STATUS.md](STATUS.md)** — single source of truth for "what's done." Read this first.
- **[PROGRAM-PLAN.md](PROGRAM-PLAN.md)** — the phased plan (Phases 0–5) and how sessions are generated.
- **[INVENTORY.md](INVENTORY.md)** — what exists in the prototype/engine to migrate.

## Layout

| Folder | Contents |
|---|---|
| (root) | `STATUS`, `PROGRAM-PLAN`, `INVENTORY` — the living canonical docs |
| [`decisions/`](decisions/) | Locked, load-bearing decision records: `TRANSPORT`, `SECURITY-MINIMUM`, `SHELL`, `SEAM-SPIKE` |
| [`reviews/`](reviews/) | Dated point-in-time reviews — archival, not edited after the fact |
| [`backlog/`](backlog/) | Active per-phase session backlogs (`phase0-1.md`) |
| [`process/`](process/) | How-to scaffolding: `HANDOFF`, `REVIEW-PROMPT` |

`MIGRATION-DOMAINS.md` and `MIGRATION-STRATEGY.md` are earlier strategy notes carried over
from the prototype's `audit/` root; they partly predate and overlap `PROGRAM-PLAN` /
`INVENTORY` and should be reconciled into them (or retired) as a follow-up.

## Where the code is

- Scaffold + walking skeleton: [`app/`](../../app/)
- The P1-0 scaffold review that gated P1-1: [`docs/reviews/2026-07-02-p1-0-desktop-scaffold-review.md`](../reviews/2026-07-02-p1-0-desktop-scaffold-review.md)
</content>
</invoke>
