import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { axisMetricsScript, designMetricsScript, profileMetricsScript, startPrototypeServer, typographyDeltas, evaluateAxisCollisions, evaluateDesign } from './visualAcceptanceMatrix.js'

/**
 * Assertions about what the code DOES must not read the comments explaining why
 * it does it. The driver's own header names `showInactive()` in order to rule it
 * out, and a naive substring check reads that as the call it forbids.
 */
function code(url: URL): string {
  return readFileSync(url, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
}

/**
 * The load-bearing property of this harness is NOT that it takes a picture. It is
 * that taking the picture never raises a window over whatever the operator is
 * doing: agent-driven GUI checking was banned here after repeated cursor warps
 * forced a machine restart (`docs/migration/process/GUI-VERIFICATION.md`).
 *
 * That property lives in two places, so both are pinned here: main must skip its
 * `show()` under the capture flag, and the driver must refuse to photograph a
 * window that turned out visible anyway.
 */
test('the capture run never shows the window', () => {
  const main = readFileSync(new URL('../main/main.ts', import.meta.url), 'utf8')

  // The gate itself, and the fact that ONLY the show is gated: readiness and the
  // post-paint scheduling below it must still run, or a capture photographs a
  // shell that never finished starting.
  expect(main).toContain("if (process.env.CATCODE_HEADLESS_CAPTURE !== '1') {\n      window.show()\n    }")
  expect(main.match(/window\.show\(\)/g) ?? []).toHaveLength(1)
  expect(main).toContain("logOperational('renderer.load.ready', 'info')")
  // F6 — the readiness latch used to log this same event a second time once
  // the renderer's own `rendererReady()` call fired, giving one document two
  // indistinguishable ready records (or a spurious rate_dedupe suppression).
  // `ready-to-show` is the sole writer now.
  expect(main.match(/logOperational\('renderer\.load\.ready', 'info'\)/g) ?? [])
    .toHaveLength(1)

  const driver = code(new URL('./visual-acceptance-driver.ts', import.meta.url))
  // Fail rather than quietly photograph a raised window: a silent capture here
  // would mean the gate regressed and nobody noticed.
  expect(driver).toContain('if (window.isVisible())')
  expect(driver).toContain('the capture-run show gate did not hold')
  // Neither way of putting a window on screen may appear in the driver's CODE.
  expect(driver).not.toContain('.show()')
  expect(driver).not.toContain('showInactive')
})

test('the capture run drives an isolated state directory, never the operator real one', () => {
  const source = readFileSync(new URL('./visual-acceptance.ts', import.meta.url), 'utf8')

  expect(source).toContain("mkdtempSync(join(tmpdir(), 'catcode-visual-config-'))")
  expect(source).toContain("mkdtempSync(join(tmpdir(), 'catcode-visual-cwd-'))")
  expect(source).toContain('CLAUDE_CONFIG_DIR: configHome')
  expect(source).toContain("CATCODE_HEADLESS_CAPTURE: '1'")
})

test('a blank frame fails the run instead of being written', () => {
  const driver = code(new URL('./visual-acceptance-driver.ts', import.meta.url))

  // An empty NativeImage written to disk is the failure mode that makes a whole
  // contact sheet worthless while every run still reports success.
  expect(driver).toContain('if (image.isEmpty())')
  expect(driver).toContain('capture produced no pixels')
  // Animations and the caret are why a screenshot differs from itself; frozen
  // once before the first frame, not per capture.
  expect(driver).toContain('animation:none!important')
  expect(driver).toContain('caret-color:transparent!important')
})

test('legacy usage shots target the current Analytics chart, pin, and activity states', () => {
  const driver = code(new URL('./visual-acceptance-driver.ts', import.meta.url))
  const daily = readFileSync(new URL('../renderer/src/UsageDailyChart.tsx', import.meta.url), 'utf8')
  const details = readFileSync(new URL('../renderer/src/UsageAnalyticsDetails.tsx', import.meta.url), 'utf8')
  for (const removed of ['.usage-panels', '.usage-activity-details', '.usage-heatmap']) expect(driver).not.toContain(removed)
  expect(daily).toContain('usage-chart usage-daily-svg')
  expect(daily).toContain('usage-daily-hit')
  expect(details).toContain('uad-chart uad-heatmap')
  expect(details).toContain('Ten-minute concurrency heatmap')
  expect(driver).toContain("document.querySelectorAll('.usage-daily-hit')[25]")
  expect(driver).toContain('Hourly tool request detail is unavailable')
  expect(driver).toContain('Ten-minute concurrency heatmap')
  expect(driver).toContain(`document.querySelector('[aria-label="Activity view"] button:nth-child(2)')`)
  expect(driver).not.toContain('.uad-controls[aria-label="Activity view"]')
  expect(driver).toContain("rect.top >= document.querySelector('.usage-sticky-top')")
  expect(driver.match(/name: 'usage-/g)).toHaveLength(7)
  expect(driver.match(/verify: `/g)).toHaveLength(7)
})

test('legacy native capture preserves the requested scene and completes through the supervised quit path', () => {
  const source = code(new URL('./visual-acceptance.ts', import.meta.url))
  const driver = code(new URL('./visual-acceptance-driver.ts', import.meta.url))
  expect(source).toContain("environment.CATCODE_CAPTURE_SCENE = process.env.CATCODE_CAPTURE_SCENE ?? ''")
  expect(driver).toContain("JSON.stringify({ ok: true, scene: process.env.CATCODE_CAPTURE_SCENE ?? '', captured })")
  expect(driver).not.toContain('app.exit(')
  expect(driver).toContain('app.quit()')
})
test('prototype server exposes only known read-only assets and closes its loopback listener', async () => {
  const server = await startPrototypeServer(fileURLToPath(new URL('../../', import.meta.url)))
  try {
    expect(server.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/)
    const page = await fetch(`${server.origin}/preview/harness.html?app=1&side=288&range=7d`)
    expect(page.status).toBe(200)
    expect(await page.text()).toContain('window.__ready = true')
    expect(page.headers.get('content-security-policy')).toContain("connect-src 'self'")
    expect(page.headers.get('content-security-policy')).toContain('https://cdnjs.cloudflare.com/ajax/libs/d3/7.9.0/d3.min.js')
    expect(page.headers.get('referrer-policy')).toBe('no-referrer')
    expect(page.headers.get('access-control-allow-origin')).toBeNull()
    expect((await fetch(`${server.origin}/page/cc.css`)).headers.get('content-type')).toContain('text/css')
    expect((await fetch(`${server.origin}/data/catcode-daily.json`)).status).toBe(200)
    for (const path of ['/package.json', '/page/../../CLAUDE.md', '/data/catcode-credentials.json', '/preview/no.html']) {
      expect((await fetch(server.origin + path)).status).toBe(404)
    }
    expect((await fetch(`${server.origin}/preview/harness.html`, { method: 'POST', body: 'not written' })).status).toBe(404)
  } finally {
    await server.close()
  }
  expect(await fetch(server.origin).then(() => false, () => true)).toBe(true)
})
test('matrix keeps app scene and lifecycle while adding isolated prototype comparisons', () => {
  const source = code(new URL('./visualAcceptanceMatrix.ts', import.meta.url))
  expect(source).toContain("for (const range of ['7d', '30d', 'all'])")
  expect(source).toContain("for (const glass of [false, true])")
  expect(source).toContain('widths.length * 12')
  expect(source).toContain('show: false')
  expect(source).toContain('sandbox: true, contextIsolation: true, nodeIntegration: false')
  expect(source).not.toContain('.show()')
  expect(source).not.toContain('.showInactive(')
  expect(source).not.toContain('.focus(')
  expect(source).toContain("prototype.on('show', () => { prototypeShown = true; prototype.destroy() })")
  expect(source).toContain("finally {\n    if (!prototype.isDestroyed()) prototype.destroy()\n    await server.close()")
  expect(source).toContain('prototype.setContentSize')
  expect(source).toContain('/preview/harness.html?app=1&side=288&range=')
  expect(source).toContain('webRequest.onBeforeRequest')
  expect(source).toContain('prototype-${name}-')
  expect(source).toContain('prototype-comparisons.json')
  expect(source).toContain('fidelity-interactions.json')
  expect(source).toContain('for (const contentWidth of [639, 640, 641, 759, 760, 761])')
  expect(source).toContain('prototype-thresholds.json')
  expect(source).toContain('interactions.length === 13 && fidelityInteractions.length === 9')
  const original = source.split('const hover = async')[0]
  expect(original.match(/await check\('/g)).toHaveLength(13)
  for (const label of ['Tool run latency row', 'hourly activity smooth profile', 'concurrency fixed level legend', 'model chip hover and off swatch', 'integration midpoint tooltip', 'session error meter and sort arrow', 'expanded session composition shares', 'daily line pinned rule', 'daily stacked tooltip total']) expect(source).toContain(`await check('${label}'`)
})
test('paired design measurement includes geometry fonts thresholds and interpreted rather than forced data equality', () => {
  for (const prototype of [false, true]) {
    const script = designMetricsScript(prototype)
    // Compile the actual expression, not just an explanatory comment.
    expect(() => new Function(`return ${script}`)).not.toThrow()
    for (const field of ['cardSamples', 'keyCards', 'gutters', 'sectionSpacing', 'summaryValues', 'sessionColumns', 'modelsColumns', 'sessionFigures', 'gridTemplateColumns', 'fontsReady', 'hero', 'inspectorTitle', 'inspectorStats', 'sectionTitles', 'trioValues', 'bigValues', 'summarySparks', 'sessionConstraints']) expect(script).toContain(field)
  }
  const source = code(new URL('./visualAcceptanceMatrix.ts', import.meta.url))
  expect(source).toContain('Values, chart Y domains, labels and data-dependent wrapping are not equality assertions.')
  expect(source).toContain('Prototype has no glass mode')
})
test('keyed typography deltas expose physical font drift and the fifth summary value', () => {
  const measured = (selector: string, size: number, width = 100, height = 28) => ({ selector, rect: { width, height }, style: { size: `${size}px`, weight: '680', lineHeight: 'normal', letterSpacing: '-.5px' } })
  const prototype = {
    hero: measured('#x-total', 38.5),
    sectionTitles: { sessions: measured('#sessions h2', 17.5) },
    trioValues: { sessions: measured('#sessions .cc-stat-value', 21) },
    bigValues: { skills: measured('#skills-card .cc-big', 28) },
    summaryValues: { latestBuild: measured('.cc-build-rate', 19.25) },
    summarySparks: { requests: measured('#spark-requests', 14, 63, 28) },
  }
  const app = structuredClone(prototype)
  app.sectionTitles.sessions.style.size = '20px'
  app.trioValues.sessions.style.size = '24px'
  app.bigValues.skills.style.size = '32px'
  app.summaryValues.latestBuild.style.size = '22px'
  app.summarySparks.requests.rect.width = 72
  const deltas = typographyDeltas(app, prototype)
  expect(deltas.sectionTitles.sessions.size).toBe(2.5)
  expect(deltas.trioValues.sessions.size).toBe(3)
  expect(deltas.bigValues.skills.size).toBe(4)
  expect(deltas.summaryValues.latestBuild.size).toBe(2.75)
  expect(deltas.summaryValues.latestBuild.missing).toEqual({ app: false, prototype: false })
  expect(deltas.summarySparks.requests.width).toBe(9)
  expect(deltas.hero.lineHeight).toBeNull()
  const prototypeScript = designMetricsScript(true), appScript = designMetricsScript(false)
  expect(prototypeScript).toContain("'.cc-build-rate'")
  expect(appScript).toContain("'.usage-metric-errorRate .usage-metric-row > strong'")
  expect(appScript).toContain("latestBuild:'.usage-build-chart'")
  expect(typographyDeltas({ hero: measured('.hero', 28) }, { hero: { selector: '#missing', rect: null, style: null } }).hero.missing.prototype).toBe(true)
});

function designFixture(): Record<string, any> {
  const node = (size = 14, width = 100, height = 30, x = 316) => ({ selector: '.fixture', rect: { x, y: 0, width, height }, style: { size: `${size}px`, weight: '400', radius: '14px', padding: '20px', gap: '14px' } })
  const values = (keys: string[], size: number) => Object.fromEntries(keys.map(key => [key, node(size)]))
  const spanCards = Object.fromEntries([['daily', 8, 0], ['inspector', 4, 8], ['cache', 8, 0], ['cacheModels', 4, 8]].map(([key, span, offset]) => [key, node(14, (1092 + 14) * Number(span) / 12 - 14, 500, 316 + (1092 + 14) * Number(offset) / 12)]))
  const metrics = {
    heading: node(20), content: { x: 316, width: 1092 }, gutters: { left: 28, right: 28 }, range: '7d',
    summaryLayout: Object.fromEntries(['requests', 'sessions', 'cache', 'toolErrors'].map(key => [key, { value: node(22.75, 42, 25, 333), spark: node(14, 63, 28, 383) }])),
    integrationHeaderGaps: Object.fromEntries(['skills', 'integrations'].map(key => [key, { header: { y: 0, height: 40 }, total: { y: 10, height: 30 }, chart: { y: 56, height: 220 }, qualifiers: [], headerToChart: 16, totalToChart: 16 }])),
    typography: {
      hero: node(38.5), inspectorTitle: node(17.5),
      inspectorStats: values(['requests', 'sessions', 'peak', 'tokens', 'cache', 'toolErrors'], 16.625),
      sectionTitles: values(['cache', 'activity', 'models', 'sessions', 'extensions', 'reliability'], 17.5),
      trioValues: values(['sessions', 'top10', 'subagents', 'compaction', 'median', 'cacheServed', 'cacheFresh', 'callsSucceeded', 'callsFailed', 'callsRetried', 'autoDecisions', 'autoReview', 'autoBlocked'], 21),
      bigValues: values(['skills', 'integrations'], 28),
      summaryValues: values(['requests', 'sessions', 'cache', 'toolErrors', 'latestBuild'], 22.75),
      sessionNumbers: values(['tokens', 'errors'], 12),
    },
    keyCards: values(['daily', 'sessions', 'skills', 'integrations'], 14),
    summaryCards: values(['requests', 'sessions', 'cache', 'toolErrors', 'latestBuild'], 14),
    spanCards,
    layoutGroups: values(['summary', 'daily', 'cache', 'integrations', 'figures'], 14),
    fixedCharts: { cache: node(14, 500, 210), skills: node(14, 500, 220), integrations: node(14, 500, 220) },
    axisLabels: Object.fromEntries(['daily', 'cache', 'skills', 'integrations', 'activity', 'builds'].map(key => [key, { rendered: true, unavailable: false, labels: [{ text: 'Oct 1', rect: { x: 100, y: 200, width: 32, height: 14 } }, { text: 'Oct 18', rect: { x: 200, y: 200, width: 35, height: 14 } }] }])),
    unavailable: {},
  }
  metrics.layoutGroups.figures!.style.gap = '12px'
  metrics.typography.summaryValues.latestBuild!.style.size = '19.25px'
  return metrics
}

test('design gate rejects +3.25px summary typography drift, including latest build', () => {
  const reference = designFixture(), app = structuredClone(reference)
  expect(evaluateDesign(app, reference)).toEqual([])
  for (const value of Object.values(app.typography.summaryValues) as any[]) value.style.size = `${parseFloat(value.style.size) + 3.25}px`
  const failures = evaluateDesign(app, reference)
  expect(failures).toHaveLength(5)
  expect(failures.some(failure => failure.path === 'typography.summaryValues.latestBuild.fontSize')).toBe(true)
  expect(failures.every(failure => failure.tolerance === .1)).toBe(true)
  const source = code(new URL('./visualAcceptanceMatrix.ts', import.meta.url))
  expect(source).toContain('designFailures: evaluateDesign(appMetrics, prototypeMetrics)')
  expect(source).toContain('designFailures.length === 0')
  expect(source).toContain("'design-failures.json'")
  expect(source).toContain('state: comparison.name')
})

test('design gate requires stable nodes and accepts only explicit data-unavailable exceptions', () => {
  const reference = designFixture(), app = structuredClone(reference)
  delete app.typography.summaryValues.latestBuild
  delete app.typography.sectionTitles.sessions
  delete app.fixedCharts.integrations
  expect(evaluateDesign(app, reference).map(f => f.path)).toEqual(expect.arrayContaining(['typography.summaryValues.latestBuild', 'typography.sectionTitles.sessions', 'fixedCharts.integrations']))
  app.unavailable.integrations = true
  delete app.typography.trioValues.callsFailed
  app.unavailable.calls = true
  const paths = evaluateDesign(app, reference).map(f => f.path)
  expect(paths).not.toContain('fixedCharts.integrations')
  expect(paths).not.toContain('typography.trioValues.callsFailed')
  expect(paths).toContain('typography.summaryValues.latestBuild')
  expect(evaluateDesign({}, {}).length).toBeGreaterThan(20)
})

test('design gate checks physical card edges, grid gaps and approved scrollbar inset', () => {
  const reference = designFixture(), app = structuredClone(reference)
  app.gutters.right += 4
  app.keyCards.daily.style.padding = '20px 20px'
  expect(evaluateDesign(app, reference)).toEqual([])
  app.keyCards.sessions.style.radius = '12px'
  app.summaryCards.latestBuild.style.padding = '14px 20px'
  app.layoutGroups.figures.style.gap = '16px'
  app.gutters.right += 1
  const paths = evaluateDesign(app, reference).map(f => f.path)
  for (const prefix of ['keyCards.sessions.radius', 'summaryCards.latestBuild.padding', 'layoutGroups.figures.gap', 'gutters.right']) expect(paths.some(path => path.startsWith(prefix))).toBe(true)
})

test('design gate tolerances reject fixed chart and wide 8/4 span drift', () => {
  const reference = designFixture(), app = structuredClone(reference)
  app.fixedCharts.cache.rect.height += 1
  app.fixedCharts.integrations.rect.height += 1
  app.typography.hero.style.size = '38.6px'
  expect(evaluateDesign(app, reference)).toEqual([])
  app.fixedCharts.cache.rect.height += .1
  app.fixedCharts.skills.rect.height = 222
  app.spanCards.daily.rect.width -= 4.66
  app.spanCards.inspector.rect.x -= 4.66
  const paths = evaluateDesign(app, reference).map(f => f.path)
  expect(paths).toContain('fixedCharts.cache.height')
  expect(paths).toContain('fixedCharts.skills.height')
  expect(paths).toContain('spanCards.daily.app.width')
  expect(paths).toContain('spanCards.inspector.app.offset')
})

test('design gate does not police data stretch, line counts, values, surfaces or summary breakpoint', () => {
  const reference = designFixture(), app = structuredClone(reference)
  app.content.height = 99999
  for (const card of [...Object.values(app.keyCards), ...Object.values(app.spanCards), ...Object.values(app.summaryCards)] as any[]) {
    card.rect.height *= 3
    card.style.color = 'pink'
    card.style.background = 'transparent'
    card.style.lineHeight = 'normal'
  }
  app.summary = { rect: { height: 300 }, style: { columns: 'four cards plus one', lineHeight: '28px' } }
  app.values = [1, 2, 3]
  app.visibleSeries = ['different']
  app.statusText = 'Partial retained history.'
  expect(evaluateDesign(app, reference)).toEqual([])
  reference.content.width = app.content.width = 730
  app.spanCards.daily.rect.width = 730
  app.spanCards.inspector.rect.x = 316
  expect(evaluateDesign(app, reference)).toEqual([])
})
test('physical axis collision gate catches clustered right-edge dates and concurrency/build labels', () => {
  const baseline = designFixture(), app = structuredClone(baseline)
  app.axisLabels.integrations.labels = [
    { text: 'Oct 11', rect: { x: 773, y: 4245, width: 29, height: 14.5 } },
    { text: 'Oct 12', rect: { x: 779, y: 4245, width: 32, height: 14.5 } },
    { text: 'Oct 18', rect: { x: 807, y: 4245, width: 32, height: 14.5 } },
  ]
  app.axisLabels.activity.labels[1].rect.x = 110
  app.axisLabels.builds.labels[1].rect.x = 120
  const failures = evaluateDesign(app, baseline)
  for (const key of ['integrations', 'activity', 'builds']) expect(failures.some(f => f.path === `axisLabels.${key}` && f.reason === 'Bottom-axis labels collide')).toBe(true)
  expect(evaluateAxisCollisions(baseline.axisLabels)).toEqual([])
  const source = code(new URL('./visualAcceptanceMatrix.ts', import.meta.url))
  expect(source).toContain('const axisLabels = await js(axisMetricsScript())')
  expect(source).toContain('assertionPassed && designFailures.length === 0')
  expect(source).toContain('state: `interaction:${item.label}`')
})
test('axis gate tolerates 1px rounding, separated rows and explicit unavailable data, not missing measurements', () => {
  const app = designFixture()
  app.axisLabels.daily.labels[1].rect.x = 131
  expect(evaluateAxisCollisions(app.axisLabels)).toEqual([])
  app.axisLabels.daily.labels[1].rect.x = 130
  expect(evaluateAxisCollisions(app.axisLabels).some(f => f.path === 'axisLabels.daily')).toBe(true)
  app.axisLabels.daily.labels[1].rect.y = 220
  expect(evaluateAxisCollisions(app.axisLabels)).toEqual([])
  app.axisLabels.activity = { rendered: false, labels: [], unavailable: true }
  expect(evaluateAxisCollisions(app.axisLabels)).toEqual([])
  delete app.axisLabels.activity
  expect(evaluateAxisCollisions(app.axisLabels).some(f => f.path === 'axisLabels.activity')).toBe(true)
  const script = axisMetricsScript()
  expect(() => new Function(`return ${script}`)).not.toThrow()
  expect(script).toContain('.uad-x-axis-label,.uas-x-axis-label,.usage-x-axis-label')
  expect(script).toContain("e.closest('svg')!==svg")
  expect(script).toContain('.uad-tooltip,.usage-daily-tooltip,.uas-tip-position')
  expect(script).toContain('.usage-chart-annotation,.uad-build-label,.cc-peak')
})
test('native axis measurement excludes y ticks, annotations and nested tooltip SVG text', () => {
  let texts: any[] = []
  const svg = {
    viewBox: { baseVal: { height: 220 } }, height: { baseVal: { value: 220 } },
    getBoundingClientRect: () => ({ width: 500, height: 220 }),
    querySelector: () => null, querySelectorAll: () => texts,
  }
  const text = (label: string, y: number, kind = 'axis') => ({
    textContent: label, getAttribute: () => String(y),
    getBoundingClientRect: () => ({ x: 100, y, width: 30, height: 14 }),
    closest: (selector: string) => selector === 'svg' ? kind === 'nested' ? {} : svg : kind === 'tooltip' ? {} : null,
    matches: (selector: string) => kind === 'annotation' && selector.includes('.usage-chart-annotation'),
  })
  texts = [text('Oct 1', 214), text('0', 194, 'y'), text('peak', 214, 'annotation'), text('Oct 1 total', 214, 'tooltip'), text('nested', 214, 'nested')]
  const run = new Function('document', 'getComputedStyle', `return ${axisMetricsScript()}`)
  const measured = run({ querySelector: (selector: string) => selector === '.usage-daily-svg' ? svg : null }, () => ({ display: 'block', visibility: 'visible', opacity: '1' }))
  expect(measured.daily.labels.map((label: any) => label.text)).toEqual(['Oct 1'])
});
test('required keyed font weights fail independently without comparing row-array positions', () => {
  const prototype = designFixture(), app = structuredClone(prototype)
  prototype.typography.sessionNumbers.tokens.style.weight = '600'
  prototype.typography.sessionNumbers.errors.style.weight = '600'
  const failures = evaluateDesign(app, prototype)
  expect(failures.filter(f => f.path.endsWith('.fontWeight')).map(f => f.path)).toEqual(['typography.sessionNumbers.tokens.fontWeight', 'typography.sessionNumbers.errors.fontWeight'])
  app.typography.sessionNumbers.tokens.style.weight = '600'
  app.typography.sessionNumbers.errors.style.weight = '600'
  app.heading.style.weight = 'normal'
  expect(evaluateDesign(app, prototype)).toEqual([])
  app.typography.bigValues.skills.style.weight = '700'
  expect(evaluateDesign(app, prototype).some(f => f.path === 'typography.bigValues.skills.fontWeight')).toBe(true)
})
test('integration header gate catches the missing 16px gap but records qualification states without false failure', () => {
  const prototype = designFixture(), app = structuredClone(prototype)
  app.integrationHeaderGaps.skills.totalToChart = 0
  app.integrationHeaderGaps.skills.headerToChart = 0
  expect(evaluateDesign(app, prototype).filter(f => f.path.startsWith('integrationHeaderGaps.skills.'))).toHaveLength(2)
  app.integrationHeaderGaps.skills.qualifiers = ['Partial retained history.']
  expect(evaluateDesign(app, prototype)).toEqual([])
  app.integrationHeaderGaps.skills.qualifiers = []
  app.range = '30d'
  expect(evaluateDesign(app, prototype)).toEqual([])
  const script = designMetricsScript(false)
  for (const field of ['summaryLayout', 'alignItems', 'justifyItems', 'justifyContent', 'alignSelf', 'justifySelf', 'sparkSvg', 'headerToChart', 'totalToChart']) expect(script).toContain(field)
  expect(script).toContain('summaryKeys.slice(0,4)')
})
test('summary spark gate accepts intrinsic 8px gaps at wide and narrow sizes without equating values', () => {
  for (const width of [1092, 552]) {
    const reference = designFixture(), app = structuredClone(reference)
    reference.content.width = app.content.width = width
    for (const key of ['requests', 'sessions', 'cache', 'toolErrors']) {
      app.summaryLayout[key].value.rect.width = 55
      app.summaryLayout[key].spark.rect.x = 333 + 55 + 8
    }
    app.summaryLayout.latestBuild = { value: { rect: null }, spark: { rect: null } }
    expect(evaluateDesign(app, reference)).toEqual([])
    app.summaryLayout.requests.spark.rect.x = 333 + 55 + 83
    const failures = evaluateDesign(app, reference)
    expect(failures).toHaveLength(1)
    expect(failures[0]).toMatchObject({ path: 'summaryLayout.requests.app.sparkToValueGap', actual: 83, expected: 8, tolerance: .1 })
    app.summaryLayout.requests.spark.rect.x = 333 + 55 + 8.1
    expect(evaluateDesign(app, reference)).toEqual([])
    app.summaryLayout.requests.spark.rect.x = 333 + 55 + 8.2
    expect(evaluateDesign(app, reference).some(f => f.path.endsWith('sparkToValueGap'))).toBe(true)
  }
})
test('native profile evidence records computed gradient stops without adding an ink equality gate', () => {
  expect(() => new Function(`return ${profileMetricsScript}`)).not.toThrow()
  for (const field of ['stopColor', 'stopOpacity', 'lineStroke', 'fontFamily', 'fontSize', 'fontWeight']) expect(profileMetricsScript).toContain(field)
  expect(designMetricsScript(false)).toContain('activityProfile:')
  expect(code(new URL('./visualAcceptanceMatrix.ts', import.meta.url))).toContain('profileAppearance:')
  const reference = designFixture(), app = structuredClone(reference)
  app.activityProfile = { stops: [{ stopColor: 'pink' }] }
  expect(evaluateDesign(app, reference)).toEqual([])
})
