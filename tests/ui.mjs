/* Pruebas de interfaz sobre el SANDBOX (ver run-tests.sh).
   Sin dependencias: habla CDP por el WebSocket nativo de Node 22+.

   Se fija Chromium con puerto propio y se vigila que no quede mirando la base
   real: la app bajo prueba es siempre la del sandbox. */

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PUERTO_APP = process.argv[2] || 4599;
let PUERTO_CDP;
const BASE = `http://127.0.0.1:${PUERTO_APP}`;
const fixtures = JSON.parse(readFileSync(join(process.env.RETAIL_TEST_APP, 'fixtures.json'), 'utf8'));

let fallos = 0, ok = 0;
const erroresConsola = [];

function check(nombre, cond, detalle = '') {
  if (cond) { ok++; console.log(`  ok   ${nombre}`); }
  else { fallos++; console.log(`  FALLA ${nombre} ${detalle}`); }
}

const perfil = mkdtempSync(join(tmpdir(), 'chrome-e2e-'));
const chrome = spawn('/usr/bin/chromium', [
  '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
  '--remote-debugging-port=0', `--user-data-dir=${perfil}`,
  '--window-size=1400,1000', 'about:blank',
], { stdio: 'ignore' });

let ws, idMsg = 0;
const pendientes = new Map();

function send(method, params = {}) {
  const id = ++idMsg;
  ws.send(JSON.stringify({ id, method, params }));
  return new Promise((res, rej) => {
    pendientes.set(id, { res, rej });
    setTimeout(() => { if (pendientes.has(id)) { pendientes.delete(id); rej(new Error(`timeout ${method}`)); } }, 30000).unref();
  });
}

async function evaluar(expr) {
  const r = await send('Runtime.evaluate', {
    expression: expr, returnByValue: true, awaitPromise: true,
  });
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'error en la pagina');
  return r.result.value;
}

const esperar = (ms) => new Promise((r) => setTimeout(r, ms));

async function esperarPor(fn, timeout = 12000, paso = 200) {
  const fin = Date.now() + timeout;
  while (Date.now() < fin) {
    if (await fn()) return true;
    await esperar(paso);
  }
  return false;
}

try {
  // --- Conectar al navegador ---
  let info = null;
  for (let i = 0; i < 60; i++) {
    try {
      PUERTO_CDP = Number(readFileSync(join(perfil, 'DevToolsActivePort'), 'utf8').split('\n')[0]);
      const r = await fetch(`http://127.0.0.1:${PUERTO_CDP}/json/version`);
      info = await r.json();
      break;
    } catch { await esperar(250); }
  }
  if (!info) throw new Error('Chromium no levanto');

  const target = await (await fetch(`http://127.0.0.1:${PUERTO_CDP}/json/new?about:blank`, { method: 'PUT' })).json();
  ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pendientes.has(m.id)) {
      const { res, rej } = pendientes.get(m.id);
      pendientes.delete(m.id);
      m.error ? rej(new Error(m.error.message)) : res(m.result);
    }
    if (m.method === 'Page.javascriptDialogOpening') {
      erroresConsola.push('Diálogo nativo inesperado: '+m.params.type);
      send('Page.handleJavaScriptDialog', {accept:false}).catch(()=>{});
    }
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
      erroresConsola.push(m.params.args.map((a) => a.value || a.description).join(' '));
    }
    if (m.method === 'Runtime.exceptionThrown') {
      erroresConsola.push(m.params.exceptionDetails.exception?.description || 'excepcion');
    }
  };

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Log.enable');

  async function wait(expr) {
    if (!await esperarPor(() => evaluar(expr), 8000)) throw new Error(`No se cumplió: ${expr}`);
  }
  async function click(selector) {
    await wait(`!!document.querySelector(${JSON.stringify(selector)})`);
    await evaluar(`document.querySelector(${JSON.stringify(selector)}).click()`);
  }
  async function login(user) {
    await send('Page.navigate', {url:BASE});
    await wait("document.readyState === 'complete'");
    await evaluar("fetch('/api/logout',{method:'POST'})");
    await send('Page.navigate', {url:BASE});
    await wait("!document.querySelector('#login-screen').classList.contains('hidden')");
    await evaluar(`document.querySelector('#login-usuario').value=${JSON.stringify(user)}; document.querySelector('#login-clave').value='test1234'; document.querySelector('#login-form').requestSubmit()`);
    await wait(`typeof state !== 'undefined' && state.empleado?.usuario === ${JSON.stringify(user)} && document.querySelector('#login-screen').classList.contains('hidden')`);
  }
  async function nav(page,selector) {
    await click(`[data-act="nav"][data-nav="${page}"]`);
    await wait(`!!document.querySelector(${JSON.stringify(selector)})`);
  }
  /* Los PDF se descargan con un <a download> que no se puede leer desde la
     página: se guarda el blob en el momento de crearlo para poder comprobar que
     lo que baja es de verdad un PDF. La espía se instala una sola vez porque
     declararla dos en la misma página es un error de sintaxis. */
  let espiaPuesta=false;
  async function espiarDescargas() {
    await evaluar(espiaPuesta ? 'window.__pdf=[]'
      : "window.__pdf=[];window.__crea=URL.createObjectURL.bind(URL);URL.createObjectURL=b=>{window.__pdf.push(b);return window.__crea(b)}");
    espiaPuesta=true;
  }
  const action=(name,id)=>`[data-act="${name}"][data-id="${id}"]`;
  const detailExpr=id=>`(await (await fetch('/api/instalaciones/${id}')).json()).instalacion`;
  async function waitStatus(id,status) { await wait(`(async()=>(${detailExpr(id)}).estado===${JSON.stringify(status)})()`); }
  async function scan(code) {
    await evaluar(`(()=>{const e=document.querySelector('#esc-codigo');e.value=${JSON.stringify(code)};e.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));})()`);
  }
  const id=fixtures.orders.ui;
  await login('asesor');
  await nav('instalaciones','#inst-f-estado');
  check('asesor oculta sucursal y conserva filtro técnico',await evaluar("!document.querySelector('#inst-f-sucursal') && !!document.querySelector('#inst-f-tecnico')"));
  check('asesor no tiene acciones de campo',await evaluar("!document.querySelector('[data-act=inst-entrega], [data-act=inst-set-estado], [data-act=inst-cobrar-saldo]')"));
  check('asesor solo muestra Editar en las acciones',await evaluar(`(()=>{const row=document.querySelector(${JSON.stringify(action('inst-editar',id))}).closest('tr');return [...row.lastElementChild.querySelectorAll('button[data-act]:not([data-act="inst-ver"])')].map(b=>b.textContent.trim()).join()==='Editar'})()`));
  check('asesor tiene el botón Detalles',await evaluar(`!!document.querySelector(${JSON.stringify(action('inst-ver',id))})?.closest('tr')?.querySelector('button[data-act="inst-ver"]')`));
  await click(action('inst-editar',id));
  await wait("!!document.querySelector('#ed-dir')");
  await evaluar(`document.querySelector('#ed-dir').value='Dirección desde interfaz';document.querySelector('#ed-con').value='555-UI';document.querySelector('#ed-notas').value='Nota UI';document.querySelector('#ed-tecnico').value='${fixtures.users.tecnico}';document.querySelector('#ed-fecha').value='2027-01-10';document.querySelector('#ed-hora').value='11:00'`);
  await click(action('inst-editar-guardar',id));
  await wait(`(async()=>{const i=${detailExpr(id)};return i.direccion==='Dirección desde interfaz'&&i.tecnico_id===${fixtures.users.tecnico}&&i.hora_programada==='11:00'&&i.estado==='programada'})()`);
  check('Editar guarda datos, técnico y cita juntos',true);
  await wait("!document.querySelector('#ed-dir')");
  await nav('ventas','#f-estado');
  check('asesor sin filtro de sucursal ni anular',await evaluar("!document.querySelector('#f-sucursal')&&!document.querySelector('[data-act=venta-anular]')"));
  await nav('gastos','#g-mes');
  check('gastos oculta sucursal al asesor',await evaluar("!document.querySelector('#g-suc')"));
  await nav('reportes','#r-desde');
  check('reportes oculta sucursal al asesor',await evaluar("!document.querySelector('#r-suc')"));

  await login('tecnico');
  await nav('instalaciones','#inst-f-estado');
  check('técnico sin filtros bloqueados',await evaluar("!document.querySelector('#inst-f-sucursal')&&!document.querySelector('#inst-f-tecnico')"));
  check('orden ajena no visible',await evaluar(`!document.querySelector('[data-id="${fixtures.orders['ui-other']}"]')`));
  await click(action('inst-entrega',id));
  await wait("!!document.querySelector('#esc-codigo')");
  check('guardar bloqueado sin escaneos',await evaluar("document.querySelector('#esc-guardar').disabled"));
  await scan('990004');
  await wait("document.querySelector('#esc-feedback').textContent.includes('no está en esta orden')");
  check('código ajeno rechazado en interfaz',await evaluar("document.querySelector('#esc-guardar').disabled"));
  // Delay a real lookup, close the modal and open another session.
  await evaluar("window.originalTestFetch=window.fetch;window.fetch=async(...args)=>{if(String(args[0]).includes('/barcode/')) await new Promise(r=>setTimeout(r,350));return originalTestFetch(...args)}");
  await scan('990001');
  await click('[data-act=modal-close]');
  await click(action('inst-entrega',id));
  await wait("!!document.querySelector('#esc-codigo')");
  await esperar(500);
  check('respuesta tardía no modifica modal nuevo',await evaluar("state.escaneo.porProducto.size===0"));
  await evaluar("window.fetch=window.originalTestFetch");
  await scan('990001'); await scan('990001');
  await scan('990002'); await scan('990002');
  await scan('990002'); await scan('990002');
  await wait("!document.querySelector('#esc-guardar').disabled");
  check('lecturas rápidas cuentan una unidad cada una',await evaluar(`state.escaneo.porProducto.get(${fixtures.p1})===2&&state.escaneo.porProducto.get(${fixtures.p2})===4`));
  await scan('990001');
  await wait("document.querySelector('#esc-feedback').textContent.includes('Te pasaste')");
  check('exceso no aumenta contador',await evaluar(`state.escaneo.porProducto.get(${fixtures.p1})===2`));
  await click(action('inst-entrega-guardar',id));
  await waitStatus(id,'en_ruta');
  await wait("!document.querySelector('#esc-codigo')");
  check('guardar inicia ruta',true);
  // Open detail from API-rendered row via the order link.
  await click(action('inst-ver',id));
  await wait(`!!document.querySelector('[data-act=inst-set-estado][data-estado=en_progreso]')`);
  check('detalle muestra solo siguiente paso',await evaluar("!document.querySelector('[data-estado=cancelada], [data-estado=completada]')"));
  await click('[data-act=inst-set-estado][data-estado=en_progreso]');
  await click('#estado-confirmar');
  await waitStatus(id,'en_progreso');
  await click(action('inst-avanzar',id));
  await click('#estado-confirmar');
  check('sin foto no permite cerrar',await evaluar("document.querySelector('.form-error').textContent.includes('Adjunta')"));
  await evaluar(`(()=>{const bytes=Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAIAAABLbSncAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEklEQVQImWP438GAFWEXHbQSAHHCYcFWgAR9AAAAAElFTkSuQmCC'),c=>c.charCodeAt(0));const transfer=new DataTransfer();transfer.items.add(new File([bytes],'foto.png',{type:'image/png'}));const field=document.querySelector('#estado-fotos');field.files=transfer.files;field.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await click('#estado-confirmar');
  await waitStatus(id,'completada');
  await wait("!!document.querySelector('#dialog-accept')");
  await evaluar('closeTopModal()');
  await wait(`!!document.querySelector(${JSON.stringify(action('inst-cobrar-saldo',id))})`);
  check('completada conserva botón cobrar',true);
  // La evidencia se subió recién en este flujo: es el momento de comprobar que
  // se puede volver a ver, que se distingue en la lista y que hay quien la tome.
  await wait(`(()=>{const row=document.querySelector(${JSON.stringify(action('inst-ver',id))})?.closest('tr');return !!row?.querySelector('.ev-count')})()`);
  check('la lista marca la orden con la cantidad de fotos',await evaluar(`document.querySelector(${JSON.stringify(action('inst-ver',id))}).closest('tr').querySelector('.ev-count').textContent.trim().endsWith('1')`));
  await click(action('inst-ver',id));
  await wait("!!document.querySelector('.evidence-item')");
  check('el detalle muestra la foto con autor y descarga',await evaluar(`(()=>{const item=document.querySelector('.evidence-item');if(!item)return false;const meta=item.querySelector('.evidence-meta');return !!item.querySelector('img[src*="/evidencias/"]')&&!!meta&&meta.textContent.trim().length>0&&!!item.querySelector('a.evidence-dl[download]')})()`));
  await click('.evidence-open');
  await wait("!!document.querySelector('.evidence-lightbox')");
  check('el visor abre la foto con descarga y sin flechas',await evaluar(`(()=>{const lb=document.querySelector('.evidence-lightbox');return !!lb.querySelector('.lb-img[src*="/evidencias/"]')&&!!lb.querySelector('.lb-dl[download]')&&lb.querySelectorAll('.lb-nav[hidden]').length===2})()`));
  await evaluar("document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");
  await wait("!document.querySelector('.evidence-lightbox')");
  check('el visor se cierra con Escape',true);
  await evaluar('closeTopModal()');
  await click(action('inst-cobrar-saldo',id));
  /* El cobro pide en qué caja o cuenta entró la plata: sin destino no se cobra. */
  await wait("!!document.querySelector('#inst-cobro-destino')");
  const elegido=await evaluar(`(async()=>{const s=document.querySelector('#inst-cobro-destino');const r=await(await fetch('/api/destinos-pago/select')).json();const d=(r.destinos||[]).find(x=>x.tipo==='efectivo');if(!d)return 'sin-caja';s.value=String(d.id);return 'ok';})()`);
  check('el modal de cobro ofrece la caja de la sucursal',elegido==='ok',String(elegido));
  await click('#inst-cobro-guardar');
  await wait(`(async()=>(${detailExpr(id)}).saldo_pendiente===0)()`);
  check('cobro desde interfaz liquida saldo',true);
  const pagos=await evaluar(`(async()=>(await(await fetch('/api/instalaciones/${id}')).json()).instalacion.pagos)()`);
  check('el cobro guarda el destino donde se recibió',Array.isArray(pagos)&&pagos.length>0&&!!pagos.at(-1).destino_nombre,JSON.stringify(pagos));

  const empty=fixtures.orders['ui-empty'];
  await click(action('inst-ver',empty));
  await click(action('inst-tomar',empty));
  await waitStatus(empty,'programada');
  await click(action('inst-avanzar',empty));
  await click('#estado-confirmar');
  await waitStatus(empty,'en_ruta');
  check('orden sin material se toma e inicia ruta',true);
  await click(action('inst-entrega',fixtures.orders['ui-box']));
  await wait("!!document.querySelector('#esc-codigo')");
  check('interfaz identifica la caja y su contenido',await evaluar("document.querySelector('#modal-root').innerText.includes('4 pzas')&&document.querySelector('#modal-root').innerText.includes('caja de 4')"));
  await scan('990005');
  await wait("document.querySelector('#esc-guardar').disabled");
  check('modo pieza: un escaneo no completa la orden',await evaluar("document.querySelector('#esc-guardar').disabled"));
  await evaluar("document.querySelector('[data-modo=caja]').click()");
  await scan('990005');
  await wait("!document.querySelector('#esc-guardar').disabled");
  check('modo caja: un escaneo completa la orden',await evaluar("!document.querySelector('#esc-guardar').disabled"));
  await click(action('inst-entrega-guardar',fixtures.orders['ui-box']));
  await waitStatus(fixtures.orders['ui-box'],'en_ruta');
  await login('admin');
  await nav('instalaciones','#inst-f-estado');
  check('citas abiertas vencidas quedan señaladas para revisión',await evaluar(`document.querySelector(${JSON.stringify(action('inst-ver',fixtures.orders['ui-overdue']))})?.closest('tr')?.innerText.includes('Cita vencida')`));
  const adminOrder=fixtures.orders['ui-other'];
  check('admin muestra solo Editar y Estado',await evaluar(`(()=>{const row=document.querySelector(${JSON.stringify(action('inst-editar',adminOrder))}).closest('tr');return [...row.lastElementChild.querySelectorAll('button[data-act]:not([data-act="inst-ver"])')].map(b=>b.textContent.trim()).join()==='Editar,Estado'})()`));
  await click(action('inst-estado',adminOrder));
  await wait("!!document.querySelector('#inst-nuevo-estado')");
  check('estados agrupados en selector',await evaluar("document.querySelectorAll('#inst-nuevo-estado option').length>1&&!document.querySelector('[data-act=inst-set-estado]')"));
  await evaluar("document.querySelector('#inst-nuevo-estado').value='material_retirado'");
  await click(action('inst-estado-guardar',adminOrder));
  await click('#estado-confirmar');
  await waitStatus(adminOrder,'material_retirado');
  check('admin cambia estado desde el selector',true);
  await nav('productos','#p-buscar');
  await click(action('prod-edit',fixtures.extra));
  await wait("!!document.querySelector('#prod-form')");
  await evaluar("document.querySelector('#prod-form [name=nombre]').value='Producto editado en interfaz'");
  await click('[data-act=prod-save]');
  await wait("!document.querySelector('#prod-form')");
  check('admin guarda cambios de productos',await evaluar(`(async()=> (await (await fetch('/api/productos')).json()).productos.find(p=>p.id===${fixtures.extra}).nombre==='Producto editado en interfaz')()`));
  const ticketChecks=await evaluar(`(async()=>{const list=await (await fetch('/api/ventas')).json();const v=list.ventas.find(v=>v.sucursal_id===${fixtures.s2});const data=await (await fetch('/api/ventas/'+v.id+'/ticket')).json();const html=ticketHTML(data.venta);return html.includes('Calle Norte 789')&&html.includes('555-789')&&html.includes(data.venta.sucursal_nombre)&&!html.includes('Sucursal principal genérica')})()`);
  check('ticket usa sucursal de venta aunque imprime otro usuario',ticketChecks);
  check('ticket sin contactos no usa dirección general',await evaluar("!ticketHTML({numero:'TEST',fecha:'2026-01-01',items:[],instalaciones:[]}).includes('Sucursal principal genérica')"));
  await nav('productos','#p-buscar');
  await click(action('prod-hist',fixtures.p1));
  await wait("document.querySelector('#modal-root').innerText.includes('TEST-ui')");
  check('historial de producto muestra retiro de la orden',true);
  await click('#modal-root [data-act=modal-close]');
  // El formulario no deja guardar el nombre de otro producto, ni escrito con
  // otras mayúsculas o tildes: la mercadería repetida se cuela en el inventario
  // y después aparece dos veces en la etiqueta y en el stock.
  await click(action('prod-edit',fixtures.p1));
  await wait("!!document.querySelector('#prod-form [name=nombre]')");
  await evaluar(`(async()=>{const r=await (await fetch('/api/productos')).json();const otro=r.productos.find(p=>p.id!==${fixtures.p1});window.__otro=otro.nombre;const n=document.querySelector('#prod-form [name=nombre]');n.value='  '+otro.nombre.toUpperCase()+' ';document.querySelector('[data-act=prod-save]').click()})()`);
  await wait("/Ya existe el producto/.test(document.querySelector('#toast-root')?.textContent||'')");
  check('el formulario avisa del nombre repetido y no cierra el formulario',await evaluar("document.querySelector('#toast-root').textContent.includes('Ya existe el producto')&&!!document.querySelector('#prod-form')"));
  check('el producto conserva el nombre que tenía',await evaluar(`(async()=>{const r=await (await fetch('/api/productos')).json();const p=r.productos.find(p=>p.id===${fixtures.p1});return p.nombre!==window.__otro.toUpperCase().trim()})()`));
  await click('#modal-root [data-act=modal-close]');
  // El botón de "todo lo visible" arma un PDF con una etiqueta por producto de la
  // lista: en la hoja densa de A4 van diez por hoja, así que las páginas son la
  // cuenta redondeada hacia arriba y no una etiqueta por página.
  await send('Browser.setDownloadBehavior',{behavior:'deny'});
  await espiarDescargas();
  await click('[data-act=prod-pdf-todo]');
  await wait("window.__pdf.length===1");
  check('el botón de exportar todo arma un PDF con una etiqueta por producto',await evaluar(`(async()=>{const r=await (await fetch('/api/productos')).json();const n=r.productos.filter(p=>p.codigo_barras).length;const t=await window.__pdf[0].text();return n>1&&window.__pdf[0].type==='application/pdf'&&t.startsWith('%PDF-')&&Number(/\\/Count (\\d+)/.exec(t)[1])===Math.ceil(n/10)})()`));
  await click('[data-act=prod-etiquetas]');
  await wait("!!document.querySelector('#label-config')");
  await click('#label-config');
  await wait("!!document.querySelector('#agent-name')");
  await evaluar("document.querySelector('#agent-name').value='Prueba interfaz';document.querySelector('#agent-create').click()");
  await wait("!!document.querySelector('#agent-token textarea')");
  await evaluar("document.querySelector('#printer-name').value='Impresora UI';document.querySelector('#printer-queue').value='Impresora UI RAW';document.querySelector('#printer-save').click()");
  await wait("!document.querySelector('#printer-name')&&!!document.querySelector('#label-printer')");
  check('la ventana ofrece perfil de impresora y cantidades',await evaluar("document.querySelector('#label-printer').options.length>0&&Number(document.querySelector('.label-qty')?.value)===1"));
  // El buscador tiene que recortar la lista sin tocar las cantidades ya escritas.
  await evaluar("const b=document.querySelector('#label-buscar');b.value='990001';b.dispatchEvent(new Event('input'))");
  await wait("document.querySelector('#label-sin-resultado').hidden");
  check('el buscador de etiquetas deja solo el producto buscado',await evaluar(`(async()=>{const f=[...document.querySelectorAll('#label-tbody tr[data-busca]')].filter(f=>!f.hidden);return f.length===1&&f[0].dataset.busca.includes('990001')})()`));
  check('el contador de la ventana dice cuántas etiquetas salen',await evaluar("document.querySelector('#label-resumen').textContent.includes('1 etiqueta')"));
  // El papel se elige de lo que el servidor declara, y el contador dice cuántas
  // hojas salen: cambiar de hoja no puede borrar las cantidades ya escritas.
  check('el selector de hoja ofrece los formatos con su cuenta de etiquetas',await evaluar("(()=>{const s=document.querySelector('#label-hoja');return s.options.length===4&&s.value==='a4densa'&&s.options[0].textContent.includes('10 por hoja')})()"));
  /* El contador cuenta solo las filas que están a la vista: con el buscador
     puesto, la fila editada es la única que sobrevive. */
  check('el contador dice cuántas hojas de papel salen',await evaluar("(()=>{const s=document.querySelector('#label-hoja');s.value='a4';s.dispatchEvent(new Event('change',{bubbles:true}));const q=document.querySelector('#label-tbody tr:not([hidden]) .label-qty');q.value=10;q.dispatchEvent(new Event('change',{bubbles:true}));const t=document.querySelector('#label-resumen').textContent;return t.includes('10 etiquetas')&&t.endsWith('5 hojas de PDF')})()"));
  check('una hoja precortada junta las diez etiquetas en un solo papel',await evaluar("(()=>{const s=document.querySelector('#label-hoja');s.value='avery';s.dispatchEvent(new Event('change',{bubbles:true}));return document.querySelector('#label-resumen').textContent.endsWith('1 hoja de PDF')&&document.querySelector('#label-tbody tr:not([hidden]) .label-qty').value==='10'})()"));
  await evaluar("(()=>{const s=document.querySelector('#label-hoja');s.value='a4densa';s.dispatchEvent(new Event('change',{bubbles:true}));const q=document.querySelector('#label-tbody tr:not([hidden]) .label-qty');q.value=1;q.dispatchEvent(new Event('change',{bubbles:true}))})()");
  // El PDF se descarga como archivo: se guarda el blob antes de que el
  // navegador se lo lleve, para poder leerlo y comprobar que es un PDF de verdad.
  await send('Browser.setDownloadBehavior',{behavior:'deny'});
  const cola=()=>evaluar("(async()=>(await (await fetch('/api/impresion/trabajos')).json()).jobs.length)()");
  const colaAntes=await cola();
  await espiarDescargas();
  await click('#label-pdf');
  await wait("window.__pdf.length===1");
  check('exportar a PDF entrega un archivo real',await evaluar("window.__pdf[0].type==='application/pdf'&&window.__pdf[0].text().then(t=>t.startsWith('%PDF-'))"));
  // "Solo PDF" tiene que significar eso: descargar no encola nada en la impresora.
  check('descargar el PDF no crea ningún trabajo de impresión',await cola()===colaAntes,`cola ${colaAntes} → ${await cola()}`);
  await click('#modal-root [data-act=modal-close]');
  check('cada producto trae su botón de etiqueta PDF',await evaluar(`!!document.querySelector(${JSON.stringify(action('prod-pdf',fixtures.p1))})`));
  await espiarDescargas();
  await click(action('prod-pdf',fixtures.p1));
  await wait("window.__pdf.length===1");
  check('la etiqueta del producto sale en un PDF',await evaluar("window.__pdf[0].size>500&&window.__pdf[0].type==='application/pdf'"));
  await click('[data-act=prod-etiquetas]');
  await wait("!!document.querySelector('#label-send')&&document.querySelector('#label-buscar').value===''");
  await click('#label-send');
  await wait("!!document.querySelector('#print-job-list')");
  check('la interfaz envía e identifica el trabajo de etiquetas',await evaluar("document.querySelector('#print-job-list').innerText.includes('En cola')"));
  check('sin excepciones de JavaScript',erroresConsola.length===0,erroresConsola.join('\n'));
} catch(e) {
  console.error('ERROR UI:',e.stack); fallos++;
} finally {
  try { ws?.close(); } catch {}
  if(chrome.exitCode===null) await new Promise(resolve=>{chrome.once('exit',resolve);chrome.kill();});
  rmSync(perfil,{recursive:true,force:true});
}
console.log(`UI FLUJO — ${ok} correctas, ${fallos} fallidas`);
process.exit(fallos?1:0);
