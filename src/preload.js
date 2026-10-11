// Playwright addInitScript: runs before a site's JavaScript in every frame.
// No fetch, XHR, WebSocket, request interception, or network hooks are installed.
(() => {
  'use strict';
  if (window.__WARP_CLOCK_INSTALLED__) return;
  Object.defineProperty(window, '__WARP_CLOCK_INSTALLED__', { value: true });

  const native = {
    now: performance.now.bind(performance),
    dateNow: Date.now.bind(Date),
    setTimeout: window.setTimeout.bind(window),
    clearTimeout: window.clearTimeout.bind(window),
    setInterval: window.setInterval.bind(window),
    clearInterval: window.clearInterval.bind(window),
    raf: window.requestAnimationFrame.bind(window),
    animate: Element.prototype.animate
  };
  let speed = 1;
  let realAnchor = native.now();
  let virtualAnchor = realAnchor;
  let dateAnchor = native.dateNow();
  let timerId = 1_000_000_000;
  const timers = new Map();
  const allowed = new Set([1, 2, 4, 8, 16]);

  function virtualNow() {
    return virtualAnchor + (native.now() - realAnchor) * speed;
  }
  function epochNow() {
    return dateAnchor + (native.now() - realAnchor) * speed;
  }
  function schedule(id, timer) {
    const remain = Math.max(0, timer.target - virtualNow());
    timer.handle = native.setTimeout(() => {
      if (timers.get(id) !== timer) return;
      if (timer.interval) {
        timer.target = virtualNow() + timer.period;
      } else {
        timers.delete(id);
      }
      try {
        if (typeof timer.callback === 'function') {
          timer.callback.apply(window, timer.args);
        } else {
          // String timer handlers are supported by Chromium. Reuse its own
          // evaluator to preserve browser semantics and CSP behavior.
          native.setTimeout(timer.callback, 0);
        }
      } finally {
        if (timer.interval && timers.get(id) === timer) schedule(id, timer);
      }
    }, Math.max(0, remain / speed));
  }
  function createTimer(callback, delay, interval, args) {
    const id = timerId++;
    const period = Math.max(1, Number(delay) || 0);
    const timer = { callback, args, interval, period, target: virtualNow() + (interval ? period : Math.max(0, Number(delay) || 0)), handle: null };
    timers.set(id, timer);
    schedule(id, timer);
    return id;
  }
  function clearTimer(id) {
    const timer = timers.get(id);
    if (timer) {
      timers.delete(id);
      native.clearTimeout(timer.handle);
    } else {
      native.clearTimeout(id);
    }
  }

  window.setTimeout = (callback, delay, ...args) => createTimer(callback, delay, false, args);
  window.clearTimeout = clearTimer;
  window.setInterval = (callback, delay, ...args) => createTimer(callback, delay, true, args);
  window.clearInterval = clearTimer;
  window.requestAnimationFrame = callback => native.raf(() => callback(virtualNow()));
  try {
    Object.defineProperty(performance, 'now', { configurable: true, value: virtualNow });
  } catch (_) { /* Some Chromium builds do not permit replacing this property. */ }
  try { Date.now = epochNow; } catch (_) { /* Keep real time on restricted pages. */ }

  if (typeof native.animate === 'function') {
    Element.prototype.animate = function (...args) {
      const animation = native.animate.apply(this, args);
      try { animation.playbackRate *= speed; } catch (_) { /* ignored */ }
      return animation;
    };
  }
  function setAnimationRates(oldSpeed, newSpeed) {
    if (!document.getAnimations) return;
    try {
      for (const animation of document.getAnimations({ subtree: true })) {
        if (animation.playbackRate) animation.playbackRate = animation.playbackRate / oldSpeed * newSpeed;
      }
    } catch (_) { /* e.g. an animation was removed during enumeration */ }
  }
  function setSpeed(value) {
    const next = Number(value);
    if (!allowed.has(next)) return speed;
    if (next === speed) return speed;
    const now = native.now();
    virtualAnchor += (now - realAnchor) * speed;
    dateAnchor += (now - realAnchor) * speed;
    realAnchor = now;
    const previous = speed;
    speed = next;
    for (const [id, timer] of timers) {
      native.clearTimeout(timer.handle);
      schedule(id, timer);
    }
    setAnimationRates(previous, speed);
    refreshButtons();
    return speed;
  }
  Object.defineProperty(window, '__warpSetSpeed', { value: setSpeed, configurable: false });
  Object.defineProperty(window, '__warpGetSpeed', { value: () => speed, configurable: false });

  // A small non-invasive overlay; top frame only. Alt+W toggles visibility.
  let panel, buttons = [];
  function refreshButtons() {
    for (const button of buttons) {
      const selected = Number(button.dataset.speed) === speed;
      button.style.background = selected ? '#2563eb' : '#252e43';
      button.style.color = selected ? '#fff' : '#dbe6ff';
    }
  }
  function installPanel() {
    if (window !== window.top || panel || !document.documentElement) return;
    const host = document.createElement('div');
    host.setAttribute('data-warp-panel', '');
    host.style.cssText = 'all:initial!important;position:fixed!important;top:12px!important;right:12px!important;z-index:2147483647!important;pointer-events:auto!important;';
    const root = host.attachShadow({ mode: 'closed' });
    const box = document.createElement('div');
    box.style.cssText = 'display:flex;gap:5px;align-items:center;padding:7px;border:1px solid #64748b;border-radius:10px;background:#101827ee;color:#fff;font:12px system-ui,sans-serif;box-shadow:0 5px 22px #0007;';
    const label = document.createElement('span');
    label.textContent = 'WARP';
    label.style.cssText = 'font-weight:700;letter-spacing:.5px;padding:0 5px;';
    box.append(label);
    for (const x of allowed) {
      const button = document.createElement('button');
      button.dataset.speed = String(x);
      button.textContent = x + '×';
      button.title = 'Velocidad de los temporizadores y animaciones';
      button.style.cssText = 'border:0;border-radius:6px;padding:5px 7px;cursor:pointer;font:600 12px system-ui,sans-serif;';
      button.addEventListener('click', () => {
        setSpeed(x);
        // The Playwright binding distributes the setting to every iframe of this tab.
        if (typeof window.__warpSpeedChange === 'function') {
          Promise.resolve(window.__warpSpeedChange(x)).catch(() => {});
        }
      });
      buttons.push(button);
      box.append(button);
    }
    const hide = document.createElement('button');
    hide.textContent = '−';
    hide.title = 'Ocultar. Alt+W para volver a mostrar';
    hide.style.cssText = 'border:0;border-radius:6px;background:#35415b;color:#fff;cursor:pointer;padding:4px 7px;';
    hide.addEventListener('click', () => { host.style.display = 'none'; });
    box.append(hide);
    root.append(box);
    document.documentElement.append(host);
    panel = host;
    refreshButtons();
  }
  window.addEventListener('keydown', event => {
    if (window !== window.top || !event.altKey || event.code !== 'KeyW') return;
    if (event.ctrlKey || event.metaKey) return;
    event.preventDefault();
    if (!panel) installPanel();
    if (panel) panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
  }, true);
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', installPanel, { once: true });
  } else {
    installPanel();
  }
})();
