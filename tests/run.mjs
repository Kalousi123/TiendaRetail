import { mkdtemp, cp, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import mysql from 'mysql2/promise';

const project=fileURLToPath(new URL('../',import.meta.url));
/* Sin esto el arnés no veía DB_USER ni DB_PASSWORD (viven en .env, no en el
   entorno) y se connectaba como root sin clave, que es como no arrancaba. */
try{process.loadEnvFile(join(project,'.env'));}catch{}
const sandbox=await mkdtemp(join(tmpdir(),'retail-tests-'));
const database=`retail_test_${Date.now()}_${process.pid}`;
const env={...process.env,TZ:'America/Lima',DB_NAME:database,IMPORT_QUIET:'1',RETAIL_TEST_APP:sandbox,UPLOAD_DIR:join(sandbox,'evidence')};
const appUser=process.env.DB_USER||'retail';
/* La base de pruebas es nueva en cada corrida y el usuario de la aplicación
   solo tiene privilegios sobre la suya, así que el alta se hace con root y la
   base creada se le concede a mano. */
const admin=await mysql.createConnection({host:process.env.DB_HOST||'127.0.0.1',port:Number(process.env.DB_PORT||3306),user:'root',password:process.env.MYSQL_ROOT_PASSWORD||process.env.DB_PASSWORD||'',...(process.env.DB_SOCKET?{socketPath:process.env.DB_SOCKET}:{})});
let server,serverLog='';const children=new Set();
async function run(relative,args=[],extra={}){
 const child=spawn(process.execPath,[join(sandbox,relative),...args],{env:{...env,...extra},stdio:'inherit',cwd:sandbox});children.add(child);
 const [code]=await once(child,'exit');children.delete(child);if(code!==0)throw new Error(`${relative}: código ${code}`);
}
try{
 await admin.query(`CREATE DATABASE \`${database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_bin`);
 await admin.query(`GRANT ALL PRIVILEGES ON \`${database}\`.* TO ?@'%'`,[appUser]);
 for(const name of ['src','public','package.json','scripts','migrations','tests'])await cp(join(project,name),join(sandbox,name),{recursive:true});
 await symlink(join(project,'node_modules'),join(sandbox,'node_modules'),'dir');
 await run('scripts/migrate.js');
 await run('scripts/demo-sqlite.js',[],{DEMO_SQLITE_PATH:join(sandbox,'demo.db')});
 await run('scripts/import-sqlite.js',[join(sandbox,'demo.db'),join(sandbox,'backups')]);
 await run('tests/fixtures.mjs');
 server=spawn(process.execPath,[join(sandbox,'src/server.js')],{cwd:sandbox,env:{...env,PORT:'0'},stdio:['ignore','pipe','pipe']});
 const port=await new Promise((resolve,reject)=>{
  const timer=setTimeout(()=>reject(new Error('Servidor no inició')),10000);
  server.stdout.on('data',data=>{serverLog+=data;const match=serverLog.match(/Servidor: http:\/\/localhost:(\d+)/);if(match){clearTimeout(timer);resolve(match[1]);}});
  server.stderr.on('data',data=>{serverLog+=data;});
  server.once('exit',code=>{clearTimeout(timer);reject(new Error(`Servidor terminó: ${code}\n${serverLog}`));});
 });
 await run('tests/api.mjs',[port]);
 await run('tests/features-api.mjs',[port]);
 if(!process.env.SKIP_UI){await run('tests/ui-existing.mjs',[port]);await run('tests/ui.mjs',[port]);}
 if(/^ERROR:/m.test(serverLog))throw new Error(serverLog);
 console.log('\nTodas las pruebas pasaron con MySQL y archivos aislados.');
}catch(error){console.error(error);console.error(serverLog);process.exitCode=1;}
finally{
 for(const child of children)child.kill();
 if(server&&server.exitCode===null){server.kill();await once(server,'exit');}
 if(process.env.KEEP_TEST_ARTIFACTS){await writeFile(join(sandbox,'server.log'),serverLog);console.log(`Artefactos: ${sandbox}; base: ${database}`);}
 else{await admin.query(`DROP DATABASE \`${database}\``);await rm(sandbox,{recursive:true,force:true});}
 await admin.end();
}
