# Cat Code agent chrome — how to build with it

These are the shared primitives cat-code uses to show a subagent: what it is, what it is
doing, and who has to act next. They are presentation-only. They hold no state, fetch
nothing, and need no provider or context wrapper.

## Setup

There is no provider. Render any component directly.

One thing is required: **these components assume a dark surface.** They ship no background
of their own, and their text tones are chosen against near-black. Put them on `bg-app-bg`
(`#09090b`) or a panel surface, or they will be invisible.

```jsx
<div className="bg-app-bg font-sans p-4">
  <div className="flex items-center gap-2">
    <AgentRoleDot role="Explore" />
    <AgentHandle name="Ada" />
    <span className="flex-1 truncate text-[11.5px] text-text-subtle">
      Trace the auth refresh path
    </span>
    <AgentPip state="running" />
    <AgentTypeLabel role="Explore" />
  </div>
</div>
```

That is a worker row, and it is the composition almost everything here serves.

## The styling idiom

Tailwind utility classes, with the palette exposed as named colour utilities. Never write
inline `style={{}}`, and never build a class name by interpolation — `text-[${hex}]` silently
produces nothing, which is a bug this codebase has shipped before. Use a static map from a
value to a full literal class instead.

**Important limit:** the stylesheet ships a finite set of utilities, not all of Tailwind. The
families below are present and safe. Something outside them may not exist, and an absent class
fails silently rather than erroring, so prefer these names over inventing new ones.

| Family | Names |
|---|---|
| Surfaces | `bg-app-bg`, `bg-surface-raised`, `bg-surface-panel`, `bg-shell-chrome` |
| Seams and hovers | `border-shell-seam`, `bg-shell-hover`, `bg-shell-active` |
| Text ramp, brightest to faintest | `text-text-primary`, `text-text-muted`, `text-text-subtle`, `text-text-faint`, `text-text-ghost` |
| Status tones | `text-tone-good`, `text-tone-warn`, `text-tone-danger`, `text-tone-info` (also `bg-` and `border-`) |
| Accent | `text-accent`, `bg-accent`, `border-accent`, `accent-soft` |
| Type | `font-sans` (DM Sans), `font-mono` (DM Mono) |
| Layout | the ordinary `flex` / `grid` / `gap-*` / `p-*` / `m-*` / `w-*` / `h-*` / `rounded-*` / `border*` / `opacity-*` set |

Arbitrary values work where the app already uses them, which is mostly small type sizes:
`text-[11px]`, `text-[11.5px]`, `text-[12.5px]`, `text-[10.5px]`. These components are small
on purpose. Body text in this UI is 11px to 13px, not 14px or 16px.

Raw tokens are available as CSS variables for cases a utility cannot express, including
`--color-app-bg`, `--color-surface-raised`, `--color-surface-panel`, `--color-shell-seam`,
`--color-text-primary`, `--color-text-subtle`, `--color-text-faint`, `--color-text-ghost`,
`--color-accent`, `--color-tone-warn`, `--color-tone-info`, `--font-sans`, `--font-mono`.

`--accent` re-themes per agent tone, so accent is not always pink. Do not hardcode `#f472b6`.

## The one rule that governs this vocabulary

**Lifecycle and ownership are two independent axes, and they must not be merged.**

`AgentPip` and `AgentStateLabel` say what a worker is *doing*. `Baton` says who must act
*next*. A worker blocked on a question is neutral purple while the assistant can pick it up,
and amber only when nobody but the human can. Do not colour a row amber just because it is
blocked, and do not use the pip to signal that someone is needed.

Similarly, `AgentRoleDot` carries **type**, not status. When both appear on one row, keep them
at opposite ends. Three coloured dots in a row all reading as status is a failure mode this UI
has already been through.

## Where the truth is

- `styles.css` and the files it imports: every token and utility that actually exists.
- `components/<group>/<Name>/<Name>.prompt.md`: per-component props, states, and usage.
- `components/<group>/<Name>/<Name>.d.ts`: the exact prop contract, including the full
  lifecycle-state union.

Read the component's own `.d.ts` before guessing a prop. The `state` unions are long and
specific.
