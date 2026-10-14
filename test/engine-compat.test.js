'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs');
const { BrowserManager } = require('../src/manager');

const html = `<!doctype html><html><body><button id="buy">Comprar prueba</button>
<script>window.clicks = [];
for (const type of ['pointerdown', 'pointerup', 'click']) {
  document.querySelector('#buy').addEventListener(type, event => {
    clicks.push({ type, trusted: event.isTrusted,
      speed: __warpGetEffectiveSpeed(),
      deltaClock: Math.abs(performance.now() - event.timeStamp),
      gsap: window.testGSAP?.timeScale(),
      pixi: window.__PIXI_APP__?.ticker.speed });
  });
}</script></body></html>`;

const waitReal = ms => new Promise(resolve => setTimeout(resolve, ms));

test('bundled GSAP via Nolimit Speedster and PIXI app ticker scale without corrupting click timing',
  { timeout: 120000 }, async () => {
    const { chromium } = require('playwright');
    const folder = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'warp-nolimit-'));
    const server = http.createServer((req, res) => {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(html);
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    let context;
    try {
      context = await chromium.launchPersistentContext(path.join(folder, 'profile'), { headless: true });
      const manager = new BrowserManager(context, {
        recoveryDir: path.join(folder, 'recovery'),
        dialog: async () => path.join(folder, 'engine-compat.har'),
        logger: { log() {}, warn() {}, error(...args) { console.error(...args); } }
      });
      await manager.start();
      const page = context.pages()[0] || await context.newPage();
      await page.goto(`http://127.0.0.1:${server.address().port}/game`);
      await manager.setSpeed(page, 8);

      // Late engine loading: selected 8x before PIXI/GSAP were available.
      await page.evaluate(() => {
        const root = {
          value: 1,
          timeScale(value) { if (value !== undefined) this.value = value; return this.value; }
        };
        // This matches Nolimit City's webpack-scoped GSAP root: its Speedster
        // class can create a disposable timeline holding a reference to root.
        class Speedster {
          static setTimeline() { return { _dp: root, kill() { window.probesKilled++; } }; }
        }
        class Game {}
        Game.speedster = new Speedster();
        class Launcher {}
        Launcher.plugins = [new Game()];
        window.NolimitLauncher = new Launcher();
        window.PIXI = { Ticker: { shared: { speed: 1 }, system: { speed: 1 } } };
        window.__PIXI_APP__ = { ticker: { speed: 1 } };
        window.probesKilled = 0;
        window.testGSAP = root;
      });
      await page.waitForFunction(() => __warpGetEngineStatus().pixi && __warpGetEngineStatus().gsap,
        { timeout: 5000 });
      const at8 = await page.evaluate(() => ({
        diagnostics: __warpGetEngineStatus(),
        gsap: testGSAP.timeScale(),
        app: __PIXI_APP__.ticker.speed,
        shared: PIXI.Ticker.shared.speed,
        system: PIXI.Ticker.system.speed,
        killed: window.probesKilled
      }));
      assert.equal(at8.diagnostics.gsapSource, 'nolimit-speedster');
      assert.equal(at8.gsap, 8);
      assert.equal(at8.app, 8);
      assert.equal(at8.shared, 8);
      assert.equal(at8.system, 1, 'PIXI system ticker must preserve input timings');
      assert.equal(at8.killed, 1, 'one empty GSAP probe should be disposed');

      // PIXI receives real rAF time rather than the virtual timestamp;
      // the ticker applies the scale once (8x, not 64x).
      const rafTime = await page.evaluate(() => new Promise(resolve => {
        requestAnimationFrame(timestamp => {
          const before = performance.now();
          requestAnimationFrame(next => resolve({ diff: next - timestamp,
            runtimeDelta: performance.now() - before }));
        });
      }));
      assert.ok(rafTime.diff > 2 && rafTime.diff < 130,
        `PIXI should receive native rAF timestamps: ${JSON.stringify(rafTime)}`);

      await page.locator('#buy').click();
      const events = await page.evaluate(() => clicks);
      assert.deepEqual(events.map(x => x.type), ['pointerdown', 'pointerup', 'click']);
      assert.ok(events.every(x => x.trusted && x.speed === 1 && x.gsap === 1 && x.pixi === 1 && x.deltaClock < 250),
        `interaction guard failed: ${JSON.stringify(events)}`);
      await waitReal(490);
      assert.equal(await page.evaluate(() => testGSAP.timeScale()), 8);
      assert.equal(await page.evaluate(() => __PIXI_APP__.ticker.speed), 8);

      await manager.setSpeed(page, 16);
      assert.equal(await page.evaluate(() => testGSAP.timeScale()), 16);
      assert.equal(await page.evaluate(() => __PIXI_APP__.ticker.speed), 16);
      await manager.setSpeed(page, 1);
      assert.equal(await page.evaluate(() => testGSAP.timeScale()), 1);
      assert.equal(await page.evaluate(() => __PIXI_APP__.ticker.speed), 1);

      await page.close();
      await manager.closePage(page);
      const har = JSON.parse(await fs.promises.readFile(path.join(folder, 'engine-compat.har'), 'utf8'));
      assert.ok(har.log.entries.some(entry => entry.request.url.endsWith('/game')));
      await context.close();
      await manager.shutdown();
    } finally {
      if (context) await context.close().catch(() => {});
      await new Promise(resolve => server.close(resolve));
      await fs.promises.rm(folder, { recursive: true, force: true });
    }
  });
