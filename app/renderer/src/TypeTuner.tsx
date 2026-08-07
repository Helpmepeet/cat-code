import { useEffect, useState } from 'react'

/* TEMPORARY type tuner (2026-08-07, operator request). DELETE ME.
 *
 * A dev-only floating panel for finding a readable type/colour setting by eye
 * instead of by argument. It injects ONE stylesheet that re-states the handful
 * of declarations worth testing, so nothing in the real components changes and
 * deleting this file plus its mount in `main.tsx` reverts everything.
 *
 * Why a generated stylesheet rather than CSS variables: `theme.css` uses
 * `@theme inline`, which compiles a token's VALUE into the utility. So
 * `.text-text-subtle` is a literal `color:` with no var to override, and
 * `.text-[11px]` is `font-size:11px`. Those need real rules. Only the named
 * sizes have usable vars (`--text-xs`/`sm`/`base`/`lg`/`xl`).
 *
 * Not wired to settings, not persisted anywhere but localStorage, not in a
 * production build (Vite drops the `import.meta.env.DEV` branch at the mount). */

const PX_SIZES = [
  8, 8.5, 9, 9.5, 10, 10.5, 11, 11.5, 12, 12.5, 13, 13.5, 14, 14.5, 15, 16, 17,
  18, 22, 26,
]

const NAMED_SIZES: ReadonlyArray<readonly [string, number]> = [
  ['xs', 12],
  ['sm', 14],
  ['base', 16],
  ['lg', 18],
  ['xl', 20],
]

/* Re-baselined 2026-08-07: these are now the LANDED `theme.css` values (the
 * prototype's greys already lifted 30%), so the slider tunes further from where
 * the app actually sits rather than re-applying a lift that has shipped. The
 * raw-hex copies this used to also target are gone — every one was converted to
 * its token in the same change. */
const GREYS: ReadonlyArray<readonly [string, string]> = [
  ['text-text-subtle', '#98989f'],
  ['text-text-faint', '#838389'],
  ['text-text-ghost', '#75757b'],
]

/* Weights named on screen because a bare "400" did not read as the change it
 * makes. These three sites (message prose, composer, placeholder) were the only
 * weight-300 text in the app and now sit at 500. */
const WEIGHT_NAMES: Record<number, string> = {
  300: 'light',
  400: 'normal',
  500: 'medium, current',
}

const STORAGE_KEY = 'catcode:typeTuner'

type Knobs = {
  scale: number
  floor: number
  weight: number
  lift: number
  smoothing: boolean
  capMono: boolean
  colWidth: number
  proseWidth: number
}

const DEFAULTS: Knobs = {
  scale: 1,
  floor: 8,
  weight: 500,
  lift: 0,
  smoothing: true,
  capMono: false,
  colWidth: 1000,
  proseWidth: 1000,
}

/** Move a colour a fraction of the way toward `--color-text-primary`. */
function lighten(hex: string, amount: number): string {
  const target = [0xf4, 0xf4, 0xf5]
  const out = [1, 3, 5].map((at, n) => {
    const from = parseInt(hex.slice(at, at + 2), 16)
    const to = target[n] ?? from
    return Math.round(from + (to - from) * amount)
  })
  return `#${out.map(c => c.toString(16).padStart(2, '0')).join('')}`
}

function buildCss(k: Knobs): string {
  const sized = (px: number) =>
    Math.round(Math.max(k.floor, px * k.scale) * 10) / 10

  const rules: string[] = []

  // Arbitrary px sizes compile to literals, so each needs its own rule. The
  // selector has to escape `[`, `]` and the decimal point.
  for (const px of PX_SIZES) {
    const cls = `${px}`.replace('.', '\\.')
    rules.push(`.text-\\[${cls}px\\]{font-size:${sized(px)}px !important}`)
  }

  // Named sizes and the light weight are vars. `:root:root` outranks the
  // `:root` Tailwind emits without needing `!important` on a custom property.
  const vars = NAMED_SIZES.map(([name, px]) => `--text-${name}:${sized(px)}px`)
  rules.push(`:root:root{${vars.join(';')}}`)

  /* Was an override of `--font-weight-light`, which stopped working when the
   * three sites landed on `font-medium`. Overriding `--font-weight-medium`
   * instead would drag all 54 `font-medium` elements along, so this names the
   * sites: the transcript markdown body, and the composer's input + placeholder
   * (which share `text-base`/`leading-normal` and nothing else does). */
  rules.push(
    `.font-sans.font-medium,.text-base.font-medium.leading-normal{font-weight:${k.weight} !important}`,
  )

  for (const [cls, hex] of GREYS) {
    rules.push(`.${cls}{color:${lighten(hex, k.lift)} !important}`)
  }

  rules.push(
    `body{-webkit-font-smoothing:${k.smoothing ? 'antialiased' : 'auto'} !important}`,
  )

  /* The transcript list and the composer BOTH carry `max-w-[1000px]`, which is
   * what keeps them aligned. One rule moves them together so further tuning
   * never desynchronises the two edges. */
  rules.push(`.max-w-\\[1000px\\]{max-width:${k.colWidth}px !important}`)

  /* Message prose only. Widening the column should let tool rows, diffs and
   * code blocks use the space WITHOUT stretching the reading measure past a
   * comfortable line length, so prose keeps its own cap. `.font-sans` narrows
   * this to the transcript markdown body: the composer is `font-medium` too but
   * carries no `font-sans`. */
  rules.push(`.font-sans.font-medium{max-width:${k.proseWidth}px}`)

  // DM Mono ships 400 and 500 only, so 600/700 render as synthetic bold.
  if (k.capMono) {
    rules.push(
      '.font-mono.font-semibold,.font-mono.font-bold{font-weight:500 !important}',
    )
  }

  return rules.join('\n')
}

function readStored(): Knobs {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    if (!raw) return DEFAULTS
    const parsed: unknown = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) return DEFAULTS
    const to = (key: keyof Knobs, fallback: number) => {
      const v = (parsed as Record<string, unknown>)[key]
      return typeof v === 'number' && Number.isFinite(v) ? v : fallback
    }
    const flag = (key: keyof Knobs, fallback: boolean) => {
      const v = (parsed as Record<string, unknown>)[key]
      return typeof v === 'boolean' ? v : fallback
    }
    return {
      scale: to('scale', DEFAULTS.scale),
      floor: to('floor', DEFAULTS.floor),
      weight: to('weight', DEFAULTS.weight),
      lift: to('lift', DEFAULTS.lift),
      smoothing: flag('smoothing', DEFAULTS.smoothing),
      capMono: flag('capMono', DEFAULTS.capMono),
      colWidth: to('colWidth', DEFAULTS.colWidth),
      proseWidth: to('proseWidth', DEFAULTS.proseWidth),
    }
  } catch {
    return DEFAULTS
  }
}

export function TypeTuner() {
  const [open, setOpen] = useState(false)
  const [k, setK] = useState<Knobs>(readStored)

  useEffect(() => {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(k))
    } catch {
      // A full or blocked localStorage must not take the panel down.
    }
  }, [k])

  const set = <K extends keyof Knobs>(key: K, value: Knobs[K]) =>
    setK(prev => ({ ...prev, [key]: value }))

  const summary = `scale ${k.scale.toFixed(2)} · floor ${k.floor}px · prose weight ${k.weight} · grey lift ${Math.round(k.lift * 100)}% · column ${k.colWidth}px · prose measure ${k.proseWidth >= k.colWidth ? 'full' : `${k.proseWidth}px`} · smoothing ${k.smoothing ? 'antialiased' : 'auto'} · mono cap ${k.capMono ? 'on' : 'off'}`

  return (
    <>
      <style>{buildCss(k)}</style>
      <div className="fixed bottom-3 right-3 z-[9999] font-mono text-[11px]">
        {open ? (
          <div className="w-64 rounded-lg border border-white/15 bg-[#141417] p-3 text-[#e4e4e7] shadow-xl">
            <div className="mb-2 flex items-center justify-between">
              <span className="font-semibold tracking-wide">Type tuner</span>
              <button
                type="button"
                onClick={() => setOpen(false)}
                className="rounded px-1.5 py-0.5 text-[#a1a1aa] hover:bg-white/10"
              >
                close
              </button>
            </div>

            <Slider
              label="Size scale"
              value={k.scale}
              min={0.85}
              max={1.5}
              step={0.01}
              format={v => `${v.toFixed(2)}x`}
              onChange={v => set('scale', v)}
            />
            <Slider
              label="Smallest size"
              value={k.floor}
              min={8}
              max={16}
              step={0.5}
              format={v => `${v}px`}
              onChange={v => set('floor', v)}
            />
            <Slider
              label="Message + composer weight"
              value={k.weight}
              min={200}
              max={600}
              step={50}
              format={v => `${v}${WEIGHT_NAMES[v] ? ` ${WEIGHT_NAMES[v]}` : ''}`}
              onChange={v => set('weight', v)}
            />
            <Slider
              label="Grey lift"
              value={k.lift}
              min={0}
              max={0.6}
              step={0.02}
              format={v => `${Math.round(v * 100)}%`}
              onChange={v => set('lift', v)}
            />

            <Slider
              label="Transcript width"
              value={k.colWidth}
              min={600}
              max={1600}
              step={20}
              format={v => `${v}px`}
              onChange={v => set('colWidth', v)}
            />
            <Slider
              label="Message text width"
              value={k.proseWidth}
              min={600}
              max={1600}
              step={20}
              format={v => (v >= k.colWidth ? 'same as above' : `${v}px`)}
              onChange={v => set('proseWidth', v)}
            />

            <Toggle
              label="Font smoothing: antialiased"
              checked={k.smoothing}
              onChange={v => set('smoothing', v)}
            />
            <Toggle
              label="Cap mono weight at 500"
              checked={k.capMono}
              onChange={v => set('capMono', v)}
            />

            <div className="mt-2 flex items-center gap-2 border-t border-white/10 pt-2">
              <button
                type="button"
                onClick={() => setK(DEFAULTS)}
                className="rounded border border-white/15 px-2 py-1 text-[10px] text-[#a1a1aa] hover:bg-white/10"
              >
                reset
              </button>
              <button
                type="button"
                onClick={() => void navigator.clipboard?.writeText(summary)}
                className="rounded border border-white/15 px-2 py-1 text-[10px] text-[#a1a1aa] hover:bg-white/10"
              >
                copy settings
              </button>
            </div>

            <p className="mt-2 select-all text-[9.5px] leading-relaxed text-[#a1a1aa]">
              {summary}
            </p>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setOpen(true)}
            className="rounded-full border border-white/15 bg-[#141417] px-2.5 py-1 text-[#a1a1aa] shadow-lg hover:text-[#e4e4e7]"
          >
            Aa
          </button>
        )}
      </div>
    </>
  )
}

function Slider(props: {
  label: string
  value: number
  min: number
  max: number
  step: number
  format: (v: number) => string
  onChange: (v: number) => void
}) {
  return (
    <label className="mb-2 block">
      <span className="flex items-center justify-between text-[10px] text-[#a1a1aa]">
        {props.label}
        <span className="text-[#e4e4e7]">{props.format(props.value)}</span>
      </span>
      <input
        type="range"
        className="mt-1 w-full accent-[#f472b6]"
        min={props.min}
        max={props.max}
        step={props.step}
        value={props.value}
        onChange={e => props.onChange(Number(e.currentTarget.value))}
      />
    </label>
  )
}

function Toggle(props: {
  label: string
  checked: boolean
  onChange: (v: boolean) => void
}) {
  return (
    <label className="mb-1.5 flex items-center gap-2 text-[10px] text-[#a1a1aa]">
      <input
        type="checkbox"
        className="accent-[#f472b6]"
        checked={props.checked}
        onChange={e => props.onChange(e.currentTarget.checked)}
      />
      {props.label}
    </label>
  )
}
