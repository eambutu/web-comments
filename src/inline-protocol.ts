import type { Capture, Thread } from './model';

export type PageToCard =
  | {type:'page';source:string}
  | {type:'overview'}
  | {type:'draft';capture:Capture}
  | {type:'thread';id:string}
  | {type:'missing';ids:string[]};

export type CardToPage =
  | {type:'threads';threads:Thread[]}
  | {type:'overview'}
  | {type:'focus';id:string}
  | {type:'dismiss'}
  | {type:'height';pixels:number};
