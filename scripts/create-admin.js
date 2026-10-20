import { db, hashPassword } from '../src/db.js';
import { pool } from '../src/mysql.js';
import { ask, hidden, cerrar } from './hidden-password.js';

try {
  const admin = await db.prepare("SELECT id FROM empleados WHERE rol='admin' AND activo=1 LIMIT 1").get();
  if (admin) throw new Error('Ya existe un administrador activo.');
  const nombre = (await ask('Nombre del administrador: ')).trim();
  const usuario = (await ask('Usuario para iniciar sesión: ')).trim().toLowerCase();
  const clave = await hidden('Contraseña (mínimo 12 caracteres, entrada oculta): ');
  const confirmacion = await hidden('Repite la contraseña: ');
  if (nombre.length < 2 || nombre.length > 120) throw new Error('El nombre debe tener entre 2 y 120 caracteres.');
  if (!/^[a-z0-9._-]{3,64}$/.test(usuario)) throw new Error('El usuario debe tener entre 3 y 64 letras, dígitos, puntos, guiones o guiones bajos.');
  if (clave.length < 12) throw new Error('La contraseña debe tener al menos 12 caracteres.');
  if (clave !== confirmacion) throw new Error('Las contraseñas no coinciden.');
  if (await db.prepare('SELECT id FROM empleados WHERE usuario=?').get(usuario)) throw new Error('Ese nombre de usuario ya existe.');
  await db.prepare("INSERT INTO empleados(nombre,usuario,clave_hash,rol) VALUES(?,?,?,'admin')").run(nombre, usuario, hashPassword(clave));
  console.log(`Administrador ${usuario} creado.`);
} finally { cerrar(); await pool.end(); }
