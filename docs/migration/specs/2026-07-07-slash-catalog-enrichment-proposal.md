# Slash-catalog enrichment — read-only catalog-snapshot frame (PROPOSAL)

**Status: PROPOSAL, 2026-07-07. NOT blocking P3-7.** Branch `migration`. This is the
`extend-engine-vs-change-UI` decision the P3-7 CONFLICT CHECKPOINT asked to flag. Written to
the C3 (`decisions/PERMISSION-BOUNDARY.md` §4 `permission.context`) precedent so the operator
can decide it later, in isolation. **P3-7 shipped WITHOUT this** — the SlashCommandPicker is
already wired and functional on command names; this only adds richer per-command metadata.
Where this doc and source disagree, **source wins**.

## What P3-7 already does (no new vocabulary)

The desktop session's real command catalog is `getCommands(cwd)` (`src/commands.ts:501`). The
sidecar now loads it (was `commands: []`) and it feeds the EXISTING outbound `system/init`
frame's `slash_commands: string[]` field (`src/utils/messages/systemInit.ts:69`, filtered to
`userInvocable !== false`; emitted `src/QueryEngine.ts:598`). The renderer captures it per
session (`transcriptProjector.ts` `selectSlashCommands`) and the picker does prefix/substring
typeahead over it. **Insertion/execution rides the existing `app.submit`** — no
command-execution capability is added to the renderer. This required **zero new wire
vocabulary**.

## The gap

`slash_commands` carries **names only**. The prototype `SlashCommandPicker.jsx` /
`CommandPalette.jsx` also show, per command: `description`, `argumentHint`, a `source` badge
(built-in / skill / plugin / mcp / workflow), a `kind: 'workflow'` badge, and
disabled-with-reason rows (e.g. bridge-filtered `local-jsx` commands). All of that lives on the
engine-side `Command` / `CommandBase` object (`src/types/command.ts:180-208`) but is **not on
the wire today**. So the picker is name-only until this metadata is surfaced.

## Why a new frame (not a change to `slash_commands`)

`slash_commands: string[]` is a **shared, engine-owned SDK type** (`system/init`,
`coreSchemas.ts:1504`, consumed by print-mode and the REPL Remote Control bridge). Widening it
to objects is an engine-graph type change with blast radius beyond the desktop app — the same
reason F3 §6 R2 kept `ReadyFrame` (app-owned) as the change site rather than widening the
shared `AppReadyPayload`. So enrichment should be an **app-owned, additive, read-only outbound
frame**, exactly like C3's `permission.context`.

## Proposed frame (sketch — decide before building)

- **Kind:** outbound-only `catalog.snapshot` (app-owned; NOT a new *inbound* type — the T2/§2
  posture is untouched, the renderer still only submits text via `app.submit`).
- **When:** emitted once per session after `init()` resolves the catalog (same lifecycle slot
  as the ready frame's `engineSessionId`), and on `/reload-plugins`-class catalog changes.
- **Payload:** `{ commands: Array<{ name; description; argumentHint?; source; kind?;
  userInvocable; disabled?; disabledReason? }> }` — a projection of the engine `Command`
  objects, **redacted to display fields** (no `load()` fns, no hooks, no skill roots).
- **Boundary rules (unchanged posture):** outbound-only, per-frame `secretGuard` +
  JSON-safe assert + `MAX_OUTBOUND_FRAME_BYTES` cap (a large plugin catalog must not exceed
  it — cap + truncate-with-flag, like the F2 history replay budget); no inbound vocabulary; the
  sidecar-local allowlist + `checkStrictKeys` additive pattern E-7 blesses.
- **Renderer:** the picker/palette upgrade from names to rich rows; disabled rows render with
  their reason (the prototype's real `isBridgeSafeCommand` filtering, `src/commands.ts:697`).

## Recommendation

**Defer.** The name-only picker is a real, usable feature; the enrichment is polish. When W4's
richer composer work opens (which the P3-7 build note defers richer behavior to), decide this
frame then, alongside any other outbound catalog needs, rather than minting a one-off frame
now. If adopted earlier, it is a self-contained additive change with an owning session.
