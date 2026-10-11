'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { HarRecorder, buildHarEntry, findRecoverable, cleanFilename, textOrBase64 } = require('../src/har');

function fakeRequest({ url = 'https://demo.test/api?a=1&a=2', method = 'POST', body = Buffer.from('payload'), responseBody = Buffer.from('response') } = {}) {
  const response = {
    headersArray: async () => [{ name: 'Content-Type', value: 'application/octet-stream' }],
    headers: () => ({ 'content-type': 'application/octet-stream' }),
    status: () => 201,
    statusText: () => 'Created',
    body: async () => responseBody
  };
  return {
    method: () => method, url: () => url,
    postDataBuffer: () => body,
    headersArray: async () => [{ name: 'content-type', value: 'application/octet-stream' }],
    headers: () => ({ 'content-type': 'application/octet-stream' }),
    response: async () => response,
    sizes: async () => ({ requestBodySize: body.length, requestHeadersSize: 100, responseBodySize: responseBody.length, responseHeadersSize: 110 }),
    timing: () => ({ startTime: Date.now() - 80, domainLookupStart: 0, domainLookupEnd: 1, connectStart: 1, connectEnd: 3, secureConnectionStart: 2, requestStart: 3, responseStart: 40, responseEnd: 80 })
  };
}

async function inTmp(fn) {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'warp-har-test-'));
  try { await fn(dir); } finally { await fs.promises.rm(dir, { recursive: true, force: true }); }
}

test('captures full payloads including binary and duplicate query arguments', async () => {
  const entry = await buildHarEntry(fakeRequest());
  assert.equal(entry.request.method, 'POST');
  assert.deepEqual(entry.request.queryString, [{ name: 'a', value: '1' }, { name: 'a', value: '2' }]);
  assert.equal(entry.response.status, 201);
  assert.equal(entry.request.postData.encoding, 'base64');
  assert.equal(Buffer.from(entry.request.postData.text, 'base64').toString(), 'payload');
  assert.equal(Buffer.from(entry.response.content.text, 'base64').toString(), 'response');
  assert.equal(entry.timings.wait, 37);
});

test('UTF8 JSON embedded as text, invalid UTF8 as base64', () => {
  assert.deepEqual(textOrBase64(Buffer.from('{"ok":true}'), 'application/json'), { text: '{"ok":true}' });
  assert.equal(textOrBase64(Buffer.from([0xff]), 'text/html').encoding, 'base64');
  assert.match(cleanFilename('https://foo.test/path/game?x=1'), /^foo.test-game$/);
});

test('recorder writes standard HAR plus WebSocket extension and recovers cleanly', async () => inTmp(async dir => {
  const recorder = new HarRecorder(dir, { url: 'https://demo.test/game' });
  recorder.recordRequest(fakeRequest(), Date.now(), false);
  recorder.append('ws', { url: 'wss://demo.test/ws', direction: 'sent', payload: 'spin', encoding: 'utf8' });
  const outcome = await recorder.finalize();
  assert.equal(outcome.entryCount, 1);
  assert.equal(outcome.wsCount, 1);
  assert.equal(fs.existsSync(recorder.ndjsonPath), false);
  const data = JSON.parse(await fs.promises.readFile(outcome.harPath, 'utf8'));
  assert.equal(data.log.version, '1.2');
  assert.equal(data.log.entries[0].request.url, 'https://demo.test/api?a=1&a=2');
  assert.equal(data.log._warpWebSockets[0].payload, 'spin');
  const retry = await recorder.finalize();
  assert.equal(retry.harPath, outcome.harPath);
}));

test('salvages a truncated final JSONL line after interrupted shutdown', async () => inTmp(async dir => {
  const base = path.join(dir, 'interrupted');
  const rec = new HarRecorder(dir);
  await fs.promises.writeFile(`${base}.ndjson`, JSON.stringify({ kind: 'http', value: { request: { url: 'https://ok.test' } } }) + '\n{"kind":"http","value":');
  await fs.promises.writeFile(`${base}.meta.json`, JSON.stringify({ started: new Date().toISOString(), url: 'https://ok.test' }));
  const result = await findRecoverable(dir);
  const interrupted = result.find(x => x.id === 'interrupted');
  assert.ok(interrupted);
  const har = JSON.parse(await fs.promises.readFile(interrupted.harPath, 'utf8'));
  assert.equal(har.log.entries.length, 1);
  assert.equal(har.log.entries[0].request.url, 'https://ok.test');
}));
