# Git branch UX review (desktop)

Date: 2026-10-16. Source baseline: `bd4c0633`. Already landed: `eb5429d2`
(a refused switch no longer turns the picker label into "Unavailable").

This report covers how the desktop app shows and changes the Git branch of a
project chat: what users see today, which problems were verified, and how the
experience should behave instead. It describes target behavior, not code. A
session picking up a slice should read the relevant section, then find the
owners through [the desktop map](../maps/web-app-runtime.md) (row "Workspace
branch choice before first prompt").

## How this was checked

- Source reading of the branch feature end to end (main, host, sidecar,
  renderer, engine Git readers).
- One live run of Cat Code Dev against a throwaway repository with 27 local
  branches, one of them checked out by a second worktree, using isolated app
  state. The real cat-code checkout was never switched.
- An independent GPT review of the findings against source. Its verdicts and
  five new findings were then re-verified in source in this session.

Testing note for later live runs: an isolated `CLAUDE_CONFIG_DIR` still picked
up the operator's real Anthropic sign-in from the keychain, so any prompt sent
in a test session spends real quota. Local slash commands such as `/cost` make a
chat non-empty without a model call.

## What users experience today

1. **App opens.** The start page shows Project and Start in. No branch.
2. **Open a recent project.** The app reopens an existing conversation, which
   usually has messages, so no branch is shown.
3. **New empty project chat.** A Branch column appears under the wordmark with
   a picker (`main ⌄`). This is the only place a branch is visible or
   changeable inside a session.
4. **Pick another branch.** On success, main runs `git switch` on the real
   checkout, closes the empty chat, and opens a fresh chat in the same tab
   (about one second). On refusal, a red message appears inside the menu.
5. **After the first message.** The branch disappears from the session: no tab,
   header, or composer readout. Two chats in one folder both read as the folder
   name. Only the Sessions page shows a branch, and that is the last branch
   recorded in the transcript, not a live observation.

## Verified findings

Severity: **defect** means wrong output or a user misled into a wrong action;
**friction** means it works but costs effort or clarity; **cosmetic** is minor.

### Visibility

| # | Finding | Verdict |
|---|---|---|
| D | No branch readout once a chat has messages. Same-folder untitled chats are indistinguishable in tabs. | Friction, fix |
| 14 | An external branch change during a conversation is never signalled. The stale `!` exists only in the empty-chat picker. | Defect, fix |
| N3 | Reopening a conversation from history does not compare its recorded branch with the current checkout. | Defect, fix |
| A, B | Start page and recent-project reopen show no branch. | Cosmetic, won't fix: no single checkout to show before a project is chosen, and D covers the reopened chat |

### Branch picker

| # | Finding | Verdict |
|---|---|---|
| 1 | Refused switch made the label read "Unavailable". | Defect, fixed in `eb5429d2` |
| 2 | Every row stays clickable when the switch cannot succeed (dirty tree, branch held by another worktree, another live chat in the repo, unsent draft). The refusal only appears after the click. | Friction, fix |
| 3 | Dirty-tree refusal text appears twice. | Cosmetic, fold into 2/7 |
| 4 | Worktree-held refusal is generic and is also used for unrelated Git failures. | Friction, fix |
| 5 | "Close other live sessions" refusal does not say which chats. | Friction, fix |
| 6 | An unsent draft or attachment blocks switching. Nothing is deleted, but the user must clear it first. | Friction, fix (see decision 3) |
| 7 | Alphabetical list, current branch not first, no filter, about 10 rows visible. The notes that matter (switching replaces the chat, dirty warning, stale warning) sit at the bottom of the scroll area. | Friction, fix |
| 8 | During a successful switch the column reads "none" for about a second, which looks like "not a Git repository". | Cosmetic, fix with loading states |
| 9 | Label flashes "Checking…" on every window focus and on menu open and close. | Cosmetic, fix with loading states |
| 10 | Menu jumps sideways when the label width changes. | Cosmetic, fix with 9 |
| 11 | ~~"+" makes a projectless chat, so a same-project chat is reachable only from the hover sidebar.~~ | **Withdrawn.** `/new` and `/clear` reuse the project, the sidebar "+" also appears on keyboard focus, and the stale picker can open a fresh chat. The global "+" being projectless is intended. |

### Switch safety and correctness

| # | Finding | Verdict |
|---|---|---|
| 12 | Switching changes the whole checkout. The concurrency guard only knows desktop chats, so terminal agents in the same clean checkout are not protected. Dirty trees and ignored-file overwrites are refused, so this is not silent data loss. | Friction with a safety limit; state the scope, won't fix by inferring terminal activity |
| N1 | The guard compares host-recorded folders. A chat that entered a worktree through the engine (`EnterWorktree`, or resume restoring one) is still recorded at its original folder, so it is not counted for the worktree and is wrongly counted for the original. The switching chat itself is safe because only empty chats can switch. | Defect, narrow; fix |
| N5 | Git switches first, then the replacement chat is requested. At the live-session cap (32) or spawn-rate cap (8 per 10 s) the switch succeeds, the replacement fails, and the old chat is closed anyway. The replacement reservation does not count the chat it replaces. | Friction, fix |

### Recorded branch metadata (engine)

| # | Finding | Verdict |
|---|---|---|
| N2 | The engine's branch reader binds to one Git directory for the process lifetime. After `EnterWorktree` it keeps reporting the original branch, so transcript rows and the Sessions page record the wrong branch. Affects the terminal too. | Defect, fix |
| N4 | The engine rejects valid branch names outside an ASCII allowlist (for example `feature/日本語`, `feature/login(v2)`, both accepted by `git check-ref-format`). They become `HEAD` in transcripts and "none" in diagnostics, while the picker, which uses Git directly, shows the real name. | Defect, fix |

### Documentation and naming

| # | Finding | Verdict |
|---|---|---|
| 13 | `docs/migration/decisions/WELCOME-LAUNCHER.md` (W4, "Branch chooser") still says the standalone chooser was cut. Commit `9bc10931` shipped one that switches the real checkout, with no amendment. | Fix: add an amendment |
| 15 | Only local branches; no create, remote checkout, or worktree start. | Won't fix; bounded feature |
| 16 | "Branch from here" (conversation fork) and the Git "Branch" column share a word. Icons differ. | Won't fix without evidence of confusion |

## Target experience

Principles, in priority order:

1. **The branch shown is the checkout's real branch, right now.** Never a
   placeholder that reads as a different fact ("none", "Unavailable",
   "Checking…") while the real value is known.
2. **Say why before the click, not after.** If a switch cannot succeed, the
   user sees that, and what to do, before choosing a row.
3. **A conversation knows which branch it was on.** When the checkout no longer
   matches, the user is told, not silently moved.
4. **Never surprise-change the checkout.** No automatic switching to match
   history. Switching stays an explicit act limited to an empty chat.
5. **Keep it quiet.** Follow `DESIGN.md` and the CLAUDE.md §7 text rules: no
   em dashes, no decorative status text, status hues only for real status, and
   short strings that change what the user does.

### Branch picker (empty chat)

**Trigger label**

- Shows the current branch in mono, as today, with the chevron.
- While refreshing (window focus, menu open), keep the last known value. Do not
  blank it or show "Checking…". Refresh on menu open, not on close.
- Before the first list read completes, show the spawn-time branch if known.
  Show a neutral pending state only when nothing is known yet.
- "Unavailable" only when the list itself failed to load.
- Detached HEAD reads as the short commit, or "Detached", not "none".
- While a switch hands off to the replacement chat, show the target branch in a
  pending (dimmed) state until the new chat reports its branch. Never "none".
- Stale marker (`!` in warning tone) stays as it is today: the chat started on
  one branch and the checkout is now on another.

**Menu layout, top to bottom**

1. **Status line, only when one applies**, outside the scrolling list so it is
   always visible. At most one line, chosen by priority:
   - A checkout-wide blocker, with the action: commit or stash changes; close
     the named chats (each name is a link that focuses that chat).
   - The stale state: this chat started on X, and selecting the current branch
     opens a fresh chat on it.
   - A refusal from the last attempt, if one came back from main despite the
     pre-checks. It stays until the next attempt or the menu closes. It does not
     vanish on window focus.
2. **Filter field** when there are more than about eight branches. Typing
   filters; arrow keys move; Enter selects. Focus starts in the field.
3. **Current branch first**, with the existing check mark.
4. **Other branches**, alphabetical (see decision 4 for recency).
5. **Consequence note**, one short line, shown only when a switch is possible:
   switching replaces this empty chat. It sits above the list, not after 27 rows.

**Rows**

- When a checkout-wide blocker applies, every row except the current one is
  disabled. Clicking the current row still just closes the menu.
- A branch checked out by another worktree is disabled individually, with that
  worktree's folder name as quiet secondary text or a tooltip.
- Long names truncate with the full name in the tooltip, as today.
- No duplicate messages: each fact appears once.

**Anchoring**

- The menu anchors to a stable edge of the Branch column so it does not jump
  when the label width changes, and stays clamped to the viewport.

### Switching flow

- **Pre-checks before Git runs**: dirty tree, other live chats in the same
  checkout, worktree occupancy, draft or attachment, and capacity for the
  replacement chat. The receiving side keeps re-checking all of them, because
  state can change after the menu opened.
- **Capacity is reserved before the checkout moves** (N5), counting the chat
  being replaced, so the cap and rate limit can no longer leave the user with a
  switched checkout and no chat.
- **The draft travels** (decision 3): unsent text, pasted blocks, images, and the
  file attachment move unchanged to the replacement chat. If the handoff fails,
  they stay in the original.
- **The tab stays in place** and keeps focus, as today.
- **Honest partial outcomes stay**: when Git moved but the handoff failed, the
  existing shell error that says so remains.
- **Guard scope** (N1): "another live chat in this checkout" means any chat
  whose engine is actually working in that checkout, including one that entered
  a worktree, not the folder the chat was opened with.

### Branch readout during a conversation (D, 14, N3)

Placement (decision 1, decided): in the composer action row, immediately left
of the lid-closed cup, in the right-hand group with the account. Not inside the
prompt line, and not in the cup's own slot.

Behavior:

- Read-only. Shows the checkout's current branch in mono with the branch glyph.
  No menu: switching remains an empty-chat action.
- Stays current while the chat is open: it updates when the checkout's branch
  changes, from any cause.
- **Mismatch state**: when the current branch differs from the branch this
  conversation was last working on (an external switch while open, or a reopen
  from history after the checkout moved), the readout takes the warning tone
  and its tooltip names both branches. The conversation is not moved and
  nothing is switched.
- The mismatch clears once the conversation continues on the new branch, so it
  marks a change the user has not acted on, not a permanent badge.
- Hidden for projectless (managed) chats and outside Git repositories, with no
  replacement text.

### Recorded branch (engine, N2 and N4)

- The branch recorded with each transcript row is the branch of the checkout the
  engine is actually working in at that moment, including after entering or
  leaving a worktree.
- Any branch name Git accepts is recorded and shown as itself. Safety checks
  that protect shell commands and file paths stay at the places that use the
  name, and do not turn a valid branch into "HEAD" or "none".
- The Sessions page then shows the right last branch without any renderer
  change.

### Documentation (13)

Amend `WELCOME-LAUNCHER.md` with the shipped behavior: the empty-chat picker
switches the real checkout, replaces the empty chat, refuses dirty trees and
other live desktop chats, and does not protect terminal sessions. Update the
desktop map row if behavior changes.

## Decisions needed from the operator

Open decisions block the slices that depend on them. None has a prototype
counterpart.

1. **Where the in-conversation branch readout lives.** Decided 2026-10-16:
   composer action row, immediately left of the lid-closed cup. Rejected:
   inside the prompt line beside the send arrow, and the cup's own slot.
   Placements above the composer, below it, in the right gutter, and in the
   tab strip were shown and not chosen.
2. **Mismatch signal.** Warning tone on the readout with a tooltip only, or
   also a one-time transcript notice at the point the change was noticed
   (similar in weight to the workspace-move divider). Recommendation: readout
   only, to keep the transcript free of status rows.
3. **Draft on switch.** Carry the draft to the replacement chat (recommended),
   or keep refusing and only show the blocker before the click.
4. **Branch order after the current one.** Alphabetical (today), or most
   recently committed first. Recommendation: recency, since long branch lists
   are mostly stale worktree branches.
5. **State the checkout-wide effect in the menu?** For example a short line that
   switching changes the folder for every tool using it. Recommendation: no
   extra line; the decision record amendment covers it, and the dirty-tree and
   live-chat guards already stop the common harm.
6. **Keep the switcher at all.** The original decision preferred a worktree
   start over switching a shared checkout. Recommendation: keep the switcher
   with the fixes above; a worktree start is a separate feature.

## Suggested slices

Independent slices, each one coherent change. File ownership is separate
between slices 1 to 3 and slice 4.

1. **Picker polish** (2, 3, 4, 5, 7, 8, 9, 10). Renderer picker plus the main
   list response carrying blockers and per-branch worktree occupancy. Needs
   decision 4 only for ordering.
2. **Switch flow** (6, N1, N5). Main and host handoff ordering, capacity
   reservation, guard scope, draft transfer. Needs decision 3.
3. **In-conversation readout and mismatch** (D, 14, N3). Needs decision 2.
4. **Engine recorded branch** (N2, N4). Engine Git reader only; affects the
   terminal as well, so check the terminal surfaces that print the branch.
5. **Decision record amendment** (13). Documentation only; can land any time.

## Verifying a slice

- Unit and DOM tests at the lowest layer that shows the behavior. A regression
  test must fail on the old behavior (the `eb5429d2` picker test is the model).
- Live checks only in Cat Code Dev against a throwaway repository with many
  branches, a dirty file, and a branch held by a second worktree. Never switch
  the real cat-code checkout: it is shared by other sessions and is almost
  always dirty.
- For the readout, check light and dark, narrow windows, keyboard focus, and a
  branch change made in a terminal while the chat is open and while it is closed.
