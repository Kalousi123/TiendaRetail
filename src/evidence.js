import Busboy from 'busboy';
import sharp from 'sharp';
import { mkdir, writeFile, unlink, readdir, stat } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { db } from './db.js';
export const UPLOAD_DIR = resolve(process.env.UPLOAD_DIR || 'data/evidence');
export function readImages(req) {
  return new Promise((resolvePromise,reject)=>{
    let parser;
    try { parser=Busboy({headers:req.headers,limits:{files:5,fileSize:10*1024*1024,fields:0,parts:5}}); }
    catch { reject(Object.assign(new Error('Se requiere multipart/form-data'),{status:400})); return; }
    const files=[]; let failure;
    const fail=message=>{failure=Object.assign(new Error(message),{status:400});};
    parser.on('file',(_name,file,info)=>{
      const chunks=[];
      if(!['image/jpeg','image/png','image/webp'].includes(info.mimeType)) fail('Usa imágenes JPEG, PNG o WebP');
      file.on('limit',()=>fail('Cada foto admite hasta 10 MB'));
      file.on('data',chunk=>chunks.push(chunk));
      file.on('end',()=>files.push(Buffer.concat(chunks)));
    });
    parser.on('filesLimit',()=>fail('Máximo cinco fotos'));
    parser.on('partsLimit',()=>fail('Máximo cinco fotos'));
    parser.on('error',reject); req.on('aborted',()=>reject(new Error('Carga interrumpida')));
    parser.on('close',()=>failure?reject(failure):resolvePromise({files}));req.pipe(parser);
  });
}
export async function saveImages(instalacionId, empleadoId, files) {
  if(!files?.length || files.length>5) throw Object.assign(new Error('Adjunta entre una y cinco fotos'),{status:400});
  const prepared=[];
  for(const file of files) {
    try {
      const image=sharp(file,{limitInputPixels:40000000,animated:false});
      const metadata=await image.metadata();
      if(!['jpeg','png','webp'].includes(metadata.format)) throw new Error();
      prepared.push(await image.rotate().resize({width:2000,height:2000,fit:'inside',withoutEnlargement:true}).jpeg({quality:85}).toBuffer());
    } catch { throw Object.assign(new Error('La imagen no es válida o excede 40 megapíxeles'),{status:400}); }
  }
  await mkdir(UPLOAD_DIR,{recursive:true,mode:0o700});const saved=[];
  try {
    for(const buffer of prepared) {
      const id=randomUUID(),filename=`${id}.jpg`;
      await writeFile(join(UPLOAD_DIR,filename),buffer,{flag:'wx',mode:0o600});saved.push({id,filename});
      await db.prepare('INSERT INTO instalacion_evidencias(id,instalacion_id,empleado_id,filename,bytes) VALUES(?,?,?,?,?)').run(id,instalacionId,empleadoId,filename,buffer.length);
    }
    return saved.map(({id})=>id);
  } catch(error) { await Promise.all(saved.map(x=>unlink(join(UPLOAD_DIR,x.filename)).catch(()=>{})));throw error; }
}
export async function cleanupImages() {
  await mkdir(UPLOAD_DIR,{recursive:true,mode:0o700});
  const old=await db.prepare('SELECT id,filename FROM instalacion_evidencias WHERE vinculada=0 AND created_at < NOW() - INTERVAL 24 HOUR').all();
  for(const row of old){await db.prepare('DELETE FROM instalacion_evidencias WHERE id=? AND vinculada=0').run(row.id);await unlink(join(UPLOAD_DIR,row.filename)).catch(()=>{});}
  const known=new Set((await db.prepare('SELECT filename FROM instalacion_evidencias').all()).map(x=>x.filename));
  for(const file of await readdir(UPLOAD_DIR))if(/^[0-9a-f-]+\.jpg$/.test(file)&&!known.has(file)){
    const path=join(UPLOAD_DIR,file);if((await stat(path)).mtimeMs<Date.now()-86400000)await unlink(path);
  }
}
