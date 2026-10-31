import { expect, test } from 'bun:test'
import { Window } from 'happy-dom'
import { installLocalFormTracking } from './localhostFormIntent.js'

test('actual submit events honor submitter overrides without treating omitted overrides as defaults', async () => {
  const window = new Window({ url: 'http://localhost:4000/page' })
  try {
    window.document.body.innerHTML = `<form action="/form-target" method="get">
      <button id="plain">Plain</button>
      <button id="post" formmethod="post" formaction="/post-target">Post</button>
      <input id="input" type="submit" formmethod="post" formaction="/input-target">
      <button id="get" formmethod="get" formaction="/get-target">Get</button>
    </form>`
    window.eval(`window.tracker={form:null};(${installLocalFormTracking.toString()})(window.tracker)`)
    const tracker = (window as unknown as { tracker: { form: unknown } }).tracker
    const form = window.document.querySelector('form')!
    form.addEventListener('submit', event => event.preventDefault())
    form.requestSubmit(window.document.querySelector('#post') as never)
    expect(tracker.form).toEqual({ url: 'http://localhost:4000/post-target', method: 'POST' })
    form.requestSubmit(window.document.querySelector('#input') as never)
    expect(tracker.form).toEqual({ url: 'http://localhost:4000/input-target', method: 'POST' })
    form.requestSubmit(window.document.querySelector('#plain') as never)
    expect(tracker.form).toEqual({ url: 'http://localhost:4000/form-target', method: 'GET' })
    form.method = 'post'
    form.requestSubmit(window.document.querySelector('#get') as never)
    expect(tracker.form).toEqual({ url: 'http://localhost:4000/get-target', method: 'GET' })
    form.requestSubmit()
    expect(tracker.form).toEqual({ url: 'http://localhost:4000/form-target', method: 'POST' })
  } finally { await window.happyDOM.close() }
})
