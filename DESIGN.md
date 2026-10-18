---
name: Cat Code
---

# Cat Code visual design

This is the visual guide for Cat Code's Electron desktop app. It helps a person
or coding agent make new renderer screens feel like part of the same workspace.
It describes the current product, not a proposed redesign. For exact values and
behavior, the renderer source is authoritative: start with
[`app/renderer/src/theme.css`](app/renderer/src/theme.css), then inspect the
component being changed. Update this guide when a design decision changes.

## Overview

Cat Code is a focused coding workspace with a little personality. Most of the
window stays quiet so the conversation, tools, files, and decisions carry the
attention. The cat artwork and bright accent make entry points recognizable;
they do not decorate every working surface. Dense controls are acceptable when
they let a person follow several sessions without losing context.

The desktop shell has a tab strip, a compact left rail, and a central workspace.
The strip can show session tabs alongside renderer-only page tabs. A session is
a readable stream of user text, agent text, reasoning, tool activity, and
results above a persistent composer. Visual hierarchy comes from type,
alignment, small color cues, seams, and restrained elevation. The welcome screen
has more room for the brand and project/account overview than an active
transcript. See [`WelcomeScreen.tsx`](app/renderer/src/WelcomeScreen.tsx),
[`SessionPane.tsx`](app/renderer/src/SessionPane.tsx), and
[`TranscriptView.tsx`](app/renderer/src/TranscriptView.tsx).

## Colors

Use semantic CSS roles from `theme.css`, including their Tailwind aliases. The
same component must remain legible in light and dark appearance. Lightness is a
user preference, and the accent can be pink, blue, green, purple, or amber.

| Role | Current dark / light reference | Use |
|---|---|---|
| `--color-app-bg` | `#09090b` / `#fcfcfd` | Main reading canvas. |
| `--color-shell-chrome` | `#070709` / `#f1f1f4` | Tab strip, rail, and shell chrome. |
| `--color-surface-raised` | `#111113` / `#ffffff` | Menus, popovers, toasts, and other floating surfaces. |
| `--color-surface-panel` | `#0a0a0c` / `#f7f7f9` | Recessed panels and drawers. |
| `--color-text-primary`, `--color-text-muted`, `--color-text-subtle` | Appearance specific ramps | Reading text, supporting text, and quiet metadata. |
| `--color-accent`, `--color-accent-soft` | Default pink; selected accent changes both | Actions, selection, focus, and active navigation. |
| `--color-tone-good`, `--color-tone-warn`, `--color-tone-danger`, `--color-tone-info` | Appearance specific | Meaningful status and feedback. |

Chrome sits one tonal step away from the reading canvas; a floating surface
sits above it. Use `--color-shell-seam`, `--color-shell-hover`, and
`--color-shell-active` for subtle boundaries and interaction states. Use
`--color-on-fill` for text on a saturated accent or status fill. Keep status
tones semantic: a selectable green accent does not turn every success state
into an accent. Peer identity has its own `--color-peer` role.

Avoid introducing raw hex values for general UI. If a new role is needed,
define it for both appearances in `theme.css` and use the role in components.
Glass mode can change the window backdrop; controls and menus still need
readable, bounded surfaces.

## Typography

Use the locally hosted **DM Sans** for interface text and conversation prose.
Use **DM Mono** for code, paths, command output, numeric readouts, and compact
technical metadata. `theme.css` exposes them as `--font-sans` and
`--font-mono`. The locally hosted **Press Start 2P** is available as
`--font-display` for rare decorative use; it is not a general heading font.

Working screens favor modest type changes over oversized headings. Keep prose
comfortable to scan and technical labels compact without making essential
state faint. The text ramp has distinct primary, muted, subtle, faint, and
ghost roles; faint and ghost belong to resting or disabled details, not core
instructions. Align numbers with tabular figures where values update in place.

## Layout

The collapsed sidebar has a 48px footprint and expands over the workspace when
opened; its content and behavior live in
[`Sidebar.tsx`](app/renderer/src/Sidebar.tsx). The transcript, restore state,
and composer share `--transcript-width` (currently 900px) so their edges align.
Do not widen one of those surfaces independently. The session column can shrink
with the window, and long paths, code, and output need their own wrapping or
scrolling behavior rather than widening the whole layout.

Use compact rows and predictable grouping in navigation and metadata. Give
reading content more breathing room than controls. Keep the composer present
at the bottom of a session. The welcome screen can use a broader composition
and more open space; settings and analytics can use denser panels and grids.

## Elevation & Depth

The main transcript stays largely flat. Hairline seams, tonal shifts, and
indentation separate activity without turning each step into a card. Floating
menus, popovers, modals, drawers, rails, and toasts use the matching
`--elev-*` shadow roles in `theme.css`; light appearance uses a soft lift and
a small contact shadow. Reserve stronger elevation for an overlay that actually
sits above the work area. Use a scrim behind a modal, not as a panel fill.

## Shapes

Use compact, softly rounded rectangles for controls and panels. Existing
components commonly use small radii for buttons and rows, about 10 to 12px
for floating surfaces, and a compact rounded rectangle for shared chips. Full
pills are used selectively for filters and small status capsules. Round shapes
are for dots, avatars, and icon buttons. Let the component's
neighboring controls set the precise radius; avoid mixing sharply square and
large pill treatments within one control group.

## Components

- **Shell navigation:** Keep the rail and tab strip quiet. The strip's single
  visible order covers session and page tabs; selecting a session shows its
  conversation, while selecting a page shows that page in the main workspace.
  Page tabs are unique, closable renderer navigation, not synthetic sessions or
  split panels, and do not survive renderer reload or app restart. Switching
  away unmounts the page, so page-local state follows the page's existing
  mount/unmount behavior. Show the selected tab clearly and preserve meaningful
  session status cues without filling every row with badges.
- **Conversation:** Agent prose reads as a continuous column. User messages
  receive a restrained accent tinted bubble. Tool activity is compact and
  scannable; expand detail on demand. Code and command output use mono text and
  clear boundaries. Bash failure is indicated by the card status; output keeps
  its per-line styling rather than turning entirely red on a nonzero exit.
  See `TranscriptView.tsx` and `toolCardStyle.ts`.
- **Workspace moves:** Agent jumps and manual moves share one centered transcript
  divider with seam-coloured rules and muted text. Moving shows the running-tool
  pulse, destination name, and project path; arrival shows “Working in”, a project
  folder icon, and the existing Move back action. Chat has no folder or path.
  Failed and stopped moves stay neutral. A live arrival washes the divider and
  subsequent content in `--source-project` for 1.8 seconds while the rules cool
  to the seam colour. Saved or restored seams stay at rest, as does reduced motion.
  The moving composer keeps its normal placeholder, dimmed.
- **Subagents:** One dock sits at the top-right of each session pane. A 288px
  panel uses the gutter beside the transcript when it fits; narrower panes show
  a chip of cat faces that opens a floating panel or the Workers dialog when
  the pane cannot contain the panel. Collapse is an app-wide preference.
  Waiting workers lead the active list; terminal workers settle into a Finished
  group, closed on load. Finished history and Clear survive reload and restart
  for the session. With no live work, the collapsed chip shows only uncleared
  failures with red badges; done and stopped history never keeps it visible,
  even while those rows settle in the panel. Each agent occupies one row across
  resume. Resumed runs use a background ring, the word “resumed”, and a brief
  `--source-project` arrival wash. Hover or keyboard focus reveals only additional
  details in a two-line strip attached to the row, with a clamped popover when
  left space is tight.
  In the dock, only foreground workers name their current activity. Background tasks remain available
  through ⌘K “Background tasks”. See `SubagentDock.tsx`,
  `subagentDockState.ts`, and `subagentDockPersistence.ts`.
  Clicking an inspectable worker opens its read-only live steps in a 480px
  inline right panel when its workspace pane is at least 840px wide. In narrower
  panes, the parent conversation and panel share the height, with the panel below
  the transcript and composer. This follows pane resizing, not window width.
  The panel uses `surface-panel` and a separating seam, without overlay elevation.
  Header faces replace the hidden dock and switch among active and finished
  workers; the open face is marked. Its two-line Agent identity header omits
  running activity, shows waiting with the assistant baton, and shows settled
  usage on finish. Steps reuse the main transcript and reasoning layout, follow
  new work until the reader scrolls up, and resume at the bottom. Background
  and resumed runs stream steps the same way as foreground runs. A finished
  launch recorded before runs published their steps keeps the existing
  reveal/Workers fallback. An open panel does not follow identity into a different
  run; an evicted finished selection retains its last observed state.
  See `SubagentWorkspace.tsx` and
  `SubagentSidePanel.tsx`.
- **Composer:** Keep the input visually connected to the transcript. Run settings
  share one borderless 12.5px medium trigger: provider mark, cyan model name,
  accent effort word (with “(Auto)” for an implicit tier), a filled amber bolt
  only when fast is on, and the permission label in its tone only outside Auto.
  Keep 6px gaps, with no internal dot separators. Auto is always the usual mode,
  independent of the saved default. Claude's mark uses `--provider-claude`;
  OpenAI's uses `--provider-openai` (primary text), independently of model cyan.
  The stacked panel shows the current model row, its effort slider when supported,
  a seam, the supported fast switch, and mode. Model and mode rows open subfaces
  with Back controls. Model picks return to the stacked face with the engine's
  updated effort; mode picks close the panel. Escape goes back one level before
  closing. Read-only panes use the same value composition without a trigger.
  Account, branch, lid cup, and context controls stay in the right cluster.
  Reuse the existing composer controls before adding a new control style.
  Context pressure belongs on the ring, not
  a separate triangle. Estimated cache expiry uses a display-only amber clock
  before the account face, with a small raised-surface hover label reading
  “Cache expired”. Unknown expiry shows nothing.
- **Overlays and feedback:** Use a raised surface, a fine border, and the
  matching elevation token. Let tone indicate a real outcome or required
  action. Avoid decorative status text that repeats what the interface shows.
- **Artwork and icons:** Keep cat illustrations in intentional brand moments,
  such as the welcome state. Use the existing thin line icon language for
  everyday controls; icons should clarify an action or state.

Motion is brief and purposeful. `theme.css` provides fast, arrival, panel,
value, and landing durations for different kinds of change. New animation
should follow the existing pattern and respect `prefers-reduced-motion`.
Interactive elements need visible keyboard focus and hover/focus affordances;
do not make a hover-only action inaccessible to keyboard users.

## Do's and Don'ts

- Do inspect the adjacent screen and its existing component before making a new
  visual pattern. Reuse semantic color roles and appearance-aware surfaces.
- Do check light, dark, each relevant accent, narrow window widths, keyboard
  focus, and reduced motion when changing a shared visual pattern.
- Do keep the transcript readable first, with small accents reserved for
  navigation, controls, and meaning.
- Don't treat the welcome screen's expressive artwork or glow as the default
  treatment for working screens.
- Don't use status hues as decorative accents or make important information
  depend on color alone.
- Don't copy values from this document into code when `theme.css` already owns
  the token. Update the source and this guide together when the system changes.
