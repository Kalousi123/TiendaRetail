import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const root=process.env.RETAIL_TEST_APP;
if(!root?.includes('retail-tests-')||!process.env.DB_NAME?.startsWith('retail_test_'))throw new Error('Sandbox requerido');
const f=JSON.parse(readFileSync(join(root,'fixtures.json'),'utf8'));
const {db}=await import(pathToFileURL(join(root,'src/db.js')));
const base=`http://127.0.0.1:${process.argv[2]}`;let cookie='';let checks=0;
async function api(method,path,body,status=200,headers={}){
 const r=await fetch(base+path,{method,headers:{cookie,'content-type':'application/json',...headers},body:body===undefined?undefined:JSON.stringify(body)});
 if(r.headers.get('set-cookie'))cookie=r.headers.get('set-cookie').split(';')[0];
 const data=await r.json();assert.equal(r.status,status,JSON.stringify(data));checks++;return data;
}
const login=user=>api('POST','/api/login',{usuario:user,clave:'test1234'});
await login('admin');
const agent=await api('POST','/api/impresion/agentes',{nombre:'Test PC',sucursal_id:f.s1});
const auth={authorization:`Bearer ${agent.token}`};
await api('POST','/api/impresion/impresoras',{agent_id:agent.id,nombre:'Mala',queue_name:'Test',language:'ZPL',dpi:600},400);
const printer=await api('POST','/api/impresion/impresoras',{agent_id:agent.id,nombre:'Test USB',queue_name:'Test RAW',language:'ZPL',dpi:203});
const body={request_key:crypto.randomUUID(),printer_id:printer.id,items:[{producto_id:f.p1,copias:2}]};
const jobs=await Promise.all([api('POST','/api/impresion/trabajos',body),api('POST','/api/impresion/trabajos',body)]);
assert.equal(jobs[0].job.id,jobs[1].job.id);
await api('POST','/api/agent/poll',{},401);
const claimed=await api('POST','/api/agent/poll',{},200,auth);assert.match(claimed.job.payload,/\^XA/);assert.equal(claimed.job.queue_name,'Test RAW');
assert.equal((await api('POST','/api/agent/poll',{},200,auth)).job,null);
await api('POST',`/api/agent/jobs/${claimed.job.id}/ack`,{claim_token:'wrong',status:'submitted'},404,auth);
await api('POST',`/api/agent/jobs/${claimed.job.id}/ack`,{claim_token:claimed.job.claim_token,status:'submitted'},200,auth);
await api('POST',`/api/agent/jobs/${claimed.job.id}/ack`,{claim_token:claimed.job.claim_token,status:'submitted'},200,auth);
await api('POST','/api/impresion/trabajos',{...body,request_key:crypto.randomUUID()});
const lost=await api('POST','/api/agent/poll',{},200,auth);
await db.prepare('UPDATE print_jobs SET claimed_at=NOW() - INTERVAL 3 MINUTE WHERE id=?').run(lost.job.id);
assert.equal((await api('POST','/api/agent/poll',{},200,auth)).job,null);
assert.equal((await db.prepare('SELECT status FROM print_jobs WHERE id=?').get(lost.job.id)).status,'uncertain');
await api('DELETE',`/api/impresion/agentes/${agent.id}`);
await api('POST','/api/agent/poll',{},401,auth);
await login('tecnico');await api('GET','/api/impresion/config',undefined,403);
// ---- Etiquetas en PDF: el archivo lo arma el servidor, sin impresora ----
const pdfDeEtiqueta=async(query='')=>{const r=await fetch(base+`/api/impresion/etiquetas/${f.p1}/pdf`+query,{headers:{cookie}});return r;};
await login('admin');
const uno=await pdfDeEtiqueta();
assert.equal(uno.status,200);checks++;
assert.equal(uno.headers.get('content-type'),'application/pdf');
assert.match(uno.headers.get('content-disposition'),/^attachment; filename="etiqueta-990001\.pdf"$/);
const bytes=Buffer.from(await uno.arrayBuffer());
assert.equal(bytes.subarray(0,5).toString('latin1'),'%PDF-','debe salir un PDF de verdad, no un JSON de error');
assert.ok(bytes.length>500);
const hoja=await fetch(base+'/api/impresion/etiquetas/pdf',{method:'POST',headers:{cookie,'content-type':'application/json'},body:JSON.stringify({hoja:'a4',items:[{producto_id:f.p1,copias:3}]})});
assert.equal(hoja.status,200);checks++;
assert.match(hoja.headers.get('content-disposition'),/filename="etiquetas-\d{8}-\d{4}\.pdf"/);
assert.ok(Buffer.from(await hoja.arrayBuffer()).subarray(0,5).toString('latin1')==='%PDF-');
// Un producto sin código no tiene etiqueta que sacar, y uno que no existe tampoco.
const sinCodigo=Number((await db.prepare("INSERT INTO productos(codigo,nombre,precio,costo,stock) VALUES('SIN-BARRA','Sin barra',10,2,1)").run()).lastInsertRowid);
const pedir=(id,method,body)=>fetch(base+`/api/impresion/etiquetas${id}`,{method,headers:{cookie,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
assert.equal((await pedir('/99999999/pdf')).status,404);
assert.equal((await pedir(`/${sinCodigo}/pdf`)).status,400);
assert.equal((await pedir('/pdf','POST',{items:[{producto_id:f.p1,copias:0}]})).status,400);
assert.equal((await pedir('/pdf','POST',{items:[]})).status,400);
// Ver el catálogo no es editarlo: el técnico saca etiquetas aunque no pueda tocar impresoras.
await login('tecnico');
assert.equal((await pdfDeEtiqueta()).status,200);
assert.equal((await fetch(base+`/api/impresion/etiquetas/${f.p1}/pdf`)).status,401);
await login('admin');
// ---- Hojas de etiqueta: el servidor dice cuáles hay y cuánto cabe en cada una ----
const formatos=(await api('GET','/api/impresion/etiquetas/formatos')).formatos;
assert.deepEqual(formatos.map(x=>x.clave),['a4densa','avery','a4','etiqueta']);
/* La rejilla densa sale primero porque es la que imprime un catálogo entero; la
   de una en una queda al final. Las medidas de cada celda las comprueba la
   prueba unitaria contra el papel, aquí solo importa el contrato con la interfaz. */
assert.deepEqual(formatos.map(x=>x.porHoja),[10,21,2,1]);
assert.ok(formatos.every(x=>x.nombre&&x.clave),'cada formato se describe solo');
assert.match(formatos[0].nombre,/2 × 5 etiquetas de 100 × 50 mm · 10 por hoja/);
/* Ver el catálogo no es editarlo: el técnico que saca etiquetas tiene que poder
   leer los formatos, pero sin sesión no hay ni selector ni PDF. */
await login('tecnico');await api('GET','/api/impresion/etiquetas/formatos');
await login('admin');assert.equal((await fetch(base+'/api/impresion/etiquetas/formatos')).status,401);
// Una hoja que no existe no es un papel cualquiera.
await fetch(base+'/api/impresion/etiquetas/pdf',{method:'POST',headers:{cookie,'content-type':'application/json'},body:JSON.stringify({hoja:'inventada',items:[{producto_id:f.p1,copias:1}]})}).then(async r=>{assert.equal(r.status,400);assert.match((await r.json()).error,/Hoja desconocida/);checks++;});
// Sin hoja se elige la densa: once etiquetas son dos hojas de diez.
const porDefecto=await fetch(base+'/api/impresion/etiquetas/pdf',{method:'POST',headers:{cookie,'content-type':'application/json'},body:JSON.stringify({items:Array.from({length:11},()=>({producto_id:f.p1,copias:1}))})});
assert.equal(porDefecto.status,200);checks++;
assert.match(Buffer.from(await porDefecto.arrayBuffer()).toString('latin1'),/\/Count 2 >>/,'once etiquetas tienen que dar dos hojas');
// La hoja precortada también se arma con el mismo producto repetido.
const avery=await fetch(base+'/api/impresion/etiquetas/pdf',{method:'POST',headers:{cookie,'content-type':'application/json'},body:JSON.stringify({hoja:'avery',items:Array.from({length:21},()=>({producto_id:f.p1,copias:1}))})});
assert.equal(avery.status,200);checks++;
assert.match(Buffer.from(await avery.arrayBuffer()).toString('latin1'),/\/Count 1 >>/,'veintiuna etiquetas de la hoja de 3 × 7 caben en una hoja');
// ---- Nombres de producto: una sola mercadería por nombre, tildes y espacios no mandan ----
const alta={codigo:'AISLANTE',nombre:'Cinta Aislante',precio:10,costo:3,stock:5,unidad:'pza'};
const primero=(await api('POST','/api/productos',alta)).producto;
// El mismo nombre con otras mayúsculas, tildes y espacios sobrantes es el mismo producto.
const repetido=await api('POST','/api/productos',{...alta,codigo:'AISLANTE-2',nombre:'  CINTA   aislante  '},400);
assert.match(repetido.error,/AISLANTE/,'el error tiene que decir qué producto ocupa el nombre');
assert.match(repetido.error,/Cinta Aislante/);
assert.equal((await db.prepare("SELECT COUNT(*) AS c FROM productos WHERE nombre_clave='cinta aislante'").get()).c,1,'el nombre repetido no se guarda');
// Editar un producto sin tocarle el nombre no es un choque consigo mismo.
const mismo=await api('PUT',`/api/productos/${primero.id}`,{...alta,nombre:'cinta AISLANTE',precio:12});
assert.equal(mismo.producto.precio,12);
// Renombrar hacia el nombre de otro sí se rechaza, y dice cuál es.
const segundo=(await api('POST','/api/productos',{codigo:'CINTA-2',nombre:'Cinta Embalar',precio:5,costo:1,stock:1,unidad:'pza'})).producto;
await api('PUT',`/api/productos/${segundo.id}`,{codigo:'CINTA-2',nombre:'cinta aislante',precio:5,costo:1,stock:1,unidad:'pza'},400);
assert.equal((await db.prepare('SELECT nombre FROM productos WHERE id=?').get(segundo.id)).nombre,'Cinta Embalar');
// Un producto con ventas no se borra, se desactiva; su nombre sigue reservado.
await db.prepare('UPDATE productos SET activo=0 WHERE id=?').run(primero.id);
const archivado=await api('POST','/api/productos',{codigo:'AISLANTE-3',nombre:'Cinta Aislante',precio:10,costo:3,stock:1,unidad:'pza'},400);
assert.match(archivado.error,/archivado/,'el nombre de un producto archivado también está ocupado');
await db.prepare('UPDATE productos SET activo=1 WHERE id=?').run(primero.id);
// La base es la última línea: si alguien salta la validación, el índice lo frena.
await assert.rejects(()=>db.prepare("INSERT INTO productos(codigo,nombre,precio,costo,stock) VALUES('SIN-VALIDAR','cinta  aislante',10,3,1)").run(),/Duplicate entry/i,'el índice único es la garantía real');

await login('admin');
// Isolated installation: no delivery requirement obscures evidence checks.
const r=await db.prepare("INSERT INTO instalaciones(codigo,producto_nombre,sucursal_id,tecnico_id,estado) VALUES(?,?,?,?,'en_progreso')").run('EVIDENCE-TEST','Test',f.s1,f.users.tecnico);
const id=r.lastInsertRowid,path=`/api/instalaciones/${id}`;
await api('POST',path+'/estado',{estado:'completada'},400);
const image=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEklEQVQImWP438GAFWEXHbQSAHHCYcFWgAR9AAAAAElFTkSuQmCC','base64');
async function upload(data=image,type='image/png',status=200){const form=new FormData();form.append('foto',new Blob([data],{type}),'photo.png');const res=await fetch(base+path+'/evidencias',{method:'POST',headers:{cookie},body:form});const body=await res.json();assert.equal(res.status,status,JSON.stringify(body));checks++;return body;}
await upload(Buffer.from('not an image'),'image/png',400);
await upload(image,'text/plain',400);
await login('marco');await upload(image,'image/png',404);
await login('tecnico');const images=await upload();
await api('POST',path+'/estado',{estado:'completada',evidencias:[crypto.randomUUID()]},400);
assert.equal((await api('GET',path)).instalacion.estado,'en_progreso');
await api('POST',path+'/estado',{estado:'completada',evidencias:images.evidencias});
const detail=await api('GET',path);assert.equal(detail.instalacion.evidencias.length,1);
const url=detail.instalacion.evidencias[0].url;
let photo=await fetch(base+url,{headers:{cookie}});assert.equal(photo.status,200);assert.equal(photo.headers.get('content-type'),'image/jpeg');
await login('marco');photo=await fetch(base+url,{headers:{cookie}});assert.equal(photo.status,404);
// Conformity: the photo has to say who took it and when, or it proves nothing.
const ev=detail.instalacion.evidencias[0];
assert.ok(ev.created_at,'la evidencia debe traer created_at');
assert.ok(ev.empleado_nombre,'la evidencia debe traer empleado_nombre');
// Downloading gives a name that identifies the order; accents are dropped, not eaten.
await login('admin');
const saved=cookie;
const dl=await fetch(base+url+'?download=1',{headers:{cookie}});assert.equal(dl.status,200);
const disp=dl.headers.get('content-disposition');
assert.match(disp,/^attachment; filename="[A-Za-z0-9._-]+\.jpg"$/);
assert.ok(disp.includes('EVIDENCE-TEST'),disp);
assert.ok(Buffer.from(await dl.arrayBuffer()).length>0,'la descarga no puede venir vacía');
assert.equal(photo.headers.get('content-disposition'),null,'verla no debe forzarla a descargarse');
assert.equal((await fetch(base+url)).status,401);assert.equal((await fetch(base+url+'?download=1')).status,401);
cookie=saved;
const _dF = (await db.prepare("SELECT id FROM destinos_pago WHERE tipo='efectivo' AND activo=1 AND (sucursal_id IS NULL OR sucursal_id=?) LIMIT 1").get(f.s1));
// The list is what draws the camera badge, so it has to carry the count too.
const listed=(await api('GET',`/api/instalaciones?estado=completada`)).instalaciones.find(i=>i.id===id);
assert.equal(listed.evidencias.length,1);
// And the sale that produced the order must show it: that is where it is checked.
const saleId=Number((await db.prepare("INSERT INTO ventas(numero,empleado_id,sucursal_id,subtotal,total,costo_total,metodo_pago,monto_pagado,destino_id,referencia) VALUES('V-90001',?,?,?,?,?,?,?,?,?)").run(f.users.asesor,f.s1,10,10,1,'efectivo',10,_dF.id,'')).lastInsertRowid);
await db.prepare('UPDATE instalaciones SET venta_id=? WHERE id=?').run(saleId,id);
const inSale=(await api('GET',`/api/ventas/${saleId}`)).venta.instalaciones.find(i=>i.id===id);
assert.equal(inSale.evidencias.length,1);assert.equal(inSale.evidencias[0].empleado_nombre,ev.empleado_nombre);
// A numero given without a correlative must not reset the sequence: the next
// sale continues from the highest one, not from whatever row landed last.
const top=Math.max(0,...(await db.prepare('SELECT numero FROM ventas').all()).map(r=>{const m=String(r.numero).match(/(\d+)$/);return m?Number(m[1]):0;}));
await db.prepare("INSERT INTO ventas(numero,empleado_id,sucursal_id,subtotal,total,costo_total,metodo_pago,monto_pagado,destino_id,referencia) VALUES('V-SIN-CORRELATIVO',?,?,?,?,?,?,?,?,?)").run(f.users.asesor,f.s1,10,10,1,'efectivo',10,_dF.id,'');
const seguimiento=(await api('POST','/api/ventas',{items:[{producto_id:f.p1,cantidad:1}],sucursal_id:f.s1,metodo_pago:'efectivo',destino_id:_dF.id,monto_pagado:100})).venta.numero;
assert.equal(Number(seguimiento.replace(/\D/g,'')),top+1,'el correlativo debe seguir al más alto, no al último id');
// Serialized stock validation prevents concurrent sales from overselling.
await login('admin');
const product=await db.prepare("INSERT INTO productos(codigo,codigo_barras,nombre,precio,costo,stock) VALUES('RACE','98989898','Concurrency',10,2,1)").run();
const sale={items:[{producto_id:product.lastInsertRowid,cantidad:1}],sucursal_id:f.s1,metodo_pago:'efectivo',destino_id:_dF.id,monto_pagado:100};
const responses=await Promise.all([1,2].map(()=>fetch(base+'/api/ventas',{method:'POST',headers:{cookie,'content-type':'application/json'},body:JSON.stringify(sale)})));
const details=await Promise.all(responses.map(r=>r.json()));
assert.deepEqual(responses.map(r=>r.status).sort(),[200,400],JSON.stringify(details));
assert.equal((await db.prepare('SELECT stock FROM productos WHERE id=?').get(product.lastInsertRowid)).stock,0);

// ---- Destinos de pago: el metodo se deduce del destino, no del cliente ----
await login('admin');
const yape=(await api('POST','/api/destinos-pago',{nombre:'Yape Tienda',tipo:'yape',identificador:'999888777'}));
const yapeId=Number((await db.prepare('SELECT id FROM destinos_pago WHERE nombre=?').get('Yape Tienda')).id);
const caja1=_dF.id;
// El selector de caja solo ofrece el efectivo de la sucursal del empleado.
const selAsesor=await api('GET','/api/destinos-pago/select');
assert.ok(selAsesor.destinos.some(d=>Number(d.id)===caja1),'la caja de la sucursal debe estar en el selector');
assert.ok(selAsesor.destinos.some(d=>Number(d.id)===yapeId),'un destino global debe estar en el selector');
const activos=(await db.prepare('SELECT id FROM destinos_pago WHERE activo=1').all()).map(r=>Number(r.id));
assert.ok(selAsesor.destinos.every(d=>activos.includes(Number(d.id))),'el selector solo debe ofrecer destinos activos');
assert.ok(selAsesor.destinos.some(d=>d.sucursal_nombre),'el selector debe decir a que sucursal pertenece cada destino');
// Sin destino no hay venta: el efectivo ya no es un metodo por defecto.
const sinDestino={items:[{producto_id:f.p1,cantidad:1}],sucursal_id:f.s1,monto_pagado:100};
await api('POST','/api/ventas',sinDestino,400);
await api('POST','/api/ventas',{...sinDestino,destino_id:999999},400);
// Yape y transferencia exigen el numero de operacion.
await api('POST','/api/ventas',{...sinDestino,destino_id:yapeId},400);
const porYape=await api('POST','/api/ventas',{...sinDestino,destino_id:yapeId,referencia:'OP-9911'});
assert.equal(porYape.venta.metodo_pago,'yape','el metodo se deduce del destino');
assert.equal(porYape.venta.destino_nombre,'Yape Tienda');
assert.equal(porYape.venta.referencia,'OP-9911');
// El cliente no elige el metodo: un "efectivo" con destino Yape sigue siendo Yape.
const porYape2=await api('POST','/api/ventas',{...sinDestino,destino_id:yapeId,referencia:'OP-9912',metodo_pago:'efectivo'});
assert.equal(porYape2.venta.metodo_pago,'yape','el metodo enviado por el cliente no manda');
// El efectivo es de una sola tienda.
const cajaSur=(await db.prepare("SELECT id FROM destinos_pago WHERE tipo='efectivo' AND sucursal_id=? LIMIT 1").get(f.s2)).id;
await api('POST','/api/ventas',{...sinDestino,sucursal_id:f.s1,destino_id:cajaSur},400);
// Un destino desactivado no se puede usar, pero la venta vieja sigue legible.
await api('PUT',`/api/destinos-pago/${yapeId}`,{activo:0});
await api('POST','/api/ventas',{...sinDestino,destino_id:yapeId,referencia:'OP-9913'},400);
assert.ok(!(await api('GET','/api/destinos-pago/select')).destinos.some(d=>Number(d.id)===yapeId),'un destino desactivado no debe ofrecerse');
assert.equal((await api('GET',`/api/ventas/${porYape.venta.id}`)).venta.destino_nombre,'Yape Tienda','una venta vieja no se rompe al desactivar su destino');
// El efectivo tiene que estar atado a una sucursal, en alta y en edicion.
await api('POST','/api/destinos-pago',{nombre:'Caja Global',tipo:'efectivo'},400);
await api('PUT',`/api/destinos-pago/${yapeId}`,{nombre:'Yape Tienda',tipo:'efectivo',sucursal_id:null},400);
// "No" desactiva de verdad: el formulario manda "0" como texto, no como booleano.
await api('PUT',`/api/destinos-pago/${yapeId}`,{activo:'0'});
assert.equal((await db.prepare('SELECT activo FROM destinos_pago WHERE id=?').get(yapeId)).activo,0,'el texto "0" debe desactivar');
await api('PUT',`/api/destinos-pago/${yapeId}`,{activo:'1'});
assert.equal((await db.prepare('SELECT activo FROM destinos_pago WHERE id=?').get(yapeId)).activo,1);
// El ticket inmediato ya trae el destino: se imprime sin volver a consultarlo.
assert.equal(porYape.venta.destino_identificador,'999888777');
// En campo tambien: cada parte del saldo guarda su propio destino.
await login('tecnico');
const instPago=(await db.prepare("SELECT i.id FROM instalaciones i WHERE i.monto_financiado - i.adelanto - i.saldo_pagado > 0 AND i.sucursal_id=? AND i.tecnico_id=? AND i.estado IN ('en_progreso','completada') LIMIT 1").get(f.s1,f.users.tecnico));
if(instPago){
  await api('POST',`/api/instalaciones/${instPago.id}/cobro`,{monto:0.5},400);
  await api('POST',`/api/instalaciones/${instPago.id}/cobro`,{monto:0.5,destino_id:yapeId},400);
  const cobrado=await api('POST',`/api/instalaciones/${instPago.id}/cobro`,{monto:0.5,destino_id:yapeId,referencia:'CAMPO-1'});
  const ult=cobrado.instalacion.pagos.at(-1);
  assert.equal(ult.destino_nombre,'Yape Tienda');
  assert.equal(ult.referencia,'CAMPO-1');
  assert.equal(Number(ult.monto),0.5);
}
await db.close();console.log(`  ok nuevas funciones: ${checks} respuestas verificadas, idempotencia y concurrencia`);
