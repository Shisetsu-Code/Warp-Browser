// Playwright addInitScript: runs before a site's JavaScript in every frame.
// Deliberately does NOT intercept requests, change Date.now/performance.now,
// or replace any input events. Real clocks are required for pointer semantics,
// game session expiry and interaction validation.
(() => {
  'use strict';
  if (window.__WARP_CLOCK_INSTALLED__) return;
  Object.defineProperty(window, '__WARP_CLOCK_INSTALLED__', { value: true });

  const native = {
    now: performance.now.bind(performance),
    setTimeout: window.setTimeout.bind(window),
    clearTimeout: window.clearTimeout.bind(window),
    setInterval: window.setInterval.bind(window),
    clearInterval: window.clearInterval.bind(window),
    raf: window.requestAnimationFrame.bind(window),
    animate: Element.prototype.animate
  };
  const allowed = [1, 2, 4, 8, 16];
  let selectedSpeed = 1;
  let effectiveSpeed = 1;
  let realAnchor = native.now();
  let virtualAnchor = realAnchor;
  let timerId = 1_000_000_000;
  const timers = new Map();

  // Only the clock passed to requestAnimationFrame and the timer scheduler is
  // virtual. Browser APIs, PointerEvent.timeStamp, performance.now and Date.now
  // all remain on the same real timeline.
  function virtualNow() {
    return virtualAnchor + (native.now() - realAnchor) * effectiveSpeed;
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
          // The browser continues to evaluate string handlers under its CSP.
          native.setTimeout(timer.callback, 0);
        }
      } finally {
        if (timer.interval && timers.get(id) === timer) schedule(id, timer);
      }
    }, Math.max(0, remain / effectiveSpeed));
  }
  function createTimer(callback, delay, interval, args) {
    const id = timerId++;
    const period = Math.max(1, Number(delay) || 0);
    const timer = {
      callback, args, interval, period,
      target: virtualNow() + (interval ? period : Math.max(0, Number(delay) || 0)),
      handle: null
    };
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
  window.requestAnimationFrame = callback => native.raf(() => callback.call(window, virtualNow()));

  if (typeof native.animate === 'function') {
    Element.prototype.animate = function (...args) {
      const animation = native.animate.apply(this, args);
      try { animation.playbackRate *= effectiveSpeed; } catch (_) { /* ignored */ }
      return animation;
    };
  }
  function setAnimationRates(oldSpeed, newSpeed) {
    if (!document.getAnimations) return;
    try {
      for (const animation of document.getAnimations({ subtree: true })) {
        if (animation.playbackRate) animation.playbackRate = animation.playbackRate / oldSpeed * newSpeed;
      }
    } catch (_) { /* e.g. animation removed during enumeration */ }
  }
  function setEffectiveSpeed(next) {
    if (next === effectiveSpeed) return;
    const now = native.now();
    virtualAnchor += (now - realAnchor) * effectiveSpeed;
    realAnchor = now;
    const oldSpeed = effectiveSpeed;
    effectiveSpeed = next;
    for (const [id, timer] of timers) {
      native.clearTimeout(timer.handle);
      schedule(id, timer);
    }
    setAnimationRates(oldSpeed, effectiveSpeed);
  }

  // Guard interaction frames from accelerated timers/animations. We change
  // only virtual scheduling; pointer/keyboard events are delivered unchanged.
  const activePointers = new Set();
  const activeKeys = new Set();
  const INPUT_SETTLE_MS = 350;
  let resumeHandle = null;
  function suspendSpeed() {
    if (resumeHandle !== null) native.clearTimeout(resumeHandle);
    resumeHandle = null;
    setEffectiveSpeed(1);
  }
  function resumeAfterInput() {
    if (resumeHandle !== null) native.clearTimeout(resumeHandle);
    if (activePointers.size || activeKeys.size) return;
    resumeHandle = native.setTimeout(() => {
      resumeHandle = null;
      if (!activePointers.size && !activeKeys.size) setEffectiveSpeed(selectedSpeed);
    }, INPUT_SETTLE_MS);
  }
  function clearInput() {
    activePointers.clear();
    activeKeys.clear();
    resumeAfterInput();
  }
  window.addEventListener('pointerdown', event => {
    if (!event.isTrusted) return;
    activePointers.add(event.pointerId);
    suspendSpeed();
  }, true);
  function releasePointer(event) {
    if (!event.isTrusted) return;
    activePointers.delete(event.pointerId);
    resumeAfterInput();
  }
  window.addEventListener('pointerup', releasePointer, true);
  window.addEventListener('pointercancel', releasePointer, true);
  window.addEventListener('click', event => {
    if (!event.isTrusted) return;
    suspendSpeed();
    resumeAfterInput();
  }, true);
  window.addEventListener('keydown', event => {
    if (!event.isTrusted) return;
    activeKeys.add(event.code || event.key);
    suspendSpeed();
  }, true);
  window.addEventListener('keyup', event => {
    if (!event.isTrusted) return;
    activeKeys.delete(event.code || event.key);
    resumeAfterInput();
  }, true);
  window.addEventListener('blur', clearInput, true);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') clearInput();
  }, true);

  function setSpeed(value) {
    const next = Number(value);
    if (!allowed.includes(next)) return selectedSpeed;
    selectedSpeed = next;
    if (!activePointers.size && !activeKeys.size && resumeHandle === null) setEffectiveSpeed(next);
    refreshButtons();
    return selectedSpeed;
  }
  Object.defineProperty(window, '__warpSetSpeed', { value: setSpeed, configurable: false });
  Object.defineProperty(window, '__warpGetSpeed', { value: () => selectedSpeed, configurable: false });
  Object.defineProperty(window, '__warpGetEffectiveSpeed', { value: () => effectiveSpeed, configurable: false });

  // Compact panel: unlike v0.1.0, the full-width toolbar never covers the
  // game's buttons unless explicitly expanded. Alt+W hides it entirely.
  let panel, chip, menu, buttons = [];
  function refreshButtons() {
    if (chip) chip.textContent = `WARP ${selectedSpeed}×`;
    for (const button of buttons) {
      const selected = Number(button.dataset.speed) === selectedSpeed;
      button.style.background = selected ? '#2563eb' : '#252e43';
      button.style.color = selected ? '#fff' : '#dbe6ff';
    }
  }
  function installPanel() {
    if (window !== window.top || panel || !document.documentElement) return;
    const host = document.createElement('div');
    host.setAttribute('data-warp-panel', '');
    host.style.cssText = 'all:initial!important;position:fixed!important;top:12px!important;right:12px!important;z-index:2147483647!important;pointer-events:none!important;';
    const root = host.attachShadow({ mode: 'closed' });
    const wrapper = document.createElement('div');
    wrapper.style.cssText = 'display:flex;flex-direction:column;align-items:flex-end;gap:4px;font:12px system-ui,sans-serif;';
    const toggle = document.createElement('button');
    toggle.textContent = 'WARP 1×';
    toggle.type = 'button';
    toggle.title = 'Abrir velocidades. Alt+W oculta el control.';
    toggle.style.cssText = 'pointer-events:auto;white-space:nowrap;border:1px solid #64748b;border-radius:7px;background:#101827ee;color:#fff;cursor:pointer;padding:6px 8px;font:600 12px system-ui,sans-serif;';
    chip = toggle;
    const options = document.createElement('div');
    options.style.cssText = 'display:none;pointer-events:auto;gap:5px;align-items:center;padding:7px;border:1px solid #64748b;border-radius:9px;background:#101827ee;box-shadow:0 5px 22px #0007;';
    menu = options;
    toggle.addEventListener('click', () => {
      options.style.display = options.style.display === 'none' ? 'flex' : 'none';
    });
    for (const x of allowed) {
      const button = document.createElement('button');
      button.type = 'button';
      button.dataset.speed = String(x);
      button.textContent = x + '×';
      button.title = 'Acelerar temporizadores y animaciones, manteniendo clics y relojes reales';
      button.style.cssText = 'border:0;border-radius:6px;padding:5px 7px;cursor:pointer;font:600 12px system-ui,sans-serif;';
      button.addEventListener('click', () => {
        setSpeed(x);
        options.style.display = 'none';
        // ExposeBinding distributes speed to all same-tab iframes.
        if (typeof window.__warpSpeedChange === 'function') {
          Promise.resolve(window.__warpSpeedChange(x)).catch(() => {});
        }
      });
      buttons.push(button);
      options.append(button);
    }
    wrapper.append(toggle, options);
    root.append(wrapper);
    document.documentElement.append(host);
    panel = host;
    refreshButtons();
  }
  window.addEventListener('keydown', event => {
    if (window !== window.top || !event.altKey || event.code !== 'KeyW') return;
    if (event.ctrlKey || event.metaKey) return;
    event.preventDefault();
    if (!panel) installPanel();
    if (panel) {
      panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
      if (menu) menu.style.display = 'none';
    }
  }, true);
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', installPanel, { once: true });
  } else {
    installPanel();
  }
})();
