import { expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { renderToStaticMarkup } from 'react-dom/server'
import { PROTOCOL_VERSION, type ServerFrame } from '../../shared/protocol.js'
import { layoutBrowser, runLayoutBrowser } from './layoutBrowser.testSupport.js'
import { SessionPane } from './SessionPane.js'
import { idleSessionPaneProps } from './sessionPaneTestProps.js'
import { TranscriptModeContext } from './transcriptMode.js'
import { TRANSCRIPT_OUTLINE_MIN_PROMPTS } from './transcriptOutlineModel.js'
import { createTranscriptState, projectServerFrame } from './transcriptProjector.js'

const css = (file: string) => readFileSync(new URL(file, import.meta.url), 'utf8')

test.skipIf(!layoutBrowser)('the narrow outline clears the full Focused hit targets and takes space only when present', () => {
  const scratch = mkdtempSync(join(tmpdir(), 'outline-lane-'))
  try {
    const props = idleSessionPaneProps()
    const sessionId = props.activeSessionId!
    const engineSessionId = 'outline-layout'
    let transcript = projectServerFrame(createTranscriptState(), {
      kind: 'ready', protocolVersion: PROTOCOL_VERSION, sessionId, engineSessionId,
      payload: { type: 'app.ready', protocolVersion: 1, inputEnabled: true, activeTurn: false,
        abort: { status: 'idle' }, goalSnapshot: null, pendingPermissionRequests: [] },
    } as ServerFrame)
    const message = (type: 'user' | 'assistant', uuid: string, content: unknown) => {
      transcript = projectServerFrame(transcript, {
        kind: 'event', protocolVersion: PROTOCOL_VERSION, sessionId,
        event: { type: 'message', message: { type, uuid, session_id: engineSessionId,
          parent_tool_use_id: null, message: { role: type, id: uuid, content } } },
      } as ServerFrame)
    }
    for (let index = 0; index < TRANSCRIPT_OUTLINE_MIN_PROMPTS; index++) {
      message('user', `prompt-${index}`, 'Check the loader')
      if (index !== 0) continue
      message('assistant', 'call', [{ type: 'tool_use', id: 'read', name: 'Read', input: { file_path: '/repo/loader.ts' } }])
      message('user', 'tool-result', [{ type: 'tool_result', tool_use_id: 'read', content: 'Fixture output' }])
    }
    const html = renderToStaticMarkup(<TranscriptModeContext.Provider value={{ mode: 'focused', setMode() {} }}>
      <SessionPane {...props} transcript={transcript} queuedPrompts={[{ id: 'queued', text: 'Waiting message' }]}
        recoveredPrompts={[{ id: 'recovered', text: 'Recovered message' }]} />
    </TranscriptModeContext.Provider>)
    const file = join(scratch, 'fixture.html')
    writeFileSync(file, `<!doctype html><meta charset="utf-8"><style>
      /* Stand in for the Tailwind utilities used by these column wrappers. */
      @layer utilities {
        * { box-sizing: border-box }
        .relative { position: relative }
        .mx-auto { margin-inline: auto }
        .w-full { width: 100% }
        .px-8 { padding-inline: 32px }
        [class*="max-w-[var(--transcript-width)]"] { max-width: var(--transcript-width) }
      }
      :root { --transcript-width: 900px }
      .session-transcript-region { height: 520px }
      .session-transcript-scroll { height: 100%; overflow: auto }
      .transcript-outline-rail { --outline-ideal-height: 500px }
      .transcript-outline-tick { --outline-tick-height: 10px }
      *, *::before { transition: none !important }
      ${css('./focusedTranscript.css')}
      ${css('./transcriptOutline.css')}
    </style><div id="pane">${html}</div><pre id="result"></pre>
    <script>
      const q = selector => document.querySelector(selector);
      window.addEventListener('error', event => { q('#result').textContent = JSON.stringify({ error: event.message }); });
      const pane = q('#pane'), region = q('.session-transcript-region'), outline = q('.transcript-outline');
      const rail = q('.transcript-outline-rail'), tick = q('.transcript-outline-tick');
      const column = q('.workspace-transcript-column'), fold = q('.focused-fold-head'), step = q('.focused-step-head');
      const queue = q('[aria-label="Send next queued message now"]').closest('[class*="max-w-"]');
      const recovered = q('[aria-label="Recovered inputs for review"]');
      for (const disclosure of document.querySelectorAll('.focused-disclosure')) disclosure.setAttribute('data-open', '');
      tick.dataset.distance = '0';
      rail.children[1].dataset.distance = '1';
      tick.focus({ preventScroll: true });
      const rect = el => el.getBoundingClientRect();
      const reachable = head => {
        const { left, top, height } = rect(head);
        return head.contains(document.elementFromPoint(left + 1, top + height / 2));
      };
      const measure = width => {
        pane.style.width = width + 'px';
        const padding = el => parseFloat(getComputedStyle(el).paddingLeft);
        const railRight = rect(rail).right;
        return {
          top: rect(rail).top - rect(region).top,
          railLeft: rect(rail).left - rect(region).left,
          dashWidths: [tick, rail.children[1]].map(mark => getComputedStyle(mark, '::before').width),
          railClear: railRight < Math.min(rect(fold).left, rect(step).left),
          foldReachable: reachable(fold), stepReachable: reachable(step),
          padding: [column, queue, recovered].map(padding),
        };
      };
      const narrow = measure(480), wide = measure(1100);
      outline.remove();
      const withoutRail = measure(480);
      q('#result').textContent = JSON.stringify({ narrow, wide, withoutRail });
    </script>`)
    const run = runLayoutBrowser(file, join(scratch, 'profile'), 1240)
    const output = run.stdout.match(/<pre id="result">(.+?)<\/pre>/)?.[1]
    expect(output, run.diagnostics).toBeDefined()
    const { narrow, wide, withoutRail, error } = JSON.parse(output!)
    expect(error).toBeUndefined()
    expect(narrow).toEqual({ top: 16, railLeft: 2, dashWidths: ['14px', '12px'], railClear: true,
      foldReachable: true, stepReachable: true, padding: [56, 56, 56] })
    expect(wide).toEqual({ top: 16, railLeft: 10, dashWidths: ['28px', '21px'], railClear: true,
      foldReachable: true, stepReachable: true, padding: [32, 32, 32] })
    expect(withoutRail.padding).toEqual([32, 32, 32])
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}, 25_000)
