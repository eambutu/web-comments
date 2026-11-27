import createDOMPurify from 'dompurify';
import { articleClass, articleId, articleImage, articleTags, webLink } from '../shared/article-html';

const purifier=createDOMPurify(window);
purifier.addHook('uponSanitizeAttribute',(node,event)=>{
  const tag=node.nodeName.toLowerCase();
  const value=event.attrValue;
  switch (event.attrName) {
    case 'class':
      event.attrValue=articleClass(value);
      event.keepAttr=!!event.attrValue;
      break;
    case 'id':
      event.keepAttr=articleId.test(value);
      break;
    case 'src':
      // DOMPurify separately permits data URLs on images, so verify the exact format here.
      event.keepAttr=tag==='img' && articleImage.test(value);
      break;
    case 'href':
      event.keepAttr=tag==='a' && (webLink.test(value) || (value.startsWith('#') && articleId.test(value.slice(1))));
      break;
  }
});
purifier.addHook('afterSanitizeAttributes',node=>{
  if (node.nodeName!=='A') return;
  if (webLink.test(node.getAttribute('href') ?? '')) {
    node.setAttribute('target','_blank');
    node.setAttribute('rel','noopener noreferrer');
  } else {
    node.removeAttribute('target');
    node.removeAttribute('rel');
  }
});

export function sanitizeArticle(html:string) {
  return purifier.sanitize(html,{
    ALLOWED_TAGS:articleTags,
    ALLOWED_ATTR:['href','id','class','src','alt','title','start','reversed','value','type','colspan','rowspan','scope','open'],
    ALLOWED_URI_REGEXP:/^(?:https?:\/\/|#wc-snapshot-)/i,
    ALLOW_DATA_ATTR:false,ALLOW_ARIA_ATTR:false,
  });
}
