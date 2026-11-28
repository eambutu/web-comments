// Ranges can span lines and can live inside clipped, independently scrolling panes.
export function visibleLine(range:Range,last=false):DOMRect|null {
  if (!range.startContainer.isConnected) return null;
  let left=0,top=0,right=document.documentElement.clientWidth,bottom=window.innerHeight;
  for (let node=range.commonAncestorContainer.nodeType===Node.ELEMENT_NODE
    ? range.commonAncestorContainer as Element : range.commonAncestorContainer.parentElement;
    node && node!==document.documentElement;node=node.parentElement) {
    const style=getComputedStyle(node);
    if (style.overflowX==='visible' && style.overflowY==='visible') continue;
    const box=node.getBoundingClientRect();
    if (style.overflowX!=='visible') { left=Math.max(left,box.left);right=Math.min(right,box.right); }
    if (style.overflowY!=='visible') { top=Math.max(top,box.top);bottom=Math.min(bottom,box.bottom); }
  }
  const lines=Array.from(range.getClientRects());
  let row:DOMRect|null=null;
  for (const line of last?lines.reverse():lines) {
    const x=Math.max(left,line.left),y=Math.max(top,line.top);
    const width=Math.min(right,line.right)-x,height=Math.min(bottom,line.bottom)-y;
    if (width<=0 || height<=0) continue;
    // One rendered line can have separate rectangles for links, emphasis or spans.
    if (!row) row=new DOMRect(x,y,width,height);
    else if (Math.min(row.bottom,y+height)-Math.max(row.top,y)>Math.min(row.height,height)/2) {
      const rowLeft=Math.min(row.left,x),rowTop=Math.min(row.top,y);
      row=new DOMRect(rowLeft,rowTop,Math.max(row.right,x+width)-rowLeft,Math.max(row.bottom,y+height)-rowTop);
    } else break;
  }
  return row;
}

export function readingColumn(range:Range) {
  const node=range.startContainer.nodeType===Node.ELEMENT_NODE?range.startContainer as Element:range.startContainer.parentElement;
  return node?.closest('p,li,h1,h2,h3,h4,h5,h6,pre,blockquote,td,th,article,main')?.getBoundingClientRect();
}

export function cardPosition(range:Range|null,height:number) {
  const gap=8,viewport=document.documentElement.clientWidth;
  let width=Math.min(320,viewport-2*gap);
  const clamp=(value:number,min:number,max:number)=>Math.max(min,Math.min(value,max));
  height=Math.min(height,Math.max(48,window.innerHeight-2*gap));
  let left=viewport-width-gap,top=window.innerHeight-height-50;
  const anchor=range && visibleLine(range);
  if (anchor) {
    const column=readingColumn(range!)??anchor;
    const rightSpace=viewport-column.right-2*gap,leftSpace=column.left-2*gap;
    if (rightSpace>=240) {
      width=Math.min(width,rightSpace);left=column.right+gap;top=anchor.top;
    } else if (leftSpace>=240) {
      width=Math.min(width,leftSpace);left=column.left-width-gap;top=anchor.top;
    } else {
      left=anchor.left;
      const bottom=visibleLine(range!,true)?.bottom??anchor.bottom;
      top=bottom+gap+height<=window.innerHeight-gap || bottom+gap<=window.innerHeight-anchor.top
        ? bottom+gap : anchor.top-height-gap;
    }
  }
  return {left:clamp(left,gap,viewport-width-gap),top:clamp(top,gap,window.innerHeight-height-gap),width,height};
}
