'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { BrowserManager } = require('../src/manager');

class FakePage extends EventEmitter {
  constructor(url) { super(); this.link = url; this.closed = false; this.frame = { url: () => this.link, evaluate: async () => {} }; }
  url() { return this.link; }
  mainFrame() { return this.frame; }
  frames() { return [this.frame]; }
  isClosed() { return this.closed; }
  close() { this.closed = true; this.emit('close'); }
}
class FakeContext extends EventEmitter {
  constructor(pages) { super(); this.active = pages; }
  pages() { return this.active; }
  async addInitScript() { }
  async exposeBinding(name, fn) { this.bound = fn; }
}
function fakeRequest(page, suffix) {
  return {
    frame: () => ({ page: () => page }),
    method: () => 'GET', url: () => `${page.url()}${suffix}`,
    postDataBuffer: () => null, headersArray: async () => [],
    response: async () => ({ status: () => 200, statusText: () => 'OK', headersArray: async () => [{ name: 'content-type', value: 'text/plain' }], body: async () => Buffer.from(suffix) }),
    sizes: async () => ({ requestBodySize: 0, responseBodySize: suffix.length }),
    timing: () => ({ startTime: Date.now(), responseEnd: 20 })
  };
}

test('native tab lifecycle creates isolated HAR, including pre-navigation request listeners', async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'warp-manager-'));
  try {
    const p1 = new FakePage('https://game-one.test/');
    const p2 = new FakePage('https://game-two.test/');
    const context = new FakeContext([p1, p2]);
    const selected = [];
    const manager = new BrowserManager(context, {
      recoveryDir: path.join(root, 'recovery'),
      downloadDir: root,
      dialog: async proposal => { const destination = path.join(root, `saved-${selected.length}.har`); selected.push(destination); return destination; },
      logger: { log() {}, warn() {}, error() {} }
    });
    await manager.start();
    assert.equal(manager.sessions.size, 2);
    for (const [page, suffix] of [[p1, 'first'], [p2, 'second']]) {
      const request = fakeRequest(page, suffix);
      context.emit('request', request);
      context.emit('requestfinished', request);
    }
    p1.close();
    await manager.closePage(p1);
    p2.close();
    await manager.closePage(p2);
    await manager.shutdown();
    assert.equal(selected.length, 2);
    const first = JSON.parse(await fs.promises.readFile(selected[0], 'utf8'));
    const second = JSON.parse(await fs.promises.readFile(selected[1], 'utf8'));
    assert.equal(first.log.entries.length, 1);
    assert.equal(second.log.entries.length, 1);
    assert.match(first.log.entries[0].request.url, /game-one/);
    assert.match(second.log.entries[0].request.url, /game-two/);
  } finally { await fs.promises.rm(root, { recursive: true, force: true }); }
});

test('speed changes only the selected tab and rejects invalid values', async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'warp-speed-'));
  try {
    const p1 = new FakePage('https://one.test/');
    const p2 = new FakePage('https://two.test/');
    const mgr = new BrowserManager(new FakeContext([p1, p2]), { recoveryDir: root, dialog: async () => null, logger: { log() {}, warn() {}, error() {} } });
    await mgr.start();
    await mgr.setSpeed(p1, 8);
    await mgr.setSpeed(p2, 3);
    assert.equal(mgr.speedByPage.get(p1), 8);
    assert.equal(mgr.speedByPage.get(p2), 1);
    p1.close(); p2.close();
    await mgr.shutdown();
  } finally { await fs.promises.rm(root, { recursive: true, force: true }); }
});
