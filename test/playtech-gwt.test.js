'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { BrowserManager } = require('../src/manager');

const fixture = [
  '<!doctype html><meta charset="utf-8"><button id="buy">Compra demo</button><script>',
  'window.__gwt_stylesLoaded={};window.frameBudget=40;window.lastTick=0;',
  'window.game={elapsed:0,last:null,ticks:0,input:[],purchased:false};',
  'window.requestAnimFrame=window.requestAnimationFrame;',
  // Matches DEg from the captured Playtech GWT bundle.
  'window.fnRequestAnimationFrame=function(){',
  'try{const budget=window.frameBudget;let now=Date.now();',
  'let delta=now-window.lastTick;',
  'if(delta<0||delta>1000)delta=budget+1;',
  'if(delta>=budget){window.lastTick=now-delta%budget;',
  'if(game.last!==null){const dt=Date.now()-game.last;',
  'if(dt>=0&&dt<=1000)game.elapsed+=dt;}',
  'game.last=Date.now();game.ticks++;}',
  'window.requestAnimFrame(window.fnRequestAnimationFrame);',
  '}catch(e){game.error=String(e);}};',
  'window.requestAnimFrame(function(){window.fnRequestAnimationFrame();});',
  'for(const t of ["pointerdown","pointerup","click"])',
  'document.getElementById("buy").addEventListener(t,e=>{',
  'game.input.push({type:t,skew:Math.abs(performance.now()-e.timeStamp),',
  'speed:__warpGetEffectiveSpeed(),dateSkew:Math.abs(Date.now()-new Date().getTime())});});',
  'document.getElementById("buy").addEventListener("click",async()=>{',
  'const response=await fetch("/api/purchase",{method:"POST",body:"simulated-only"});',
  'game.purchased=response.ok;});',
  '</script>'
].join('');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

test('GPAS GWT engine advances at 8x but native clocks/clicks/requests stay intact',
  { timeout: 120000 }, async () => {
    const { chromium } = require('playwright');
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(),'warp-gpas-'));
    const requests = [];
    const server = http.createServer((req,res) => {
      if(req.url === '/api/purchase') {
        const parts=[];
        req.on('data',part => parts.push(part));
        req.on('end',()=> {
          requests.push(Buffer.concat(parts).toString('utf8'));
          res.setHeader('Content-Type','application/json');
          res.end('{"ok":true}');
        });
      } else {
        res.setHeader('Content-Type','text/html; charset=utf-8');
        res.end(fixture);
      }
    });
    await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
    let context;
    try {
      context = await chromium.launchPersistentContext(path.join(root,'profile'),{
        headless:true,acceptDownloads:true
      });
      const saved=[];
      const manager = new BrowserManager(context,{
        recoveryDir:path.join(root,'recovery'),
        dialog:async()=>{
          const dest=path.join(root,'capture-'+saved.length+'.har');
          saved.push(dest); return dest;
        },
        logger:{log(){},warn(){},error(...args){console.error(...args)}}
      });
      await manager.start();
      const page=context.pages()[0] || await context.newPage();
      const base='http://127.0.0.1:'+server.address().port;
      await page.goto(base+'/gpasclient.html?game=gpas_bblitz2_pop');
      await page.waitForFunction(()=>window.__warpGetGpasStatus?.().frames>4);
      assert.equal(await page.evaluate(()=>__warpGetGpasStatus().supported),true);
      const before=await page.evaluate(()=>game.elapsed);
      await wait(400);
      const normal=await page.evaluate(()=>game.elapsed-before);
      assert.ok(normal>100 && normal<700,'1x engine clock: '+normal);
      await manager.setSpeed(page,8);
      const a=await page.evaluate(()=>({game:game.elapsed,real:Date.now()}));
      await wait(420);
      const b=await page.evaluate(()=>({game:game.elapsed,real:Date.now(),status:__warpGetGpasStatus()}));
      const fast=b.game-a.game;
      assert.ok(fast>normal*4 && fast<normal*12,'Expected accelerated time: '+normal+' -> '+fast);
      assert.ok(b.real-a.real>250 && b.real-a.real<1000,'Browser Date.now became virtual');
      assert.equal(b.status.effectiveSpeed,8);
      assert.ok(b.status.acceleratedFrames>0);
      await page.locator('#buy').click();
      await page.waitForFunction(()=>game.purchased===true);
      const input=await page.evaluate(()=>game.input);
      assert.deepEqual(input.map(x=>x.type),['pointerdown','pointerup','click']);
      assert.ok(input.every(x=>x.speed===1 && x.skew<400 && x.dateSkew<100),
        'Click clock changed: '+JSON.stringify(input));
      assert.deepEqual(requests,['simulated-only']);
      await wait(480);
      assert.equal(await page.evaluate(()=>__warpGetEffectiveSpeed()),8);
      await manager.setSpeed(page,1);
      const start=await page.evaluate(()=>game.elapsed);
      await wait(300);
      const end=await page.evaluate(()=>game.elapsed);
      assert.ok(end>start && end-start<650,'1x did not restore correctly');
      await page.close();
      await manager.closePage(page);
      assert.equal(saved.length,1);
      const har=JSON.parse(await fs.promises.readFile(saved[0],'utf8'));
      assert.ok(har.log.entries.some(e=>e.request.url.includes('/gpasclient.html')));
      assert.ok(har.log.entries.some(e=>e.request.url.endsWith('/api/purchase') &&
        e.request.postData?.text==='simulated-only'));
      await context.close();
      await manager.shutdown();
    } finally {
      if(context) await context.close().catch(()=>{});
      await new Promise(resolve=>server.close(resolve));
      await fs.promises.rm(root,{force:true,recursive:true});
    }
});
