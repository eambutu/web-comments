import sharp from 'sharp';
import { rasterMime } from './article-image';

const maxImageWidth=1250;
const maxImageOutput=36*1024;
const imageFormats=new Set(['jpeg','png','webp','gif','heif']);

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
