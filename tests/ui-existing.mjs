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

  // Sembrar datos: una sucursal con alquiler pactado y dos gastos, vía API.
  console.log('\n== DATOS DE PRUEBA ==');
  await send('Page.navigate', { url: BASE });
  await esperarPor(async () => await evaluar('!!document.querySelector("#app, .login-card, body")'));
  const sembrado = await evaluar(`(async () => {
    const post = async (u, b) => {
      const r = await fetch(u, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
      return { status: r.status, data: await r.json().catch(() => null) };
    };
    const login = await post('/api/login', { usuario: 'admin', clave: 'test1234' });
    if (login.status !== 200) return { error: 'login ' + login.status };
    const sucs = await (await fetch('/api/sucursales')).json();
    const s = sucs.sucursales[0];
    await fetch('/api/sucursales/' + s.id, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ nombre: s.nombre, alquiler_mensual: 1800, dia_alquiler: 5, propietario_nombre: 'Sr. Rios' }),
    });
    const d = new Date();
    const mes = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
    const hoyLocal = d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    const g1 = await post('/api/gastos', { sucursal_id: s.id, categoria: 'alquiler', concepto: 'Alquiler ' + mes, monto: 1800, fecha: hoyLocal, mes_cobro: mes });
    const g2 = await post('/api/gastos', { sucursal_id: s.id, categoria: 'luz', concepto: 'Recibo de luz', monto: 320.5, fecha: hoyLocal, mes_cobro: mes });
    return { sucursal: s.nombre, g1: g1.status, g2: g2.status };
  })()`);
  check('siembra de datos por API', !sembrado.error && sembrado.g1 === 200 && sembrado.g2 === 200, JSON.stringify(sembrado));

  // --- Login por la interfaz ---
  console.log('\n== LOGIN ==');
  await send('Page.navigate', { url: BASE });
  await esperarPor(async () => await evaluar('!!document.querySelector("input")'), 8000).catch(() => {});
  const hayForm = await evaluar('!!document.querySelector("input")');
  check('la pantalla de login aparece', hayForm);
  await evaluar(`(() => {
    const inputs = [...document.querySelectorAll('input')];
    const u = inputs.find(i => /usuario|user/i.test(i.name || i.id || ''));
    const c = inputs.find(i => /clave|password|pass/i.test(i.name || i.id || ''));
    if (u && c) {
      u.value = 'admin'; u.dispatchEvent(new Event('input', { bubbles: true }));
      c.value = 'test1234'; c.dispatchEvent(new Event('input', { bubbles: true }));
      (c.closest('form') || document.querySelector('form'))?.requestSubmit();
      return 'form';
    }
    return 'no-form';
  })()`);
  const entro = await esperarPor(async () => await evaluar('!!document.querySelector("#nav .nav-item, .nav button")'), 10000);
  check('entra al sistema con la interfaz', entro, await evaluar('document.body.innerText.slice(0,120)'));

  // --- Gastos ---
  console.log('\n== PANTALLA DE GASTOS ==');
  const tieneGastos = await esperarPor(async () => await evaluar(`[...document.querySelectorAll('[data-act=nav]')].some(b => /gastos/i.test(b.textContent))`), 8000);
  check('el menú muestra Gastos', tieneGastos);
  await evaluar(`[...document.querySelectorAll('[data-act=nav]')].find(b => /gastos/i.test(b.textContent))?.click()`);
  const gastosOk = await esperarPor(async () => await evaluar('!!document.querySelector("#g-mes")'), 10000);
  check('la vista de gastos carga', gastosOk, await evaluar('document.body.innerText.slice(0,150)'));
  if (gastosOk) {
    check('muestra el total del mes', await evaluar(`!!document.querySelector('.kpi-value')`));
    check('muestra la tabla de gastos', await evaluar(`!!document.querySelector('#g-tbody tr')`));
    check('el alquiler aparece con su estado',
      await evaluar(`document.body.innerText.includes('Alquiler') && /Al d[ií]a|Pendiente/.test(document.body.innerText)`),
      await evaluar(`document.querySelector('#g-alq-tbody')?.innerText.slice(0,120)`));
    check('la tabla de alquiler lista la tienda', await evaluar(`!!document.querySelector('#g-alq-tbody tr')`));

    // Registrar un gasto desde la interfaz
    await evaluar(`document.querySelector('[data-act=gas-new]')?.click()`);
    const modal = await esperarPor(async () => await evaluar('!!document.querySelector("#gas-form")'), 8000);
    check('se abre el modal de gasto', modal);
    if (modal) {
      await evaluar(`(() => {
        const f = document.querySelector('#gas-form');
        f.monto.value = '77.25';
        f.concepto.value = 'Gasto desde la interfaz';
        f.proveedor.value = 'Proveedor UI';
        f.categoria.value = 'internet';
        f.monto.dispatchEvent(new Event('input', { bubbles: true }));
      })()`);
      await evaluar(`document.querySelector('[data-act=gas-save]')?.click()`);
      const guardado = await esperarPor(async () => await evaluar(`document.body.innerText.includes('Gasto desde la interfaz')`), 10000);
      check('el gasto guardado aparece en la lista', guardado);
    }

    // Filtrar por categoría
    await evaluar(`(() => {
      const s = document.querySelector('#g-cat');
      if (!s) return;
      s.value = 'internet';
      s.dispatchEvent(new Event('change', { bubbles: true }));
    })()`);
    await esperar(1200);
    check('el filtro por categoria recorta la lista',
      await evaluar(`(() => { const t = document.querySelector('#g-tbody'); return !!t && !t.innerText.includes('Recibo de luz'); })()`),
      await evaluar(`document.querySelector('#g-tbody')?.innerText.slice(0,100)`));
    await evaluar(`(() => { const s = document.querySelector('#g-cat'); s.value = ''; s.dispatchEvent(new Event('change', { bubbles: true })); })()`);
    await esperar(900);
  }

  // --- Sucursales ---
  console.log('\n== PANTALLA DE SUCURSALES ==');
  await evaluar(`[...document.querySelectorAll('[data-act=nav]')].find(b => /sucursales/i.test(b.textContent))?.click()`);
  const sucOk = await esperarPor(async () => await evaluar(
    `[...document.querySelectorAll('h3')].some(h => /Puntos de operaci/i.test(h.textContent))`), 12000);
  check('la vista de sucursales carga', sucOk, await evaluar(
    `(document.querySelector('#content')?.innerText || '').slice(0,150)`));
  check('la tabla muestra al propietario', await evaluar(`document.body.innerText.includes('Sr. Rios')`), await evaluar('document.body.innerText.slice(0,200)'));
  check('la tabla muestra el alquiler pactado', await evaluar(`document.body.innerText.includes('1,800') || document.body.innerText.includes('1800')`));
  check('el resumen de alquiler del mes aparece', await evaluar(`document.body.innerText.includes('Alquiler del mes')`));

  await evaluar(`document.querySelector('[data-act=suc-new]')?.click()`);
  const modalSuc = await esperarPor(async () => await evaluar('!!document.querySelector("#suc-form")'), 8000);
  check('se abre el modal de sucursal', modalSuc);
  if (modalSuc) {
    check('el modal pide los datos del propietario',
      await evaluar(`!!document.querySelector('#suc-form [name=propietario_nombre]')`));
    check('el modal pide el alquiler mensual',
      await evaluar(`!!document.querySelector('#suc-form [name=alquiler_mensual]')`));
    check('el modal pide el dia de pago',
      await esperarPor(async () => await evaluar(`!!document.querySelector('#suc-form [name=dia_alquiler]')`), 3000));
  }
  await evaluar(`document.querySelector('[data-act=modal-close]')?.click()`);

  // --- Reportes ---
  console.log('\n== PANTALLA DE REPORTES ==');
  await evaluar(`[...document.querySelectorAll('[data-act=nav]')].find(b => /reportes/i.test(b.textContent))?.click()`);
  const repOk = await esperarPor(async () => await evaluar('!!document.querySelector("#rep-kpis .kpi")'), 15000);
  check('la vista de reportes carga con los indicadores ya pintados', repOk, await evaluar(
    `(document.querySelector('#content')?.innerText || '').slice(0,150)`));
  if (repOk) {
    const nKpi = await evaluar(`document.querySelectorAll('#rep-kpis .kpi').length`);
    check('muestra los cinco indicadores (incluye utilidad)', nKpi === 5, `n=${nKpi}`);
    check('el indicador de utilidad existe', await evaluar(`document.querySelector('#rep-kpis').innerText.includes('Utilidad')`));
    check('el grafico se dibuja al abrir', await esperarPor(async () => await evaluar(`document.querySelectorAll('#rep-bars .bar-col').length > 0`), 12000));
    check('la utilidad por sucursal tiene tabla', await esperarPor(async () => await evaluar(`!!document.querySelector('#rep-suc tr')`), 8000));
    // 'Gastos' es una columna del thead: vive en la tabla, no en el tbody.
    check('la tabla de utilidad por sucursal tiene columna de gastos',
      await esperarPor(async () => await evaluar(
        `document.querySelector('#rep-suc')?.closest('table')?.textContent.includes('Gastos')`), 8000));
    check('cada fila de utilidad trae 6 columnas',
      await evaluar(`[...document.querySelectorAll('#rep-suc tr')].every(t => t.children.length === 6)`));
    check('las categorias de producto se pintan al abrir', await esperarPor(async () => await evaluar(`document.querySelectorAll('#rep-items tr').length > 0`), 8000));

    // Granularidad por mes
    const filasDia = await evaluar(`document.querySelectorAll('#rep-bars .bar-col').length`);
    await evaluar(`document.querySelector('[data-act=rep-gran][data-v=mes]')?.click()`);
    await esperar(1500);
    const filasMes = await evaluar(`document.querySelectorAll('#rep-bars .bar-col').length`);
    check('cambiar a mes regroupa el grafico', filasMes > 0 && filasMes !== filasDia, `dia=${filasDia} mes=${filasMes}`);
    check('el titulo del grafico sigue a la granularidad',
      await evaluar(`document.querySelector('#rep-graf-titulo')?.textContent.includes('mes')`),
      await evaluar(`document.querySelector('#rep-graf-titulo')?.textContent`));

    // Filtro por sucursal
    await evaluar(`(() => {
      const s = document.querySelector('#r-suc');
      if (!s || s.options.length < 2) return;
      s.value = s.options[1].value;
      document.querySelector('[data-act=rep-filtrar]')?.click();
    })()`);
    await esperar(1500);
    check('el filtro por sucursal recarga el reporte sin romper',
      await evaluar(`!!document.querySelector('#rep-kpis .kpi')`));

    // Detalle de producto
    await evaluar(`(() => { const s = document.querySelector('#r-suc'); if (s) { s.value = ''; } document.querySelector('[data-act=rep-filtrar]')?.click(); })()`);
    await esperar(1500);
    const habiaProd = await evaluar(`document.querySelectorAll('#rep-items tr.row-click').length`);
    check('hay productos en el ranking', habiaProd > 0, `n=${habiaProd}`);
    if (habiaProd) {
      const nombreProd = await evaluar(`document.querySelector('#rep-items tr.row-click b')?.textContent`);
      await evaluar(`document.querySelector('#rep-items tr.row-click')?.click()`);
      const detalle = await esperarPor(async () => await evaluar(`!!document.querySelector('.modal.wide')`), 10000);
      check('al hacer clic se abre el detalle del producto', detalle);
      if (detalle) {
        check('el detalle corresponde al producto pulsado',
          await evaluar(`document.querySelector('.modal.wide').innerText.includes(${JSON.stringify(nombreProd)})`),
          `esperado: ${nombreProd}`);
        check('el detalle lista las ventas del producto',
          await esperarPor(async () => await evaluar(`document.querySelector('.modal.wide tbody tr')?.innerText.trim().length > 3`), 8000));
      }
      await evaluar(`document.querySelector('[data-act=modal-close]')?.click()`);
    }
  }

  console.log('\n== HISTORIAL DEL CLIENTE ==');
  {
    await evaluar(`location.hash = '#/clientes'`);
    await esperar(2000);
    const filas = await esperarPor(async () => await evaluar(`document.querySelectorAll('#cli-tbody tr').length > 0`), 10000);
    check('la tabla de clientes carga', filas);
    /* El id llega como texto desde data-id; sin Number() ni el find de la ficha
       ni el filtro de la tabla comparan bien, y el modal sale vacio. */
    const reviso = await evaluar(`(async () => {
      const datos = await (await fetch('/api/clientes')).json();
      /* Se elige el que mas compras tiene: con un cliente de una sola compra el
         conteo de filas coincidiria por casualidad con la fila unica del
         mensaje "Sin compras registradas". */
      const conCompras = datos.clientes.filter((x) => x.total_compras > 0)
        .sort((a, b) => b.total_compras - a.total_compras)[0];
      if (!conCompras) return { error: 'ningun cliente con compras' };
      document.querySelector('[data-act=modal-close]')?.click();
      document.querySelector('[data-act=cli-ver][data-id="' + conCompras.id + '"]')?.click();
      await new Promise((r) => setTimeout(() => r(), 2000));
      const m = document.querySelector('#modal-root .modal');
      if (!m) return { error: 'no abrio el modal', esperado: conCompras.total_compras };
      const cuerpo = m.querySelector('tbody');
      return {
        titulo: m.querySelector('h3').textContent,
        esperado: conCompras.total_compras,
        filas: cuerpo.querySelectorAll('tr').length,
        vacio: cuerpo.innerText.includes('Sin compras registradas'),
        primera: cuerpo.querySelector('tr td') ? cuerpo.querySelector('tr td').textContent : '',
      };
    })()`);
    check('el boton Historial abre el modal del cliente', !!reviso && !reviso.error,
      reviso.error || `titulo=${reviso.titulo}`);
    if (reviso && !reviso.error) {
      check('el modal lista las compras del cliente', reviso.filas > 0 && reviso.vacio === false,
        `filas=${reviso.filas} vacio=${reviso.vacio}`);
      /* La tabla debe cuadrar con el contador de la ficha: si el filtro de
         cliente_id compara contra el texto del boton, sale "Sin compras" con
         la ficha diciendo que si compro. */
      check('las filas del historial coinciden con las compras de la ficha',
        reviso.filas === reviso.esperado, `tabla=${reviso.filas} ficha=${reviso.esperado}`);
    }
    await evaluar(`document.querySelector('[data-act=modal-close]')?.click()`);
  }

  console.log('\n== AUTOCOMPLETADO DE INSTALACION EN POS ==');
  {
    await evaluar(`location.hash = '#/pos'`);
    await esperar(2000);
    await esperarPor(async () => await evaluar(`!!document.querySelector('#cart-cliente')`), 10000);

    /* Cliente con datos ya elegido y luego se enciende la instalacion: es el
       orden natural en el mostrador y antes no rellenaba nada. */
    const casoA = await esperarPor(async () => await evaluar(`(async () => {
      const c = (state._clientesCache || []).find((x) => x.direccion && x.telefono);
      if (!c) return null;
      const sel = document.querySelector('#cart-cliente');
      sel.value = String(c.id);
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      const p = (await (await fetch('/api/productos')).json()).productos.find((x) => x.stock > 5);
      if (!p) return null;
      addToCart(p);
      await new Promise((r) => setTimeout(r, 400));
      const sw = document.querySelector('#inst-switch');
      sw.checked = true;
      sw.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 700));
      const dir = document.querySelector('#inst-direccion');
      const tel = document.querySelector('#inst-contacto');
      return { esperado: c.direccion, dir: dir ? dir.value : null, tel: tel ? tel.value : null, estado: state.inst.direccion };
    })()`), 15000);
    check('enciender la instalacion autocompleta direccion y telefono del cliente',
      !!casoA && casoA.dir === casoA.esperado, JSON.stringify(casoA));
    check('el autocompletado tambien queda en el borrador',
      !!casoA && casoA.estado === casoA.esperado, `estado=${casoA && casoA.estado}`);

    /* Cambiar la cantidad redibuja el panel: los datos deben sobrevivir. */
    const casoB = await evaluar(`(async () => {
      const antes = document.querySelector('#inst-direccion')?.value;
      const inp = document.querySelector('[data-act=cart-qty]');
      inp.value = String(Number(inp.value) + 1);
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 700));
      return { antes, despues: document.querySelector('#inst-direccion')?.value };
    })()`);
    check('los datos autocompletados sobreviven al redibujo del carrito',
      casoB.antes && casoB.antes === casoB.despues, JSON.stringify(casoB));

    /* Un campo vaciado a proposito no debe reaparecer solo. */
    const casoC = await evaluar(`(async () => {
      const dir = document.querySelector('#inst-direccion');
      dir.value = '';
      dir.dispatchEvent(new Event('input', { bubbles: true }));
      const inp = document.querySelector('[data-act=cart-qty]');
      inp.value = String(Number(inp.value) + 1);
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise((r) => setTimeout(r, 700));
      return document.querySelector('#inst-direccion')?.value;
    })()`);
    check('una direccion borrada a proposito no se resucita', casoC === '', `quedo=${JSON.stringify(casoC)}`);
    await evaluar(`document.querySelector('[data-act=cart-clear]')?.click()`);
  }

  console.log('\n== ERRORES DE CONSOLA ==');
  const ruido = erroresConsola.filter((e) => !/favicon|ERR_/i.test(e));
  check('sin errores de JavaScript en la consola', ruido.length === 0, ruido.slice(0, 3).join(' | '));

} catch (e) {
  console.log('  ERROR FATAL:', e.message);
  fallos++;
} finally {
  try { ws?.close(); } catch {}
  if (chrome.exitCode === null) {
    await new Promise((resolve) => { chrome.once('exit', resolve); chrome.kill(); });
  }
  try { rmSync(perfil, { recursive: true, force: true }); } catch {}
}

console.log(`\n${fallos === 0 ? 'INTERFAZ OK' : `INTERFAZ CON ${fallos} FALLAS`} — ${ok} correctas, ${fallos} fallidas`);
process.exit(fallos ? 1 : 0);