'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../src/playtech-gwt.js'), 'utf8');

function makeEngine({ domain = 'unrelated-game.example', pathname = '/random/inside-frame.html', useNative = false } = {}) {
  let clock = 200;
  let requested = 8;
  let effective = 8;
  const intervals = [];
  const reports = [];
  class FakeDate extends Date {}
  FakeDate.now = () => 1700000000000 + clock;
  const browser = {
    location: { hostname: domain, pathname },
    frameBudget: 30, lastTick: 0,
    game: { ticks: 0, times: [], nextScheduled: false },
    __warpGetSpeed: () => requested,
    __warpGetEffectiveSpeed: () => effective,
    __warpReportGpasStatus: data => { reports.push(data); },
    setInterval: (fn, ms) => { intervals.push({ fn, ms }); return intervals.length; },
    requestAnimFrame: fn => { browser.game.nextScheduled = fn === browser.fnRequestAnimationFrame; }
  };
  if (useNative) {
    browser.__warpNativeSetInterval = browser.setInterval;
    browser.setInterval = () => { throw Error('Virtual game interval must not be used by engine probe'); };
  }
  const context = vm.createContext({
    window: browser,
    Date: FakeDate,
    performance: { now: () => clock },
    Number, Math, Object, Reflect, Function, Boolean, Promise, String
  });
  vm.runInContext(source, context, { filename: 'playtech-gwt.js' });
  function installGame() {
    vm.runInContext(`
      window.fnRequestAnimationFrame = function gwtFrame() {
        const budget = window.frameBudget;
        const time = Date.now();
        if (time - window.lastTick >= budget) {
          window.lastTick = time;
          window.game.ticks++;
          window.game.times.push(time);
        }
        window.requestAnimFrame(window.fnRequestAnimationFrame);
      };
    `, context);
  }
  function pulse() {
    for (const { fn } of intervals) fn();
  }
  function frame(n = 1, step = 16) {
    for (let i = 0; i < n; i++) {
      clock += step;
      browser.fnRequestAnimationFrame();
    }
  }
  return { browser, reports, intervals, pulse, frame, installGame,
    setRequested(n) { requested = n; }, setEffective(n) { effective = n; },
    real() { return FakeDate.now(); } };
}

test('GWT engine is detected by signature after delayed load on an arbitrary iframe URL', () => {
  const { browser, pulse, frame, installGame, real, reports } = makeEngine();
  assert.equal(browser.__warpGetGpasStatus().detected, false);
  assert.equal(Object.hasOwn(browser, 'fnRequestAnimationFrame'), false,
    'ordinary non-game page must not be patched');
  installGame();
  const nativeLoop = browser.fnRequestAnimationFrame;
  pulse();
  assert.notEqual(browser.fnRequestAnimationFrame, nativeLoop);
  frame(35);
  const report = browser.__warpGetGpasStatus();
  assert.equal(report.detected, true);
  assert.equal(report.selectedSpeed, 8);
  assert.equal(report.confirmed, true);
  assert.equal(report.clockMultiplier, 8);
  assert.ok(report.acceleratedFrames > 25);
  assert.ok(browser.game.nextScheduled);
  assert.equal(real(), Date.parse('2023-11-14T22:13:20.760Z'),
    'Date.now outside the game must stay real');
  assert.ok(reports.some(s => s.engine === 'playtech-gwt'));
});

test('GWT wrapper hot-reinstalls after the game overwrites its loop', () => {
  const h = makeEngine({ domain: 'cdn.other-source.org', pathname: '/webgl/unknown' });
  h.installGame(); h.pulse(); h.frame(30);
  const old = h.browser.fnRequestAnimationFrame;
  h.installGame();
  h.pulse();
  assert.notEqual(h.browser.fnRequestAnimationFrame, old);
  assert.equal(h.browser.__warpGetGpasStatus().reinstalls, 2);
  h.frame(30);
  assert.equal(h.browser.__warpGetGpasStatus().confirmed, true);
  h.setEffective(1); h.pulse(); h.frame(20);
  assert.equal(h.browser.__warpGetGpasStatus().confirmed, false,
    'input pause cannot be labelled as 8x applied');
});

test('unrelated frame callbacks are not modified, even if named fnRequestAnimationFrame', () => {
  const h = makeEngine();
  const innocent = function normalFrame() { return 'untouched'; };
  h.browser.fnRequestAnimationFrame = innocent;
  h.pulse();
  assert.equal(h.browser.fnRequestAnimationFrame, innocent);
  assert.equal(h.browser.__warpGetGpasStatus().detected, false);
  h.setRequested(16);
  h.pulse();
  assert.equal(h.browser.fnRequestAnimationFrame, innocent);
});


test('adapter uses the native unaccelerated scheduler when provided by preload', () => {
  const h = makeEngine({ useNative: true });
  assert.deepEqual(h.intervals.map(x => x.ms), [350, 900]);
  h.installGame(); h.pulse(); h.frame(35);
  assert.equal(h.browser.__warpGetGpasStatus().confirmed, true);
});
