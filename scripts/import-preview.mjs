import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { basename, extname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { parseHTML } from 'linkedom';

const { values, positionals: urls }=parseArgs({
  allowPositionals:true,
  options:{
    out:{type:'string',default:'dist/import-previews'},
    source:{type:'string'},
    images:{type:'string'},
    assets:{type:'string'},
    archive:{type:'boolean'},
    screenshot:{type:'boolean'},
    browser:{type:'string'},
    focus:{type:'string',multiple:true,default:[]},
  },
});
if (!urls.length || values.source && urls.length!==1 ||
    (values.images || values.assets) && !values.source || values.focus.length && !values.screenshot) {
  throw Error('Usage: npm run import:preview -- [--out directory] [--archive] [--source captured.html --assets directory] [--screenshot [--browser /path/to/chromium] [--focus selector]] URL [URL ...]');
}

const root=fileURLToPath(new URL('../',import.meta.url));
const out=resolve(values.out);
const escape=value=>String(value).replace(/[&<>"']/g,char=>({
  '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;',
}[char]));
const write=(name,value)=>writeFile(join(out,name),value);
const original=values.source?await readFile(resolve(values.source),'utf8'):null;

async function localAsset(url,kind,source) {
  const extension=extname(url.pathname).toLowerCase();
  const parts=url.pathname.split('/').filter(Boolean);
  if (!parts.every(part=>/^[a-zA-Z0-9._@%+-]+$/.test(part) && part!=='.' && part!=='..')) return null;
  let bytes;
  if (values.assets) {
    bytes=await readFile(join(resolve(values.assets),url.hostname,...parts)).catch(()=>null);
  }
  if (!bytes && kind==='image' && values.images && url.origin===source.origin &&
      /^\.(?:avif|gif|jpe?g|png|webp|svg)$/.test(extension)) {
    bytes=await readFile(join(resolve(values.images),basename(url.pathname))).catch(()=>null);
  }
  if (!bytes) return null;
  const contentType=kind==='style'?'text/css':kind==='font'?'font/'+extension.slice(1):
    extension==='.svg'?'image/svg+xml':'image/'+extension.slice(1);
  return {body:bytes,url,contentType};
}

const htmlPage=(title,csp,styles,body)=>`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${escape(csp)}">
<meta name="referrer" content="no-referrer"><title>${escape(title)}</title>
<style>${styles}</style></head><body>${body}</body></html>`;

await mkdir(join(root,'dist'),{recursive:true});
const scratch=await mkdtemp(join(root,'dist','preview-build-'));
let browser;
try {
  await mkdir(out,{recursive:true});
  const [,clientBundle,baseCss,contentCss,libraryCss]=await Promise.all([
    build({absWorkingDir:root,entryPoints:['server/import-document.ts'],outfile:join(scratch,'importer.mjs'),
      bundle:true,format:'esm',platform:'node',packages:'external',target:'node22'}),
    build({absWorkingDir:root,entryPoints:['scripts/import-preview-client.ts'],write:false,
      bundle:true,format:'iife',target:'chrome120',minify:true}),
    readFile(join(root,'src/styles.css'),'utf8'),
    readFile(join(root,'src/content.css'),'utf8'),
    readFile(join(root,'src/library.css'),'utf8'),
  ]);
  const { articleSnapshots, importDocument, importUrl }=await import(pathToFileURL(join(scratch,'importer.mjs')).href);
  const js=clientBundle.outputFiles[0].text;
  const digest=createHash('sha256').update(js).digest('base64');
  const csp=`default-src 'none'; script-src 'sha256-${digest}'; style-src 'unsafe-inline'; img-src data:; font-src data:; frame-src 'self'; base-uri 'none'`;
  const styles=baseCss+contentCss+libraryCss+'body {background:#fffdf8}';
  if (values.screenshot) {
    const {chromium}=await import('playwright-core');
    browser=await chromium.launch({headless:true,executablePath:values.browser || process.env.CHROMIUM_PATH || undefined});
  }

  const rows=[];
  for (const [index,input] of urls.entries()) {
    const row={input};
    rows.push(row);
    try {
      const url=importUrl(input);
      const result=original===null?await importDocument(url.href,values.archive):
        await articleSnapshots(original,url,(asset,kind)=>localAsset(asset,kind,url),!!values.archive);
      if (result.kind!=='html') throw Error('The URL returned a PDF. This preview exercises the HTML reader.');
      const slug=(basename(url.pathname,extname(url.pathname)) || url.hostname).toLowerCase().replace(/[^a-z0-9-]+/g,'-').slice(0,65);
      const name=String(index+1).padStart(2,'0')+'-'+slug;
      row.page=name+'.html';
      row.title=result.title;
      row.source=result.url;
      row.complete=result.complete;
      row.note=result.note;
      row.bytes=Buffer.byteLength(result.html);
      row.sha256=createHash('sha256').update(result.html).digest('hex');
      const {document}=parseHTML(result.html);
      const metrics=['h1,h2,h3,h4,h5,h6','p','ul,ol','li','a[href]','a[href^="#"]','img','figure','pre,br,.snapshot-space-pre-line,.snapshot-space-pre-wrap'];
      const labels=['headings','paragraphs','lists','listItems','links','inPageLinks','images','figures','lineBreaks'];
      row.markup=Object.fromEntries(metrics.map((selector,i)=>[labels[i],document.querySelectorAll(selector).length]));

      const payload=JSON.stringify({html:result.html}).replaceAll('<','\\u003c');
      await write(row.page,htmlPage(result.title,csp,styles,
        '<main class="library-reader"><header class="library-document-header"><div><h2>'+escape(result.title)+
        '</h2><p>'+escape(url.hostname)+'</p></div><a href="'+escape(result.url)+
        '" target="_blank" rel="noopener noreferrer">Open original</a></header><article class="reader-content"></article></main>'+
        '<script id="snapshot" type="application/json">'+payload+'</script><script>'+js+'</script>'));
      if (values.archive && result.archive) {
        row.archive=name+'-archive.html';
        row.archiveMissingAssets=result.archive.missingAssets;
        row.archiveBytes=Buffer.byteLength(result.archive.html);
        const archivePayload=JSON.stringify({archive:result.archive}).replaceAll('<','\\u003c');
        await write(row.archive,htmlPage(result.title+' · saved layout',csp,
          'html,body,iframe {box-sizing:border-box;width:100%;height:100%;margin:0;border:0} iframe {display:block}',
          '<iframe title="Saved article layout" sandbox="allow-same-origin" referrerpolicy="no-referrer"></iframe>'+
          '<script id="snapshot" type="application/json">'+archivePayload+'</script><script>'+js+'</script>'));
      }

      if (browser) {
        const page=await browser.newPage({viewport:{width:1180,height:920},deviceScaleFactor:1});
        try {
          const previewRoot='http://localhost/';
          await page.route('**/*',route=>{
            const address=route.request().url();
            const file=[row.page,row.archive].find(name=>name && address===previewRoot+name);
            return file?route.fulfill({path:join(out,file),contentType:'text/html; charset=utf-8'}):route.abort();
          });
          await page.goto(previewRoot+row.page);
          await page.locator('html[data-preview-ready]').waitFor({timeout:5000});
          const reader=page.locator('.reader-content');
          row.rendered=await reader.evaluate(async (node,selectors)=>{
            const result=Object.fromEntries(selectors.map(([label,selector])=>[label,node.querySelectorAll(selector).length]));
            const images=Array.from(node.querySelectorAll('img'));
            await Promise.all(images.map(image=>image.decode().catch(()=>{})));
            result.loadedImages=images.filter(image=>image.naturalWidth>0).length;
            result.brokenFragments=Array.from(node.querySelectorAll('a[href^="#"]')).filter(link=>
              !node.ownerDocument.getElementById(link.getAttribute('href').slice(1))).length;
            return result;
          },labels.map((label,i)=>[label,metrics[i]]));
          for (const label of labels) {
            if (row.rendered[label]!==row.markup[label]) throw Error('The reader changed the parsed '+label+' count.');
          }
          if (row.rendered.brokenFragments || row.rendered.loadedImages!==row.rendered.images) {
            throw Error('The rendered page has broken fragments or images.');
          }
          row.screenshots=[name+'.png'];
          await page.screenshot({path:join(out,row.screenshots[0])});
          for (const [focusIndex,selector] of values.focus.entries()) {
            const target=reader.locator(selector).first();
            if (!await target.count()) throw Error('Screenshot target not found: '+selector);
            await target.evaluate(node=>node.scrollIntoView({block:'start'}));
            const file=name+'-section-'+(focusIndex+1)+'.png';
            await page.screenshot({path:join(out,file)});
            row.screenshots.push(file);
          }
          if (row.archive) {
            await page.goto(previewRoot+row.archive);
            await page.locator('html[data-preview-ready]').waitFor({timeout:5000});
            const frame=page.frameLocator('iframe');
            await frame.locator('body').waitFor({timeout:5000});
            row.archiveRendered=await frame.locator('body').evaluate(async node=>{
              await node.ownerDocument.fonts.ready;
              const images=Array.from(node.querySelectorAll('img[src^="data:"]'));
              images.forEach(image=>image.loading='eager');
              await Promise.all(images.map(image=>image.decode().catch(()=>{})));
              return {images:images.length,loadedImages:images.filter(image=>image.naturalWidth>0).length,
                inlineCharts:node.querySelectorAll('svg').length,svgUses:node.querySelectorAll('svg use').length,
                loadedFonts:[...node.ownerDocument.fonts].filter(font=>font.status==='loaded').length};
            });
            if (row.archiveRendered.images!==row.archiveRendered.loadedImages) throw Error('A saved layout image failed to decode.');
            const file=name+'-archive.png';
            await page.screenshot({path:join(out,file)});
            row.screenshots.push(file);
            for (const [focusIndex,selector] of values.focus.entries()) {
              const target=frame.locator(selector).first();
              if (!await target.count()) continue;
              await target.evaluate(node=>node.scrollIntoView({block:'start'}));
              const section=name+'-archive-section-'+(focusIndex+1)+'.png';
              await page.screenshot({path:join(out,section)});
              row.screenshots.push(section);
            }
          }
        } finally {
          await page.close();
        }
      }
      console.log(result.title+' → '+join(out,row.page));
    } catch (error) {
      row.error=error.message;
      process.exitCode=1;
      console.error(input+' — '+row.error);
    }
  }

  await write('report.json',JSON.stringify(rows,null,2)+'\n');
  const indexStyle=baseCss+'main {max-width:90rem;margin:2rem auto;padding:1rem} li {margin:1rem 0} .captures {display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:1rem} .captures a {display:grid;gap:.4rem;align-content:start} .captures img {width:100%;aspect-ratio:1180/920;object-fit:contain;background:white;border:1px solid #ccd9d8;border-radius:.35rem}';
  const indexCsp=csp.replace('img-src data:',"img-src 'self' data:");
  await write('index.html',htmlPage('Article import previews',indexCsp,indexStyle,'<main><h1>Article import previews</h1>'+
    '<p><a href="report.json">Measurements</a></p><ol>'+rows.map(row=>'<li>'+
      (row.page?'<a href="'+escape(row.page)+'">'+escape(row.title)+'</a>':escape(row.input))+
      (row.archive?' · <a href="'+escape(row.archive)+'">Saved layout</a>':'')+
      (row.error?'<p>'+escape(row.error)+'</p>':'')+
      (row.screenshots?.length?'<p class="captures">'+row.screenshots.map(file=>{
        const layout=file.includes('-archive')?'Archive':'Reader';
        const section=file.match(/-section-(\d+)\.png$/)?.[1];
        const label=layout+(section?' section '+section:' screenshot');
        return '<a href="'+escape(file)+'"><img src="'+escape(file)+'" alt="" loading="lazy">'+escape(label)+'</a>';
      }).join('')+'</p>':'')+'</li>').join('')+'</ol></main>'));
} finally {
  await browser?.close();
  await rm(scratch,{recursive:true,force:true});
}
