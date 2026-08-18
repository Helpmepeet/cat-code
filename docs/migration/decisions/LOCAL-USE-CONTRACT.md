# P5-0 — Local-use contract (identity · version · signing · updates · state)

**Status: RULED, 2026-08-19.** Branch `migration`. This replaces the "release contract"
the 2026-08-17 Phase-5 backlog assumed. It is deliberately one page: it exists so P5-1,
P5-5c, and P5-7 can proceed without inventing product-scope answers, not to describe a
product.

All `file:line` anchors below were verified on `migration` at `6e12939e`. Source wins.

---

## 1. Distribution scope — the ruling everything else follows from

**Local only. One machine, one user, no distribution.**

Cat Code desktop is built by its operator, from their own checkout, for their own machine.
It is never downloaded by a third party, never served from a feed, never installed by
anyone who cannot rebuild it.

Every clause below is a consequence of this line. If the scope changes, this document is
what must be revised first, and `backlog/phase5.md` § Waived lists what comes back.

## 2. Identity

- Application name: **Cat Code**. Development builds remain **Cat Code Dev**
  (`app/main/main.ts:229`, gated on `IS_DEV`).
- Bundle identifier: **`com.catcode.desktop`**.
- **Gap P5-1 must close:** no bundle identifier exists anywhere today. `app/package.json`
  declares no `productName`, no `appId`, and no build configuration, so a packaged build
  would inherit Electron's default identity. macOS keys per-app state (TCC permissions,
  saved window state, `localStorage`) to the bundle id, so this must be set once and then
  never changed casually.
- The dev-rebrand mechanism is **not** the identity mechanism. `prepare-dev-electron.ts`
  edits Info.plist display keys only, and deliberately leaves `CFBundleExecutable` named
  `electron` because Electron derives `app.isPackaged` from the executable basename
  (`app/scripts/prepare-dev-electron.ts:85-93`). P5-1 must not reuse that trick.

## 3. Version authority

**The git SHA is the version.** There is no semantic release number for the desktop app.

- `app/package.json` reports `0.0.0` and the root CLI reports `2.1.87` (`package.json:3`).
  Neither is authoritative and **neither should be made to look authoritative.** `0.0.0`
  correctly says "not independently versioned"; leave it.
- The build stamps the SHA. `CATCODE_BUILD_ID` and `CATCODE_COMMIT_ID` are already read at
  `app/main/main.ts:2047-2048` and flow into the diagnostics bundle.
- **Gap P5-1 must close:** nothing anywhere *sets* those two variables. They are read-only
  consumers of a value no build produces. P5-1 owns injecting them at package time.
- `app.getVersion()` stays whatever the packaged metadata says; it is not the identity of
  record. When a report needs to name a build, it names the commit id.

## 4. Artifact

A macOS `.app` bundle, arm64, built to a deterministic path under `app/`, produced by one
documented command. No installer, no `.dmg`, no archive for transport, and **no artifact
manifest** — a manifest proves contents to someone who cannot inspect the build, and the
only person who runs this build can. A minimum-OS floor is likewise a distribution
concept: the build targets the machine it is built on.

## 5. Signing posture

**Ad-hoc local signing (`codesign --sign -`). No Developer ID, no notarization.**

This is not a downgrade. The stock Electron bundle the dev path copies is already ad-hoc
signed, and re-signing ad-hoc after editing Info.plist does not change its trust level
(`app/scripts/prepare-dev-electron.ts:98-101`). Developer ID and notarization exist to make
Gatekeeper trust a binary that **arrived from elsewhere**; nothing here arrives from
elsewhere. A locally built app the operator launches themselves does not cross that
boundary, and no quarantine attribute is applied to a bundle the build wrote directly.

P5-1 must re-sign ad-hoc after any Info.plist or nested-binary edit, and must sign nested
executables (the vendored sidecar runtime) rather than only the outer bundle, so the app
launches without a broken-signature refusal.

## 6. Updates

**The operator updates by rebuilding from the checkout.** `git pull`, run the P5-1 build
command, replace the artifact.

There is no update check, no feed, no channel, no differential download, and no in-app
update UI. **This absence is the decision, not a deferral** — do not add an "update
available" affordance, a version-check ping, or a placeholder settings row for one.

## 7. Persisted-state policy

**Ratified as-is: the current move-aside / rebuild behavior is the policy.** No migration
framework, no rollback contract, no version matrix for desktop-owned state.

This is proportionate because of what that state actually is:

| Store | What it is | Unknown/corrupt behavior today | Policy |
|---|---|---|---|
| `registry.json` | Durable session addresses. `REGISTRY_VERSION = 1` | Unparseable or unknown version → moved aside, start empty (`app/host/registry.ts:50-51`, `:1170`; `decisions/REGISTRY.md:311`) | **Ratified.** Losing it costs session addresses, not transcripts. |
| `sessions-catalog.json` | Enumeration **cache** | Unreadable, non-JSON, oversized, or missing a required field → `null` → re-enumerate (`app/main/sessionsCatalogBaseline.ts:48-70`) | **Ratified.** Rebuildable by definition. |
| `debug/state.json` | Write-only debug dump, `DEBUG_STATE_VERSION = 1` (`app/shared/debugState.ts:4`) | Never read back by the app (`app/main/main.ts:2403-2410`) | **Ratified.** Not state. |
| Renderer preferences | Accent theme, reasoning layout, dev panels, in `localStorage` (`app/renderer/src/{App,AccentThemeProvider,ReasoningLayoutProvider}.tsx`) | Browser-managed; absent keys fall back to defaults | **Ratified.** See the origin note below. |

`cat-code-diagnostics.json` is **not** persisted state: it is the default filename of the
operator-initiated export dialog (`app/main/main.ts:2036`).

- **Note for P5-1:** `localStorage` is keyed to the renderer origin, and packaged
  (`file://`) differs from dev (`http://localhost:5173`). Renderer preferences will not
  carry over from the dev app to the packaged app. That is acceptable — they are
  preferences, re-set in seconds — but the operator should be told once, not left to
  wonder why their accent reset.
- **Downgrade** is running an older build. It is supported in the only sense that matters:
  an older build must not silently rewrite state it does not understand. The move-aside
  rule above already provides this. No further guarantee is offered.
- **The real state is engine-owned and out of scope here.** Transcripts, the Codex vault,
  memory, and settings under `~/.cat-code/` predate the desktop app and are shared with
  terminal Cat Code. **P5-5c owns them**, and nothing in this contract licenses a desktop
  session to migrate, rewrite, or take ownership of them.

## 8. Operator-owned steps

These are never performed by an agent session without authorization for that exact run:
installing or replacing the operator's active application; launching or driving the GUI;
any action against live accounts, credentials, or `~/.cat-code`; pushing.

## 9. Waived Phase-5 sessions

P5-3 (signing/notarization), P5-4 (auto-update), P5-5a/P5-5b (state contract and
migrations), P5-6 (CI gate), P5-8 (performance budget gate), P5-10 (accessibility
certification), P5-12 (install rehearsal), P5-13 (release gate).

**One reason: §1.** Each protects a distribution that does not exist. Per-row reasoning and
the verbatim original prompts are in `backlog/phase5.md` § Waived and its appendix. Do not
re-argue them individually; revise §1 or leave them waived.

## 10. What this contract does NOT license

Single-user is not a security posture. `decisions/SECURITY-MINIMUM.md` stands unchanged:
the renderer displays model output, and hostile content arrives through fetched pages,
repository files, and tool results. The threat is injection, not other users. Packaging
must not introduce a second privileged renderer path, relax default-deny preload, or move
secrets out of the engine.

Nor does it license silence about failure. A failed or partial restore must never open a
fresh session that impersonates the operator's old one (P5-7).
