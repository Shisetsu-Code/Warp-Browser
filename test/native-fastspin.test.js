'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { chromium } = require('playwright');
const { BrowserManager } = require('../src/manager');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

test('demo-only native FastSpin persists during a trusted click and restores at 1x',
  { timeout: 120000 }, async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'warp-demo-native-'));
    const server = http.createServer((req, res) => {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end('<!doctype html><button id="spin">Tirar demo</button>');
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    let context;
    try {
      context = await chromium.launchPersistentContext(path.join(root, 'profile'), {headless: true});
      const manager = new BrowserManager(context, {
        recoveryDir: path.join(root, 'recovery'),
        dialog: async () => path.join(root, 'test.har'),
        logger: { log() {}, warn() {}, error(...args) { console.error(...args); } }
      });
      await manager.start();
      const page = context.pages()[0] || await context.newPage();
      await page.goto(`http://127.0.0.1:${server.address().port}/`);
      await page.evaluate(() => {
        class Game {}
        const fastSpin = {
          speed: 0,
          isEnabled: true,
          _gameHasSupportMegaSupport: false,
          get isFastSpin() { return this.speed > 0; },
          calls: [],
          setSpeed(value) { this.speed = value; this.calls.push(value); }
        };
        Game.apiPlugin = {
          options: { funMode: true },
          gameClientConfiguration: { operator: 'FANPAGE_DEMO' },
          fastSpin
        };
        window.demoGame = Game;
        window.NolimitLauncher = {constructor: {plugins: [new Game()]}};
      });
      await manager.setSpeed(page, 8);
      assert.equal(await page.evaluate(() => demoGame.apiPlugin.fastSpin.speed), 1);
      const status = await page.evaluate(() => __warpGetEngineStatus());
      assert.deepEqual(status.nativeFastSpin, {eligible: true, enabled: true, nativeSpeed: 1, gameMode: 'free-play'});
      await page.locator('#spin').hover();
      await page.mouse.down();
      assert.equal(await page.evaluate(() => __warpGetEffectiveSpeed()), 1);
      assert.equal(await page.evaluate(() => demoGame.apiPlugin.fastSpin.speed), 1,
        'native fast-spin must remain enabled when the spin click begins');
      await page.mouse.up();
      await sleep(500);
      assert.equal(await page.evaluate(() => __warpGetEffectiveSpeed()), 8);
      assert.equal(await page.evaluate(() => demoGame.apiPlugin.fastSpin.speed), 1);
      await manager.setSpeed(page, 1);
      assert.equal(await page.evaluate(() => demoGame.apiPlugin.fastSpin.speed), 0);
      assert.deepEqual(await page.evaluate(() => demoGame.apiPlugin.fastSpin.calls), [1,0]);
      // A non-demo real-money context must not be modified.
      await page.evaluate(() => {demoGame.apiPlugin.options.funMode = false;});
      await manager.setSpeed(page, 8);
      assert.equal(await page.evaluate(() => demoGame.apiPlugin.fastSpin.speed), 0);
      await page.close();
      await manager.closePage(page);
      await context.close();
      await manager.shutdown();
    } finally {
      if (context) await context.close().catch(() => {});
      await new Promise(resolve => server.close(resolve));
      await fs.promises.rm(root, { recursive: true, force: true });
    }
  });
