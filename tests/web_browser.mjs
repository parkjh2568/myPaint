// Run against a local web build. Playwright is a development-only dependency.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
const {chromium} = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const base = process.env.PAINT_TEST_URL || 'http://127.0.0.1:8910/';
const output = process.env.PAINT_TEST_OUTPUT || 'build-web-work';
await fs.mkdir(output, {recursive:true});
const browser = await chromium.launch({headless:true,
    ...(process.env.CHROME_PATH ? {executablePath:process.env.CHROME_PATH} : {}),
    args:['--use-gl=angle','--use-angle=swiftshader','--enable-unsafe-swiftshader']});
const results = {browser:browser.version(),url:base,checks:[],errors:[],requests:[]};
const context = await browser.newContext({viewport:{width:1200,height:900}});
const page = await context.newPage();
page.setDefaultTimeout(15000);
page.on('pageerror', error=>results.errors.push(error.message));
page.on('request', request=>results.requests.push(request.url()));
page.on('dialog', dialog=>dialog.accept());
await page.addInitScript(()=>{
    window.testBlobs=[];
    const create=URL.createObjectURL.bind(URL);
    URL.createObjectURL=blob=>{window.testBlobs.push(blob);return create(blob);};
});
// Menu positions are asserted by this fixed desktop viewport and local font.
async function menu(x,y){await page.mouse.click(1100,700);await page.mouse.click(x,39);await page.waitForTimeout(60);await page.mouse.click(x===25?90:110,y);await page.waitForTimeout(120);}
async function snapshot(){
    await menu(25,124);
    await page.getByRole('button',{name:'파일 받기',exact:true}).waitFor();
    const bytes=await page.evaluate(async()=>Array.from(new Uint8Array(await window.testBlobs.at(-1).arrayBuffer())));
    await page.getByRole('button',{name:'닫기',exact:true}).click();
    await page.waitForTimeout(150);
    return Buffer.from(bytes);
}
async function openFile(payload){const chosen=page.waitForEvent('filechooser');await menu(25,83);await (await chosen).setFiles(payload);await page.waitForTimeout(200);}
try {
    await page.goto(base);
    await page.waitForFunction(()=>window.retropaint);
    await page.waitForTimeout(200);
    if (process.env.PAINT_TEST_PACKAGE === '1') {
        const license = await context.request.get(new URL('licenses.html',await page.evaluate(()=>document.baseURI)).href);
        assert.equal(license.status(),200);
        const links = await page.evaluate(html=>{const document=new DOMParser().parseFromString(html,'text/html');const baseElement=document.querySelector('base');const base=baseElement?new URL(baseElement.getAttribute('href'),new URL('licenses.html',window.document.baseURI)).href:window.document.baseURI;return [...document.querySelectorAll('a')].map(link=>new URL(link.getAttribute('href'),base).href);},await license.text());
        assert(links.length>10);
        for(const link of links){assert.equal(new URL(link).origin,new URL(base).origin);assert.equal((await context.request.head(link)).status(),200);}
        results.checks.push('Versioned package license and corresponding-source links resolve');
    }
    // Verify the real shortcut first, so the active-gesture check cannot pass by an undelivered key.
    const modifier=await page.evaluate(()=>navigator.platform.includes('Mac')?'Meta':'Control');
    await page.mouse.click(120,120);await page.keyboard.press(modifier+'+s');
    await page.getByRole('button',{name:'파일 받기',exact:true}).waitFor();
    await page.getByRole('button',{name:'닫기',exact:true}).click();await page.waitForTimeout(150);
    const beforeGesture=await page.evaluate(()=>window.testBlobs.length);
    await page.mouse.move(120,120);await page.mouse.down();await page.mouse.move(180,120,{steps:6});
    await page.keyboard.press(modifier+'+s');await page.waitForTimeout(100);
    assert.equal(await page.evaluate(()=>window.testBlobs.length),beforeGesture);
    await page.mouse.move(240,120,{steps:6});await page.mouse.up();
    results.checks.push('Real save shortcut defers during an active gesture without cancelling the stroke');
    await page.mouse.move(120,120);await page.mouse.down();await page.mouse.move(240,120,{steps:12});await page.mouse.up();
    const drawn=await snapshot();
    assert.equal(drawn.subarray(0,8).toString(),'RPAINT01');assert.equal(drawn.readUInt32LE(8),800);assert.equal(drawn.readUInt32LE(12),600);
    const pngStart=28+4+drawn.readUInt32LE(28)+1+4;
    const pixel=await page.evaluate(async(data)=>{
        const image=await createImageBitmap(new Blob([new Uint8Array(data)],{type:'image/png'}));
        const canvas=new OffscreenCanvas(image.width,image.height);const painter=canvas.getContext('2d');painter.drawImage(image,0,0);
        return Array.from(painter.getImageData(50,41,1,1).data);
    },Array.from(drawn.subarray(pngStart)));
    assert.deepEqual(pixel,[0,0,0,255]);results.checks.push('Actual stroke and downloaded project pixels');
    // Downloading does not clear dirty status or Undo history.
    await menu(85,62);const undone=await snapshot();assert.notDeepEqual(undone,drawn);
    await menu(85,83);assert.deepEqual(await snapshot(),drawn);results.checks.push('Download preserves Undo/Redo');
    await page.mouse.click(61,315);
    await page.mouse.move(110,105);await page.mouse.down();await page.mouse.move(250,140,{steps:8});await page.mouse.up();
    await page.mouse.move(150,120);await page.mouse.down();await page.mouse.move(180,150,{steps:8});await page.mouse.up();
    assert.notDeepEqual(await snapshot(),drawn);
    await menu(25,166);await page.keyboard.press('Enter');
    await page.getByRole('button',{name:'파일 받기',exact:true}).waitFor();
    const png=await page.evaluate(async()=>Array.from(new Uint8Array(await window.testBlobs.at(-1).arrayBuffer()).slice(0,8)));
    assert.deepEqual(png,[137,80,78,71,13,10,26,10]);
    await page.getByRole('button',{name:'닫기',exact:true}).click();await page.waitForTimeout(150);
    await menu(85,62);assert.deepEqual(await snapshot(),drawn);
    await menu(85,83);assert.deepEqual(await snapshot(),drawn);
    results.checks.push('Project/PNG downloads include pending selection without committing or creating Redo');
    await page.mouse.click(23,99);
    await openFile({name:'broken.rpaint',mimeType:'application/octet-stream',buffer:Buffer.from('RPAINT01bad')});
    await page.screenshot({path:output+'/invalid-project.png'});
    // The error dialog has one default OK button; keyboard delivery is native Qt input.
    await page.keyboard.press('Enter');await page.waitForTimeout(150);
    assert.deepEqual(await snapshot(),drawn);results.checks.push('Invalid project preserves current pixels and history');
    await openFile([]);assert.deepEqual(await snapshot(),drawn);results.checks.push('File chooser cancellation preserves document');
    await page.evaluate(()=>{window.largeReads=0;const read=File.prototype.arrayBuffer;File.prototype.arrayBuffer=function(){if(this.size>40*1048576)window.largeReads++;return read.call(this);};});
    await openFile({name:'large.rpaint',mimeType:'application/octet-stream',buffer:Buffer.alloc(40*1048576+1)});
    await page.keyboard.press('Enter');await page.waitForTimeout(150);
    assert.equal(await page.evaluate(()=>window.largeReads),0);assert.deepEqual(await snapshot(),drawn);results.checks.push('Oversized File rejected before arrayBuffer');
    // Denied image cut must leave pixels, selection and Redo untouched.
    await page.evaluate(()=>Object.defineProperty(navigator,'clipboard',{configurable:true,value:{write:async()=>{throw new Error('Test clipboard permission denied');}}}));
    await menu(85,110);await page.waitForTimeout(150);await page.keyboard.press('Enter');await page.waitForTimeout(100);
    assert.deepEqual(await snapshot(),drawn);results.checks.push('Denied clipboard cut preserves pixels');
    // Verify a committed snapshot survives a real page reload.
    await page.waitForFunction(async()=>{
        return await new Promise(resolve=>{const r=indexedDB.open('retropaint-local-v1',1);r.onsuccess=()=>{const db=r.result;const tx=db.transaction('heads');const q=tx.objectStore('heads').count();q.onsuccess=()=>resolve(q.result>0);tx.oncomplete=()=>db.close();};r.onerror=()=>resolve(false);});
    },null,{timeout:45000,polling:500});
    await page.reload();await page.waitForFunction(()=>window.retropaint);await page.waitForTimeout(400);
    await page.screenshot({path:output+'/recovery-prompt.png'});
    await page.keyboard.press('Enter');await page.waitForTimeout(300);
    assert.deepEqual(await snapshot(),drawn);
    results.checks.push('IndexedDB committed snapshot survives reload and restores exact pixels');
    await page.screenshot({path:output+'/web-app.png'});
    assert.equal(results.errors.length,0);
    const origin=new URL(base).origin;
    assert(results.requests.every(url=>url.startsWith(origin)||url.startsWith('data:')||url.startsWith('blob:')));
    results.checks.push('Same-origin application requests only; no page errors');
    const lost = await page.evaluate(()=>{
        for(const canvas of document.querySelectorAll('#screen #qt-shadow-container')) {
            for(const target of canvas.shadowRoot.querySelectorAll('canvas')) {
                const gl=target.getContext('webgl2');const extension=gl?.getExtension('WEBGL_lose_context');
                if(extension){extension.loseContext();return true;}
            }
        }
        const canvas=document.querySelector('#screen #qt-shadow-container')?.shadowRoot?.querySelector('canvas');
        if(canvas){canvas.dispatchEvent(new Event('contextlost'));return 'synthetic raster context-loss event';}
        return false;
    });
    assert(lost,'Test requires the active Qt canvas');
    await page.waitForFunction(()=>!document.getElementById('status').hidden&&document.getElementById('status').textContent.includes('화면 연결'));
    results.checks.push('Canvas context-loss guidance: '+(lost===true?'WebGL extension':lost));
    const failed = await context.newPage();
    await failed.route('**/retropaint.wasm',route=>route.abort('failed'));
    await failed.goto(base);
    await failed.waitForFunction(()=>document.getElementById('status').textContent.includes('시작할 수 없습니다'));
    results.checks.push('Wasm load failure presents a startup error');
    await failed.close();
} catch(error){await page.screenshot({path:output+'/failure.png'}).catch(()=>{});results.failure=String(error.stack||error);throw error;}
finally{await fs.writeFile(output+'/web-browser.json',JSON.stringify(results,null,2));await browser.close();}
console.log(JSON.stringify(results,null,2));
