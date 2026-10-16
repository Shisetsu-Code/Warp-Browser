'use strict';
// Read-only public Playtech demo probe. Never submits a spin, purchase or bet.
// Never intercepts or modifies HTTP, XHR or WebSocket traffic.
const path=require('node:path');
const fs=require('node:fs');
const os=require('node:os');
const {chromium}=require('playwright');
const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
const url='https://gpas-games.playtechone.com/gpasclient.html?game=gpas_bblitz2_pop#casino=playtechhorizon&imsgame=gpas_bblitz2_pop&preferedmode=offline&real=0';

async function gather(page) {
  const stats=[];
  for(const frame of page.frames()) {
    try {
      const data=await frame.evaluate(()=>({
        status:typeof window.__warpGetGpasStatus==='function'?window.__warpGetGpasStatus():null,
        gwt:Boolean(window.__gwt_stylesLoaded)
      }));
      stats.push({origin:new URL(frame.url()).origin,path:new URL(frame.url()).pathname,...data});
    } catch (_) { /* detached or inaccessible frame */ }
  }
  return stats;
}
async function main(){
  const profile=await fs.promises.mkdtemp(path.join(os.tmpdir(),'warp-gpas-live-'));
  let context;
  try {
    context=await chromium.launchPersistentContext(profile,{
      headless:true,acceptDownloads:false,viewport:{width:1280,height:720}
    });
    await context.addInitScript({path:path.resolve(__dirname,'../src/preload.js')});
    await context.addInitScript({path:path.resolve(__dirname,'../src/playtech-gwt.js')});
    const page=context.pages()[0]||await context.newPage();
    page.on('pageerror',err=>console.log('PAGE_ERROR:',String(err.message).slice(0,170)));
    try {
      const response=await page.goto(url,{waitUntil:'domcontentloaded',timeout:55000});
      console.log('NAV:',response?.status());
    } catch(e) { console.log('NAV_ERROR:',String(e.message).slice(0,250)); }
    let current=[];
    for(let i=0;i<20;i++){
      await sleep(1500);
      current=await gather(page);
      if(current.some(x=>x.status?.supported && x.status.frames>=5))break;
    }
    console.log('BEFORE:',JSON.stringify(current));
    for(const frame of page.frames()){
      try { await frame.evaluate(()=>window.__warpSetSpeed?.(8)); }catch(_){}
    }
    await sleep(2500);
    const after=await gather(page);
    console.log('AFTER_8X:',JSON.stringify(after));
    const frame=after.find(x=>x.status?.supported);
    if(frame){
      console.log('RESULT: DETECTED_GPAS_GWT', 'scaledFrames='+frame.status.acceleratedFrames,
        'lastStepMs='+frame.status.lastStepMS);
    } else {
      console.log('RESULT: INCONCLUSIVE_NOT_LOADED');
    }
    for(const f of page.frames()){
      try{await f.evaluate(()=>window.__warpSetSpeed?.(1));}catch(_){}
    }
  } finally {
    if(context)await context.close().catch(()=>{});
    await fs.promises.rm(profile,{recursive:true,force:true});
  }
}
main().catch(err=>{console.error(err);process.exitCode=1;});
