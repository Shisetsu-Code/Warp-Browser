// Playtech GPAS uses a GWT frame loop that reads Date.now() to advance its
// internal animation clock. RAF callback timestamps alone cannot accelerate it.
// Scope the virtual Date clock ONLY to the compiled game frame callback.
// No request interception, user-event rewriting, or global Date.now changes.
(() => {
  'use strict';
  try {
    const allowedHost = /(^|\.)playtechone\.com$/i.test(location.hostname) ||
      ['127.0.0.1', 'localhost'].includes(location.hostname); // offline tests
    if (!allowedHost || !/\/gpasclient\.html$/i.test(location.pathname)) return;
  } catch (_) { return; }
  if (window.__warpGpasClockInstalled) return;
  Object.defineProperty(window, '__warpGpasClockInstalled', { value: true });

  const realDateNow = Date.now.bind(Date);
  const realPerfNow = performance.now.bind(performance);
  let originalLoop, wrappedLoop, supported = false;
  let frames = 0, acceleratedFrames = 0, previousFrame = null;
  let logicalEpoch = realDateNow(), lastStep = 0, lastError = null;

  function speed() {
    const rate = Number(window.__warpGetEffectiveSpeed?.() || 1);
    return [1, 2, 4, 8, 16].includes(rate) ? rate : 1;
  }
  function advanceClock(rate) {
    const now = realPerfNow();
    if (previousFrame === null) {
      previousFrame = now;
      logicalEpoch = realDateNow();
      return logicalEpoch;
    }
    const elapsed = Math.max(0, now - previousFrame);
    previousFrame = now;
    // GPAS discards GWT simulation steps over 1000ms. Avoid a giant jump
    // after Chromium throttles a hidden tab or an overloaded rendering frame.
    lastStep = Math.min(elapsed * rate, 900);
    logicalEpoch += lastStep;
    return Math.round(logicalEpoch);
  }
  function wrapGameLoop(loop) {
    return function warpGpasFrame(...args) {
      const rate = speed();
      if (rate === 1 && acceleratedFrames === 0) {
        previousFrame = realPerfNow();
        logicalEpoch = realDateNow();
        frames++;
        return Reflect.apply(loop, this, args);
      }
      const gameNow = advanceClock(rate);
      const originalDateNow = Date.now;
      try {
        // Browser input events and network callbacks execute outside this
        // synchronous scope and always see their original system clock.
        Date.now = () => gameNow;
        frames++;
        if (rate > 1) acceleratedFrames++;
        return Reflect.apply(loop, this, args);
      } catch (error) {
        lastError = String(error?.message || error).slice(0, 120);
        throw error;
      } finally {
        Date.now = originalDateNow;
      }
    };
  }
  function assignLoop(fn) {
    originalLoop = fn;
    if (typeof fn !== 'function') {
      supported = false;
      wrappedLoop = fn;
      return;
    }
    let source = '';
    try { source = Function.prototype.toString.call(fn); } catch (_) { /* ignore */ }
    // Exact GWT dispatcher signature found in Playtech's captured JS bundle.
    supported = source.includes('frameBudget') &&
      source.includes('lastTick') && source.includes('requestAnimFrame');
    wrappedLoop = supported ? wrapGameLoop(fn) : fn;
  }

  const previous = Object.getOwnPropertyDescriptor(window, 'fnRequestAnimationFrame');
  if (previous && !previous.configurable) return;
  if (previous && 'value' in previous) assignLoop(previous.value);
  else if (previous?.get) {
    try { assignLoop(previous.get.call(window)); } catch (_) { /* ignore */ }
  }
  Object.defineProperty(window, 'fnRequestAnimationFrame', {
    configurable: true,
    enumerable: true,
    get() { return wrappedLoop; },
    set(fn) {
      if (fn === wrappedLoop || fn === originalLoop) return;
      assignLoop(fn);
    }
  });
  Object.defineProperty(window, '__warpGetGpasStatus', {
    value: () => ({
      supported, frames, acceleratedFrames,
      selectedSpeed: window.__warpGetSpeed?.() ?? 1,
      effectiveSpeed: speed(), lastStepMS: Math.round(lastStep * 100) / 100,
      lastError
    })
  });
})();
