# Two-week audit sweep: what a green test suite was hiding

**Range audited:** `bcfe0db` (2026-07-14) .. `5433af8` (2026-07-28) — 237 commits,
538 files, +79,628 / −6,010.
**Method:** 13 read-only auditors over disjoint domains, then 25 fix-agent runs
across three waves, each with exclusive file ownership.
**Result:** ~70 findings. All closed or explicitly parked. 23 commits,
`fdca782`..`ce7098f`, local `migration`, not pushed.

Status row: `docs/migration/STATUS.md` **CC-21**.

---

## 1. The finding that frames all the others

`bun test app/` was **1711 pass / 0 fail** on the first commit of this sweep. It
was green while every bug in §2 was live.

That is not a story about missing tests. The suite is large and mostly earnest.
It is a story about *what the tests were measuring*: reducers, selectors, and in
several cases the literal source text of the file under test. The renderer suite
runs `renderToStaticMarkup`, so it cannot mount an effect or dispatch an event —
which means the entire class of "the wiring is wrong" is invisible to it by
construction.

Two artifacts make this concrete, and they are the most reusable thing in this
report.

### 1.1 Eighteen green tests over a broken main process

`app/main/mainSource.test.ts` (**deleted in this sweep**, recoverable at
`git show 5433af8:app/main/mainSource.test.ts`) had 18 tests and 19 `readFileSync`
calls against `main.ts`'s own source. It executed no production code.

We reconstructed it and applied three behaviour-destroying mutations to `main.ts`
that leave the asserted *text* intact:

1. the renderer bridge never translates an event (`const frame = null as …`)
2. the single-use cwd-token delete is removed — HC1 tokens become infinitely reusable
3. transcript backfill reads the oldest rows instead of the newest

```
bun test <scratch>/mainSource.test.ts
 18 pass / 0 fail          # against the MUTATED main.ts
```

Frame delivery gone, a security guarantee gone, backfill inverted — all green.
The replacement (`app/main/mainDecisions.ts`, Electron-free) fails 4 tests on the
same three mutations.

**Generalisable:** an assertion over source text cannot distinguish a call from a
call that is never reached, and `indexOf(a) > indexOf(b)` proves textual order,
not execution order.

### 1.2 A test mock that cannot be undone

The four deferred-continuation suites each passed alone but reported **31 pass /
16 fail** together. Cause: `mock.module` in one test file, never gated.

The obvious fix does not work, and we measured that twice before believing it:
**bun installs `mock.module` during the import phase for every file in the
invocation**, so an `afterAll` restore runs long after the damage. A related trap:
reading the "real" function back off the namespace after mocking returns the
*stub* — the implementation must be captured into a local before the
`mock.module` call, or the pass-through infinitely recurses.

The casualty was the durable-barrier test, which is the crash-safety evidence for
deferred continuation. Anyone widening their test command saw the safety net fail,
and would eventually have "fixed" it by weakening it.

Fixed by injecting the durable writers through `QueryEngineConfig`. Those files
are now **56 pass / 0 fail** together and each still passes alone.

---

## 2. Defects that shipped green

Severity is operator impact, not code smell.

| Area | Defect |
|---|---|
| Permissions | Pressing **Deny** on a permission card **allowed the tool**. The global Enter shortcut treated any non-text-field target as "nobody is typing", then `preventDefault()`d the button's own click. |
| Permissions | With a permission and an `AskUserQuestion` pending together, **one Enter resolved both** — answering a question silently approved an unrelated Bash command. |
| Tasks | ⌘K with the Tasks dialog open **killed the first running background task**. No confirmation, no undo: the `k` shortcut had no modifier guard. |
| Deferred continuation | An unusable store **blocked every prompt in every session**, and the recovery command the message named threw the same error. One `sudo cat-code` run triggers it. |
| Deferred continuation | A crashed `submitted` job **bricked the session permanently**. 16 of 60 real project dirs on this machine hit the triggering permission check. |
| Deferred continuation | Autocompaction spliced the attempt's own message out of the array classification later searched, so a **successful** continuation reported "Stopped, needs you". |
| Provider routing | CLI `--resume` never armed the provider-switch lock, so a GPT session could be moved onto Anthropic mid-conversation — the apply_patch-vs-Edit schema mismatch the code itself warns about. |
| Settings | Writing a setting that a higher layer overrides turned that row into a permanently uneditable `unknown`. The operator destroyed the control they had just used, could not see what they wrote, and could not undo it. |
| Settings | Five live panes — workspace trust, permission rules, effective settings, launch flags, engine diagnostics — rendered **nowhere**. Settings deleted them citing an inspector that was never handed its state. |
| Transport | One oversized frame **erased the entire replay ring**; a renderer reload showed an empty transcript. |
| Lifecycle | The catalog and accounts-pool workers were never killed on quit, orphaning a ~189 MB engine-graph process invisible to every reaper. |
| Security | `remoteSettings.directConnect` accepted any renderer string as a URL — renderer-originated egress plus the session cwd, defeating the `connect-src 'self'` policy. **Predates the window.** |
| Accounts | The accounts worker ran the engine in bare mode, so it reported every Anthropic route absent every 60 s — a signed-in user was told to sign in, forever. |
| Accounts | A host-initiated park could `process.exit()` mid vault-token-refresh, orphaning the lock and quarantining an account that had no auth failure. |

Sixteen more of lower severity are in the commit bodies.

---

## 3. Swept clean — do not re-audit

Recorded so the next sweep does not spend its budget here.

- **Em dash across `app/renderer/src`:** 910 raw hits, all 910 classified, **zero
  violations** (all code comments).
- **Tailwind v4 dynamic-class trap:** 131 interpolated `className` template
  literals, **zero traps** — every one substitutes a whole pre-resolved class
  string. The 5 bracket-interpolation hits are comments warning about the trap.
- **Feature and migration wiring:** `scripts/build.ts` unchanged in the window; no
  migration added; the one touched migration is 4/4 wired.
- **`src/codex-core/` entirely unchanged in the window** — the cross-process
  lockfile and durable attempt-ledger machinery was never touched.
- **`hasConversation` /resume filter:** replicated the 64 KB scan over all 323 real
  transcripts — 1 lite-false, **0 false negatives**.

---

## 4. Open, and why

### 4.1 The feature-gate divergence (biggest open item)

The sidecar is spawned unbundled (`bun run app/sidecar/index.ts`), and `feature()`
is a build-time macro. So:

- **911** `feature()` call sites across **87** flags in `src/` evaluate `false` in the sidecar
- `./cli-dev` enables **37** of those names — **463** call sites, **436 outside the TUI**

Three divergences that change behaviour, not just surfaces:

- `src/utils/bash/parser.ts` — the desktop parses Bash with a **different parser**,
  and Bash *permission analysis* is built on that parse. Same command, potentially
  different classification. **This is the security-relevant one.**
- Built-in Explore/Plan subagents exist in the terminal, not in the desktop app.
- Memory extraction and agent memory snapshots never run in the desktop.

Already on record as **"ruling #1", open since 2026-07-21**
(`docs/migration/reviews/2026-07-21-app-cutlist-ram-audit.md`), while `app/` kept
shipping surfaces on top of it. Needs a decision — bundle the sidecar, pass an
explicit manifest at spawn, or ratify the empty set — not a patch.

### 4.2 Three test suites that still leak

`src/components/Settings/Usage.test.tsx` (co-run 46/22),
`src/components/Settings/Settings.test.tsx`, and `src/codex-core/accounts.test.ts`
(intermittent) each carry 10–13 unconditional module mocks. Not a one-line gate.
The last is the cross-process token-rotation file CLAUDE.md §6 fences off, so it
was deliberately left rather than fixed unsupervised.

### 4.3 Smaller

- `AgentConfigSnapshot.availableMcpServers` and `MemorySnapshot.notes` — 3rd and
  4th unread wire fields. The latter now ships `notes: []` purely to satisfy the
  contract.
- A user frame carrying **only** a `tool_result` projects zero rows and returns
  before being recorded as seen, so its redelivery still churns identity.
- `docs/maps/web-app-runtime.md:67,69` cite the deleted `mainSource.test.ts`; that
  map was another session's uncommitted work at the time and was left alone.

### 4.4 The two worst bugs are fixed but **unexercised**

No test in `app/` can press a key. `App` takes no props, its data arrives through
effects `renderToStaticMarkup` never runs, `App`/`SessionPane` call hooks so the
direct-invocation convention throws, and there is no jsdom in the tree. The Deny
fix and the double-resolve fix are pinned by exact-expression tripwires only.

**Operator check, one keypress:** with a Bash permission pending, Tab to Deny and
press Enter. It must deny.

**Structural fix:** a DOM harness. Until then this class keeps shipping green.

---

## 5. Verification

| Battery | Before | After |
|---|---|---|
| `bun test app/` | 1711 pass / 0 fail (142 files) | **1799 pass / 0 fail** (148 files) |
| deferred suites, run together | 31 pass / **16 fail** | **56 pass / 0 fail** |
| `bun run --cwd app typecheck` | clean | clean |
| `bun run --cwd app typecheck:sidecar` | clean (5546 upstream) | clean (5545 upstream) |
| `bun run --cwd app test:hardening` | 19/19 | **19/19** |
| `bun run build:dev:full` | green | green |
| root `bun run typecheck` (known-red) | 1897 | 1896 |

---

## 6. Process notes worth keeping

- **Park deletions on any documentary hit.** Four proposed deletions were parked
  because `STATUS.md`, `backlog/phase4.md`, `INVENTORY.md` or a prior cut-list
  audit still treated those files as live work. One would have deleted the only
  implementation of data that currently renders nowhere. A referrer-grep cannot
  see documentary wiring.
- **Exclusive file ownership per agent.** `App.tsx` alone attracted findings from
  three audit domains; splitting it would have raced. Agents were told to report
  cross-file needs rather than reach across.
- **Agents must not commit.** 12 agents sharing one git index will corrupt it; the
  lead committed serially after verifying.
- **`rg` is not fully trustworthy in this repo.** `codex-fetch-adapter.ts` contains
  a raw NUL byte so plain `rg`/`git grep` silently skip all 3,634 of its lines
  (use `rg -a`). Separately, during this sweep `rg` was observed silently replacing
  long identifiers in its own output; quoted strings were re-verified with `Read`.
