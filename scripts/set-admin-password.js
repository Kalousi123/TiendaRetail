/* Cambia la contraseña del administrador sin borrarlo.

   Existe porque borrar al administrador es el camino corto a quedarse sin
   sistema: es el único rol con permiso para todo y el único que puede crear
   usuarios, productos y configuración. Con este script la cuenta se conserva
   (mismo usuario, mismo id, mismos permisos) y solo se le pone una clave nueva.

   Uso:  npm run db:admin:clave  [--usuario nombre]

   La clave se escribe a ciegas, igual que al crear el administrador, y Ctrl+C
   cancela sin tocar nada. */

import { db, hashPassword } from '../src/db.js';
import { pool } from '../src/mysql.js';
import { ask, hidden, cerrar } from './hidden-password.js';

const MINIMO = 12;

/* Con varios administradores se pregunta cuál: cambiar la clave equivocada es
   peor que no cambiarla. */
async function elegir(admins) {
  console.log('Hay más de un administrador activo:');
  admins.forEach((a, i) => console.log(`  ${i + 1}) ${a.nombre} (${a.usuario})`));
  const opcion = (await ask('¿A cuál se le cambia la clave? número: ')).trim();
  const elegido = admins[Number(opcion) - 1];
  if (!elegido) throw new Error('Opción inválida');
  return elegido;
}

try {
  const admins = await db.prepare("SELECT id,nombre,usuario FROM empleados WHERE rol='admin' AND activo=1 ORDER BY id").all();
  if (!admins.length) throw new Error('No hay ningún administrador activo. Crea uno con: npm run db:admin');
  const pedido = process.argv.indexOf('--usuario');
  const usuario = pedido > -1 ? String(process.argv[pedido + 1] || '').trim().toLowerCase() : '';
  if (pedido > -1 && !usuario) throw new Error('Falta el nombre de usuario después de --usuario');
  const objetivo = usuario ? admins.find(a => a.usuario === usuario) : (admins.length === 1 ? admins[0] : await elegir(admins));
  if (!objetivo) throw new Error(`${usuario} no es un administrador activo. Activos: ${admins.map(a => a.usuario).join(', ')}`);
  console.log(`Administrador: ${objetivo.nombre} (${objetivo.usuario})`);
  const clave = await hidden(`Contraseña nueva (mínimo ${MINIMO} caracteres, entrada oculta): `);
  const confirmacion = await hidden('Repite la contraseña: ');
  if (clave.length < MINIMO) throw new Error(`La contraseña debe tener al menos ${MINIMO} caracteres.`);
  if (clave !== confirmacion) throw new Error('Las contraseñas no coinciden.');
  await db.prepare('UPDATE empleados SET clave_hash=? WHERE id=?').run(hashPassword(clave), objetivo.id);
  console.log(`Contraseña de ${objetivo.usuario} actualizada. Las sesiones ya abiertas siguen vigentes.`);
} finally { cerrar(); await pool.end(); }
