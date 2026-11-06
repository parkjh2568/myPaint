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
// Qt exposes its semantic controls after screen-reader activation; click through to the painted UI.
async function command(menuName,item){
    await page.getByRole('menuitem',{name:menuName,exact:true}).click({force:true});
    await page.waitForTimeout(80);
    const action=page.getByRole('menuitem',{name:item,exact:typeof item==='string'});
    if(await action.isDisabled()){await page.keyboard.press('Escape');return;}
    await action.click({force:true});await page.waitForTimeout(120);
}
async function snapshot(){
    await command('파일(F)','프로젝트 다운로드');
    await page.getByRole('button',{name:'파일 받기',exact:true}).waitFor();
    const bytes=await page.evaluate(async()=>Array.from(new Uint8Array(await window.testBlobs.at(-1).arrayBuffer())));
    await page.getByRole('button',{name:'닫기',exact:true}).click();
    await page.waitForTimeout(150);
    return Buffer.from(bytes);
}
async function openFile(payload){const chosen=page.waitForEvent('filechooser');await command('파일(F)','열기…');await (await chosen).setFiles(payload);await page.waitForTimeout(200);}
try {
    await page.goto(base);
    await page.waitForFunction(()=>window.retropaint);
    await page.waitForTimeout(200);
    await page.getByRole('button',{name:'Enable Screen Reader'}).first().evaluate(element=>element.click());
    await page.waitForTimeout(150);
    await page.getByRole('checkbox',{name:'연필',exact:true}).click({force:true});
    // Qt Wasm omits custom canvas widgets from its DOM accessibility tree; find the blank paper visually.
    const paper=await page.evaluate(()=>{
        const canvas=document.querySelector('#qt-shadow-container').shadowRoot.querySelector('canvas');
        const ctx=canvas.getContext('2d');const {width,height}=canvas;
        const pixels=ctx.getImageData(0,0,width,height).data;
        const white=(x,y)=>{const i=(y*width+x)*4;return pixels[i]===255&&pixels[i+1]===255&&pixels[i+2]===255;};
        let best={length:0,x:0,y:0};
        for(let y=0;y<height;y+=16){let start=0;for(let x=0;x<=width;x++){if(x<width&&white(x,y))continue;const length=x-start;if(length>best.length)best={length,x:start,y};start=x+1;}}
        if(best.length<500)return null;
        let y=best.y;const middle=best.x+Math.floor(best.length/2);while(y>0&&white(middle,y-1))y--;
        const bounds=canvas.getBoundingClientRect();return {x:bounds.x+best.x*bounds.width/width,y:bounds.y+y*bounds.height/height};
    });
    assert(paper);
    const left=paper.x, top=paper.y;
    if (process.env.PAINT_TEST_PACKAGE === '1') {
        const license = await context.request.get(new URL('licenses.html',await page.evaluate(()=>document.baseURI)).href);
        assert.equal(license.status(),200);
        const links = await page.evaluate(html=>{const document=new DOMParser().parseFromString(html,'text/html');const baseElement=document.querySelector('base');const base=baseElement?new URL(baseElement.getAttribute('href'),new URL('licenses.html',window.document.baseURI)).href:window.document.baseURI;return [...document.querySelectorAll('a')].map(link=>new URL(link.getAttribute('href'),base).href);},await license.text());
        assert(links.length>10);
        for(const link of links){const url=new URL(link);assert(url.origin===new URL(base).origin||link==='https://codeload.github.com/qt/qtbase/tar.gz/025bdad181de241e81bf853c8a2d7bf3d19261a9');assert.equal((await context.request.head(link)).status(),200);}
        results.checks.push('Versioned package license and corresponding-source links resolve');
    }
    // Verify the real shortcut first, so the active-gesture check cannot pass by an undelivered key.
    const modifier=await page.evaluate(()=>navigator.platform.includes('Mac')?'Meta':'Control');
    await page.mouse.click(left+35,top+41);await page.keyboard.press(modifier+'+s');
    await page.getByRole('button',{name:'파일 받기',exact:true}).waitFor();
    await page.getByRole('button',{name:'닫기',exact:true}).click();await page.waitForTimeout(150);
    const beforeGesture=await page.evaluate(()=>window.testBlobs.length);
    await page.mouse.move(left+35,top+41);await page.mouse.down();await page.mouse.move(left+95,top+41,{steps:6});
    await page.keyboard.press(modifier+'+s');await page.waitForTimeout(100);
    assert.equal(await page.evaluate(()=>window.testBlobs.length),beforeGesture);
    await page.mouse.move(left+155,top+41,{steps:6});await page.mouse.up();
    results.checks.push('Real save shortcut defers during an active gesture without cancelling the stroke');
    await page.mouse.move(left+35,top+41);await page.mouse.down();await page.mouse.move(left+155,top+41,{steps:12});await page.mouse.up();
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
    await command('편집(E)',/^(실행 취소|현재 편집 취소)/);const undone=await snapshot();assert.notDeepEqual(undone,drawn);
    await command('편집(E)',/^다시 실행/);assert.deepEqual(await snapshot(),drawn);results.checks.push('Download preserves Undo/Redo');
    await page.getByRole('checkbox',{name:'사각 선택',exact:true}).click({force:true});
    await page.mouse.move(left+25,top+26);await page.mouse.down();await page.mouse.move(left+165,top+61,{steps:8});await page.mouse.up();
    await page.mouse.move(left+65,top+41);await page.mouse.down();await page.mouse.move(left+95,top+71,{steps:8});await page.mouse.up();
    assert.notDeepEqual(await snapshot(),drawn);
    await command('파일(F)','이미지 내보내기…');await page.keyboard.press('Enter');
    await page.getByRole('button',{name:'파일 받기',exact:true}).waitFor();
    const png=await page.evaluate(async()=>Array.from(new Uint8Array(await window.testBlobs.at(-1).arrayBuffer()).slice(0,8)));
    assert.deepEqual(png,[137,80,78,71,13,10,26,10]);
    await page.getByRole('button',{name:'닫기',exact:true}).click();await page.waitForTimeout(150);
    await command('편집(E)',/^(실행 취소|현재 편집 취소)/);assert.deepEqual(await snapshot(),drawn);
    await command('편집(E)',/^다시 실행/);assert.deepEqual(await snapshot(),drawn);
    results.checks.push('Project/PNG downloads include pending selection without committing or creating Redo');
    await page.getByRole('checkbox',{name:'연필',exact:true}).click({force:true});
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
    await command('편집(E)','잘라내기');await page.waitForTimeout(150);await page.keyboard.press('Enter');await page.waitForTimeout(100);
    assert.deepEqual(await snapshot(),drawn);results.checks.push('Denied clipboard cut preserves pixels');
    // Verify a committed snapshot survives a real page reload.
    await page.waitForFunction(async()=>{
        return await new Promise(resolve=>{const r=indexedDB.open('retropaint-local-v1',1);r.onsuccess=()=>{const db=r.result;const tx=db.transaction('heads');const q=tx.objectStore('heads').count();q.onsuccess=()=>resolve(q.result>0);tx.oncomplete=()=>db.close();};r.onerror=()=>resolve(false);});
    },null,{timeout:45000,polling:500});
    await page.reload();await page.waitForFunction(()=>window.retropaint);await page.waitForTimeout(400);
    await page.getByRole('button',{name:'Enable Screen Reader'}).first().evaluate(element=>element.click());
    await page.screenshot({path:output+'/recovery-prompt.png'});
    await page.keyboard.press('Enter');await page.waitForTimeout(300);
    assert.deepEqual(await snapshot(),drawn);
    results.checks.push('IndexedDB committed snapshot survives reload and restores exact pixels');
    // Qt Wasm omits names on line-edit proxies; the first edit is the HEX field.
    await page.getByRole('textbox').first().click({force:true});
    await page.keyboard.press(modifier+'+a');await page.keyboard.type('#1679ea');await page.keyboard.press('Enter');
    await page.getByRole('checkbox',{name:'브러시',exact:true}).click({force:true});
    await page.mouse.move(left+70,top+200);await page.mouse.down();
    for(let x=80;x<=300;x+=10)await page.mouse.move(left+x,top+200+Math.sin((x-70)/35)*30);
    await page.mouse.up();
    const painted=await snapshot();
    const paintedStart=28+4+painted.readUInt32LE(28)+1+4;
    const brushPixels=await page.evaluate(async(data)=>{
        const image=await createImageBitmap(new Blob([new Uint8Array(data)],{type:'image/png'}));
        const canvas=new OffscreenCanvas(image.width,image.height);const ctx=canvas.getContext('2d');ctx.drawImage(image,0,0);
        const center=Array.from(ctx.getImageData(70,200,1,1).data);
        const pixels=ctx.getImageData(62,192,16,16).data;
        let antialiased=false;for(let i=0;i<pixels.length;i+=4)if(pixels[i]>22&&pixels[i]<255&&pixels[i+2]>pixels[i])antialiased=true;
        return {center,antialiased};
    },Array.from(painted.subarray(paintedStart)));
    assert.deepEqual(brushPixels.center,[22,121,234,255]);assert(brushPixels.antialiased);
    results.checks.push('Studio HEX color and antialiased smooth brush produce correct exported pixels');
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
