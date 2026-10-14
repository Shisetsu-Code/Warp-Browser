'use strict';
// Optional live diagnostic on a public free-play demo. Does not place bets,
// click game controls, change any HTTP/WS traffic or upload captured responses.
const { chromium } = require('playwright');
const { BrowserManager } = require('../src/manager');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const url = 'https://demo.nolimitcdn.com/loader/loader-desktop.html?operator=FANPAGE_DEMO&game=AirportSecurity&language=en&provider=nlc';
async function statuses(page) {
  const values = [];
  for (const frame of page.frames()) {
    try {
      const row = await frame.evaluate(() => {
        const engine = window.__warpGetEngineStatus?.() || null;
        const launcher = window.NolimitLauncher;
        const plugins = launcher?.constructor?.plugins;
        return {
          warpInstalled: Boolean(window.__warpSetSpeed),
          engine,
          hasPixiGlobal: Boolean(window.PIXI?.Ticker),
          hasPixiApp: Boolean(window.__PIXI_APP__?.ticker),
          realPixiSpeed: window.__PIXI_APP__?.ticker?.speed ?? null,
          launcher: Boolean(launcher),
          pluginCount: Array.isArray(plugins) ? plugins.length : null,
          hasGameSpeedster: Array.isArray(plugins) && plugins.some(p => Boolean(p?.constructor?.speedster)),
          hasGlobalGsap: Boolean(window.gsap?.globalTimeline),
          engineGSAPSource: engine?.gsapSource || null
        };
      });
      // Avoid leaking session tokens and query strings into public CI logs.
      const address = new URL(frame.url());
      values.push({origin: address.origin, pathname: address.pathname.slice(0, 120), ...row});
    } catch (err) {
      values.push({frame: 'transient-navigation', reason: err.name});
    }
  }
  return values;
}

(async () => {
  const folder = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'warp-provider-'));
  let context, manager;
  try {
    context = await chromium.launchPersistentContext(path.join(folder, 'profile'), {
      headless: true, acceptDownloads: false, viewport: { width: 1280, height: 900 }
    });
    manager = new BrowserManager(context, {
      recoveryDir: path.join(folder, 'recovery'),
      dialog: async () => null,
      logger: { log() {}, warn() {}, error(e) { console.error('HAR capture warning:', String(e).slice(0, 180)); } }
    });
    await manager.start();
    const page = context.pages()[0] || await context.newPage();
    page.on('pageerror', err => {
      const msg = err.message.replace(/https?:\/\/[^ ]+/g, '[URL]');
      console.log('PAGE_ERROR:', msg.slice(0, 150));
    });
    try {
      const navigation = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
      console.log('NAV_STATUS:', navigation?.status());
    } catch (error) { console.log('NAV_ERROR:', String(error.message).split('\n')[0].slice(0, 160)); }
    let readiness = false;
    for (let i = 0; i < 35; i++) {
      const rows = await statuses(page);
      if (rows.some(x => x.hasPixiApp || x.hasGameSpeedster)) { readiness = true; break; }
      await sleep(1000);
    }
    console.log('READINESS:', readiness);
    console.log('BEFORE:', JSON.stringify(await statuses(page)));
    await manager.setSpeed(page, 8);
    await sleep(1000);
    console.log('AFTER_8X:', JSON.stringify(await statuses(page)));
    await manager.setSpeed(page, 1);
    await sleep(350);
    console.log('AFTER_1X:', JSON.stringify(await statuses(page)));
  } finally {
    if (context) await context.close().catch(() => {});
    if (manager) await manager.shutdown().catch(err => console.log('SHUTDOWN_WARN', err.message.slice(0, 80)));
    await fs.promises.rm(folder, { recursive: true, force: true }).catch(() => {});
  }
})().catch(error => { console.error('PROBE_ERROR:', error.message); process.exitCode = 1; });
