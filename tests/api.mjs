import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
const root=process.env.RETAIL_TEST_APP;
if (!root?.includes('retail-tests-')) throw new Error('Sandbox requerido');
const f=JSON.parse(readFileSync(join(root,'fixtures.json'),'utf8'));
const {db}=await import(pathToFileURL(join(root,'src/db.js')));
if (!process.env.DB_NAME?.startsWith('retail_test_')) throw new Error('Base de pruebas requerida');
const base=`http://127.0.0.1:${process.argv[2]}`;
let cookie='', lastSetCookie='', checks=0;
function check(name,condition) { assert.ok(condition,name); checks++; console.log(`  ok ${name}`); }
async function api(method,path,body,status=200) {
 const res=await fetch(base+path,{method,headers:{cookie,'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body)});
 if(res.headers.get('set-cookie')) { lastSetCookie=res.headers.get('set-cookie'); cookie=lastSetCookie.split(';')[0]; }
 const data=await res.json(); assert.equal(res.status,status,`${method} ${path}: ${JSON.stringify(data)}`); checks++;
 return data;
}
async function upload(id) {
 const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEklEQVQImWP438GAFWEXHbQSAHHCYcFWgAR9AAAAAElFTkSuQmCC','base64');
 const form=new FormData();form.append('fotos',new Blob([png],{type:'image/png'}),'foto.png');
 const r=await fetch(base+path(id)+'/evidencias',{method:'POST',headers:{cookie},body:form});
 const data=await r.json();assert.equal(r.status,200,JSON.stringify(data));return data.evidencias;
}
async function login(user) {
 cookie='';
 const result=await api('POST','/api/login',{usuario:user,clave:'test1234'});
 check('cookie de sesión compatible con el protocolo de la petición',lastSetCookie?.includes('Secure')===false);
 return result;
}
const path=id=>`/api/instalaciones/${id}`;
const detail=async id=>(await api('GET',path(id))).instalacion;
const scan=[{codigo:'990001',veces:2},{codigo:'990002',veces:4}];
async function snapshot(id) {
 return JSON.stringify({order:(await db.prepare('SELECT * FROM instalaciones WHERE id=?').get(id)),items:(await db.prepare('SELECT * FROM instalacion_items WHERE instalacion_id=?').all(id)),products:(await db.prepare('SELECT id,stock,stock_reservado FROM productos ORDER BY id').all()),history:(await db.prepare('SELECT * FROM instalacion_historial WHERE instalacion_id=?').all(id)),movements:(await db.prepare('SELECT * FROM movimientos ORDER BY id').all())});
}
await api('GET','/api/instalaciones',undefined,401);
const mirrorSource=readFileSync(join(root,'public/app.js'),'utf8').match(/const PERMISOS = (\{[\s\S]*?\n\});/)[1];
const mirror=runInNewContext('('+mirrorSource+')');
for(const role of ['admin','asesor','tecnico']) {
 const session=await login(role==='admin'?' ADMIN ':role);
 check(`permisos ${role} sincronizados`,JSON.stringify([...session.empleado.permisos].sort())===JSON.stringify([...mirror[role]].sort()));
}

await login('asesor');
const own=(await api('GET','/api/ventas?sucursal_id='+f.s2)).ventas;
check('ventas solo del asesor aunque cambie sucursal',own.length>0 && own.every(v=>v.empleado_id===f.users.asesor));
await api('GET',`/api/ventas/${f.sales.other}`,undefined,404);
await api('POST',`/api/ventas/${f.sales.own}/anular`,{},403);
await api('PATCH',path(f.orders.other),{direccion:'No'},404);
await api('POST',path(f.orders.flow)+'/entrega',{escaneos:scan},403);
await api('POST',path(f.orders.flow)+'/estado',{estado:'en_progreso'},403);
await api('POST',path(f.orders.flow)+'/cobro',{},403);
check('instalaciones solo de su tienda', (await api('GET','/api/instalaciones?sucursal_id='+f.s2)).instalaciones.every(i=>i.sucursal_id===f.s1));
await api('PATCH',path(f.orders.flow),{direccion:''},400);
const editBefore=(await snapshot(f.orders.flow));
await api('PATCH',path(f.orders.flow),{direccion:'No debe guardarse',tecnico_id:f.users.tecnico,fecha_programada:'2027-02-30',hora_programada:'10:00'},400);
check('edición conjunta inválida no guarda parcialmente',(await snapshot(f.orders.flow))===editBefore);
await api('PATCH',path(f.orders.flow),{direccion:'No debe guardarse',tecnico_id:f.users.asesor},400);
check('asignación inválida tampoco cambia datos',(await snapshot(f.orders.flow))===editBefore);
await api('PATCH',path(f.orders.flow),{direccion:'Nueva dirección',contacto:'555',notas:'Prueba',tecnico_id:f.users.tecnico,fecha_programada:'2027-02-28',hora_programada:'11:00'});
const edited=await detail(f.orders.flow);
check('edición guarda todos los campos juntos',edited.direccion==='Nueva dirección'&&edited.fecha_programada==='2027-02-28'&&edited.hora_programada==='11:00'&&edited.tecnico_id===f.users.tecnico);

const occupied=(await db.prepare('SELECT fecha_programada,hora_programada FROM instalaciones WHERE id=?').get(f.orders['ui-box']));
const flowBeforeConflict=(await snapshot(f.orders.flow));
await api('POST',path(f.orders.flow)+'/cita',occupied,409);
check('reprogramación ocupada no modifica la orden',(await snapshot(f.orders.flow))===flowBeforeConflict);
await api('PATCH',path(f.orders.flow),{direccion:'Cambio parcial inválido',...occupied},409);
check('edición con horario ocupado revierte todos los campos',(await snapshot(f.orders.flow))===flowBeforeConflict);
const freeOriginal=await detail(f.orders.free);
await api('PATCH',path(f.orders.free),occupied);
await api('POST',path(f.orders.free)+'/asignar',{tecnico_id:f.users.tecnico},409);
check('asignación a horario ocupado no guarda el técnico',(await detail(f.orders.free)).tecnico_id===null);
await api('PATCH',path(f.orders.free),{fecha_programada:freeOriginal.fecha_programada,hora_programada:freeOriginal.hora_programada});
await login('admin');
await api('PATCH',path(f.orders['ui-other']),occupied);
check('dos técnicos distintos pueden compartir horario', (await detail(f.orders['ui-other'])).fecha_programada===occupied.fecha_programada);
await api('POST',path(f.orders.cancelled)+'/estado',{estado:'pendiente'});
const pendingBeforeProgramar=await detail(f.orders.cancelled);
await api('POST',path(f.orders.cancelled)+'/estado',{estado:'programada',...occupied},409);
const pendingAfterProgramar=await detail(f.orders.cancelled);
check('cambiar a programada respeta el horario ocupado',pendingAfterProgramar.estado==='pendiente'&&pendingAfterProgramar.fecha_programada===pendingBeforeProgramar.fecha_programada);
await api('POST',path(f.orders.cancelled)+'/estado',{estado:'cancelada'});
await login('asesor');

await api('POST',path(f.orders.flow)+'/cita',{fecha_programada:'2026-10-10',hora_programada:'10:00'});
await api('POST',path(f.orders.flow)+'/asignar',{tecnico_id:f.users.tecnico});
await api('POST',path(f.orders.cancelled)+'/asignar',{tecnico_id:f.users.tecnico},400);
const date=(await db.prepare("SELECT DATE_FORMAT(CURDATE(), '%Y-%m-%d') AS d").get()).d;
const range=`desde=${date}&hasta=${date}`;
const report=await api('GET',`/api/reportes/ventas?${range}&sucursal_id=${f.s2}`);
const expected=(await db.prepare("SELECT COUNT(*) AS n FROM instalaciones WHERE sucursal_id=? AND estado='completada' AND date(fecha)=?").get(f.s1,date)).n;
check('reporte recorta instalaciones',report.instalaciones.n===expected);
check('reporte recorta gastos',report.resumen.gastos===(await db.prepare('SELECT COALESCE(SUM(monto),0) AS n FROM gastos_sucursal WHERE sucursal_id=? AND date(fecha)=?').get(f.s1,date)).n);
const gasto=await api('GET',`/api/gastos?${range}&categoria=luz&sucursal_id=${f.s2}`);
check('filtros combinados respetan sucursal',gasto.gastos.length>0 && gasto.gastos.every(g=>g.sucursal_id===f.s1&&g.categoria==='luz'));
await login('sin');
check('asesor sin sucursal conserva ventas propias',(await api('GET','/api/ventas')).ventas.some(v=>v.id===f.sales.none));
check('sin sucursal no hay instalaciones',(await api('GET','/api/instalaciones')).instalaciones.length===0);
await api('GET',path(f.orders.flow),undefined,404);
check('sin sucursal no hay reportes',(await api('GET',`/api/reportes/ventas?${range}`)).resumen.n_ventas===0);
const noG=await api('GET',`/api/gastos?${range}`);
check('sin sucursal no hay gastos ni alquileres',!noG.gastos.length&&!noG.alquileres.length);
const noD=await api('GET','/api/dashboard');
check('sin sucursal dashboard restringido',!noD.ultimasVentas.length&&!noD.utilidadSucursales.length&&noD.instalaciones.abiertas===0);
await login('tecnico');
check('técnico no recibe ventas en dashboard',!(await api('GET','/api/dashboard')).ultimasVentas.length);
await api('GET',path(f.orders.other),undefined,404);
await api('GET','/api/reportes/ventas',undefined,403);
check('solo órdenes propias o disponibles',(await api('GET','/api/instalaciones')).instalaciones.every(i=>!i.tecnico_id||i.tecnico_id===f.users.tecnico));
await api('PATCH',path(f.orders.flow),{notas:'No'},403);
await api('POST',path(f.orders.free)+'/entrega',{escaneos:scan},403);
await api('POST',path(f.orders.free)+'/tomar',{});
check('tomar programa y asigna',(await detail(f.orders.free)).tecnico_id===f.users.tecnico);
await api('POST',path(f.orders.flow)+'/cobro',{},400);
await api('POST',path(f.orders.flow)+'/estado',{estado:'cancelada'},400);
await api('POST',path(f.orders.flow)+'/estado',{estado:'en_progreso'},400);
const meterStock=(await db.prepare('SELECT stock FROM productos WHERE id=?').get(f.meter)).stock;
await api('POST',path(f.orders.meter)+'/entrega',{escaneos:[{codigo:'990005',veces:1}]});
check('medidor empaque de 4: un escaneo retira una unidad',(await db.prepare('SELECT stock FROM productos WHERE id=?').get(f.meter)).stock===meterStock-1);
check('el contenido del empaque sigue siendo 4',(await db.prepare('SELECT contenido FROM productos WHERE id=?').get(f.meter)).contenido===4);
const boxStock=(await db.prepare('SELECT stock FROM productos WHERE id=?').get(f.meter)).stock;
(await db.prepare('UPDATE productos SET contenido=8 WHERE id=?').run(f.meter));
await api('POST',path(f.orders['meter-box'])+'/entrega',{escaneos:[{codigo:'990005',veces:1}]});
const packedItem=(await db.prepare('SELECT cantidad_entregada,contenido_empaque FROM instalacion_items WHERE instalacion_id=?').get(f.orders['meter-box']));
check('una lectura retira la caja completa vendida (4 piezas)',(await db.prepare('SELECT stock FROM productos WHERE id=?').get(f.meter)).stock===boxStock-4);
check('el retiro usa el contenido guardado al vender',packedItem.contenido_empaque===4&&packedItem.cantidad_entregada===4);
(await db.prepare('UPDATE productos SET contenido=4 WHERE id=?').run(f.meter));
const piecesStock=(await db.prepare('SELECT stock FROM productos WHERE id=?').get(f.meter)).stock;
await api('POST',path(f.orders['meter-pieces'])+'/entrega',{escaneos:[{codigo:'990005',veces:1}]},400);
await api('POST',path(f.orders['meter-pieces'])+'/entrega',{escaneos:[{codigo:'990005',veces:4}]});
check('cuatro piezas sueltas requieren cuatro lecturas',(await db.prepare('SELECT stock FROM productos WHERE id=?').get(f.meter)).stock===piecesStock-4);

/* ---- Toggle por caja / por pieza ----
   El técnico puede elegir en el momento cuánto suma cada escaneo,
   independientemente de cómo se vendió el producto. */
const toggleStock=(await db.prepare('SELECT stock FROM productos WHERE id=?').get(f.meter)).stock;
await api('POST',path(f.orders['toggle-caja'])+'/entrega',{escaneos:[{codigo:'990005',veces:1,modo:'caja'}]});
check('modo caja: un escaneo retira la caja completa aunque se vendió por pieza',(await db.prepare('SELECT stock FROM productos WHERE id=?').get(f.meter)).stock===toggleStock-4);
const toggleStock2=(await db.prepare('SELECT stock FROM productos WHERE id=?').get(f.meter)).stock;
await api('POST',path(f.orders['toggle-pza'])+'/entrega',{escaneos:[{codigo:'990005',veces:1,modo:'pza'}]},400);
await api('POST',path(f.orders['toggle-pza'])+'/entrega',{escaneos:[{codigo:'990005',veces:4,modo:'pza'}]});
check('modo pieza: cuatro escaneos retiran cuatro piezas aunque se vendió por caja',(await db.prepare('SELECT stock FROM productos WHERE id=?').get(f.meter)).stock===toggleStock2-4);
const toggleStock3=(await db.prepare('SELECT stock FROM productos WHERE id=?').get(f.meter)).stock;
await api('POST',path(f.orders['toggle-mix'])+'/entrega',{escaneos:[{codigo:'990005',veces:1,modo:'caja'},{codigo:'990005',veces:2,modo:'pza'}]},400);
await api('POST',path(f.orders['toggle-mix'])+'/entrega',{escaneos:[{codigo:'990005',veces:1,modo:'caja'},{codigo:'990005',veces:1,modo:'pza'}]});
check('mixto: caja completa + una pieza suelta',(await db.prepare('SELECT stock FROM productos WHERE id=?').get(f.meter)).stock===toggleStock3-5);
const singleStock=(await db.prepare('SELECT stock FROM productos WHERE id=?').get(f.single)).stock;
await api('POST',path(f.orders['toggle-single'])+'/entrega',{escaneos:[{codigo:'990006',veces:1,modo:'caja'}]},400);
check('modo caja en producto sin contenido de empaque es rechazado',(await db.prepare('SELECT stock FROM productos WHERE id=?').get(f.single)).stock===singleStock);
const invalidStock=(await db.prepare('SELECT stock FROM productos WHERE id=?').get(f.meter)).stock;
await api('POST',path(f.orders['toggle-invalid'])+'/entrega',{escaneos:[{codigo:'990005',veces:1,modo:'invalido'}]},400);
check('modo inválido es rechazado',(await db.prepare('SELECT stock FROM productos WHERE id=?').get(f.meter)).stock===invalidStock);

/* ---- Escaneos mixtos del mismo producto ----
   El técnico puede cambiar de modo en medio del retiro. Cada escaneo debe
   contar según el modo que estaba activo en ese momento. */
const mixStock=(await db.prepare('SELECT stock FROM productos WHERE id=?').get(f.meter)).stock;
await api('POST',path(f.orders['toggle-mix-same'])+'/entrega',{escaneos:[
  {codigo:'990005',veces:1,modo:'pza'},
  {codigo:'990005',veces:1,modo:'pza'},
  {codigo:'990005',veces:1,modo:'caja'}
]});
check('mixto del mismo producto: 2 piezas + 1 caja (4) = 6 piezas',(await db.prepare('SELECT stock FROM productos WHERE id=?').get(f.meter)).stock===mixStock-6);
const mixItem=(await db.prepare('SELECT cantidad_entregada FROM instalacion_items WHERE instalacion_id=?').get(f.orders['toggle-mix-same']));
check('la línea queda con las 6 piezas registradas',mixItem.cantidad_entregada===6);

const before=(await snapshot(f.orders.flow));
for(const body of [{},{items:[]},{escaneos:[]},{escaneos:[{codigo:'990004',veces:1}]},{escaneos:[{codigo:'no-existe',veces:1}]},{escaneos:[{codigo:'990001',veces:1}]},{escaneos:[{codigo:'990001',veces:3},scan[1]]},...[-1,0,1.5,'2',null].map(veces=>({escaneos:[{codigo:'990001',veces},scan[1]]}))]) {
 await api('POST',path(f.orders.flow)+'/entrega',body,400);
 check('entrega inválida no altera datos',(await snapshot(f.orders.flow))===before);
}
const rb=(await snapshot(f.orders.rollback));
await api('POST',path(f.orders.rollback)+'/entrega',{escaneos:[scan[0],{codigo:'990003',veces:1}]},400);
check('stock insuficiente revierte también primera línea',(await snapshot(f.orders.rollback))===rb);
const stock=(await db.prepare('SELECT stock,stock_reservado FROM productos WHERE id=?').get(f.p1));
await api('POST',path(f.orders.flow)+'/entrega',{escaneos:scan});
let i=await detail(f.orders.flow);
check('entrega inicia ruta y restringe siguiente estado',i.estado==='en_ruta'&&i.puede_avanzar.join()==='en_progreso');
check('entrega descuenta stock y libera reserva',(await db.prepare('SELECT stock FROM productos WHERE id=?').get(f.p1)).stock===stock.stock-2&&(await db.prepare('SELECT stock_reservado FROM productos WHERE id=?').get(f.p1)).stock_reservado===stock.stock_reservado-2);
check('historial registra retiro y ruta',i.historial.slice(-2).map(h=>h.estado).join()==='material_retirado,en_ruta');
const done=(await snapshot(i.id));
await api('POST',path(i.id)+'/entrega',{escaneos:scan},400);
check('repetición no descuenta',(await snapshot(i.id))===done);
await api('POST',path(i.id)+'/estado',{estado:'completada'},400);
await api('POST',path(i.id)+'/estado',{estado:'en_progreso'});
const _d = (await db.prepare("SELECT id FROM destinos_pago WHERE tipo='efectivo' AND activo=1 LIMIT 1").get()); await api('POST',path(i.id)+'/cobro',{monto:20, destino_id:_d.id});
await api('POST',path(i.id)+'/cobro',{monto:80.01, destino_id:_d.id},400);
await api('POST',path(i.id)+'/estado',{estado:'completada',evidencias:await upload(i.id)});
check('completada mantiene cobro',(await detail(i.id)).acciones.includes('cobrar'));
await api('POST',path(i.id)+'/cobro',{destino_id:_d.id});
check('sin saldo desaparece cobro',!(await detail(i.id)).acciones.includes('cobrar'));
await api('POST',path(i.id)+'/cobro',{},400);
for(const key of ['empty','retired']) {
 const o=await detail(f.orders[key]);
 check(`${key} permite iniciar ruta sin escaneo`,o.puede_avanzar.join()==='en_ruta'&&!o.acciones.includes('entrega'));
 await api('POST',path(o.id)+'/estado',{estado:'en_ruta'});
}
const oldStock=(await db.prepare('SELECT stock FROM productos WHERE id=?').get(f.p1)).stock;
await api('POST',path(f.orders.legacy)+'/entrega',{escaneos:scan});
check('legacy no descuenta de nuevo',(await db.prepare('SELECT stock FROM productos WHERE id=?').get(f.p1)).stock===oldStock);
await login('admin');
await api('POST',path(f.orders.manual)+'/entrega',{});
check('admin conserva regularización manual',(await detail(f.orders.manual)).estado==='en_ruta');
const closed=await detail(f.orders.closed);
check('admin no anuncia edición cerrada',!closed.acciones.includes('editar')&&!closed.acciones.includes('asignar')&&closed.acciones.includes('cobrar'));
const history=await api('GET',`/api/inventario/movimientos?producto_id=${f.p1}`);
check('historial filtra producto',history.movimientos.length>0&&history.movimientos.every(m=>m.producto_id===f.p1));
// Comparison across all financial responses, using independently scoped DB values.
await login('asesor');
for(const endpoint of ['ventas','productos',`producto/${f.p1}`]) await api('GET',`/api/reportes/${endpoint}?${range}&sucursal_id=${f.s2}`);
await login('marco');
await api('GET',path(f.orders.flow),undefined,404);
check('segundo técnico ve su orden',(await detail(f.orders.other)).tecnico_id===f.users.marco);
// Exercise a new sale through the public API, including reservation and payment.
await login('asesor');
const client=(await db.prepare('SELECT id FROM clientes WHERE activo=1 LIMIT 1').get()).id;
await login('asesor');
const salesBeforeConflict=(await db.prepare('SELECT COUNT(*) AS n FROM ventas').get()).n;
await api('POST','/api/ventas',{
 items:[{producto_id:f.meter,cantidad:4,modo_retiro:'caja'}],cliente_id:client,metodo_pago:'efectivo',destino_id:_d.id,monto_pagado:10,
 instalacion:{precio:30,adelanto:10,tecnico_id:f.users.tecnico,direccion:'Horario ocupado',fecha_programada:occupied.fecha_programada,hora_programada:occupied.hora_programada},
},409);
check('venta que choca con horario ocupado se revierte completa',(await db.prepare('SELECT COUNT(*) AS n FROM ventas').get()).n===salesBeforeConflict);
const stockBefore=(await db.prepare('SELECT stock,stock_reservado FROM productos WHERE id=?').get(f.p1));
const created=await api('POST','/api/ventas',{
 items:[{producto_id:f.p1,cantidad:2}],cliente_id:client,metodo_pago:'efectivo',destino_id:_d.id,monto_pagado:10,
 instalacion:{precio:30,adelanto:10,tecnico_id:f.users.tecnico,direccion:'Visita desde venta',fecha_programada:date,hora_programada:'10:00'},
});
const createdId=created.venta.instalaciones[0].id;
const stockReserved=(await db.prepare('SELECT stock,stock_reservado FROM productos WHERE id=?').get(f.p1));
check('venta reserva material sin descontar stock',stockReserved.stock===stockBefore.stock&&stockReserved.stock_reservado===stockBefore.stock_reservado+2);
check('venta devuelve acciones de oficina',created.venta.instalaciones[0].acciones.includes('editar'));
await login('tecnico');
await api('POST',path(createdId)+'/entrega',{escaneos:[scan[0]]});
await api('POST',path(createdId)+'/estado',{estado:'en_progreso'});
await api('POST',path(createdId)+'/estado',{estado:'completada',evidencias:await upload(createdId)});
await api('POST',path(createdId)+'/cobro',{destino_id:_d.id});
check('venta nueva termina entregada, completada y pagada',(await detail(createdId)).saldo_pendiente===0);
await login('asesor');
const boxedSale=await api('POST','/api/ventas',{
 items:[{producto_id:f.meter,cantidad:4,modo_retiro:'caja'}],cliente_id:client,metodo_pago:'efectivo',destino_id:_d.id,monto_pagado:10,
 instalacion:{precio:30,adelanto:10,tecnico_id:f.users.tecnico,direccion:'Visita por caja',fecha_programada:date,hora_programada:'11:00'},
});
const boxedOrder=boxedSale.venta.instalaciones[0];
check('checkout conserva caja y contenido en la orden',boxedOrder.items.some(it=>it.producto_id===f.meter&&it.cantidad_prevista===4&&it.modo_retiro==='caja'&&it.contenido_empaque===4));
await login('tecnico');
const boxedStockBefore=(await db.prepare('SELECT stock FROM productos WHERE id=?').get(f.meter)).stock;
await api('POST',path(boxedOrder.id)+'/entrega',{escaneos:[{codigo:'990005',veces:1}]});
check('una lectura de la caja descuenta cuatro unidades',(await db.prepare('SELECT stock FROM productos WHERE id=?').get(f.meter)).stock===boxedStockBefore-4);
await login('norte');
await login('norte');
const _dN = (await db.prepare("SELECT id FROM destinos_pago WHERE tipo='efectivo' AND activo=1 AND (sucursal_id IS NULL OR sucursal_id=?) LIMIT 1").get(f.s2));
const regularSale=await api('POST','/api/ventas',{items:[{producto_id:f.extra,cantidad:1}],metodo_pago:'efectivo',destino_id:_dN.id,monto_pagado:100});
check('venta sin instalación no crea orden para el técnico',regularSale.instalaciones===0&&regularSale.venta.instalaciones.length===0);
const northSale=regularSale.venta;
check('ticket inmediato trae datos de la sucursal de venta',northSale.sucursal_id===f.s2&&northSale.sucursal_direccion==='Calle Norte 789'&&northSale.sucursal_telefono==='555-789');
await login('admin');
const reprint=(await api('GET',`/api/ventas/${northSale.id}/ticket`)).venta;
check('reimpresión por admin conserva la sucursal de venta',reprint.sucursal_nombre===northSale.sucursal_nombre&&reprint.sucursal_direccion===northSale.sucursal_direccion&&reprint.sucursal_telefono===northSale.sucursal_telefono);
const product=(await api('GET','/api/productos')).productos.find(p=>p.id===f.extra);
await api('PUT',`/api/productos/${product.id}`,{...product,nombre:'Producto editado por admin'});
check('admin puede modificar productos',(await api('GET','/api/productos')).productos.find(p=>p.id===product.id).nombre==='Producto editado por admin');
for(const user of ['asesor','tecnico']) {
 await login(user);
 await api('PUT',`/api/productos/${product.id}`,{...product,nombre:'No permitido'},403);
}
(await db.close());
console.log(`API OK — ${checks} comprobaciones`);
