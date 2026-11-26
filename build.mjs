import { build } from 'esbuild';
import { cp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { zipSync } from 'fflate';

const publicAddress = process.env.PUBLIC_ORIGIN || process.env.RENDER_EXTERNAL_URL;
const define = {DEFAULT_WEB_COMMENTS_ORIGIN:JSON.stringify(publicAddress ? new URL(publicAddress).origin : '')};

await rm('dist', {recursive:true,force:true});
await mkdir('dist/extension', {recursive:true});
const bundle = (entryPoints, outdir, options={}) => build({
  entryPoints,outdir,bundle:true,target:'chrome120',loader:{'.woff':'file','.woff2':'file','.ttf':'file'},
  logLevel:'warning',...options,
});
await Promise.all([
  bundle(['src/background.ts','src/content.ts'],'dist/extension',{format:'iife'}),
  bundle(['src/panel.tsx','src/viewer.ts'],'dist/extension',{format:'esm',define}),
  bundle(['src/web.ts'],'dist/web/assets',{format:'esm',define}),
  bundle(['server/index.ts'],'dist',{target:'node22',platform:'node',format:'esm',packages:'external',entryNames:'server'}),
  bundle(['server/review.ts'],'dist',{target:'node22',platform:'node',format:'esm',packages:'external'}),
  cp('node_modules/pdfjs-dist/build/pdf.worker.mjs','dist/extension/pdf.worker.mjs'),
  cp('node_modules/pdfjs-dist/cmaps','dist/extension/cmaps',{recursive:true}),
  cp('node_modules/pdfjs-dist/standard_fonts','dist/extension/standard_fonts',{recursive:true}),
  cp('src/content.css','dist/extension/content.css'),
  cp('node_modules/pdfjs-dist/LICENSE','dist/extension/PDFJS-LICENSE'),
  cp('node_modules/katex/LICENSE','dist/extension/KATEX-LICENSE'),
  cp('src/manifest.json','dist/extension/manifest.json'),
  cp('src/panel.html','dist/extension/panel.html'),
  cp('src/viewer.html','dist/extension/viewer.html'),
  cp('src/web.html','dist/web/index.html'),
  cp('src/styles.css','dist/web/assets/styles.css'),
]);

const extensionFiles = await readdir('dist/extension',{recursive:true,withFileTypes:true});
const archiveFiles = await Promise.all(extensionFiles.filter(file => file.isFile()).map(async file => {
  const path = file.parentPath + '/' + file.name;
  return [path.slice('dist/extension/'.length),await readFile(path)];
}));
await writeFile('dist/web/chrome-extension.zip',zipSync(Object.fromEntries(archiveFiles)));
