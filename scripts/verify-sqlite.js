// Read-only verification against a disposable MySQL schema. Never switches production.
import mysql from 'mysql2/promise';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
if(!process.argv[2])throw new Error('Indica la ruta de SQLite');
const name=`retail_verify_${Date.now()}_${process.pid}`;
const conn=await mysql.createConnection({host:process.env.DB_HOST||'127.0.0.1',port:Number(process.env.DB_PORT||3306),user:process.env.DB_USER||'root',password:process.env.DB_PASSWORD||'',...(process.env.DB_SOCKET?{socketPath:process.env.DB_SOCKET}:{})});
const directory=await mkdtemp(join(tmpdir(),'retail-verify-'));
let pool;
try{
 await conn.query(`CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`);
 process.env.DB_NAME=name;
 ({pool}=await import('../src/mysql.js'));
 const {migrate}=await import('./migrate.js');await migrate();
 const {importSqlite}=await import('./import-sqlite.js');
 const report=await importSqlite(resolve(process.argv[2]),directory);
 console.log('Verificación completa: '+report.tables.map(t=>`${t.table}: ${t.rows}`).join(', '));
}finally{
 if(pool)await pool.end();
 await conn.query(`DROP DATABASE \`${name}\``);await conn.end();await rm(directory,{recursive:true,force:true});
}
