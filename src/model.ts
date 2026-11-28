export type HTMLAnchor = { kind:'html'; exact:string; prefix:string; suffix:string; start:number; end:number; occurrences?:number };
export type PDFAnchor = { kind:'pdf'; exact:string; page:number; binaryHash:string; rects:{x:number;y:number;w:number;h:number}[] };
export type Anchor = HTMLAnchor | PDFAnchor;
export type Capture = {
  url:string; title:string; text:string; kind:'html'|'pdf'; complete:boolean;
  note:string; anchor:Anchor|null; binaryHash?:string; pdfPath?:string; pdfBlob?:Blob;
};
export type Thread = {id:string; version_id:string; anchor:Anchor; resolved:boolean};
export type Message = {id:string; thread_id:string; body:string; role:'user'|'assistant'; question:boolean; reply_to:string|null};

export async function hash(data: string | ArrayBuffer) {
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  const digest = await crypto.subtle.digest('SHA-256',bytes);
  return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2,'0')).join('');
}

export async function captureFingerprint(documentHash:string,capture:Pick<Capture,'kind'|'complete'|'note'|'binaryHash'>,
  snapshotHtml?:string|null,archiveDigest?:string) {
  const signature=[documentHash,capture.kind,capture.complete,capture.note,capture.binaryHash];
  if (typeof snapshotHtml==='string') signature.push(await hash(snapshotHtml));
  if (archiveDigest) signature.push(archiveDigest);
  return hash(JSON.stringify(signature));
}

export function locate(text:string, anchor:HTMLAnchor) {
  if (!anchor.exact) return -1;
  const positions:number[] = [];
  for (let i = text.indexOf(anchor.exact); i !== -1; i = text.indexOf(anchor.exact,i+1)) positions.push(i);
  if (positions.length < 2) return positions[0] ?? -1;
  const ranked = positions.map(start => {
    const before = text.slice(Math.max(0,start-anchor.prefix.length),start);
    const after = text.slice(start+anchor.exact.length,start+anchor.exact.length+anchor.suffix.length);
    let prefix = 0, suffix = 0;
    while (prefix < before.length && before.at(-prefix-1) === anchor.prefix.at(-prefix-1)) prefix++;
    while (suffix < after.length && after[suffix] === anchor.suffix[suffix]) suffix++;
    return {start,score:prefix+suffix,distance:Math.abs(start-anchor.start)};
  }).sort((a,b) => b.score-a.score || a.distance-b.distance);
  const [best,runnerUp] = ranked;
  if (best.score === runnerUp.score && (best.score === 0 || best.distance === runnerUp.distance)) return -1;
  return best.start;
}

// A layout can introduce a different run of whitespace between the same words.
// Store offsets in the canonical reader text, even for selections made in the archive.
export function alignHtmlAnchor(text:string,anchor:HTMLAnchor):HTMLAnchor|null {
  if (!anchor.exact.trim()) return null;
  let start=locate(text,anchor);
  let end=start+anchor.exact.length;
  if (start<0) {
    const fold=(value:string)=>value.replace(/\s+/g,' ');
    const normalized={...anchor,exact:fold(anchor.exact),prefix:fold(anchor.prefix),suffix:fold(anchor.suffix)};
    const position=locate(fold(text),normalized);
    if (position<0) return null;
    start=position;
    end=position+normalized.exact.length;
    let removed=0;
    for (const match of text.matchAll(/\s{2,}/g)) {
      const at=match.index-removed;
      if (at>=position+normalized.exact.length) break;
      const extra=match[0].length-1;
      if (at<position) start+=extra;
      end+=extra;
      removed+=extra;
    }
  }
  return {kind:'html',start,end,exact:text.slice(start,end),
    prefix:text.slice(Math.max(0,start-100),start),suffix:text.slice(end,end+100)};
}
