'use strict';
// Optional live diagnostic on a public free-play demo. Does not place bets,
// click game controls, change any HTTP/WS traffic or upload captured responses.
const { chromium } = require('playwright');
const { BrowserManager } = require('../src/manager');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const url = 'https://playin.com/embed/v1/demo/AirportSecurity';
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

    async function runtimeDetail() {
      const list = [];
      for (const frame of page.frames()) {
        try {
          const value = await frame.evaluate(() => {
            const plugins = window.NolimitLauncher?.constructor?.plugins || [];
            const game = plugins.find(p => p?.constructor?.speedster)?.constructor;
            const api = game?.apiPlugin;
            const ctrl = game?.gameFlowController;
            const app = window.__PIXI_APP__;
            const slowButtons = Array.from(document.querySelectorAll('button'))
              .slice(0, 25).map(b => ({ text: b.textContent.trim().slice(0,40), aria:b.getAttribute('aria-label')?.slice(0,50) }));
            const pixiNodes = [];
            if (app?.stage) {
              const nodes = [{ item: app.stage, depth: 0 }];
              let count = 0;
              while (nodes.length && count < 3000) {
                const { item, depth } = nodes.shift(); count++;
                if (/spin|skip|fast|speed|play/i.test(item?.name || '') && pixiNodes.length < 30) {
                  pixiNodes.push({ name: String(item.name).slice(0,60), interactive: Boolean(item.interactive), x:Math.round(item.x||0), y:Math.round(item.y||0) });
                }
                if (depth < 9 && Array.isArray(item?.children)) {
                  for(const child of item.children) nodes.push({item:child,depth:depth+1});
                }
              }
            }
            let rootScale = null;
            try {
              const speedster=game?.speedster?.constructor;
              const probe=speedster?.setTimeline?.call(speedster,null,null);
              rootScale=(probe?.parent || probe?._dp)?.timeScale?.() ?? null;
              probe?.kill?.();
            } catch(_) {}
            return {
              game:game?.name || null,
              fastSpin:api?.fastSpin ? {isEnabled:api.fastSpin.isEnabled, speed:api.fastSpin.speed, isFastSpin:api.fastSpin.isFastSpin} : null,
              round:ctrl ? {mode:ctrl._mode,presentation:ctrl._currentPresentation?.constructor?.name || null,minMs:ctrl._minimumGameRoundTimeInMs} : null,
              gsapRootScale:rootScale,
              appTicker:app?.ticker ? {speed:app.ticker.speed,deltaTime:app.ticker.deltaTime} : null,
              domButtons:slowButtons,
              pixiNodes
            };
          });
          if (value.game || value.appTicker) list.push(value);
        } catch (_) { /* navigation race */ }
      }
      return list;
    }
    console.log('BEFORE:', JSON.stringify(await statuses(page)));
    await manager.setSpeed(page, 8);
    await sleep(1000);
    console.log('AFTER_8X:', JSON.stringify(await statuses(page)));
    console.log('RUNTIME_8X:', JSON.stringify(await runtimeDetail()));
    await manager.setSpeed(page, 1);
    await sleep(350);
    console.log('AFTER_1X:', JSON.stringify(await statuses(page)));
    async function findGameFrame() {
      for (const frame of page.frames()) {
        try {
          if (await frame.evaluate(() => Boolean(
            window.NolimitLauncher?.constructor?.plugins?.some(
              plugin => plugin?.constructor?.apiPlugin?.options?.funMode === true &&
                plugin?.constructor?.apiPlugin?.gameClientConfiguration?.operator === 'FANPAGE_DEMO'
            ) && window.__PIXI_APP__?.stage
          ))) return frame;
        } catch (_) { /* navigation race */ }
      }
      return null;
    }
    const gameFrame = await findGameFrame();
    if (gameFrame && process.env.RUN_DEMO_SPINS === '1') {
      // Normal free-play rounds only. Space invokes the game's own clickSpin
      // handler; Warp never constructs or alters game requests.
      for (const chosen of [1, 8]) {
        await manager.setSpeed(page, chosen);
        let started = false, idleCounter = 0, samples = 0;
        const begin = Date.now();
        try {
          await gameFrame.locator('body').press('Space');
          while (Date.now() - begin < 18000) {
            await sleep(90);
            const st = await gameFrame.evaluate(() => {
              const plugins = window.NolimitLauncher?.constructor?.plugins || [];
              const game = plugins.find(x => x?.constructor?.speedster)?.constructor;
              return Boolean(game?.gameFlowController?._currentPresentation);
            });
            samples++;
            if (st) { started = true; idleCounter = 0; }
            else if (started && ++idleCounter > 4) break;
          }
          console.log('SPIN_SAMPLE:', JSON.stringify({selectedSpeed:chosen, began:started,
            elapsedMs:Date.now()-begin, samples}));
        } catch (e) { console.log('SPIN_SAMPLE_ERROR:', chosen, String(e.message).split('\n')[0].slice(0,120)); }
      }
    }

  } finally {
    if (context) await context.close().catch(() => {});
    if (manager) await manager.shutdown().catch(err => console.log('SHUTDOWN_WARN', err.message.slice(0, 80)));
    await fs.promises.rm(folder, { recursive: true, force: true }).catch(() => {});
  }
})().catch(error => { console.error('PROBE_ERROR:', error.message); process.exitCode = 1; });
