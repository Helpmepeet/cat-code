import { expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Run the Electron mock in a child so its module binding cannot leak into other suites.
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'browser-renderer-start-'))
  const source = `
    import { mock } from 'bun:test';
    import { strict as assert } from 'node:assert';
    import { EventEmitter } from 'node:events';
    const events = [];
    const bounds = [];
    const visibility = [];
    let failBounds = false, failVisible = false;
    let started = false;
    let activeIndex = 0;
    const historyEntries = [{ id: 11, url: 'http://localhost:3000/same' }, { id: 12, url: 'http://localhost:3000/same' }];
    class Image {
      constructor(width, height, scale = 1) { this.width = width; this.height = height; this.scale = scale; }
      getSize() { return { width: this.width, height: this.height }; }
      resize({width, height}) { return new Image(width, height, this.scale); }
      toPNG() {
        const png = Buffer.alloc(24);
        png.writeUInt32BE(this.width * this.scale, 16);
        png.writeUInt32BE(this.height * this.scale, 20);
        return png;
      }
    }
    class Contents extends EventEmitter {
      debugger = Object.assign(new EventEmitter(), {
        attach() {},
        async sendCommand(method) {
          events.push(method);
          if (!started) throw new Error('CDP page command sent before renderer startup');
          if (method === 'Page.getNavigationHistory') return { currentIndex: activeIndex, entries: historyEntries };
          return {};
        },
      });
      async loadURL(url) { events.push('load:' + url); started = true; }
      navigationHistory = {
        goToIndex: index => { events.push('index:' + index); activeIndex = index; this.emit('did-finish-load'); },
        canGoBack: () => activeIndex > 0,
        canGoForward: () => activeIndex < historyEntries.length - 1,
      };
      async capturePage() { return new Image(1400, 1400, 2); }
      getURL() { return 'about:blank'; }
      setWindowOpenHandler() {}
      isDestroyed() { return false; }
      close() {}
    }
    const partition = new Proxy({ protocol: { handle() {} }, webRequest: { onBeforeRequest() {} } }, {
      get(target, key) { return target[key] ?? (() => {}); },
    });
    mock.module('electron', () => ({
      app: { getPath: () => process.env.BROWSER_RENDERER_TEST_ROOT },
      protocol: { registerSchemesAsPrivileged() {} },
      session: { fromPartition: () => partition },
      nativeImage: { createFromBuffer: (png, options) => new Image(png.readUInt32BE(16), png.readUInt32BE(20), options?.scaleFactor ?? 1) },
      WebContentsView: class {
        webContents = new Contents();
        setBounds(rect) { bounds.push(rect); if (failBounds) throw new Error('bounds failed'); }
        setVisible(value) { visibility.push(value); if (failVisible) throw new Error('visible failed'); }
      },
    }));
    const { createBrowserPaneElectronAdapter, createBrowserPanePresentationNative } = await import(${JSON.stringify(new URL('./browserPaneElectron.ts', import.meta.url).pathname)});
    const { BrowserPanePolicy } = await import(${JSON.stringify(new URL('./browserPanePolicy.ts', import.meta.url).pathname)});
    const view = await createBrowserPaneElectronAdapter().create('probe', new BrowserPanePolicy({ folders: () => null, devOrigin: null }));
    const hookEvents = [];
    view.setHooks({ navigated: () => hookEvents.push('navigation'), titleUpdated: () => hookEvents.push('title') });
    view.nativeView.webContents.emit('page-title-updated');
    assert.deepEqual(hookEvents, ['title']);
    const firstEntry = await view.historyEntry();
    activeIndex = 1;
    const secondEntry = await view.historyEntry();
    assert.notEqual(firstEntry, secondEntry);
    await view.restoreHistoryEntry(firstEntry);
    assert.equal(activeIndex, 0);
    assert.equal(events.at(-1), 'index:0');
    await view.restoreHistoryEntry(secondEntry);
    assert.equal(activeIndex, 1);
    historyEntries.pop();
    await assert.rejects(view.restoreHistoryEntry(secondEntry), /no longer available/);
    await assert.rejects(view.restoreHistoryEntry('different-view:11'), /no longer available/);
    assert.deepEqual(events.filter(event => event.startsWith('load:')), ['load:about:blank']);
    const capture = await view.capturePage(2000000);
    const png = Buffer.from(capture.data, 'base64');
    const presentation = createBrowserPanePresentationNative();
    let zoom = 1.1;
    const window = { isDestroyed: () => false, contentView: { addChildView() {}, removeChildView() {} }, webContents: { getZoomFactor: () => zoom } };
    presentation.attach(window, view);
    const rect = { x: 100, y: 50, width: 600, height: 400 };
    presentation.bounds(view, rect);
    const converted = bounds.at(-1);
    presentation.visible(view, true);
    const counts = [bounds.length, visibility.length];
    presentation.bounds(view, { ...rect });
    presentation.visible(view, true);
    assert.deepEqual([bounds.length, visibility.length], counts);
    presentation.bounds(view, { ...rect, width: 601 });
    assert.equal(bounds.at(-1).width, 661);
    zoom = 1.25;
    presentation.bounds(view, rect);
    assert.deepEqual(bounds.at(-1), { x: 125, y: 63, width: 750, height: 500 });
    failBounds = true;
    assert.throws(() => presentation.bounds(view, { ...rect, x: 101 }));
    failBounds = false;
    const failedBoundsCount = bounds.length;
    presentation.bounds(view, { ...rect, x: 101 });
    assert.equal(bounds.length, failedBoundsCount + 1);
    failVisible = true;
    assert.throws(() => presentation.visible(view, false));
    failVisible = false;
    const failedVisibleCount = visibility.length;
    presentation.visible(view, false);
    assert.equal(visibility.length, failedVisibleCount + 1);
    presentation.detach(window, view);
    presentation.attach(window, view);
    const reattachCounts = [bounds.length, visibility.length];
    presentation.bounds(view, { ...rect, x: 101 });
    presentation.visible(view, false);
    assert.deepEqual([bounds.length, visibility.length], reattachCounts.map(n => n + 1));
    console.log(JSON.stringify({ events, capture, pixels: { width: png.readUInt32BE(16), height: png.readUInt32BE(20) }, bounds: converted }));
  `
  try {
    const child = Bun.spawn([process.execPath, '-e', source], {
      stdout: 'pipe', stderr: 'pipe', env: { ...process.env, BROWSER_RENDERER_TEST_ROOT: root },
    })
    const [code, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()])
    expect(code, stderr).toBe(0)
    return JSON.parse(stdout) as { events: string[]; capture: { width: number; height: number }; pixels: { width: number; height: number }; bounds: { x: number; y: number; width: number; height: number } }
  } finally { await rm(root, { recursive: true, force: true }) }
}

test('a new browser view starts its blank renderer before sending CDP page commands', async () => {
  const { events } = await fixture()
  expect(events.indexOf('load:about:blank')).toBeGreaterThanOrEqual(0)
  expect(events.indexOf('load:about:blank')).toBeLessThan(events.indexOf('Page.enable'))
})

test('native operations deduplicate effective bounds and visibility, track zoom and geometry, and retry after failures or reattach', async () => {
  expect((await fixture()).bounds).toEqual({ x: 110, y: 55, width: 660, height: 440 })
})

test('Retina screenshots are capped in encoded pixels with matching image dimensions', async () => {
  const { capture, pixels } = await fixture()
  expect(pixels).toEqual({ width: capture.width, height: capture.height })
  expect(pixels.width * pixels.height).toBeLessThanOrEqual(2_000_000)
})
