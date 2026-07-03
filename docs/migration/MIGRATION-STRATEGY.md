> ⚠️ **SUPERSEDED 2026-06-26 by `PROGRAM-PLAN.md`.** Kept for historical
> reference (the strangler-fig / vertical-slice reasoning still informs the new plan).
> Where this disagrees with PROGRAM-PLAN.md, the latter wins.

# CatCode migration — strategy

How we take the prototype to production. This is the **methodology**; the
**territory** is `MIGRATION-DOMAINS.md`; per-domain findings live in their own
files (see "Document structure" below). Grounded in real prototype→production
practice (strangler fig, vertical slices, walking skeleton, anti-corruption
layer) adapted to our specifics. Created 2026-06-19.

---

## 1. Our situation is NOT a textbook strangler-fig — name it precisely

Standard prototype→production playbooks assume the legacy **is** the production
system and you replace it endpoint-by-endpoint behind a facade/proxy. **That does
not describe us:**

- The cat-code **TUI keeps living** — we are not retiring it. We're adding a second
  face (a dedicated app) to the same engine.
- The **prototype is a parallel design artifact**, not the running system. It proves
  what the app *should* be (high-fidelity design), not that it *can* be built on the
  real engine.
- There is **no shared request path** between TUI and the new app, so there's no
  facade to route traffic through. The classic strangler "coexist behind one entry
  point" mechanic doesn't apply.

What this means: we can't lean on the facade/route-shifting safety net the pattern
gives. Our safety comes from two *other* borrowed ideas (below). Naming this stops
us from cargo-culting steps that assume a facade we don't have.

## 2. The two patterns that DO apply

**(a) Vertical slices (the core engine of our work).**
Research distinction: *prototypes prove "should"; vertical slices prove "can."* You
don't "convert" a prototype — once it has validated the design, you build a
**vertical slice from scratch on the real production pipeline**: one-of-each-thing
at near-shipping quality, run end-to-end (UI → real cat-code engine → back), to
surface the real blockers. Our prototype already did the "should." Every migration
unit is now a vertical slice that proves "can" against `~/cat-code`.

- A good slice: visible value, low blast radius, exercises the *whole* pipeline.
- **Start with the easiest slice that's still real, not the most important one** —
  build the pipeline + confidence before the hard domains.
- The *second* slice in a domain goes much faster — that's when you can estimate the
  rest. (Don't estimate the whole migration off slice #1.)

**(b) Anti-corruption layer (the boundary that keeps us honest).**
The prototype invented shapes cat-code doesn't have (`tool` as a message type,
`escalate:user`, cross-session `sessionId`, 14 perm variants…). To stop those
inventions from silently dictating production, every slice passes the real
cat-code shape through an explicit **adapter/mapping boundary** rather than letting
prototype mocks become the contract. Where prototype and source disagree, **source
wins and the adapter absorbs the difference** (it's already documented per the
`// SOURCE:` / `// PROTOTYPE` markers). This is also where multi-session lives:
the registry-of-N-processes reality (see DOMAINS §A) gets adapted to the
tabs/panels UI, not the other way round.

## 3. The walking skeleton comes first

Before any domain is "migrated," stand up a **walking skeleton**: the thinnest
possible end-to-end path that is *real on both ends* — dedicated-app shell → talks
to a real cat-code session → renders one real message → sends one real prompt back.
No features, no fidelity. Its only job is to prove the **production pipeline exists
and the seam works**. Every later vertical slice is then flesh on this skeleton.

This is the antidote to our biggest risk (§1): since we have no facade to fall back
on, the seam between app and engine is unproven until a skeleton walks it. Build it
first; everything else is lower-risk after.

## 4. Phase shape (sequence by risk retired, not by feature area)

> Coarse on purpose. Each phase's *contents* get fine-grained only when we open it.

0. **Decide the production target & process model.** ✅ MOSTLY DONE — shell tech =
   **Tauri + Bun sidecar** and the app↔engine seam = **`AppSessionController` over a local
   socket** are decided (see `decisions/SHELL.md`, `decisions/SEAM-SPIKE.md`).
   Still open: production-target repo location, and the multi-session spawn/multiplex model
   (single-session skeleton first regardless). (§6.) — *gates everything*
1. **Walking skeleton.** One real session, one real message in, one real prompt out,
   in the chosen shell. Proves the seam. (§3)
2. **First vertical slice — the easiest real domain.** Likely a leaf with a clean
   source mapping and low blast radius (candidate: Goal, or a single tool-card family),
   NOT the shell. Establishes the slice recipe + the adapter pattern + the per-domain
   deliverable format (still TBD — defined by doing this one).
3. **Transcript + tool rendering slices** (Domains B, C) on the skeleton — the spine
   most other surfaces need.
4. **Permissions** (E) — high-value, strongly source-anchored, interaction already accurate.
5. **The shell + multi-session** (A, with G/H) — deferred until the seam, adapter, and
   process model are all proven, because it's the deepest architectural item.
6. **Remaining domains** (Settings J, Accounts I, Agents K, Orchestrator F, Startup L)
   slice by slice, reusing the now-proven recipe.

Rationale: we front-load the two unknowns the research says kill these migrations —
**the seam** (no facade → prove it early) and **wrong decomposition** (do the domain
modeling first → that's the DOMAINS doc + per-domain tracing). Volume work comes only
after both are retired.

## 5. Per-domain working loop (the repeatable recipe)

When we open a domain (run as one or more sessions):
1. **Enumerate** its features fine-grained (deferred until now per the DOMAINS doc).
2. **Trace** each into `~/cat-code/src`: real home (`file:line`) / works-differently /
   no counterpart / architectural collision. (Use the cat-code agent where the shape
   is unknown; require a `src/…:line` citation, not map prose.)
3. **Classify** each feature: *port-as-is · adapt · build-new · cut*.
4. **Slice**: pick the smallest end-to-end-real piece, build it through the adapter on
   the skeleton, leave a runnable check.
5. **Record** findings in the domain's own file; update DOMAINS status.

We **define the deliverable format by doing step 2-5 once** (Phase 2), then template it.

## 6. Decisions & open questions

**Resolved this session (see depth-docs):**
- ✅ **App↔engine seam:** adopt cat-code's existing `AppSessionController` / `QueryEngine`
  driver (`src/app-runtime/`) — tested, current, streams full `SDKMessage`. (`decisions/SEAM-SPIKE.md`)
- ✅ **Shell tech + transport:** **Tauri shell + cat-code Bun binary as a sidecar**, UI↔engine
  over a local socket (reuse `AppSessionWebSocketServer`, replace its flattening mapper).
  Driven by the engine being Bun-native (can't run on Node → Electron's value is void).
  (`decisions/SHELL.md`)

**Still open (resolve at the phase that needs them):**
- **Production target:** fresh app in `~/cat-code` vs. promote this workspace. (User: undecided.)
- **Multi-session process model:** N sidecars coordinated via the session registry
  (`concurrentSessions.ts`) — how the app spawns/attaches/multiplexes them. Gates Phase 5.
- **Skeleton sub-question:** reuse `AppSessionWebSocketServer` as-is vs. a thin custom
  socket wrapper around `app-runtime`. Decide when building Phase 1.
- **Per-domain deliverable format:** TBD by doing the first domain.

## 7. Document structure (so no single doc carries everything)

- `MIGRATION-STRATEGY.md` — this file. The how. Rarely changes.
- `MIGRATION-DOMAINS.md` — the what/where. The 13 territories + status. The index.
- `decisions/SEAM-SPIKE.md` — how the app drives a real cat-code session (the seam). Settled.
- `decisions/SHELL.md` — Tauri + Bun sidecar + socket. Settled.
- `migration/<domain>.md` — one file per domain, created when we open it: fine-grained
  feature list, source traces (`file:line`), classifications, slice notes. The depth.
- (Later) per-slice build prompts, if we adopt the `visual-build-prompts.md` style.

The strategy/territory/depth split is the point — flat single-doc was the wrong shape.
