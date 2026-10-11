'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const { saveCapture, saveDialog, windowsDialogScript } = require('../src/dialog');

test('Windows SaveFileDialog script quotes special filenames', () => {
  const script = windowsDialogScript('C:\\Games\\User\'s game.har');
  assert.match(script, /User''s game.har/);
  assert.match(script, /OverwritePrompt = \$true/);
  assert.match(script, /ShowDialog/);
});

test('Windows chooser decodes UTF8 path', async () => {
  const chosen = 'C:\\Games\\juego-ñ.har';
  const result = await saveDialog('C:\\temp\\default.har', {
    platform: 'win32',
    execute: async () => ({ stdout: Buffer.from(chosen, 'utf8').toString('base64') })
  });
  assert.equal(result, chosen);
});

test('cancel keeps recoverable HAR, save copies and removes backup', async () => {
  const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'warp-dialog-'));
  try {
    const backup = path.join(root, 'orig.har');
    const meta = path.join(root, 'orig.meta.json');
    const output = path.join(root, 'saved.har');
    await fs.promises.writeFile(backup, '{"log":{}}');
    await fs.promises.writeFile(meta, '{}');
    const capture = { harPath: backup, metaPath: meta, meta: { started: '2026-10-11T12:00:00.000Z', url: 'https://game.test/' } };
    const canceled = await saveCapture(capture, { dialog: async () => null, destinationDir: root });
    assert.equal(canceled.saved, false);
    assert.equal(fs.existsSync(backup), true);
    const saved = await saveCapture(capture, { dialog: async () => output, destinationDir: root });
    assert.equal(saved.saved, true);
    assert.equal(fs.existsSync(backup), false);
    assert.equal(fs.existsSync(meta), false);
    assert.equal(await fs.promises.readFile(output, 'utf8'), '{"log":{}}');
  } finally { await fs.promises.rm(root, { force: true, recursive: true }); }
});
