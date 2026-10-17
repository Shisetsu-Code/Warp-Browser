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

  // Timers and generic RAF timestamps are virtual. PIXI gets real RAF timestamps
  // and a scaled ticker.speed instead; combining both would accelerate twice.
  // Date.now(), performance.now(), input event timestamps, and network clocks
  // remain real.
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
  window.requestAnimationFrame = callback => native.raf(timestamp => {
    // PIXI's own Ticker multiplies deltaMS by ticker.speed. Passing a virtual
    // timestamp as well would double-scale it and hit its 100 ms safety clamp.
    const pixiTicker = window.PIXI?.Ticker;
    callback.call(window, pixiTicker ? timestamp : virtualNow());
  });

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
  // Engine clocks: Nolimit City Airport Security exposes __PIXI_APP__ and
  // bundles GSAP privately. Accelerating RAF arguments alone is not sufficient
  // for GSAP, and is clamped by PIXI.Ticker. Never hook fetch/XHR/WebSocket or
  // modify event.timeStamp / native Date.now / performance.now.
  const engineBaselines = new WeakMap();
  const nativeFastSpinState = new WeakMap();
  let gsapRoot = null;
  let engineInfo = { pixi: false, gsap: false, gsapSource: null, nativeFastSpin: null };

  // Airport Security is primarily driven by GSAP, not by its PIXI.Application
  // ticker (the application starts with autoStart:false). The demo also offers
  // an official fast-spin mode which affects actual reel/flow durations. Use
  // that only on an explicitly identifiable free-play demo, and restore it at 1x.
  // No bet API is invoked and no network calls are intercepted or modified.
  function updateDemoNativeFastSpin() {
    let fastSpin, api;
    try {
      const plugins = window.NolimitLauncher?.constructor?.plugins;
      if (!Array.isArray(plugins)) return null;
      for (const plugin of plugins) {
        api = plugin?.constructor?.apiPlugin;
        if (api?.fastSpin) break;
        api = null;
      }
      fastSpin = api?.fastSpin;
      if (!fastSpin || typeof fastSpin.setSpeed !== 'function') return null;
      const demo = api.options?.funMode === true &&
        api.gameClientConfiguration?.operator === 'FANPAGE_DEMO';
      const eligible = demo && fastSpin.isEnabled === true;
      const before = Number(fastSpin.speed);
      let saved = nativeFastSpinState.get(fastSpin);
      if (!Number.isFinite(before)) return null;
      if (eligible && selectedSpeed > 1) {
        if (!saved) {
          saved = { original: before, applied: null };
          nativeFastSpinState.set(fastSpin, saved);
        }
        // Respect the provider's own supported values: 0=normal, 1=fast,
        // 2=mega only where the game declares support.
        const desired = selectedSpeed >= 8 && fastSpin._gameHasSupportMegaSupport ? 2 : 1;
        if (saved.applied === null || before === saved.applied) {
          if (before !== desired) fastSpin.setSpeed(desired);
          saved.applied = desired;
        }
      } else if (saved && saved.applied !== null) {
        // Don't override any changes the user made through the game's controls.
        if (before === saved.applied && before !== saved.original) fastSpin.setSpeed(saved.original);
        saved.applied = null;
      }
      return {
        eligible,
        enabled: Boolean(fastSpin.isFastSpin),
        nativeSpeed: Number(fastSpin.speed),
        gameMode: 'free-play'
      };
    } catch (_) { return null; }
  }

  function scaleEngineClock(clock) {
    if (!clock || typeof clock.timeScale !== 'function') return false;
    try {
      if (!engineBaselines.has(clock)) {
        const initial = clock.timeScale();
        if (!Number.isFinite(initial) || initial <= 0) return false;
        engineBaselines.set(clock, initial);
      }
      const target = engineBaselines.get(clock) * effectiveSpeed;
      if (clock.timeScale() !== target) clock.timeScale(target);
      return true;
    } catch (_) { return false; }
  }

  function scalePixiTicker(ticker) {
    if (!ticker || typeof ticker.speed !== 'number') return false;
    try {
      if (!engineBaselines.has(ticker)) {
        if (!Number.isFinite(ticker.speed) || ticker.speed <= 0) return false;
        engineBaselines.set(ticker, ticker.speed);
      }
      const target = engineBaselines.get(ticker) * effectiveSpeed;
      if (ticker.speed !== target) ticker.speed = target;
      return true;
    } catch (_) { return false; }
  }

  function findGsapRoot() {
    try {
      if (window.gsap?.globalTimeline?.timeScale) {
        return { root: window.gsap.globalTimeline, source: 'global' };
      }
      // Nolimit City's source exports window.NolimitLauncher, but GSAP lives
      // inside its webpack bundle. The game's Speedster.setTimeline() factory
      // creates a GSAP Timeline; its parent is the engine-wide root. This uses
      // the game's public runtime objects, not source rewriting or request hooks.
      const plugins = window.NolimitLauncher?.constructor?.plugins;
      if (!Array.isArray(plugins)) return null;
      for (const plugin of plugins) {
        const speedster = plugin?.constructor?.speedster;
        const factory = speedster?.constructor?.setTimeline;
        if (typeof factory !== 'function') continue;
        const probe = factory.call(speedster.constructor, null, null);
        const root = probe?.parent || probe?._dp;
        try { probe?.kill?.(); } catch (_) { /* avoid lingering probe */ }
        if (typeof root?.timeScale === 'function') {
          return { root, source: 'nolimit-speedster' };
        }
      }
    } catch (_) { /* unsupported game, leave default behavior */ }
    return null;
  }

  function updateGameEngines() {
    let pixi = false, gsap = false;
    try {
      const appTicker = window.__PIXI_APP__?.ticker;
      const sharedTicker = window.PIXI?.Ticker?.shared;
      pixi = scalePixiTicker(appTicker) || pixi;
      pixi = scalePixiTicker(sharedTicker) || pixi;
      // Never scale PIXI.Ticker.system: it handles interaction/pointer upkeep.
    } catch (_) { /* engine not initialized */ }
    if (!gsapRoot) {
      const found = findGsapRoot();
      if (found) {
        gsapRoot = found.root;
        engineInfo.gsapSource = found.source;
      }
    }
    if (gsapRoot) gsap = scaleEngineClock(gsapRoot);
    engineInfo.pixi = pixi;
    engineInfo.gsap = gsap;
    engineInfo.pixiTickerRunning = window.__PIXI_APP__?.ticker?.started === true;
    engineInfo.nativeFastSpin = updateDemoNativeFastSpin();
    if (chip) refreshButtons();
  }

  // Use a native, unaccelerated interval: engines may finish loading after the
  // user selected 8×, without requiring another click in Warp's toolbar.
  native.setInterval(updateGameEngines, 500);
  Object.defineProperty(window, '__warpGetEngineStatus', {
    value: () => ({ ...engineInfo, selectedSpeed, effectiveSpeed }),
    configurable: false
  });

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
    updateGameEngines();
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
    // Native fast-spin is tied to the selected setting, not the temporary
    // input-protection pause; a click on Spin must start in fast mode.
    updateGameEngines();
    refreshButtons();
    return selectedSpeed;
  }
  Object.defineProperty(window, '__warpSetSpeed', { value: setSpeed, configurable: false });
  Object.defineProperty(window, '__warpGetSpeed', { value: () => selectedSpeed, configurable: false });
  Object.defineProperty(window, '__warpGetEffectiveSpeed', { value: () => effectiveSpeed, configurable: false });

  // Compact panel: unlike v0.1.0, the full-width toolbar never covers the
  // game's buttons unless explicitly expanded. Alt+W hides it entirely.
  let panel, chip, menu, buttons = [];
  let gpasSummary = null;
  // The manager reports the measured GWT clock from any cross-origin iframe.
  Object.defineProperty(window, '__warpSetEngineStatus', {
    value: value => {
      if (!value || typeof value !== 'object') return false;
      gpasSummary = {
        detected: value.detected === true,
        live: value.live === true,
        confirmed: value.confirmed === true,
        clockMultiplier: Number.isFinite(value.clockMultiplier) ? value.clockMultiplier : null
      };
      refreshButtons();
      return true;
    }, configurable: false
  });
  Object.defineProperty(window, '__warpGetEngineSummary', {
    value: () => gpasSummary ? { ...gpasSummary } : null, configurable: false
  });
  function refreshButtons() {
    if (chip) {
      const turbo = engineInfo.nativeFastSpin?.eligible &&
        engineInfo.nativeFastSpin?.enabled && selectedSpeed > 1;
      const verified = selectedSpeed > 1 && gpasSummary?.confirmed &&
        Number.isFinite(gpasSummary?.clockMultiplier);
      const suffix = selectedSpeed === 1 ? '' : verified
        ? ` · GWT ${gpasSummary.clockMultiplier.toFixed(1)}×`
        : (gpasSummary?.detected ? ' · GWT …' : ' · ?');
      chip.textContent = `WARP ${selectedSpeed}×${turbo ? ' TURBO' : ''}${suffix}`;
      chip.title = selectedSpeed === 1
        ? 'Velocidad normal del navegador'
        : verified
          ? `${selectedSpeed}× seleccionado. Reloj GWT medido: ${gpasSummary.clockMultiplier.toFixed(1)}×. No mide el tiempo total de cada tirada.`
          : `${selectedSpeed}× seleccionado. Aceleración del motor GWT todavía no verificada; ? no significa que la tirada vaya más rápido.`;
    }
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
      button.title = 'Acelerar JS, PIXI y GSAP cuando estén disponibles, sin alterar clics ni tráfico';
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
  // New/lazy frames sync speed even if navigation events were too early.
  if (typeof window.__warpGetTabSpeed === 'function') {
    Promise.resolve(window.__warpGetTabSpeed())
      .then(value => setSpeed(value)).catch(() => {});
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', installPanel, { once: true });
  } else {
    installPanel();
  }
})();
