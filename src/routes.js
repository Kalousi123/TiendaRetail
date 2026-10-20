import { db, round2, getConfig, getAllConfig, sigNumero, sigCodigoProducto, sigCodigoBarras, normalizarCodigoBarras, normalizarNombre, verifyPassword, hashPassword, ahora, ESTADOS_INSTALACION } from './db.js';
import { createSession, destroySession, COOKIE_NAME } from './auth.js';

function finDeMes(mes) {
  const [a, m] = mes.split('-').map(Number);
  return `${mes}-${String(new Date(a, m, 0).getDate()).padStart(2, '0')}`;
}

function hoyISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function haceDias(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/* =====================================================================
   Permisos por rol. El admin tiene acceso total; los demás roles
   declaran explícitamente qué módulos pueden usar.
   ===================================================================== */
const PERMISOS = {
  admin: ['*'],
  asesor: [
    'dashboard:ver',
    'pos:usar', 'ventas:crear', 'ventas:ver',
    'productos:ver', 'clientes:ver', 'clientes:editar',
    'instalaciones:ver', 'instalaciones:crear', 'instalaciones:editar',
    'reportes:ver', 'sucursales:ver', 'empleados:tecnicos',
    /* El asesor ve lo que se gasta en la tienda donde trabaja, pero no lo
       registra: los pagos los hace el dueño o el administrador. */
    'gastos:ver',
  ],
  tecnico: [
    'dashboard:ver',
    'productos:ver',
    'instalaciones:ver', 'instalaciones:gestionar',
    'sucursales:ver',
  ],
};

export function puedeAcceder(empleado, permiso) {
  if (!empleado) return false;
  const lista = PERMISOS[empleado.rol] || [];
  return lista.includes('*') || lista.includes(permiso);
}

/* Lo que ve la pantalla sale de aquí y no de una lista copiada en el cliente:
   se manda la lista real del rol en cada sesión, así el menú nunca promete una
   acción que la API vaya a negar con un 403, ni esconde una que sí permitiría. */
function sessionDe(e) {
  return {
    id: e.id, nombre: e.nombre, usuario: e.usuario, rol: e.rol,
    sucursal_id: e.sucursal_id, sucursal_nombre: e.sucursal_nombre,
    permisos: PERMISOS[e.rol] || [],
  };
}

function exigir(empleado, permiso) {
  if (!empleado) throw new ApiError(401, 'No autorizado');
  if (!puedeAcceder(empleado, permiso)) throw new ApiError(403, 'Sin permisos para esta acción');
}

/* Elegir dónde se cobró no es "ver ventas": el técnico cobra en campo y no
   tiene permiso de ventas, pero sí necesita las cajas y cuentas de su
   sucursal. Se acepta cualquiera de los dos permisos. */
function exigirVerDestinos(empleado) {
  if (!empleado) throw new ApiError(401, 'No autorizado');
  if (puedeAcceder(empleado, 'ventas:ver') || puedeAcceder(empleado, 'instalaciones:gestionar')) return;
  throw new ApiError(403, 'Sin permisos para esta acción');
}

/* Un técnico solo opera sobre las órdenes que tiene asignadas. */
function exigirTecnicoDe(empleado, instalacion) {
  if (empleado.rol === 'admin') return;
  if (empleado.rol !== 'tecnico' || instalacion.tecnico_id !== empleado.id) {
    throw new ApiError(403, 'Solo puedes gestionar las órdenes que tienes asignadas');
  }
}

/* =====================================================================
   ÁMBITO POR ROL
   ---------------------------------------------------------------------
   Los permisos dicen si un rol puede abrir un módulo, pero no de qué datos
   tiene derecho a ver. Eso se decide aparte, acá, y se fuerza en el servidor:
   si el recorte dependiera de lo que el cliente manda en el filtro, bastaría
   con editar la URL para ver las ventas de otra tienda.

     ventas         asesor -> sólo lo que él facturó (no lo de su compañero,
                               aunque sea de la misma sucursal)
     instalaciones  asesor -> su sucursal
                     técnico -> sus órdenes y las que están sin asignar
     reportes       asesor -> su sucursal (es el número de la tienda, no el
                               del vendedor)
   El admin no se recorta: ve todo, que es para lo que existe.

   Devuelve un fragmento SQL y los argumentos que lo acompañan, para poder
   pegarlo tal cual en el WHERE de cualquier consulta.
   ===================================================================== */
function ambitoVentas(empleado, alias = 'v') {
  if (empleado.rol === 'tecnico') return { sql: ' AND 0=1', args: [] };
  if (empleado.rol !== 'asesor') return { sql: '', args: [] };
  return { sql: ` AND ${alias}.empleado_id = ?`, args: [empleado.id] };
}

function ambitoInstalaciones(empleado, alias = 'i') {
  if (empleado.rol === 'asesor') {
    if (!empleado.sucursal_id) return { sql: ' AND 0=1', args: [] };
    return { sql: ` AND ${alias}.sucursal_id = ?`, args: [empleado.sucursal_id] };
  }
  if (empleado.rol === 'tecnico') {
    /* Las sin técnico también se ven: es el tablero de trabajo pendiente de
       repartir. Lo que no se ve es la orden de otro técnico. */
    return { sql: ` AND (${alias}.tecnico_id = ? OR ${alias}.tecnico_id IS NULL)`, args: [empleado.id] };
  }
  return { sql: '', args: [] };
}

function ambitoSucursal(empleado, alias = '') {
  const pre = alias ? `${alias}.` : '';
  if (empleado.rol !== 'asesor') return { sql: '', args: [] };
  if (!empleado.sucursal_id) return { sql: ' AND 0=1', args: [] };
  return { sql: ` AND ${pre}sucursal_id = ?`, args: [empleado.sucursal_id] };
}

/* ¿Esta orden es visible para quien la está pidiendo? */
function puedeVerInstalacion(empleado, inst) {
  if (empleado.rol === 'admin') return true;
  if (empleado.rol === 'tecnico') return !inst.tecnico_id || inst.tecnico_id === empleado.id;
  return Boolean(empleado.sucursal_id) && inst.sucursal_id === empleado.sucursal_id;
}

const LIST_CAT = 'SELECT * FROM categorias ORDER BY nombre';
const CAT_ONE = 'SELECT * FROM categorias WHERE id = ?';
const LIST_CAT_SEL = 'SELECT id, nombre FROM categorias ORDER BY nombre';
const SUC_ONE = 'SELECT * FROM sucursales WHERE id = ?';
const LIST_SUC = 'SELECT * FROM sucursales ORDER BY nombre';
const LIST_SUC_SEL = 'SELECT id, codigo, nombre FROM sucursales WHERE activo = 1 ORDER BY nombre';

/* Lo que sale de cada tienda. El alquiler tiene categoría propia porque es el
   único que se compara contra un monto pactado y genera aviso si no se pagó. */
const CATEGORIAS_GASTO = ['alquiler', 'luz', 'agua', 'internet', 'telefono',
  'mantenimiento', 'transporte', 'publicidad', 'impuestos', 'otros'];

const GASTO_SELECT = `
  SELECT g.*, s.nombre AS sucursal_nombre, s.codigo AS sucursal_codigo,
         s.alquiler_mensual, e.nombre AS empleado_nombre
  FROM gastos_sucursal g
  LEFT JOIN sucursales s ON s.id = g.sucursal_id
  LEFT JOIN empleados e ON e.id = g.empleado_id`;

/* El gasto de una sucursal en un mes, para contrastarlo con el alquiler pactado.
   Los pagos se imputan a `mes_cobro`, no a la fecha de pago: pagar el alquiler
   el día 5 no lo convierte en gasto de mayo. */
async function alquilerPendiente(sucursal, mes) {
  if (!sucursal.alquiler_mensual) return null;
  const pagado = (await db.prepare(
    "SELECT COALESCE(SUM(monto),0) AS m FROM gastos_sucursal WHERE sucursal_id = ? AND categoria = 'alquiler' AND mes_cobro = ?")
    .get(sucursal.id, mes)).m;
  return {
    sucursal_id: sucursal.id,
    sucursal_nombre: sucursal.nombre,
    mes,
    pactado: round2(sucursal.alquiler_mensual),
    pagado: round2(pagado),
    pendiente: round2(sucursal.alquiler_mensual - pagado),
    dia: sucursal.dia_alquiler || 0,
    propietario: sucursal.propietario_nombre || '',
  };
}

const PRODUCT_SELECT = `
  SELECT p.*, c.nombre AS categoria_nombre
  FROM productos p
  LEFT JOIN categorias c ON c.id = p.categoria_id`;

const CLIENTE_SELECT = `
  SELECT c.*, (SELECT COUNT(*) FROM ventas v WHERE v.cliente_id = c.id AND v.estado = 'completada') AS total_compras,
         (SELECT COALESCE(SUM(v.total),0) FROM ventas v WHERE v.cliente_id = c.id AND v.estado = 'completada') AS total_comprado
  FROM clientes c`;

const INSTALACION_SELECT = `
  SELECT i.*, c.nombre AS cliente_nombre, c.telefono AS cliente_telefono,
         su.nombre AS sucursal_nombre, su.codigo AS sucursal_codigo,
         t.nombre AS tecnico_nombre, a.nombre AS asesor_nombre, p.codigo AS producto_codigo,
         v.numero AS venta_numero,
         ROUND(i.monto_financiado - i.adelanto - i.saldo_pagado, 2) AS saldo_pendiente
  FROM instalaciones i
  LEFT JOIN clientes c ON c.id = i.cliente_id
  LEFT JOIN sucursales su ON su.id = i.sucursal_id
  LEFT JOIN empleados t ON t.id = i.tecnico_id
  LEFT JOIN empleados a ON a.id = i.asesor_id
  LEFT JOIN productos p ON p.id = i.producto_id
  LEFT JOIN ventas v ON v.id = i.venta_id`;

/* La venta de una instalación lleva esta línea de servicio. No apunta a un
   producto: la orden cubre la visita completa, no un artículo suelto. */
const SERVICIO_INSTALACION = 'Instalación a domicilio';

/* Transiciones válidas del ciclo de vida de una orden de instalación. */
/* El recorrido de la mercadería: se reserva al vender, sale del almacén cuando
   el técnico la retira, viaja, se instala y termina. Saltar de programada a
   en_progreso se permite para las visitas que no llevan material, y en_ruta es
   un marcador opcional. Volver atrás no tiene sentido: la mercadería ya salió. */
const TRANSICIONES = {
  pendiente: ['programada', 'cancelada'],
  programada: ['material_retirado', 'en_ruta', 'en_progreso', 'cancelada'],
  material_retirado: ['en_ruta', 'en_progreso', 'cancelada'],
  en_ruta: ['en_progreso', 'cancelada'],
  en_progreso: ['completada', 'cancelada'],
  completada: [],
  cancelada: ['pendiente'],
};

async function handler(method, path, body, empleado, setCookie) {
  const seg = path.replace(/^\/+/, '').split('/').filter(Boolean);

  if (method === 'POST' && path === '/api/login') {
    const { usuario, clave } = body || {};
    const e = (await db.prepare(`
      SELECT e.*, su.nombre AS sucursal_nombre
      FROM empleados e LEFT JOIN sucursales su ON su.id = e.sucursal_id
      WHERE e.usuario = ? AND e.activo = 1`).get(String(usuario || '').trim().toLowerCase()));
    if (!e || !verifyPassword(String(clave || ''), e.clave_hash)) {
      throw new ApiError(401, 'Usuario o contraseña incorrectos');
    }
    const token = createSession(e.id);
    setCookie(`${COOKIE_NAME}=${token}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=43200`);
    return { empleado: sessionDe(e) };
  }

  if (path === '/api/me') {
    if (!empleado) throw new ApiError(401, 'No autorizado');
    return { empleado: sessionDe(empleado) };
  }

  if (method === 'POST' && path === '/api/logout') {
    destroySession(body?.token || '');
    return { ok: true };
  }

  if (!empleado) throw new ApiError(401, 'No autorizado');

  /* ---------------- CATEGORÍAS ---------------- */
  if (path === '/api/categorias' && method === 'GET') {
    exigir(empleado, 'productos:ver');
    return { categorias: (await db.prepare(LIST_CAT).all()) };
  }
  if (path === '/api/categorias/select' && method === 'GET') {
    exigir(empleado, 'productos:ver');
    return { categorias: (await db.prepare(LIST_CAT_SEL).all()) };
  }
  if (path === '/api/categorias' && method === 'POST') {
    exigir(empleado, 'categorias:gestionar');
    if (!body.nombre) throw new ApiError(400, 'El nombre es obligatorio');
    const nombre = String(body.nombre).trim();
    if (!nombre) throw new ApiError(400, 'El nombre es obligatorio');
    if ((await db.prepare('SELECT 1 FROM categorias WHERE LOWER(nombre) = LOWER(?)').get(nombre))) {
      throw new ApiError(400, `Ya existe una categoría llamada "${nombre}"`);
    }
    const r = (await db.prepare('INSERT INTO categorias(nombre, descripcion) VALUES(?,?)').run(nombre, body.descripcion || ''));
    return { categoria: (await db.prepare(CAT_ONE).get(Number(r.lastInsertRowid))) };
  }
  if (seg[0] === 'api' && seg[1] === 'categorias' && seg[2]) {
    exigir(empleado, 'categorias:gestionar');
    const id = Number(seg[2]);
    if (method === 'PUT') {
      if (!body.nombre) throw new ApiError(400, 'El nombre es obligatorio');
      const nombre = String(body.nombre).trim();
      if (!nombre) throw new ApiError(400, 'El nombre es obligatorio');
      if ((await db.prepare('SELECT 1 FROM categorias WHERE LOWER(nombre) = LOWER(?) AND id <> ?').get(nombre, id))) {
        throw new ApiError(400, `Ya existe una categoría llamada "${nombre}"`);
      }
      (await db.prepare('UPDATE categorias SET nombre = ?, descripcion = ? WHERE id = ?').run(nombre, body.descripcion || '', id));
      return { categoria: (await db.prepare(CAT_ONE).get(id)) };
    }
    if (method === 'DELETE') {
      const usados = (await db.prepare('SELECT COUNT(*) AS c FROM productos WHERE categoria_id = ?').get(id));
      if (usados.c > 0) throw new ApiError(400, 'No se puede eliminar: tiene productos asignados');
      (await db.prepare('DELETE FROM categorias WHERE id = ?').run(id));
      return { ok: true };
    }
  }

  // ---------------- SUCURSALES ----------------
  if (path === '/api/sucursales' && method === 'GET') {
    exigir(empleado, 'sucursales:ver');
    return { sucursales: (await db.prepare(LIST_SUC).all()) };
  }
  if (path === '/api/sucursales/select' && method === 'GET') {
    exigir(empleado, 'sucursales:ver');
    return { sucursales: (await db.prepare(LIST_SUC_SEL).all()) };
  }
  if (path === '/api/sucursales' && method === 'POST') {
    exigir(empleado, 'config:gestionar');
    return (await crearSucursal(body));
  }
  if (seg[0] === 'api' && seg[1] === 'sucursales' && seg[2]) {
    exigir(empleado, 'config:gestionar');
    const id = Number(seg[2]);
    const me = (await db.prepare('SELECT * FROM sucursales WHERE id = ?').get(id));
    if (!me) throw new ApiError(404, 'Sucursal no encontrada');
    if (method === 'PUT') return (await actualizarSucursal(id, body, me));
    if (method === 'DELETE') {
      /* Ninguna sucursal se marca como principal: lo que no puede ocurrir es
         quedarse sin ninguna, porque las ventas, los empleados y las órdenes
         de instalación se clasifican por sucursal. */
      const activas = (await db.prepare('SELECT COUNT(*) AS c FROM sucursales WHERE activo = 1').get()).c;
      if (me.activo && activas <= 1) {
        throw new ApiError(400, 'No se puede eliminar: es la última sucursal activa');
      }
      const empleados = (await db.prepare('SELECT COUNT(*) AS c FROM empleados WHERE sucursal_id = ?').get(id)).c;
      if (empleados > 0) throw new ApiError(400, `No se puede eliminar: tiene ${empleados} empleado(s) asignado(s)`);
      (await db.prepare('DELETE FROM sucursales WHERE id = ?').run(id));
      return { ok: true };
    }
  }

// ---------------- DESTINOS DE PAGO ----------------
if (path === '/api/destinos-pago' && method === 'GET') {
  exigir(empleado, 'config:ver');
  const activo = body?.activo;
  let sql = 'SELECT d.*, s.nombre AS sucursal_nombre FROM destinos_pago d LEFT JOIN sucursales s ON s.id = d.sucursal_id';
  const args = [];
  if (activo !== undefined && activo !== null && activo !== '') {
    sql += ' WHERE d.activo = ?';
    args.push(Number(activo) ? 1 : 0);
  }
  sql += ' ORDER BY d.activo DESC, d.sucursal_id IS NULL, d.sucursal_id, d.tipo, d.nombre';
  return { destinos: (await db.prepare(sql).all(...args)) };
}
if (path === '/api/destinos-pago/select' && method === 'GET') {
  exigirVerDestinos(empleado);
  const sucursal = Number(body?.sucursal_id) || Number(empleado.sucursal_id) || null;
  let sql = `SELECT d.id, d.nombre, d.tipo, d.identificador, d.sucursal_id, s.nombre AS sucursal_nombre
    FROM destinos_pago d LEFT JOIN sucursales s ON s.id = d.sucursal_id
    WHERE d.activo = 1`;
  const args = [];
  if (sucursal) {
    sql += ' AND (sucursal_id IS NULL OR sucursal_id = ?)';
    args.push(sucursal);
  }
  sql += ' ORDER BY sucursal_id IS NULL, sucursal_id, tipo, nombre';
  return { destinos: (await db.prepare(sql).all(...args)) };
}
if (path === '/api/destinos-pago' && method === 'POST') {
  exigir(empleado, 'config:gestionar');
  const nombre = String(body.nombre || '').trim();
  if (!nombre) throw new ApiError(400, 'El nombre es obligatorio');
  const tipo = String(body.tipo || '').trim();
  if (!TIPOS_DESTINO.includes(tipo)) throw new ApiError(400, 'Tipo de destino inválido');
  const sucursalId = body.sucursal_id === null || body.sucursal_id === undefined || body.sucursal_id === '' ? null : Number(body.sucursal_id);
  if (sucursalId && !(await db.prepare('SELECT 1 FROM sucursales WHERE id = ?').get(sucursalId))) {
    throw new ApiError(400, 'Sucursal inválida');
  }
  const identificador = String(body.identificador || '').trim();
  if (tipo === 'efectivo' && !sucursalId) throw new ApiError(400, 'Un destino en efectivo debe pertenecer a una sucursal');
  (await db.prepare(
    `INSERT INTO destinos_pago (sucursal_id, nombre, tipo, identificador, activo)
     VALUES(?,?,?,?,1)`
  ).run(sucursalId, nombre, tipo, identificador));
  return { ok: true };
}
if (seg[0] === 'api' && seg[1] === 'destinos-pago' && seg[2]) {
  exigir(empleado, 'config:gestionar');
  const id = Number(seg[2]);
  const me = (await db.prepare('SELECT * FROM destinos_pago WHERE id = ?').get(id));
  if (!me) throw new ApiError(404, 'Destino no encontrado');
  if (method === 'PUT') {
    const nombre = String(body.nombre || me.nombre).trim();
    if (!nombre) throw new ApiError(400, 'El nombre es obligatorio');
    const tipo = String(body.tipo || me.tipo).trim();
    if (!TIPOS_DESTINO.includes(tipo)) throw new ApiError(400, 'Tipo de destino inválido');
    const sucursalId = body.sucursal_id === null || body.sucursal_id === undefined || body.sucursal_id === '' ? null : Number(body.sucursal_id);
    if (sucursalId && !(await db.prepare('SELECT 1 FROM sucursales WHERE id = ?').get(sucursalId))) {
      throw new ApiError(400, 'Sucursal inválida');
    }
    const identificador = String(body.identificador || me.identificador || '').trim();
    /* FormData manda "0" y "1" como texto, así que un chequeo de verdad trata "0"
       como activo. Se compara con Number para que "No" sí desactive. */
    const activo = body.activo === undefined ? me.activo : (Number(body.activo) ? 1 : 0);
    if (tipo === 'efectivo' && !sucursalId) throw new ApiError(400, 'Un destino en efectivo debe pertenecer a una sucursal');
    (await db.prepare('UPDATE destinos_pago SET sucursal_id=?, nombre=?, tipo=?, identificador=?, activo=? WHERE id=?')
      .run(sucursalId, nombre, tipo, identificador, activo, id));
    return { ok: true };
  }
  if (method === 'DELETE') {
    /* No se borra: las ventas y los cobros lo referencian. Se desactiva. */
    (await db.prepare('UPDATE destinos_pago SET activo = 0 WHERE id = ?').run(id));
    return { ok: true };
  }
}


  // ---------------- GASTOS DE SUCURSAL ----------------
  if (path === '/api/gastos' && method === 'GET') {
    exigir(empleado, 'gastos:ver');
    const mes = String(body?.mes || '').trim();
/* Elegir un mes es otra pregunta que elegir un rango de fechas. En el rango
       importa cuándo salió la plata (fecha). Al pedir un mes interesa a qué mes
       se imputa el gasto (mes_cobro): así el alquiler pagado el 5 de octubre
       sigue apareciendo como gasto de septiembre, igual que lo cuenta la tarjeta
       de alquiler pendiente. Ojo: mes_cobro se guarda como 'AAAA-MM', no como
       fecha, así que se compara con igualdad y no con BETWEEN. */
    const desde = mes ? `${mes}-01` : String(body?.desde || haceDias(29)).slice(0, 10);
    const hasta = mes ? finDeMes(mes) : String(body?.hasta || hoyISO()).slice(0, 10);
    const sucursal = Number(body?.sucursal_id) || 0;
    const categoria = String(body?.categoria || '').trim();

    /* Una sola condición de fecha, reutilizada por las tres consultas de la
       pantalla, y el mismo filtro de sucursal y categoría en las tres: si el
       listado dice una cosa y el total dice otra, la pantalla miente. */
    const condFecha = mes ? 'g.mes_cobro = ?' : 'date(g.fecha) BETWEEN ? AND ?';
    const argsFecha = mes ? [mes] : [desde, hasta];
    /* Al asesor se le impone su tienda. Lo que gasta la otra no es un dato suyo,
       aunque el formulario de gastos que ve sea el mismo. */
    const ag = ambitoSucursal(empleado, 'g');
    const extras = [];
    if (sucursal && !ag.sql) extras.push('g.sucursal_id = ?');
    if (categoria) extras.push('g.categoria = ?');
    const where = `WHERE ${condFecha}${extras.map((c) => ` AND ${c}`).join('')}${ag.sql}`;
    const args = [...argsFecha];
    if (sucursal && !ag.sql) args.push(sucursal);
    if (categoria) args.push(categoria);
    args.push(...ag.args);

    const gastos = (await db.prepare(`${GASTO_SELECT} ${where} ORDER BY g.fecha DESC, g.id DESC`).all(...args));
    const porCategoria = (await db.prepare(`SELECT g.categoria, COUNT(*) AS n, COALESCE(SUM(g.monto),0) AS total
      FROM gastos_sucursal g ${where} GROUP BY g.categoria ORDER BY total DESC`).all(...args));
    const total = (await db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(g.monto),0) AS total
      FROM gastos_sucursal g ${where}`).get(...args));

    /* El estado de alquiler de cada tienda en el mes consultado, para que el
       dueño vea de un vistazo a quién le falta pagar. El asesor sólo necesita
       el de la suya, y no el de las demás. */
    const mesRef = mes || `${hasta.slice(0, 7)}`;
    const sucVisible = ag.sql ? Number(empleado.sucursal_id) || -1 : sucursal;
    const sucs = sucVisible
      ? (await db.prepare('SELECT * FROM sucursales WHERE id = ?').all(sucVisible))
      : (await db.prepare('SELECT * FROM sucursales WHERE activo = 1 ORDER BY nombre').all());
    const alquileres = (await Promise.all(sucs.map(async (s) => (await alquilerPendiente(s, mesRef))))).filter(Boolean);

    return {
      gastos, porCategoria, resumen: total, alquileres,
      categorias: CATEGORIAS_GASTO, desde, hasta, mes: mesRef,
    };
  }
  if (path === '/api/gastos' && method === 'POST') {
    exigir(empleado, 'gastos:gestionar');
    return (await crearGasto(body, empleado));
  }
  if (seg[0] === 'api' && seg[1] === 'gastos' && seg[2]) {
    exigir(empleado, 'gastos:gestionar');
    const id = Number(seg[2]);
    const me = (await db.prepare('SELECT * FROM gastos_sucursal WHERE id = ?').get(id));
    if (!me) throw new ApiError(404, 'Gasto no encontrado');
    if (method === 'PUT') return (await actualizarGasto(id, body, me));
    if (method === 'DELETE') {
      (await db.prepare('DELETE FROM gastos_sucursal WHERE id = ?').run(id));
      return { ok: true };
    }
  }

  // ---------------- PRODUCTOS ----------------
  if (path === '/api/productos/siguiente-codigo' && method === 'GET') {
    exigir(empleado, 'productos:ver');
    return { codigo: (await sigCodigoProducto()) };
  }
  if (path === '/api/productos' && method === 'GET') {
    exigir(empleado, 'productos:ver');
    const busca = String(body?.buscar || '').trim();
    const filtro = String(body?.filtro || '');
    const cat = Number(body?.categoria_id) || 0;
    let sql = PRODUCT_SELECT + ' WHERE 1=1';
    const p = [];
    if (busca) {
      sql += ' AND (p.nombre LIKE ? OR p.codigo LIKE ? OR p.codigo_barras LIKE ?)';
      p.push(`%${busca}%`, `%${busca}%`, `%${busca}%`);
    }
    /* "stock bajo" se mide contra lo vendible: lo comprometido a una visita con
       instalación ya no está disponible para reponer. */
    if (filtro === 'bajo') sql += ' AND p.stock - p.stock_reservado <= p.stock_minimo';
    if (filtro === 'inactivos') sql += ' AND p.activo = 0';
    else sql += ' AND p.activo = 1';
    if (cat) { sql += ' AND p.categoria_id = ?'; p.push(cat); }
    sql += ' ORDER BY p.nombre';
    return { productos: (await db.prepare(sql).all(...p)) };
  }
  /* Lectura por lector de códigos de barras. Va antes del bloque que resuelve
     productos por id para que "barcode" no se tome como un id. */
  if (seg[0] === 'api' && seg[1] === 'productos' && seg[2] === 'barcode' && method === 'GET') {
    exigir(empleado, 'productos:ver');
    let leido = '';
    try { leido = normalizarCodigoBarras(decodeURIComponent(seg[3] || '')); } catch { leido = ''; }
    if (!leido) throw new ApiError(400, 'No llegó un código de barras válido');
    const encontrado = (await db.prepare(PRODUCT_SELECT + ' WHERE p.codigo_barras = ? AND p.activo = 1').get(leido));
    if (!encontrado) throw new ApiError(404, 'Ningún producto activo tiene el código ' + leido);
    return { producto: encontrado };
  }
  if (path === '/api/productos' && method === 'POST') {
    exigir(empleado, 'productos:editar');
    const cat = body.categoria_id ? Number(body.categoria_id) : null;
    const codigo = String(body.codigo || '').trim() || (await sigCodigoProducto());
    if (!body.nombre) throw new ApiError(400, 'El nombre es obligatorio');
    if ((await db.prepare('SELECT 1 FROM productos WHERE codigo = ?').get(codigo))) throw new ApiError(400, 'Ya existe un producto con ese código');
    const codigoBarras = (await codigoBarrasDe(body.codigo_barras, null));
    if ((await db.prepare('SELECT 1 FROM productos WHERE codigo_barras = ?').get(codigoBarras))) {
      throw new ApiError(400, 'Ese código de barras ya pertenece a otro producto');
    }
    const campos = datosProducto(body, null);
    await exigirNombreLibre(campos.nombre, 0);
    const r = (await db.prepare(
      `INSERT INTO productos(codigo, codigo_barras, nombre, categoria_id, descripcion, costo, precio, stock, stock_minimo, unidad, contenido, iva_aplicable)
       VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(codigo, codigoBarras, campos.nombre, cat, campos.descripcion, campos.costo, campos.precio, campos.stock,
      campos.stock_minimo, campos.unidad, campos.contenido, campos.iva_aplicable));
    const id = Number(r.lastInsertRowid);
    if (campos.stock > 0) {
      (await db.prepare(`INSERT INTO movimientos(producto_id, sucursal_id, tipo, cantidad, stock_despues, referencia, empleado_id, notas)
                  VALUES(?,?,?,?,?,?,?,?)`)
        .run(id, empleado.sucursal_id, 'entrada', campos.stock, campos.stock, 'Stock inicial', empleado.id, ''));
    }
    return { producto: (await db.prepare(PRODUCT_SELECT + ' WHERE p.id = ?').get(id)) };
  }
  if (seg[0] === 'api' && seg[1] === 'productos' && seg[2]) {
    const id = Number(seg[2]);
    const me = (await db.prepare(PRODUCT_SELECT + ' WHERE p.id = ?').get(id));
    if (!me) throw new ApiError(404, 'Producto no encontrado');
    if (method === 'PUT') {
      exigir(empleado, 'productos:editar');
      if (!body.nombre) throw new ApiError(400, 'El nombre es obligatorio');
      const codigo = String(body.codigo || '').trim() || me.codigo;
      if ((await db.prepare('SELECT 1 FROM productos WHERE codigo = ? AND id != ?').get(codigo, id))) {
        throw new ApiError(400, 'Ya existe otro producto con ese código');
      }
      const codigoBarras = (await codigoBarrasDe(body.codigo_barras, me.codigo_barras));
      if ((await db.prepare('SELECT 1 FROM productos WHERE codigo_barras = ? AND id != ?').get(codigoBarras, id))) {
        throw new ApiError(400, 'Ese código de barras ya pertenece a otro producto');
      }
      const c = datosProducto(body, me);
      await exigirNombreLibre(c.nombre, id);
      (await db.prepare(
        `UPDATE productos SET codigo=?, codigo_barras=?, nombre=?, categoria_id=?, descripcion=?, costo=?, precio=?, stock_minimo=?, unidad=?, contenido=?, iva_aplicable=? WHERE id=?`
      ).run(codigo, codigoBarras, c.nombre, body.categoria_id ? Number(body.categoria_id) : null, c.descripcion,
        c.costo, c.precio, c.stock_minimo, c.unidad, c.contenido, c.iva_aplicable, id));
      return { producto: (await db.prepare(PRODUCT_SELECT + ' WHERE p.id = ?').get(id)) };
    }
    if (method === 'DELETE') {
      exigir(empleado, 'productos:editar');
      const vendido = (await db.prepare('SELECT COUNT(*) AS c FROM venta_items WHERE producto_id = ?').get(id));
      if (vendido.c > 0) {
        (await db.prepare('UPDATE productos SET activo = 0 WHERE id = ?').run(id));
        return { ok: true, inactivado: true };
      }
      (await db.prepare('DELETE FROM productos WHERE id = ?').run(id));
      return { ok: true, eliminado: true };
    }
  }

  // ---------------- CLIENTES ----------------
  if (path === '/api/clientes' && method === 'GET') {
    exigir(empleado, 'clientes:ver');
    const busca = String(body?.buscar || '').trim();
    const sql = busca
      ? CLIENTE_SELECT + ' WHERE c.nombre LIKE ? OR c.documento LIKE ? OR c.codigo LIKE ? ORDER BY c.nombre'
      : CLIENTE_SELECT + ' ORDER BY c.nombre';
    const p = busca ? [`%${busca}%`, `%${busca}%`, `%${busca}%`] : [];
    return { clientes: (await db.prepare(sql).all(...p)) };
  }
  if (path === '/api/clientes' && method === 'POST') {
    exigir(empleado, 'clientes:editar');
    if (!body.nombre) throw new ApiError(400, 'El nombre es obligatorio');
    const codigo = String(body.codigo || '').trim() || (await sigNumero('clientes', 'C', 'codigo'));
    if ((await db.prepare('SELECT 1 FROM clientes WHERE codigo = ?').get(codigo))) throw new ApiError(400, 'Ya existe un cliente con ese código');
    const r = (await db.prepare(
      'INSERT INTO clientes(codigo, nombre, documento, telefono, email, direccion) VALUES(?,?,?,?,?,?)'
    ).run(codigo, String(body.nombre).trim(), body.documento || '', body.telefono || '', body.email || '', body.direccion || ''));
    return { cliente: (await db.prepare(CLIENTE_SELECT + ' WHERE c.id = ?').get(Number(r.lastInsertRowid))) };
  }
  if (seg[0] === 'api' && seg[1] === 'clientes' && seg[2]) {
    const id = Number(seg[2]);
    const me = (await db.prepare(CLIENTE_SELECT + ' WHERE c.id = ?').get(id));
    if (!me) throw new ApiError(404, 'Cliente no encontrado');
    if (method === 'PUT') {
      exigir(empleado, 'clientes:editar');
      if (!body.nombre) throw new ApiError(400, 'El nombre es obligatorio');
      (await db.prepare(
        'UPDATE clientes SET nombre=?, documento=?, telefono=?, email=?, direccion=?, activo=? WHERE id=?'
      ).run(String(body.nombre).trim(), body.documento ?? me.documento, body.telefono ?? me.telefono,
        body.email ?? me.email, body.direccion ?? me.direccion,
        body.activo !== undefined ? (body.activo ? 1 : 0) : me.activo, id));
      return { cliente: (await db.prepare(CLIENTE_SELECT + ' WHERE c.id = ?').get(id)) };
    }
    if (method === 'DELETE') {
      exigir(empleado, 'config:gestionar');
      (await db.prepare('UPDATE clientes SET activo = 0 WHERE id = ?').run(id));
      return { ok: true };
    }
  }

  // ---------------- PROVEEDORES ----------------
  if (path === '/api/proveedores' && method === 'GET') {
    exigir(empleado, 'proveedores:gestionar');
    const busca = String(body?.buscar || '').trim();
    const sql = busca
      ? 'SELECT * FROM proveedores WHERE nombre LIKE ? OR documento LIKE ? ORDER BY nombre'
      : 'SELECT * FROM proveedores ORDER BY nombre';
    const p = busca ? [`%${busca}%`, `%${busca}%`] : [];
    return { proveedores: (await db.prepare(sql).all(...p)) };
  }
  if (path === '/api/proveedores' && method === 'POST') {
    exigir(empleado, 'proveedores:gestionar');
    if (!body.nombre) throw new ApiError(400, 'El nombre es obligatorio');
    const r = (await db.prepare(
      'INSERT INTO proveedores(nombre, contacto, documento, telefono, email, direccion) VALUES(?,?,?,?,?,?)'
    ).run(String(body.nombre).trim(), body.contacto || '', body.documento || '', body.telefono || '', body.email || '', body.direccion || ''));
    return { proveedor: (await db.prepare('SELECT * FROM proveedores WHERE id = ?').get(Number(r.lastInsertRowid))) };
  }
  if (seg[0] === 'api' && seg[1] === 'proveedores' && seg[2]) {
    const id = Number(seg[2]);
    const me = (await db.prepare('SELECT * FROM proveedores WHERE id = ?').get(id));
    if (!me) throw new ApiError(404, 'Proveedor no encontrado');
    if (method === 'PUT') {
      exigir(empleado, 'proveedores:gestionar');
      if (!body.nombre) throw new ApiError(400, 'El nombre es obligatorio');
      (await db.prepare(
        'UPDATE proveedores SET nombre=?, contacto=?, documento=?, telefono=?, email=?, direccion=?, activo=? WHERE id=?'
      ).run(String(body.nombre).trim(), body.contacto ?? me.contacto, body.documento ?? me.documento,
        body.telefono ?? me.telefono, body.email ?? me.email, body.direccion ?? me.direccion,
        body.activo !== undefined ? (body.activo ? 1 : 0) : me.activo, id));
      return { proveedor: (await db.prepare('SELECT * FROM proveedores WHERE id = ?').get(id)) };
    }
    if (method === 'DELETE') {
      exigir(empleado, 'config:gestionar');
      (await db.prepare('UPDATE proveedores SET activo = 0 WHERE id = ?').run(id));
      return { ok: true };
    }
  }

  // ---------------- EMPLEADOS ----------------
  if (path === '/api/empleados' && method === 'GET') {
    exigir(empleado, 'config:gestionar');
    return { empleados: (await listarEmpleados()) };
  }
  if (path === '/api/empleados' && method === 'POST') {
    exigir(empleado, 'config:gestionar');
    return (await crearEmpleado(body));
  }
  /* El punto de venta necesita la lista de técnicos para asignar la instalación. */
  if (path === '/api/tecnicos' && method === 'GET') {
    exigir(empleado, 'empleados:tecnicos');
    return { tecnicos: (await listarTecnicos()) };
  }
  if (seg[0] === 'api' && seg[1] === 'empleados' && seg[2]) {
    exigir(empleado, 'config:gestionar');
    const id = Number(seg[2]);
    const me = (await db.prepare('SELECT * FROM empleados WHERE id = ?').get(id));
    if (!me) throw new ApiError(404, 'Empleado no encontrado');
    if (method === 'PUT') return (await actualizarEmpleado(id, body, me));
    if (method === 'DELETE') {
      if (empleado.id === id) throw new ApiError(400, 'No puedes desactivar tu propia cuenta');
      (await db.prepare('UPDATE empleados SET activo = 0 WHERE id = ?').run(id));
      return { ok: true };
    }
  }

  // ---------------- VENTAS / POS ----------------
  if (path === '/api/ventas' && method === 'POST') {
    exigir(empleado, 'ventas:crear');
    return (await crearVenta(body, empleado));
  }
  if (path === '/api/ventas' && method === 'GET') {
    exigir(empleado, 'ventas:ver');
    const desde = body?.desde || haceDias(7);
    const hasta = body?.hasta || hoyISO();
    const estado = body?.estado || 'todas';
    const sucursal = Number(body?.sucursal_id) || 0;
    const busca = String(body?.buscar || '').trim();
    let sql = `
      SELECT v.*, c.nombre AS cliente_nombre, e.nombre AS empleado_nombre, su.nombre AS sucursal_nombre,
             (SELECT COUNT(*) FROM venta_items vi WHERE vi.venta_id = v.id) AS n_items,
             (SELECT COUNT(*) FROM instalaciones i WHERE i.venta_id = v.id) AS n_instalaciones
      FROM ventas v
      LEFT JOIN clientes c ON c.id = v.cliente_id
      LEFT JOIN empleados e ON e.id = v.empleado_id
      LEFT JOIN sucursales su ON su.id = v.sucursal_id
      WHERE date(v.fecha) BETWEEN ? AND ?`;
    const p = [desde, hasta];
    if (estado === 'completada') { sql += ' AND v.estado = ?'; p.push('completada'); }
    if (estado === 'anulada') { sql += ' AND v.estado = ?'; p.push('anulada'); }
    /* El filtro de sucursal se ignora para quien no es admin: sin esto bastaría
       cambiar el valor del select para ver la venta de otra tienda. */
    const amb = ambitoVentas(empleado);
    sql += amb.sql; p.push(...amb.args);
    if (sucursal && empleado.rol !== 'asesor') { sql += ' AND v.sucursal_id = ?'; p.push(sucursal); }
    if (busca) { sql += ' AND (v.numero LIKE ? OR c.nombre LIKE ?)'; p.push(`%${busca}%`, `%${busca}%`); }
    sql += ' ORDER BY v.fecha DESC, v.id DESC LIMIT 500';
    const ventas = (await db.prepare(sql).all(...p));
    for (const v of ventas) {
      const d = (await db.prepare('SELECT nombre, tipo FROM destinos_pago WHERE id = ?').get(v.destino_id));
      if (d) { v.destino_nombre = d.nombre; v.destino_tipo = d.tipo; }
    }
    return { ventas, desde, hasta };
  }
  if (seg[0] === 'api' && seg[1] === 'ventas' && seg[2]) {
    exigir(empleado, 'ventas:ver');
    const id = Number(seg[2]);
    const ventaDetalle = async () => {
      const venta = (await db.prepare(`
        SELECT v.*, c.nombre AS cliente_nombre, c.direccion AS cliente_direccion, c.telefono AS cliente_telefono,
               e.nombre AS empleado_nombre, su.nombre AS sucursal_nombre, su.codigo AS sucursal_codigo,
               su.direccion AS sucursal_direccion, su.telefono AS sucursal_telefono,
               cu.valor AS moneda,
               d.nombre AS destino_nombre, d.tipo AS destino_tipo, d.identificador AS destino_identificador
        FROM ventas v
        LEFT JOIN clientes c ON c.id = v.cliente_id
        LEFT JOIN empleados e ON e.id = v.empleado_id
        LEFT JOIN sucursales su ON su.id = v.sucursal_id
        LEFT JOIN destinos_pago d ON d.id = v.destino_id
        LEFT JOIN (SELECT valor FROM configuracion WHERE clave='moneda') cu ON 1=1
        WHERE v.id = ?`).get(id));
      /* Una venta ajena se responde como inexistente y no como "no permitida":
         confirmar que el número existe ya filtra información de la tienda. */
      if (!venta) throw new ApiError(404, 'Venta no encontrada');
      if (empleado.rol === 'asesor' && venta.empleado_id !== empleado.id) {
        throw new ApiError(404, 'Venta no encontrada');
      }
      venta.items = (await db.prepare('SELECT * FROM venta_items WHERE venta_id = ?').all(id));
      venta.instalaciones = (await Promise.all((await db.prepare(INSTALACION_SELECT + ' WHERE i.venta_id = ?').all(id)).filter((i) => puedeVerInstalacion(empleado, i)).map(async (i) => (await conVistas(i, empleado)))));
      return { venta };
    };
    if (seg[3] === 'ticket') return (await ventaDetalle());
    if (method === 'GET') return (await ventaDetalle());
    if (method === 'POST' && seg[3] === 'anular') {
      exigir(empleado, 'ventas:anular');
      return (await anularVenta(id, empleado, body?.motivo || ''));
    }
    if (method === 'POST') return (await ventaDetalle());
  }

  // ---------------- INSTALACIONES A DOMICILIO ----------------
  if (path === '/api/instalaciones' && method === 'GET') {
    exigir(empleado, 'instalaciones:ver');
    const estado = String(body?.estado || '');
    const sucursal = Number(body?.sucursal_id) || 0;
    const tecnico = Number(body?.tecnico_id) || 0;
    const desde = body?.desde || '';
    const hasta = body?.hasta || '';
    const busca = String(body?.buscar || '').trim();
    let sql = INSTALACION_SELECT + ' WHERE 1=1';
    const p = [];
    if (estado) { sql += ' AND i.estado = ?'; p.push(estado); }
    /* El recorte del rol va antes que los filtros de la pantalla, y no se
       pueden ampliar: el filtro de sucursal o de técnico se ignora para quien
       no es admin o técnico, respectivamente. */
    const amb = ambitoInstalaciones(empleado);
    sql += amb.sql; p.push(...amb.args);
    if (sucursal && empleado.rol !== 'asesor') { sql += ' AND i.sucursal_id = ?'; p.push(sucursal); }
    if (tecnico) { sql += ' AND i.tecnico_id = ?'; p.push(tecnico); }
    if (desde) { sql += ' AND date(i.fecha) >= ?'; p.push(desde); }
    if (hasta) { sql += ' AND date(i.fecha) <= ?'; p.push(hasta); }
    if (busca) { sql += ' AND (i.codigo LIKE ? OR i.producto_nombre LIKE ? OR i.direccion LIKE ? OR c.nombre LIKE ?)'; p.push(`%${busca}%`, `%${busca}%`, `%${busca}%`, `%${busca}%`); }
    /* Primero lo que está por vencer, de la cita más próxima a la más lejana;
       al final, el historial de lo ya cerrado. Los hitos de la mercadería
       cuentan como trabajo abierto: aún falta entregar o instalar. */
    sql += ` ORDER BY
        CASE WHEN i.estado IN ('pendiente','programada','material_retirado','en_ruta','en_progreso') THEN 0 ELSE 1 END,
        CASE WHEN i.estado IN ('pendiente','programada','material_retirado','en_ruta','en_progreso') THEN CONCAT(i.fecha_programada, ' ', i.hora_programada) END ASC,
        i.fecha DESC, i.id DESC LIMIT 500`;
    const lista = (await db.prepare(sql).all(...p));
    return {
      /* conVistas se pasa dentro de un map, así que el segundo argumento sería
         el índice del array y no el empleado: hay que envolverlo o las acciones
         de la lista saldrían siempre vacías. */
      instalaciones: (await Promise.all(lista.map(async (i) => (await conVistas(i, empleado))))),
      resumen: (await resumenInstalaciones(lista)),
      /* La pantalla usa esto para ocultar los selectores que el servidor
         ignora, en vez de dejarlos sonando como un filtro que no hace nada. */
      alcance: {
        sucursal: empleado.rol === 'asesor' ? Number(empleado.sucursal_id) || 0 : 0,
        tecnico: empleado.rol === 'tecnico' ? Number(empleado.id) : 0,
        sin_tecnico: empleado.rol === 'tecnico',
      },
    };
  }
  if (seg[0] === 'api' && seg[1] === 'instalaciones' && seg[2]) {
    exigir(empleado, 'instalaciones:ver');
    const id = Number(seg[2]);
    const inst = (await db.prepare(INSTALACION_SELECT + ' WHERE i.id = ?').get(id));
    /* Igual que con las ventas ajenas: 404, no 403. */
    if (!inst || !puedeVerInstalacion(empleado, inst)) throw new ApiError(404, 'Orden de instalación no encontrada');
    if (method === 'GET' && !seg[3]) {
      inst.historial = (await db.prepare(`
        SELECT h.*, e.nombre AS empleado_nombre
        FROM instalacion_historial h LEFT JOIN empleados e ON e.id = h.empleado_id
        WHERE h.instalacion_id = ? ORDER BY h.id`).all(id));
      return { instalacion: (await conVistas(inst, empleado)) };
    }
    /* Corregir los datos de la orden (dirección, contacto, notas) no mueve el
       estado ni el dinero: por eso es un permiso aparte del de gestionarla. */
    if (method === 'PATCH' && !seg[3]) {
      exigir(empleado, 'instalaciones:editar');
      return (await editarDatosInstalacion(inst, body, empleado));
    }
    if (method === 'POST' && seg[3] === 'asignar') {
      exigir(empleado, 'instalaciones:editar');
      return (await asignarTecnico(inst, body, empleado));
    }
    if (method === 'POST' && seg[3] === 'tomar') {
      exigir(empleado, 'instalaciones:gestionar');
      if (empleado.rol !== 'tecnico' || !['pendiente', 'programada'].includes(inst.estado)) {
        throw new ApiError(400, 'Solo un técnico puede tomar una orden pendiente o programada');
      }
      if (inst.tecnico_id && inst.tecnico_id !== empleado.id) {
        throw new ApiError(400, 'Esta orden ya tiene un técnico asignado');
      }
      return (await asignarTecnico(inst, { tecnico_id: empleado.id }, empleado));
    }
    if (method === 'POST' && seg[3] === 'estado') {
      exigir(empleado, 'instalaciones:gestionar');
      return (await cambiarEstadoInstalacion(inst, body, empleado));
    }
    /* El técnico puede registrar su propia entrega; el admin también, para
       regularizar lo que retiró el equipo. */
    if (method === 'POST' && seg[3] === 'entrega') {
      exigir(empleado, 'instalaciones:gestionar');
      return (await registrarEntrega(inst, body, empleado));
    }
    if (method === 'POST' && seg[3] === 'cobro') {
      exigir(empleado, 'instalaciones:gestionar');
      return (await cobrarSaldoInstalacion(inst, body, empleado));
    }
    if (method === 'POST' && seg[3] === 'cita') {
      exigir(empleado, 'instalaciones:editar');
      return (await reprogramarInstalacion(inst, body, empleado));
    }
  }

  // ---------------- COMPRAS ----------------
  if (path === '/api/compras' && method === 'POST') {
    exigir(empleado, 'compras:gestionar');
    return (await crearCompra(body, empleado));
  }
  if (path === '/api/compras' && method === 'GET') {
    exigir(empleado, 'compras:gestionar');
    const estado = body?.estado || 'todas';
    let sql = `
      SELECT co.*, pr.nombre AS proveedor_nombre, e.nombre AS empleado_nombre,
             (SELECT COUNT(*) FROM compra_items ci WHERE ci.compra_id = co.id) AS n_items
      FROM compras co
      LEFT JOIN proveedores pr ON pr.id = co.proveedor_id
      LEFT JOIN empleados e ON e.id = co.empleado_id
      WHERE 1=1`;
    const p = [];
    if (estado === 'pendiente') { sql += ' AND co.estado = ?'; p.push('pendiente'); }
    if (estado === 'recibida') { sql += ' AND co.estado = ?'; p.push('recibida'); }
    if (estado === 'cancelada') { sql += ' AND co.estado = ?'; p.push('cancelada'); }
    sql += ' ORDER BY co.fecha DESC, co.id DESC LIMIT 400';
    return { compras: (await db.prepare(sql).all(...p)) };
  }
  if (seg[0] === 'api' && seg[1] === 'compras' && seg[2]) {
    exigir(empleado, 'compras:gestionar');
    const id = Number(seg[2]);
    const me = (await db.prepare('SELECT * FROM compras WHERE id = ?').get(id));
    if (!me) throw new ApiError(404, 'Compra no encontrada');
    if (method === 'GET') {
      /* Se trae el código de barras y el contenido del producto para que la
         recepción pueda contar cajas con el lector. Si la línea apunta a un
         producto que ya no existe, quedan vacíos y se cuenta a mano. */
      me.items = (await db.prepare(
        `SELECT ci.*, p.codigo_barras, p.contenido, p.unidad
         FROM compra_items ci
         LEFT JOIN productos p ON p.id = ci.producto_id
         WHERE ci.compra_id = ?`
      ).all(id));
      return { compra: me };
    }
    if (method === 'POST' && seg[3] === 'recibir') return (await recibirCompra(id, empleado, body?.recibido));
    if (method === 'POST' && seg[3] === 'cancelar') {
      if (me.estado !== 'pendiente') throw new ApiError(400, 'Solo se pueden cancelar compras pendientes');
      (await db.prepare("UPDATE compras SET estado='cancelada' WHERE id=?").run(id));
      return { ok: true };
    }
  }

  // ---------------- INVENTARIO ----------------
  if (path === '/api/inventario/movimientos' && method === 'GET') {
    exigir(empleado, 'inventario:ver');
    const desde = body?.desde || '';
    const hasta = body?.hasta || '';
    const tipo = body?.tipo || '';
    const producto = Number(body?.producto_id) || 0;
    const sucursal = Number(body?.sucursal_id) || 0;
    let sql = `
      SELECT m.*, p.nombre AS producto_nombre, p.codigo AS producto_codigo,
             e.nombre AS empleado_nombre, s.nombre AS sucursal_nombre
      FROM movimientos m
      LEFT JOIN productos p ON p.id = m.producto_id
      LEFT JOIN empleados e ON e.id = m.empleado_id
      LEFT JOIN sucursales s ON s.id = m.sucursal_id
      WHERE 1=1`;
    const args = [];
    if (desde) { sql += ' AND date(m.fecha) >= ?'; args.push(desde); }
    if (hasta) { sql += ' AND date(m.fecha) <= ?'; args.push(hasta); }
    if (tipo) { sql += ' AND m.tipo = ?'; args.push(tipo); }
    if (producto) { sql += ' AND m.producto_id = ?'; args.push(producto); }
    if (sucursal) { sql += ' AND m.sucursal_id = ?'; args.push(sucursal); }
    sql += ' ORDER BY m.fecha DESC, m.id DESC LIMIT 500';
    return { movimientos: (await db.prepare(sql).all(...args)) };
  }
  if (path === '/api/inventario/ajuste' && method === 'POST') {
    exigir(empleado, 'inventario:ajustar');
    const { producto_id, tipo, cantidad, notas } = body;
    const p = (await db.prepare('SELECT * FROM productos WHERE id = ?').get(Number(producto_id)));
    if (!p) throw new ApiError(404, 'Producto no encontrado');
    const cant = Number(cantidad);
    if (!Number.isFinite(cant) || cant <= 0) throw new ApiError(400, 'Cantidad inválida');
    let nuevo = p.stock;
    let ref = 'Ajuste de inventario';
    if (tipo === 'entrada') { nuevo = round2(p.stock + cant); ref = 'Entrada manual'; }
    else if (tipo === 'salida') {
      /* No se puede sacar mercadería comprometida a una venta con instalación:
         saldría del almacén sin que ninguna orden lo registre. */
      const disponible = round2(p.stock - p.stock_reservado);
      if (cant > disponible) {
        throw new ApiError(400, `Stock insuficiente (disponible: ${disponible}${p.stock_reservado > 0 ? `, ${p.stock_reservado} reservado para instalaciones` : ''})`);
      }
      nuevo = round2(p.stock - cant); ref = 'Salida manual / merma';
    } else throw new ApiError(400, 'Tipo de ajuste inválido');
    (await db.prepare('UPDATE productos SET stock = ? WHERE id = ?').run(nuevo, p.id));
    (await db.prepare(
      `INSERT INTO movimientos(producto_id, sucursal_id, tipo, cantidad, stock_despues, referencia, empleado_id, notas)
       VALUES(?,?,?,?,?,?,?,?)`
    ).run(p.id, empleado.sucursal_id, tipo, cant, nuevo, ref, empleado.id, notas || ''));
    return { producto: (await db.prepare(PRODUCT_SELECT + ' WHERE p.id = ?').get(p.id)), ok: true };
  }
  if (path === '/api/inventario/resumen' && method === 'GET') {
    exigir(empleado, 'inventario:ver');
    const r = (await db.prepare(`
      SELECT COUNT(*) AS total, COALESCE(SUM(stock),0) AS unidades,
             COALESCE(SUM(stock * costo),0) AS valor_inventario,
             COALESCE(SUM(stock_reservado),0) AS unidades_reservadas,
             /* Lo bajo se mide contra lo realmente vendible: lo que ya está
                comprometido a una visita no se puede reponer. */
             SUM(CASE WHEN stock - stock_reservado <= stock_minimo THEN 1 ELSE 0 END) AS stock_bajo
      FROM productos WHERE activo = 1`).get());
    return { resumen: r };
  }

  // ---------------- REPORTES ----------------
  /* Todas las pantallas de reportes comparten los mismos filtros, así que se
     leen y se traducen a SQL en un solo lugar. Si el dueño mira una tienda y
     el asesor mira toda la cadena, el cálculo es el mismo: solo cambia el
     WHERE. */
  if (path === '/api/reportes/ventas' && method === 'GET') {
    exigir(empleado, 'reportes:ver');
    const f = filtrosReporte(body, empleado);
    const { sql, args } = dondeVentas(f);
    const periodo = expressionPeriodo(f.granularidad);
    const etiqueta = etiquetaPeriodo.bind(null, f.granularidad);

    const porPeriodo = (await Promise.all((await db.prepare(`
      SELECT ${periodo} AS periodo, COUNT(*) AS n,
             COALESCE(SUM(subtotal),0) AS subtotal, COALESCE(SUM(descuento),0) AS descuento,
             COALESCE(SUM(impuestos),0) AS impuestos, COALESCE(SUM(total),0) AS total,
             COALESCE(SUM(costo_total),0) AS costo
      FROM ventas v WHERE ${sql}
      GROUP BY periodo ORDER BY periodo`).all(...args))
      .map(async (r) => ({ ...r, etiqueta: etiqueta(r.periodo), ...(await gananciaYUtilidad(r, f.desde, f.hasta, f.sucursal_id)) }))));

    /* Los huecos se rellenan con cero: si el lunes no se vendió nada, el lunes
       tiene que verse con cero, no desaparecer del gráfico. */
    const serie = rellenarPeriodos(porPeriodo, f.granularidad, f.desde, f.hasta);

    const porMetodo = (await db.prepare(`
      SELECT metodo_pago, COUNT(*) AS n, COALESCE(SUM(total),0) AS total
      FROM ventas v WHERE ${sql} GROUP BY v.metodo_pago ORDER BY total DESC`).all(...args));

    /* Por tienda: lo que entró, lo que se gastó y qué quedó. Es la pregunta que
       hace el dueño: qué tienda deja y cuál se está comiendo el alquiler. */
    const porSucursal = (await Promise.all((await db.prepare(`
      SELECT su.id, COALESCE(su.nombre,'Sin sucursal') AS sucursal,
             COUNT(*) AS n, COALESCE(SUM(v.subtotal),0) AS subtotal,
             COALESCE(SUM(v.descuento),0) AS descuento, COALESCE(SUM(v.impuestos),0) AS impuestos,
             COALESCE(SUM(v.total),0) AS total, COALESCE(SUM(v.costo_total),0) AS costo
      FROM ventas v LEFT JOIN sucursales su ON su.id = v.sucursal_id
      WHERE ${sql} GROUP BY su.id, su.nombre ORDER BY total DESC`).all(...args))
      .map(async (r) => ({ ...r, ...(await gananciaYUtilidad(r, f.desde, f.hasta, r.id)) }))));

    const resumen = (await db.prepare(`
      SELECT COUNT(*) AS n_ventas, COALESCE(SUM(v.subtotal),0) AS subtotal,
             COALESCE(SUM(v.descuento),0) AS descuento, COALESCE(SUM(v.impuestos),0) AS impuestos,
             COALESCE(SUM(v.total),0) AS total, COALESCE(SUM(v.costo_total),0) AS costo
      FROM ventas v WHERE ${sql}`).get(...args));
    const resumenFinal = { ...resumen, ...(await gananciaYUtilidad(resumen, f.desde, f.hasta, f.sucursal_id)) };

    const porVendedor = (await Promise.all((await db.prepare(`
      SELECT COALESCE(e.nombre,'Sin asignar') AS vendedor, COUNT(*) AS n,
             COALESCE(SUM(v.total),0) AS total, COALESCE(SUM(v.costo_total),0) AS costo
      FROM ventas v LEFT JOIN empleados e ON e.id = v.empleado_id
      WHERE ${sql} GROUP BY v.empleado_id, e.nombre ORDER BY total DESC`).all(...args))
      .map(async (r) => ({ ...r, ...(await gananciaYUtilidad(r, f.desde, f.hasta, f.sucursal_id)) }))));

    const instalaciones = (await db.prepare(`
      SELECT COUNT(*) AS n, COALESCE(SUM(i.costo),0) AS ingresos
      FROM instalaciones i WHERE i.estado = 'completada' AND date(i.fecha) BETWEEN ? AND ?
        ${f.sucursal_id ? 'AND i.sucursal_id = ?' : ''}`)
      .get(f.desde, f.hasta, ...(f.sucursal_id ? [f.sucursal_id] : [])));

    return {
      porDia: porPeriodo, serie, granularidad: f.granularidad, porMetodo, porSucursal,
      porVendedor, resumen: resumenFinal, instalaciones, ...f,
    };
  }
  if (path === '/api/reportes/productos' && method === 'GET') {
    exigir(empleado, 'reportes:ver');
    const f = filtrosReporte(body, empleado);
    const { sql, args } = dondeVentas(f);
    /* El descuento y el IGV viven en la cabecera de la venta, no en la línea.
       Se prorratean a cada línea para que la tabla de productos sume
       exactamente lo que dicen los indicadores de arriba. */
    const items = (await db.prepare(`
      SELECT vi.producto_id, vi.nombre, p.codigo, p.unidad, c.nombre AS categoria,
             SUM(vi.cantidad) AS cantidad,
             SUM(vi.subtotal - ${PRORRATEO}) AS base_neta,
             SUM(vi.subtotal - ${PRORRATEO} + ${PRORRATEO_IGV}) AS venta,
             SUM(vi.cantidad * vi.costo) AS costo,
             COUNT(DISTINCT v.id) AS ventas
      FROM venta_items vi
      JOIN ventas v ON v.id = vi.venta_id
      LEFT JOIN productos p ON p.id = vi.producto_id
      LEFT JOIN categorias c ON c.id = p.categoria_id
      WHERE ${sql} AND vi.producto_id IS NOT NULL
      GROUP BY vi.producto_id, vi.nombre, p.codigo, p.unidad, c.nombre
      ORDER BY cantidad DESC`).all(...args))
      .map((r) => ({ ...r, ganancia: round2(r.venta - r.costo), margen: r.costo ? Math.round((r.venta - r.costo) / r.costo * 100) : 0 }));

    const porCategoria = (await db.prepare(`
      SELECT COALESCE(c.nombre,'Sin categoría') AS categoria, SUM(vi.cantidad) AS cantidad,
             SUM(vi.subtotal - ${PRORRATEO} + ${PRORRATEO_IGV}) AS venta,
             SUM(vi.cantidad * vi.costo) AS costo
      FROM venta_items vi
      JOIN ventas v ON v.id = vi.venta_id
      LEFT JOIN productos p ON p.id = vi.producto_id
      LEFT JOIN categorias c ON c.id = p.categoria_id
      WHERE ${sql} AND vi.producto_id IS NOT NULL
      GROUP BY c.nombre ORDER BY venta DESC`).all(...args))
      .map((r) => ({ ...r, ganancia: round2(r.venta - r.costo) }));

    /* Los mismos productos, pero solo los de la tienda elegida. */
    const porSucursal = (await db.prepare(`
      SELECT COALESCE(su.nombre,'Sin sucursal') AS sucursal, SUM(vi.cantidad) AS cantidad,
             SUM(vi.subtotal - ${PRORRATEO} + ${PRORRATEO_IGV}) AS venta,
             SUM(vi.cantidad * vi.costo) AS costo
      FROM venta_items vi
      JOIN ventas v ON v.id = vi.venta_id
      LEFT JOIN sucursales su ON su.id = v.sucursal_id
      LEFT JOIN productos p ON p.id = vi.producto_id
      WHERE ${sql} AND vi.producto_id IS NOT NULL
      GROUP BY su.id, su.nombre ORDER BY venta DESC`).all(...args))
      .map((r) => ({ ...r, ganancia: round2(r.venta - r.costo) }));

    return { items, porCategoria, porSucursal, ...f };
  }

  /* Al hacer clic en un producto del reporte, el dueño quiere ver las ventas
     concretas que lo llevaron: qué día, en qué tienda, a quién y a qué precio.
     Esta es la consulta que une el ranking con el ticket. */
  if (seg[0] === 'api' && seg[1] === 'reportes' && seg[2] === 'producto' && seg[3] && method === 'GET') {
    exigir(empleado, 'reportes:ver');
    const f = filtrosReporte(body, empleado);
    const { sql, args } = dondeVentas(f);
    const prodId = Number(seg[3]);
    const p = (await db.prepare('SELECT id, nombre, codigo, unidad FROM productos WHERE id = ?').get(prodId));
    if (!p) throw new ApiError(404, 'Producto no encontrado');
    const ventas = (await db.prepare(`
      SELECT v.id AS venta_id, v.numero, v.fecha, v.estado,
             COALESCE(su.nombre,'Sin sucursal') AS sucursal,
             COALESCE(cl.nombre,'Cliente de mostrador') AS cliente,
             COALESCE(e.nombre,'Sin asignar') AS empleado,
             v.metodo_pago, vi.cantidad, vi.precio, vi.precio_instalacion,
             ROUND(vi.subtotal - ${PRORRATEO}, 2) AS base_neta,
             ROUND(vi.subtotal - ${PRORRATEO} + ${PRORRATEO_IGV}, 2) AS venta,
             ROUND(vi.cantidad * vi.costo, 2) AS costo
      FROM venta_items vi
      JOIN ventas v ON v.id = vi.venta_id
      LEFT JOIN sucursales su ON su.id = v.sucursal_id
      LEFT JOIN clientes cl ON cl.id = v.cliente_id
      LEFT JOIN empleados e ON e.id = v.empleado_id
      WHERE ${sql} AND vi.producto_id = ?
      ORDER BY v.fecha DESC, v.id DESC LIMIT ?`).all(...args, prodId, Number(body?.limite) || 300));

    const tot = (await db.prepare(`
      SELECT COUNT(*) AS n, COALESCE(SUM(vi.cantidad),0) AS cantidad,
             COALESCE(SUM(vi.subtotal - ${PRORRATEO} + ${PRORRATEO_IGV}),0) AS venta,
             COALESCE(SUM(vi.cantidad * vi.costo),0) AS costo
      FROM venta_items vi JOIN ventas v ON v.id = vi.venta_id
      WHERE ${sql} AND vi.producto_id = ?`).get(...args, prodId));

    return {
      producto: p,
      ventas,
      resumen: { ...tot, ganancia: round2(tot.venta - tot.costo) },
      ...f,
    };
  }

  // ---------------- DASHBOARD ----------------
  if (path === '/api/dashboard' && method === 'GET') {
    exigir(empleado, 'dashboard:ver');
    const hoy = hoyISO();
    const mesInicio = `${hoy.slice(0, 8)}01`;
    /* Los agregados de ventas van recortados a lo que le toca ver a cada rol.
       El stock y el catálogo no se recortan: son únicos en toda la cadena, y
       decir "hay 3 piezas" en una tienda donde el stock no se lleva por tienda
       sería un número falso. */
    const av = empleado.rol === 'asesor' && !empleado.sucursal_id
      ? { sql: ' AND 0=1', args: [] } : ambitoVentas(empleado);
    const ai = ambitoInstalaciones(empleado);
    const ventasHoy = (await db.prepare(`
      SELECT COUNT(*) AS n, COALESCE(SUM(total),0) AS total, COALESCE(SUM(costo_total),0) AS costo
      FROM ventas v WHERE v.estado='completada' AND date(v.fecha)=?${av.sql}`).get(hoy, ...av.args));
    const ventasMes = (await db.prepare(`
      SELECT COUNT(*) AS n, COALESCE(SUM(total),0) AS total, COALESCE(SUM(costo_total),0) AS costo
      FROM ventas v WHERE v.estado='completada' AND date(v.fecha) BETWEEN ? AND ?${av.sql}`)
      .get(mesInicio, hoy, ...av.args));
    const stockBajo = (await db.prepare(`
      SELECT * FROM (${PRODUCT_SELECT}) AS productos_resumen WHERE activo=1 AND stock - stock_reservado <= stock_minimo
      ORDER BY stock ASC LIMIT 8`).all());
    const stockBajoCount = (await db.prepare(`
      SELECT COUNT(*) AS c FROM productos WHERE activo=1 AND stock - stock_reservado <= stock_minimo`).get()).c;
    const ultimasVentas = (await db.prepare(`
      SELECT v.id, v.numero, v.fecha, v.total, v.estado, v.metodo_pago, c.nombre AS cliente_nombre, su.nombre AS sucursal_nombre,
             (SELECT COUNT(*) FROM instalaciones i WHERE i.venta_id = v.id) AS n_instalaciones
      FROM ventas v
      LEFT JOIN clientes c ON c.id = v.cliente_id
      LEFT JOIN sucursales su ON su.id = v.sucursal_id
      WHERE 1=1${av.sql}
      ORDER BY v.id DESC LIMIT 6`).all(...av.args));
    const dias = [];
    for (let i = 6; i >= 0; i--) dias.push(haceDias(i));
    const porDia = (await db.prepare(`
      SELECT date(fecha) AS dia, COALESCE(SUM(total),0) AS total
      FROM ventas v WHERE v.estado='completada' AND date(v.fecha) BETWEEN ? AND ?${av.sql}
      GROUP BY date(v.fecha)`).all(dias[0], hoy, ...av.args));
    const mapa = Object.fromEntries(porDia.map((d) => [d.dia, d.total]));
    const chart = dias.map((d) => ({ dia: d.slice(5), total: round2(mapa[d] || 0) }));
    const topProductos = (await db.prepare(`
      SELECT vi.nombre, SUM(vi.cantidad) AS cantidad, SUM(vi.subtotal) AS venta
      FROM venta_items vi JOIN ventas v ON v.id=vi.venta_id AND v.estado='completada'
      WHERE date(v.fecha) BETWEEN ? AND ? AND vi.producto_id IS NOT NULL${av.sql}
      GROUP BY vi.nombre ORDER BY cantidad DESC LIMIT 5`).all(mesInicio, hoy, ...av.args));
    const instPendientes = (await db.prepare(`
      SELECT COUNT(*) AS c FROM instalaciones i
      WHERE i.estado IN ('pendiente','programada','material_retirado','en_ruta','en_progreso')${ai.sql}`).get(...ai.args)).c;
    const instMes = (await db.prepare(`
      SELECT COUNT(*) AS n, COALESCE(SUM(costo),0) AS ingresos
      FROM instalaciones i WHERE i.estado = 'completada' AND date(i.fecha) BETWEEN ? AND ?${ai.sql}`)
      .get(mesInicio, hoy, ...ai.args));
    const instEnProgreso = (await db.prepare(`
      SELECT COUNT(*) AS c FROM instalaciones i
      WHERE i.estado IN ('material_retirado','en_ruta','en_progreso')${ai.sql}`).get(...ai.args)).c;
    const instSinTecnico = (await db.prepare(`
      SELECT COUNT(*) AS c FROM instalaciones i
      WHERE i.estado IN ('pendiente','programada','material_retirado','en_ruta','en_progreso')
        AND i.tecnico_id IS NULL${ai.sql}`).get(...ai.args)).c;
    return {
      ventasHoy,
      ventasMes,
      ticketPromedio: ventasHoy.n ? round2(ventasHoy.total / ventasHoy.n) : 0,
      stockBajo,
      stockBajoCount,
      ultimasVentas,
      chart,
      topProductos,
      instalaciones: {
        pendientes: instPendientes,
        abiertas: instPendientes,
        en_progreso: instEnProgreso,
        sin_tecnico: instSinTecnico,
        mes: instMes,
      },
      totalProductos: (await db.prepare('SELECT COUNT(*) AS c FROM productos WHERE activo=1').get()).c,
      totalClientes: (await db.prepare('SELECT COUNT(*) AS c FROM clientes WHERE activo=1').get()).c,
      utilidadSucursales: (await utilidadPorSucursal(mesInicio, hoy, empleado)),
    };
  }

  // ---------------- CONFIG ----------------
  if (path === '/api/config' && method === 'GET') {
    return { config: (await getAllConfig()) };
  }
  if (path === '/api/config' && method === 'PUT') {
    exigir(empleado, 'config:gestionar');
    const permitidas = ['nombre_tienda', 'lema', 'documento', 'direccion', 'telefono', 'moneda', 'iva', 'pie_ticket', 'prefijo_venta', 'prefijo_compra', 'prefijo_instalacion', 'precio_instalacion'];
    for (const [k, v] of Object.entries(body || {})) {
      if (!permitidas.includes(k)) continue;
      if (k === 'iva' || k === 'precio_instalacion') {
        const n = Number(v);
        if (!Number.isFinite(n) || n < 0 || n > 100) {
          throw new ApiError(400, k === 'iva' ? 'IGV inválido' : 'Tarifa de instalación inválida');
        }
        (await db.prepare('INSERT INTO configuracion(clave, valor) VALUES(?,?) ON DUPLICATE KEY UPDATE valor=VALUES(valor)').run(k, String(Math.round(n * 100) / 100)));
      } else if (k === 'prefijo_venta' || k === 'prefijo_compra' || k === 'prefijo_instalacion') {
        if (!String(v).trim()) throw new ApiError(400, 'Prefijo inválido');
        (await db.prepare('INSERT INTO configuracion(clave, valor) VALUES(?,?) ON DUPLICATE KEY UPDATE valor=VALUES(valor)').run(k, String(v).trim()));
      } else {
        (await db.prepare('INSERT INTO configuracion(clave, valor) VALUES(?,?) ON DUPLICATE KEY UPDATE valor=VALUES(valor)').run(k, String(v ?? '')));
      }
    }
    return { config: (await getAllConfig()) };
  }

  throw new ApiError(404, `Ruta no encontrada: ${method} ${path}`);
}

/* ===================== Auxiliares de módulos ===================== */

/* La instalación a domicilio se cotiza en el punto de venta, no es un atributo
   del producto: aquí solo se guardan nombre, precios, unidad e impuestos. Las
   columnas requiere_instalacion / precio_instalacion / dias_instalacion ya no
   se escriben; se conservan porque las órdenes antiguas las referencian y
   porque sirven para proponer la tarifa inicial de una venta. */
function datosProducto(body, actual) {
  return {
    nombre: String(body.nombre || '').trim(),
    descripcion: body.descripcion || '',
    costo: round2(body.costo ?? actual?.costo ?? 0),
    precio: round2(body.precio ?? actual?.precio ?? 0),
    stock: round2(body.stock ?? actual?.stock ?? 0),
    stock_minimo: round2(body.stock_minimo ?? actual?.stock_minimo ?? 5),
    unidad: body.unidad || actual?.unidad || 'pza',
    contenido: contenidoDe(body.contenido, actual?.contenido ?? 1),
    iva_aplicable: body.iva_aplicable ? 1 : 0,
  };
}

/* Dos productos con el mismo nombre son el mismo artículo, y entonces el
   catálogo muestra dos renglones idénticos, el stock se reparte entre los dos y
   los reportes los cuentan dos veces. El código y el código de barras ya tienen
   índice único en la tabla (migración 004 también para el nombre); esto es lo
   que hace la base con un mensaje que dice cuál es el que ya está.

   Se comparan también los archivados. Un producto con ventas no se borra, se
   desactiva: si su nombre volviera a salir, el artículo aparecería otra vez como
   producto nuevo, con todo el stock, al lado del que ya tenía historia. */
async function exigirNombreLibre(nombre, id) {
  const existente = await db.prepare('SELECT codigo, nombre, activo FROM productos WHERE nombre_clave = ? AND id <> ? LIMIT 1')
    .get(normalizarNombre(nombre), id);
  if (!existente) return;
  throw new ApiError(400, existente.activo
    ? `Ya existe el producto ${existente.codigo} «${existente.nombre}». Edítalo o ponle otro nombre`
    : `Ese nombre ya lo usa el producto archivado ${existente.codigo} «${existente.nombre}». Reactívalo o ponle otro nombre`);
}

/* Cuántas unidades de stock suma un escaneo. Una caja de 12 piezas lleva
   contenido 12, así que al escanearla entran 12 al inventario. */
function contenidoDe(valor, porDefecto = 1) {
  const n = Number(valor);
  if (!Number.isFinite(n) || n <= 0) return porDefecto;
  return round2(n);
}

/* Un producto puede traer escrito el código de barras que ya trae impreso el
   proveedor, o dejarlo vacío para que el sistema le asigne uno. Se queda solo
   con los dígitos porque es lo que el lector devuelve sin ambigüedad. */
async function codigoBarrasDe(valor, actual) {
  const codigo = normalizarCodigoBarras(valor);
  return codigo || actual || (await sigCodigoBarras());
}

async function listarEmpleados() {
  return (await db.prepare(`
    SELECT e.id, e.nombre, e.usuario, e.rol, e.telefono, e.activo, e.sucursal_id, e.creado_en,
           su.nombre AS sucursal_nombre
    FROM empleados e LEFT JOIN sucursales su ON su.id = e.sucursal_id
    ORDER BY e.nombre`).all());
}

async function listarTecnicos() {
  return (await db.prepare(`
    SELECT e.id, e.nombre, e.usuario, e.telefono, e.sucursal_id, su.nombre AS sucursal_nombre
    FROM empleados e LEFT JOIN sucursales su ON su.id = e.sucursal_id
    WHERE e.rol = 'tecnico' AND e.activo = 1
    ORDER BY e.nombre`).all());
}

/* ---------- Reportes: filtros, periodos y utilidad ---------- */

/* Los descuentos y el IGV se calculan una vez por venta y se guardan en la
   cabecera. Para saber cuánto apportó cada línea se le reparte su parte en
   proporción a lo que esa línea aporta, así la tabla de productos suma
   exactamente el total que dicen los indicadores. */
const PRORRATEO = 'COALESCE(v.descuento,0) * vi.subtotal / NULLIF(v.subtotal,0)';
const PRORRATEO_IGV = 'COALESCE(v.impuestos,0) * vi.subtotal / NULLIF(v.subtotal,0)';

const GRANULARIDADES = ['dia', 'semana', 'mes'];

function filtrosReporte(body = {}, empleado = null) {
  const g = String(body.granularidad || 'dia').toLowerCase();
  return {
    desde: String(body.desde || haceDias(29)).slice(0, 10),
    hasta: String(body.hasta || hoyISO()).slice(0, 10),
    /* Al asesor se le impone su sucursal aunque pida otra en el filtro: los tres
       reportes pasan por acá, así que el recorte queda en un solo lugar y no
       depende de que cada consulta se acuerde dearlo. */
    sucursal_id: empleado?.rol === 'asesor'
      ? (Number(empleado.sucursal_id) || -1)
      : (Number(body.sucursal_id) || 0),
    categoria_id: Number(body.categoria_id) || 0,
    producto_id: Number(body.producto_id) || 0,
    empleado_id: Number(body.empleado_id) || 0,
    metodo_pago: String(body.metodo_pago || '').trim(),
    estado: String(body.estado || 'completada').trim(),
    granularidad: GRANULARIDADES.includes(g) ? g : 'dia',
  };
}

/* Traduce los filtros a un WHERE. Se llama igual desde todos los reportes, de
   modo que la tienda, la categoría o el producto se recortan siempre igual. */
function dondeVentas(f) {
  let sql = 'date(v.fecha) BETWEEN ? AND ?';
  const args = [f.desde, f.hasta];
  if (f.sucursal_id) { sql += ' AND v.sucursal_id = ?'; args.push(f.sucursal_id); }
  if (f.empleado_id) { sql += ' AND v.empleado_id = ?'; args.push(f.empleado_id); }
  if (f.metodo_pago) { sql += ' AND v.metodo_pago = ?'; args.push(f.metodo_pago); }
  if (f.estado && f.estado !== 'todas') { sql += ' AND v.estado = ?'; args.push(f.estado); }
  /* Producto y categoría se recortan sobre las líneas, así que van en un
     EXISTS y no ensucian el agrupado de la cabecera. */
  if (f.producto_id || f.categoria_id) {
    sql += ` AND EXISTS (SELECT 1 FROM venta_items vi2
      JOIN productos p2 ON p2.id = vi2.producto_id
      WHERE vi2.venta_id = v.id`;
    if (f.producto_id) { sql += ' AND vi2.producto_id = ?'; args.push(f.producto_id); }
    if (f.categoria_id) { sql += ' AND p2.categoria_id = ?'; args.push(f.categoria_id); }
    sql += ')';
  }
  return { sql, args };
}

/* La expresión que agrupa por día, por semana (lunes) o por mes. En la semana
   SQLite cuenta el domingo como 0, así que el lunes de esa semana se obtiene
   restando (dow + 6) mod 7 días. */
function expressionPeriodo(g) {
  if (g === 'mes') return "DATE_FORMAT(v.fecha, '%Y-%m')";
  if (g === 'semana') return "DATE_FORMAT(DATE_SUB(DATE(v.fecha), INTERVAL WEEKDAY(v.fecha) DAY), '%Y-%m-%d')";
  return 'date(v.fecha)';
}

function etiquetaPeriodo(g, periodo) {
  if (!periodo) return '';
  if (g === 'mes') { const [a, m] = periodo.split('-'); return `${['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'set', 'oct', 'nov', 'dic'][Number(m) - 1] || m} ${a}`; }
  if (g === 'semana') return `sem. ${periodo.slice(8)}/${periodo.slice(5, 7)}`;
  return periodo.slice(5);
}

/* Genera todos los periodos entre dos fechas y los cruza con lo que sí hubo
   ventas, para que los días en cero también aparezcan en el gráfico. El
   relleno tiene que usar la MISMA granularidad del agrupado: rellenar por día
   una consulta semanal llenaba el gráfico de 30 columnas que decían "sem. 01/09"
   para un martes. */
function rellenarPeriodos(filas, g, desde, hasta) {
  const mapa = new Map(filas.map((r) => [r.periodo, r]));
  const claves = clavesPeriodo(g, desde, hasta).slice(0, 400);
  return claves.map((k) => {
    const r = mapa.get(k);
    return {
      periodo: k,
      etiqueta: etiquetaPeriodo(g, k),
      n: r ? r.n : 0,
      subtotal: r ? round2(r.subtotal) : 0,
      descuento: r ? round2(r.descuento) : 0,
      impuestos: r ? round2(r.impuestos) : 0,
      total: r ? round2(r.total) : 0,
      costo: r ? round2(r.costo) : 0,
      utilidad: r && r.utilidad !== undefined ? r.utilidad : 0,
    };
  });
}

/* AAAA-MM-DD en hora local. toISOString() convierte a UTC y en una zona con
   huso negativo se ir un día al otro: el lunes 31/08 podía salir 30/08. */
function isoLocal(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function dias(desde, hasta) {
  const out = [];
  const d = new Date(`${desde}T12:00:00`);
  const fin = new Date(`${hasta}T12:00:00`);
  while (d <= fin) { out.push(isoLocal(d)); d.setDate(d.getDate() + 1); }
  return out;
}

/* Los lunes de todas las semanas que toca el rango, que es como agrupa la
   consulta cuando la granularidad es semanal. */
function semanas(desde, hasta) {
  const out = [];
  const d = new Date(`${desde}T12:00:00`);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  const fin = new Date(`${hasta}T12:00:00`);
  while (d <= fin) { out.push(isoLocal(d)); d.setDate(d.getDate() + 7); }
  return out;
}

function meses(desde, hasta) {
  const out = [];
  let a = Number(desde.slice(0, 4)), m = Number(desde.slice(5, 7));
  const fa = Number(hasta.slice(0, 4)), fm = Number(hasta.slice(5, 7));
  while (a < fa || (a === fa && m <= fm)) {
    out.push(`${a}-${String(m).padStart(2, '0')}`);
    m += 1; if (m > 12) { m = 1; a += 1; }
  }
  return out;
}

function clavesPeriodo(g, desde, hasta) {
  if (g === 'mes') return meses(desde, hasta);
  if (g === 'semana') return semanas(desde, hasta);
  return dias(desde, hasta);
}

/* La ganancia es sobre la base: el IGV no es ingreso de la tienda, es del
   fisco, así que nunca puede sumar a la utilidad. Los gastos de la sucursal sí
   se restan, porque es plata que de verdad sale. */
async function gananciaYUtilidad(r, desde, hasta, sucursalId = 0) {
  const base = Number(r.subtotal || 0) - Number(r.descuento || 0);
  const ganancia = round2(base - Number(r.costo || 0));
  const gastos = round2((await db.prepare(
    `SELECT COALESCE(SUM(monto),0) AS m FROM gastos_sucursal
     WHERE date(fecha) BETWEEN ? AND ?${sucursalId ? ' AND sucursal_id = ?' : ''}`)
    .get(...(sucursalId ? [desde, hasta, sucursalId] : [desde, hasta]))).m);
  return { base: round2(base), ganancia, gastos, utilidad: round2(ganancia - gastos) };
}

/* Para el dueño lo que importa es qué tienda deja plata este mes, no solo qué
   tienda vendió más. Se descuenta el alquiler y los servicios ya pagados. */
async function utilidadPorSucursal(desde, hasta, empleado) {
  /* El asesor sólo ve la fila de su tienda: la utilidad de la otra es un dato
     de esa tienda, no del local donde él trabaja. */
  if (empleado.rol === 'tecnico' || (empleado.rol === 'asesor' && !empleado.sucursal_id)) return [];
  const av = ambitoSucursal(empleado, 'v');
  const ventas = (await db.prepare(`
    SELECT v.sucursal_id, COUNT(*) AS n, COALESCE(SUM(v.subtotal - v.descuento),0) AS base,
           COALESCE(SUM(v.costo_total),0) AS costo, COALESCE(SUM(v.total),0) AS total
    FROM ventas v WHERE v.estado='completada' AND date(v.fecha) BETWEEN ? AND ?${av.sql}
    GROUP BY v.sucursal_id`).all(desde, hasta, ...av.args));
  const gastos = (await db.prepare(`
    SELECT sucursal_id, COALESCE(SUM(monto),0) AS gasto FROM gastos_sucursal
    WHERE date(fecha) BETWEEN ? AND ? GROUP BY sucursal_id`).all(desde, hasta));
  const mapaGastos = new Map(gastos.map((g) => [g.sucursal_id, g.gasto]));
  const sucs = (await db.prepare('SELECT id, nombre, codigo, alquiler_mensual FROM sucursales ORDER BY nombre').all());
  const mapaSuc = new Map(sucs.map((s) => [s.id, s]));
  return ventas.map((v) => {
    const s = mapaSuc.get(v.sucursal_id);
    const g = round2(v.base - v.costo);
    const ga = round2(mapaGastos.get(v.sucursal_id) || 0);
    return {
      sucursal: s ? s.nombre : 'Sin sucursal',
      codigo: s ? s.codigo : '',
      n: v.n, total: round2(v.total), ganancia: g, gastos: ga, utilidad: round2(g - ga),
    };
  });
}

/* Los datos de la tienda y los del dueño que nos la alquila se guardan juntos:
   son los dos lados del mismo contrato, y el reporte los necesita a los dos. */
function datosSucursal(body, previo = {}) {
  const nombre = String(body.nombre ?? previo.nombre ?? '').trim();
  if (!nombre) throw new ApiError(400, 'El nombre es obligatorio');
  const alquiler = round2(Number(body.alquiler_mensual ?? previo.alquiler_mensual) || 0);
  if (alquiler < 0) throw new ApiError(400, 'El alquiler no puede ser negativo');
  const dia = Math.trunc(Number(body.dia_alquiler ?? previo.dia_alquiler) || 0);
  if (dia < 0 || dia > 31) throw new ApiError(400, 'El día de alquiler debe ir de 0 a 31');
  return {
    nombre,
    direccion: String(body.direccion ?? previo.direccion ?? ''),
    telefono: String(body.telefono ?? previo.telefono ?? ''),
    propietario_nombre: String(body.propietario_nombre ?? previo.propietario_nombre ?? '').trim(),
    propietario_dni: String(body.propietario_dni ?? previo.propietario_dni ?? '').trim(),
    propietario_telefono: String(body.propietario_telefono ?? previo.propietario_telefono ?? '').trim(),
    alquiler_mensual: alquiler,
    dia_alquiler: dia,
    notas: String(body.notas ?? previo.notas ?? ''),
  };
}

async function crearSucursal(body) {
  const d = datosSucursal(body);
  const codigo = String(body.codigo || '').trim().toUpperCase() || (await sigNumero('sucursales', 'S', 'codigo'));
  if ((await db.prepare('SELECT 1 FROM sucursales WHERE codigo = ?').get(codigo))) throw new ApiError(400, 'Ya existe una sucursal con ese código');
  const r = (await db.prepare(`INSERT INTO sucursales
      (codigo, nombre, direccion, telefono, propietario_nombre, propietario_dni,
       propietario_telefono, alquiler_mensual, dia_alquiler, notas)
      VALUES(?,?,?,?,?,?,?,?,?,?)`)
    .run(codigo, d.nombre, d.direccion, d.telefono, d.propietario_nombre, d.propietario_dni,
      d.propietario_telefono, d.alquiler_mensual, d.dia_alquiler, d.notas));
  const sucursalId = Number(r.lastInsertRowid);
  /* Al crear una sucursal nueva, generamos su caja de efectivo automáticamente.
     Así nunca queda una tienda sin un destino para cobrar en efectivo, aunque el
     administrador no entre a Configuración aún. */
  (await db.prepare(
    `INSERT INTO destinos_pago (sucursal_id, nombre, tipo, identificador, activo)
     SELECT ?, CONCAT('Caja ', ?), 'efectivo', '', 1
     WHERE NOT EXISTS (
       SELECT 1 FROM destinos_pago d WHERE d.sucursal_id = ? AND d.tipo = 'efectivo'
     )`
  ).run(sucursalId, d.nombre, sucursalId));
  return { sucursal: (await db.prepare(SUC_ONE).get(sucursalId)) };
}

async function actualizarSucursal(id, body, me) {
  const d = datosSucursal(body, me);
  const codigo = String(body.codigo || me.codigo).trim().toUpperCase();
  if ((await db.prepare('SELECT 1 FROM sucursales WHERE codigo = ? AND id != ?').get(codigo, id))) {
    throw new ApiError(400, 'Ya existe otra sucursal con ese código');
  }
  (await db.prepare(`UPDATE sucursales SET codigo=?, nombre=?, direccion=?, telefono=?,
      propietario_nombre=?, propietario_dni=?, propietario_telefono=?,
      alquiler_mensual=?, dia_alquiler=?, notas=?, activo=? WHERE id=?`)
    .run(codigo, d.nombre, d.direccion, d.telefono, d.propietario_nombre, d.propietario_dni,
      d.propietario_telefono, d.alquiler_mensual, d.dia_alquiler, d.notas,
      body.activo !== undefined ? (body.activo ? 1 : 0) : me.activo, id));
  return { sucursal: (await db.prepare(SUC_ONE).get(id)) };
}

async function datosGasto(body, previo = {}) {
  const sucursalId = Number(body.sucursal_id ?? previo.sucursal_id);
  if (!sucursalId) throw new ApiError(400, 'La sucursal es obligatoria');
  const s = (await db.prepare(SUC_ONE).get(sucursalId));
  if (!s) throw new ApiError(404, 'Sucursal no encontrada');
  const monto = round2(Number(body.monto ?? previo.monto) || 0);
  if (monto <= 0) throw new ApiError(400, 'El monto debe ser mayor a 0');
  const cat = String(body.categoria ?? previo.categoria ?? '').trim();
  if (!cat) throw new ApiError(400, 'La categoría es obligatoria');
  const concepto = String(body.concepto ?? previo.concepto ?? '').trim() || cat;
  const fecha = String(body.fecha ?? previo.fecha ?? hoyISO()).slice(0, 10);
  const mes = String(body.mes_cobro ?? previo.mes_cobro ?? fecha.slice(0, 7)).slice(0, 7);
  return {
    sucursal_id: sucursalId,
    categoria: cat,
    concepto,
    proveedor: String(body.proveedor ?? previo.proveedor ?? ''),
    monto,
    fecha,
    mes_cobro: mes,
    documento: String(body.documento ?? previo.documento ?? ''),
    notas: String(body.notas ?? previo.notas ?? ''),
  };
}

async function crearGasto(body, empleado) {
  const d = (await datosGasto(body));
  const r = (await db.prepare(`INSERT INTO gastos_sucursal
    (sucursal_id, categoria, concepto, proveedor, monto, fecha, mes_cobro, documento, notas, empleado_id)
    VALUES(?,?,?,?,?,?,?,?,?,?)`)
    .run(d.sucursal_id, d.categoria, d.concepto, d.proveedor, d.monto, d.fecha, d.mes_cobro, d.documento, d.notas, empleado.id));
  return { gasto: (await db.prepare(`${GASTO_SELECT} WHERE g.id = ?`).get(Number(r.lastInsertRowid))) };
}

async function actualizarGasto(id, body, me) {
  const d = (await datosGasto(body, me));
  (await db.prepare(`UPDATE gastos_sucursal SET sucursal_id=?, categoria=?, concepto=?, proveedor=?, monto=?, fecha=?, mes_cobro=?, documento=?, notas=? WHERE id=?`)
    .run(d.sucursal_id, d.categoria, d.concepto, d.proveedor, d.monto, d.fecha, d.mes_cobro, d.documento, d.notas, id));
  return { gasto: (await db.prepare(`${GASTO_SELECT} WHERE g.id = ?`).get(id)) };
}

/* La orden financia el total de la venta (productos más instalación) y el
   técnico cobra el saldo al terminar. Del saldo se separa lo que le
   corresponde al técnico, que es el costo de la instalación pactado en el
   mostrador, y lo que es de la tienda y el técnico devuelve en caja. */
async function conVistas(inst, empleado = null) {
  if (!inst) return inst;
  const financiado = Number(inst.monto_financiado) || Number(inst.costo) || 0;
  const pendiente = round2(financiado - inst.adelanto - inst.saldo_pagado);
  const paraTecnico = round2(Math.min(inst.costo, Math.max(0, pendiente)));
  /* La mercadería que la visita debe llevar, con lo ya entregado. Permite saber
     de un vistazo si la orden puede cerrarse o si falta entregar algo. Se traen
     el código y la unidad del producto porque el técnico las necesita delante
     para escanear: si no, tendría que buscarlas en el catálogo con la orden
     abierta y el teléfono en la mano. */
  const items = (await db.prepare(`
    SELECT it.*, p.codigo_barras, p.unidad AS producto_unidad, p.contenido
    FROM instalacion_items it LEFT JOIN productos p ON p.id = it.producto_id
    WHERE it.instalacion_id = ? ORDER BY it.id`).all(inst.id));
  const pendientes = items.filter((i) => i.cantidad_prevista > 0 && !i.fecha_entrega);
  const vista = {
    ...inst,
    monto_financiado: financiado,
    saldo_pendiente: pendiente,
    parte_tecnico: paraTecnico,
    parte_tienda: round2(Math.max(0, pendiente) - paraTecnico),
    pago_estado: pendiente <= 0 ? 'pagada' : inst.saldo_pagado > 0 ? 'parcial' : 'pendiente',
    puede_avanzar: TRANSICIONES[inst.estado] || [],
    /* Una foto sin saber quién la tomó y cuándo no prueba que la instalación
       se terminó, así que cada evidencia viaja con su autor y su fecha. El
       nombre del archivo en disco es un UUID: el que se le pone al descargar
       lo arma el servidor, en la ruta que la sirve. */
    evidencias: (await db.prepare(`
      SELECT e.id, e.created_at, emp.nombre AS empleado_nombre
      FROM instalacion_evidencias e LEFT JOIN empleados emp ON emp.id = e.empleado_id
      WHERE e.instalacion_id = ? AND e.vinculada = 1
      ORDER BY e.created_at, e.id`).all(inst.id)).map(e => ({
        id: e.id,
        url: `/api/instalaciones/${inst.id}/evidencias/${e.id}`,
        created_at: e.created_at,
        empleado_nombre: e.empleado_nombre,
      })),
    items,
    /* Cada cobro del saldo se guarda por separado con su destino, porque se
       puede cobrar en partes y cada parte puede haber ido a un lugar distinto.
       Los cobros anteriores a esta versión no tienen fila aquí: no se inventan,
       la vista los resume como "cobrados sin detalle de destino". */
    pagos: (await db.prepare(`
      SELECT p.id, p.fecha, p.monto, p.referencia, p.nota,
             d.nombre AS destino_nombre, d.tipo AS destino_tipo,
             d.identificador AS destino_identificador,
             emp.nombre AS recibido_por_nombre
      FROM instalacion_pagos p
      LEFT JOIN destinos_pago d ON d.id = p.destino_id
      LEFT JOIN empleados emp ON emp.id = p.recibido_por
      WHERE p.instalacion_id = ? ORDER BY p.fecha, p.id`).all(inst.id)),
    pendientes_entrega: pendientes.length,
    entrega_registrada: items.length > 0 && pendientes.length === 0,
  };
  /* La lista de acciones se calcula acá, en el servidor, y no en la pantalla:
     antes cada rol veía los mismos botones y el que no debía tocarlos se
     enteraba del error sólo después del 403. Ahora el botón y la regla salen
     del mismo sitio, así que no pueden separarse. */
  vista.puede_avanzar = transicionesInstalacion(vista, empleado);
  vista.acciones = accionesInstalacion(vista, empleado);
  return vista;
}

/* Qué se puede hacer con esta orden, para quien la está mirando. Es la misma
   lista que las funciones de abajo van a aceptar, así que un botón que aparece
   es un botón que el servidor va a dejar pasar. */
function transicionesInstalacion(inst, empleado) {
  if (!empleado) return [];
  let estados = [];
  if (empleado.rol === 'admin') estados = TRANSICIONES[inst.estado] || [];
  if (empleado.rol === 'tecnico' && inst.tecnico_id === empleado.id) {
    estados = FLUJO_LINEAL[inst.estado] || [];
    if (['programada', 'material_retirado'].includes(inst.estado) && !inst.pendientes_entrega) {
      estados = ['en_ruta'];
    }
  }
  return estados.filter((e) => e !== 'completada' || !inst.pendientes_entrega);
}

function accionesInstalacion(inst, empleado) {
  if (!empleado) return [];
  const admin = empleado.rol === 'admin';
  const propio = empleado.rol === 'tecnico' && inst.tecnico_id === empleado.id;
  const abierta = !['completada', 'cancelada'].includes(inst.estado);
  const acc = [];
  if (abierta && (admin || empleado.rol === 'asesor')) acc.push('editar', 'reprogramar', 'asignar');
  if (inst.puede_avanzar.length) acc.push(admin ? 'estado' : 'avanzar');
  if ((admin || propio) && ['en_progreso', 'completada'].includes(inst.estado) && inst.saldo_pendiente > 0) acc.push('cobrar');
  if (abierta && inst.pendientes_entrega > 0 && (admin || (propio && ['programada', 'material_retirado'].includes(inst.estado)))) acc.push('entrega');
  if (empleado.rol === 'tecnico' && !inst.tecnico_id && ['pendiente', 'programada'].includes(inst.estado)) acc.push('tomar');
  return acc;
}

async function resumenInstalaciones(lista) {
  const base = {
    total: lista.length, costo: 0, adelantos: 0, saldos_cobrados: 0,
    saldo_pendiente: 0, por_entregar: 0, sin_entregar: 0,
  };
  for (const e of ESTADOS_INSTALACION) base[e] = 0;
  for (const i of lista) {
    const v = (await conVistas(i));
    if (base[i.estado] !== undefined) base[i.estado]++;
    if (i.estado === 'completada') base.costo = round2(base.costo + i.costo);
    base.adelantos = round2(base.adelantos + i.adelanto);
    /* Órdenes con mercadería que el técnico todavía no retiró del almacén. */
    if (i.estado !== 'cancelada' && i.estado !== 'completada' && v.pendientes_entrega > 0) {
      base.sin_entregar++;
    }
    if (i.estado !== 'cancelada') {
      base.saldos_cobrados = round2(base.saldos_cobrados + i.saldo_pagado);
      base.saldo_pendiente = round2(base.saldo_pendiente + Math.max(0, v.saldo_pendiente));
      /* El saldo que cobra el técnico incluye dinero de la tienda: hasta que
         lo entrega en caja sigue estando por entregar. */      base.por_entregar = round2(base.por_entregar + v.parte_tienda);
    }
  }
  return base;
}

async function registrarHistorial(instalacionId, estado, comentario, empleadoId) {
  (await db.prepare('INSERT INTO instalacion_historial(instalacion_id, estado, comentario, empleado_id, fecha) VALUES(?,?,?,?,?)')
    .run(instalacionId, estado, comentario || '', empleadoId, ahora()));
}

async function asignarTecnico(inst, body, empleado) {
  const tecnicoId = Number(body?.tecnico_id) || null;
  if (tecnicoId) {
    const t = (await db.prepare("SELECT id, nombre, activo FROM empleados WHERE id = ? AND rol = 'tecnico'").get(tecnicoId));
    if (!t) throw new ApiError(400, 'El empleado indicado no es un técnico');
    if (!t.activo) throw new ApiError(400, 'El técnico indicado está inactivo');
  }
  if (['completada', 'cancelada'].includes(inst.estado)) {
    throw new ApiError(400, 'No se puede reasignar una instalación cerrada');
  }
  const nuevoEstado = inst.estado === 'pendiente' && tecnicoId ? 'programada' : inst.estado;
  (await db.exec('BEGIN'));
  try {
    (await validarDisponibilidadTecnico(tecnicoId, inst.fecha_programada, inst.hora_programada, inst.id));
    (await db.prepare('UPDATE instalaciones SET tecnico_id = ?, estado = ? WHERE id = ?').run(tecnicoId, nuevoEstado, inst.id));
    (await registrarHistorial(inst.id, nuevoEstado, tecnicoId
      ? `Técnico asignado: ${(await db.prepare('SELECT nombre FROM empleados WHERE id = ?').get(tecnicoId)).nombre}`
      : 'Técnico desasignado', empleado.id));
    (await db.exec('COMMIT'));
  } catch (err) {
    (await db.exec('ROLLBACK'));
    throw err;
  }
  return { instalacion: (await conVistas((await db.prepare(INSTALACION_SELECT + ' WHERE i.id = ?').get(inst.id)), empleado)) };
}

/* El técnico no salta pasos ni corrige estados: va en línea, de "en_ruta" a
   "en_progreso", y de ahí a cerrada. Cancelar o retomar una orden es del
   administrador, que es quien responde por el papel. El admin sí puede usar
   todas las transiciones de arriba, para regularizar. */
const FLUJO_LINEAL = { en_ruta: ['en_progreso'], en_progreso: ['completada'] };

/* Los mensajes de error van con el nombre del estado que entiende la gente, no
   con la clave de la base. */
const ETIQUETA_ESTADO = {
  pendiente: 'Pendiente', programada: 'Programada',
  material_retirado: 'Material retirado', en_ruta: 'En ruta',
  en_progreso: 'En progreso', completada: 'Completada', cancelada: 'Cancelada',
};
const estadoTexto = (e) => ETIQUETA_ESTADO[e] || e;

async function cambiarEstadoInstalacion(inst, body, empleado) {
  const nuevo = String(body?.estado || '');
  if (!ESTADOS_INSTALACION.includes(nuevo)) throw new ApiError(400, 'Estado inválido');
  if (nuevo === inst.estado) throw new ApiError(400, 'La orden ya está en ese estado');
  if (empleado.rol !== 'admin') {
    const suyos = (await conVistas(inst, empleado)).puede_avanzar;
    if (!suyos.includes(nuevo)) {
      throw new ApiError(400, `Desde "${estadoTexto(inst.estado)}" sólo se puede pasar a `
        + (suyos.length ? suyos.map(estadoTexto).join(' o ') : 'ningún estado: la orden va a otra persona'));
    }
  }
  const permitidos = TRANSICIONES[inst.estado] || [];
  if (!permitidos.includes(nuevo)) {
    throw new ApiError(400, `No se puede pasar de "${inst.estado}" a "${nuevo}"`);
  }
  exigirTecnicoDe(empleado, inst);

  const comentario = String(body?.comentario || '').trim();
  const campos = { estado: nuevo };
  if (nuevo === 'en_progreso' && !inst.fecha_inicio) campos.fecha_inicio = ahora();
  if (nuevo === 'completada') {
    /* Una orden con mercadería no se cierra hasta registrar qué se entregó:
       de lo contrario el stock nunca baja y el almacén descuadra. */
    const pendientes = (await db.prepare(`
      SELECT COUNT(*) AS c FROM instalacion_items
      WHERE instalacion_id = ? AND cantidad_prevista > 0 AND fecha_entrega = ''`).get(inst.id)).c;
    if (pendientes > 0) {
      throw new ApiError(400, `Falta registrar la entrega de ${pendientes} producto(s) antes de completar la orden`);
    }
    const ids = body.evidencias;
    if (!Array.isArray(ids) || ids.length < 1 || ids.length > 5 || new Set(ids).size !== ids.length || ids.some(id => typeof id !== 'string')) {
      throw new ApiError(400, 'Adjunta entre una y cinco fotos de la instalación terminada');
    }
    for (const id of ids) {
      const evidencia = await db.prepare('SELECT id FROM instalacion_evidencias WHERE id=? AND instalacion_id=? AND vinculada=0').get(id,inst.id);
      if (!evidencia) throw new ApiError(400, 'La evidencia no pertenece a esta instalación o ya fue utilizada');
    }
    for (const id of ids) await db.prepare('UPDATE instalacion_evidencias SET vinculada=1 WHERE id=?').run(id);
    campos.fecha_fin = ahora();
  }
  if (nuevo === 'programada') {
    const fecha = String(body?.fecha_programada || '').trim();
    const hora = String(body?.hora_programada || '').trim();
    if (fecha) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) throw new ApiError(400, 'Selecciona la fecha de la instalación');
      campos.fecha_programada = fecha;
    }
    if (hora) {
      if (!/^\d{2}:\d{2}$/.test(hora)) throw new ApiError(400, 'Selecciona la hora de la instalación');
      campos.hora_programada = hora;
    }
  }

  const sets = Object.keys(campos).map((k) => `${k} = ?`).join(', ');
  (await db.exec('BEGIN'));
  try {
    if (['pendiente', 'programada', 'material_retirado', 'en_ruta', 'en_progreso'].includes(nuevo)) {
      (await validarDisponibilidadTecnico(inst.tecnico_id, campos.fecha_programada ?? inst.fecha_programada,
        campos.hora_programada ?? inst.hora_programada, inst.id));
    }
    (await db.prepare(`UPDATE instalaciones SET ${sets} WHERE id = ?`).run(...Object.values(campos), inst.id));
    (await registrarHistorial(inst.id, nuevo, comentario, empleado.id));
    (await db.exec('COMMIT'));
  } catch (err) {
    (await db.exec('ROLLBACK'));
    throw err;
  }
  return { instalacion: (await conVistas((await db.prepare(INSTALACION_SELECT + ' WHERE i.id = ?').get(inst.id)), empleado)) };
}

async function crearInstalacion(datos) {
  (await validarDisponibilidadTecnico(datos.tecnicoId, datos.fechaProgramada, datos.horaProgramada));
  const codigo = (await sigNumero('instalaciones', (await getConfig('prefijo_instalacion')) || 'INS', 'codigo'));
  const estado = datos.tecnicoId ? 'programada' : 'pendiente';
  const r = (await db.prepare(`
    INSERT INTO instalaciones(codigo, fecha, venta_id, cliente_id, sucursal_id, producto_id, producto_nombre,
                             cantidad, tecnico_id, asesor_id, direccion, contacto, fecha_programada,
                             hora_programada, estado, reserva_stock, costo, adelanto, monto_financiado, notas)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  ).run(codigo, ahora(), datos.ventaId, datos.clienteId, datos.sucursalId, datos.productoId, datos.productoNombre,
    datos.cantidad, datos.tecnicoId, datos.asesorId, datos.direccion, datos.contacto,
    datos.fechaProgramada || '', datos.horaProgramada || '', estado, datos.reservaStock ? 1 : 0,
    datos.costo, datos.adelanto || 0, datos.montoFinanciado || datos.costo || 0, datos.notas || ''));
  const id = Number(r.lastInsertRowid);
  (await registrarHistorial(id, 'pendiente', 'Orden generada en el punto de venta', datos.asesorId));
  if (datos.tecnicoId) {
    const nombre = (await db.prepare('SELECT nombre FROM empleados WHERE id = ?').get(datos.tecnicoId))?.nombre || '';
    (await registrarHistorial(id, 'programada', `Visita agendada para el ${datos.fechaProgramada} a las ${datos.horaProgramada} · técnico ${nombre}`, datos.asesorId));
  }
  if (datos.adelanto > 0) {
    const financiado = datos.montoFinanciado || datos.costo || 0;
    (await registrarHistorial(id, 'adelanto',
      `Adelanto de S/${datos.adelanto.toFixed(2)} recibido en caja sobre un total de S/${financiado.toFixed(2)}`,
      datos.asesorId));
    const saldo = round2(financiado - datos.adelanto);
    if (saldo > 0) {
      (await registrarHistorial(id, 'adelanto',
        `Saldo de S/${saldo.toFixed(2)} a cobrar por el técnico al terminar `
        + `(honorarios S/${(datos.costo || 0).toFixed(2)} y S/${round2(saldo - (datos.costo || 0)).toFixed(2)} a entregar en tienda)`,
        datos.asesorId));
    }
  }
  return id;
}

/* Una cita ocupa al técnico en una fecha y hora exactas. Se consulta en el
   servidor para que todas las vías de creación y edición apliquen la misma
   regla; las órdenes cerradas no reservan horarios. */
async function validarDisponibilidadTecnico(tecnicoId, fecha, hora, excluirId = null) {
  if (!tecnicoId || !fecha || !hora) return;
  const choque = (await db.prepare(`
    SELECT id, codigo FROM instalaciones
    WHERE tecnico_id = ? AND fecha_programada = ? AND hora_programada = ?
      AND estado NOT IN ('completada','cancelada')
      AND (? IS NULL OR id <> ?)
    LIMIT 1`).get(tecnicoId, fecha, hora, excluirId, excluirId));
  if (!choque) return;
  const tecnico = (await db.prepare('SELECT nombre FROM empleados WHERE id = ?').get(tecnicoId))?.nombre || 'El técnico';
  throw new ApiError(409, `${tecnico} ya tiene la instalación ${choque.codigo} en ese horario (${fecha} ${hora})`);
}

/* El técnico retira la mercadería del almacén. Acá el stock físico baja de
   verdad: se descuenta lo entregado, se libera la reserva comprometida por la
   venta y queda registrado el movimiento de salida con su sucursal.
   Las órdenes anteriores a esta lógica ya descontaron el stock al vender, así
   que en ellas la entrega solo se documenta y no vuelve a mover el inventario.

   El técnico llega con el lector: manda los códigos que pasó y el servidor es
   el que decide qué producto es cada uno. No se confía en la pantalla, porque
   si el conteo viniera de ella un técnico podría "escanear" lo que quiso.

   Al terminar, la orden pasa sola a "en_ruta": el material ya salió del
   almacén y la visita está en marcha. Antes pasaba por "material_retirado",
   un estado que sólo quedaba un instante y que ahora es historia. */
async function registrarEntrega(inst, body, empleado) {
  exigirTecnicoDe(empleado, inst);
  if (['completada', 'cancelada'].includes(inst.estado)) {
    throw new ApiError(400, 'Esta orden ya está cerrada y no admite entregas');
  }
  if (empleado.rol === 'tecnico' && !['programada', 'material_retirado'].includes(inst.estado)) {
    throw new ApiError(400, 'El material se retira antes de iniciar la ruta');
  }
  const items = (await db.prepare('SELECT * FROM instalacion_items WHERE instalacion_id = ? ORDER BY id').all(inst.id));
  if (items.every((it) => it.fecha_entrega)) {
    throw new ApiError(400, 'La entrega de esta orden ya fue registrada');
  }

  const getProd = db.prepare('SELECT * FROM productos WHERE id = ?');
  const updateStock = db.prepare('UPDATE productos SET stock = ? WHERE id = ?');
  const updateReserva = db.prepare('UPDATE productos SET stock_reservado = ? WHERE id = ?');
  const insertMov = db.prepare(
    `INSERT INTO movimientos(producto_id, sucursal_id, tipo, cantidad, stock_despues, referencia, empleado_id, notas)
     VALUES(?,?,?,?,?,?,?,?)`);
  const updateItem = db.prepare(`
    UPDATE instalacion_items
    SET cantidad_entregada = ?, devueltas = ?, faltantes = ?, fecha_entrega = ?, registrado_por = ?
    WHERE id = ?`);

  /* Se lee el detalle antes de tocar nada: si viene mal no se ensucia la base. */
  const pedidas = new Map();
  const escaneos = Array.isArray(body?.escaneos) ? body.escaneos : null;

  if (empleado.rol === 'tecnico' && !escaneos) throw new ApiError(400, 'Debes escanear el material de la orden');
  if (body?.escaneos !== undefined && !escaneos) throw new ApiError(400, 'Escaneos inválidos');

  if (escaneos) {
    /* Camino del lector. Cada escaneo se resuelve contra el catálogo y se
       acumula sobre la línea de esa misma orden. */
    const leido = db.prepare('SELECT id, nombre FROM productos WHERE codigo_barras = ? AND activo = 1');
    const porItem = new Map();
    for (const esc of escaneos) {
      let codigo;
      try { codigo = normalizarCodigoBarras(String(esc?.codigo ?? '')); } catch { codigo = ''; }
      if (!codigo) throw new ApiError(400, 'Se recibió un código de barras ilegible');
      const p = (await leido.get(codigo));
      if (!p) throw new ApiError(400, `El código ${codigo} no pertenece a ningún producto activo`);
      const fila = items.find((x) => x.producto_id === p.id);
      /* Un producto que sí existe pero no está en esta orden es el error más
         común al tomar mercadería: se avisa por nombre, no en clave técnica. */
      if (!fila) throw new ApiError(400, `${p.nombre} no está en la orden ${inst.codigo}`);
      const veces = esc?.veces;
      if (!Number.isSafeInteger(veces) || veces <= 0) throw new ApiError(400, 'Cantidad de escaneos inválida');
      /* El modo de escaneo lo decide el técnico en el momento: puede llevar la
         caja completa o solo algunas piezas de ella. Si no manda modo, se usa
         el de la venta (compatibilidad con órdenes anteriores). */
      const modo = esc?.modo || body?.modo_escaneo || fila.modo_retiro || 'pza';
      if (!['pza', 'caja'].includes(modo)) throw new ApiError(400, 'Modo de escaneo inválido');
      const contenidoEmpaque = Math.max(1, Number(fila.contenido_empaque) || 1);
      if (modo === 'caja' && contenidoEmpaque <= 1) {
        throw new ApiError(400, `${p.nombre} no es un producto por cajas: no tiene contenido de empaque`);
      }
      const piezasPorLectura = modo === 'caja' ? contenidoEmpaque : 1;
      const piezas = veces * piezasPorLectura;
      porItem.set(fila.id, (porItem.get(fila.id) || 0) + piezas);
    }
    for (const [idItem, cant] of porItem) {
      const fila = items.find((x) => x.id === idItem);
      if (fila.fecha_entrega) throw new ApiError(400, `${fila.nombre} ya fue registrado en una entrega anterior`);
      if (cant > fila.cantidad_prevista) {
        throw new ApiError(400, `Escaneaste más de lo previsto en ${fila.nombre} `
          + `(previsto: ${fila.cantidad_prevista}, escaneado: ${cant})`);
      }
      pedidas.set(fila.id, { fila, cant, devueltas: 0 });
    }
    /* Y al revés: si una línea quedó a medias, la visita no arranca. Mejor que
       el técnico llegue a casa del cliente y falte un producto. */
    for (const fila of items) {
      if (fila.fecha_entrega) continue;
      const cant = pedidas.get(fila.id)?.cant ?? 0;
      if (cant < fila.cantidad_prevista) {
        const faltan = round2(fila.cantidad_prevista - cant);
        throw new ApiError(400, `Falta retirar ${faltan} pieza(s) de ${fila.nombre.toLowerCase()} `
          + `(retirado: ${cant} de ${fila.cantidad_prevista} piezas)`);
      }
    }
  } else {
    for (const it of (Array.isArray(body?.items) ? body.items : [])) {
      const fila = items.find((x) => x.id === Number(it.id ?? it.instalacion_item_id));
      if (!fila) throw new ApiError(404, 'Producto de la orden no encontrado');
      if (fila.fecha_entrega) throw new ApiError(400, `${fila.nombre} ya fue registrado en una entrega anterior`);
      const cant = round2(Number(it.cantidad_entregada ?? fila.cantidad_prevista));
      if (!Number.isFinite(cant) || cant < 0) throw new ApiError(400, `Cantidad inválida para ${fila.nombre}`);
      if (cant > fila.cantidad_prevista) {
        throw new ApiError(400, `No puedes entregar más de lo previsto en ${fila.nombre} (previsto: ${fila.cantidad_prevista})`);
      }
      const devueltas = Number(it.devueltas ?? 0);
      if (!Number.isFinite(devueltas) || devueltas < 0 || devueltas > cant) throw new ApiError(400, 'Cantidad devuelta inválida');
      pedidas.set(fila.id, { fila, cant, devueltas: round2(devueltas) });
    }
    /* Sin detalle se entiende que salió todo lo previsto: es la entrega normal. */
    for (const it of items) {
      if (!it.fecha_entrega && !pedidas.has(it.id)) pedidas.set(it.id, { fila: it, cant: it.cantidad_prevista, devueltas: 0 });
    }
  }

  const legacy = !inst.reserva_stock;
  const comentario = String(body?.comentario || '').trim();
  const movs = [];
  let nuevosEstado = inst.estado;

  (await db.exec('BEGIN'));
  try {
    for (const { fila, cant, devueltas } of pedidas.values()) {
      if (fila.producto_id) {
        const p = (await getProd.get(fila.producto_id));
        if (p) {
          if (legacy) {
            /* Ya salió del almacén cuando se vendió: no se vuelve a descontar. */
            if (cant > 0) {
              movs.push({ producto_id: p.id, cantidad: cant, stock_despues: p.stock, notas: 'Entrega de orden anterior al control de reserva' });
            }
          } else {
            /* La reserva era por la cantidad prevista completa: lo que no salió
               vuelve a estar disponible, así que se libera íntegro. */
            const stockNuevo = round2(p.stock - cant);
            if (cant > 0) {
              if (cant > p.stock) {
                throw new ApiError(400, `Stock insuficiente de ${p.nombre} para entregar (en almacén: ${p.stock})`);
              }
              (await updateStock.run(stockNuevo, p.id));
              movs.push({ producto_id: p.id, cantidad: cant, stock_despues: stockNuevo, notas: `Entrega de orden ${inst.codigo}` });
            }
            (await updateReserva.run(round2(Math.max(0, p.stock_reservado - fila.cantidad_prevista)), p.id));
          }
        }
      }
      (await updateItem.run(cant, devueltas, round2(fila.cantidad_prevista - cant), ahora(), empleado.id, fila.id));
    }
    for (const m of movs) {
      (await insertMov.run(m.producto_id, inst.sucursal_id, 'salida', m.cantidad, m.stock_despues, `Orden ${inst.codigo}`, empleado.id, m.notas));
    }
    /* La mercadería ya salió del almacén, así que la visita arranca sola: de
       "programada" se pasa directo a "en_ruta" sin pedirle nada a nadie. */
    if (['pendiente', 'programada', 'material_retirado'].includes(inst.estado)) nuevosEstado = 'en_ruta';
    (await db.prepare('UPDATE instalaciones SET estado = ? WHERE id = ?').run(nuevosEstado, inst.id));
    const nombres = [...pedidas.values()].map((x) => `${x.cant} x ${x.fila.nombre}`).join(', ');
    /* Aunque el estado final sea "en_ruta", los dos hitos quedan anotados: se
       ve cuándo se retiró la mercadería y desde cuándo va en camino. */
    if (nuevosEstado === 'en_ruta' && !['en_ruta', 'en_progreso', 'completada'].includes(inst.estado)) {
      (await registrarHistorial(inst.id, 'material_retirado', 'Mercadería retirada del almacén', empleado.id));
    }
    (await registrarHistorial(inst.id, nuevosEstado,
      nombres ? `Entrega registrada: ${nombres}${comentario ? ` · ${comentario}` : ''}`
        : `Sin mercadería que retirar${comentario ? ` · ${comentario}` : ''}`,
      empleado.id));

    (await db.exec('COMMIT'));
  } catch (err) {
    (await db.exec('ROLLBACK'));
    throw err;
  }

  return { instalacion: (await conVistas((await db.prepare(INSTALACION_SELECT + ' WHERE i.id = ?').get(inst.id)), empleado)) };
}

/* Edición de oficina: datos, técnico y cita se guardan juntos con su historial.
   Asignar técnico a una orden pendiente la programa; no admite estados arbitrarios. */
async function editarDatosInstalacion(inst, body, empleado) {
  if (['completada', 'cancelada'].includes(inst.estado)) {
    throw new ApiError(400, 'Esta orden ya está cerrada y sus datos no se modifican');
  }
  const campos = {};
  const etiquetas = { direccion: 'Dirección', contacto: 'Contacto', notas: 'Notas',
    fecha_programada: 'Fecha', hora_programada: 'Hora', tecnico_id: 'Técnico' };
  for (const campo of ['direccion', 'contacto', 'notas', 'fecha_programada', 'hora_programada']) {
    if (body?.[campo] !== undefined) campos[campo] = String(body[campo] ?? '').trim();
  }
  if (campos.direccion === '') throw new ApiError(400, 'La dirección no puede quedar vacía');
  if (campos.fecha_programada !== undefined && campos.fecha_programada !== '') {
    const fecha = campos.fecha_programada;
    const d = new Date(`${fecha}T12:00:00Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha) || !Number.isFinite(d.getTime()) || d.toISOString().slice(0, 10) !== fecha) {
      throw new ApiError(400, 'Selecciona una fecha válida');
    }
  }
  if (campos.hora_programada !== undefined && campos.hora_programada !== '' && !/^([01]\d|2[0-3]):[0-5]\d$/.test(campos.hora_programada)) {
    throw new ApiError(400, 'Selecciona una hora válida');
  }
  // Se conservan órdenes antiguas sin cita, pero una cita existente no se borra.
  for (const campo of ['fecha_programada', 'hora_programada']) {
    if (campos[campo] === '' && inst[campo]) throw new ApiError(400, 'La cita no puede quedar vacía');
  }
  if (body?.tecnico_id !== undefined) {
    const id = body.tecnico_id === null || body.tecnico_id === '' ? null : Number(body.tecnico_id);
    if (id !== null && (!Number.isSafeInteger(id) || id <= 0)) throw new ApiError(400, 'Técnico inválido');
    if (id !== null && !(await db.prepare("SELECT id FROM empleados WHERE id=? AND rol='tecnico' AND activo=1").get(id))) {
      throw new ApiError(400, 'El técnico indicado no existe o está inactivo');
    }
    campos.tecnico_id = id;
  }
  if (!Object.keys(campos).length) throw new ApiError(400, 'No se envió ningún dato para corregir');
  const cambios = Object.keys(campos).filter((k) => campos[k] !== inst[k]);
  if (!cambios.length) throw new ApiError(400, 'No cambió nada: los datos ya son esos');
  if (inst.estado === 'pendiente' && campos.tecnico_id) campos.estado = 'programada';
  const descripcion = (await Promise.all(cambios.map(async (k) => {
    const valor = async (v) => k === 'tecnico_id'
      ? (v ? (await db.prepare('SELECT nombre FROM empleados WHERE id=?').get(v))?.nombre || '—' : 'Sin asignar')
      : String(v || '—');
    return `${etiquetas[k]}: "${(await valor(inst[k]))}" → "${(await valor(campos[k]))}"`;
  }))).join(' · ');
  (await db.exec('BEGIN'));
  try {
    if (['tecnico_id', 'fecha_programada', 'hora_programada'].some((campo) => cambios.includes(campo))) {
      (await validarDisponibilidadTecnico(campos.tecnico_id ?? inst.tecnico_id,
        campos.fecha_programada ?? inst.fecha_programada, campos.hora_programada ?? inst.hora_programada, inst.id));
    }
    const sets = Object.keys(campos).map((k) => `${k} = ?`).join(', ');
    (await db.prepare(`UPDATE instalaciones SET ${sets} WHERE id = ?`).run(...Object.values(campos), inst.id));
    (await registrarHistorial(inst.id, 'datos', descripcion, empleado.id));
    if (campos.estado) (await registrarHistorial(inst.id, campos.estado, 'Orden programada al asignar técnico', empleado.id));
    (await db.exec('COMMIT'));
  } catch (err) {
    (await db.exec('ROLLBACK'));
    throw err;
  }
  return { instalacion: (await conVistas((await db.prepare(INSTALACION_SELECT + ' WHERE i.id = ?').get(inst.id)), empleado)) };
}

async function reprogramarInstalacion(inst, body, empleado) {
  /* Aquí no se exige ser el técnico asignado: la cita la mueve la oficina para
     llegar a tiempo con el cliente, no la cuadrilla en campo. El permiso
     `instalaciones:editar` ya lo comprobó el endpoint. */
  if (inst.estado === 'completada' || inst.estado === 'cancelada') {
    throw new ApiError(400, 'Esta orden ya no admite cambios de cita');
  }
  const fecha = String(body?.fecha_programada || '').trim();
  const hora = String(body?.hora_programada || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) throw new ApiError(400, 'Selecciona la fecha de la instalación');
  if (!/^\d{2}:\d{2}$/.test(hora)) throw new ApiError(400, 'Selecciona la hora de la instalación');
  const anterior = `${inst.fecha_programada} ${inst.hora_programada}`.trim();
  (await db.exec('BEGIN'));
  try {
    (await validarDisponibilidadTecnico(inst.tecnico_id, fecha, hora, inst.id));
    (await db.prepare('UPDATE instalaciones SET fecha_programada = ?, hora_programada = ? WHERE id = ?')
      .run(fecha, hora, inst.id));
    (await registrarHistorial(inst.id, 'cita', `Cita reprogramada: ${anterior || 'sin fecha'} → ${fecha} ${hora}`, empleado.id));
    (await db.exec('COMMIT'));
  } catch (err) {
    (await db.exec('ROLLBACK'));
    throw err;
  }
  return { instalacion: (await conVistas((await db.prepare(INSTALACION_SELECT + ' WHERE i.id = ?').get(inst.id)), empleado)) };
}

const TIPOS_DESTINO = ['efectivo', 'tarjeta', 'transferencia', 'yape'];
/* La referencia es el N° de operación del Yape o de la transferencia. Sin ella
   el registro dice "entró Yape por S/ 200" y no hay forma de saber cuál de los
   cuarenta Yape del día fue. En efectivo no aplica: no hay operación que buscar. */
const TIPOS_CON_REFERENCIA = ['yape', 'transferencia'];

/* Todo pago pasa por acá. El destino es la fuente de la verdad y de él se deduce
   el método, así que un pago a Yape no puede quedar guardado como efectivo: el
   cliente ya no manda el método, sólo la cuenta a la que se pagó. */
async function destinoDePago(body, sucursalId) {
  const id = Number(body.destino_id);
  if (!id) {
    throw new ApiError(400, 'Indica dónde recibió el pago: la caja, el número de Yape o la cuenta');
  }
  const d = await db.prepare('SELECT * FROM destinos_pago WHERE id = ?').get(id);
  if (!d) throw new ApiError(400, 'El destino de pago no existe');
  if (!d.activo) throw new ApiError(400, `El destino "${d.nombre}" está desactivado`);
  /* El efectivo no se transfiere por red: queda en la sucursal donde se cobró.
     Un destino en efectivo de otra tienda es un error de dedo, no un pago. */
  if (d.tipo === 'efectivo') {
    if (!d.sucursal_id) throw new ApiError(400, 'Un destino en efectivo debe pertenecer a una sucursal');
    if (sucursalId && Number(d.sucursal_id) !== Number(sucursalId)) {
      throw new ApiError(400, `"${d.nombre}" es la caja de otra sucursal`);
    }
  }
  const referencia = String(body.referencia || '').trim();
  if (TIPOS_CON_REFERENCIA.includes(d.tipo) && !referencia) {
    throw new ApiError(400, `Anota el N° de operación del pago por ${d.tipo}`);
  }
  return { destino: d, referencia, metodo: d.tipo };
}

async function cobrarSaldoInstalacion(inst, body, empleado) {
  exigirTecnicoDe(empleado, inst);
  if (inst.estado === 'cancelada') throw new ApiError(400, 'La orden está cancelada');
  /* El saldo se cobra cuando el trabajo ya está hecho o en marcha. Antes de
     empezar no se cobra: el cliente todavía no recibió nada. */
  if (!['en_progreso', 'completada'].includes(inst.estado)) {
    throw new ApiError(400, `El saldo se cobra cuando la instalación esté en progreso o completada `
      + `(ahora está en ${estadoTexto(inst.estado).toLowerCase()})`);
  }
  const vista = (await conVistas(inst, empleado));
  const pendiente = vista.saldo_pendiente;
  if (pendiente <= 0) throw new ApiError(400, 'Esta orden no tiene saldo pendiente');

  const monto = body?.monto === undefined || body.monto === null || body.monto === ''
    ? pendiente
    : round2(Number(body.monto));
  if (!Number.isFinite(monto) || monto <= 0) throw new ApiError(400, 'Monto de cobro inválido');
  if (monto > pendiente) {
    throw new ApiError(400, `El cobro no puede superar el saldo pendiente (S/${pendiente.toFixed(2)})`);
  }

  /* El técnico cobra el saldo completo, pero solo se queda con sus honorarios:
     el resto es dinero de la tienda y vuelve al caja. */
  const restante = round2(pendiente - monto);
  const paraTecnico = round2(Math.min(inst.costo, restante));

  /* En la casa del cliente no hay caja a la vista, así que se anota a qué
     número o cuenta llegó el dinero. Sin esto no hay forma de detectar que un
     Yape fue a cancelar el celular del técnico en vez de al número de la tienda. */
  const { destino, referencia } = await destinoDePago(body, inst.sucursal_id);

  const nota = `Cobro de S/${monto.toFixed(2)} · recibido en ${destino.nombre}`
    + `${referencia ? ` (op. ${referencia})` : ''}: honorarios S/${paraTecnico.toFixed(2)}, `
    + `entrega a tienda S/${round2(restante - paraTecnico).toFixed(2)}`;

  (await db.prepare('INSERT INTO instalacion_pagos(instalacion_id, fecha, monto, destino_id, referencia, recibido_por, nota) VALUES (?,?,?,?,?,?,?)')
    .run(inst.id, ahora(), monto, destino.id, referencia, empleado.id, ''));
  (await db.prepare('UPDATE instalaciones SET saldo_pagado = ?, fecha_pago_saldo = ?, saldo_recibido_por = ? WHERE id = ?')
    .run(round2(inst.saldo_pagado + monto), ahora(), empleado.id, inst.id));
  (await registrarHistorial(inst.id, 'saldo_pagado', nota, empleado.id));
  return { instalacion: (await conVistas((await db.prepare(INSTALACION_SELECT + ' WHERE i.id = ?').get(inst.id)), empleado)) };
}

async function crearVenta(body, empleado) {
  if (!body.items || !Array.isArray(body.items) || body.items.length === 0) {
    throw new ApiError(400, 'La venta no tiene productos');
  }
  const getProd = db.prepare('SELECT * FROM productos WHERE id = ?');
  const lineas = [];
  const usados = new Map();

  /* El stock vendible es el que queda libre: lo físico menos lo comprometido a
     ventas con instalación que aún no han retirado el material. */
  for (const it of body.items) {
    const p = (await getProd.get(Number(it.producto_id)));
    if (!p || !p.activo) throw new ApiError(404, 'Producto no encontrado');
    const cant = round2(Number(it.cantidad));
    if (!Number.isFinite(cant) || cant <= 0) throw new ApiError(400, `Cantidad inválida para ${p.nombre}`);
    const modoRetiro = it.modo_retiro === undefined ? 'pza' : String(it.modo_retiro);
    if (!['pza', 'caja'].includes(modoRetiro)) throw new ApiError(400, `Modo de venta inválido para ${p.nombre}`);
    const contenidoEmpaque = Math.max(1, Number(p.contenido) || 1);
    if (modoRetiro === 'caja' && (contenidoEmpaque <= 1 || Math.abs(cant / contenidoEmpaque - Math.round(cant / contenidoEmpaque)) > 0.0001)) {
      throw new ApiError(400, `La cantidad de ${p.nombre} no corresponde a cajas completas`);
    }
    if (usados.has(p.id)) throw new ApiError(400, `Producto duplicado en la venta: ${p.nombre}`);
    usados.set(p.id, true);
    const disponible = round2(p.stock - p.stock_reservado);
    if (cant > disponible) throw new ApiError(400, `Stock insuficiente de ${p.nombre} (disponible: ${disponible})`);
    const sub = round2(p.precio * cant);
    lineas.push({ p, cant, precio: p.precio, sub, costoLinea: round2(p.costo * cant), modoRetiro, contenidoEmpaque });
  }

  /* La instalación es un servicio que el asesor cotiza en el mostrador: llega
     ya con su precio y no depende de que el producto la tenga marcada. Se
     guarda como una línea propia para que salga en el ticket y en el detalle. */
  const inst = body.instalacion && typeof body.instalacion === 'object' ? body.instalacion : {};
  const conInstalacion = Object.keys(inst).length > 0;
  const costoInst = conInstalacion ? Math.max(0, round2(Number(inst.precio) || 0)) : 0;
  if (conInstalacion && costoInst <= 0) {
    throw new ApiError(400, 'Indica el costo de la instalación a domicilio');
  }

  const igv = Number((await getConfig('iva'))) || 16;
  const subTotal = round2(lineas.reduce((a, l) => a + l.sub, 0) + costoInst);
  const descto = round2(Math.max(0, Number(body.descuento) || 0));
  if (descto > subTotal) throw new ApiError(400, 'El descuento no puede exceder el subtotal');
  const base = round2(subTotal - descto);
  const impuestos = round2(base * (igv / 100));
  const total = round2(base + impuestos);
  const costoTotal = round2(lineas.reduce((a, l) => a + l.costoLinea, 0));
  const clienteId = body.cliente_id ? Number(body.cliente_id) : null;

  /* La venta siempre pertenece a la sucursal donde está afiliado el asesor:
     el punto de venta no puede mover mercadería entre sucursales. */
  const sucursalId = empleado.sucursal_id;
  if (!sucursalId) {
    throw new ApiError(400, 'Tu usuario no está afiliado a una sucursal. Comunícate con el administrador.');
  }

  /* El método se deduce del destino. Antes se leía del cuerpo y, si no era uno
     de los tres conocidos, se guardaba 'efectivo' en silencio: un Yape quedaba
     registrado como plata en caja sin que nadie se enterara. */
  const { destino, referencia, metodo } = await destinoDePago(body, sucursalId);

  /* Datos de la visita: técnico, fecha, hora y adelanto. */
  let tecnicoId = inst.tecnico_id ? Number(inst.tecnico_id) : null;
  if (tecnicoId) {
    const t = (await db.prepare("SELECT id FROM empleados WHERE id = ? AND rol = 'tecnico' AND activo = 1").get(tecnicoId));
    if (!t) throw new ApiError(400, 'El técnico indicado no existe o está inactivo');
  }
  const direccion = conInstalacion ? String(inst.direccion || '').trim() : '';
  if (conInstalacion && !direccion) {
    throw new ApiError(400, 'La instalación a domicilio requiere la dirección de entrega');
  }
  if (conInstalacion && !clienteId) {
    throw new ApiError(400, 'Registra al cliente para poder coordinar la instalación a domicilio');
  }

  /* Para agendar hay que fijar día y hora de la visita. */
  const fechaCita = conInstalacion ? String(inst.fecha_programada || '').trim() : '';
  const horaCita = conInstalacion ? String(inst.hora_programada || '').trim() : '';
  if (conInstalacion) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fechaCita)) {
      throw new ApiError(400, 'Selecciona la fecha de la instalación');
    }
    if (!/^\d{2}:\d{2}$/.test(horaCita)) {
      throw new ApiError(400, 'Selecciona la hora de la instalación');
    }
  }

  /* El adelanto es la garantía que el cliente entrega en el mostrador: no
     cubre la venta, la financia. El resto lo cobra el técnico al terminar. */
  const adelanto = conInstalacion ? round2(Number(inst.adelanto) || 0) : 0;
  if (conInstalacion && adelanto <= 0) {
    throw new ApiError(400, 'Registra el adelanto del cliente para validar la instalación');
  }
  if (adelanto > total) {
    throw new ApiError(400, `El adelanto no puede superar el total de la venta (S/${total.toFixed(2)})`);
  }

  /* Lo que entra a la caja ahora es el adelanto; sin instalación, la venta
     completa. El sobrante es cambio y no se guarda como cobrado. */
  const recibido = Number(body.monto_pagado);
  const montoPagado = round2(Number.isFinite(recibido) && recibido > 0 ? recibido : (conInstalacion ? adelanto : total));
  const cobradoCaja = conInstalacion ? adelanto : total;
  if (conInstalacion && montoPagado + 0.01 < adelanto) {
    throw new ApiError(400, `El pago en caja debe cubrir el adelanto (S/${adelanto.toFixed(2)})`);
  }

  const numero = (await sigNumero('ventas', (await getConfig('prefijo_venta')) || 'V'));

  const insertVenta = db.prepare(`
    INSERT INTO ventas(numero, fecha, cliente_id, empleado_id, sucursal_id, subtotal, descuento, impuestos, total, costo_total, metodo_pago, monto_pagado, destino_id, referencia, notas)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const insertItem = db.prepare(
    'INSERT INTO venta_items(venta_id, producto_id, nombre, cantidad, precio, precio_instalacion, costo, subtotal) VALUES(?,?,?,?,?,?,?,?)');
  const updateStock = db.prepare('UPDATE productos SET stock = ? WHERE id = ?');
  const updateReserva = db.prepare('UPDATE productos SET stock_reservado = ? WHERE id = ?');
  const insertMov = db.prepare(
    `INSERT INTO movimientos(producto_id, sucursal_id, tipo, cantidad, stock_despues, referencia, empleado_id, notas)
     VALUES(?,?,?,?,?,?,?,?)`);

  let ventaId;
  const creadas = [];
  (await db.exec('BEGIN'));
  try {
    const r = (await insertVenta.run(numero, ahora(), clienteId, empleado.id, sucursalId, subTotal, descto, impuestos, total, costoTotal, metodo, montoPagado, destino.id, referencia, body.notas || ''));
    ventaId = Number(r.lastInsertRowid);
    for (const l of lineas) {
      (await insertItem.run(ventaId, l.p.id, l.p.nombre, l.cant, l.precio, 0, l.p.costo, l.sub));
      /* Sin instalación la mercadería sale ahora. Con instalación queda
         comprometida en el almacén y baja recién cuando el técnico la
         retira, así que no se registra movimiento todavía. */
      if (conInstalacion) {
        (await updateReserva.run(round2(l.p.stock_reservado + l.cant), l.p.id));
      } else {
        const nuevo = round2(l.p.stock - l.cant);
        (await updateStock.run(nuevo, l.p.id));
        (await insertMov.run(l.p.id, sucursalId, 'venta', l.cant, nuevo, `Venta ${numero}`, empleado.id, ''));
      }
    }
    /* La instalación viaja como línea de servicio: sin producto_id, por eso no
       toca stock ni los reportes de mercadería. */
    if (conInstalacion) {
      (await insertItem.run(ventaId, null, SERVICIO_INSTALACION, 1, costoInst, 0, 0, costoInst));
    }
    if (conInstalacion) {
      /* Una sola visita por venta: el técnico va una vez, no una por producto. */
      const nuevaId = (await crearInstalacion({
        ventaId, clienteId, sucursalId, productoId: null,
        productoNombre: SERVICIO_INSTALACION,
        cantidad: 1, tecnicoId, asesorId: empleado.id,
        direccion, contacto: String(inst.contacto || '').trim(),
        fechaProgramada: fechaCita, horaProgramada: horaCita,
        costo: costoInst, adelanto, montoFinanciado: total,
        reservaStock: 1,
        notas: [
          lineas.map((l) => `${l.cant} x ${l.p.nombre}`).join(', '),
          String(inst.notas || '').trim(),
        ].filter(Boolean).join(' · '),
      }));
      /* Cada producto vendido queda anotado como lo que la visita debe llevar.
         Sin esta lista el técnico no sabe qué retirar del almacén. */
      const insertInstItem = db.prepare(`
        INSERT INTO instalacion_items(instalacion_id, producto_id, nombre, cantidad_prevista, modo_retiro, contenido_empaque)
        VALUES(?,?,?,?,?,?)`);
      for (const l of lineas) {
        (await insertInstItem.run(nuevaId, l.p.id, l.p.nombre, l.cant, l.modoRetiro, l.contenidoEmpaque));
      }
      creadas.push(nuevaId);
    }
    (await db.exec('COMMIT'));
  } catch (err) {
    (await db.exec('ROLLBACK'));
    throw err;
  }

  const venta = (await db.prepare('SELECT * FROM ventas WHERE id = ?').get(ventaId));
  Object.assign(venta, {
    destino_nombre: destino.nombre,
    destino_tipo: destino.tipo,
    destino_identificador: destino.identificador || '',
  });
  venta.items = (await db.prepare('SELECT * FROM venta_items WHERE venta_id = ?').all(ventaId));
  venta.instalaciones = (await Promise.all((await db.prepare(INSTALACION_SELECT + ' WHERE i.venta_id = ?').all(ventaId)).map(async (i) => (await conVistas(i, empleado)))));
  venta.cliente_nombre = clienteId
    ? (await db.prepare('SELECT nombre FROM clientes WHERE id = ?').get(clienteId))?.nombre
    : 'Público General';
  const sucursal = (await db.prepare('SELECT nombre, direccion, telefono FROM sucursales WHERE id = ?').get(sucursalId));
  venta.sucursal_nombre = sucursal?.nombre || null;
  venta.sucursal_direccion = sucursal?.direccion || '';
  venta.sucursal_telefono = sucursal?.telefono || '';
  venta.cambio = metodo === 'efectivo' ? round2(Math.max(0, montoPagado - cobradoCaja)) : 0;
  venta.igv_rate = igv;
  return { venta, instalaciones: creadas.length };
}

async function anularVenta(id, empleado, motivo) {
  const venta = (await db.prepare('SELECT * FROM ventas WHERE id = ?').get(id));
  if (!venta) throw new ApiError(404, 'Venta no encontrada');
  if (venta.estado !== 'completada') throw new ApiError(400, 'La venta ya no puede anularse');
  /* Con instalación no se anula una venta ya financiada en la calle: si el
     técnico cobró saldo, o si la visita ya salió del almacén o empezó, el
     producto está en manos del cliente y devolverlo al stock descuadra el
     inventario. */
  const ordenes = (await db.prepare("SELECT * FROM instalaciones WHERE venta_id = ? AND estado <> 'cancelada'").all(id));
  for (const o of ordenes) {
    if (o.saldo_pagado > 0) {
      throw new ApiError(400, `La orden ${o.codigo} ya tiene saldo cobrado por el técnico. Regulariza la orden antes de anular la venta.`);
    }
    if (['material_retirado', 'en_ruta', 'en_progreso', 'completada'].includes(o.estado)) {
      throw new ApiError(400, `La orden ${o.codigo} está en estado ${o.estado}. La mercadería ya salió del almacén, así que la venta no puede anularse.`);
    }
  }
  const items = (await db.prepare('SELECT * FROM venta_items WHERE venta_id = ?').all(id));
  const getProd = db.prepare('SELECT * FROM productos WHERE id = ?');
  const updateStock = db.prepare('UPDATE productos SET stock = ? WHERE id = ?');
  const updateReserva = db.prepare('UPDATE productos SET stock_reservado = ? WHERE id = ?');
  const insertMov = db.prepare(
    `INSERT INTO movimientos(producto_id, sucursal_id, tipo, cantidad, stock_despues, referencia, empleado_id, notas)
     VALUES(?,?,?,?,?,?,?,?)`);
  /* Si la venta dejaba mercadería reservada en el almacén, la anulación libera
     esa reserva. Si ya había salido, el stock se devuelve como antes. */
  const conReserva = ordenes.length > 0;
  (await db.exec('BEGIN'));
  /* Se declara fuera del try porque el resumen de la respuesta lo necesita. */
  let abiertas = [];
  try {
    (await db.prepare("UPDATE ventas SET estado='anulada', notas = (CASE WHEN ? != '' THEN ? ELSE notas END) WHERE id=?").run(motivo || '', motivo || '', id));
    for (const it of items) {
      const p = (await getProd.get(it.producto_id));
      if (!p) continue;
      if (conReserva) {
        (await updateReserva.run(round2(Math.max(0, p.stock_reservado - it.cantidad)), p.id));
      } else {
        const nuevo = round2(p.stock + it.cantidad);
        (await updateStock.run(nuevo, p.id));
        (await insertMov.run(p.id, venta.sucursal_id, 'ajuste', it.cantidad, nuevo, `Anulación ${venta.numero}`, empleado.id, 'Devolución de stock'));
      }
    }
    /* Las órdenes de servicio que aún no salieron se cancelan con la venta. */
    abiertas = (await db.prepare("SELECT id FROM instalaciones WHERE venta_id = ? AND estado IN ('pendiente','programada')").all(id));
    for (const inst of abiertas) {
      (await db.prepare("UPDATE instalaciones SET estado='cancelada' WHERE id=?").run(inst.id));
      (await registrarHistorial(inst.id, 'cancelada', 'Venta anulada', empleado.id));
    }
    (await db.exec('COMMIT'));
  } catch (err) {
    (await db.exec('ROLLBACK'));
    throw err;
  }
  return {
    ok: true,
    venta: (await db.prepare('SELECT * FROM ventas WHERE id = ?').get(id)),
    instalaciones_canceladas: abiertas.length,
  };
}

async function crearCompra(body, empleado) {
  if (!body.proveedor_id) throw new ApiError(400, 'Seleccione un proveedor');
  if (!body.items || !Array.isArray(body.items) || body.items.length === 0) throw new ApiError(400, 'La compra no tiene productos');
  const getProd = db.prepare('SELECT * FROM productos WHERE id = ?');
  const lineas = [];
  const usados = new Set();
  let subTotal = 0;
  for (const it of body.items) {
    const p = (await getProd.get(Number(it.producto_id)));
    if (!p) throw new ApiError(404, 'Producto no encontrado');
    if (usados.has(p.id)) throw new ApiError(400, `Producto duplicado: ${p.nombre}`);
    usados.add(p.id);
    const cont = p.contenido > 0 ? p.contenido : 1;
    const cajas = Number(it.cajas);
    const costoCaja = Number(it.costo_caja);
    const porCajas = Number.isFinite(cajas) && cajas > 0 && Number.isFinite(costoCaja) && costoCaja >= 0;
    let cant;
    let precio;
    let sub;
    /* El formulario puede mandar la línea como cajas cuando el proveedor
       factura la bolsa o la caja entera. Lo que se guarda sigue siendo en
       piezas, que es como se cuenta el stock, pero el subtotal sale del precio
       de la caja para que la orden cuadre con la factura. La cantidad se calcula
       con el contenido del servidor, no con el que mande el cliente. */
    if (porCajas) {
      const nb = Math.max(1, Math.trunc(cajas));
      cant = round2(nb * cont);
      precio = costoCaja > 0 ? round2(costoCaja / cont) : 0;
      sub = round2(nb * costoCaja);
    } else {
      cant = Number(it.cantidad);
      precio = round2(Number(it.costo) || p.costo);
      if (!Number.isFinite(cant) || cant <= 0) throw new ApiError(400, `Cantidad inválida para ${p.nombre}`);
      if (precio < 0) throw new ApiError(400, 'Costo inválido');
      sub = round2(cant * precio);
    }
    lineas.push({ p, cant, precio, sub });
    subTotal = round2(subTotal + sub);
  }
  const igv = Number((await getConfig('iva'))) || 16;
  const impuestos = round2(subTotal * (igv / 100));
  const total = round2(subTotal + impuestos);
  const numero = (await sigNumero('compras', (await getConfig('prefijo_compra')) || 'C'));
  const proveedor = (await db.prepare('SELECT * FROM proveedores WHERE id = ?').get(Number(body.proveedor_id)));
  if (!proveedor) throw new ApiError(404, 'Proveedor no encontrado');

  const insertCompra = db.prepare(`
    INSERT INTO compras(numero, fecha, proveedor_id, empleado_id, subtotal, impuestos, total, estado, notas)
    VALUES(?, DATE_FORMAT(NOW(), '%Y-%m-%d %H:%i:%s'), ?, ?, ?, ?, ?, 'pendiente', ?)`);
  const insertItem = db.prepare(
    'INSERT INTO compra_items(compra_id, producto_id, nombre, cantidad, costo, subtotal) VALUES(?,?,?,?,?,?)');
  const r = (await insertCompra.run(numero, proveedor.id, empleado.id, subTotal, impuestos, total, body.notas || ''));
  const compraId = Number(r.lastInsertRowid);
  for (const l of lineas) (await insertItem.run(compraId, l.p.id, l.p.nombre, l.cant, l.precio, l.sub));
  const compra = (await db.prepare('SELECT * FROM compras WHERE id = ?').get(compraId));
  compra.items = (await db.prepare('SELECT * FROM compra_items WHERE compra_id = ?').all(compraId));
  compra.proveedor_nombre = proveedor.nombre;
  return { compra };
}

/* Recepción por lector: lo que entra al almacén es lo que se escaneó, no lo que
   se pidió. El formulario manda, por línea, cuántos escaneos hubo; cada escaneo
   suma el contenido del producto (una caja de 12 con contenido 12 suma 12).
   Si no llega ninguna cantidad se toma lo pedido, que es como se recibía antes
   del lector. */
async function recibirCompra(id, empleado, recibido) {
  const me = (await db.prepare('SELECT * FROM compras WHERE id = ?').get(id));
  if (!me) throw new ApiError(404, 'Compra no encontrada');
  if (me.estado !== 'pendiente') throw new ApiError(400, 'Solo se pueden recibir compras pendientes');
  const items = (await db.prepare('SELECT * FROM compra_items WHERE compra_id = ?').all(id));
  const getProd = db.prepare('SELECT * FROM productos WHERE id = ?');
  const updateStock = db.prepare('UPDATE productos SET stock = ?, costo = ? WHERE id = ?');
  const setCantidadRecibida = db.prepare('UPDATE compra_items SET cantidad_recibida = ? WHERE id = ?');
  const insertMov = db.prepare(
    `INSERT INTO movimientos(producto_id, sucursal_id, tipo, cantidad, stock_despues, referencia, empleado_id, notas)
     VALUES(?,?,?,?,?,?,?,?)`);

  /* Convierte lo que llega del formulario en unidades de stock por línea. La
     clave es el id de la línea, no el producto, para no confundir dos líneas
     del mismo producto. */
  const escaneos = new Map();
  if (Array.isArray(recibido)) {
    for (const r of recibido) {
      const linea = Number(r?.item);
      const veces = Number(r?.escaneos);
      if (!Number.isInteger(linea) || !Number.isFinite(veces)) continue;
      escaneos.set(linea, Math.max(0, Math.trunc(veces)));
    }
  }

  const detalle = [];
  (await db.exec('BEGIN'));
  try {
    for (const it of items) {
      const p = (await getProd.get(it.producto_id));
      if (!p) continue;
      const contenido = p.contenido > 0 ? p.contenido : 1;
      const veces = escaneos.has(it.id) ? escaneos.get(it.id) : null;
      const recibidoStock = veces === null ? it.cantidad : round2(veces * contenido);
      (await setCantidadRecibida.run(recibidoStock, it.id));

      if (recibidoStock !== it.cantidad) {
        detalle.push({
          producto_id: p.id,
          nombre: p.nombre,
          pedido: it.cantidad,
          recibido: recibidoStock,
          escaneos: veces,
          diferencia: round2(recibidoStock - it.cantidad),
        });
      }
      if (recibidoStock === 0) continue;

      const stockNuevo = round2(p.stock + recibidoStock);
      /* El costo de la orden es por unidad de stock. Si se recibió otra
         cantidad, el costo real de lo que entró cambia. */
      const costoNuevo = stockNuevo > 0
        ? round2((p.stock * p.costo + recibidoStock * it.costo) / stockNuevo)
        : it.costo;
      (await updateStock.run(stockNuevo, costoNuevo, p.id));
      const nota = veces === null ? '' : `${veces} escaneo(s) x ${contenido}`;
      (await insertMov.run(p.id, empleado.sucursal_id, 'compra', recibidoStock, stockNuevo, `Compra ${me.numero}`, empleado.id, nota));
    }
    (await db.prepare("UPDATE compras SET estado='recibida' WHERE id=?").run(id));
    (await db.exec('COMMIT'));
  } catch (err) {
    (await db.exec('ROLLBACK'));
    throw err;
  }
  return { ok: true, diferencias: detalle };
}

async function crearEmpleado(body) {
  if (!body.nombre) throw new ApiError(400, 'El nombre es obligatorio');
  const usuario = String(body.usuario || '').trim().toLowerCase();
  if (!usuario) throw new ApiError(400, 'El usuario es obligatorio');
  if (!body.clave || String(body.clave).length < 4) throw new ApiError(400, 'La contraseña debe tener al menos 4 caracteres');
  if (!['admin', 'asesor', 'tecnico'].includes(body.rol)) throw new ApiError(400, 'Rol inválido');
  if ((await db.prepare('SELECT 1 FROM empleados WHERE usuario = ?').get(usuario))) throw new ApiError(400, 'Ese nombre de usuario ya existe');
  const sucursalId = (await normalizarSucursal(body.sucursal_id));
  const r = (await db.prepare('INSERT INTO empleados(nombre, usuario, clave_hash, rol, sucursal_id, telefono) VALUES(?,?,?,?,?,?)')
    .run(String(body.nombre).trim(), usuario, hashPassword(String(body.clave)), body.rol, sucursalId, body.telefono || ''));
  return { empleado: (await db.prepare('SELECT id, nombre, usuario, rol, telefono, activo, sucursal_id FROM empleados WHERE id = ?').get(Number(r.lastInsertRowid))) };
}

async function actualizarEmpleado(id, body, me) {
  const nombre = body.nombre ?? me.nombre;
  const usuario = String(body.usuario || me.usuario).trim().toLowerCase();
  const rol = body.rol || me.rol;
  if (!['admin', 'asesor', 'tecnico'].includes(rol)) throw new ApiError(400, 'Rol inválido');
  if ((await db.prepare('SELECT 1 FROM empleados WHERE usuario = ? AND id != ?').get(usuario, id))) {
    throw new ApiError(400, 'Ese nombre de usuario ya existe');
  }
  const activo = body.activo !== undefined ? (body.activo ? 1 : 0) : me.activo;
  /* No se puede dejar la empresa sin nadie con un rol. */
  if (me.activo && !activo) {
    const quedan = (await db.prepare('SELECT COUNT(*) AS c FROM empleados WHERE rol = ? AND activo = 1 AND id != ?').get(rol, id)).c;
    if (quedan === 0) throw new ApiError(400, 'Debe quedar al menos un empleado activo con ese rol');
  }
  const sucursalId = (await normalizarSucursal(body.sucursal_id ?? me.sucursal_id));
  if (body.clave && String(body.clave).length < 4) throw new ApiError(400, 'La contraseña debe tener al menos 4 caracteres');
  if (body.clave) {
    (await db.prepare('UPDATE empleados SET nombre=?, usuario=?, clave_hash=?, rol=?, sucursal_id=?, telefono=?, activo=? WHERE id=?')
      .run(nombre, usuario, hashPassword(String(body.clave)), rol, sucursalId, body.telefono ?? me.telefono, activo, id));
  } else {
    (await db.prepare('UPDATE empleados SET nombre=?, usuario=?, rol=?, sucursal_id=?, telefono=?, activo=? WHERE id=?')
      .run(nombre, usuario, rol, sucursalId, body.telefono ?? me.telefono, activo, id));
  }
  return { empleado: (await db.prepare('SELECT id, nombre, usuario, rol, telefono, activo, sucursal_id FROM empleados WHERE id = ?').get(id)) };
}

async function normalizarSucursal(valor) {
  if (valor === undefined || valor === null || valor === '') return null;
  const id = Number(valor);
  if (!id) return null;
  if (!(await db.prepare('SELECT 1 FROM sucursales WHERE id = ?').get(id))) throw new ApiError(400, 'Sucursal inválida');
  return id;
}

export { handler, exigir, exigirTecnicoDe, puedeVerInstalacion };
