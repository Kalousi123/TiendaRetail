import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { writeFileSync } from 'node:fs';
const root = process.env.RETAIL_TEST_APP;
if (!root || !resolve(root).startsWith(join(tmpdir(), 'retail-tests-'))) throw new Error('Se requiere sandbox');
const { db, hashPassword } = await import(pathToFileURL(join(root, 'src/db.js')));
const hash = hashPassword('test1234');
(await db.prepare('UPDATE empleados SET clave_hash=?').run(hash));
const users = Object.fromEntries((await db.prepare('SELECT * FROM empleados').all()).map(e => [e.usuario, e]));
const s1 = users.asesor.sucursal_id, s2 = users.marco.sucursal_id;
async function user(name, branch) {
  return Number((await db.prepare("INSERT INTO empleados(nombre,usuario,clave_hash,rol,sucursal_id) VALUES(?,?,?,'asesor',?)").run(name,name,hash,branch)).lastInsertRowid);
}
users.otro = { id: (await user('otro', s1)) };
users.sin = { id: (await user('sin', null)) };
users.norte = { id: (await user('norte', s2)) };
async function product(code, content=1, stock=100) {
  return Number((await db.prepare('INSERT INTO productos(codigo,codigo_barras,nombre,precio,costo,stock,contenido) VALUES(?,?,?,?,?,?,?)')
    .run(code, code, `Prueba ${code}`,10,2,stock,content)).lastInsertRowid);
}
const meter=(await product('990005',4));
const single=(await product('990006',1));
const p1=(await product('990001')), p2=(await product('990002',2)), poor=(await product('990003',1,0)), extra=(await product('990004'));
const orders={};
async function order(name, {branch=s1, tech=users.tecnico.id, status='programada', items=[[p1,2],[p2,4]], legacy=false, delivered=false, mode='pza', pack=1, date=null, time='09:00'}={}) {
  const dayOffset=Object.keys(orders).length;
  const id=Number((await db.prepare(`INSERT INTO instalaciones(codigo,producto_nombre,sucursal_id,tecnico_id,asesor_id,direccion,estado,costo,monto_financiado,reserva_stock,fecha_programada,hora_programada)
    VALUES(?,?,?,?,?,'Calle de prueba',?,30,100,?,COALESCE(?,DATE_FORMAT(DATE_ADD(CURDATE(), INTERVAL ? DAY), '%Y-%m-%d')),?)`).run(`TEST-${name}-${10000+dayOffset}`,name,branch,tech,users.asesor.id,status,legacy?0:1,date,dayOffset,time)).lastInsertRowid);
  for(const [pid,qty] of items) {
    (await db.prepare(`INSERT INTO instalacion_items(instalacion_id,producto_id,nombre,cantidad_prevista,modo_retiro,contenido_empaque,cantidad_entregada,fecha_entrega) VALUES(?,?,?,?,?,?,?,?)`)
      .run(id,pid,`Prueba ${pid}`,qty,mode,pack,delivered?qty:0,delivered?'2026-01-01':''));
    if(!legacy && !delivered) (await db.prepare('UPDATE productos SET stock_reservado=stock_reservado+? WHERE id=?').run(qty,pid));
  }
  orders[name]=id; return id;
}
(await order('meter',{items:[[meter,1]]})); (await order('meter-box',{items:[[meter,4]],mode:'caja',pack:4}));
(await order('meter-pieces',{items:[[meter,4]],mode:'pza',pack:4}));
(await order('meter-mix',{items:[[meter,5]],mode:'caja',pack:4}));
(await order('toggle-caja',{items:[[meter,4]],mode:'pza',pack:4}));
(await order('toggle-pza',{items:[[meter,4]],mode:'caja',pack:4}));
(await order('toggle-mix',{items:[[meter,5]],mode:'caja',pack:4}));
(await order('toggle-single',{items:[[single,1]],mode:'pza',pack:1}));
(await order('toggle-invalid',{items:[[meter,4]],mode:'pza',pack:4}));
(await order('toggle-mix-same',{items:[[meter,6]],mode:'caja',pack:4}));
(await order('ui-meter',{items:[[meter,1]]})); (await order('ui-box',{items:[[meter,4]],mode:'caja',pack:4}));
(await order('flow')); (await order('rollback',{items:[[p1,2],[poor,1]]})); (await order('manual'));
(await order('legacy',{legacy:true})); (await order('empty',{items:[]}));
(await order('retired',{status:'material_retirado',legacy:true,delivered:true}));
(await order('other',{branch:s2,tech:users.marco.id})); (await order('free',{tech:null,status:'pendiente'}));
(await order('closed',{status:'completada',items:[]}));
(await order('closed-north',{branch:s2,tech:users.marco.id,status:'completada',items:[]}));
for (const [branch,monto] of [[s1,123.45],[s2,678.90]]) {
  (await db.prepare("INSERT INTO gastos_sucursal(sucursal_id,categoria,concepto,monto,fecha,mes_cobro,empleado_id) VALUES(?,'luz','Prueba alcance',?,CURDATE(),DATE_FORMAT(NOW(), '%Y-%m'),?)").run(branch,monto,users.admin.id));
} (await order('cancelled',{status:'cancelada',items:[]}));
(await order('ui',{tech:null,status:'pendiente'})); (await order('ui-empty',{tech:null,status:'pendiente',items:[]}));
(await order('ui-other',{tech:users.marco.id}));
(await order('ui-overdue',{tech:users.marco.id,status:'programada',date:'2020-01-01'}));
let saleNumber=10000;
async function sale(employee, branch, total) {
  return Number((await db.prepare(`INSERT INTO ventas(numero,empleado_id,sucursal_id,subtotal,total,costo_total,metodo_pago,monto_pagado) VALUES(?,?,?,?,?,1,'efectivo',?)`)
    .run(`V-${++saleNumber}`,employee,branch,total,total,total)).lastInsertRowid);
}
const sales={own:(await sale(users.asesor.id,s1,11)),other:(await sale(users.otro.id,s1,22)),north:(await sale(users.norte.id,s2,33)),none:(await sale(users.sin.id,s1,44))};
(await db.prepare("UPDATE sucursales SET direccion='Calle Norte 789',telefono='555-789' WHERE id=?").run(s2));
(await db.prepare("UPDATE configuracion SET valor='Sucursal principal genérica' WHERE clave='direccion'").run());
const fixture={s1,s2,users:Object.fromEntries(Object.entries(users).map(([k,v])=>[k,v.id])),p1,p2,poor,extra,meter,single,orders,sales};
writeFileSync(join(root,'fixtures.json'),JSON.stringify(fixture));
(await db.close());
