# RAM-0 measurement session — raw results (2026-07-21)

Instrumented, re-runnable memory measurement of the desktop **sidecar** engine
process, discharging the RAM-0 obligation in
`docs/migration/reviews/2026-07-21-app-cutlist-ram-audit.md` §RAM-0 / Part V.
The predecessor numbers (cut-list §RAM-1, PER-SESSION-COST) were single-run
SCRATCH scripts that were never retained (audit finding F1). This session checks
in the instrument and the raw output.

**Scope of THIS session (bounded):** the account-free cohorts only —
(1) cache-hit preview no-engagement and (2) fresh-spawn attached-idle (boot floor
+ catalog-refresh plateau), incl. the enrich-volume A/B and the
`MIMALLOC_PURGE_DELAY=0` A/B. Cohorts (3) one turn, (4) restored large
transcript, (5) long-lived multi-turn are **PARKED** — they need real LLM
turns/accounts (see §Parked). No real accounts/vaults/tokens, no LLM calls, no
GUI, no shared-tree writes.

## Instrument (committed, hermetic, no secrets)

| File | Role |
|---|---|
| `app/scripts/ram-corpus-gen.ts` | Deterministic synthetic transcript corpus generator (seeded; no `Math.random`/`Date.now`/`crypto.randomUUID`). |
| `app/scripts/ram-probe.ts` | Spawns ONE sandboxed sidecar, samples RSS + physical footprint over a dwell, records every PID, kills + verifies (`ps -p`) on exit. |
| `app/scripts/ram-measure.ts` | Drives the cohort matrix: ≥3 reps, median+range, counterbalanced (rotated) condition order; each run an isolated child process. |
| `docs/migration/reports/ram0-raw/` | Retained raw `ps`/`vmmap` captures + `ram0-aggregate.json` + machine-pressure snapshot. |

Re-run:
```
bun run app/scripts/ram-corpus-gen.ts --out <cfg600> --sessions 600 --dirs 30 --seed 42 --min-bytes 160000 --clean
bun run app/scripts/ram-corpus-gen.ts --out <cfg50>  --sessions 50  --dirs 10 --seed 42 --min-bytes 160000 --clean
mkdir -p <cfgEmpty>/projects
bun run app/scripts/ram-measure.ts --out docs/migration/reports/ram0-raw \
  --reps 3 --dwell-ms 240000 --sample-ms 30000 \
  --corpus50 <cfg50> --corpus600 <cfg600> --empty <cfgEmpty>
```

## Pinned feature manifest (ruling #1 predecessor)

The audit makes ruling #1 (feature set for the sidecar) a **strict predecessor**
for any *shipping-target* measurement, and requires the exact sorted manifest be
recorded here BEFORE sampling.

**Manifest measured = ENABLED FEATURES: ∅ (empty set).** VERIFIED empirically:
the sidecar runs via plain `bun run app/sidecar/index.ts`, and `feature()` from
`bun:bundle` evaluates to `false` for every name under plain `bun run` (only the
bundler `scripts/build.ts` bakes any in). Confirmed by direct probe — even the
bundle defaults `TRANSCRIPT_CLASSIFIER` and `VOICE_MODE` return `false`. This
directly corroborates the audit's Part IV feature-gate drift note.

The full set of feature NAMES that exist and are all OFF in this configuration
(`scripts/build.ts:13-50` + defaults, sorted): `AGENT_MEMORY_SNAPSHOT`,
`AGENT_TRIGGERS`, `AGENT_TRIGGERS_REMOTE`, `AWAY_SUMMARY`, `BASH_CLASSIFIER`,
`BRIDGE_MODE`, `BUILTIN_EXPLORE_PLAN_AGENTS`, `CACHED_MICROCOMPACT`,
`CCR_AUTO_CONNECT`, `CCR_MIRROR`, `CCR_REMOTE_SETUP`, `COMPACTION_REMINDERS`,
`CONNECTOR_TEXT`, `EXTRACT_MEMORIES`, `HISTORY_PICKER`, `HOOK_PROMPTS`,
`KAIROS_BRIEF`, `KAIROS_CHANNELS`, `LODESTONE`, `MCP_RICH_OUTPUT`,
`MESSAGE_ACTIONS`, `NATIVE_CLIPBOARD_IMAGE`, `NEW_INIT`, `POWERSHELL_AUTO_MODE`,
`PROMPT_CACHE_BREAK_DETECTION`, `QUICK_SEARCH`, `SHOT_STATS`, `TEAMMEM`,
`TOKEN_BUDGET`, `TRANSCRIPT_CLASSIFIER`, `TREE_SITTER_BASH`,
`TREE_SITTER_BASH_SHADOW`, `ULTRAPLAN`, `ULTRATHINK`, `UNATTENDED_RETRY`,
`VERIFICATION_AGENT`, `VOICE_MODE`.

Per audit ruling #1, "today's ALL-gates-OFF config IS the shipping target": these
numbers are therefore labeled the **current-featureless configuration** — the
only configuration that satisfies RAM-0 today. Any future named-manifest cohort
requires the operator to finalize + record that manifest here before sampling.

## Protocol

- **Metrics:** RSS (`ps -o rss=`) AND macOS physical footprint + peak
  (`vmmap --summary`, "Physical footprint:" / "(peak):"). Footprint ≈ the
  private-dirty + compressed real memory the audit's F1 asks for; RSS reported
  alongside. Every raw capture retained under `ram0-raw/`.
- **Reps:** ≥3 per condition; report **median [min–max]**.
- **Counterbalanced order:** condition order rotated per rep (`ram-measure.ts`
  `rotate()`), so machine-pressure drift cannot systematically bias one
  condition. The exact executed order is recorded in `ram0-aggregate.json`
  (`runOrder`) and echoed in §Results.
- **Sandbox (account-free, hermetic):** fresh `CLAUDE_CONFIG_DIR` under worktree
  scratch (config home + credential vault both key off it, `envUtils.ts:15`);
  credential env vars deleted → keyless boot; network poisoned (HTTP(S)/ALL
  proxy → `127.0.0.1:9` closed, + `DISABLE_AUTOUPDATER`,
  `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`, `CI`); idle-TTL disabled so the
  janitor never reaps mid-measurement.
  - **Keyless-boot artifact (recorded):** with no key, the slash-command catalog
    fails to build ("session runs without slash commands"), so that subsystem is
    absent from these numbers — a small, honest reduction vs a keyed boot. The
    **sessions catalog** (the RAM-3.1 lever under study) enumerates normally.
- **Boot floor** sampled pre-attach (after a settle delay past module-graph +
  `init()` + controller construction). **Attached plateau** sampled after a bare
  socket attach (which kicks the first enumeration, `sidecarServer.ts:588`) then
  every `sample-ms` across the dwell; the 30s catalog re-enumeration
  (`sidecarServer.ts:449`, no-op unless attached `:2314-2316`) drives the
  allocator toward its high-water.
- **Machine-pressure note:** captured in `ram0-raw/machine.txt` at run time
  (hw.memsize, ncpu, load average, vm_stat). Summarized in §Results.

## Corpus recipe (retained, deterministic)

Real-shaped transcripts under `<cfg>/projects/<sanitized-cwd>/<uuid>.jsonl`,
enrichable by the SAME loader `/resume` uses
(`loadAllProjectsMessageLogsProgressive`, `src/utils/sessionStorage.ts:4476`).
Each file ≥ ~157KB so the 64KB head AND tail windows (`LITE_READ_BUF_SIZE`) are
full and disjoint; head carries `cwd`/`gitBranch`/first user prompt, tail carries
`lastPrompt`/`customTitle`/`summary`/`tag`/PR fields/last `timestamp`.
Enrichment verified: a 5-session smoke corpus enriched to 5 fully-populated rows
(title, firstPrompt, gitBranch, cwd, tag, prNumber, modified all present).

- **600-session corpus** (enrich=600 arm): 600 sessions / 30 dirs / seed 42 /
  ≥157KB per file (≈94 MB). Realizes "enrich=600" at the fixed shipping limit.
- **50-session corpus** (enrich=50 arm): 50 sessions / 10 dirs / seed 42
  (≈8 MB). Realizes "enrich=50".
- **Enrich-A/B method note (no engine edit):** `SESSIONS_CATALOG_ENRICH_LIMIT`
  (`app/sidecar/sessionsCatalogDomain.ts:62`) is a module const, not env-driven;
  enumeration enriches `min(limit, discovered)`. We vary enrichment VOLUME by
  corpus size at the fixed limit of 600 — measuring the audit's 278-vs-467
  question without changing shipping behavior. The strict interim-knob A/B
  (limit varied on a fixed large corpus) additionally needs a source test-seam
  and is PARKED (§Parked).
- Scale note vs audit's "60 dirs / ~1,800 files / ~1 GB": enrichment reads are
  capped at ≤2×64KB per file, so files > 128KB cost the same to enrich; a
  ~157KB × 600 corpus fully exercises the enrich path at far less disk than 1 GB.

---

## Results

Machine-pressure snapshot: **(pending — filled at run time from `ram0-raw/machine.txt`)**

Executed counterbalanced order: **(pending — from `ram0-aggregate.json` runOrder)**

### Cohort (1) — cache-hit preview, no engagement → engine MB

| State | Engine processes | Engine MB | Basis |
|---|---|---|---|
| Post-dwell-cut (target) | 0 | ~0 (definitional) | pure reader spawns no sidecar |
| Today (pre-cut) | 1 (after 300 ms dwell) | = cohort-2 boot floor | dwell-spawn `App.tsx:2602-2613` |

Validation of "no sidecar spawned": **(source-anchored; live GUI confirmation is operator-gated — see §Cohort 1 note)**

### Cohort (2a) — fresh spawn, boot floor (real engine, no attach)

| Metric | median | min–max | reps |
|---|---|---|---|
| RSS (MB) | (pending) | (pending) | (pending) |
| Physical footprint (MB) | (pending) | (pending) | (pending) |

### Cohort (2b) — attached-idle plateau (real engine, bare socket attached)

| Condition | boot footprint MB (med [range]) | plateau footprint MB (med [range]) | boot RSS MB (med [range]) | plateau RSS MB (med [range]) | trajectory |
|---|---|---|---|---|---|
| enrich=50  (50-session corpus) | (pending) | (pending) | (pending) | (pending) | (pending) |
| enrich=600 (600-session corpus) | (pending) | (pending) | (pending) | (pending) | (pending) |

### MIMALLOC_PURGE_DELAY=0 A/B (enrich=600 corpus)

| Condition | plateau footprint MB (med [range]) | plateau RSS MB (med [range]) | Δ vs default |
|---|---|---|---|
| default (unset) | (pending) | (pending) | — |
| MIMALLOC_PURGE_DELAY=0 | (pending) | (pending) | (pending) |

### Leak sweep (post-run)

| Check | Result |
|---|---|
| `ps` for probe sidecar PIDs | (pending) |
| `find` for probe scratch sockets | (pending) |
| Per-run `killVerified` | (pending) |

---

## Parked (NOT run this session)

- **Cohort (3) one turn, (4) restored large transcript, (5) long-lived
  multi-turn:** need real LLM turns → real accounts. **Fake-executor seam check:**
  the sidecar's real-vs-fake executor seam is `CATCODE_SIDECAR_PROBE=1`
  (`app/sidecar/probeAdapter.ts`), but the probe adapter builds NO engine
  (`initializeSidecarRuntime`/controller are skipped when `probeOnAttach`), so it
  cannot drive turn-shaped engine memory (no app-state store, no catalog, no
  turn machinery). There is no account-free seam that produces a *real* engine
  turn's memory. → **PARKED, needs operator-authorized account.**
- **Strict enrich-limit interim-knob A/B** (limit varied on a fixed large
  corpus): needs an additive env test-seam in `sessionsCatalogDomain.ts`
  (behavior-preserving default 600). Out of this session's no-source-edit scope.
  → **PARKED** (corpus-size proxy measured instead; see above).
- **Bundled-sidecar RAM ladder (RAM-3.5 spike):** optional here; not run.

## Re-anchor drift found (vs audit)

- Enrich limit: audit cites `app/renderer/src/...:66`; the real enumerating
  domain is **`app/sidecar/sessionsCatalogDomain.ts:62`** (`= 600`). Confirmed.
- Catalog refresh no-op-unless-attached guard: audit `~:2314-2316` — exact match
  (`app/sidecar/sidecarServer.ts:2314-2316`).
- Refresh timer: `app/sidecar/sidecarServer.ts:449-451`; interval const
  `SESSIONS_CATALOG_REFRESH_INTERVAL_MS = 30_000` at `:287`. First enumeration
  kicked on attach at `:588`.
- MIMALLOC env: audit says add one line in `sidecarEnv`
  (`supervisor.ts:218-230`). Confirmed that region is the spawn `env` block; no
  `MIMALLOC_*` present today — the probe injects it directly for the A/B.
