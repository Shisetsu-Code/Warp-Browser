#!/usr/bin/env node
'use strict';

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { BrowserManager } = require('./manager');
const { findRecoverable } = require('./har');
const { saveCapture } = require('./dialog');

function dataFolder() {
  if (process.env.WARP_HOME) return path.resolve(process.env.WARP_HOME);
  if (process.platform === 'win32') return path.join(process.env.LOCALAPPDATA || os.homedir(), 'Warp-Browser');
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'Warp-Browser');
  return path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'warp-browser');
}

function toURL(value) {
  if (value === 'about:blank') return value;
  if (!/^[a-z][a-z\d+.-]*:\/\//i.test(value)) value = `https://${value}`;
  const parsed = new URL(value);
  if (!['http:', 'https:', 'file:'].includes(parsed.protocol)) throw new Error('Only http(s) and file URLs are supported');
  return parsed.toString();
}

async function recover(dir) {
  const captures = await findRecoverable(dir);
  if (!captures.length) { console.log('No hay grabaciones pendientes.'); return; }
  console.log(`${captures.length} HAR pendiente(s) de guardar.`);
  for (const capture of captures) {
    try {
      const saved = await saveCapture(capture);
      console.log(saved.saved ? `Guardado: ${saved.path}` : `Pendiente: ${capture.harPath}`);
    } catch (error) { console.error(`No se pudo guardar ${capture.harPath}:`, error.message); }
  }
}

async function main(argv = process.argv.slice(2)) {
  const home = dataFolder();
  const recoveryDir = path.join(home, 'recovery');
  const profile = path.join(home, 'chromium-profile');
  fs.mkdirSync(recoveryDir, { recursive: true });
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log('Warp Browser: npm start -- [url1] [url2] ... | npm run recover\nAlt+W: mostrar/ocultar control de velocidad. Ctrl+T: pestaña nueva. Ctrl+W: cerrar y guardar HAR.');
    return;
  }
  if (argv.includes('--recover')) return recover(recoveryDir);
  const pending = await findRecoverable(recoveryDir);
  if (pending.length) console.log(`Hay ${pending.length} HAR pendiente(s): ejecutar npm run recover para guardarlos.`);

  const urls = argv.filter(value => !value.startsWith('--')).map(toURL);
  // Lazy import allows recovery and unit tests to run without launching Chromium.
  const { chromium } = require('playwright');
  let context;
  try {
    context = await chromium.launchPersistentContext(profile, {
      headless: argv.includes('--headless'),
      viewport: null,
      acceptDownloads: true,
      args: ['--start-maximized']
    });
  } catch (error) {
    console.error('No se pudo iniciar Chromium. Ejecutar: npx playwright install chromium');
    throw error;
  }
  const manager = new BrowserManager(context, { recoveryDir });
  await manager.start();
  console.log('Warp Browser listo. Las pestañas se graban desde la primera request; cierre una pestaña para guardar su HAR.');
  if (urls.length) {
    const pages = context.pages();
    for (let i = 0; i < urls.length; i++) {
      const page = i === 0 && pages.length ? pages[0] : await context.newPage();
      try { await page.goto(urls[i], { waitUntil: 'domcontentloaded', timeout: 45000 }); }
      catch (error) { console.warn('[NAVIGATION]', urls[i], error.message); }
    }
  } else if (!context.pages().length) {
    await context.newPage();
  }

  process.once('SIGINT', () => { void context.close().catch(() => {}); });
  process.once('SIGTERM', () => { void context.close().catch(() => {}); });
  await new Promise(resolve => context.once('close', resolve));
  await manager.shutdown();
}

if (require.main === module) {
  main().catch(error => { console.error(error); process.exitCode = 1; });
}

module.exports = { main, toURL, dataFolder, recover };
