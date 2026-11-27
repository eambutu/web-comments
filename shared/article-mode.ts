export const articleModes=['both','reader','archive'] as const;
export type ArticleMode=typeof articleModes[number];
export type ArticleLayout=Exclude<ArticleMode,'both'>;

// Old versions of the library can render this as ordinary HTML. The prefix lets
// newer versions distinguish a saved text fallback from the Reader conversion.
export const plainArticlePrefix='<!--web-comments:saved-layout-text:1-->';
export const escapeArticleText=(text:string)=>text.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;');

export function plainArticleHtml(text:string) {
  const limit=100_000; // Escaped UTF-8 stays within the existing 750,000-byte column.
  const excerpt=text.length>limit?text.slice(0,limit).replace(/[\uD800-\uDBFF]$/,'')+'\n…':text;
  return plainArticlePrefix+'<pre>'+escapeArticleText(excerpt)+'</pre>';
}
