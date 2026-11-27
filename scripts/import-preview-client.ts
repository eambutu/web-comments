import { sanitizeArticle } from '../src/article-sanitizer';
import { mountArchive } from '../src/archive-frame';
import { archivePolicy, type ArticleArchive } from '../shared/article-archive';

const payload=document.getElementById('snapshot')!;
const snapshot=JSON.parse(payload.textContent ?? '') as {html:string;archive?:ArticleArchive};
if (snapshot.archive) {
  const archive=snapshot.archive;
  const frame=document.querySelector('iframe')!;
  frame.addEventListener('load',()=>{
    if (frame.contentDocument?.URL!=='about:srcdoc') return;
    mountArchive(frame,archive);
    document.documentElement.dataset.previewReady='true';
  });
  frame.srcdoc='<html><head><meta http-equiv="Content-Security-Policy" content="'+archivePolicy+'"></head><body></body></html>';
} else {
  document.querySelector('.reader-content')!.innerHTML=sanitizeArticle(snapshot.html);
  document.documentElement.dataset.previewReady='true';
}
