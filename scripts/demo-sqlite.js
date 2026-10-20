import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { scryptSync, randomBytes, timingSafeEqual } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'data');
const DB_PATH = process.env.DEMO_SQLITE_PATH;
if (!DB_PATH || !resolve(DB_PATH).startsWith(join(tmpdir(), 'retail-tests-'))) throw new Error('DEMO_SQLITE_PATH must be inside an isolated retail-tests-* directory; this script only generates disposable fixtures');

mkdirSync(dirname(DB_PATH), { recursive: true });

export const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

export const ROLES = ['admin', 'asesor', 'tecnico'];

/* Los estados siguen el recorrido de la mercadería: se reserva al vender, sale
   del almacén cuando el técnico la retira, viaja, se instala y termina. */
export const ESTADOS_INSTALACION = ['pendiente', 'programada', 'material_retirado', 'en_ruta', 'en_progreso', 'completada', 'cancelada'];

export function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

export function verifyPassword(password, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [salt, hash] = stored.split(':');
  const candidate = scryptSync(password, salt, 64);
  const expected = Buffer.from(hash, 'hex');
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}

export function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS categorias (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nombre TEXT NOT NULL UNIQUE,
  descripcion TEXT DEFAULT '',
  creado_en TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

/* Una sucursal es una tienda alquilada, así que además de su dirección tiene
   los datos de quien nos la alquila y el alquiler que se le paga. */
CREATE TABLE IF NOT EXISTS sucursales (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  codigo TEXT NOT NULL UNIQUE,
  nombre TEXT NOT NULL,
  direccion TEXT DEFAULT '',
  telefono TEXT DEFAULT '',
  propietario_nombre TEXT DEFAULT '',
  propietario_dni TEXT DEFAULT '',
  propietario_telefono TEXT DEFAULT '',
  /* Alquiler mensual pactado y día del mes en que vence (0 = sin vencimiento).
     El pago en sí se registra en gastos_sucursal, como los servicios. */
  alquiler_mensual REAL NOT NULL DEFAULT 0,
  dia_alquiler INTEGER NOT NULL DEFAULT 0,
  notas TEXT DEFAULT '',
  activo INTEGER NOT NULL DEFAULT 1,
  creado_en TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

/* Pagos de alquiler y servicios (luz, agua, internet) de cada tienda. Es la
   contraparte de lo que entra por ventas: lo que sale por gastos. Lo que se
   guarda es el pago real; el alquiler esperado vive en la sucursal. */
CREATE TABLE IF NOT EXISTS gastos_sucursal (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sucursal_id INTEGER NOT NULL REFERENCES sucursales(id) ON DELETE CASCADE,
  categoria TEXT NOT NULL DEFAULT 'otros',
  concepto TEXT NOT NULL DEFAULT '',
  proveedor TEXT DEFAULT '',
  monto REAL NOT NULL DEFAULT 0,
  fecha TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  /* Mes al que se imputa el gasto ('YYYY-MM'). Permite agrupar el alquiler por
     mes aunque el pago caiga en otro, por ejemplo al día 5 del mes siguiente. */
  mes_cobro TEXT NOT NULL DEFAULT '',
  documento TEXT DEFAULT '',
  notas TEXT DEFAULT '',
  empleado_id INTEGER REFERENCES empleados(id) ON DELETE SET NULL,
  creado_en TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS productos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  codigo TEXT NOT NULL UNIQUE,
  /* Código de barras propio de la tienda (Code 128). Lo genera el sistema y
     se imprime en la etiqueta del producto. Nulo solo si aún no se ha generado. */
  codigo_barras TEXT,
  nombre TEXT NOT NULL,
  categoria_id INTEGER REFERENCES categorias(id) ON DELETE SET NULL,
  descripcion TEXT DEFAULT '',
  costo REAL NOT NULL DEFAULT 0,
  precio REAL NOT NULL DEFAULT 0,
  stock REAL NOT NULL DEFAULT 0,
  stock_minimo REAL NOT NULL DEFAULT 5,
  stock_reservado REAL NOT NULL DEFAULT 0,
  unidad TEXT NOT NULL DEFAULT 'pza',
  /* Cuántas unidades de stock suma un escaneo de este producto. Una caja de
     doce piezas con contenido 12 suma 12 al inventario, no 1. */
  contenido REAL NOT NULL DEFAULT 1,
  iva_aplicable INTEGER NOT NULL DEFAULT 1,
  requiere_instalacion INTEGER NOT NULL DEFAULT 0,
  precio_instalacion REAL NOT NULL DEFAULT 0,
  dias_instalacion INTEGER NOT NULL DEFAULT 1,
  activo INTEGER NOT NULL DEFAULT 1,
  creado_en TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS clientes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  codigo TEXT NOT NULL UNIQUE,
  nombre TEXT NOT NULL,
  documento TEXT DEFAULT '',
  telefono TEXT DEFAULT '',
  email TEXT DEFAULT '',
  direccion TEXT DEFAULT '',
  saldo REAL NOT NULL DEFAULT 0,
  activo INTEGER NOT NULL DEFAULT 1,
  creado_en TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS proveedores (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nombre TEXT NOT NULL,
  contacto TEXT DEFAULT '',
  documento TEXT DEFAULT '',
  telefono TEXT DEFAULT '',
  email TEXT DEFAULT '',
  direccion TEXT DEFAULT '',
  activo INTEGER NOT NULL DEFAULT 1,
  creado_en TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS empleados (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nombre TEXT NOT NULL,
  usuario TEXT NOT NULL UNIQUE,
  clave_hash TEXT NOT NULL,
  rol TEXT NOT NULL CHECK (rol IN ('admin','asesor','tecnico')),
  sucursal_id INTEGER REFERENCES sucursales(id) ON DELETE SET NULL,
  telefono TEXT DEFAULT '',
  activo INTEGER NOT NULL DEFAULT 1,
  creado_en TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS destinos_pago (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  sucursal_id INTEGER REFERENCES sucursales(id) ON DELETE CASCADE,
  nombre TEXT NOT NULL,
  tipo TEXT NOT NULL CHECK (tipo IN ('efectivo','tarjeta','transferencia','yape')),
  identificador TEXT NOT NULL DEFAULT '',
  activo INTEGER NOT NULL DEFAULT 1,
  creado_en TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE TABLE IF NOT EXISTS instalacion_pagos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  instalacion_id INTEGER NOT NULL REFERENCES instalaciones(id) ON DELETE CASCADE,
  fecha TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  monto REAL NOT NULL DEFAULT 0,
  destino_id INTEGER REFERENCES destinos_pago(id) ON DELETE SET NULL,
  referencia TEXT NOT NULL DEFAULT '',
  recibido_por INTEGER REFERENCES empleados(id) ON DELETE SET NULL,
  nota TEXT DEFAULT '',
  creado_en TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS ventas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  numero TEXT NOT NULL UNIQUE,
  fecha TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  cliente_id INTEGER REFERENCES clientes(id) ON DELETE SET NULL,
  empleado_id INTEGER REFERENCES empleados(id) ON DELETE SET NULL,
  sucursal_id INTEGER REFERENCES sucursales(id) ON DELETE SET NULL,
  subtotal REAL NOT NULL DEFAULT 0,
  descuento REAL NOT NULL DEFAULT 0,
  impuestos REAL NOT NULL DEFAULT 0,
  total REAL NOT NULL DEFAULT 0,
  costo_total REAL NOT NULL DEFAULT 0,
  metodo_pago TEXT NOT NULL DEFAULT 'efectivo',
  monto_pagado REAL NOT NULL DEFAULT 0,
  estado TEXT NOT NULL DEFAULT 'completada' CHECK (estado IN ('completada','anulada')),
  notas TEXT DEFAULT '',
  destino_id INTEGER REFERENCES destinos_pago(id) ON DELETE SET NULL,
  referencia TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS venta_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  venta_id INTEGER NOT NULL REFERENCES ventas(id) ON DELETE CASCADE,
  producto_id INTEGER REFERENCES productos(id) ON DELETE SET NULL,
  nombre TEXT NOT NULL,
  cantidad REAL NOT NULL,
  precio REAL NOT NULL,
  precio_instalacion REAL NOT NULL DEFAULT 0,
  costo REAL NOT NULL DEFAULT 0,
  subtotal REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS compras (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  numero TEXT NOT NULL UNIQUE,
  fecha TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  proveedor_id INTEGER REFERENCES proveedores(id) ON DELETE SET NULL,
  empleado_id INTEGER REFERENCES empleados(id) ON DELETE SET NULL,
  subtotal REAL NOT NULL DEFAULT 0,
  impuestos REAL NOT NULL DEFAULT 0,
  total REAL NOT NULL DEFAULT 0,
  estado TEXT NOT NULL DEFAULT 'pendiente' CHECK (estado IN ('pendiente','recibida','cancelada')),
  notas TEXT DEFAULT ''
);

CREATE TABLE IF NOT EXISTS compra_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  compra_id INTEGER NOT NULL REFERENCES compras(id) ON DELETE CASCADE,
  producto_id INTEGER REFERENCES productos(id) ON DELETE SET NULL,
  nombre TEXT NOT NULL,
  cantidad REAL NOT NULL,
  /* Lo que realmente entró al almacén. Se llena al recibir con el lector de
     códigos de barras y puede diferir de lo pedido (faltantes o sobrantes). */
  cantidad_recibida REAL NOT NULL DEFAULT 0,
  costo REAL NOT NULL,
  subtotal REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS instalaciones (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  codigo TEXT NOT NULL UNIQUE,
  fecha TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  venta_id INTEGER REFERENCES ventas(id) ON DELETE SET NULL,
  cliente_id INTEGER REFERENCES clientes(id) ON DELETE SET NULL,
  sucursal_id INTEGER REFERENCES sucursales(id) ON DELETE SET NULL,
  producto_id INTEGER REFERENCES productos(id) ON DELETE SET NULL,
  producto_nombre TEXT NOT NULL,
  cantidad REAL NOT NULL DEFAULT 1,
  tecnico_id INTEGER REFERENCES empleados(id) ON DELETE SET NULL,
  asesor_id INTEGER REFERENCES empleados(id) ON DELETE SET NULL,
  direccion TEXT NOT NULL DEFAULT '',
  contacto TEXT DEFAULT '',
  fecha_programada TEXT NOT NULL DEFAULT '',
  hora_programada TEXT NOT NULL DEFAULT '',
  estado TEXT NOT NULL DEFAULT 'pendiente' CHECK (estado IN ('pendiente','programada','material_retirado','en_ruta','en_progreso','completada','cancelada')),
  /* 1 = esta orden tiene mercadería reservada en productos.stock_reservado y
     aún en el almacén. 0 = la orden ya descontó el stock al vender (legacy) o
     la mercadería ya salió; en ese caso la entrega solo se documenta. */
  reserva_stock INTEGER NOT NULL DEFAULT 0,
  costo REAL NOT NULL DEFAULT 0,
  adelanto REAL NOT NULL DEFAULT 0,
  saldo_pagado REAL NOT NULL DEFAULT 0,
  fecha_pago_saldo TEXT NOT NULL DEFAULT '',
  saldo_recibido_por INTEGER REFERENCES empleados(id) ON DELETE SET NULL,
  monto_financiado REAL NOT NULL DEFAULT 0,
  notas TEXT DEFAULT '',
  fecha_inicio TEXT DEFAULT '',
  fecha_fin TEXT DEFAULT ''
);

CREATE TABLE IF NOT EXISTS instalacion_historial (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  instalacion_id INTEGER NOT NULL REFERENCES instalaciones(id) ON DELETE CASCADE,
  estado TEXT NOT NULL,
  comentario TEXT DEFAULT '',
  empleado_id INTEGER REFERENCES empleados(id) ON DELETE SET NULL,
  fecha TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

/* La mercadería que cada orden debe llevar al sitio. Antes esto solo existía
   como texto suelto en instalaciones.notas, lo que impedía saber qué retiró el
   técnico. cantidad_prevista = lo que vendió la venta; cantidad_entregada = lo
   que salió del almacén. La diferencia son faltantes o sobrantes que el admin
   regulariza por inventario. */
CREATE TABLE IF NOT EXISTS instalacion_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  instalacion_id INTEGER NOT NULL REFERENCES instalaciones(id) ON DELETE CASCADE,
  producto_id INTEGER REFERENCES productos(id) ON DELETE SET NULL,
  nombre TEXT NOT NULL,
  cantidad_prevista REAL NOT NULL DEFAULT 0,
  /* El retiro conserva si la venta pidió piezas o cajas. La cantidad prevista
     sigue en unidades de stock; contenido_empaque es una copia al vender. */
  modo_retiro TEXT NOT NULL DEFAULT 'pza' CHECK (modo_retiro IN ('pza','caja')),
  contenido_empaque REAL NOT NULL DEFAULT 1,
  cantidad_entregada REAL NOT NULL DEFAULT 0,
  devueltas REAL NOT NULL DEFAULT 0,
  faltantes REAL NOT NULL DEFAULT 0,
  fecha_entrega TEXT NOT NULL DEFAULT '',
  registrado_por INTEGER REFERENCES empleados(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS movimientos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  producto_id INTEGER REFERENCES productos(id) ON DELETE SET NULL,
  /* El stock es único en toda la cadena, pero cada movimiento sabe de qué
     sucursal salió la mercadería. Nulo en los movimientos anteriores. */
  sucursal_id INTEGER REFERENCES sucursales(id) ON DELETE SET NULL,
  tipo TEXT NOT NULL CHECK (tipo IN ('entrada','salida','ajuste','venta','compra')),
  cantidad REAL NOT NULL,
  stock_despues REAL NOT NULL,
  referencia TEXT DEFAULT '',
  empleado_id INTEGER REFERENCES empleados(id) ON DELETE SET NULL,
  notas TEXT DEFAULT '',
  fecha TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE TABLE IF NOT EXISTS configuracion (
  clave TEXT PRIMARY KEY,
  valor TEXT NOT NULL
);
`;

const INDICES = `
CREATE INDEX IF NOT EXISTS idx_productos_nombre ON productos(nombre);
CREATE INDEX IF NOT EXISTS idx_productos_codigo ON productos(codigo);
CREATE INDEX IF NOT EXISTS idx_ventas_fecha ON ventas(fecha);
CREATE INDEX IF NOT EXISTS idx_movimientos_producto ON movimientos(producto_id);
`;

db.exec(SCHEMA);

/* =====================================================================
   Migraciones: la base pudo crearse con una versión anterior del
   esquema (roles vendedor/bodeguero, sin sucursales ni instalaciones).
   Se reconstruye lo mínimo indispensable conservando todos los datos.
   ===================================================================== */

function columnasDe(tabla) {
  return db.prepare(`PRAGMA table_info(${tabla})`).all().map((c) => c.name);
}

function agregarColumna(tabla, nombre, definicion) {
  if (!columnasDe(tabla).includes(nombre)) {
    db.exec(`ALTER TABLE ${tabla} ADD COLUMN ${nombre} ${definicion}`);
  }
}

function definicionDe(tabla) {
  const r = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(tabla);
  return r ? r.sql : '';
}

/* La tabla empleados lleva el rol en un CHECK. SQLite no puede alterarlo,
   así que se reconstruye renombrando los roles antiguos. */
function migrarRoles() {
  if (definicionDe('empleados').includes("'tecnico'")) return;
  db.exec('PRAGMA foreign_keys = OFF');
  try {
    db.exec('BEGIN');
    db.exec(`
      CREATE TABLE empleados_nueva (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        nombre TEXT NOT NULL,
        usuario TEXT NOT NULL UNIQUE,
        clave_hash TEXT NOT NULL,
        rol TEXT NOT NULL CHECK (rol IN ('admin','asesor','tecnico')),
        sucursal_id INTEGER REFERENCES sucursales(id) ON DELETE SET NULL,
        telefono TEXT DEFAULT '',
        activo INTEGER NOT NULL DEFAULT 1,
        creado_en TEXT NOT NULL DEFAULT (datetime('now','localtime'))
      );
      INSERT INTO empleados_nueva(id, nombre, usuario, clave_hash, rol, telefono, activo, creado_en)
        SELECT id, nombre, usuario, clave_hash,
               CASE rol WHEN 'vendedor' THEN 'asesor' WHEN 'bodeguero' THEN 'tecnico' ELSE rol END,
               telefono, activo, creado_en
        FROM empleados;
      DROP TABLE empleados;
      ALTER TABLE empleados_nueva RENAME TO empleados;
    `);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}

/* La tabla instalaciones lleva el estado en un CHECK y SQLite no puede
   alterarlo. Se reconstruye para admitir los hitos de la mercadería
   (material_retirado, en_ruta) copiando todas las columnas y sus datos.
   Es el mismo recurso que usa migrarRoles para el CHECK de rol. */
function migrarEstadosInstalacion() {
  if (definicionDe('instalaciones').includes("'material_retirado'")) return;
  db.exec('PRAGMA foreign_keys = OFF');
  try {
    db.exec('BEGIN');
    db.exec(`
      CREATE TABLE instalaciones_nueva (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        codigo TEXT NOT NULL UNIQUE,
        fecha TEXT NOT NULL DEFAULT (datetime('now','localtime')),
        venta_id INTEGER REFERENCES ventas(id) ON DELETE SET NULL,
        cliente_id INTEGER REFERENCES clientes(id) ON DELETE SET NULL,
        sucursal_id INTEGER REFERENCES sucursales(id) ON DELETE SET NULL,
        producto_id INTEGER REFERENCES productos(id) ON DELETE SET NULL,
        producto_nombre TEXT NOT NULL,
        cantidad REAL NOT NULL DEFAULT 1,
        tecnico_id INTEGER REFERENCES empleados(id) ON DELETE SET NULL,
        asesor_id INTEGER REFERENCES empleados(id) ON DELETE SET NULL,
        direccion TEXT NOT NULL DEFAULT '',
        contacto TEXT DEFAULT '',
        fecha_programada TEXT NOT NULL DEFAULT '',
        hora_programada TEXT NOT NULL DEFAULT '',
        estado TEXT NOT NULL DEFAULT 'pendiente' CHECK (estado IN ('pendiente','programada','material_retirado','en_ruta','en_progreso','completada','cancelada')),
        reserva_stock INTEGER NOT NULL DEFAULT 0,
        costo REAL NOT NULL DEFAULT 0,
        adelanto REAL NOT NULL DEFAULT 0,
        saldo_pagado REAL NOT NULL DEFAULT 0,
        fecha_pago_saldo TEXT NOT NULL DEFAULT '',
        saldo_recibido_por INTEGER REFERENCES empleados(id) ON DELETE SET NULL,
        monto_financiado REAL NOT NULL DEFAULT 0,
        notas TEXT DEFAULT '',
        fecha_inicio TEXT DEFAULT '',
        fecha_fin TEXT DEFAULT ''
      );
      INSERT INTO instalaciones_nueva(
        id, codigo, fecha, venta_id, cliente_id, sucursal_id, producto_id, producto_nombre,
        cantidad, tecnico_id, asesor_id, direccion, contacto, fecha_programada, hora_programada,
        estado, reserva_stock, costo, adelanto, saldo_pagado, fecha_pago_saldo,
        saldo_recibido_por, monto_financiado, notas, fecha_inicio, fecha_fin)
      SELECT id, codigo, fecha, venta_id, cliente_id, sucursal_id, producto_id, producto_nombre,
        cantidad, tecnico_id, asesor_id, direccion, contacto, COALESCE(fecha_programada,''),
        COALESCE(hora_programada,''), estado, COALESCE(reserva_stock,0), costo, adelanto,
        saldo_pagado, fecha_pago_saldo, saldo_recibido_por, monto_financiado, notas,
        fecha_inicio, fecha_fin
        FROM instalaciones;
      DROP TABLE instalaciones;
      ALTER TABLE instalaciones_nueva RENAME TO instalaciones;
    `);
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}

migrarRoles();
agregarColumna('empleados', 'sucursal_id', 'INTEGER REFERENCES sucursales(id) ON DELETE SET NULL');
agregarColumna('ventas', 'sucursal_id', 'INTEGER REFERENCES sucursales(id) ON DELETE SET NULL');
agregarColumna('venta_items', 'precio_instalacion', 'REAL NOT NULL DEFAULT 0');
agregarColumna('productos', 'requiere_instalacion', 'INTEGER NOT NULL DEFAULT 0');
agregarColumna('productos', 'precio_instalacion', 'REAL NOT NULL DEFAULT 0');
agregarColumna('productos', 'dias_instalacion', 'INTEGER NOT NULL DEFAULT 1');
agregarColumna('instalaciones', 'hora_programada', "TEXT NOT NULL DEFAULT ''");
agregarColumna('instalaciones', 'adelanto', 'REAL NOT NULL DEFAULT 0');
agregarColumna('instalaciones', 'saldo_pagado', 'REAL NOT NULL DEFAULT 0');
agregarColumna('instalaciones', 'fecha_pago_saldo', "TEXT NOT NULL DEFAULT ''");
agregarColumna('instalaciones', 'saldo_recibido_por', 'INTEGER REFERENCES empleados(id) ON DELETE SET NULL');
/* monto_financiado es el total de la venta que la orden financia: productos
   más instalación. El saldo que cobra el técnico sale de este monto, no del
   costo de instalación. Las órdenes anteriores solo cubrían la instalación,
   así que se les fija su costo para que su saldo no cambie. */
agregarColumna('instalaciones', 'monto_financiado', 'REAL NOT NULL DEFAULT 0');
db.prepare('UPDATE instalaciones SET monto_financiado = costo WHERE monto_financiado = 0 AND costo > 0').run();

/* Reserva de mercadería: la venta con instalación ya no descuenta el stock,
   lo compromete. stock es lo que hay físicamente en el almacén y
   stock_reservado lo que está vendido y aún por retirar. */
agregarColumna('productos', 'stock_reservado', 'REAL NOT NULL DEFAULT 0');
/* Cada movimiento sabe de qué sucursal salió la mercadería. */
agregarColumna('movimientos', 'sucursal_id', 'INTEGER REFERENCES sucursales(id) ON DELETE SET NULL');
/* reserva_stock se añade antes de reconstruir la tabla para que la copia lo
   herede. Vale 0 en las órdenes anteriores: esas ya descontaron el stock al
   vender, así que no pueden volver a descontarlo al entregar. */
agregarColumna('instalaciones', 'reserva_stock', 'INTEGER NOT NULL DEFAULT 0');
/* Las órdenes previas no guardaban si se vendió por pieza o caja; se conservan
   como piezas sueltas. Las órdenes nuevas guardan el modo y el empaque vendido. */
agregarColumna('instalacion_items', 'modo_retiro', "TEXT NOT NULL DEFAULT 'pza'");
agregarColumna('instalacion_items', 'contenido_empaque', 'REAL NOT NULL DEFAULT 1');
migrarEstadosInstalacion();

/* Código de barras propio de cada producto y contenido del empaque. */
agregarColumna('productos', 'codigo_barras', 'TEXT');
agregarColumna('productos', 'contenido', 'REAL NOT NULL DEFAULT 1');
/* Lo que realmente llegó de cada línea de la orden de compra. */
agregarColumna('compra_items', 'cantidad_recibida', 'REAL NOT NULL DEFAULT 0');
/* Un mismo código de barras no puede estar en dos productos: el lector debe
   llevar a uno solo. */
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS ux_productos_codigo_barras ON productos(codigo_barras) WHERE codigo_barras IS NOT NULL');

/* Las sucursales son tiendas alquiladas: con los datos de quien nos las alquila
   y el alquiler pactado. La tabla ya existía, así que se añaden por separado. */
agregarColumna('sucursales', 'propietario_nombre', 'TEXT DEFAULT \'\'');
agregarColumna('sucursales', 'propietario_dni', 'TEXT DEFAULT \'\'');
agregarColumna('sucursales', 'propietario_telefono', 'TEXT DEFAULT \'\'');
agregarColumna('sucursales', 'alquiler_mensual', 'REAL NOT NULL DEFAULT 0');
agregarColumna('sucursales', 'dia_alquiler', 'INTEGER NOT NULL DEFAULT 0');
agregarColumna('sucursales', 'notas', 'TEXT DEFAULT \'\'');

/* Los productos dados de alta antes del control por lector no tenían código.
   Se les asigna uno correlativo para que todos puedan escanearse desde el
   primer día. */
(function asignarCodigosBarras() {
  const get = db.prepare('SELECT id FROM productos WHERE codigo_barras IS NULL OR TRIM(codigo_barras) = ? ORDER BY id');
  for (const p of get.all('')) {
    let codigo = sigCodigoBarras();
    /* Si el correlativo ya estuviera tomado por una fila anterior de la misma
       corrida, se avanza hasta encontrar uno libre. */
    while (db.prepare('SELECT 1 FROM productos WHERE codigo_barras = ?').get(codigo)) {
      codigo = String(Number(codigo) + 1).padStart(codigo.length, '0');
    }
    db.prepare('UPDATE productos SET codigo_barras = ? WHERE id = ?').run(codigo, p.id);
  }
})();

/* Las órdenes anteriores tenían un solo producto en la propia tabla. Se les
   arma su línea de entrega para que tengan checklist, pero con reserva_stock = 0
   la entrega solo se documenta: el stock ya salió cuando se vendió. */
const insertItem = db.prepare(`
  INSERT INTO instalacion_items(instalacion_id, producto_id, nombre, cantidad_prevista)
  SELECT i.id, i.producto_id, i.producto_nombre, i.cantidad
  FROM instalaciones i
  WHERE i.producto_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM instalacion_items x WHERE x.instalacion_id = i.id)`);
insertItem.run();

/* Ninguna sucursal es "principal": cada venta, empleado y orden de instalación
   cuelga de la sucursal donde está afiliado quien la originó. La clave quedó
   sin uso al retirar la etiqueta y el bloqueo de borrado que dependían de ella. */
db.prepare("DELETE FROM configuracion WHERE clave = 'sucursal_principal'").run();

/* Los índices van al final: referencian columnas que las migraciones añaden. */
db.exec(INDICES);
db.exec(`
CREATE INDEX IF NOT EXISTS idx_ventas_sucursal ON ventas(sucursal_id);
CREATE INDEX IF NOT EXISTS idx_instalaciones_estado ON instalaciones(estado);
CREATE INDEX IF NOT EXISTS idx_instalaciones_tecnico ON instalaciones(tecnico_id);
CREATE INDEX IF NOT EXISTS idx_instalaciones_fecha ON instalaciones(fecha);
CREATE INDEX IF NOT EXISTS idx_empleados_sucursal ON empleados(sucursal_id);
CREATE INDEX IF NOT EXISTS idx_institems_instalacion ON instalacion_items(instalacion_id);
CREATE INDEX IF NOT EXISTS idx_movimientos_sucursal ON movimientos(sucursal_id);
CREATE INDEX IF NOT EXISTS idx_gastos_sucursal ON gastos_sucursal(sucursal_id);
CREATE INDEX IF NOT EXISTS idx_gastos_categoria ON gastos_sucursal(categoria);
CREATE INDEX IF NOT EXISTS idx_gastos_fecha ON gastos_sucursal(fecha);
`);

/* Los gastos registrados sin mes de imputación se imputan al mes de su propia
   fecha, para que el agrupamiento por mes no deje huecos. */
db.exec(`
  UPDATE gastos_sucursal
  SET mes_cobro = substr(fecha, 1, 7)
  WHERE (mes_cobro IS NULL OR TRIM(mes_cobro) = '')
    AND fecha IS NOT NULL`);
/* Los movimientos anteriores no tenían sucursal, pero su referencia guarda el
   número de la venta, así que se completa con la sucursal que la originó. */
db.exec(`
  UPDATE movimientos SET sucursal_id = (
    SELECT v.sucursal_id FROM ventas v
    WHERE v.numero = trim(replace(replace(movimientos.referencia, 'Venta ', ''), 'Anulación ', ''))
  )
  WHERE sucursal_id IS NULL
    AND (referencia LIKE 'Venta %' OR referencia LIKE 'Anulación %')
    AND EXISTS (
      SELECT 1 FROM ventas v
      WHERE v.numero = trim(replace(replace(movimientos.referencia, 'Venta ', ''), 'Anulación ', ''))
    )`);

/* ============================ Semilla ============================ */

function tableEmpty(name) {
  return db.prepare(`SELECT COUNT(*) AS c FROM ${name}`).get().c === 0;
}

function idDe(tabla, columna, valor) {
  const r = db.prepare(`SELECT id FROM ${tabla} WHERE ${columna} = ?`).get(valor);
  return r ? r.id : null;
}

function idCategoria(nombre, descripcion = '') {
  const id = idDe('categorias', 'nombre', nombre);
  if (id) return id;
  db.prepare('INSERT INTO categorias(nombre, descripcion) VALUES(?,?)').run(nombre, descripcion);
  return idDe('categorias', 'nombre', nombre);
}

function idSucursal(codigo, nombre, direccion = '', telefono = '') {
  const id = idDe('sucursales', 'codigo', codigo);
  if (id) return id;
  db.prepare('INSERT INTO sucursales(codigo, nombre, direccion, telefono) VALUES(?,?,?,?)')
    .run(codigo, nombre, direccion, telefono);
  return idDe('sucursales', 'codigo', codigo);
}

function idEmpleado(usuario, nombre, clave, rol, sucursalId, telefono = '') {
  if (idDe('empleados', 'usuario', usuario)) return null;
  db.prepare('INSERT INTO empleados(nombre, usuario, clave_hash, rol, sucursal_id, telefono) VALUES(?,?,?,?,?,?)')
    .run(nombre, usuario, hashPassword(clave), rol, sucursalId, telefono);
  return idDe('empleados', 'usuario', usuario);
}

function idProducto(codigo, nombre, categoriaId, descripcion, costo, precio, stock, stockMinimo, unidad, reqInst, precioInst, diasInst) {
  if (idDe('productos', 'codigo', codigo)) return null;
  db.prepare(`
    INSERT INTO productos(codigo, codigo_barras, nombre, categoria_id, descripcion, costo, precio, stock,
                          stock_minimo, unidad, requiere_instalacion, precio_instalacion, dias_instalacion)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(codigo, sigCodigoBarras(), nombre, categoriaId, descripcion, costo, precio, stock,
      stockMinimo, unidad, reqInst, precioInst, diasInst);
  return idDe('productos', 'codigo', codigo);
}

function seed() {
  const sucursalCentral = idSucursal('S01', 'Sucursal Central', 'Av. Los Comercio 123', '555-0100');

  const defaults = {
    nombre_tienda: 'Ferretería El Tornillo',
    lema: 'Herramientas, materiales e instalaciones',
    documento: 'RUC-20509876543',
    direccion: 'Av. Los Comercio 123',
    telefono: '555-0100',
    moneda: 'S/',
    iva: '16',
    pie_ticket: '¡Gracias por su compra!',
    prefijo_venta: 'V',
    prefijo_compra: 'C',
    prefijo_instalacion: 'INS',
    /* Rango de los códigos de barras que imprime la tienda. El 200 es un
       prefijo interno reservado: nunca colisiona con un EAN de proveedor. */
    prefijo_barras: '200',
    /* Tarifa base de la instalación a domicilio. El POS la propone como
       precio inicial y el asesor puede cambiarla en cada venta. */
    precio_instalacion: '52',
  };
  for (const [clave, valor] of Object.entries(defaults)) {
    db.prepare('INSERT OR IGNORE INTO configuracion(clave, valor) VALUES(?, ?)').run(clave, valor);
  }

  /* Las ventas anteriores a las sucursales heredan la central. */
  db.prepare('UPDATE ventas SET sucursal_id = ? WHERE sucursal_id IS NULL').run(sucursalCentral);

  const sucursalNorte = idSucursal('S02', 'Sucursal Norte', 'Av.-Commerce 450', '555-0200');
  idSucursal('S03', 'Sucursal Sur', 'Calle del Sur 88', '555-0300');

  if (tableEmpty('empleados')) {
    idEmpleado('admin', 'Administrador', 'admin123', 'admin', sucursalCentral, '555-0100');
  }
  idEmpleado('asesor', 'Asesor de Ventas', 'asesor123', 'asesor', sucursalCentral, '555-0101');
  idEmpleado('tecnico', 'Carlos Técnico', 'tecnico123', 'tecnico', sucursalCentral, '555-0103');
  idEmpleado('marco', 'Marco Instalador', 'marco123', 'tecnico', sucursalNorte, '555-0104');

  /* Una afiliación vacía se conserva: solo el administrador asigna sucursal. */

  migrarCatalogoFerreteria();

  if (tableEmpty('categorias')) {
    CATEGORIAS_SEED.forEach(([nombre, descripcion]) => idCategoria(nombre, descripcion));
  }

  CATALOGO_SEED.forEach((p) => {
    const cat = idCategoria(p.cat, p.catDesc);
    idProducto(p.codigo, p.nombre, cat, p.desc, p.costo, p.precio, p.stock, p.min, p.uni, p.inst, p.pInst, p.dias);
  });

  if (tableEmpty('clientes')) {
    const ins = db.prepare(
      'INSERT INTO clientes(codigo, nombre, documento, telefono, email, direccion) VALUES(?,?,?,?,?,?)'
    );
    [
      ['C001', 'Público General', '', '', '', ''],
      ['C002', 'María López', 'DNI-12345678', '555-2001', 'maria@email.com', 'Calle Rosa 45'],
      ['C003', 'Carlos Pérez', 'DNI-87654321', '555-2002', 'carlos@email.com', 'Av. Sol 12'],
      ['C004', 'Constructora Norte S.A.C.', 'RUC-20123456789', '555-2003', 'compras@cnorte.com', 'Ruta 5 km 3'],
    ].forEach((c) => ins.run(...c));
  }

  if (tableEmpty('proveedores')) {
    const ins = db.prepare(
      'INSERT INTO proveedores(nombre, contacto, documento, telefono, email, direccion) VALUES(?,?,?,?,?,?)'
    );
    [
      ['Acero y Tornillería Andina', 'Roberto Díaz', 'RUC-20987654321', '555-3001', 'ventas@aceroandina.com', 'Zona Industrial 8'],
      ['Herramientas del Norte S.A.C.', 'Elena Ruiz', 'RUC-20112233445', '555-3002', 'pedidos@hnorte.com', 'Camino Industrial 22'],
      ['Pinturas y Acabados El Globo', 'Mario Soto', 'RUC-20556677889', '555-3003', 'info@elglobo.com', 'Calle Comercio 90'],
    ].forEach((p) => ins.run(...p));
  }

  if (tableEmpty('ventas')) seedVentas(sucursalCentral);
  if (tableEmpty('instalaciones')) seedInstalaciones(sucursalCentral);
  migrarInstalacionesDemo();
}

/* ================== Catálogo de ferretería ==================
   La ferretería vende herramientas, materiales y productos que
   además requieren instalación a domicilio.                            */

const CATEGORIAS_SEED = [
  ['Herramientas manuales', 'Alicates, martillos, destornilladores y medición'],
  ['Tornillería y anclajes', 'Tornillos, tuercas, arandelas y anclajes'],
  ['Pintura y acabados', 'Pinturas, lijados, masillas y selladores'],
  ['Tubería y plomería', 'Tuberías, accesorios y grifería'],
  ['Electricidad', 'Cables, protecciones y luminarias'],
  ['Maquinaria eléctrica', 'Herramientas inalámbricas y de potencia'],
  ['Seguridad industrial', 'Casco, guantes y protección personal'],
  ['Instalaciones del hogar', 'Productos que se entregan instalados a domicilio'],
];

/* cod, nombre, categoría, descripción, costo, precio, stock, mínimo, unidad,
   ¿requiere instalación?, precio de instalación, días de instalación */
const CATALOGO_SEED = [
  { codigo: 'P001', nombre: 'Juego de destornilladores 6 piezas', cat: 'Herramientas manuales', catDesc: 'Alicates, martillos, destornilladores y medición', desc: 'Punta plana, phillips y estrella en mango giratorio', costo: 22, precio: 34, stock: 40, min: 10, uni: 'pza', inst: 0, pInst: 0, dias: 1 },
  { codigo: 'P002', nombre: 'Martillo de unclador 27 mm', cat: 'Herramientas manuales', catDesc: 'Alicates, martillos, destornilladores y medición', desc: 'Cabeza de acero forjado con mango de fibra', costo: 24, precio: 38, stock: 25, min: 8, uni: 'pza', inst: 0, pInst: 0, dias: 1 },
  { codigo: 'P003', nombre: 'Llave adjustable 10"', cat: 'Herramientas manuales', catDesc: 'Alicates, martillos, destornilladores y medición', desc: 'Mango de acero cromado, apertura 250 mm', costo: 19, precio: 31, stock: 30, min: 10, uni: 'pza', inst: 0, pInst: 0, dias: 1 },
  { codigo: 'P004', nombre: 'Alicate universal 8"', cat: 'Herramientas manuales', catDesc: 'Alicates, martillos, destornilladores y medición', desc: 'Aislamiento VDE 1000 V', costo: 16, precio: 27, stock: 28, min: 8, uni: 'pza', inst: 0, pInst: 0, dias: 1 },
  { codigo: 'P005', nombre: 'Pinza de corte diagonal 6"', cat: 'Herramientas manuales', catDesc: 'Alicates, martillos, destornilladores y medición', desc: 'Corte limpio para alambre y cable', costo: 12, precio: 21, stock: 22, min: 6, uni: 'pza', inst: 0, pInst: 0, dias: 1 },
  { codigo: 'P006', nombre: 'Juego de llaves allen 9 piezas', cat: 'Herramientas manuales', catDesc: 'Alicates, martillos, destornilladores y medición', desc: 'Acero al carbono, incluye estuche', costo: 10, precio: 18, stock: 20, min: 6, uni: 'jgo', inst: 0, pInst: 0, dias: 1 },
  { codigo: 'P007', nombre: 'Nivel de burbuja 60 cm', cat: 'Herramientas manuales', catDesc: 'Alicates, martillos, destornilladores y medición', desc: 'Cuerpo de aluminio con ampollas visibles', costo: 9, precio: 16, stock: 18, min: 6, uni: 'pza', inst: 0, pInst: 0, dias: 1 },
  { codigo: 'P008', nombre: 'Cinta métrica 8 m', cat: 'Herramientas manuales', catDesc: 'Alicates, martillos, destornilladores y medición', desc: 'Caja de ABS con clip a cinturón', costo: 7, precio: 13, stock: 35, min: 10, uni: 'pza', inst: 0, pInst: 0, dias: 1 },
  { codigo: 'P009', nombre: 'Tornillo drywall 1" (caja 400u)', cat: 'Tornillería y anclajes', catDesc: 'Tornillos, tuercas, arandelas y anclajes', desc: 'Punta de acero y cabeza cónica para tabiquería', costo: 18, precio: 29, stock: 45, min: 12, uni: 'caja', inst: 0, pInst: 0, dias: 1 },
  { codigo: 'P010', nombre: 'Tornillo hexagonal 1/2" x 6"', cat: 'Tornillería y anclajes', catDesc: 'Tornillos, tuercas, arandelas y anclajes', desc: 'Galvanizado en caliente, bolsa x 50', costo: 15, precio: 25, stock: 60, min: 15, uni: 'bolsa', inst: 0, pInst: 0, dias: 1 },
  { codigo: 'P011', nombre: 'Tuerca M10 zincada (caja 100u)', cat: 'Tornillería y anclajes', catDesc: 'Tornillos, tuercas, arandelas y anclajes', desc: 'Rosca métrica ISO', costo: 12, precio: 20, stock: 50, min: 15, uni: 'caja', inst: 0, pInst: 0, dias: 1 },
  { codigo: 'P012', nombre: 'Arandela plana M10 (caja 200u)', cat: 'Tornillería y anclajes', catDesc: 'Tornillos, tuercas, arandelas y anclajes', desc: 'Acero zincado', costo: 9, precio: 16, stock: 55, min: 15, uni: 'caja', inst: 0, pInst: 0, dias: 1 },
  { codigo: 'P013', nombre: 'Anclaje de expansión 1/2" (caja 50u)', cat: 'Tornillería y anclajes', catDesc: 'Tornillos, tuercas, arandelas y anclajes', desc: 'Expansión por percusión para concreto', costo: 21, precio: 34, stock: 38, min: 10, uni: 'caja', inst: 0, pInst: 0, dias: 1 },
  { codigo: 'P014', nombre: 'Pintura látex interior 5 gal', cat: 'Pintura y acabados', catDesc: 'Pinturas, lijados, masillas y selladores', desc: 'Base agua, blanco o color a elección', costo: 96, precio: 145, stock: 20, min: 5, uni: 'balde', inst: 0, pInst: 0, dias: 1 },
  { codigo: 'P015', nombre: 'Pintura acrílica exterior 1 gal', cat: 'Pintura y acabados', catDesc: 'Pinturas, lijados, masillas y selladores', desc: 'Resistente a la intemperie', costo: 38, precio: 58, stock: 26, min: 8, uni: 'gal', inst: 0, pInst: 0, dias: 1 },
  { codigo: 'P016', nombre: 'Lija en grano 120 (paquete 10u)', cat: 'Pintura y acabados', catDesc: 'Pinturas, lijados, masillas y selladores', desc: 'Resina sobre papel para madera y metal', costo: 5, precio: 10, stock: 70, min: 20, uni: 'paq', inst: 0, pInst: 0, dias: 1 },
  { codigo: 'P017', nombre: 'Rodillo de pintura 9"', cat: 'Pintura y acabados', catDesc: 'Pinturas, lijados, masillas y selladores', desc: 'Felpa de mezcla con mango', costo: 8, precio: 15, stock: 30, min: 8, uni: 'pza', inst: 0, pInst: 0, dias: 1 },
  { codigo: 'P018', nombre: 'Masilla acrílica 1 kg', cat: 'Pintura y acabados', catDesc: 'Pinturas, lijados, masillas y selladores', desc: 'Para pared y techo, secado rápido', costo: 9, precio: 16, stock: 32, min: 10, uni: 'pza', inst: 0, pInst: 0, dias: 1 },
  { codigo: 'P019', nombre: 'Sellador silicón neutro 300 ml', cat: 'Pintura y acabados', catDesc: 'Pinturas, lijados, masillas y selladores', desc: 'Sellado de juntas y vitrocerámica', costo: 10, precio: 18, stock: 30, min: 8, uni: 'pza', inst: 0, pInst: 0, dias: 1 },
  { codigo: 'P020', nombre: 'Tubería PVC 1" (tubo 5 m)', cat: 'Tubería y plomería', catDesc: 'Tuberías, accesorios y grifería', desc: 'Para agua fría, Schedule 40', costo: 14, precio: 24, stock: 60, min: 15, uni: 'tubo', inst: 0, pInst: 0, dias: 1 },
  { codigo: 'P021', nombre: 'Codo PVC 90° 1"', cat: 'Tubería y plomería', catDesc: 'Tuberías, accesorios y grifería', desc: 'Cemento, rosca hembra', costo: 3, precio: 6, stock: 120, min: 30, uni: 'pza', inst: 0, pInst: 0, dias: 1 },
  { codigo: 'P022', nombre: 'Tee PVC 1"', cat: 'Tubería y plomería', catDesc: 'Tuberías, accesorios y grifería', desc: 'Derivación roscada hembra', costo: 3, precio: 7, stock: 110, min: 30, uni: 'pza', inst: 0, pInst: 0, dias: 1 },
  { codigo: 'P023', nombre: 'Llave de paso 1/2"', cat: 'Tubería y plomería', catDesc: 'Tuberías, accesorios y grifería', desc: 'Bronce con manivela azul', costo: 24, precio: 38, stock: 30, min: 8, uni: 'pza', inst: 0, pInst: 0, dias: 1 },
  { codigo: 'P024', nombre: 'Sifón flexible 1 1/2"', cat: 'Tubería y plomería', catDesc: 'Tuberías, accesorios y grifería', desc: 'Para lavamanos y duchas', costo: 18, precio: 29, stock: 26, min: 8, uni: 'pza', inst: 0, pInst: 0, dias: 1 },
  { codigo: 'P025', nombre: 'Grifería de lavatorio', cat: 'Tubería y plomería', catDesc: 'Tuberías, accesorios y grifería', desc: 'Cromo, incluida con manguera flexible', costo: 42, precio: 66, stock: 20, min: 6, uni: 'pza', inst: 0, pInst: 0, dias: 1 },
  { codigo: 'P026', nombre: 'Cable THHN 14 AWG (rollo 100 m)', cat: 'Electricidad', catDesc: 'Cables, protecciones y luminarias', desc: 'Cobre desnudo, 90 °C', costo: 68, precio: 99, stock: 18, min: 5, uni: 'rollo', inst: 0, pInst: 0, dias: 1 },
  { codigo: 'P027', nombre: 'Breaker termomagnético 20 A', cat: 'Electricidad', catDesc: 'Cables, protecciones y luminarias', desc: 'Curva C, unipolar', costo: 11, precio: 19, stock: 40, min: 12, uni: 'pza', inst: 0, pInst: 0, dias: 1 },
  { codigo: 'P028', nombre: 'Tomacorriente empotrable', cat: 'Electricidad', catDesc: 'Cables, protecciones y luminarias', desc: 'Bipolar, placa blanca', costo: 6, precio: 12, stock: 80, min: 20, uni: 'pza', inst: 0, pInst: 0, dias: 1 },
  { codigo: 'P029', nombre: 'Lámpara LED de techo 18 W', cat: 'Electricidad', catDesc: 'Cables, protecciones y luminarias', desc: 'Luz blanca, driver incluido', costo: 22, precio: 35, stock: 34, min: 10, uni: 'pza', inst: 0, pInst: 0, dias: 1 },
  { codigo: 'P030', nombre: 'Tablero de distribución 12 polos', cat: 'Electricidad', catDesc: 'Cables, protecciones y luminarias', desc: 'Metálico con tapa', costo: 96, precio: 142, stock: 10, min: 3, uni: 'pza', inst: 0, pInst: 0, dias: 1 },
  { codigo: 'P031', nombre: 'Taladro percutor 1/2" 750 W', cat: 'Maquinaria eléctrica', catDesc: 'Herramientas inalámbricas y de potencia', desc: 'Con maletín y 2 baterías', costo: 245, precio: 359, stock: 12, min: 3, uni: 'pza', inst: 0, pInst: 0, dias: 1 },
  { codigo: 'P032', nombre: 'Amoladora 4-1/2" 900 W', cat: 'Maquinaria eléctrica', catDesc: 'Herramientas inalámbricas y de potencia', desc: 'Disco 4-1/2" y 3 discos', costo: 148, precio: 219, stock: 14, min: 4, uni: 'pza', inst: 0, pInst: 0, dias: 1 },
  { codigo: 'P033', nombre: 'Pistola de pintura eléctrica 800 ml', cat: 'Maquinaria eléctrica', catDesc: 'Herramientas inalámbricas y de potencia', desc: 'Para paredes y muebles', costo: 176, precio: 259, stock: 8, min: 2, uni: 'pza', inst: 0, pInst: 0, dias: 1 },
  { codigo: 'P034', nombre: 'Casco de seguridad', cat: 'Seguridad industrial', catDesc: 'Casco, guantes y protección personal', desc: 'ABS con arnés de 4 puntos', costo: 16, precio: 27, stock: 40, min: 10, uni: 'pza', inst: 0, pInst: 0, dias: 1 },
  { codigo: 'P035', nombre: 'Guantes de cuero', cat: 'Seguridad industrial', catDesc: 'Casco, guantes y protección personal', desc: 'Cuero curtido, talla L', costo: 14, precio: 24, stock: 50, min: 15, uni: 'par', inst: 0, pInst: 0, dias: 1 },
  { codigo: 'P036', nombre: 'Gafas de protección', cat: 'Seguridad industrial', catDesc: 'Casco, guantes y protección personal', desc: 'Policarbonato antivaho', costo: 9, precio: 17, stock: 45, min: 12, uni: 'pza', inst: 0, pInst: 0, dias: 1 },
  { codigo: 'P037', nombre: 'Calentador de agua 50 L a gas', cat: 'Instalaciones del hogar', catDesc: 'Productos que se entregan instalados a domicilio', desc: 'Tanque vertical, instalación a gas incluida', costo: 385, precio: 545, stock: 6, min: 2, uni: 'pza', inst: 1, pInst: 60, dias: 2 },
  { codigo: 'P038', nombre: 'Inodoro con descargue y tapa', cat: 'Instalaciones del hogar', catDesc: 'Productos que se entregan instalados a domicilio', desc: 'Vitrificado, incluye taza y tapa', costo: 190, precio: 285, stock: 8, min: 2, uni: 'pza', inst: 1, pInst: 55, dias: 1 },
  { codigo: 'P039', nombre: 'Ducha eléctrica 12 kW', cat: 'Instalaciones del hogar', catDesc: 'Productos que se entregan instalados a domicilio', desc: 'Calentador instantáneo con salida', costo: 168, precio: 245, stock: 10, min: 3, uni: 'pza', inst: 1, pInst: 45, dias: 1 },
  { codigo: 'P040', nombre: 'Puerta de madera 90 cm', cat: 'Instalaciones del hogar', catDesc: 'Productos que se llegan instalados a domicilio', desc: 'Con marco, cerraja y bisagras', costo: 142, precio: 215, stock: 15, min: 4, uni: 'pza', inst: 1, pInst: 40, dias: 2 },
  { codigo: 'P041', nombre: 'Ventana de aluminio 1.2 m', cat: 'Instalaciones del hogar', catDesc: 'Productos que se entregan instalados a domicilio', desc: 'Perfil con vidrio simple', costo: 178, precio: 268, stock: 12, min: 3, uni: 'pza', inst: 1, pInst: 50, dias: 2 },
  { codigo: 'P042', nombre: 'Bomba de agua 1 HP', cat: 'Instalaciones del hogar', catDesc: 'Productos que se entregan instalados a domicilio', desc: 'Bomba centrífuga para tanque', costo: 158, precio: 235, stock: 7, min: 2, uni: 'pza', inst: 1, pInst: 35, dias: 1 },
  { codigo: 'P043', nombre: 'Portero electrónico con cámara', cat: 'Instalaciones del hogar', catDesc: 'Productos que se entregan instalados a domicilio', desc: 'Intercomunicador con apertura remota', costo: 132, precio: 198, stock: 9, min: 2, uni: 'pza', inst: 1, pInst: 45, dias: 1 },
  { codigo: 'P044', nombre: 'Tanque de agua 250 L', cat: 'Instalaciones del hogar', catDesc: 'Productos que se entregan instalados a domicilio', desc: 'Polietileno, instalación a nivel', costo: 88, precio: 132, stock: 16, min: 4, uni: 'pza', inst: 1, pInst: 40, dias: 1 },
  { codigo: 'P045', nombre: 'Piso laminado 8 mm (caja 2.13 m²)', cat: 'Instalaciones del hogar', catDesc: 'Productos que se entregan instalados a domicilio', desc: 'Diseños varios, AC4', costo: 58, precio: 88, stock: 40, min: 10, uni: 'caja', inst: 1, pInst: 30, dias: 3 },
  { codigo: 'P046', nombre: 'Escalera metálica plegable 2.5 m', cat: 'Instalaciones del hogar', catDesc: 'Productos que se entregan instalados a domicilio', desc: 'Para altillo o azotea', costo: 175, precio: 259, stock: 5, min: 2, uni: 'pza', inst: 1, pInst: 50, dias: 1 },
  { codigo: 'P047', nombre: 'Minisplit inverter 12000 BTU', cat: 'Instalaciones del hogar', catDesc: 'Productos que se entregan instalados a domicilio', desc: 'Frío/calor, incluye instalación básica', costo: 545, precio: 785, stock: 5, min: 2, uni: 'pza', inst: 1, pInst: 120, dias: 2 },
];

/* La base nació con un catálogo de abarrotes. Se reetiquetan los productos
   conservando su id —ventas, compras e instalaciones ya los referencian— para
   que el histórico siga apuntando al mismo producto con el nombre vigente,
   y se reasignan a las categorías de ferretería. */
function migrarCatalogoFerreteria() {
  if (db.prepare("SELECT 1 FROM configuracion WHERE clave = 'catalogo' AND valor = 'ferreteria'").get()) return;
  /* Base recién creada: la semilla ya insertó el catálogo de ferretería. */
  if (tableEmpty('productos')) {
    db.prepare("INSERT OR REPLACE INTO configuracion(clave, valor) VALUES('catalogo','ferreteria')").run();
    return;
  }

  db.exec('BEGIN');
  try {
    /* Primero se crean todas las categorías destino. */
    const catPorNombre = new Map();
    for (const p of CATALOGO_SEED) {
      if (!catPorNombre.has(p.cat)) catPorNombre.set(p.cat, idCategoria(p.cat, p.catDesc));
    }

    for (const p of CATALOGO_SEED) {
      const cat = catPorNombre.get(p.cat);
      /* Reetiqueta el existente o da de alta el que el catálogo anterior no tenía. */
      db.prepare(`
        UPDATE productos SET nombre=?, categoria_id=?, descripcion=?, costo=?, precio=?,
               stock_minimo=?, unidad=?, requiere_instalacion=?, precio_instalacion=?, dias_instalacion=?
         WHERE codigo = ?`).run(
        p.nombre, cat, p.desc, p.costo, p.precio, p.min, p.uni, p.inst, p.pInst, p.dias, p.codigo
      );
      idProducto(p.codigo, p.nombre, cat, p.desc, p.costo, p.precio, p.stock, p.min, p.uni, p.inst, p.pInst, p.dias);
    }

    /* El histórico guarda una copia del nombre: se actualiza para que
       los tickets y las órdenes antigüos muestren el producto vigente. */
    for (const p of CATALOGO_SEED) {
      const id = idDe('productos', 'codigo', p.codigo);
      if (!id) continue;
      db.prepare('UPDATE venta_items SET nombre = ? WHERE producto_id = ?').run(p.nombre, id);
      db.prepare('UPDATE compra_items SET nombre = ? WHERE producto_id = ?').run(p.nombre, id);
      db.prepare('UPDATE instalaciones SET producto_nombre = ?, costo = ? WHERE producto_id = ?')
        .run(p.nombre, p.pInst, id);
    }

    /* Las categorías del catálogo anterior que quedaron sin productos se retiran. */
    db.prepare('DELETE FROM categorias WHERE id NOT IN (SELECT categoria_id FROM productos WHERE categoria_id IS NOT NULL)').run();

    db.prepare("UPDATE clientes SET nombre = 'Constructora Norte S.A.C.' WHERE nombre = 'Supermercado Norte'").run();
    db.prepare("UPDATE proveedores SET nombre = 'Acero y Tornillería Andina' WHERE nombre = 'Distribuidora Central'").run();
    db.prepare("UPDATE proveedores SET nombre = 'Herramientas del Norte S.A.C.' WHERE nombre = 'Lácteos del Valle'").run();
    db.prepare("UPDATE proveedores SET nombre = 'Pinturas y Acabados El Globo' WHERE nombre = 'Limpieza Total S.A.'").run();
    db.prepare("UPDATE configuracion SET valor = 'Ferretería El Tornillo' WHERE clave = 'nombre_tienda' AND valor = 'Tienda Retail'").run();
    db.prepare("UPDATE configuracion SET valor = 'Herramientas, materiales e instalaciones' WHERE clave = 'lema' AND valor LIKE 'Gestión integral%'").run();
    db.prepare("UPDATE configuracion SET valor = 'S/' WHERE clave = 'moneda' AND valor = '$'").run();
    db.prepare("INSERT OR REPLACE INTO configuracion(clave, valor) VALUES('catalogo','ferreteria')").run();
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/* Las órdenes de servicio heredadas apuntan a productos que ya no requieren
   instalación y no tienen hora ni adelanto. Se repuntan a productos
   instalables del catálogo y se les fija la cita y el pago inicial. */
function migrarInstalacionesDemo() {
  if (db.prepare("SELECT 1 FROM configuracion WHERE clave = 'instalaciones' AND valor = 'v2'").get()) return;

  const instalables = db.prepare(
    'SELECT id, nombre, precio_instalacion, dias_instalacion FROM productos WHERE requiere_instalacion = 1 ORDER BY codigo'
  ).all();
  if (!instalables.length) return;

  const SELECT = `SELECT * FROM instalaciones WHERE hora_programada = '' OR adelanto = 0 OR costo = 0 ORDER BY id`;
  const update = db.prepare(`
    UPDATE instalaciones SET producto_id=?, producto_nombre=?, cantidad=?, costo=?, adelanto=?,
           fecha_programada=?, hora_programada=?, saldo_pagado=?, fecha_pago_saldo=?, saldo_recibido_por=?,
           monto_financiado=?
     WHERE id=?`);
  const insH = db.prepare(
    'INSERT INTO instalacion_historial(instalacion_id, estado, comentario, empleado_id, fecha) VALUES(?,?,?,?,?)'
  );

  db.exec('BEGIN');
  try {
    /* Las órdenes que dejaron pruebas manuales, sin hora de cita, se retiran. */
    db.prepare("DELETE FROM instalaciones WHERE hora_programada = '' AND producto_id IS NULL").run();

    let i = 0;
    for (const inst of db.prepare(SELECT).all()) {
      if (inst.estado === 'cancelada') continue;
      const p = instalables[i % instalables.length];
      i++;

      /* De la fecha heredada se separan día y hora; si falta, se agenda. */
      let fecha = String(inst.fecha_programada || '').slice(0, 10);
      let hora = String(inst.fecha_programada || '').slice(11, 16);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(fecha)) fecha = fechaRel(1 + (i % 7));
      if (!/^\d{2}:\d{2}$/.test(hora)) hora = `${String(9 + (i % 8)).padStart(2, '0')}:00`;

      const costo = p.precio_instalacion;
      const adelanto = round2(costo * 0.4);
      const saldo = round2(costo - adelanto);
      const liquidada = inst.estado === 'completada';

      update.run(
        p.id, p.nombre, 1, costo, adelanto, fecha, hora,
        liquidada ? saldo : 0, liquidada ? (inst.fecha_fin || fechaOffset(0, 11)) : '',
        liquidada ? inst.tecnico_id : null, inst.id,
        /* Estas órdenes son anteriores al cobro por técnico: solo financiaban
           la instalación, así que su monto financiado es su propio costo. */
        costo
      );
      if (adelanto > 0) {
        insH.run(inst.id, 'adelanto', `Adelanto de S/${adelanto.toFixed(2)} recibido en caja`, inst.asesor_id, inst.fecha);
      }
      if (liquidada) {
        insH.run(inst.id, 'saldo_pagado', `Saldo de S/${saldo.toFixed(2)} cobrado por el técnico`, inst.tecnico_id, masMinutos(inst.fecha_fin || fechaOffset(0, 11), 5));
      }
    }
    db.prepare("INSERT OR REPLACE INTO configuracion(clave, valor) VALUES('instalaciones','v2')").run();
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

function ahoraISO() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(d.getSeconds()).padStart(2, '0')}`;
}

function fechaOffset(dias, hora = 10) {
  const d = new Date();
  d.setDate(d.getDate() + dias);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(hora).padStart(2, '0')}:00:00`;
}

function masMinutos(iso, minutos) {
  const d = new Date(String(iso).replace(' ', 'T'));
  if (Number.isNaN(d.getTime())) return iso;
  d.setMinutes(d.getMinutes() + minutos);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:00`;
}

function fechaRel(dias) {
  const d = new Date();
  d.setDate(d.getDate() + dias);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function seedVentas(sucursalId) {
  const hoy = new Date();
  const configIva = Number(getConfig('iva')) || 16;
  const prefijo = getConfig('prefijo_venta') || 'V';
  if (!sucursalId) sucursalId = null;
  /* [código de producto, cantidad, ¿quiere instalación?, fecha y hora programada] */
  const ventas = [
    { dias: 0, cliente: 2, metodo: 'efectivo', items: [['P001', 2, null], ['P014', 1, null], ['P021', 4, null]], horas: [9, 12, 16] },
    { dias: 0, cliente: 1, metodo: 'tarjeta', items: [['P031', 1, '2026-02-18 09:00'], ['P011', 2, '2026-02-18 09:00']], horas: [10, 14] },
    { dias: 1, cliente: 3, metodo: 'efectivo', items: [['P020', 3, null], ['P022', 6, null], ['P013', 1, null]], horas: [11, 15] },
    { dias: 1, cliente: 1, metodo: 'transferencia', items: [['P037', 1, '2026-02-19 10:30'], ['P040', 1, '2026-02-19 10:30']], horas: [17] },
    { dias: 2, cliente: 4, metodo: 'transferencia', items: [['P009', 10, null], ['P012', 8, null], ['P010', 4, null]], horas: [10] },
    { dias: 3, cliente: 2, metodo: 'efectivo', items: [['P016', 6, null], ['P018', 2, null]], horas: [13] },
    { dias: 4, cliente: 1, metodo: 'tarjeta', items: [['P002', 2, null], ['P003', 1, null], ['P006', 1, null]], horas: [12, 18] },
    { dias: 5, cliente: 3, metodo: 'efectivo', items: [['P026', 1, '2026-02-20 15:00'], ['P028', 6, null]], horas: [16] },
    { dias: 6, cliente: 1, metodo: 'efectivo', items: [['P001', 2, null], ['P023', 1, null], ['P008', 2, null]], horas: [11] },
    { dias: 7, cliente: 4, metodo: 'transferencia', items: [['P005', 2, null], ['P006', 3, null], ['P013', 2, null]], horas: [9] },
  ];
  const insV = db.prepare(
    `INSERT INTO ventas(numero, fecha, cliente_id, empleado_id, sucursal_id, subtotal, descuento, impuestos, total, costo_total, metodo_pago, monto_pagado, destino_id, referencia, notas)
     VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
  );
  const insI = db.prepare(
    'INSERT INTO venta_items(venta_id, producto_id, nombre, cantidad, precio, precio_instalacion, costo, subtotal) VALUES(?,?,?,?,?,?,?,?)'
  );
  const getProd = db.prepare('SELECT * FROM productos WHERE codigo = ?');
  const insCaja = db.prepare(
    "INSERT OR IGNORE INTO destinos_pago(sucursal_id, nombre, tipo, identificador, activo) VALUES(?,?,?,?,1)"
  );
  const sucursalesAll = db.prepare('SELECT id, nombre FROM sucursales WHERE activo=1').all();
  for (const sc of sucursalesAll) {
    const c = db.prepare("SELECT id FROM destinos_pago WHERE sucursal_id=? AND tipo='efectivo'").get(sc.id);
    if (!c) insCaja.run(sc.id, 'Caja ' + sc.nombre, 'efectivo', '');
  }
  const getEmpleado = db.prepare("SELECT id FROM empleados WHERE rol = 'asesor' ORDER BY id LIMIT 1");
  const asesorId = getEmpleado.get()?.id || null;
  let num = 1;
  for (const v of ventas) {
    let subtotal = 0, costo = 0;
    let destId = null;
    const lines = [];
    for (const [codigo, cant, programada] of v.items) {
      const p = getProd.get(codigo);
      if (!p) continue;
      const pInst = programada ? p.precio_instalacion * cant : 0;
      const sub = round2(p.precio * cant + pInst);
      subtotal += sub;
      costo += round2(p.costo * cant);
      lines.push({ p, cant, sub, pInst, programada });
    }
    subtotal = round2(subtotal);
    costo = round2(costo);
    const impuestos = round2(subtotal * (configIva / 100));
    const total = round2(subtotal + impuestos);
    const fecha = new Date(hoy);
    fecha.setDate(fecha.getDate() - v.dias);
    fecha.setHours(v.horas[0], (num * 7) % 60, 0, 0);
    const iso = fecha.toISOString().slice(0, 19).replace('T', ' ');
    const numero = `${prefijo}-${String(num).padStart(5, '0')}`;
    if (v.metodo === 'efectivo') {
      const c = db.prepare("SELECT id FROM destinos_pago WHERE sucursal_id=? AND tipo='efectivo' LIMIT 1").get(sucursalId);
      if (c) destId = c.id;
    }
    const r = insV.run(numero, iso, v.cliente, asesorId, sucursalId, subtotal, 0, impuestos, total, costo, v.metodo, total, destId, '', '');
    const ventaId = Number(r.lastInsertRowid);
    for (const l of lines) {
      insI.run(ventaId, l.p.id, l.p.nombre, l.cant, l.p.precio, l.pInst, l.p.costo, l.sub);
    }
    num++;
  }
}

/* Órdenes de servicio de demostración para que el módulo arranque con datos.
   Toda instalación nace con un adelanto pagado en el punto de venta; el saldo
   se liquida con el técnico al terminar el trabajo. */
function seedInstalaciones(sucursalPrincipal) {
  const prefijo = getConfig('prefijo_instalacion') || 'INS';
  const sucursalNorte = idDe('sucursales', 'codigo', 'S02') || sucursalPrincipal;
  const tecnico1 = idDe('empleados', 'usuario', 'tecnico');
  const tecnico2 = idDe('empleados', 'usuario', 'marco');
  const asesor = db.prepare("SELECT id FROM empleados WHERE rol = 'asesor' ORDER BY id LIMIT 1").get()?.id || null;
  const catalogo = ['P037', 'P040', 'P044', 'P038', 'P041', 'P047'];
  const clientes = [
    { id: idDe('clientes', 'codigo', 'C002'), direccion: 'Calle Rosa 45, Dpto 3B', contacto: '555-2001' },
    { id: idDe('clientes', 'codigo', 'C003'), direccion: 'Av. Sol 12, casa 7', contacto: '555-2002' },
    { id: null, nombre: 'Familia Paredes', documento: 'DNI-44556677', direccion: 'Barrio Los Pinos, calle 4 #22', contacto: '555-2044' },
  ];

  const ins = db.prepare(`
    INSERT INTO instalaciones(codigo, fecha, cliente_id, sucursal_id, producto_id, producto_nombre,
                             cantidad, tecnico_id, asesor_id, direccion, contacto, fecha_programada,
                             hora_programada, estado, costo, adelanto, saldo_pagado, fecha_pago_saldo,
                             saldo_recibido_por, notas, fecha_inicio, fecha_fin)
    VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`);
  const insH = db.prepare(
    'INSERT INTO instalacion_historial(instalacion_id, estado, comentario, empleado_id, fecha) VALUES(?,?,?,?,?)'
  );

  let num = 1;
  catalogo.forEach((codigo, i) => {
    const p = db.prepare('SELECT * FROM productos WHERE codigo = ?').get(codigo);
    if (!p) return;
    const cli = clientes[i % clientes.length];
    if (cli.id === null) {
      db.prepare('INSERT INTO clientes(codigo, nombre, documento, telefono, direccion) VALUES(?,?,?,?,?)')
        .run(`C${String(900 + i).padStart(5, '0')}`, cli.nombre, cli.documento, cli.contacto, cli.direccion);
      cli.id = idDe('clientes', 'codigo', `C${String(900 + i).padStart(5, '0')}`);
    }
    const dias = i + 1;
    const tecnico = i % 2 === 0 ? tecnico1 : tecnico2;
    const estado = ['completada', 'en_progreso', 'programada', 'programada', 'pendiente', 'pendiente'][i];
    const fechaProg = fechaOffset(dias);
    const horaProg = `${String(9 + (i % 6)).padStart(2, '0')}:00`;
    /* El cliente entrega el 40 % como adelanto al momento de la venta. */
    const adelanto = round2(p.precio_instalacion * 0.4);
    const saldo = round2(p.precio_instalacion - adelanto);
    const liquidada = estado === 'completada';
    const r = ins.run(
      `${prefijo}-${String(num).padStart(5, '0')}`, fechaOffset(-dias, 16), cli.id,
      i % 2 === 0 ? sucursalPrincipal : sucursalNorte, p.id, p.nombre, 1,
      estado === 'pendiente' ? null : tecnico, asesor,
      cli.direccion, cli.contacto, fechaProg, horaProg, estado, p.precio_instalacion,
      adelanto, liquidada ? saldo : 0, liquidada ? fechaOffset(0, 11) : '',
      liquidada ? tecnico : null,
      i % 3 === 0 ? 'El cliente solicita llamar antes de llegar.' : '',
      estado === 'en_progreso' || estado === 'completada' ? fechaOffset(0, 9) : '',
      estado === 'completada' ? fechaOffset(0, 11) : ''
    );
    const instId = Number(r.lastInsertRowid);
    insH.run(instId, 'pendiente', 'Orden generada en el punto de venta', asesor, fechaOffset(-dias, 16));
    if (tecnico) insH.run(instId, 'programada', `Asignada al técnico ${i % 2 === 0 ? 'Carlos Técnico' : 'Marco Instalador'}`, asesor, fechaOffset(-dias, 16));
    if (adelanto > 0) insH.run(instId, 'adelanto', `Adelanto de S/${adelanto.toFixed(2)} recibido en caja`, asesor, fechaOffset(-dias, 16));
    if (estado === 'en_progreso') insH.run(instId, 'en_progreso', 'Técnico en sitio, instalación en curso', tecnico, fechaOffset(0, 9));
    if (estado === 'completada') {
      insH.run(instId, 'en_progreso', 'Técnico en sitio', tecnico, fechaOffset(0, 9));
      insH.run(instId, 'completada', 'Instalación verificada y aprobada por el cliente', tecnico, fechaOffset(0, 11));
      if (liquidada) insH.run(instId, 'saldo_pagado', `Saldo de S/${saldo.toFixed(2)} cobrado al técnico`, tecnico, fechaOffset(0, 11));
    }
    num++;
  });
}

seed();

export function getConfig(clave) {
  const row = db.prepare('SELECT valor FROM configuracion WHERE clave = ?').get(clave);
  return row ? row.valor : null;
}

export function getAllConfig() {
  const out = {};
  for (const r of db.prepare('SELECT clave, valor FROM configuracion').all()) out[r.clave] = r.valor;
  return out;
}

export function ahora() {
  return ahoraISO();
}

export function sigNumero(tabla, prefijo, campo = 'numero') {
  const row = db.prepare(`SELECT ${campo} AS n FROM ${tabla} ORDER BY id DESC LIMIT 1`).get();
  let max = 0;
  if (row && row.n) {
    const m = String(row.n).match(/(\d+)$/);
    if (m) max = Number(m[1]);
  }
  return `${prefijo}-${String(max + 1).padStart(5, '0')}`;
}

/* El código de producto sigue el formato P001, P002… (prefijo + correlativo sin
   guion, como el que ya usa el catálogo). Se toma el correlativo más alto, no el
   último insertado, para no repetir un código si se dio de alta uno manual. */
export function sigCodigoProducto() {
  const filas = db.prepare("SELECT codigo FROM productos WHERE codigo GLOB 'P[0-9]*'").all();
  let max = 0;
  let ancho = 3;
  for (const f of filas) {
    const m = String(f.codigo).match(/^P(\d+)$/);
    if (m && Number(m[1]) > max) { max = Number(m[1]); ancho = m[1].length; }
  }
  return `P${String(max + 1).padStart(ancho, '0')}`;
}

/* El prefijo de los códigos de barras se configura desde Ajustes para que cada
   tienda use su rango y no choque con los de otra tienda si se mezclan
   inventarios. Solo dígitos: el lector los lee sin ambigüedad. */
function prefijoBarras() {
  const crudo = String(getConfig('prefijo_barras') ?? '200');
  const digitos = crudo.replace(/\D/g, '').slice(0, 4) || '200';
  return digitos;
}

/* Código de barras propio: prefijo de la tienda + 5 dígitos correlativos
   (20000001). Se toma el correlativo más alto ya usado, nunca el id del
   producto, así el código no cambia aunque se reordenen o borren filas. */
export function sigCodigoBarras() {
  const prefijo = prefijoBarras();
  const ancho = 5;
  const filas = db.prepare('SELECT codigo_barras FROM productos WHERE codigo_barras IS NOT NULL AND codigo_barras != ?').all(prefijo);
  let max = 0;
  for (const f of filas) {
    const m = String(f.codigo_barras).match(new RegExp(`^${prefijo}(\\d{${ancho}})$`));
    if (m && Number(m[1]) > max) max = Number(m[1]);
  }
  if (max + 1 > 10 ** ancho) throw new Error('Se agotó la serie de códigos de barras; cambia el prefijo en Ajustes');
  return `${prefijo}${String(max + 1).padStart(ancho, '0')}`;
}

/* Normaliza lo que llega del lector o del formulario: solo dígitos, sin
   espacios. Devuelve cadena vacía si no queda nada utilizable. */
export function normalizarCodigoBarras(valor) {
  return String(valor ?? '').trim().replace(/\D/g, '');
}
