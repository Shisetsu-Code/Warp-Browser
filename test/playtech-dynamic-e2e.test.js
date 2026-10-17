'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { BrowserManager } = require('../src/manager');

const shell = `<!doctype html><meta charset="utf-8"><title>Game launcher</title>
<button id="buy" style="position:fixed;top:10px;right:120px">Safe demo click</button>
<div id="mount"></div><script>
window.parentClicks=[];
document.getElementById('buy').addEventListener('click',e=>{
  window.parentClicks.push({skew:Math.abs(performance.now()-e.timeStamp),
   speed:__warpGetEffectiveSpeed()});
});
</script>`;

// Intentionally DOES NOT use /gpasclient.html nor a Playtech domain.
// Emulates only the GWT frame dispatcher signature found in the supplied HAR.
const engine = `<!doctype html><meta charset="utf-8"><title>Late GWT frame</title>
<button id="inside">Click inside cross-origin game</button>
<script>
window.game={ticks:0,elapsed:0,clicks:[]};
window.frameBudget=40;window.lastTick=0;
window.requestAnimFrame=window.requestAnimationFrame;
window.reinstallGwt=function(){
 let prev=null;
 window.fnRequestAnimationFrame=function gameFrame(){
  const budget=window.frameBudget;
  const now=Date.now();
  const delta=now-window.lastTick;
  if(delta>=budget){
    window.lastTick=now;
    if(prev!==null)window.game.elapsed+=Math.max(0,now-prev);
    prev=now;window.game.ticks++;
  }
  window.requestAnimFrame(window.fnRequestAnimationFrame);
 };
 window.requestAnimFrame(window.fnRequestAnimationFrame);
};
setTimeout(window.reinstallGwt,600);
document.getElementById('inside').addEventListener('click',async e=>{
 window.game.clicks.push({skew:Math.abs(performance.now()-e.timeStamp),
  speed:window.__warpGetEffectiveSpeed(),clockReal:Math.abs(Date.now()-new Date().getTime())});
 const res=await fetch('/api/mock-purchase',{method:'POST',body:'no-real-bet'});
 window.game.response=res.ok;
});
</script>`;

const waitReal = ms => new Promise(resolve => setTimeout(resolve, ms));
const serve = (handler) => new Promise((resolve, reject) => {
  const server = http.createServer(handler);
  server.once('error', reject);
  server.listen(0, '127.0.0.1', () => resolve(server));
});
const close = server => new Promise(resolve => server.close(resolve));

test('late/reloaded cross-origin iframes inherit speed; real GWT loop detected; click/HAR stay intact',
  { timeout: 120000 }, async () => {
    const { chromium } = require('playwright');
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'warp-dynamic-gwt-'));
    const received = [];
    const parentServer = await serve((req,res) => {
      res.setHeader('Content-Type','text/html; charset=utf-8');
      res.end(shell);
    });
    const childServer = await serve((req,res) => {
      if (req.url.startsWith('/api/mock-purchase')) {
        const parts=[];
        req.on('data', part=>parts.push(part));
        req.on('end',()=>{
          received.push(Buffer.concat(parts).toString('utf8'));
          res.setHeader('Content-Type','application/json');res.end('{"ok":true}');
        });
      } else {
        res.setHeader('Content-Type','text/html; charset=utf-8');
        res.end(engine);
      }
    });
    let context;
    try {
      const parentBase = `http://127.0.0.1:${parentServer.address().port}`;
      const childBase = `http://127.0.0.1:${childServer.address().port}`;
      context = await chromium.launchPersistentContext(path.join(root,'profile'), {
        headless:true,acceptDownloads:true
      });
      const saved=[];
      const mgr = new BrowserManager(context, {
        recoveryDir:path.join(root,'recovery'),
        dialog:async()=>{
          const target=path.join(root,`saved-${saved.length}.har`);
          saved.push(target);return target;
        },
        logger:{log(){},warn(){},error(...args){console.error(...args);}}
      });
      await mgr.start();
      const page=context.pages()[0] || await context.newPage();
      await page.goto(parentBase+'/launcher.html');
      await mgr.setSpeed(page,8);
      await page.evaluate(url => {
        const iframe = document.createElement('iframe');iframe.id='game';
        iframe.src=url;iframe.width=680;iframe.height=300;
        document.getElementById('mount').append(iframe);
      },childBase+'/unknown-runtime/launch.html');
      const frame=page.frameLocator('#game');
      await frame.locator('#inside').waitFor();
      await frame.locator('body').evaluate(async () => {
        if (__warpGetSpeed() !== 8) throw new Error('speed not inherited by late cross-origin frame');
      });
      await page.waitForFunction(() => {
        const s=window.__warpGetEngineSummary?.();
        return s?.detected && s?.confirmed && s?.clockMultiplier>=6;
      },null,{timeout:15000});
      let status=await page.evaluate(()=>window.__warpGetEngineSummary());
      assert.equal(status.confirmed,true);
      assert.ok(status.clockMultiplier>=6 && status.clockMultiplier<=10);
      const ticker=await frame.locator('body').evaluate(()=>window.__warpGetGpasStatus());
      assert.ok(ticker.acceleratedFrames>5);
      assert.equal(ticker.confirmed,true);
      // Both the selected rate and observed GWT clock rate appear in Warp's UI.
      // Shadow DOM is deliberately closed: verify through its public readout.
      assert.equal(await page.evaluate(()=>__warpGetSpeed()),8);

      await frame.locator('#inside').click();
      await frame.locator('body').evaluate(async()=>{
        const started=performance.now();
        while(!window.game.response && performance.now()-started<3000)
          await new Promise(r=>setTimeout(r,100));
        if(!window.game.response)throw new Error('demo click not acknowledged');
      });
      assert.deepEqual(received,['no-real-bet']);
      const events=await frame.locator('body').evaluate(()=>window.game.clicks);
      assert.equal(events.length,1);
      assert.ok(events[0].skew<400 && events[0].clockReal<100);
      assert.equal(events[0].speed,1);

      // Replace GWT function after initialization; the probe must reinstall.
      await frame.locator('body').evaluate(()=>window.reinstallGwt());
      await frame.locator('body').evaluate(async()=>{
        const started=performance.now();
        while(__warpGetGpasStatus().reinstalls<2 && performance.now()-started<3500)
          await new Promise(r=>setTimeout(r,70));
      });
      assert.ok((await frame.locator('body').evaluate(()=>__warpGetGpasStatus())).reinstalls>=2);

      // Navigate to yet another arbitrary filename while 8x is active.
      await page.locator('#game').evaluate((el,url)=>el.src=url,
        childBase+'/nested/new-game-module.html?restarted=1');
      await frame.locator('#inside').waitFor();
      await page.waitForFunction(()=>window.__warpGetEngineSummary?.().confirmed===true,
        null,{timeout:15000});
      assert.equal(await frame.locator('body').evaluate(()=>__warpGetSpeed()),8);
      await mgr.setSpeed(page,1);
      await waitReal(1100);
      const summary=await page.evaluate(()=>__warpGetEngineSummary());
      assert.equal(summary.confirmed,false);

      await page.close();
      await mgr.closePage(page);
      assert.equal(saved.length,1);
      const har=JSON.parse(await fs.promises.readFile(saved[0],'utf8'));
      assert.ok(har.log.entries.some(x=>x.request.url.includes('/launcher.html')));
      assert.ok(har.log.entries.some(x=>x.request.url.includes('/unknown-runtime/launch.html')));
      assert.ok(har.log.entries.some(x=>x.request.url.endsWith('/api/mock-purchase') &&
        x.request.postData?.text==='no-real-bet'));
      await context.close();await mgr.shutdown();
    } finally {
      if(context)await context.close().catch(()=>{});
      await Promise.all([close(parentServer),close(childServer)]);
      await fs.promises.rm(root,{recursive:true,force:true});
    }
  });
