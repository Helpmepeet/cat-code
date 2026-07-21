/**
 * P4-1 shared primitive kit — the ONE place the tone vocabulary maps to P0-2
 * token utilities (theme.css `--tone-*` / `--color-tone-*`). Every primitive
 * (Chip, BannerStack, ToastHost, ToolInspector) reads its tone
 * colours from here so a tone reads the same everywhere and the mapping is
 * unit-testable without a DOM.
 *
 * Class strings are LITERAL on purpose: Tailwind's JIT only emits utilities it
 * can see as complete strings in source, so `bg-tone-${tone}` would silently
 * no-op. Enumerating them keeps the generated CSS honest.
 *
 * The tone set is the union the prototype's surfaces paint with
 * (Surfaces.jsx Chip/Banner/Toast palettes): `default` (quiet grey), `accent`
 * (the pink brand hue), plus the four status tones `good`/`warn`/`danger`/
 * `info`. `info` is the prototype's blue #60a5fa (`--tone-info`, theme.css) —
 * an earlier note wrongly said the prototype had no info hue and reused accent;
 * corrected 2026-07-13 (UI-drift review).
 */

export type Tone = 'default' | 'accent' | 'warn' | 'danger' | 'good' | 'info'

/** The class fragments a primitive composes for a given tone. */
export interface ToneClasses {
  /** Foreground text painted in the tone. */
  text: string
  /** A filled status dot (`bg-<tone>`). */
  dot: string
  /** A solid 1px border in the tone at chip strength. */
  border: string
  /** A subtle tinted fill (`bg-<tone>/10`) for active/hover surfaces. */
  softBg: string
  /** A subtle tinted border (`border-<tone>/25`). */
  softBorder: string
  /**
   * The hover form of `softBg`+`softBorder`, with the `hover:` variant baked
   * in as a literal. Runtime-prefixing `hover:` onto `softBg` would defeat the
   * JIT (it never sees the composed string) — so it lives here pre-composed.
   */
  hoverTint: string
  /** An inverse pill: solid tone fill with near-black text (badges). */
  badge: string
}

export const TONE_CLASSES: Record<Tone, ToneClasses> = {
  default: {
    text: 'text-text-muted',
    dot: 'bg-text-subtle',
    border: 'border-white/10',
    softBg: 'bg-white/5',
    softBorder: 'border-white/10',
    hoverTint: 'hover:bg-white/5 hover:border-white/10',
    badge: 'bg-text-muted text-app-bg',
  },
  accent: {
    text: 'text-accent',
    dot: 'bg-accent',
    border: 'border-accent/40',
    softBg: 'bg-accent/10',
    softBorder: 'border-accent/25',
    hoverTint: 'hover:bg-accent/10 hover:border-accent/25',
    badge: 'bg-accent text-app-bg',
  },
  warn: {
    text: 'text-tone-warn',
    dot: 'bg-tone-warn',
    border: 'border-tone-warn/40',
    softBg: 'bg-tone-warn/10',
    softBorder: 'border-tone-warn/25',
    hoverTint: 'hover:bg-tone-warn/10 hover:border-tone-warn/25',
    badge: 'bg-tone-warn text-app-bg',
  },
  danger: {
    text: 'text-tone-danger',
    dot: 'bg-tone-danger',
    border: 'border-tone-danger/40',
    softBg: 'bg-tone-danger/10',
    softBorder: 'border-tone-danger/25',
    hoverTint: 'hover:bg-tone-danger/10 hover:border-tone-danger/25',
    badge: 'bg-tone-danger text-app-bg',
  },
  good: {
    text: 'text-tone-good',
    dot: 'bg-tone-good',
    border: 'border-tone-good/40',
    softBg: 'bg-tone-good/10',
    softBorder: 'border-tone-good/25',
    hoverTint: 'hover:bg-tone-good/10 hover:border-tone-good/25',
    badge: 'bg-tone-good text-app-bg',
  },
  info: {
    text: 'text-tone-info',
    dot: 'bg-tone-info',
    border: 'border-tone-info/40',
    softBg: 'bg-tone-info/10',
    softBorder: 'border-tone-info/25',
    hoverTint: 'hover:bg-tone-info/10 hover:border-tone-info/25',
    badge: 'bg-tone-info text-app-bg',
  },
}

export function toneClasses(tone: Tone): ToneClasses {
  return TONE_CLASSES[tone]
}
