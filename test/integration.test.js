'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { BrowserManager } = require('../src/manager');

test('real Playwright Chromium captures two pages separately, from first navigation', { timeout: 120000 }, async () => {
  const { chromium } = require('playwright');
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'warp-smoke-'));
  const server = http.createServer((req, res) => {
    if (req.url.startsWith('/api')) {
      let body = '';
      req.on('data', x => { body += x.toString(); });
      req.on('end', () => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ ok: true, received: body })); });
    } else {
      res.setHeader('Content-Type', 'text/html');
      res.end('<!doctype html><title>Warp Smoke</title><h1>Ready</h1>');
    }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let context;
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    context = await chromium.launchPersistentContext(path.join(root, 'profile'), { headless: true, acceptDownloads: true });
    const saved = [];
    const mgr = new BrowserManager(context, {
      recoveryDir: path.join(root, 'recovery'), downloadDir: root,
      dialog: async () => { const dest = path.join(root, `capture-${saved.length}.har`); saved.push(dest); return dest; },
      logger: { log() {}, warn() {}, error(...args) { console.error(...args); } }
    });
    await mgr.start();
    const pages = context.pages();
    const a = pages.length ? pages[0] : await context.newPage();
    const b = await context.newPage();
    await a.goto(base + '/first');
    await a.evaluate(async () => { await fetch('/api?tab=a', { method: 'POST', body: 'spin-a' }); });
    await b.goto(base + '/second');
    await b.evaluate(async () => { await fetch('/api?tab=b', { method: 'POST', body: 'spin-b' }); });
    await mgr.setSpeed(a, 8);
    assert.equal(await a.evaluate(() => window.__warpGetSpeed()), 8);
    assert.equal(await b.evaluate(() => window.__warpGetSpeed()), 1);
    await a.close();
    await mgr.closePage(a);
    await b.close();
    await mgr.closePage(b);
    assert.equal(saved.length, 2);
    const first = JSON.parse(await fs.promises.readFile(saved[0], 'utf8'));
    const second = JSON.parse(await fs.promises.readFile(saved[1], 'utf8'));
    assert.ok(first.log.entries.some(x => x.request.url.endsWith('/first')), 'first navigation missing');
    assert.ok(first.log.entries.some(x => x.request.url.includes('tab=a')), 'first POST missing');
    assert.ok(!first.log.entries.some(x => x.request.url.includes('tab=b')), 'cross-tab leakage');
    assert.ok(second.log.entries.some(x => x.request.url.endsWith('/second')), 'second navigation missing');
    assert.ok(second.log.entries.some(x => x.request.url.includes('tab=b')), 'second POST missing');
    const post = first.log.entries.find(x => x.request.url.includes('tab=a'));
    assert.equal(post.request.postData.text, 'spin-a');
    await context.close();
    await mgr.shutdown();
  } finally {
    if (context) await context.close().catch(() => {});
    await new Promise(resolve => server.close(resolve));
    await fs.promises.rm(root, { recursive: true, force: true });
  }
});
