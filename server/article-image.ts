import sharp from 'sharp';

export const maxArticleImageBytes=5*1024*1024;
const maxImageWidth=1250;
const maxImageOutput=36*1024;
const imageFormats=new Set(['jpeg','png','webp','gif','heif']);

export function rasterMime(bytes:Buffer) {
  if (bytes.subarray(0,3).equals(Buffer.from([0xff,0xd8,0xff]))) return 'image/jpeg';
  if (bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return 'image/png';
  if (['GIF87a','GIF89a'].includes(bytes.toString('ascii',0,6))) return 'image/gif';
  if (bytes.toString('ascii',0,4)==='RIFF' && bytes.toString('ascii',8,12)==='WEBP') return 'image/webp';
  if (['ftypavif','ftypavis'].includes(bytes.toString('ascii',4,12))) return 'image/avif';
  return null;
}

export function inlineSvg(element:Element) {
  const svg=element.cloneNode(true) as Element;
  // Render standalone vector figures as bitmap images. Only local SVG references are needed.
  svg.querySelectorAll('script,foreignObject,style,animate,animateMotion,animateTransform,set').forEach(node=>node.remove());
  for (const node of [svg,...svg.querySelectorAll('*')]) {
    for (const {name,value} of Array.from(node.attributes)) {
      if (/^on/i.test(name) || (/^(?:xlink:)?href$/i.test(name) && !value.startsWith('#')) ||
          /url\s*\(/i.test(value) && !/^url\(#[\w.-]+\)$/.test(value)) node.removeAttribute(name);
    }
  }
  svg.setAttribute('xmlns','http://www.w3.org/2000/svg');
  const bytes=Buffer.from(svg.outerHTML);
  return bytes.length<=480000 ? bytes : null;
}

export async function articleImageData(bytes:Buffer,svg=false) {
  if (!svg && !rasterMime(bytes)) return null;
  try {
    const image=sharp(bytes,{limitInputPixels:16_000_000,failOn:'error'});
    const {format}=await image.metadata();
    if (svg ? format!=='svg' : !format || !imageFormats.has(format)) return null;
    image.autoOrient().resize(maxImageWidth,maxImageWidth,{fit:'inside',withoutEnlargement:true});
    let result=await image.webp({quality:78}).toBuffer();
    if (result.length>maxImageOutput) {
      result=await image.resize(900,900,{fit:'inside',withoutEnlargement:true}).webp({quality:56}).toBuffer();
    }
    if (result.length>maxImageOutput) {
      result=await image.resize(650,650,{fit:'inside',withoutEnlargement:true}).webp({quality:47}).toBuffer();
    }
    return result.length<=maxImageOutput?'data:image/webp;base64,'+result.toString('base64'):null;
  } catch {
    return null;
  }
}
