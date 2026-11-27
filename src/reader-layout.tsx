import React from 'react';

export function ReaderLayout({html,onRoot}:{html:string;onRoot:(root:HTMLElement|null)=>void}) {
  return <article className="reader-content" ref={onRoot} dangerouslySetInnerHTML={{__html:html}}/>;
}
