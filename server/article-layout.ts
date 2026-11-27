import { parse, type Declaration } from 'postcss';
import { whiteSpaceValues } from '../shared/article-html';

type WhiteSpace=typeof whiteSpaceValues[number];
type Layout={space?:WhiteSpace;block?:boolean};

function layoutDeclarations(declarations:readonly Declaration[]) {
  const layout:Layout={};
  for (const {prop,value} of declarations) {
    const mode=value.trim().toLowerCase();
    if (prop.toLowerCase()==='white-space' && whiteSpaceValues.includes(mode as WhiteSpace)) layout.space=mode as WhiteSpace;
    if (prop.toLowerCase()==='display' && ['block','inline','inline-block'].includes(mode)) layout.block=mode==='block';
  }
  return layout;
}

const inlineTags=new Set(['span','b','strong','i','em','code','small','mark','abbr']);
const inlineSelector=Array.from(inlineTags).join(',');

// Use the publisher's static whitespace rules without retaining its stylesheet.
export function articleLayout(document:Document,root:Element) {
  const styles=new Map<Element,Layout>();
  const add=(element:Element,layout:Layout)=>{
    const {space,block}=layout;
    if (space===undefined && (block===undefined || !inlineTags.has(element.localName))) return;
    styles.set(element,{...styles.get(element),...layout});
  };
  let cssBytes=0;
  let rules=0;
  for (const style of document.querySelectorAll('style')) {
    const css=style.textContent ?? '';
    cssBytes+=css.length;
    if (cssBytes>128000 || rules>=128) break;
    try {
      for (const rule of parse(css).nodes) {
        if (rule.type!=='rule') continue;
        const layout=layoutDeclarations(rule.nodes.filter(node=>node.type==='decl'));
        if (layout.space===undefined && layout.block===undefined) continue;
        if (rules++>=128) break;
        // Simple selectors cover typography and avoid evaluating arbitrary publisher pseudo-classes.
        const selectors=rule.selectors.filter(selector=>selector.length<=200 &&
          /^[a-zA-Z0-9_*.#> +~-]+$/.test(selector));
        if (!selectors.length) continue;
        const selector=selectors.join(',');
        if (layout.space===undefined) {
          for (const element of root.querySelectorAll(inlineSelector)) {
            if (element.matches(selector)) add(element,layout);
          }
        } else {
          for (const element of root.querySelectorAll(selector)) add(element,layout);
          if (root.matches(selector)) add(root,layout);
        }
      }
    } catch {
      // A malformed publisher stylesheet does not prevent extraction of the article.
    }
  }
  for (const element of [root,...root.querySelectorAll('[style]')]) {
    const css=element.getAttribute('style');
    if (!css || css.length>1500 || !/white-space|display/i.test(css)) continue;
    try {
      const rule=parse('x{'+css+'}').first;
      if (rule?.type==='rule') add(element,layoutDeclarations(rule.nodes.filter(node=>node.type==='decl')));
    } catch {}
  }
  return (element:Element)=>{
    const style=styles.get(element);
    return [
      style?.space && 'snapshot-space-'+style.space,
      style?.block && inlineTags.has(element.localName) && 'snapshot-block',
      element.getAttribute('role')==='tooltip' && 'snapshot-note',
    ].filter(Boolean).join(' ');
  };
}
