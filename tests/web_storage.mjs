// Browser boundary failure tests use actual IndexedDB/Blob APIs on a local test origin.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE||'playwright');
const base=process.env.PAINT_TEST_URL||'http://127.0.0.1:8910/';
const output=process.env.PAINT_TEST_OUTPUT||'build-web-work';
const browser=await chromium.launch({headless:true,...(process.env.CHROME_PATH?{executablePath:process.env.CHROME_PATH}:{}),args:['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
const context=await browser.newContext();
const source=await fs.readFile(new URL('../web/browser.js',import.meta.url),'utf8');
const checks=[], errors=[];
async function createPage(){
    const page=await context.newPage();
    page.on('pageerror',error=>errors.push(error.message));
    await page.route('**/__bridge_test__',route=>route.fulfill({contentType:'text/html',body:'<div id="downloads"></div>'}));
    await page.goto(new URL('/__bridge_test__',base).href);
    await page.addScriptTag({content:`
        var Module=window.bridgeModule={};
        var HEAPU8=new Uint8Array(50*1048576),nextPointer=1;
        function _malloc(size){const p=nextPointer;nextPointer+=size;return p;}
        function _free(){}
        var replies=new Map();
        Module._retropaint_browser_result=(id,meta,length,data,size)=>{
            const result=JSON.parse(new TextDecoder().decode(HEAPU8.slice(meta,meta+length)));
            result.bytes=Array.from(HEAPU8.slice(data,data+size));
            replies.get(id)?.(result);replies.delete(id);
        };
        ${source}
        var serial=0;
        window.request=(operation,options={},bytes=[])=>new Promise(resolve=>{
            const id=++serial;replies.set(id,resolve);
            Module.paintBrowser.request(id,{operation,limit:40*1048576,...options},new Uint8Array(bytes));
        });
        window.recover=async()=>{const list=await request('recover');return list.entries?.length?await request('recover',{key:list.entries[0].key,sequence:list.entries[0].sequence}):list;};
    `});
    return page;
}
try{
    const first=await createPage();const second=await createPage();
    assert((await first.evaluate(()=>request('store',{name:'first'},[1,2,3]))).ok);
    assert((await second.evaluate(()=>request('store',{name:'second'},[4,5,6,7]))).ok);
    let recovered=await first.evaluate(()=>recover());assert.deepEqual(recovered.bytes,[4,5,6,7]);
    checks.push('Independent tab keys preserve both committed snapshots');
    const selected=await first.evaluate(async()=> (await request('recover')).entries[0]);
    assert((await second.evaluate(()=>request('store',{name:'second update'},[4,5,6,7]))).ok);
    assert.equal((await first.evaluate(entry=>request('recover',{key:entry.key,sequence:entry.sequence}),selected)).ok,false);
    assert.deepEqual((await first.evaluate(()=>recover())).bytes,[4,5,6,7]);
    checks.push('Selected backup generation revalidated; head and Blob read in one transaction');
    // Quota exception aborts the complete transaction, preserving the old head and Blob.
    const failure=await second.evaluate(async()=>{
        const original=IDBObjectStore.prototype.put;
        IDBObjectStore.prototype.put=function(){throw new DOMException('Injected quota failure','QuotaExceededError');};
        try{return await request('store',{name:'replacement'},[9,9]);}finally{IDBObjectStore.prototype.put=original;}
    });
    assert.equal(failure.ok,false);recovered=await first.evaluate(()=>recover());assert.deepEqual(recovered.bytes,[4,5,6,7]);
    checks.push('Quota/transaction failure preserves previous head and bytes');
    // Reset changes the session key before a queued old store may finish.
    const stale=await first.evaluate(async()=>{
        const pending=request('store',{name:'stale'},[8]);
        bridgeModule.paintBrowser.request(0,{operation:'reset',limit:40*1048576},new Uint8Array());
        return await pending;
    });
    assert.equal(stale.ok,false);await first.waitForTimeout(100);
    recovered=await first.evaluate(()=>recover());assert.deepEqual(recovered.bytes,[4,5,6,7]);
    checks.push('Late old-document store rejected; reset retains another tab backup');
    const clipboard=await first.evaluate(async()=>{
        Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async()=>{throw new DOMException('denied','NotAllowedError');},readText:async()=> 'x'.repeat(65537)}});
        return [await request('clipboardWrite',{textMode:true,text:'keep'}),await request('clipboardRead',{textMode:true})];
    });
    assert(clipboard.every(result=>result.ok===false));checks.push('Clipboard rejection and oversized text return explicit failure');
    // Replacing and closing the HTML download revokes immutable Blob URLs.
    const downloads=await first.evaluate(async()=>{
        const urls=[];const create=URL.createObjectURL.bind(URL);URL.createObjectURL=blob=>{const url=create(blob);urls.push(url);return url;};
        await request('download',{name:'one.rpaint',mime:'application/octet-stream'},[1]);
        await request('download',{name:'two.rpaint',mime:'application/octet-stream'},[2]);
        const current=Array.from(new Uint8Array(await (await fetch(urls[1])).arrayBuffer()));
        const oldRevoked=await fetch(urls[0]).then(()=>false,()=>true);
        document.querySelectorAll('#downloads button')[1].click();
        const newRevoked=await fetch(urls[1]).then(()=>false,()=>true);
        return {current,oldRevoked,newRevoked};
    });
    assert.deepEqual(downloads,{current:[2],oldRevoked:true,newRevoked:true});checks.push('Download replacement/close revoke only superseded URLs');
    // A broken snapshot is detected without changing the stored head or bytes.
    await second.evaluate(()=>new Promise((resolve,reject)=>{
        const r=indexedDB.open('retropaint-local-v1',1);r.onsuccess=()=>{const db=r.result;const tx=db.transaction(['heads','snapshots'],'readwrite');const q=tx.objectStore('heads').getAll();q.onsuccess=()=>tx.objectStore('snapshots').put(new Blob([new Uint8Array([0])]),q.result[0].key);tx.oncomplete=()=>{db.close();resolve();};tx.onabort=()=>reject(tx.error);};
    }));
    assert.equal((await first.evaluate(()=>recover())).ok,false);checks.push('Corrupt Blob/head mismatch fails without deleting backup');
    assert((await first.evaluate(()=>request('clear'))).ok);assert((await second.evaluate(()=>recover())).empty);
    checks.push('Explicit clear transaction removes app snapshots across tabs');
    const denied=await createPage();
    const deniedResult=await denied.evaluate(async()=>{Object.defineProperty(window,'indexedDB',{value:{open(){throw new DOMException('Storage disabled','SecurityError');}}});return await request('recover');});
    assert.equal(deniedResult.ok,false);checks.push('Storage access denied is reported without hanging');
    assert.deepEqual(errors,[]);
    console.log(JSON.stringify({browser:browser.version(),checks,errors},null,2));
    await fs.mkdir(output,{recursive:true});await fs.writeFile(output+'/web-storage.json',JSON.stringify({browser:browser.version(),checks,errors},null,2));
}finally{await browser.close();}
