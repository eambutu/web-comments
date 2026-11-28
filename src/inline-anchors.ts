import type { HTMLAnchor } from './model';

const fold=(text:string)=>text.replace(/\s+/g,' ');

// Index once per page change. Compare all occurrences in the same whitespace
// representation so a decoy with an exact space cannot beat the intended line wrap.
export function inlineQuoteIndex(text:string) {
  const normalized=fold(text);
  let removed=0;
  const runs=Array.from(text.matchAll(/\s{2,}/g),match=>{
    const at=match.index-removed;
    removed+=match[0].length-1;
    return {at,removed};
  });
  function original(offset:number) {
    let lo=0,hi=runs.length;
    while (lo<hi) {
      const mid=(lo+hi)>>>1;
      if (runs[mid].at<offset) lo=mid+1;else hi=mid;
    }
    return offset+(lo?runs[lo-1].removed:0);
  }
  function positions(exact:string) {
    const result:number[]=[];
    if (!exact.trim()) return result;
    for (let at=normalized.indexOf(exact);at>=0;at=normalized.indexOf(exact,at+1)) result.push(at);
    return result;
  }
  return {
    count:(quote:string)=>positions(fold(quote)).length,
    range(anchor:HTMLAnchor) {
      const exact=fold(anchor.exact),prefix=fold(anchor.prefix),suffix=fold(anchor.suffix);
      const matches=positions(exact).map(at=>{
        const end=at+exact.length;
        let left=0,right=0;
        while (left<prefix.length && left<at && normalized[at-left-1]===prefix[prefix.length-left-1]) left++;
        while (right<suffix.length && normalized[end+right]===suffix[right]) right++;
        return {start:original(at),end:original(end),score:left+right,left,right};
      });
      matches.sort((a,b)=>b.score-a.score || Math.abs(a.start-anchor.start)-Math.abs(b.start-anchor.start));
      const [best,second]=matches;
      if (!best) return null;
      if (second?.score===best.score && (!best.score || best.start!==anchor.start)) return null;
      if (anchor.occurrences && matches.length<anchor.occurrences) {
        const stableContext=(prefix.length>0 && best.left>=Math.min(32,prefix.length)) ||
          (suffix.length>0 && best.right>=Math.min(32,suffix.length));
        if (!stableContext) return null;
      }
      return {start:best.start,end:best.end};
    },
  };
}
