import './env.js';
import mysql from 'mysql2/promise';
import { AsyncLocalStorage } from 'node:async_hooks';

const context = new AsyncLocalStorage();
export const pool = mysql.createPool({
  host: process.env.DB_HOST || '127.0.0.1', port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || 'retail', password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'retail', connectionLimit: 10,
  decimalNumbers: true, dateStrings: true, charset: 'utf8mb4',
  ...(process.env.DB_SOCKET ? { socketPath: process.env.DB_SOCKET } : {}),
  ...(process.env.DB_SSL === 'true' ? { ssl: { rejectUnauthorized: true } } : {}),
});

async function connectionWork(fn) {
  const existing = context.getStore();
  if (existing) return fn(existing.connection);
  const connection = await pool.getConnection();
  try {
    await connection.query("SET time_zone = '-05:00'");
    return await fn(connection);
  } finally { connection.release(); }
}

// A single write lock covers validation and mutation, including existing legacy
// operations whose BEGIN appears after their reads. It also spans server replicas.
// Keep transaction commands inside routes declarative: the request owns commit.
export async function withDatabase(write, fn) {
  if (context.getStore()) return fn();
  const connection = await pool.getConnection();
  let locked = false;
  const lockName = `retail-write:${process.env.DB_NAME || 'retail'}`.slice(0, 64);
  try {
    await connection.query("SET time_zone = '-05:00'");
    if (write) {
      const [rows] = await connection.query('SELECT GET_LOCK(?, 15) AS acquired', [lockName]);
      if (rows[0].acquired !== 1) throw new Error('No se pudo obtener el bloqueo de escritura');
      locked = true;
    }
    await connection.beginTransaction();
    const result = await context.run({ connection }, fn);
    await connection.commit();
    return result;
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    try { if (locked) await connection.query('SELECT RELEASE_LOCK(?)', [lockName]); }
    finally { connection.release(); }
  }
}

export const db = {
  prepare(sql) {
    const execute = (...args) => connectionWork(async (connection) => {
      const [result] = await connection.query(sql, args.map(x => x === undefined ? null : x));
      return result;
    });
    return {
      all: execute,
      get: async (...args) => (await execute(...args))[0],
      run: async (...args) => {
        const result = await execute(...args);
        return { lastInsertRowid: result.insertId, changes: result.affectedRows };
      },
    };
  },
  async exec(sql) {
    if (/^(BEGIN|COMMIT|ROLLBACK)$/.test(sql.trim())) {
      if (!context.getStore()) throw new Error('Use withDatabase for transactions');
      return;
    }
    return connectionWork(connection => connection.query(sql));
  },
  close: () => pool.end(),
};
