export const maxArticleImageBytes=5*1024*1024;

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
  // Keep only local SVG references in archived and rasterized figures.
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
