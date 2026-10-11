'use strict';

const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const path = require('node:path');
const fs = require('node:fs');

const run = promisify(execFile);

function quotePS(value) { return "'" + String(value).replace(/'/g, "''") + "'"; }

function windowsDialogScript(defaultPath) {
  const name = path.win32.basename(defaultPath);
  const dir = path.win32.dirname(defaultPath);
  return [
    'Add-Type -AssemblyName System.Windows.Forms',
    '$d = New-Object System.Windows.Forms.SaveFileDialog',
    `$d.FileName = ${quotePS(name)}`,
    `$d.InitialDirectory = ${quotePS(dir)}`,
    "$d.Filter = 'HTTP Archive (*.har)|*.har|All files (*.*)|*.*'",
    "$d.Title = 'Guardar HAR de esta pestaña'",
    '$d.DefaultExt = "har"',
    '$d.AddExtension = $true',
    '$d.OverwritePrompt = $true',
    'if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {',
    '  [Console]::Out.Write([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($d.FileName)))',
    '}'
  ].join('\n');
}

async function saveDialog(defaultPath, { platform = process.platform, execute = run } = {}) {
  try {
    if (platform === 'win32') {
      const { stdout } = await execute('powershell.exe', ['-NoProfile', '-STA', '-Command', windowsDialogScript(defaultPath)], { windowsHide: true, timeout: 120000 });
      const encoded = stdout.trim();
      return encoded ? Buffer.from(encoded, 'base64').toString('utf8') : null;
    }
    if (platform === 'darwin') {
      const file = path.basename(defaultPath).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      const script = `POSIX path of (choose file name with prompt "Guardar HAR de esta pestaña" default name "${file}")`;
      const { stdout } = await execute('osascript', ['-e', script], { timeout: 120000 });
      return stdout.trim() || null;
    }
    for (const command of ['zenity', 'kdialog']) {
      try {
        const args = command === 'zenity'
          ? ['--file-selection', '--save', '--confirm-overwrite', `--filename=${defaultPath}`, '--title=Guardar HAR de esta pestaña']
          : ['--getsavefilename', defaultPath, '*.har'];
        const { stdout } = await execute(command, args, { timeout: 120000 });
        return stdout.trim() || null;
      } catch (error) {
        if (error.code !== 'ENOENT') return null; // canceled dialog
      }
    }
  } catch (error) {
    if (error.code !== 1 && error.code !== 'ETIMEDOUT') console.error('[Save dialog]', error.message);
  }
  return null;
}

async function saveCapture(capture, { dialog = saveDialog, destinationDir = path.join(require('node:os').homedir(), 'Downloads') } = {}) {
  const { cleanFilename } = require('./har');
  const title = cleanFilename(capture.meta.url);
  const stamp = (capture.meta.started || new Date().toISOString()).replace(/[-:]/g, '').slice(0, 15).replace('T', '_');
  const proposal = path.join(fs.existsSync(destinationDir) ? destinationDir : process.cwd(), `${title}_${stamp}.har`);
  const selected = await dialog(proposal);
  if (!selected) return { saved: false, backup: capture.harPath };
  const dest = path.resolve(selected);
  if (dest === path.resolve(capture.harPath)) return { saved: true, path: dest };
  // The native dialog asks for overwrite confirmation. Keep the recovery file
  // until copying succeeds; a copy failure must never discard the HAR.
  await fs.promises.copyFile(capture.harPath, dest);
  await Promise.all([capture.harPath, capture.metaPath, capture.ndjsonPath].filter(Boolean).map(p => fs.promises.rm(p, { force: true })));
  return { saved: true, path: dest };
}

module.exports = { saveDialog, windowsDialogScript, saveCapture };
