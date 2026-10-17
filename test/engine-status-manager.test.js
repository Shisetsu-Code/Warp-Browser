'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const EventEmitter = require('node:events');
const { BrowserManager } = require('../src/manager');

class Frame {
  constructor(page) { this.page = page; }
  url() { return this.page.url(); }
  async evaluate(fn, status) {
    if (status && typeof status === 'object') {
      this.page.status = status;
      return true;
    }
    return null;
  }
}
class Page extends EventEmitter {
  constructor(url) {
    super();this.href=url;this.closed=false;
    this.status=null;this.frame=new Frame(this);
  }
  url() { return this.href; }
  isClosed() { return this.closed; }
  mainFrame() { return this.frame; }
  frames() { return [this.frame]; }
  close() { this.closed=true;this.emit('close'); }
}
class Context extends EventEmitter {
  constructor(pages) { super();this.current=pages;this.bindings={}; }
  pages() { return this.current; }
  async exposeBinding(name, callback) { this.bindings[name]=callback; }
  async addInitScript() {}
}
const wait = () => new Promise(resolve => setImmediate(resolve));

test('frame reports distinguish selected 8x from verified clock speed, then reset on navigation',async()=>{
  const root=await fs.promises.mkdtemp(path.join(os.tmpdir(),'warp-gwt-report-'));
  try {
    const pageA=new Page('https://site-a.test/');
    const pageB=new Page('https://site-b.test/');
    const context=new Context([pageA,pageB]);
    const mgr=new BrowserManager(context,{recoveryDir:root,dialog:async()=>null,
      logger:{log(){},warn(){},error(){}}});
    await mgr.start();
    assert.equal(typeof context.bindings.__warpReportGpasStatus,'function');
    await mgr.setSpeed(pageA,8);
    await wait();
    assert.equal(pageA.status.confirmed,false);
    assert.equal(context.bindings.__warpGetTabSpeed({page:pageA}),8);
    assert.equal(context.bindings.__warpGetTabSpeed({page:pageB}),1);
    context.bindings.__warpReportGpasStatus({page:pageA,frame:pageA.frame},{
      engine:'playtech-gwt',detected:true,live:true,confirmed:true,
      selectedSpeed:8,clockMultiplier:7.9
    });
    await wait();
    assert.equal(pageA.status.confirmed,true);
    assert.equal(pageA.status.clockMultiplier,7.9);
    assert.equal(pageB.status,null);

    pageA.emit('framenavigated',pageA.frame);
    await wait();
    assert.equal(pageA.status.confirmed,false);
    assert.equal(pageA.status.detected,false);
    // A stale 1x report must never confirm a newly selected 8x setting.
    context.bindings.__warpReportGpasStatus({page:pageA,frame:pageA.frame},{
      engine:'playtech-gwt',detected:true,live:true,confirmed:true,
      selectedSpeed:1,clockMultiplier:1
    });
    await wait();
    assert.equal(pageA.status.confirmed,false);
    await mgr.setSpeed(pageA,1);
    await wait();
    assert.equal(pageA.status.confirmed,true); // 1x report remains truthful
    pageA.close();pageB.close();await mgr.shutdown();
    assert.equal(mgr.gpasByPage.has(pageA),false);
  } finally {
    await fs.promises.rm(root,{recursive:true,force:true});
  }
});
