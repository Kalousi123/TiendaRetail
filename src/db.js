import { scryptSync, randomBytes, timingSafeEqual } from 'node:crypto';
export { db, withDatabase } from './mysql.js';
import { db } from './mysql.js';
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


export async function getConfig(clave) {
  const row = (await db.prepare('SELECT valor FROM configuracion WHERE clave = ?').get(clave));
  return row ? row.valor : null;
}

export async function getAllConfig() {
  const out = {};
  for (const r of (await db.prepare('SELECT clave, valor FROM configuracion').all())) out[r.clave] = r.valor;
  return out;
}

export function ahora() {
  return new Date().toLocaleString('sv-SE', { timeZone: 'America/Lima' });
}

export async function sigNumero(tabla, prefijo, campo = 'numero') {
  /* Se toma el correlativo más alto y no la última fila insertada. La última por
     id no siempre es la más alta: una alta manual, una importación o una venta
     con un numero sin correlativo la dejan atrás, y entonces el siguiente
     número sale repetido y la venta se cae con duplicate entry. Solo se cuentan
     los que terminan en cifras, que es lo único que se puede continuar. */
  const row = (await db.prepare(
    `SELECT MAX(CAST(SUBSTRING_INDEX(${campo}, '-', -1) AS UNSIGNED)) AS n
     FROM ${tabla} WHERE ${campo} REGEXP '[0-9]+$'`).get());
  return `${prefijo}-${String((Number(row && row.n) || 0) + 1).padStart(5, '0')}`;
}

/* El código de producto sigue el formato P001, P002… (prefijo + correlativo sin
   guion, como el que ya usa el catálogo). Se toma el correlativo más alto, no el
   último insertado, para no repetir un código si se dio de alta uno manual. */
export async function sigCodigoProducto() {
  const filas = (await db.prepare("SELECT codigo FROM productos WHERE codigo REGEXP '^P[0-9]'").all());
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
async function prefijoBarras() {
  const crudo = String((await getConfig('prefijo_barras')) ?? '200');
  const digitos = crudo.replace(/\D/g, '').slice(0, 4) || '200';
  return digitos;
}

/* Código de barras propio: prefijo de la tienda + 5 dígitos correlativos
   (20000001). Se toma el correlativo más alto ya usado, nunca el id del
   producto, así el código no cambia aunque se reordenen o borren filas. */
export async function sigCodigoBarras() {
  const prefijo = (await prefijoBarras());
  const ancho = 5;
  const filas = (await db.prepare('SELECT codigo_barras FROM productos WHERE codigo_barras IS NOT NULL AND codigo_barras != ?').all(prefijo));
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

/* La clave con la que se compara un nombre de producto para saber si dos son el
   mismo artículo. Sin tildes, sin mayúsculas y sin espacios de sobra: "Cemento
    PORTLAND" y "Cemento Portánd" tienen que cuente como el mismo producto,
   porque quien los escribió quiso lo mismo aunque el teclado decidiera por su
   cuenta. La comparación real la hace SQL sobre la columna nombre_clave, así que
   esta función tiene que quedar igual que el LOWER/TRIM de la migración 004 en
   todo lo que SQL sabe hacer, y es la que además pliega tildes. */
export function normalizarNombre(valor) {
  return String(valor ?? '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}
