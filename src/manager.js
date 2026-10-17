'use strict';

const { HarRecorder } = require('./har');
const { saveCapture } = require('./dialog');

function requestPage(request) {
  try { return request.frame().page(); } catch (_) { return null; }
}

class BrowserManager {
  constructor(context, { recoveryDir, dialog, downloadDir, logger = console } = {}) {
    if (!recoveryDir) throw new Error('recoveryDir is required');
    this.context = context;
    this.recoveryDir = recoveryDir;
    this.dialog = dialog;
    this.downloadDir = downloadDir;
    this.logger = logger;
    this.sessions = new Map();
    this.inflight = new Map();
    this.handledRequests = new WeakSet();
    this.speedByPage = new Map();
    this.gpasByPage = new Map();
    this.gpasViews = new Map();
    this.closing = new Map();
    this.saveQueue = Promise.resolve();
    this.orphanRecorder = null;
    this.shutdownPromise = null;
  }

  async start() {
    // Register network event listeners before any URL is navigated. Neither
    // route() nor any other request-modifying API is used anywhere.
    this.context.on('request', request => {
      const page = requestPage(request);
      if (page) this.registerPage(page);
      this.inflight.set(request, { page, started: Date.now() });
    });
    this.context.on('requestfinished', request => this.completeRequest(request, false));
    this.context.on('requestfailed', request => this.completeRequest(request, true));
    this.context.on('page', page => this.registerPage(page));
    await this.context.exposeBinding('__warpSpeedChange', async ({ page }, speed) => {
      await this.setSpeed(page, speed);
    });
    // Frame navigations may race init scripts; new frames pull selected speed.
    await this.context.exposeBinding('__warpGetTabSpeed', ({ page }) => this.speedByPage.get(page) || 1);
    await this.context.exposeBinding('__warpReportGpasStatus', ({ page, frame }, report) => {
      this.reportGpasStatus(page, frame, report);
    });
    await this.context.addInitScript({ path: require('node:path').join(__dirname, 'preload.js') });
    await this.context.addInitScript({ path: require('node:path').join(__dirname, 'playtech-gwt.js') });
    for (const page of this.context.pages()) this.registerPage(page);
  }

  registerPage(page) {
    if (this.sessions.has(page)) return this.sessions.get(page);
    const recorder = new HarRecorder(this.recoveryDir, { url: page.url() });
    this.sessions.set(page, recorder);
    this.speedByPage.set(page, 1);
    page.on('close', () => { void this.closePage(page); });
    page.on('websocket', ws => recorder.recordWebSocket(ws));
    page.on('framenavigated', frame => {
      this.forgetGpasFrame(page, frame);
      if (frame === page.mainFrame()) recorder.updateURL(frame.url());
      const speed = this.speedByPage.get(page) || 1;
      if (speed !== 1) void this.applySpeedToFrame(frame, speed);
    });
    page.on('framedetached', frame => this.forgetGpasFrame(page, frame));
    page.on('frameattached', frame => {
      const speed = this.speedByPage.get(page) || 1;
      if (speed !== 1) void this.applySpeedToFrame(frame, speed);
    });
    this.logger.log('[TAB +]', page.url());
    return recorder;
  }


  reportGpasStatus(page, frame, value) {
    if (!this.sessions.has(page) || page.isClosed() || !frame ||
        value?.engine !== 'playtech-gwt' || typeof value.detected !== 'boolean') return;
    let frames = this.gpasByPage.get(page);
    if (!frames) { frames = new Map(); this.gpasByPage.set(page, frames); }
    const multiplier = Number(value.clockMultiplier);
    frames.set(frame, {
      detected: value.detected, live: value.live === true,
      confirmed: value.confirmed === true,
      selectedSpeed: Number(value.selectedSpeed),
      clockMultiplier: Number.isFinite(multiplier) && multiplier >= 0 &&
        multiplier <= 32 && value.clockMultiplier !== null ? multiplier : null,
      time: Date.now()
    });
    this.renderGpasStatus(page);
  }

  forgetGpasFrame(page, frame) {
    if (frame === page.mainFrame()) this.gpasByPage.delete(page);
    else this.gpasByPage.get(page)?.delete(frame);
    this.gpasViews.delete(page);
    this.renderGpasStatus(page);
  }

  renderGpasStatus(page) {
    if (page.isClosed()) return;
    const selectedSpeed = this.speedByPage.get(page) || 1;
    const reports = [...(this.gpasByPage.get(page)?.values() || [])]
      .filter(s => s.detected && Date.now() - s.time < 4000);
    const live = reports.filter(s => s.live);
    // Verification measures only the GWT frame clock, not a complete spin.
    const verified = live.find(s => s.confirmed &&
      s.selectedSpeed === selectedSpeed && s.clockMultiplier !== null);
    const summary = {
      detected: reports.length > 0,
      live: live.length > 0,
      confirmed: Boolean(verified),
      clockMultiplier: verified?.clockMultiplier ?? null
    };
    const key = JSON.stringify({ selectedSpeed, ...summary });
    if (this.gpasViews.get(page) === key) return;
    this.gpasViews.set(page, key);
    void page.mainFrame().evaluate(value =>
      window.__warpSetEngineStatus?.(value) === true, summary)
      .then(ok => { if (!ok && this.gpasViews.get(page) === key) this.gpasViews.delete(page); })
      .catch(() => { if (this.gpasViews.get(page) === key) this.gpasViews.delete(page); });
  }

  async applySpeedToFrame(frame, speed) {
    try { await frame.evaluate(value => window.__warpSetSpeed?.(value), speed); } catch (_) { /* navigation race */ }
  }

  async setSpeed(page, speed) {
    const value = Number(speed);
    if (![1, 2, 4, 8, 16].includes(value) || page.isClosed()) return;
    this.speedByPage.set(page, value);
    this.gpasViews.delete(page);
    this.renderGpasStatus(page);
    await Promise.allSettled(page.frames().map(frame => this.applySpeedToFrame(frame, value)));
    this.logger.log(`[SPEED] ${value}x ${page.url()}`);
  }

  completeRequest(request, failed) {
    if (this.handledRequests.has(request)) return;
    this.handledRequests.add(request);
    const info = this.inflight.get(request);
    this.inflight.delete(request);
    const page = info?.page || requestPage(request);
    // A late requestfailed event must not resurrect a tab that is already closed.
    if (page && this.closing.has(page)) return;
    const recorder = page ? this.sessions.get(page) || this.registerPage(page) : this.getOrphanRecorder();
    recorder.recordRequest(request, info?.started || Date.now(), failed);
  }

  getOrphanRecorder() {
    if (!this.orphanRecorder) this.orphanRecorder = new HarRecorder(this.recoveryDir, { url: 'unattributed-service-workers' });
    return this.orphanRecorder;
  }

  enqueueSave(capture) {
    // Native file dialogs must not overlap when several tabs close together.
    const doSave = async () => {
      try {
        const status = await saveCapture(capture, { dialog: this.dialog, destinationDir: this.downloadDir });
        if (status.saved) this.logger.log('[HAR saved]', status.path);
        else this.logger.warn('[HAR recoverable]', status.backup);
      } catch (error) {
        this.logger.error('[HAR could not be saved]', error.message, 'Recovery:', capture.harPath);
      }
    };
    this.saveQueue = this.saveQueue.catch(() => {}).then(doSave);
    return this.saveQueue;
  }

  closePage(page) {
    if (this.closing.has(page)) return this.closing.get(page);
    const recorder = this.sessions.get(page);
    if (!recorder) return Promise.resolve();
    // Finish outstanding requests before finalizing their tab's HAR.
    for (const [request, info] of this.inflight) {
      if (info.page !== page) continue;
      this.inflight.delete(request);
      this.handledRequests.add(request);
      recorder.recordRequest(request, info.started, true);
    }
    const job = (async () => {
      try {
        const capture = await recorder.finalize();
        this.logger.log(`[TAB -] ${capture.entryCount} HTTP, ${capture.wsCount} WS frames`);
        await this.enqueueSave(capture);
      } catch (error) {
        this.logger.error('[HAR finalization failed]', error.message, 'Recovery:', recorder.ndjsonPath);
      } finally {
        this.sessions.delete(page);
        this.speedByPage.delete(page);
        this.gpasByPage.delete(page);
        this.gpasViews.delete(page);
      }
    })();
    this.closing.set(page, job);
    return job;
  }

  shutdown() {
    if (this.shutdownPromise) return this.shutdownPromise;
    this.shutdownPromise = (async () => {
      for (const [request, info] of this.inflight) {
        this.inflight.delete(request);
        this.handledRequests.add(request);
        const recorder = info.page ? this.sessions.get(info.page) : this.getOrphanRecorder();
        recorder?.recordRequest(request, info.started, true);
      }
      await Promise.all([
        ...Array.from(this.sessions.keys(), page => this.closePage(page)),
        ...this.closing.values()
      ]);
      if (this.orphanRecorder) {
        try {
          const capture = await this.orphanRecorder.finalize();
          await this.enqueueSave(capture);
        } catch (error) { this.logger.error('[Orphan capture]', error.message); }
      }
      await this.saveQueue;
    })();
    return this.shutdownPromise;
  }
}

module.exports = { BrowserManager, requestPage };
