import { DatabaseSync, backup } from 'node:sqlite';
import { resolve, join } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { db, withDatabase } from '../src/db.js';
import { pool } from '../src/mysql.js';

const canonical = row => JSON.stringify(Object.fromEntries(Object.entries(row).sort(([a],[b])=>a.localeCompare(b))));
const digest = rows => createHash('sha256').update(rows.map(canonical).sort().join('\n')).digest('hex');
export async function importSqlite(sourcePath, backupDirectory) {
  const source = new DatabaseSync(resolve(sourcePath), {readOnly:true});
  let snapshot;
  try {
    await mkdir(backupDirectory,{recursive:true});
    snapshot=join(backupDirectory,`sqlite-${Date.now()}.db`);
    await backup(source,snapshot);
  } finally { source.close(); }
  const sqlite=new DatabaseSync(snapshot,{readOnly:true});
  try {
    if(sqlite.prepare('PRAGMA integrity_check').get().integrity_check!=='ok')throw new Error('SQLite no supera integrity_check');
    if(sqlite.prepare('PRAGMA foreign_key_check').all().length)throw new Error('SQLite contiene referencias inválidas');
    const tables=sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map(r=>r.name);
    const known=new Set((await db.prepare('SELECT TABLE_NAME AS name FROM information_schema.tables WHERE TABLE_SCHEMA=DATABASE()').all()).map(r=>r.name));
    for(const table of tables)if(!known.has(table)||!/^\w+$/.test(table))throw new Error(`Tabla no reconocida: ${table}`);
    const pending=new Set(tables),ordered=[];
    while(pending.size){
      const available=[...pending].filter(table=>sqlite.prepare(`PRAGMA foreign_key_list("${table}")`).all().every(f=>!pending.has(f.table)||f.table===table));
      if(!available.length)throw new Error('Hay dependencias cíclicas en SQLite');
      for(const table of available){ordered.push(table);pending.delete(table);}
    }
    const report=[];
    await withDatabase(true,async()=>{
      for(const table of tables)if((await db.prepare(`SELECT COUNT(*) AS n FROM \`${table}\``).get()).n)throw new Error(`La tabla ${table} no está vacía. No se sobrescribió nada.`);
      for(const table of ordered){
        const rows=sqlite.prepare(`SELECT * FROM "${table}"`).all();
        const columns=sqlite.prepare(`PRAGMA table_info("${table}")`).all().map(c=>c.name);
        const target=(await db.prepare(`SHOW COLUMNS FROM \`${table}\``).all()).map(c=>c.Field);
        if(columns.some(c=>!target.includes(c)))throw new Error(`Columnas incompatibles en ${table}`);
        const statement=db.prepare(`INSERT INTO \`${table}\` (${columns.map(c=>'`'+c+'`').join(',')}) VALUES (${columns.map(()=>'?').join(',')})`);
        for(const row of rows)await statement.run(...columns.map(c=>row[c]));
        const imported=await db.prepare(`SELECT ${columns.map(c=>'`'+c+'`').join(',')} FROM \`${table}\``).all();
        if(rows.length!==imported.length || digest(rows)!==digest(imported))throw new Error(`La validación completa de ${table} falló; se revertirá la importación`);
        report.push({table,rows:rows.length,sha256:digest(rows)});
      }
    });
    return {snapshot,tables:report};
  } finally {sqlite.close();}
}
if(process.argv[1]===new URL(import.meta.url).pathname){
 try {
  if(!process.argv[2])throw new Error('Uso: node scripts/import-sqlite.js /ruta/tienda.db [/ruta/backups]');
  const result = await importSqlite(process.argv[2],resolve(process.argv[3]||'data/backups'));
  console.log(process.env.IMPORT_QUIET ? `Importadas y verificadas ${result.tables.length} tablas` : JSON.stringify(result,null,2));
 } finally {await pool.end();}
}
