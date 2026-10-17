// Dynamic Playtech GPAS/GWT adapter. Installed in every frame before page JS,
// regardless of hostname or pathname. It patches ONLY a positively identified
// GWT animation callback, never requests, responses, event timestamps or input.
(() => {
  'use strict';
  if (window.__warpGpasProbeInstalled) return;
  Object.defineProperty(window, '__warpGpasProbeInstalled', { value: true });

  const nativeDateNow = Date.now.bind(Date);
  const nativePerfNow = performance.now.bind(performance);
  // Run adapter probes on real time, not virtual game time.
  const nativeSetInterval = typeof window.__warpNativeSetInterval === 'function'
    ? window.__warpNativeSetInterval : window.setInterval.bind(window);
  const CLOCK_LIMIT_MS = 900;
  const DETECT_EVERY_MS = 350;
  const REPORT_EVERY_MS = 900;

  let originalLoop = null;
  let wrappedLoop = null;
  let detected = false;
  let frames = 0;
  let acceleratedFrames = 0;
  let reinstalls = 0;
  let lastError = null;
  let previousFrame = null;
  let logicalEpoch = nativeDateNow();
  let lastFrameAt = 0;
  let previousRate = 1;
  let realWindow = 0;
  let logicalWindow = 0;
  let countWindow = 0;
  let observedSpeed = null;
  let measuredAt = 0;
  let lastStep = 0;

  function selectedSpeed() {
    const rate = Number(window.__warpGetSpeed?.() ?? 1);
    return [1, 2, 4, 8, 16].includes(rate) ? rate : 1;
  }
  function effectiveSpeed() {
    const rate = Number(window.__warpGetEffectiveSpeed?.() ?? 1);
    return [1, 2, 4, 8, 16].includes(rate) ? rate : 1;
  }
  function signatureMatches(fn) {
    if (typeof fn !== 'function') return false;
    let source;
    try { source = Function.prototype.toString.call(fn); } catch (_) { return false; }
    // Actual GWT dispatcher extracted from the Buffalo Blitz II HAR.
    // Require the full signature to avoid modifying unrelated browser pages.
    return source.includes('frameBudget') && source.includes('lastTick') &&
      source.includes('requestAnimFrame') && source.includes('Date.now');
  }
  function resetMeasurements() {
    realWindow = logicalWindow = countWindow = 0;
    observedSpeed = null;
    measuredAt = 0;
  }
  function advanceClock(rate) {
    const now = nativePerfNow();
    lastFrameAt = now;
    if (rate !== previousRate) {
      previousRate = rate;
      resetMeasurements();
    }
    if (previousFrame === null) {
      previousFrame = now;
      logicalEpoch = nativeDateNow();
      return Math.round(logicalEpoch);
    }
    const elapsed = Math.max(0, now - previousFrame);
    previousFrame = now;
    const step = Math.min(elapsed * rate, CLOCK_LIMIT_MS);
    lastStep = step;
    logicalEpoch += step;
    // Report the measured rate of the game clock, NOT the duration of spins.
    // Ignore clamped/hidden-tab frames when estimating its effective speed.
    if (elapsed > 0 && elapsed < 180 && step < CLOCK_LIMIT_MS) {
      realWindow += elapsed;
      logicalWindow += step;
      countWindow++;
      if (realWindow >= 250 && countWindow >= 4) {
        observedSpeed = Math.round(10 * logicalWindow / realWindow) / 10;
        measuredAt = now;
        realWindow = logicalWindow = countWindow = 0;
      }
    }
    return Math.round(logicalEpoch);
  }
  function wrapLoop(fn) {
    return function warpGwtAnimationFrame(...args) {
      const rate = effectiveSpeed();
      frames++;
      if (rate === 1 && acceleratedFrames === 0) {
        previousFrame = nativePerfNow();
        logicalEpoch = nativeDateNow();
        lastFrameAt = previousFrame;
        return Reflect.apply(fn, this, args);
      }
      const logicalNow = advanceClock(rate);
      const oldDateNow = Date.now;
      try {
        Date.now = () => logicalNow;
        if (rate > 1) acceleratedFrames++;
        return Reflect.apply(fn, this, args);
      } catch (error) {
        lastError = String(error?.message || error).slice(0, 140);
        throw error;
      } finally {
        // Always restore the native, real-time API before input or network work.
        Date.now = oldDateNow;
      }
    };
  }
  function probe() {
    let fn;
    try { fn = window.fnRequestAnimationFrame; } catch (_) { return; }
    if (fn === wrappedLoop && detected) return;
    if (!signatureMatches(fn)) {
      if (detected && fn !== wrappedLoop) {
        detected = false;
        originalLoop = wrappedLoop = null;
        resetMeasurements();
      }
      return;
    }
    const descriptor = Object.getOwnPropertyDescriptor(window, 'fnRequestAnimationFrame');
    if (descriptor && (descriptor.writable === false || (descriptor.get && !descriptor.set))) {
      lastError = 'GWT frame callback is read-only';
      detected = false;
      return;
    }
    const candidate = wrapLoop(fn);
    try {
      window.fnRequestAnimationFrame = candidate;
      if (window.fnRequestAnimationFrame !== candidate) {
        lastError = 'GWT callback replacement was rejected';
        return;
      }
    } catch (error) {
      lastError = String(error?.message || error).slice(0, 140);
      return;
    }
    originalLoop = fn;
    wrappedLoop = candidate;
    detected = true;
    previousFrame = null;
    lastFrameAt = 0;
    logicalEpoch = nativeDateNow();
    acceleratedFrames = 0;
    previousRate = 1;
    resetMeasurements();
    reinstalls++;
    lastError = null;
    report();
  }
  function status() {
    const selected = selectedSpeed();
    const effective = effectiveSpeed();
    const age = lastFrameAt ? nativePerfNow() - lastFrameAt : Infinity;
    const live = detected && frames > 0 && age < 2500;
    const recent = measuredAt && nativePerfNow() - measuredAt < 1800;
    const confirmed = Boolean(live && selected > 1 && effective === selected &&
      recent && Number.isFinite(observedSpeed) &&
      observedSpeed >= selected * 0.8 && observedSpeed <= selected * 1.2);
    return {
      engine: 'playtech-gwt', detected, supported: detected, live, confirmed,
      selectedSpeed: selected, effectiveSpeed: effective,
      clockMultiplier: recent ? observedSpeed : null,
      frames, acceleratedFrames, reinstalls, lastStepMS: Math.round(lastStep * 100) / 100,
      lastFrameAgeMS: Number.isFinite(age) ? Math.round(age) : null,
      lastError
    };
  }
  function report() {
    // Absence of detection in ordinary frames needs no IPC. On replacement or
    // restart, report the status so the tab indicator can clear stale results.
    if (!detected && reinstalls === 0) return;
    try {
      const promise = window.__warpReportGpasStatus?.(status());
      if (promise && typeof promise.catch === 'function') promise.catch(() => {});
    } catch (_) { /* UI diagnostics must never interrupt the game */ }
  }
  Object.defineProperty(window, '__warpGetGpasStatus', {
    value: status, configurable: false
  });
  // Native intervals keep working when Warp accelerates setInterval globally.
  // Dynamic frames and hot-reloaded engines are detected without URL guesses.
  probe();
  nativeSetInterval(probe, DETECT_EVERY_MS);
  nativeSetInterval(report, REPORT_EVERY_MS);
})();
