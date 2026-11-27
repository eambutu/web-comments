export const articleTags='article section div span p h1 h2 h3 h4 h5 h6 a blockquote ul ol li dl dt dd pre code strong em b i s del mark sub sup u kbd samp var table thead tbody tfoot tr th td caption br hr figure figcaption details summary time img abbr cite q address'.split(' ');

export const whiteSpaceValues=['normal','pre','pre-wrap','pre-line','break-spaces'] as const;
const articleClasses=new Set([
  ...whiteSpaceValues.map(value=>'snapshot-space-'+value),
  'snapshot-block','snapshot-note',
]);
export const articleClass=(value:string)=>value.split(/\s+/).filter(token=>articleClasses.has(token)).join(' ');
export const articleId=/^wc-snapshot-[a-zA-Z0-9_-]{1,400}$/;
export const articleImage=/^data:image\/webp;base64,[a-zA-Z0-9+/]+={0,2}$/;
export const webLink=/^https?:\/\//i;
