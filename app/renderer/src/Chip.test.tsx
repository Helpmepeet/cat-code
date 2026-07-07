import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { Chip, ChipStrip } from './Chip.js'
import { toneClasses, TONE_CLASSES, type Tone } from './tone.js'

test('every tone maps to its P0-2 token text class', () => {
  const expected: Record<Tone, string> = {
    default: 'text-text-muted',
    accent: 'text-accent',
    warn: 'text-tone-warn',
    danger: 'text-tone-danger',
    good: 'text-tone-good',
    info: 'text-tone-info',
  }
  for (const tone of Object.keys(expected) as Tone[]) {
    expect(toneClasses(tone).text).toBe(expected[tone])
  }
})

test('the hover tint bakes the hover: variant in as a literal (JIT-safe)', () => {
  // Runtime-prefixing `hover:` onto softBg would defeat Tailwind's JIT; the
  // literal must already carry it.
  for (const tone of Object.keys(TONE_CLASSES) as Tone[]) {
    expect(TONE_CLASSES[tone].hoverTint).toContain('hover:')
  }
})

test('a chip paints its tone text and shows value + badge', () => {
  const html = renderToStaticMarkup(
    <Chip tone="danger" label="Errors" value="3" badge={3} />,
  )
  expect(html).toContain('text-tone-danger')
  expect(html).toContain('Errors')
  expect(html).toContain('3')
  // Badge is the inverse pill (solid tone fill, near-black text).
  expect(html).toContain('bg-tone-danger')
})

test('an active chip pins the tint; an inactive one is quiet with a hover tint', () => {
  const active = renderToStaticMarkup(
    <Chip tone="accent" label="Model" active />,
  )
  expect(active).toContain('bg-accent/10')

  const quiet = renderToStaticMarkup(<Chip tone="accent" label="Model" />)
  expect(quiet).toContain('bg-transparent')
  expect(quiet).toContain('hover:bg-accent/10')
})

test('ChipStrip interleaves · separators only between chips when separated', () => {
  const html = renderToStaticMarkup(
    <ChipStrip separated>
      <Chip label="a" />
      <Chip label="b" />
      <Chip label="c" />
    </ChipStrip>,
  )
  // Two separators for three chips (never a leading/trailing one).
  const separators = html.split('·').length - 1
  expect(separators).toBe(2)
})

test('ChipStrip without separated renders no dividers', () => {
  const html = renderToStaticMarkup(
    <ChipStrip>
      <Chip label="a" />
      <Chip label="b" />
    </ChipStrip>,
  )
  expect(html).not.toContain('·')
})
