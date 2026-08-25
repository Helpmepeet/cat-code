import { expect, test } from 'bun:test'
import { renderToStaticMarkup } from 'react-dom/server'
import { ProseArrivalPreview } from './ProseArrivalPreview.js'
import { ProseArrivalProvider } from './ProseArrivalProvider.js'
import { ProseArrivalContext } from './proseArrival.js'
import type { ProseArrival } from './proseArrival.js'

function render(arrival?: ProseArrival) {
  if (arrival === undefined) {
    return renderToStaticMarkup(
      <ProseArrivalProvider storage={null}>
        <ProseArrivalPreview />
      </ProseArrivalProvider>,
    )
  }
  return renderToStaticMarkup(
    <ProseArrivalContext.Provider value={{ arrival, setArrival: () => {} }}>
      <ProseArrivalPreview />
    </ProseArrivalContext.Provider>,
  )
}

test('the preview renders the settled sample before anything plays', () => {
  // Effects do not run under static rendering, so this is the pre-playback
  // frame: real text, not an empty box the operator would see flash on open.
  const html = render()
  const text = html.replace(/<[^>]*>/g, '')
  expect(text).toContain('The loader resolves each entry')
  expect(text).toContain('ist is consumed.'.trim().slice(-16))
})

test('the settled frame carries no arrival marking', () => {
  // Nothing has "just arrived" until the loop starts, so marking here would
  // animate on every open of the Settings pane.
  for (const arrival of ['instant', 'smooth', 'flowing'] as const) {
    expect(render(arrival)).not.toContain('prose-arrive')
  }
})

test('the canvas is a fixed height, so playing does not move the picker', () => {
  // The sample grows while it plays. A canvas sized to its content would pump
  // every settings row below it up and down on each loop.
  expect(render()).toContain('h-[92px]')
  expect(render()).toContain('overflow-hidden')
})

test('the sample is keyed by option, so switching restarts the delivery', () => {
  // Without the key, changing the picker would apply the new timing only from
  // the next chunk, and the operator would judge a blend of both.
  const smooth = render('smooth')
  const flowing = render('flowing')
  expect(smooth).toContain('prose-arrival-preview:smooth')
  expect(flowing).toContain('prose-arrival-preview:flowing')
})
