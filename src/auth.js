import { randomBytes } from 'node:crypto';
import { db } from './db.js';

const sessions = new Map();
const SESSION_TTL = 1000 * 60 * 60 * 12;

export function createSession(empleadoId) {
  const token = randomBytes(24).toString('hex');
  sessions.set(token, { empleadoId, exp: Date.now() + SESSION_TTL });
  return token;
}

export function destroySession(token) {
  sessions.delete(token);
}

export async function getEmpleadoByToken(token) {
  if (!token) return null;
  const s = sessions.get(token);
  if (!s) return null;
  if (s.exp < Date.now()) {
    sessions.delete(token);
    return null;
  }
  return (await db.prepare(`
    SELECT e.id, e.nombre, e.usuario, e.rol, e.telefono, e.sucursal_id,
           su.nombre AS sucursal_nombre
    FROM empleados e
    LEFT JOIN sucursales su ON su.id = e.sucursal_id
    WHERE e.id = ? AND e.activo = 1`).get(s.empleadoId));
}

export function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > -1) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export const COOKIE_NAME = 'tienda_sesion';