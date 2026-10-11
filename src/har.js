'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { once } = require('node:events');
const readline = require('node:readline');

const MAX_BODY_WAIT_MS = 2000;

function headersFromObject(obj = {}) {
  return Object.entries(obj).map(([name, value]) => ({ name, value: String(value) }));
}

function getHeader(headers, name) {
  const found = headers.find(h => h.name.toLowerCase() === name.toLowerCase());
  return found?.value || '';
}

async function headersOf(message) {
  try {
    if (typeof message.headersArray === 'function') return await message.headersArray();
  } catch (_) { /* the page may have been closed */ }
  try { return headersFromObject(message.headers()); } catch (_) { return []; }
}

function textOrBase64(buffer, mime = '') {
  const body = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || '');
  const looksText = /^(text\/|application\/(?:json|javascript|xml|x-www-form-urlencoded|graphql)|image\/svg\+xml)|\+(?:json|xml)(?:;|$)/i.test(mime);
  if (looksText) {
    const text = body.toString('utf8');
    if (Buffer.from(text, 'utf8').equals(body)) return { text };
  }
  return { text: body.toString('base64'), encoding: 'base64' };
}

async function withTimeout(promise, ms, fallback) {
  let handle;
  try {
    return await Promise.race([
      Promise.resolve(promise),
      new Promise(resolve => { handle = setTimeout(() => resolve(fallback), ms); })
    ]);
  } catch (_) {
    return fallback;
  } finally {
    clearTimeout(handle);
  }
}

function harTimings(timing) {
  const diff = (end, start) => Number.isFinite(end) && Number.isFinite(start) && end >= start && start >= 0 ? end - start : -1;
  return {
    blocked: -1,
    dns: diff(timing.domainLookupEnd, timing.domainLookupStart),
    connect: diff(timing.connectEnd, timing.connectStart),
    ssl: diff(timing.connectEnd, timing.secureConnectionStart),
    send: diff(timing.responseStart, timing.requestStart) >= 0 ? 0 : -1,
    wait: diff(timing.responseStart, timing.requestStart),
    receive: diff(timing.responseEnd, timing.responseStart)
  };
}

async function buildHarEntry(request, started = Date.now(), failed = false) {
  let response = null;
  try { response = await withTimeout(request.response(), MAX_BODY_WAIT_MS, null); } catch (_) { /* ignored */ }
  const [reqHeaders, resHeaders] = await Promise.all([
    headersOf(request), response ? headersOf(response) : []
  ]);
  let postBuffer = null;
  try { postBuffer = request.postDataBuffer(); } catch (_) { /* ignored */ }
  const method = (() => { try { return request.method(); } catch (_) { return 'GET'; } })();
  const url = (() => { try { return request.url(); } catch (_) { return ''; } })();
  const req = {
    method, url, httpVersion: '', cookies: [], headers: reqHeaders,
    queryString: [], headersSize: -1, bodySize: postBuffer ? postBuffer.length : 0
  };
  try { req.queryString = [...new URL(url).searchParams].map(([name, value]) => ({ name, value })); } catch (_) { /* ignored */ }
  if (postBuffer !== null) {
    req.postData = { mimeType: getHeader(reqHeaders, 'content-type') || 'application/octet-stream', ...textOrBase64(postBuffer, getHeader(reqHeaders, 'content-type')) };
  }

  let status = 0;
  let statusText = '';
  let content = { size: 0, mimeType: getHeader(resHeaders, 'content-type') || 'application/octet-stream' };
  let redirectURL = getHeader(resHeaders, 'location');
  if (response) {
    try { status = response.status(); statusText = response.statusText(); } catch (_) { /* ignored */ }
    // Capture complete bodies, including binary images/scripts/wasm, without filtering.
    // On a tab closed mid-response, the body may not be recoverable.
    let body = null;
    try { body = await withTimeout(response.body(), MAX_BODY_WAIT_MS, null); } catch (_) { /* ignored */ }
    if (body) content = { size: body.length, mimeType: content.mimeType, ...textOrBase64(body, content.mimeType) };
  }
  let sizes = null;
  try { sizes = await withTimeout(request.sizes(), MAX_BODY_WAIT_MS, null); } catch (_) { /* ignored */ }
  if (sizes) {
    req.headersSize = sizes.requestHeadersSize ?? -1;
    req.bodySize = sizes.requestBodySize ?? req.bodySize;
  }
  let timing = {};
  try { timing = request.timing(); } catch (_) { /* ignored */ }
  const began = Number.isFinite(timing.startTime) && timing.startTime > 0 ? timing.startTime : started;
  const entry = {
    startedDateTime: new Date(began).toISOString(),
    time: Number.isFinite(timing.responseEnd) && timing.responseEnd >= 0 ? timing.responseEnd : Math.max(0, Date.now() - began),
    request: req,
    response: {
      status, statusText, httpVersion: '', cookies: [], headers: resHeaders,
      content, redirectURL, headersSize: sizes?.responseHeadersSize ?? -1,
      bodySize: sizes?.responseBodySize ?? content.size
    },
    cache: {}, timings: harTimings(timing)
  };
  if (failed) {
    let error = 'Request failed or tab closed';
    try { error = request.failure()?.errorText || error; } catch (_) { /* ignored */ }
    entry._warpError = error;
  }
  return entry;
}

function cleanFilename(url, fallback = 'capture') {
  try {
    const u = new URL(url);
    const pathname = u.pathname.split('/').filter(Boolean).pop() || 'home';
    return `${u.hostname}-${pathname}`.replace(/[^a-z0-9._-]/gi, '_').slice(0, 72) || fallback;
  } catch (_) {
    return fallback;
  }
}

function makeHarHeader(title, started) {
  return {
    version: '1.2',
    creator: { name: 'Warp Browser', version: '0.1.1' },
    browser: { name: 'Chromium (Playwright)' },
    pages: [{ startedDateTime: started, id: 'page_1', title, pageTimings: { onContentLoad: -1, onLoad: -1 } }]
  };
}

async function writeHarFromLines(ndjsonPath, harPath, meta = {}) {
  await fs.promises.mkdir(path.dirname(harPath), { recursive: true });
  const tmp = `${harPath}.${randomUUID()}.tmp`;
  const stream = fs.createWriteStream(tmp, { encoding: 'utf8' });
  const header = makeHarHeader(meta.url || 'Warp Tab', meta.started || new Date().toISOString());
  let entryCount = 0, wsCount = 0, firstEntry = true, firstWs = true;
  async function writeChunk(chunk) {
    if (!stream.write(chunk)) await once(stream, 'drain');
  }
  // Pass one for HTTP entries, one for optional WebSocket frames.
  async function processPass(kind, fn) {
    const input = fs.createReadStream(ndjsonPath, { encoding: 'utf8' });
    for await (const line of readline.createInterface({ input, crlfDelay: Infinity })) {
      if (!line.trim()) continue;
      let event;
      try { event = JSON.parse(line); } catch (_) { continue; } // interrupted last line
      if (event.kind === kind) await fn(event.value);
    }
  }
  try {
    await writeChunk('{"log":' + JSON.stringify({ ...header, _warpNote: 'Raw, unfiltered requests. Frames are stored in _warpWebSockets.' }).slice(0, -1) + ',"entries":[');
    await processPass('http', async value => {
      await writeChunk((firstEntry ? '' : ',') + JSON.stringify({ pageref: 'page_1', ...value }));
      firstEntry = false;
      entryCount++;
    });
    await writeChunk('],"_warpWebSockets":[');
    await processPass('ws', async value => {
      await writeChunk((firstWs ? '' : ',') + JSON.stringify(value));
      firstWs = false;
      wsCount++;
    });
    stream.end(']}}');
    await once(stream, 'finish');
    await fs.promises.rename(tmp, harPath);
    return { entryCount, wsCount, harPath };
  } catch (err) {
    stream.destroy();
    await fs.promises.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }

}

class HarRecorder {
  constructor(directory, { url = 'about:blank' } = {}) {
    this.id = randomUUID();
    this.directory = directory;
    this.base = path.join(directory, this.id);
    this.ndjsonPath = `${this.base}.ndjson`;
    this.harPath = `${this.base}.har`;
    this.metaPath = `${this.base}.meta.json`;
    this.meta = { started: new Date().toISOString(), url };
    this.tasks = new Set();
    this.writeChain = Promise.resolve();
    this.stopped = false;
    this.finalizePromise = null;
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(this.ndjsonPath, '');
    fs.writeFileSync(this.metaPath, JSON.stringify(this.meta));
  }
  updateURL(url) {
    if (!url || url === 'about:blank') return;
    this.meta.url = url;
    try { fs.writeFileSync(this.metaPath, JSON.stringify(this.meta)); } catch (_) { /* disk issues are reported on save */ }
  }
  append(kind, value) {
    if (this.stopped) return;
    const payload = JSON.stringify({ kind, value }) + '\n';
    this.writeChain = this.writeChain.then(() => fs.promises.appendFile(this.ndjsonPath, payload, 'utf8'));
    this.writeChain.catch(err => console.error('[HAR write]', err.message));
  }
  track(work) {
    const p = Promise.resolve(work).catch(err => { console.error('[HAR capture]', err.message); });
    this.tasks.add(p);
    p.finally(() => this.tasks.delete(p));
  }
  recordRequest(request, started, failed) {
    if (this.stopped) return;
    this.track(buildHarEntry(request, started, failed).then(value => this.append('http', value)));
  }
  recordWebSocket(socket) {
    if (this.stopped) return;
    const url = socket.url();
    const capture = direction => frame => {
      const payload = frame.payload;
      const value = Buffer.isBuffer(payload)
        ? { url, direction, timestamp: new Date().toISOString(), payload: payload.toString('base64'), encoding: 'base64' }
        : { url, direction, timestamp: new Date().toISOString(), payload: String(payload), encoding: 'utf8' };
      this.append('ws', value);
    };
    socket.on('framesent', capture('sent'));
    socket.on('framereceived', capture('received'));
  }
  finalize() {
    if (this.finalizePromise) return this.finalizePromise;
    this.finalizePromise = (async () => {
      await Promise.all([...this.tasks]);
      this.stopped = true;
      await this.writeChain;
      const result = await writeHarFromLines(this.ndjsonPath, this.harPath, this.meta);
      await fs.promises.rm(this.ndjsonPath, { force: true });
      return { ...result, id: this.id, meta: this.meta, metaPath: this.metaPath };
    })();
    return this.finalizePromise;
  }
}

async function findRecoverable(directory) {
  await fs.promises.mkdir(directory, { recursive: true });
  const names = await fs.promises.readdir(directory);
  const bases = [...new Set(names.filter(n => /\.(?:har|ndjson)$/.test(n)).map(n => n.replace(/\.(?:har|ndjson)$/, '')))];
  const found = [];
  for (const id of bases) {
    const root = path.join(directory, id);
    const har = `${root}.har`, lines = `${root}.ndjson`, metaPath = `${root}.meta.json`;
    let meta = {};
    try { meta = JSON.parse(await fs.promises.readFile(metaPath, 'utf8')); } catch (_) { /* ignored */ }
    if (!fs.existsSync(har) && fs.existsSync(lines)) await writeHarFromLines(lines, har, meta);
    if (fs.existsSync(har)) found.push({ id, harPath: har, metaPath, ndjsonPath: lines, meta });
  }
  return found;
}

module.exports = { HarRecorder, buildHarEntry, cleanFilename, textOrBase64, harTimings, writeHarFromLines, findRecoverable };
