import { sanitizeArticle } from '../src/article-sanitizer';

const payload=document.getElementById('snapshot')!;
const snapshot=JSON.parse(payload.textContent ?? '') as {html:string};
const reader=document.querySelector('.reader-content')!;
reader.innerHTML=sanitizeArticle(snapshot.html);
document.documentElement.dataset.previewReady='true';
