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

The desktop shell has a tab strip, a compact left rail, and a central session
area. A session is a readable stream of user text, agent text, reasoning, tool
activity, and results above a persistent composer. Visual hierarchy comes from
type, alignment, small color cues, seams, and restrained elevation. The welcome
screen has more room for the brand and project/account overview than an active
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

- **Shell navigation:** Keep the rail and tab strip quiet. Show the active
  session with the accent and a small marker. Preserve meaningful status cues
  without filling every row with badges.
- **Conversation:** Agent prose reads as a continuous column. User messages
  receive a restrained accent tinted bubble. Tool activity is compact and
  scannable; expand detail on demand. Code and command output use mono text and
  clear boundaries. See `TranscriptView.tsx` and `toolCardStyle.ts`.
- **Workspace moves:** Agent jumps and manual moves share one centered transcript
  divider with seam-coloured rules and muted text. Moving shows the running-tool
  pulse, destination name, and project path; arrival shows “Working in”, a project
  folder icon, and the existing Move back action. Chat has no folder or path.
  Failed and stopped moves stay neutral. A live arrival washes the divider and
  subsequent content in `--source-project` for 1.8 seconds while the rules cool
  to the seam colour. Saved or restored seams stay at rest, as does reduced motion.
  The moving composer keeps its normal placeholder, dimmed.
- **Composer:** Keep the input visually connected to the transcript. Put model,
  reasoning, permission, and account controls in a compact action row. Reuse
  the existing composer controls and [`Chip.tsx`](app/renderer/src/Chip.tsx)
  before adding a new control style.
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
