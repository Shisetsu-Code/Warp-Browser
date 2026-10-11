'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { BrowserManager } = require('../src/manager');

const waitReal = ms => new Promise(resolve => setTimeout(resolve, ms));

const gamePage = `<!doctype html><meta charset="utf-8"><title>Demo de clics</title>
<style>body{font:16px system-ui;margin:0}#buy{position:fixed;top:14px;right:105px;z-index:1;cursor:pointer}
iframe{position:absolute;top:100px;left:40px;width:550px;height:300px;border:1px solid #ccc}</style>
<button id="buy" type="button">Comprar demo</button>
<iframe id="game" src="/iframe"></iframe>
<script>
window.clickEvents=[];
const buy = document.getElementById('buy');
for (const type of ['pointerdown','pointerup','click']) {
 buy.addEventListener(type,event=>{
   window.clickEvents.push({type, effective:__warpGetEffectiveSpeed(),
      skew: Math.abs(performance.now()-event.timeStamp)});
 });
}
buy.addEventListener('click',async()=>{
 const response=await fetch('/api?buy=parent',{method:'POST',body:'buy-demo'});
 window.buyCompleted=response.ok;
});
</script>`;
const iframePage = `<!doctype html><meta charset="utf-8"><title>Iframe demo</title>
<button id="inner" type="button" style="margin:30px">Comprar dentro de iframe</button>
<script>
window.clickEvents=[];
const btn=document.getElementById('inner');
for(const type of ['pointerdown','pointerup','click']){
 btn.addEventListener(type,event=>window.clickEvents.push({type,effective:__warpGetEffectiveSpeed(),
    skew:Math.abs(performance.now()-event.timeStamp)}));
}
btn.addEventListener('click',async()=>{
 const response=await fetch('/api?buy=frame',{method:'POST',body:'iframe-buy-demo'});
 window.buyCompleted=response.ok;
});
</script>`;

test('8x and 16x preserve real browser clocks and trusted clicks in page and iframe', {timeout: 120000}, async () => {
  const { chromium } = require('playwright');
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'warp-click-safe-'));
  const sent = [];
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/api')) {
      const chunks = [];
      req.on('data', c => chunks.push(c));
      req.on('end', () => {
        sent.push({ url: req.url, body: Buffer.concat(chunks).toString('utf8') });
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ ok: true }));
      });
    } else {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(req.url === '/iframe' ? iframePage : gamePage);
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let context;
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    context = await chromium.launchPersistentContext(path.join(root, 'profile'), {
      headless: true, acceptDownloads: true
    });
    const saved = [];
    const manager = new BrowserManager(context, {
      recoveryDir: path.join(root, 'recovery'), downloadDir: root,
      dialog: async () => {
        const location = path.join(root, `click-${saved.length}.har`);
        saved.push(location);
        return location;
      },
      logger: { log() {}, warn() {}, error(...args) { console.error(...args); } }
    });
    await manager.start();
    const page = context.pages()[0] || await context.newPage();
    await page.goto(base + '/game');
    await page.frameLocator('#game').locator('#inner').waitFor();

    // Acceleration should not corrupt clocks used by click/gesture recognition.
    await manager.setSpeed(page, 8);
    const before = await page.evaluate(() => ({date: Date.now(), perf: performance.now()}));
    await waitReal(180);
    const after = await page.evaluate(() => ({date: Date.now(), perf: performance.now()}));
    const deltaDate = after.date - before.date;
    const deltaPerf = after.perf - before.perf;
    assert.ok(deltaDate >= 80 && deltaDate < 950, `Date.now jumped at 8x (${deltaDate}ms)`);
    assert.ok(deltaPerf >= 80 && deltaPerf < 950, `performance.now jumped at 8x (${deltaPerf}ms)`);
    assert.ok(Math.abs(deltaDate - deltaPerf) < 80, 'native clocks disagree');
    assert.equal(await page.evaluate(() => __warpGetEffectiveSpeed()), 8);
    const iframeSpeed = await page.frameLocator('#game').locator('body')
      .evaluate(() => __warpGetSpeed());
    assert.equal(iframeSpeed, 8);

    // The old always-open toolbar (approx 300px wide) covered this top-right
    // button. The collapsed 70px chip must not block its trusted click.
    await page.locator('#buy').hover();
    await page.mouse.down();
    assert.equal(await page.evaluate(() => __warpGetEffectiveSpeed()), 1,
      'pointerdown should briefly suspend acceleration');
    await page.mouse.up();
    await page.waitForFunction(() => window.buyCompleted === true);
    const parentEvents = await page.evaluate(() => window.clickEvents);
    assert.deepEqual(parentEvents.map(e => e.type), ['pointerdown', 'pointerup', 'click']);
    assert.ok(parentEvents.every(e => e.effective === 1 && e.skew < 350),
      `parent click event timing invalid: ${JSON.stringify(parentEvents)}`);
    await waitReal(490);
    assert.equal(await page.evaluate(() => __warpGetEffectiveSpeed()), 8);

    // The same safety applies to game UIs hosted in a cross-frame iframe.
    await manager.setSpeed(page, 16);
    await page.frameLocator('#game').locator('#inner').click();
    await page.waitForFunction(() => document.querySelector('iframe').contentWindow.buyCompleted === true);
    const frameEvents = await page.frameLocator('#game').locator('body').evaluate(() => window.clickEvents);
    assert.deepEqual(frameEvents.map(e => e.type), ['pointerdown', 'pointerup', 'click']);
    assert.ok(frameEvents.every(e => e.effective === 1 && e.skew < 350),
      `iframe click event timing invalid: ${JSON.stringify(frameEvents)}`);
    await waitReal(490);
    assert.equal(await page.frameLocator('#game').locator('body')
      .evaluate(() => __warpGetEffectiveSpeed()), 16);
    assert.deepEqual(sent, [
      { url: '/api?buy=parent', body: 'buy-demo' },
      { url: '/api?buy=frame', body: 'iframe-buy-demo' }
    ]);

    await page.close();
    await manager.closePage(page);
    assert.equal(saved.length, 1);
    const har = JSON.parse(await fs.promises.readFile(saved[0], 'utf8'));
    assert.ok(har.log.entries.some(entry => entry.request.url.endsWith('?buy=parent')));
    assert.ok(har.log.entries.some(entry => entry.request.url.endsWith('?buy=frame')));
    assert.ok(har.log.entries.some(entry => entry.request.postData?.text === 'buy-demo'));
    assert.ok(har.log.entries.some(entry => entry.request.postData?.text === 'iframe-buy-demo'));
    await context.close();
    await manager.shutdown();
  } finally {
    if (context) await context.close().catch(() => {});
    await new Promise(resolve => server.close(resolve));
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});
