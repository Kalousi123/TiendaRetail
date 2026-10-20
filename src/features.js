import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { db, ahora } from './db.js';
import { ApiError, exigir, exigirTecnicoDe, puedeVerInstalacion } from './routes.js';
import { generateLabels } from './labels.js';
import { generarEtiquetasPdf, FORMATOS } from './labelpdf.js';
import { saveImages, UPLOAD_DIR } from './evidence.js';
const hash = token => createHash('sha256').update(token).digest('hex');
function validate(condition,message) { if(!condition)throw new ApiError(400,message); }
/* Un producto solo se imprime si tiene código de barras numérico, que es lo
   que garantiza generateLabels y lo que hace falta para dibujar el PDF. El
   precio se trae para la etiqueta compacta de las hojas con rejilla; en la de
   100 × 150 no se imprime. */
async function productoParaEtiqueta(id) {
  const p=await db.prepare('SELECT id,codigo,codigo_barras,nombre,contenido,unidad,precio FROM productos WHERE id=? AND activo=1').get(id);
  if(!p)throw new ApiError(404,'Producto no encontrado');
  validate(/^\d{1,32}$/.test(p.codigo_barras),'Producto sin código imprimible');
  return p;
}
function copiasDe(valor) {
  const n=Number(valor);
  validate(Number.isInteger(n)&&n>0&&n<=1000,'Cantidad inválida');
  return n;
}
/* La hora local del servidor, no la de UTC: el archivo se ordena con la misma
   fecha que ve el usuario en la pantalla. */
function sello() {
  const d=new Date(),p=n=>String(n).padStart(2,'0');
  return `${d.getFullYear()}${p(d.getMonth()+1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}
const pdfDeEtiquetas=(items,hoja,filename)=>({binary:generarEtiquetasPdf(items,{hoja}),contentType:'application/pdf',filename});
export async function featureHandler(req,path,body,empleado) {
  const method=req.method;
  if(path.startsWith('/api/agent/')) {
    const token=(req.headers.authorization||'').replace(/^Bearer /,'');
    const agent=token && await db.prepare('SELECT * FROM print_agents WHERE token_hash=? AND activo=1').get(hash(token));
    if(!agent)throw new ApiError(401,'Agente no autorizado');
    await db.prepare('UPDATE print_agents SET last_seen=? WHERE id=?').run(ahora(),agent.id);
    if(path==='/api/agent/poll'&&method==='POST') {
      await db.prepare("UPDATE print_jobs j JOIN printers p ON p.id=j.printer_id SET j.status='uncertain',j.error='El agente no confirmó el envío',j.updated_at=NOW() WHERE p.agent_id=? AND j.status='claimed' AND j.claimed_at < NOW() - INTERVAL 2 MINUTE").run(agent.id);
      const job=await db.prepare("SELECT j.id,j.payload,p.queue_name FROM print_jobs j JOIN printers p ON p.id=j.printer_id WHERE p.agent_id=? AND p.activo=1 AND j.status='pending' ORDER BY j.created_at,j.id LIMIT 1").get(agent.id);
      if(!job)return {job:null};
      job.claim_token=randomUUID();
      await db.prepare("UPDATE print_jobs SET status='claimed',claim_token=?,claimed_at=NOW(),updated_at=NOW() WHERE id=?").run(job.claim_token,job.id);
      return {job};
    }
    const ack=path.match(/^\/api\/agent\/jobs\/([\w-]+)\/ack$/);
    if(ack&&method==='POST') {
      validate(['submitted','uncertain','failed'].includes(body.status),'Estado inválido');
      const job=await db.prepare('SELECT j.* FROM print_jobs j JOIN printers p ON p.id=j.printer_id WHERE j.id=? AND p.agent_id=?').get(ack[1],agent.id);
      if(!job||job.claim_token!==body.claim_token)throw new ApiError(404,'Trabajo no encontrado');
      if(!['claimed','uncertain',body.status].includes(job.status))throw new ApiError(409,'Trabajo ya confirmado');
      await db.prepare('UPDATE print_jobs SET status=?,error=?,updated_at=NOW() WHERE id=?').run(body.status,String(body.error||'').slice(0,1000),job.id);
      return {ok:true};
    }
    throw new ApiError(404,'Ruta de agente no encontrada');
  }
  const photo=path.match(/^\/api\/instalaciones\/(\d+)\/evidencias(?:\/([\w-]+))?$/);
  if(photo) {
    exigir(empleado,'instalaciones:ver');
    const inst=await db.prepare('SELECT * FROM instalaciones WHERE id=?').get(Number(photo[1]));
    if(!inst||!puedeVerInstalacion(empleado,inst))throw new ApiError(404,'Instalación no encontrada');
    if(method==='POST'&&!photo[2]) {
      exigir(empleado,'instalaciones:gestionar');exigirTecnicoDe(empleado,inst);
      validate(inst.estado==='en_progreso','La instalación debe estar en progreso');
      return {evidencias:await saveImages(inst.id,empleado.id,body.files)};
    }
    if(method==='GET'&&photo[2]) {
      const row=await db.prepare(`SELECT ev.filename,ev.vinculada,ev.empleado_id,ev.created_at,emp.nombre AS empleado_nombre
        FROM instalacion_evidencias ev LEFT JOIN empleados emp ON emp.id=ev.empleado_id
        WHERE ev.id=? AND ev.instalacion_id=?`).get(photo[2],inst.id);
      if(!row||(!row.vinculada&&row.empleado_id!==empleado.id&&empleado.rol!=='admin'))throw new ApiError(404,'Foto no encontrada');
      /* El tipo sale de la extensión real y no de un valor fijo: hasta ahora
         todas acaban en .jpg porque sharp las recodifica, pero si algún día se
         guarda otro formato, servirlo como image/jpeg lo rompe. */
      const ext=extname(row.filename).toLowerCase();
      const contentType=ext==='.png'?'image/png':ext==='.webp'?'image/webp':'image/jpeg';
      const binary=await readFile(join(UPLOAD_DIR,row.filename));
      /* El archivo en disco es un UUID. Para quien lo archiva con la orden, el
         nombre útil es el de la orden, la fecha y quién la tomó. Se limpia
         porque viaja en una cabecera y un salto de línea ahí rompe la respuesta. */
      let filename=null;
      if(body&&String(body.download)==='1'){
        /* Se quitan los acentos en vez de borrarlos: si no, "Carlos Técnico"
           termina en un "T-cnico" que ya no se parece a ningún nombre. */
        const base=[inst.codigo,String(row.created_at||'').slice(0,10),row.empleado_nombre||'sin-nombre']
          .join('-').normalize('NFD').replace(/[\u0300-\u036f]/g,'').replace(/[^A-Za-z0-9._-]+/g,'-').replace(/^-+|-+$/g,'').slice(0,120);
        filename=(base||'evidencia')+contentType.replace('image/','.').replace('jpeg','jpg');
      }
      return {binary,contentType,filename};
    }
    throw new ApiError(404,'Ruta no encontrada');
  }
  if(!path.startsWith('/api/impresion'))return null;
  /* ---- Etiquetas en PDF ----
     Van antes del permiso de edición: exportar el PDF no toca ninguna
     impresora de la tienda, es solo un archivo para el que lo pide. Por eso lo
     puede sacar también el técnico, que ve el catálogo pero no lo edita y a
     veces necesita la etiqueta de lo que está instalando. */
  const etiquetaUnica=path.match(/^\/api\/impresion\/etiquetas\/(\d+)\/pdf$/);
  if(etiquetaUnica&&method==='GET') {
    exigir(empleado,'productos:ver');
    const producto=await productoParaEtiqueta(Number(etiquetaUnica[1]));
    /* Una sola etiqueta sale con el papel de su tamaño exacto: es lo que
       entiende una impresora de etiquetas sin recortes. */
    return pdfDeEtiquetas([{...producto,copias:copiasDe(body.copias??1)}],'etiqueta',`etiqueta-${producto.codigo_barras}.pdf`);
  }
  /* Los formatos de hoja con su cuenta de etiquetas. Los manda el servidor para
     que el selector no pueda prometer "dos por hoja" cuando en el papel caben
     diez, y para que ninguno tenga que adivinar el tamaño de la etiqueta. */
  if(path==='/api/impresion/etiquetas/formatos'&&method==='GET') {
    exigir(empleado,'productos:ver');
    return { formatos:FORMATOS };
  }
  if(path==='/api/impresion/etiquetas/pdf'&&method==='POST') {
    exigir(empleado,'productos:ver');
    validate(Array.isArray(body.items)&&body.items.length>0&&body.items.length<=1000,'Selecciona productos');
    const items=[];let total=0;
    for(const item of body.items){
      const producto=await productoParaEtiqueta(Number(item.producto_id));
      const copias=copiasDe(item.copias);
      total+=copias;validate(total<=1000,'Máximo 1000 etiquetas por PDF');
      items.push({...producto,copias});
    }
    /* Una hoja que no existe no es un papel cualquiera: si el nombre viene mal
       sería un PDF en un tamaño que el usuario no pidió. Sin hoja se usa la
       rejilla densa, que es la que sirve para imprimir un catálogo entero. */
    const hoja=body.hoja||'a4densa';
    validate(FORMATOS.some(f=>f.clave===hoja),`Hoja desconocida: ${hoja}`);
    return pdfDeEtiquetas(items,hoja,`etiquetas-${sello()}.pdf`);
  }
  exigir(empleado,'productos:editar');
  if(path==='/api/impresion/config'&&method==='GET')return {
    agents:await db.prepare('SELECT id,nombre,sucursal_id,activo,last_seen FROM print_agents ORDER BY id').all(),
    printers:await db.prepare('SELECT p.*,a.sucursal_id,a.last_seen,a.activo AS agente_activo FROM printers p JOIN print_agents a ON a.id=p.agent_id ORDER BY p.id').all(),
  };
  if(path==='/api/impresion/agentes'&&method==='POST') {
    validate(String(body.nombre||'').trim().length>0&&String(body.nombre).length<=191,'Nombre requerido (máximo 191 caracteres)');
    validate(await db.prepare('SELECT id FROM sucursales WHERE id=? AND activo=1').get(Number(body.sucursal_id)),'Sucursal inválida');
    const token=randomBytes(32).toString('hex');
    const r=await db.prepare('INSERT INTO print_agents(nombre,sucursal_id,token_hash) VALUES(?,?,?)').run(body.nombre.trim(),Number(body.sucursal_id),hash(token));
    return {id:r.lastInsertRowid,token};
  }
  const agentPath=path.match(/^\/api\/impresion\/agentes\/(\d+)$/);
  if(agentPath&&method==='DELETE') {
    await db.prepare('UPDATE print_agents SET activo=0 WHERE id=?').run(Number(agentPath[1]));return {ok:true};
  }
  if(path==='/api/impresion/impresoras'&&method==='POST') {
    validate(await db.prepare('SELECT id FROM print_agents WHERE id=? AND activo=1').get(Number(body.agent_id)),'Agente inválido');
    validate(['ZPL','TSPL'].includes(body.language)&&[203,300].includes(Number(body.dpi)),'Lenguaje o resolución inválidos');
    for(const key of ['nombre','queue_name'])validate(typeof body[key]==='string'&&body[key].trim().length>0&&body[key].length<=191,'Nombre y cola de Windows requeridos');
    for(const key of ['offset_x','offset_y'])validate(Number.isFinite(Number(body[key]??0))&&Math.abs(Number(body[key]??0))<=5,'Desplazamiento máximo: 5 mm');
    validate(Number.isFinite(Number(body.gap_mm??3))&&Number(body.gap_mm??3)>=0&&Number(body.gap_mm??3)<=10,'Separación inválida');
    const args=[Number(body.agent_id),body.nombre.trim(),body.queue_name.trim(),body.language,Number(body.dpi),Number(body.offset_x||0),Number(body.offset_y||0),Number(body.gap_mm??3)];
    if(body.id){
      const result=await db.prepare('UPDATE printers SET agent_id=?,nombre=?,queue_name=?,language=?,dpi=?,offset_x=?,offset_y=?,gap_mm=? WHERE id=?').run(...args,Number(body.id));
      validate(result.changes>0,'Impresora no encontrada');return {id:Number(body.id)};
    }
    const r=await db.prepare('INSERT INTO printers(agent_id,nombre,queue_name,language,dpi,offset_x,offset_y,gap_mm) VALUES(?,?,?,?,?,?,?,?)').run(...args);
    return {id:r.lastInsertRowid};
  }
  if(path==='/api/impresion/trabajos'&&method==='POST') {
    validate(typeof body.request_key==='string'&&/^[\w-]{16,64}$/.test(body.request_key),'Identificador de solicitud requerido');
    const existing=await db.prepare('SELECT id,status FROM print_jobs WHERE empleado_id=? AND request_key=?').get(empleado.id,body.request_key);
    if(existing)return {job:existing};
    const printer=await db.prepare('SELECT p.* FROM printers p JOIN print_agents a ON a.id=p.agent_id WHERE p.id=? AND p.activo=1 AND a.activo=1').get(Number(body.printer_id));
    validate(printer,'Impresora inválida');
    validate(Array.isArray(body.items)&&body.items.length>0&&body.items.length<=1000,'Selecciona productos');
    const items=[];let total=0;
    for(const item of body.items) {
      const product=await db.prepare('SELECT id,nombre,codigo_barras,contenido,unidad FROM productos WHERE id=? AND activo=1').get(Number(item.producto_id));
      validate(product&&/^\d{1,32}$/.test(product.codigo_barras),'Producto sin código imprimible');
      validate(Number.isInteger(item.copias)&&item.copias>0&&item.copias<=1000,'Cantidad inválida');
      total+=item.copias;validate(total<=1000,'Máximo 1000 etiquetas por trabajo');items.push({...product,copias:item.copias});
    }
    const id=randomUUID();
    await db.prepare('INSERT INTO print_jobs(id,request_key,empleado_id,printer_id,items,payload) VALUES(?,?,?,?,?,?)').run(id,body.request_key,empleado.id,printer.id,JSON.stringify(items),generateLabels(printer,items));
    return {job:{id,status:'pending'}};
  }
  if(path==='/api/impresion/trabajos'&&method==='GET')return {jobs:await db.prepare("SELECT j.id,CASE WHEN j.status=? AND j.claimed_at < NOW() - INTERVAL 2 MINUTE THEN ? ELSE j.status END AS status,j.created_at,j.error,j.items,j.printer_id,p.nombre AS impresora FROM print_jobs j JOIN printers p ON p.id=j.printer_id ORDER BY j.created_at DESC,j.id DESC LIMIT 50").all('claimed','uncertain')};
  throw new ApiError(404,'Ruta de impresión no encontrada');
}
