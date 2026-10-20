'use strict';

/* ============ Utilidades ============ */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
/* Para buscar sin que el acento estorbe: escribir "cinta" tiene que encontrar
   "Cinta" tanto si el asesor lo escribió con tilde como si no. */
function sinAcentos(s) {
  return String(s ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}
function num(n, dec) {
  return Number(n || 0).toLocaleString('es-ES', { minimumFractionDigits: dec ?? 0, maximumFractionDigits: dec ?? 0 });
}

function fmt(n) {
  return `${state.config?.moneda || '$'}${Number(n || 0).toLocaleString('es-ES', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function mon() { return state.config?.moneda || '$'; }

/* Dos decimales, como hace el servidor, para que lo que se ve en pantalla sea
   lo mismo que queda guardado. */
function round2(n) {
  return Math.round((Number(n) || 0) * 100) / 100;
}

function fmtDT(iso) {
  if (!iso) return '';
  const [d, t] = String(iso).split(' ');
  const [y, m, dd] = d.split('-');
  return `${dd}/${m}/${y} ${t ? t.slice(0, 5) : ''}`;
}
function fmtD(iso) { return String(iso || '').slice(5).replace('-', '/'); }

const METODO = { efectivo: 'Efectivo', tarjeta: 'Tarjeta', transferencia: 'Transferencia', yape: 'Yape' };
const ROLES = { admin: 'Administrador', asesor: 'Asesor de ventas', tecnico: 'Técnico' };
/* Unidades que maneja la ferretería. La clave es el valor guardado en
   productos.unidad (texto libre, sin CHECK), así que cualquier valor que exista
   en la base debe tener su clave aquí: si falta, la pantalla lo muestra como
   "pza" por el || 'pza' de los tres lugares que imprimen el stock.
   La clave del paquete es 'paq' y no 'pqt' porque así la guarda el catálogo. */
const UNIDAD = {
  pza: 'pza', caja: 'caja', bolsa: 'bolsa', paq: 'paquete', jgo: 'juego',
  par: 'par', rollo: 'rollo', tubo: 'tubo', balde: 'balde', gal: 'gal',
  kg: 'kg', g: 'g', L: 'L', ml: 'ml',
};

/* ---------- Etiquetas con código de barras ---------- */
/* El código lo dibuja barcode.js como SVG de Code 128. La etiqueta lleva el
   nombre y la unidad para que quien la reciba sepa qué es, pero la barra manda:
   el número va debajo en grande porque es lo que se escanea. */
function etiquetaSvg(codigo, nombre, unidad, contenido) {
  const barras = window.Code128 ? Code128.svg(codigo) : '';
  if (!barras) return `<div class="etiqueta-sin-codigo">Sin código asignado</div>`;
  const pie = Number(contenido) > 1
    ? `<div class="etiqueta-pie">Contiene ${Number(contenido)} ${esc(UNIDAD[unidad] || 'pza')}</div>`
    : '';
  /* El numero legible ya va dentro del SVG de la barra, asi que la etiqueta no
     lo repite: el lector necesita una sola vez y el papel se desperdicia. */
  return `<div class="etiqueta">
    <div class="etiqueta-nombre">${esc(nombre || '')}</div>
    <div class="etiqueta-barras">${barras}</div>
    ${pie}
  </div>`;
}

const TIPO_MOV = { entrada: 'Entrada', salida: 'Salida', ajuste: 'Ajuste', venta: 'Venta', compra: 'Compra' };
const ESTADO_INST = {
  pendiente: 'Pendiente', programada: 'Programada',
  material_retirado: 'Material retirado', en_ruta: 'En ruta', en_progreso: 'En progreso',
  completada: 'Completada', cancelada: 'Cancelada',
};

function badgeEstado(estado) {
  const map = { completada: 'badge-ok', anulada: 'badge-danger', pendiente: 'badge-warn', recibida: 'badge-info', cancelada: 'badge-neutral' };
  return `<span class="badge ${map[estado] || 'badge-neutral'}">${esc(estado)}</span>`;
}
function badgeInstalacion(estado) {
  const map = {
    pendiente: 'badge-warn', programada: 'badge-info',
    material_retirado: 'badge-primary', en_ruta: 'badge-primary', en_progreso: 'badge-primary',
    completada: 'badge-ok', cancelada: 'badge-neutral',
  };
  return `<span class="badge ${map[estado] || 'badge-neutral'}">${esc(ESTADO_INST[estado] || estado)}</span>`;
}
/* Lo vendible es lo físico menos lo comprometido a visitas con instalación. */
function badgeStock(stock, minimo, reservado = 0) {
  const disponible = Math.round((stock - reservado) * 100) / 100;
  if (disponible <= minimo) {
    return `<span class="badge badge-danger">Stock bajo</span>`
      + (reservado > 0 ? `<span class="badge badge-warn">${esc(reservado)} reservado</span>` : '');
  }
  return `<span class="badge badge-ok">${esc(disponible)} disp.</span>`
    + (reservado > 0 ? `<span class="badge badge-warn">${esc(reservado)} reservado</span>` : '');
}

const state = {
  empleado: null,
  config: null,
  route: 'dashboard',
  cart: [],
  /* Instalación a domicilio de la venta en curso. El asesor la enciende en el
     carrito y cotiza el servicio ahí; no depende de ningún producto. */
  inst: nuevaInstalacion(),
  _cats: null,
  _suc: null,
  _destinos: null,
  _tecnicos: null,
  _clientesCache: [],
  fVentas: { desde: null, hasta: null, estado: 'todas', sucursal_id: '', buscar: '' },
};

/* Borrador en blanco de la instalación en curso. Va en una función porque
   tres rutas lo reinician —al cobrar, al vaciar el carrito y al arrancar— y un
   objeto repetido a mano se queda corto de campos con cualquier añadido.
   `direccionTocada`/`contactoTocada` marcan lo que el asesor escribió a mano:
   así el autocompletado rellena lo que falta, pero no resucita una dirección
   que él borró a propósito cuando el carrito se vuelve a dibujar. */
function nuevaInstalacion() {
  return {
    on: false, precio: null,
    direccion: '', direccionTocada: false,
    contacto: '', contactoTocada: false,
    tecnico_id: '', fecha: '', hora: '', adelanto: null, notas: '',
  };
}

/* El servidor manda en cada sesión la lista real de permisos del rol, así que
   esta copia es sólo el respaldo para el primer pintado, antes de que llegue la
   respuesta del login. Si una lista de aquí se desincroniza con src/routes.js,
   la que manda es la del servidor. */
const PERMISOS = {
  admin: ['*'],
  asesor: [
    'dashboard:ver', 'pos:usar', 'ventas:crear', 'ventas:ver',
    'productos:ver', 'clientes:ver', 'clientes:editar',
    'instalaciones:ver', 'instalaciones:crear', 'instalaciones:editar',
    'reportes:ver', 'sucursales:ver', 'empleados:tecnicos', 'gastos:ver',
  ],
  tecnico: [
    'dashboard:ver', 'productos:ver',
    'instalaciones:ver', 'instalaciones:gestionar', 'sucursales:ver',
  ],
};

function puede(perm) {
  const lista = state.empleado?.permisos || PERMISOS[state.empleado?.rol] || [];
  return lista.includes('*') || lista.includes(perm);
}

/* ============ API ============ */
async function api(method, path, data) {
  const opts = { method, headers: {} };
  let url = path;
  if (method === 'GET' && data) {
    const q = new URLSearchParams();
    for (const [k, v] of Object.entries(data)) if (v !== undefined && v !== null && v !== '') q.set(k, v);
    const s = q.toString();
    if (s) url += `?${s}`;
  } else if (data !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(data);
  }
  const res = await fetch(url, opts);
  let json = {};
  try { json = await res.json(); } catch (_) {}
  if (!res.ok) throw new Error(json.error || `Error ${res.status}`);
  return json;
}

/* Descarga un archivo que arma el servidor (el PDF de las etiquetas). Se pide
   con fetch y no con un <a download> para que un 400 del servidor se vea como
   aviso y no como una pestaña en blanco con el JSON del error. El nombre lo
   pone el servidor en Content-Disposition. No imprime nada: solo deja el
   archivo en la carpeta de descargas del navegador. */
async function descarga(url, opciones) {
  const res = await fetch(url, opciones);
  if (!res.ok) {
    let json = {};
    try { json = await res.json(); } catch (_) {}
    /* Un 404 en una ruta de impresión casi siempre es un servidor que quedó
       corriendo con la versión anterior: el archivo del cliente es nuevo pero
       la ruta todavía no existe en el proceso que está escuchando. */
    if (res.status === 404 && /no encontrada/.test(json.error || '')) throw new Error('El servidor que está corriendo no tiene esta ruta: reinicia el servicio para cargar la versión nueva');
    throw new Error(json.error || `Error ${res.status}`);
  }
  const disposition = res.headers.get('content-disposition') || '';
  const nombre = /filename="([^"]+)"/.exec(disposition)?.[1] || 'etiquetas.pdf';
  const href = URL.createObjectURL(await res.blob());
  const link = document.createElement('a');
  link.href = href;
  link.download = nombre;
  link.click();
  /* El enlace se suelta enseguida, pero el archivo tardaría un poco más en
     terminar de bajarse: revoke antes de tiempo deja la descarga a medias. */
  setTimeout(() => URL.revokeObjectURL(href), 30_000);
  return nombre;
}

async function loadConfig() {
  if (state.config) return state.config;
  try {
    const r = await api('GET', '/api/config');
    state.config = r.config;
  } catch (_) { state.config = { moneda: '$', iva: '16', nombre_tienda: 'Tienda Retail' }; }
  return state.config;
}

async function getCats() {
  if (state._cats) return state._cats;
  const r = await api('GET', '/api/categorias/select');
  state._cats = r.categorias;
  return state._cats;
}
function invalidarCats() { state._cats = null; }

async function getSucursales() {
  if (state._suc) return state._suc;
  const r = await api('GET', '/api/sucursales/select');
  state._suc = r.sucursales;
  return state._suc;
}
function invalidarSucursales() { state._suc = null; }

async function getDestinos(sucursalId) {
  const q = sucursalId ? `?sucursal_id=${sucursalId}` : '';
  const r = await api('GET', `/api/destinos-pago/select${q}`);
  return r.destinos || [];
}
function invalidarDestinos() { state._destinos = null; }

async function getTecnicos(forzar = false) {
  if (state._tecnicos && !forzar) return state._tecnicos;
  const r = await api('GET', '/api/tecnicos');
  state._tecnicos = r.tecnicos;
  return state._tecnicos;
}
function invalidarTecnicos() { state._tecnicos = null; }

/* ============ Toast ============ */
function toast(msg, tipo = 'ok') {
  const el = document.createElement('div');
  el.className = `toast toast-${tipo}`;
  el.textContent = msg;
  $('#toast-root').appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity .3s'; setTimeout(() => el.remove(), 320); }, 2600);
}

/* ============ Modal ============ */
function openModal({ title, body, footer, wide, onClose }) {
  const previousFocus = document.activeElement;
  const root = $('#modal-root');
  const wrap = document.createElement('div');
  wrap.className = 'modal-backdrop';
  wrap.innerHTML = `
    <div class="modal ${wide ? 'wide' : ''}" role="dialog" aria-modal="true" aria-label="${esc(title)}" tabindex="-1">
      <div class="modal-header">
        <h3>${esc(title)}</h3>
        <button class="icon-btn" data-act="modal-close" style="color:var(--muted)">✕</button>
      </div>
      <div class="modal-body">${body}</div>
      ${footer ? `<div class="modal-footer">${footer}</div>` : ''}
    </div>`;
  wrap.addEventListener('click', (e) => {
    if (e.target === wrap) close();
  });
  root.appendChild(wrap);
  let closed = false;
  const close = () => {
    if (closed || wrap._busy) return; closed = true;
    onClose?.(); wrap.remove();
    if (previousFocus?.isConnected) previousFocus.focus();
  };
  wrap._close = close;
  wrap.addEventListener('keydown', e => {
    if (wrap !== [...root.children].at(-1)) return;
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
    if (e.key === 'Tab') {
      const fields = [...wrap.querySelectorAll('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),a[href],[tabindex="0"]')].filter(el => el.getClientRects().length);
      const first = fields[0], last = fields.at(-1);
      if (!first) { e.preventDefault(); modalEl.focus(); }
      else if (e.shiftKey && (document.activeElement === first || !wrap.contains(document.activeElement))) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  });
  const modalEl = $('.modal', wrap);
  if (modalEl) setTimeout(() => { const f = $('input, select, textarea', modalEl); if (f) f.focus(); }, 60);
  /* `root` es el .modal (no el backdrop) para poder colgarle dataset y estilos. */
  return { root: modalEl || wrap, wrap, close, el: modalEl };
}
function closeTopModal() {
  const b = [...document.querySelectorAll('#modal-root .modal-backdrop')].at(-1);
  if (b) b._close ? b._close() : b.remove();
}

/* ============ Evidencia fotográfica ============
   La foto se sube al cerrar la orden, pero subarla no es verla: tiene que
   aparecer en la orden, en la venta que la generó, y bajar con un nombre que
   sirva al archivarla. Estas funciones son la única forma de mostrarla, para
   que las dos pantallas queden siempre con el mismo aspecto. */
const GRUPOS_EVIDENCIA = new Map();
let secuenciaEvidencia = 0;
function grupoEvidencia(evidencias) {
  const clave = `ev${++secuenciaEvidencia}`;
  GRUPOS_EVIDENCIA.set(clave, evidencias);
  return clave;
}
/* Quién tomó la foto y cuándo. Sin esto el archivo es una imagen suelta: no
   acredita que la instalación se terminó ni cuándo se confirmó. */
function evidenciaMeta(e) {
  const quien = e.empleado_nombre || 'Autor no registrado';
  const cuando = e.created_at ? fmtDT(e.created_at) : 'fecha desconocida';
  return `<div class="evidence-meta"><span class="evidence-quien">${esc(quien)}</span><span>${esc(cuando)}</span></div>`;
}
/* Imita un sello en la lista: dice que la orden ya tiene fotos sin obligar a
   abrirla. Solo el contador, nunca la miniatura, para no pedirle al navegador
   cincuenta imágenes cada vez que se arma la tabla. */
function evidenciaContador(evidencias) {
  const n = evidencias?.length || 0;
  if (!n) return '';
  return `<span class="ev-count" title="${n} foto${n > 1 ? 's' : ''} de conformidad">${icon('camara')}<b>${n}</b></span>`;
}
function evidenciasGrid(evidencias) {
  if (!evidencias?.length) return '<p class="muted">Sin evidencia registrada.</p>';
  const clave = grupoEvidencia(evidencias);
  return `<div class="evidence-grid">${evidencias.map((e, n) => `
    <figure class="evidence-item">
      <button type="button" class="evidence-open" data-act="ev-ver" data-grupo="${clave}" data-idx="${n}" aria-label="Ampliar la foto ${n + 1} de ${evidencias.length}">
        <img src="${esc(e.url)}" alt="Foto ${n + 1} de la instalación terminada" loading="lazy">
      </button>
      ${evidenciaMeta(e)}
      <a class="evidence-dl" href="${esc(e.url)}?download=1" download>Descargar</a>
    </figure>`).join('')}</div>`;
}
function evidenciasCard(evidencias, orden = '') {
  const n = evidencias?.length || 0;
  return `<div class="card mt-2">
    <h3>Evidencia de instalación</h3>
    ${n ? `<p class="table-muted">${n} foto${n > 1 ? 's' : ''} de conformidad${orden ? ` · orden ${esc(orden)}` : ''}.</p>` : ''}
    ${evidenciasGrid(evidencias)}
  </div>`;
}
/* Visor a pantalla completa. Antes la miniatura abría el JPEG en otra pestaña,
   fuera de la aplicación y sin forma de recorrer las demás fotos. */
function abrirEvidencia(clave, indice = 0) {
  const fotos = GRUPOS_EVIDENCIA.get(clave);
  if (!fotos?.length) return;
  const previo = document.activeElement;
  let i = Math.min(Math.max(0, indice), fotos.length - 1);
  const muchas = fotos.length > 1;
  const wrap = document.createElement('div');
  wrap.className = 'evidence-lightbox';
  wrap.setAttribute('role', 'dialog');
  wrap.setAttribute('aria-modal', 'true');
  wrap.setAttribute('aria-label', 'Evidencia de la instalación');
  wrap.tabIndex = -1;
  wrap.innerHTML = `
    <div class="lb-bar">
      <span class="lb-titulo">Evidencia de la instalación</span>
      <span class="lb-cont"></span>
      <a class="lb-dl btn btn-sm" download>Descargar</a>
      <button type="button" class="icon-btn lb-close" aria-label="Cerrar el visor">✕</button>
    </div>
    <button type="button" class="lb-nav lb-prev" aria-label="Foto anterior">‹</button>
    <figure class="lb-stage">
      <img class="lb-img" alt="">
      <figcaption class="lb-cap"></figcaption>
    </figure>
    <button type="button" class="lb-nav lb-next" aria-label="Foto siguiente">›</button>`;
  document.body.appendChild(wrap);

  const img = wrap.querySelector('.lb-img');
  const link = wrap.querySelector('.lb-dl');
  const pinta = () => {
    const e = fotos[i];
    img.src = e.url;
    img.alt = `Foto ${i + 1} de ${fotos.length} de la instalación terminada`;
    wrap.querySelector('.lb-cap').innerHTML = evidenciaMeta(e);
    link.href = `${e.url}?download=1`;
    wrap.querySelector('.lb-cont').textContent = muchas ? `${i + 1} / ${fotos.length}` : '';
  };
  const mover = d => { i = (i + d + fotos.length) % fotos.length; pinta(); };
  const cerrar = () => {
    wrap.remove();
    document.removeEventListener('keydown', teclas, true);
    if (previo?.isConnected) previo.focus();
  };
  const teclas = ev => {
    if (!wrap.isConnected) return;
    if (ev.key === 'Escape') { ev.preventDefault(); cerrar(); }
    else if (muchas && ev.key === 'ArrowLeft') { ev.preventDefault(); mover(-1); }
    else if (muchas && ev.key === 'ArrowRight') { ev.preventDefault(); mover(1); }
  };
  wrap.addEventListener('click', ev => {
    if (ev.target === wrap || ev.target.closest('.lb-close')) cerrar();
    else if (ev.target.closest('.lb-prev')) mover(-1);
    else if (ev.target.closest('.lb-next')) mover(1);
  });
  document.addEventListener('keydown', teclas, true);
  if (!muchas) { wrap.querySelector('.lb-prev').hidden = true; wrap.querySelector('.lb-next').hidden = true; }
  pinta();
  wrap.focus();
}

/* ============ Navegación ============ */
const MENU = [
  { id: 'dashboard', label: 'Dashboard', perm: 'dashboard:ver', icon: icon('dashboard') },
  { id: 'pos', label: 'Punto de venta', perm: 'pos:usar', icon: icon('pos') },
  { id: 'ventas', label: 'Ventas', perm: 'ventas:ver', icon: icon('ventas') },
  { id: 'instalaciones', label: 'Instalaciones', perm: 'instalaciones:ver', icon: icon('instalaciones') },
  { id: 'productos', label: 'Productos', perm: 'productos:ver', icon: icon('productos') },
  { id: 'categorias', label: 'Categorías', perm: 'categorias:gestionar', icon: icon('categorias') },
  { id: 'inventario', label: 'Inventario', perm: 'inventario:ver', icon: icon('inventario') },
  { id: 'compras', label: 'Compras', perm: 'compras:gestionar', icon: icon('compras') },
  { id: 'proveedores', label: 'Proveedores', perm: 'proveedores:gestionar', icon: icon('proveedores') },
  { id: 'clientes', label: 'Clientes', perm: 'clientes:ver', icon: icon('clientes') },
  { id: 'sucursales', label: 'Sucursales', perm: 'sucursales:ver', icon: icon('sucursales') },
  { id: 'gastos', label: 'Gastos', perm: 'gastos:ver', icon: icon('gastos') },
  { id: 'empleados', label: 'Empleados', perm: 'config:gestionar', icon: icon('empleados') },
  { id: 'reportes', label: 'Reportes', perm: 'reportes:ver', icon: icon('reportes') },
  { id: 'config', label: 'Configuración', perm: 'config:gestionar', icon: icon('config') },
];

function icon(name) {
  const paths = {
    dashboard: '<rect x="3" y="3" width="7" height="9" rx="1"/><rect x="14" y="3" width="7" height="5" rx="1"/><rect x="14" y="12" width="7" height="9" rx="1"/><rect x="3" y="16" width="7" height="5" rx="1"/>',
    pos: '<circle cx="9" cy="21" r="1"/><circle cx="20" cy="21" r="1"/><path d="M1 1h4l2.7 13.4a2 2 0 0 0 2 1.6h9.7a2 2 0 0 0 2-1.6L23 6H6"/>',
    ventas: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M16 13H8M16 17H8M10 9H8"/>',
    instalaciones: '<path d="M14.7 6.3a4 4 0 0 0 5 5L21 3l-2 2z"/><path d="M10 14 3 21l2 2 7-7"/><path d="M9 15l-1-1 4-4 1 1-4 4z"/>',
    productos: '<path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><path d="M3.3 7l8.7 5 8.7-5M12 22V12"/>',
    categorias: '<path d="M20.6 13.4 12 22l-8.6-8.6A5 5 0 1 1 12 9.25 5 5 0 1 1 20.6 13.4z"/>',
    inventario: '<path d="M3 7h18v13a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1z"/><path d="M3 7l2-4h14l2 4M9 11h6"/>',
    compras: '<path d="M1 3h3l2.4 12.4a2 2 0 0 0 2 1.6h9.6a2 2 0 0 0 2-1.6L22 7H6"/><circle cx="8" cy="21" r="1"/><circle cx="19" cy="21" r="1"/>',
    proveedores: '<path d="M16 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM2 21a7 7 0 0 1 14 0"/>',
    clientes: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75"/>',
    sucursales: '<path d="M3 21h18M5 21V7l7-4 7 4v14"/><path d="M9 21v-6h6v6M9 10h.01M15 10h.01M12 13h.01"/>',
    gastos: '<path d="M12 1v22M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/>',
    empleados: '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
    reportes: '<path d="M18 20V10M12 20V4M6 20v-6"/>',
    config: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/>',
  camara: '<path d="M3 9a2 2 0 0 1 2-2h3l1.5-2.5h5L16 7h3a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><circle cx="12" cy="13" r="3.5"/>',
  };
  return `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${paths[name] || ''}</svg>`;
}

const TITLES = {
  dashboard: 'Dashboard', pos: 'Punto de venta', ventas: 'Historial de ventas',
  instalaciones: 'Instalaciones a domicilio', productos: 'Productos', categorias: 'Categorías',
  inventario: 'Inventario', compras: 'Órdenes de compra', proveedores: 'Proveedores',
  clientes: 'Clientes', sucursales: 'Sucursales', empleados: 'Empleados',
  reportes: 'Reportes', config: 'Configuración',
};

function verMenu(m) { return puede(m.perm); }

function go(route) {
  const destino = MENU.find((m) => m.id === route);
  if (!destino || !verMenu(destino)) route = 'dashboard';
  location.hash = '#/' + route;
}

function renderNav() {
  const nav = $('#nav');
  if (!state.empleado) return;
  nav.innerHTML = MENU.filter(verMenu).map((m) =>
    `<a class="nav-item ${m.id === state.route ? 'active' : ''}" data-act="nav" data-nav="${m.id}">${m.icon}${m.label}</a>`
  ).join('');
  $('#user-nombre').textContent = state.empleado.nombre;
  $('#user-rol').textContent = ROLES[state.empleado.rol] || state.empleado.rol;
  $('#user-avatar').textContent = state.empleado.nombre.charAt(0).toUpperCase();
  const nombre = state.config?.nombre_tienda || 'Ferretería';
  $('#brand-nombre').textContent = nombre;
  $('#brand-lema').textContent = state.config?.lema || 'Herramientas y materiales';
  /* Las iniciales del logo siguen al nombre configurado. */
  const iniciales = nombre.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase() || 'F';
  for (const sel of ['.brand-logo', '.login-logo']) {
    const el = $(sel);
    if (el) el.textContent = iniciales;
  }
  const chipSuc = $('#user-sucursal');
  if (chipSuc) chipSuc.textContent = state.empleado.sucursal_nombre || 'Sin sucursal';
}

function currentRoute() {
  const r = (location.hash || '#/dashboard').replace('#/', '').split('?')[0];
  return r || 'dashboard';
}

async function render() {
  if (!state.empleado) return;
  state.route = currentRoute();
  /* Un hash escrito a mano no puede saltarse los permisos del menú. */
  const destino = MENU.find((m) => m.id === state.route);
  if (!destino || !verMenu(destino)) {
    state.route = 'dashboard';
    location.hash = '#/dashboard';
    return;
  }
  renderNav();
  $('#page-title').textContent = TITLES[state.route] || 'Dashboard';
  $('#page-title').dataset.view = state.route;
  const content = $('#content');
  try {
    content.innerHTML = await (VIEWS[state.route] || VIEWS.dashboard)();
  } catch (err) {
    content.innerHTML = `<div class="card"><div class="empty">Error: ${esc(err.message)}</div></div>`;
  }
  if (state.route === 'pos') renderCart();
  /* Los reportes llegan con los contenedores vacíos y se rellenan aparte: la
     tabla, el gráfico y los indicadores se pintan contra el DOM ya montado.
     Sin esto, abrir Reportes por primera vez mostraba los números en blanco
     hasta que se tocaba "Actualizar". */
  if (state.route === 'reportes' && state.repData) renderReporte(state.repData.rep, state.repData.prod);
  window.scrollTo(0, 0);
}

/* ============ VISTAS ============ */
const VIEWS = {
  dashboard: v_dashboard,
  pos: v_pos,
  ventas: v_ventas,
  instalaciones: v_instalaciones,
  productos: v_productos,
  categorias: v_categorias,
  inventario: v_inventario,
  compras: v_compras,
  proveedores: v_proveedores,
  clientes: v_clientes,
  sucursales: v_sucursales,
  gastos: v_gastos,
  empleados: v_empleados,
  reportes: v_reportes,
  config: v_config,
};

/* ---------- Dashboard ---------- */
async function v_dashboard() {
  const d = await api('GET', '/api/dashboard');
  const max = Math.max(...d.chart.map((c) => c.total), 1);
  return `
  <div class="grid cols-4 mb-2">
    <div class="card kpi primary-tint">
      <span class="kpi-label">Ventas de hoy</span>
      <span class="kpi-value">${fmt(d.ventasHoy.total)}</span>
      <span class="kpi-sub">${d.ventasHoy.n} venta(s) · ${d.ventasHoy.n ? fmt(d.ventasHoy.costo) : ''}</span>
    </div>
    <div class="card kpi ok-tint">
      <span class="kpi-label">Ticket promedio hoy</span>
      <span class="kpi-value">${fmt(d.ticketPromedio)}</span>
      <span class="kpi-sub">por operación</span>
    </div>
    <div class="card kpi info-tint">
      <span class="kpi-label">Ventas del mes</span>
      <span class="kpi-value">${fmt(d.ventasMes.total)}</span>
      <span class="kpi-sub">${d.ventasMes.n} venta(s)</span>
    </div>
    <div class="card kpi ${d.instalaciones?.abiertas ? 'warn-tint' : 'ok-tint'}" data-act="nav" data-nav="instalaciones" style="cursor:pointer">
      <span class="kpi-label">Instalaciones abiertas</span>
      <span class="kpi-value">${d.instalaciones?.abiertas ?? 0}</span>
      <span class="kpi-sub">${d.instalaciones?.en_progreso || 0} en campo · ${d.instalaciones?.sin_tecnico || 0} sin técnico</span>
    </div>
  </div>

  <div class="grid cols-2-1">
    <div class="grid">
      <div class="card">
        <h3>Ventas últimos 7 días <span class="hint">${fmt(d.ventasMes.total)} este mes</span></h3>
        <div class="bars">
          ${d.chart.map((c) => `
            <div class="bar-col">
              <span class="bar-value">${fmt(c.total)}</span>
              <div class="bar-track"><div class="bar" style="height:${Math.round((c.total / max) * 100)}%"></div></div>
              <span class="bar-label">${esc(c.dia)}</span>
            </div>`).join('')}
        </div>
      </div>
      <div class="card">
        <h3>Últimas ventas</h3>
        <div class="table-wrap">
          <table>
            <thead><tr><th>N°</th><th>Fecha</th><th>Cliente</th><th>Pago</th><th class="num">Total</th><th></th></tr></thead>
            <tbody>
              ${d.ultimasVentas.length ? d.ultimasVentas.map((v) => `
                <tr>
                  <td class="mono">${esc(v.numero)}</td>
                  <td class="table-muted">${fmtDT(v.fecha)}</td>
                  <td>${esc(v.cliente_nombre || '—')}</td>
                  <td>${METODO[v.metodo_pago] || v.metodo_pago} ${badgeEstado(v.estado)}</td>
                  <td class="num mono">${fmt(v.total)}</td>
                  <td class="text-right"><button class="btn btn-sm" data-act="venta-ver" data-id="${v.id}">Ver</button></td>
                </tr>`).join('')
              : '<tr><td colspan="6" class="empty">Sin ventas registradas</td></tr>'}
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <div class="grid">
      <div class="card">
        <h3>Stock bajo ${d.stockBajoCount ? `<span class="hint">${d.stockBajoCount} producto(s)</span>` : ''}</h3>
        ${d.stockBajo.length ? d.stockBajo.map((p) => `
          <div class="list-item">
            <div>
              <b>${esc(p.nombre)}</b>
              <div class="table-muted">${esc(p.codigo)} · mínimo ${Number(p.stock_minimo).toLocaleString('es-ES')}</div>
            </div>
            ${badgeStock(p.stock, p.stock_minimo, p.stock_reservado)}
          </div>`).join('')
          : '<div class="empty">Sin alertas de stock</div>'}
        <button class="btn btn-sm mt-2" data-act="nav" data-nav="inventario">Gestionar inventario</button>
      </div>
      <div class="card">
        <h3>Más vendidos del mes</h3>
        ${d.topProductos.length ? d.topProductos.map((p, i) => `
          <div class="list-item">
            <div><b>${i + 1}. ${esc(p.nombre)}</b><div class="table-muted">${Number(p.cantidad).toLocaleString('es-ES')} unidades</div></div>
            <b class="mono">${fmt(p.venta)}</b>
          </div>`).join('')
          : '<div class="empty">Sin datos este mes</div>'}
      </div>
      <div class="card">
        <h3>Utilidad por sucursal <span class="hint">mes en curso</span></h3>
        ${d.utilidadSucursales?.length ? `
        <div class="table-wrap">
          <table>
            <thead><tr><th>Sucursal</th><th class="num">Ventas</th><th class="num">Gastos</th><th class="num">Utilidad</th></tr></thead>
            <tbody>
              ${d.utilidadSucursales.map((s) => `
                <tr>
                  <td><b>${esc(s.sucursal)}</b></td>
                  <td class="num mono">${fmt(s.total)}</td>
                  <td class="num mono txt-err">${fmt(s.gastos)}</td>
                  <td class="num mono"><b class="${s.utilidad >= 0 ? 'txt-ok' : 'txt-err'}">${fmt(s.utilidad)}</b></td>
                </tr>`).join('')}
            </tbody>
          </table>
        </div>` : '<div class="empty">Sin ventas este mes</div>'}
      </div>
    </div>
  </div>`;
}

/* ---------- Punto de venta ---------- */
async function v_pos() {
  const [cats, prods, clientes, sucursales, tecnicos] = await Promise.all([
    getCats(), api('GET', '/api/productos'), api('GET', '/api/clientes'),
    getSucursales(), getTecnicos().catch(() => []),
  ]);
  const igv = Number(state.config?.iva) || 16;
  const suPropia = state.empleado.sucursal_id;
  state._clientesCache = clientes.clientes;
  return `
  <div class="pos-grid">
    <div>
      <div class="pos-search">
        <div class="input-group">
          <input type="text" id="pos-buscar" placeholder="Buscar por nombre, código o escanear…" />
          <select id="pos-cat">
            <option value="">Todas las categorías</option>
            ${cats.map((c) => `<option value="${c.id}">${esc(c.nombre)}</option>`).join('')}
          </select>
        </div>
      </div>
      <div class="pos-products" id="pos-grid">
        ${renderChips(prods.productos, '')}
      </div>
    </div>

    <div class="card cart-panel">
      <h3>Cobro actual <span class="hint">${state.cart.length} artículo(s)</span></h3>
      <div class="field">
        <span>Cliente</span>
        <select id="cart-cliente">
          <option value="">Público general</option>
          ${clientes.clientes.filter((c) => c.activo).map((c) => `<option value="${c.id}">${esc(c.nombre)}</option>`).join('')}
        </select>
      </div>
      <div class="field" ${suPropia ? '' : 'hidden'}>
        <span>Sucursal de la venta</span>
        <div class="static-value" title="La venta se registra en la sucursal donde estás afiliado">
          <b>${esc(sucursales.find((s) => s.id === suPropia)?.nombre || 'Sucursal no asignada')}</b>
        </div>
      </div>
      <div class="cart-items" id="cart-items"></div>
      <div id="cart-instalacion"></div>
      <div class="cart-totals">
        <div class="row"><span>Subtotal</span><b id="t-subtotal">${fmt(0)}</b></div>
        <div class="row">
          <span>Descuento</span>
          <input type="number" id="cart-descuento" min="0" step="0.01" value="0" style="width:110px" />
        </div>
        <div class="row"><span>IGV (${igv}%)</span><b id="t-impuestos">${fmt(0)}</b></div>
        <div class="row total"><span>TOTAL VENTA</span><span id="t-total">${fmt(0)}</span></div>
        <div class="row" hidden><span>Adelanto que entrega el cliente</span><b id="t-adelanto">${fmt(0)}</b></div>
        <div class="row" hidden><span>Saldo a cobrar por el técnico</span><b id="t-saldotecnico">${fmt(0)}</b></div>
        <div class="row total" hidden><span>A COBRAR HOY</span><span id="t-totalcobro">${fmt(0)}</span></div>
      </div>
      <div class="input-group mt-2">
        <select id="cart-destino">
          <option value="">¿Dónde recibió el pago?</option>
        </select>
        <input type="number" id="cart-efectivo" min="0" step="0.01" placeholder="Con $…" style="display:none" />
      </div>
      <input type="text" id="cart-referencia" class="mt-2" placeholder="N° de operación (Yape o Transferencia)" style="display:none" />
      <div class="mt-2 flex">
        <button class="btn btn-ghost" data-act="cart-clear">Vaciar</button>
        <button class="btn btn-primary grow" data-act="cart-cobrar">Cobrar ${fmt(0)}</button>
      </div>
    </div>
  </div>`;
}

/* Stock vendible: lo que hay en almacén menos lo comprometido a visitas con
   instalación que aún no retiraron el material. */
function disponible(p) {
  return Math.round(((p.stock || 0) - (p.stock_reservado || 0)) * 100) / 100;
}

/* ---------- Piezas y cajas ----------
   El stock SIEMPRE se cuenta en piezas. La caja (bolsa, caja) es solo la
   forma de teclear la cantidad: un producto con contenido 30 se compra en
   bolsas de 30 y se vende de a uno. Por eso la compra y la recepción multiplican
   por el contenido, y la venta nunca lo hace. */
function contenidoDe(p) {
  const n = Number(p?.contenido);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

/* El interruptor aparece en cuanto la caja trae más de una pieza, sin importar
   cómo se mida el producto. Antes se ocultaba cuando la unidad ya era "caja" y
   con eso desaparecía justo de los productos que se compran en paquete. */
function tieneCaja(p) {
  return contenidoDe(p) > 1;
}

/* Cómo se llama al paquete en el interruptor. Si el producto ya se mide en
   cajas, decir "caja | caja" no diría nada, y ahí el paquete se llama
   "paquete". En el resto de los productos es "caja". */
function nombrePaquete(p) {
  return (UNIDAD[p?.unidad] || 'pza') === 'caja' ? 'paquete' : 'caja';
}

function renderChips(prods, busca) {
  const b = busca.toLowerCase();
  const f = prods.filter((p) => !b
    || p.nombre.toLowerCase().includes(b)
    || p.codigo.toLowerCase().includes(b)
    || (p.codigo_barras || '').includes(b));
  if (!f.length) return '<div class="empty" style="grid-column:1/-1">Sin resultados</div>';
  return f.map((p) => {
    const disp = disponible(p);
    const reservado = Number(p.stock_reservado) || 0;
    return `
    <button class="chip-prod ${disp <= p.stock_minimo ? 'stock-low' : ''}" data-act="pos-prod" data-id="${p.id}" ${disp <= 0 ? 'disabled' : ''}>
      <b>${esc(p.nombre)}</b>
      <small>${esc(p.codigo)} · ${esc(p.categoria_nombre || '')}</small>
      <span class="price">${fmt(p.precio)}</span>
      <small>${disp <= 0
        ? (reservado > 0 ? 'RESERVADO PARA INSTALACIÓN' : 'AGOTADO')
        : `${disp.toLocaleString('es-ES')} ${UNIDAD[p.unidad] || 'pza'} disponibles${reservado > 0 ? ` · ${reservado} reservado` : ''}`}</small>
    </button>`;
  }).join('');
}

/* Precio efectivo por unidad. La instalación ya no va aquí: es un servicio
   aparte que el asesor cotiza en el carrito. */
function precioUnitario(p) {
  return Number(p.precio || 0);
}

/* Tarifa que se propone al abrir el panel: si algún producto del carrito tiene
   una tarifa guardada de antes, se respeta esa; si no, la de Configuración. */
function tarifaInstalacionSugerida() {
  const conTarifa = state.cart.find((l) => Number(l.producto.precio_instalacion || 0) > 0);
  if (conTarifa) return Number(conTarifa.producto.precio_instalacion);
  return Number(state.config?.precio_instalacion) || 0;
}

/* Costo de la instalación de la venta en curso. Se lee el campo vivo para que
   el botón de cobro nunca use un valor que el asesor acaba de cambiar. */
function costoInstalacion() {
  if (!state.inst.on) return 0;
  const enPantalla = $('#inst-precio');
  if (enPantalla) return Math.max(0, Number(enPantalla.value) || 0);
  return Math.max(0, Number(state.inst.precio) || 0);
}

/* La sección de instalación siempre está disponible: apagada por defecto, la
   enciende el asesor si el cliente la pide. */
function renderPanelInstalacion() {
  const cont = $('#cart-instalacion');
  if (!cont) return;
  const inst = state.inst;
  if (!inst.on) {
    cont.innerHTML = `
      <div class="inst-panel inst-off">
        <label class="inst-switch">
          <input type="checkbox" id="inst-switch" style="width:auto">
          <span><b>Instalación a domicilio</b><small class="table-muted">Una visita del técnico. Tarifa ${fmt(tarifaInstalacionSugerida())}, ajustable al cobrarla.</small></span>
        </label>
      </div>`;
    return;
  }

  const costo = costoInstalacion();
  const totalVenta = totalVentaActual();
  const sugeridoAdel = Math.round(totalVenta * 0.4 * 100) / 100;
  const fechaPrevia = inst.fecha || hoy();
  const horaPrevia = inst.hora || '09:00';
  /* Si el asesor ya escribió un costo se respeta, aunque sea 0. */
  const valorPrecio = inst.precio === null ? (tarifaInstalacionSugerida() || '') : inst.precio;

  cont.innerHTML = `
    <div class="inst-panel">
      <div class="inst-head">
        <b>Instalación a domicilio</b>
        <label class="inst-switch-mini"><input type="checkbox" id="inst-switch" checked style="width:auto"><span>Quitar</span></label>
      </div>
      <div class="field"><span class="req">Costo de la instalación</span>
        <input type="number" id="inst-precio" min="0" step="0.01" value="${valorPrecio}" placeholder="0.00">
        <small class="table-muted">Tarifa sugerida ${fmt(tarifaInstalacionSugerida())}. Cámbiala si el trabajo es más difícil.</small>
      </div>
      <div class="field"><span class="req">Dirección de entrega</span>
        <input id="inst-direccion" placeholder="Calle, número, referencias" value="${esc(inst.direccion)}">
      </div>
      <div class="field"><span>Teléfono de contacto</span>
        <input id="inst-contacto" placeholder="Número de contacto" value="${esc(inst.contacto)}">
      </div>
      <div class="field"><span>Técnico que realiza la instalación</span>
        <select id="inst-tecnico">
          <option value="">Sin asignar (lo asigna el administrador)</option>
          ${(state._tecnicos || []).map((t) => `<option value="${t.id}" ${String(t.id) === String(inst.tecnico_id) ? 'selected' : ''}>${esc(t.nombre)} · ${esc(t.sucursal_nombre || 'sin sucursal')}</option>`).join('')}
        </select>
      </div>
      <div class="field">
        <span class="req">Fecha y hora de la visita</span>
        <div class="input-group">
          <input type="date" id="inst-fecha" value="${esc(fechaPrevia)}" min="${hoy()}">
          <input type="time" id="inst-hora" value="${esc(horaPrevia)}" step="900">
        </div>
        <small class="table-muted">Sin cita no se puede agendar la visita.</small>
      </div>
      <div class="field">
        <span class="req">Adelanto que entrega el cliente</span>
        <input type="number" id="inst-adelanto" min="0" step="0.01" placeholder="0.00" value="${inst.adelanto ?? ''}">
        <small class="table-muted" id="inst-ayuda"></small>
      </div>
      <div class="field"><span>Notas para el técnico</span>
        <textarea id="inst-notas" placeholder="Instrucciones de acceso, horarios preferidos…">${esc(inst.notas)}</textarea>
      </div>
    </div>`;
  const inp = $('#inst-adelanto');
  if (inp) {
    if (inst.adelanto === null) inp.value = sugeridoAdel.toFixed(2);
    inp.max = totalVenta || '';
  }
  /* Al abrirse el panel se autocompleta lo que falte con los datos del
     cliente ya elegido, y de paso se sincroniza el borrador. */
  prefillInstalacionCliente(false);
  actualizarSaldoInstalacion();
}

/* Muestra en vivo cómo se reparte lo que falta: el técnico se queda con sus
   honorarios y devuelve el resto en tienda. */
function actualizarSaldoInstalacion() {
  const costo = costoInstalacion();
  const totalVenta = totalVentaActual();
  const adel = Math.round((Number($('#inst-adelanto')?.value) || 0) * 100) / 100;
  const saldo = Math.max(0, Math.round((totalVenta - adel) * 100) / 100);
  const ayuda = $('#inst-ayuda');
  if (ayuda) {
    ayuda.innerHTML = `El cliente entrega <b>${fmt(adel)}</b> ahora y el técnico cobra
      <b>${fmt(saldo)}</b> al terminar: <b>${fmt(Math.min(costo, saldo))}</b> de honorarios y
      <b>${fmt(Math.max(0, saldo - costo))}</b> que entrega en tienda.
      Sugerido 40% del total: ${fmt(Math.round(totalVenta * 0.4 * 100) / 100)}`;
  }
}

function renderCart() {
  const el = $('#cart-items');
  if (!el) return;
  if (!state.cart.length) {
    el.innerHTML = '<div class="empty">Agrega productos para comenzar</div>';
  } else {
    el.innerHTML = state.cart.map((l, i) => filaCarrito(l, i)).join('');
  }
  renderPanelInstalacion();
  actualizarTotales();
  cargarDestinosCart();
}

/* Una línea del carrito. `l.cant` está siempre en piezas; el interruptor solo
   cambia la unidad en la que se teclea el número. Debajo se repite la cuenta
   ("2 cajas = 60 pzas") para que nadie cobre 2 piezas pensando que vendió 2
   cajas. */
function filaCarrito(l, i) {
  const p = l.producto;
  const c = contenidoDe(p);
  const modo = l.modo === 'caja' && tieneCaja(p) ? 'caja' : 'pza';
  const enCajas = modo === 'caja';
  const escrito = enCajas ? Math.max(1, Math.round(l.cant / c)) : l.cant;
  const tope = enCajas
    ? Math.floor(disponible(p) / c)
    : disponible(p);
  const pz = esc(UNIDAD[p.unidad] || 'pza');
  const paq = esc(nombrePaquete(p));
  return `
    <div class="cart-line">
      <b>${esc(p.nombre)}</b>
      <span class="table-muted">${fmt(precioUnitario(p))}</span>
      ${tieneCaja(p) ? `<span class="modo-cantidad" role="group" aria-label="Cantidad en ${pz} o ${paq}">
          <button type="button" class="modo-btn ${enCajas ? '' : 'on'}" data-act="cart-modo" data-modo="pza" data-idx="${i}" title="Vender ${pz} sueltas">${pz}</button>
          <button type="button" class="modo-btn ${enCajas ? 'on' : ''}" data-act="cart-modo" data-modo="caja" data-idx="${i}" title="Vender ${paq} de ${c}">${paq}</button>
        </span>` : ''}
      <input type="number" class="qty-input" data-act="cart-qty" data-idx="${i}" min="1" step="1" max="${tope}" value="${escrito}" aria-label="Cantidad" />
      <b class="mono">${fmt(precioUnitario(p) * l.cant)}</b>
      <button class="icon-btn" data-act="cart-del" data-idx="${i}" style="color:var(--danger)" aria-label="Quitar">✕</button>
    </div>
    ${enCajas ? `<div class="cart-nota">${escrito} ${paq}${escrito === 1 ? '' : 's'} de ${c} = ${fmt(l.cant)} ${pz}</div>` : ''}`;
}

/* Recalcula los importes del panel. Se llama aparte de renderCart para no
   redibujar el formulario mientras el asesor escribe el adelanto. */
/* Total de la venta en curso: productos más instalación, con IGV y descuento.
   Es la cifra sobre la que se calcula el adelanto y el saldo del técnico. */
function totalVentaActual() {
  const igv = Number(state.config?.iva) || 16;
  const subtotal = Math.round((state.cart.reduce((a, l) => a + precioUnitario(l.producto) * l.cant, 0) + costoInstalacion()) * 100) / 100;
  const dcto = Math.min(Number($('#cart-descuento')?.value) || 0, subtotal);
  const base = subtotal - dcto;
  return Math.round((base + base * (igv / 100)) * 100) / 100;
}

function actualizarTotales() {
  const igv = Number(state.config?.iva) || 16;
  const subtotal = Math.round((state.cart.reduce((a, l) => a + precioUnitario(l.producto) * l.cant, 0) + costoInstalacion()) * 100) / 100;
  const dcto = Math.min(Number($('#cart-descuento')?.value) || 0, subtotal);
  const base = subtotal - dcto;
  const imp = base * (igv / 100);
  const total = base + imp;
  $('#t-subtotal').textContent = fmt(subtotal);
  $('#t-impuestos').textContent = fmt(imp);
  $('#t-total').textContent = fmt(total);

  /* Con instalación el cliente no cancela la venta: entrega un adelanto y el
     técnico cobra el resto al terminar. Sin ella se cobra todo aquí. */
  const costoInst = costoInstalacion();
  const conInst = costoInst > 0;
  const adel = conInst ? Math.round((Number($('#inst-adelanto')?.value) || 0) * 100) / 100 : 0;
  const saldo = Math.max(0, Math.round((total - adel) * 100) / 100);
  const aCobrar = conInst ? adel : total;

  const filaAdel = $('#t-adelanto');
  if (filaAdel) {
    filaAdel.parentElement.hidden = !conInst;
    filaAdel.textContent = fmt(adel);
  }
  const filaSaldo = $('#t-saldotecnico');
  if (filaSaldo) {
    filaSaldo.parentElement.hidden = !conInst;
    filaSaldo.textContent = fmt(saldo);
  }
  const filaTotal = $('#t-totalcobro');
  if (filaTotal) {
    filaTotal.parentElement.hidden = !conInst;
    filaTotal.textContent = fmt(aCobrar);
  }
  const btn = $('[data-act="cart-cobrar"]');
  if (btn) btn.innerHTML = conInst ? `Cobrar adelanto ${fmt(aCobrar)}` : `Cobrar ${fmt(aCobrar)}`;
  const eff = $('#cart-efectivo');
  if (eff) eff.placeholder = `Con ${mon()}…`;
  actualizarEfectivoUI();
}

/* Al elegir cliente se precargan dirección y teléfono de la orden, y se
   escriben también en el borrador: si sólo se tocara el formulario, el
   siguiente redibujado del carrito los perdería.

   Se llama en dos momentos distintos y no en los dos rellena igual:
   - al cambiar de cliente, `forzar`: otro cliente trae otra dirección, así que
     lo tecleado se reemplaza;
   - al construir el panel, sin forzar: si el asesor ya vació un campo a
     propósito, redibujar el carrito no debe resucitarlo. */
function prefillInstalacionCliente(forzar) {
  const sel = $('#cart-cliente');
  const dir = $('#inst-direccion');
  const tel = $('#inst-contacto');
  if (!sel || !dir || !tel) return;
  const c = (state._clientesCache || []).find((x) => x.id === Number(sel.value));
  if (!c) return;
  const inst = state.inst;
  if (forzar || (!dir.value && !inst.direccionTocada)) {
    dir.value = c.direccion || '';
    inst.direccion = dir.value;
    inst.direccionTocada = false;
  }
  if (forzar || (!tel.value && !inst.contactoTocada)) {
    tel.value = c.telefono || '';
    inst.contacto = tel.value;
    inst.contactoTocada = false;
  }
}

function actualizarEfectivoUI() {
  const sel = $('#cart-destino');
  const eff = $('#cart-efectivo');
  const ref = $('#cart-referencia');
  const dest = state._destinos?.find((d) => String(d.id) === String(sel?.value));
  const tipo = dest?.tipo || '';
  if (eff) {
    eff.style.display = tipo === 'efectivo' ? '' : 'none';
    eff.placeholder = `Con ${mon()}…`;
  }
  if (ref) {
    const requiere = tipo === 'yape' || tipo === 'transferencia';
    ref.style.display = requiere ? '' : 'none';
    if (!requiere) ref.value = '';
    if (dest) ref.placeholder = `N° de operación (${dest.tipo === 'yape' ? 'Yape' : 'Transferencia'})`;
  }
}

function addToCart(prod) {
  const exist = state.cart.find((l) => l.producto.id === prod.id);
  const disp = disponible(prod);
  /* Escanear siempre mete una pieza. Si el asesor ya dejó la línea en cajas
     porque el cliente se lleva cajas, cada lectura suma un caja entero: sería
     raro escanear seis veces y quedarse en seis piezas de una caja de 30. */
  const paso = exist && exist.modo === 'caja' ? contenidoDe(exist.producto) : 1;
  if (exist) {
    if (exist.cant + paso > disp) { toast('Stock máximo alcanzado', 'err'); return; }
    exist.cant += paso;
  } else {
    if (disp < paso) { toast('Sin stock disponible', 'err'); return; }
    state.cart.push({ producto: prod, cant: paso, modo: 'pza' });
  }
  renderCart();
}

/* Convierte lo que escribió el asesor a piezas, respetando si esa línea está
   contando piezas o cajas, y sin dejar que pase de lo que hay en almacén. */
function fijarCantidadCarrito(l, escrito) {
  const c = contenidoDe(l.producto);
  const enCajas = l.modo === 'caja' && tieneCaja(l.producto);
  const n = Math.max(1, Math.floor(Number(escrito) || 0) || 1);
  const tope = enCajas
    ? Math.floor(disponible(l.producto) / c)
    : disponible(l.producto);
  const v = Math.max(1, Math.min(n, Math.max(1, tope)));
  l.cant = enCajas ? v * c : v;
  return l.cant;
}

async function checkout() {
  if (!state.cart.length) { toast('El carrito está vacío', 'err'); return; }
  const destSel = $('#cart-destino');
  const destino_id = destSel && destSel.value ? Number(destSel.value) : null;
  const cliente_id = $('#cart-cliente').value ? Number($('#cart-cliente').value) : null;
  const igv = Number(state.config?.iva) || 16;
  const conInst = state.inst.on;
  const costoInst = costoInstalacion();
  const subtotal = Math.round((state.cart.reduce((a, l) => a + precioUnitario(l.producto) * l.cant, 0) + costoInst) * 100) / 100;
  const descuento = Math.min(Number($('#cart-descuento').value) || 0, subtotal);
  const total = Math.round((subtotal - descuento + (subtotal - descuento) * igv / 100) * 100) / 100;

  const adelanto = conInst ? Math.round((Number($('#inst-adelanto')?.value) || 0) * 100) / 100 : 0;
  /* Con instalación el adelanto sale en caja y el resto lo cobra el técnico. */
  const aCobrar = conInst ? adelanto : total;

  const dest = state._destinos?.find((d) => String(d.id) === String(destino_id));
  if (!destino_id || !dest) { toast('Selecciona dónde recibió el pago', 'err'); return; }
  const tipoDest = dest.tipo;

  const eff = Number($('#cart-efectivo').value) || 0;
  let monto = aCobrar;
  if (tipoDest === 'efectivo') {
    if (eff < aCobrar) {
      toast(`El monto recibido es menor al cobro de hoy (${mon()} ${aCobrar.toFixed(2)})`, 'err');
      return;
    }
    monto = eff;
  }
  const referencia = String($('#cart-referencia')?.value || '').trim();
  if ((tipoDest === 'yape' || tipoDest === 'transferencia') && !referencia) {
    toast('Anota el N° de operación del pago', 'err');
    return;
  }

  const payload = {
    items: state.cart.map((l) => ({
      producto_id: l.producto.id,
      cantidad: l.cant,
      modo_retiro: l.modo === 'caja' && tieneCaja(l.producto) ? 'caja' : 'pza',
    })),
    cliente_id, destino_id, referencia, descuento, monto_pagado: monto,
  };

  if (conInst) {
    if (costoInst <= 0) { toast('Indica el costo de la instalación a domicilio', 'err'); return; }
    if (!cliente_id) { toast('Selecciona el cliente para la instalación a domicilio', 'err'); return; }
    const direccion = ($('#inst-direccion')?.value || '').trim();
    if (!direccion) { toast('Ingresa la dirección de entrega', 'err'); return; }
    const fecha = $('#inst-fecha')?.value || '';
    const hora = $('#inst-hora')?.value || '';
    if (!fecha) { toast('Selecciona la fecha de la instalación', 'err'); return; }
    if (!hora) { toast('Selecciona la hora de la instalación', 'err'); return; }
    if (adelanto <= 0) { toast('Registra el adelanto del cliente para validar la instalación', 'err'); return; }
    if (adelanto > total) { toast('El adelanto no puede superar el total de la venta', 'err'); return; }
    payload.instalacion = {
      precio: costoInst,
      direccion,
      contacto: ($('#inst-contacto')?.value || '').trim(),
      tecnico_id: $('#inst-tecnico')?.value ? Number($('#inst-tecnico').value) : null,
      fecha_programada: fecha,
      hora_programada: hora,
      adelanto,
      notas: ($('#inst-notas')?.value || '').trim(),
    };
  }

  try {
    const r = await api('POST', '/api/ventas', payload);
    state.cart = [];
    state.inst = nuevaInstalacion();
    renderCart();
    showTicket(r.venta);
    const n = r.instalaciones || 0;
    toast(n ? `Venta ${r.venta.numero} · visita de instalación agendada` : `Venta ${r.venta.numero} registrada`);
    setTimeout(() => render(), 250);
  } catch (err) {
    toast(err.message, 'err');
  }
}

function showTicket(venta) {
  const igv = Number(state.config?.iva) || 16;
  openModal({
    title: `Venta ${venta.numero}`,
    wide: true,
    body: `
      <div class="hidden" id="ticket-html">${ticketHTML(venta)}</div>
      <div class="grid cols-2-1">
        <div>${ticketHTML(venta)}</div>
        <div>
          <div class="card">
            <h3>Pago</h3>
            <div class="stat-line"><span>Método</span><b>${METODO[venta.metodo_pago] || venta.metodo_pago}</b></div>
            ${venta.instalaciones?.length ? `
            <div class="stat-line"><span>Adelanto recibido</span><b>${fmt(sumaAdelanto(venta))}</b></div>
            <div class="stat-line"><span>Entregado en caja</span><b>${fmt(venta.monto_pagado)}</b></div>
            <div class="stat-line"><span>Saldo para el técnico</span><b>${fmt(sumaSaldo(venta))}</b></div>
            <div class="stat-line"><span>&nbsp;&nbsp;· Honorarios</span><b>${fmt(sumaHonorarios(venta))}</b></div>
            <div class="stat-line"><span>&nbsp;&nbsp;· A entregar en tienda</span><b>${fmt(Math.max(0, sumaSaldo(venta) - sumaHonorarios(venta)))}</b></div>
            ` : `
            <div class="stat-line"><span>Recibido</span><b>${fmt(venta.monto_pagado)}</b></div>
            <div class="stat-line"><span>Cambio</span><b>${fmt(venta.cambio)}</b></div>
            `}
            <div class="stat-line"><span>IGV aplicado</span><b>${igv}%</b></div>
            ${venta.sucursal_nombre ? `<div class="stat-line"><span>Sucursal</span><b>${esc(venta.sucursal_nombre)}</b></div>` : ''}
          </div>
          ${venta.instalaciones?.length ? `
          <div class="card mt-2">
            <h3>Instalaciones generadas</h3>
            ${venta.instalaciones.map((i) => `
              <div class="stat-line"><span>${esc(i.codigo)} · ${esc(i.producto_nombre)}</span>${badgeInstalacion(i.estado)}</div>
              <div class="table-muted" style="padding-bottom:6px">${esc(i.direccion)} · ${i.fecha_programada ? `cita ${esc(i.fecha_programada)} ${esc(i.hora_programada || '')}` : 'sin fecha'}${i.tecnico_nombre ? ` · ${esc(i.tecnico_nombre)}` : ' · sin técnico'}</div>
              <div class="table-muted" style="padding-bottom:8px">Total financiado ${fmt(i.monto_financiado ?? i.costo)} · adelanto ${fmt(i.adelanto)} · saldo a cobrar por el técnico ${fmt(i.saldo_pendiente)}</div>
              ${i.evidencias?.length ? `<h4 class="ev-sub">Evidencia${i.evidencias.length > 1 ? ` (${i.evidencias.length})` : ''}</h4>${evidenciasGrid(i.evidencias)}` : ''}
            `).join('')}
          </div>` : ''}
          <button class="btn btn-primary btn-block mt-2" data-act="ticket-print">Imprimir ticket</button>
        </div>
      </div>`,
    footer: '<button class="btn btn-primary" data-act="modal-close">Hecho</button>',
  });
}

function sumaAdelanto(v) {
  return (v.instalaciones || []).reduce((a, i) => a + Number(i.adelanto || 0), 0);
}

function sumaSaldo(v) {
  return (v.instalaciones || []).reduce((a, i) => a + Math.max(0, Number(i.saldo_pendiente ?? ((i.monto_financiado ?? i.costo) - i.adelanto))), 0);
}

function sumaHonorarios(v) {
  return (v.instalaciones || []).reduce((a, i) => a + Number(i.costo || 0), 0);
}

function ticketHTML(v) {
  /* conInst se basa en las órdenes: las ventas nuevas traen una sola orden por
     visita, las antiguas una por producto, y en ambos casos el bloque de
     adelanto y saldo aplica igual. */
  const conInst = (v.instalaciones || []).length > 0;
  const adelanto = sumaAdelanto(v);
  const saldo = sumaSaldo(v);
  const honorarios = sumaHonorarios(v);
  return `
  <div class="ticket">
    <h4>${esc(state.config?.nombre_tienda || 'Tienda Retail')}</h4>
    <div class="tcenter">${[state.config?.documento, v.sucursal_direccion, v.sucursal_telefono].filter(Boolean).map(esc).join('<br/>')}</div>
    ${v.sucursal_nombre ? `<div class="tdash"></div><div class="trow"><span>Sucursal</span><span>${esc(v.sucursal_nombre)}</span></div>` : ''}
    <div class="tdash"></div>
    <div class="trow"><span>N°</span><b>${esc(v.numero)}</b></div>
    <div class="trow"><span>Fecha</span><span>${fmtDT(v.fecha)}</span></div>
    <div class="trow"><span>Cliente</span><span>${esc(v.cliente_nombre || 'Público general')}</span></div>
    <div class="trow"><span>Atendió</span><span>${esc(v.empleado_nombre || '')}</span></div>
    <div class="tdash"></div>
    <table>
      ${v.items.map((i) => `
        <tr><td>${esc(i.nombre)}${Number(i.precio_instalacion) > 0 ? ' <small>(c/ inst.)</small>' : ''}<br/><small>${Number(i.cantidad).toLocaleString('es-ES')} × ${fmt(i.precio + Number(i.precio_instalacion || 0))}</small></td><td class="num">${fmt(i.subtotal)}</td></tr>`).join('')}
    </table>
    <div class="tdash"></div>
    <div class="trow"><span>Subtotal</span><span>${fmt(v.subtotal)}</span></div>
    ${v.descuento ? `<div class="trow"><span>Descuento</span><span>-${fmt(v.descuento)}</span></div>` : ''}
    <div class="trow"><span>IGV (${v.igv_rate || 0}%)</span><span>${fmt(v.impuestos)}</span></div>
    <div class="trow tbold"><span>TOTAL</span><span>${fmt(v.total)}</span></div>
    ${conInst ? `
    <div class="tdash"></div>
    <div class="trow"><span>Adelanto entregado</span><span>${fmt(adelanto)}</span></div>
    <div class="trow tbold"><span>PAGADO HOY</span><span>${fmt(adelanto)}</span></div>
    <div class="trow"><span>Saldo a cobrar al técnico</span><span>${fmt(saldo)}</span></div>
    <div class="trow"><span>· Honorarios del técnico</span><span>${fmt(Math.min(honorarios, saldo))}</span></div>
    <div class="trow"><span>· A entregar en tienda</span><span>${fmt(Math.max(0, saldo - honorarios))}</span></div>` : ''}
    ${conInst ? `<div class="trow"><span>* Pago ${METODO[v.metodo_pago] || v.metodo_pago}</span><span>${fmt(v.monto_pagado)}</span></div>` : `<div class="trow"><span>Pago ${METODO[v.metodo_pago] || v.metodo_pago}</span><span>${fmt(v.monto_pagado)}</span></div>`}${v.destino_nombre ? `<div class="trow"><span>Recibido en</span><span>${esc(v.destino_nombre)}${v.destino_identificador ? ` (${esc(v.destino_identificador)})` : ''}</span></div>` : ''}${v.referencia ? `<div class="trow"><span>Operación</span><span>${esc(v.referencia)}</span></div>` : ''}
    ${v.cambio ? `<div class="trow"><span>Cambio</span><span>${fmt(v.cambio)}</span></div>` : ''}
    <div class="tdash"></div>
    <div class="tcenter">${esc(state.config?.pie_ticket || '¡Gracias por su compra!')}</div>
  </div>`;
}

/* ---------- Ventas ---------- */
async function v_ventas() {
  const sucursales = await getSucursales();
  const f = state.fVentas;
  if (!f.desde) f.desde = haceNDias(7);
  if (!f.hasta) f.hasta = hoy();
  const r = await api('GET', '/api/ventas', {
    desde: f.desde, hasta: f.hasta, estado: f.estado === 'todas' ? '' : f.estado,
    sucursal_id: f.sucursal_id, buscar: f.buscar,
  });
  return `
  <div class="toolbar">
    <input type="date" id="f-desde" value="${f.desde}">
    <input type="date" id="f-hasta" value="${f.hasta}">
    <select id="f-estado">
      <option value="todas" ${f.estado === 'todas' ? 'selected' : ''}>Todos los estados</option>
      <option value="completada" ${f.estado === 'completada' ? 'selected' : ''}>Completadas</option>
      <option value="anulada" ${f.estado === 'anulada' ? 'selected' : ''}>Anuladas</option>
    </select>
    ${state.empleado.rol === 'asesor' ? `<span class="badge badge-info">${esc(state.empleado.sucursal_nombre || 'Sin sucursal asignada')}</span>` : `
    <select id="f-sucursal">
      <option value="">Todas las sucursales</option>
      ${sucursales.map((s) => `<option value="${s.id}" ${String(f.sucursal_id) === String(s.id) ? 'selected' : ''}>${esc(s.nombre)}</option>`).join('')}
    </select>`}
    <input class="search" id="f-buscar" placeholder="Buscar por N° o cliente…" value="${esc(f.buscar)}">
    <button class="btn btn-primary btn-sm" data-act="ventas-filtrar">Filtrar</button>
  </div>
  <div class="card">
    <table>
      <thead><tr><th>N°</th><th>Fecha</th><th>Cliente</th><th>Sucursal</th><th>Vendedor</th><th>Pago</th><th>Art.</th><th class="num">Total</th><th>Estado</th><th></th></tr></thead>
      <tbody>
        ${r.ventas.length ? r.ventas.map((v) => `
          <tr>
            <td class="mono">${esc(v.numero)}</td>
            <td class="table-muted">${fmtDT(v.fecha)}</td>
            <td>${esc(v.cliente_nombre || '—')}</td>
            <td class="table-muted">${esc(v.sucursal_nombre || '—')}</td>
            <td>${esc(v.empleado_nombre || '—')}</td>
            <td>${METODO[v.metodo_pago] || v.metodo_pago}</td>
            <td class="num">${v.n_items}${v.n_instalaciones ? ` <span class="inst-tag" title="Con instalación a domicilio">${icon('instalaciones')} ${v.n_instalaciones}</span>` : ''}</td>
            <td class="num mono">${fmt(v.total)}</td>
            <td>${badgeEstado(v.estado)}</td>
            <td class="text-right">
              <button class="btn btn-sm" data-act="venta-ver" data-id="${v.id}">Ver</button>
              ${v.estado === 'completada' && puede('ventas:anular') ? `<button class="btn btn-sm btn-danger" data-act="venta-anular" data-id="${v.id}">Anular</button>` : ''}
            </td>
          </tr>`).join('')
        : '<tr><td colspan="10" class="empty">No hay ventas en el rango seleccionado</td></tr>'}
      </tbody>
    </table>
  </div>`;
}

async function ventaDetalle(id, anular = false) {
  try {
    const r = await api('POST', `/api/ventas/${id}/ticket`);
    const v = r.venta;
    openModal({
      title: `Venta ${v.numero}`,
      wide: true,
      body: `
        <div class="grid cols-2-1">
          <div class="table-wrap">
            <table>
              <thead><tr><th>Producto</th><th class="num">Cant.</th><th class="num">Precio</th><th class="num">Total</th></tr></thead>
              <tbody>
                ${v.items.map((i) => `<tr><td>${esc(i.nombre)}${Number(i.precio_instalacion) > 0 ? ' <span class="inst-tag">inst.</span>' : ''}</td><td class="num">${Number(i.cantidad).toLocaleString('es-ES')}</td><td class="num">${fmt(i.precio + Number(i.precio_instalacion || 0))}</td><td class="num mono">${fmt(i.subtotal)}</td></tr>`).join('')}
              </tbody>
            </table>
            ${v.instalaciones?.length ? `
            <h3 class="mt-2">Órdenes de instalación</h3>
            ${v.instalaciones.map((i) => `
              <div class="list-item">
                <div>
                  <b>${esc(i.codigo)} · ${esc(i.producto_nombre)}</b>
                  <div class="table-muted">${esc(i.direccion)}${i.tecnico_nombre ? ` · ${esc(i.tecnico_nombre)}` : ' · sin técnico'}${i.fecha_programada ? ` · ${esc(i.fecha_programada)}` : ''}</div>
                </div>
                ${badgeInstalacion(i.estado)}
              </div>`).join('')}` : ''}
          </div>
          <div>
            <div class="stat-line"><span>Fecha</span><b>${fmtDT(v.fecha)}</b></div>
            <div class="stat-line"><span>Cliente</span><b>${esc(v.cliente_nombre || '—')}</b></div>
            <div class="stat-line"><span>Sucursal</span><b>${esc(v.sucursal_nombre || '—')}</b></div>
            <div class="stat-line"><span>Vendedor</span><b>${esc(v.empleado_nombre || '—')}</b></div>
            <div class="stat-line"><span>Estado</span>${badgeEstado(v.estado)}</div>
            <div class="stat-line"><span>Subtotal</span><b>${fmt(v.subtotal)}</b></div>
            ${v.descuento ? `<div class="stat-line"><span>Descuento</span><b>-${fmt(v.descuento)}</b></div>` : ''}
            <div class="stat-line"><span>IGV</span><b>${fmt(v.impuestos)}</b></div>
            <div class="stat-line"><span>Pago</span><b>${METODO[v.metodo_pago] || v.metodo_pago} · ${fmt(v.monto_pagado)}${v.cambio ? ` (cambio ${fmt(v.cambio)})` : ''}</b></div>
            <div class="stat-line"><span>Total</span><b style="font-size:17px">${fmt(v.total)}</b></div>
            ${v.instalaciones?.length ? `
              <div class="divider"></div>
              <div class="stat-line"><span>Adelanto recibido</span><b>${fmt(sumaAdelanto(v))}</b></div>
              <div class="stat-line"><span>Saldo para el técnico</span><b style="color:var(--warn)">${fmt(sumaSaldo(v))}</b></div>
              <div class="stat-line"><span>&nbsp;&nbsp;· Honorarios</span><b>${fmt(sumaHonorarios(v))}</b></div>
              <div class="stat-line"><span>&nbsp;&nbsp;· A entregar en tienda</span><b>${fmt(Math.max(0, sumaSaldo(v) - sumaHonorarios(v)))}</b></div>
            ` : ''}
            ${v.notas ? `<div class="mt-2 text-muted" style="font-size:12.5px">Notas: ${esc(v.notas)}</div>` : ''}
          </div>
        </div>`,
      footer: `
        <button class="btn btn-sm" data-act="ticket-print" data-id="${v.id}">Ticket</button>
        ${v.estado === 'completada' && puede('ventas:anular') ? `<button class="btn btn-sm btn-danger" data-act="venta-anular" data-id="${v.id}">Anular venta</button>` : ''}
        <button class="btn btn-primary btn-sm" data-act="modal-close">Cerrar</button>`,
    });
  } catch (err) { toast(err.message, 'err'); }
}

async function anularVenta(id) {
  if (!(await uiConfirm('¿Anular esta venta? Se devolverá el stock a inventario. Esta acción no se puede deshacer.'))) return;
  try {
    const motivo = await uiPrompt('Motivo (opcional):', '');
    if (motivo === null) return;
    await api('POST', `/api/ventas/${id}/anular`, { motivo });
    toast('Venta anulada y stock restituido');
    render();
  } catch (err) { toast(err.message, 'err'); }
}

async function printTicketData(id) {
  const r = await api('POST', `/api/ventas/${id}/ticket`);
  printHTML(ticketHTML(r.venta));
}

function printHTML(html) {
  $('#print-area').innerHTML = html;
  window.print();
  setTimeout(() => { $('#print-area').innerHTML = ''; }, 500);
}

function hoy() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function haceNDias(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const MESES_CORTOS = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'set', 'oct', 'nov', 'dic'];
const MESES_LARGOS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'setiembre', 'octubre', 'noviembre', 'diciembre'];

/* El mes en curso como 'AAAA-MM', el formato en que se guarda mes_cobro. */
function hoyMes() { return hoy().slice(0, 7); }

/* '2026-09' -> 'septiembre 2026'. Los gastos y el alquiler se conversan por
   mes, no por día, así que el mes tiene que leerse como una palabra. */
function mesLabel(mes) {
  const [a, m] = String(mes || '').split('-');
  const i = Number(m) - 1;
  return i >= 0 && i < 12 ? `${MESES_LARGOS[i]} ${a}` : (mes || '');
}

/* ---------- Instalaciones a domicilio ---------- */
async function v_instalaciones() {
  const [r, sucursales, tecnicos] = await Promise.all([
    api('GET', '/api/instalaciones'),
    getSucursales(),
    puede('empleados:tecnicos') ? getTecnicos() : Promise.resolve([]),
  ]);
  const s = r.resumen;
  const soyTecnico = state.empleado.rol === 'tecnico';
  return `
  <div class="grid cols-5 mb-2">
    <div class="card kpi primary-tint">
      <span class="kpi-label">Órdenes abiertas</span>
      <span class="kpi-value">${(s.pendiente || 0) + (s.programada || 0) + (s.material_retirado || 0) + (s.en_ruta || 0) + (s.en_progreso || 0)}</span>
      <span class="kpi-sub">${s.pendiente || 0} sin técnico · ${s.programada || 0} programadas · ${(s.material_retirado || 0) + (s.en_ruta || 0)} en camino</span>
    </div>
    <div class="card kpi ${s.sin_entregar > 0 ? 'danger-tint' : 'ok-tint'}">
      <span class="kpi-label">Material por retirar</span>
      <span class="kpi-value">${s.sin_entregar || 0}</span>
      <span class="kpi-sub">${s.sin_entregar > 0 ? 'el técnico aún no retiró la mercadería' : 'todo el material salió del almacén'}</span>
    </div>
    <div class="card kpi warn-tint">
      <span class="kpi-label">En progreso</span>
      <span class="kpi-value">${s.en_progreso || 0}</span>
      <span class="kpi-sub">técnicos en sitio</span>
    </div>
    <div class="card kpi ok-tint">
      <span class="kpi-label">Completadas</span>
      <span class="kpi-value">${s.completada || 0}</span>
      <span class="kpi-sub">de ${s.total} órdenes</span>
    </div>
    <div class="card kpi info-tint">
      <span class="kpi-label">Adelantos de ventas</span>
      <span class="kpi-value">${fmt(s.adelantos)}</span>
      <span class="kpi-sub">entregados por el cliente en el mostrador</span>
    </div>
    <div class="card kpi ${s.saldo_pendiente > 0 ? 'warn-tint' : 'ok-tint'}">
      <span class="kpi-label">Saldo por cobrar</span>
      <span class="kpi-value">${fmt(s.saldo_pendiente)}</span>
      <span class="kpi-sub">lo cobra el técnico al terminar · ${fmt(s.saldos_cobrados)} cobrado</span>
    </div>
    <div class="card kpi ${s.por_entregar > 0 ? 'warn-tint' : 'ok-tint'}">
      <span class="kpi-label">Por entregar en tienda</span>
      <span class="kpi-value">${fmt(s.por_entregar)}</span>
      <span class="kpi-sub">dinero de la tienda en manos del técnico</span>
    </div>
  </div>

  <div class="toolbar">
    <select id="inst-f-estado">
      <option value="">Todos los estados</option>
      ${Object.entries(ESTADO_INST).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}
    </select>
    ${/* El servidor recorta por rol, así que un selector de otra tienda sería
        un filtro que no hace nada: se esconde en vez de dejar sonar. */ soyTecnico || state.empleado.rol === 'asesor' ? `
    <span class="badge badge-info">${soyTecnico ? 'Tus órdenes y las sin técnico' : esc(state.empleado.sucursal_nombre || 'Sin sucursal asignada')}</span>` : `
    <select id="inst-f-sucursal">
      <option value="">Todas las sucursales</option>
      ${sucursales.map((s2) => `<option value="${s2.id}">${esc(s2.nombre)}</option>`).join('')}
    </select>`}
    ${!soyTecnico ? `
    <select id="inst-f-tecnico">
      <option value="">Todos los técnicos</option>
      ${tecnicos.map((t) => `<option value="${t.id}">${esc(t.nombre)}</option>`).join('')}
    </select>` : ''}
    <input class="search" id="inst-f-buscar" placeholder="Buscar por orden, producto o dirección…">
    <button class="btn btn-primary btn-sm" data-act="inst-filtrar">Filtrar</button>
  </div>

  <div class="card">
    <div class="table-wrap">
      <table>
        <thead><tr><th>Orden</th><th>Fecha</th><th>Producto</th><th>Cliente / dirección</th><th>Técnico</th><th>Visita agendada</th><th class="num">Financiado</th><th class="num">Adelanto</th><th class="num">Saldo</th><th>Estado</th><th></th></tr></thead>
        <tbody id="inst-tbody">
          ${instHtml(r.instalaciones)}
        </tbody>
      </table>
    </div>
  </div>`;
}

function instHtml(lista) {
  if (!lista.length) return '<tr><td colspan="11" class="empty">No hay órdenes de instalación</td></tr>';
  return lista.map((i) => {
    const saldo = Number(i.saldo_pendiente ?? ((i.monto_financiado ?? i.costo) - i.adelanto));
    return `
    <tr>
      <td class="mono"><button class="btn btn-sm" data-act="inst-ver" data-id="${i.id}">${esc(i.codigo)}</button>${evidenciaContador(i.evidencias)}</td>
      <td class="table-muted">${fmtDT(i.fecha)}</td>
      <td><b>${esc(i.producto_nombre)}</b><div class="table-muted">${esc(i.producto_codigo || '')} · ${esc(i.sucursal_nombre || '—')}</div></td>
      <td>${esc(i.cliente_nombre || '—')}<div class="table-muted">${esc(i.direccion || '')}</div></td>
      <td>${i.tecnico_nombre ? esc(i.tecnico_nombre) : '<span class="badge badge-warn">Sin asignar</span>'}</td>
      <td class="table-muted">${i.fecha_programada ? `${esc(i.fecha_programada)}<div>${esc(i.hora_programada || 'sin hora')}</div>${instCitaVencida(i) ? '<span class="badge badge-warn">Cita vencida</span>' : ''}` : '<span class="badge badge-warn">Sin agendar</span>'}</td>
      <td class="num mono">${fmt(i.monto_financiado ?? i.costo)}<div class="table-muted">hon. ${fmt(i.costo)}</div></td>
      <td class="num mono">${fmt(i.adelanto)}</td>
      <td class="num mono">${saldo > 0 ? `<b style="color:var(--warn)">${fmt(saldo)}</b><div class="table-muted">${fmt(Number(i.parte_tecnico) || 0)} + ${fmt(Number(i.parte_tienda) || 0)} tienda</div>` : `<span class="badge badge-ok">Pagado</span>`}</td>
      <td>${badgeInstalacion(i.estado)}${materialBadge(i)}</td>
      <td class="text-right">${instAcciones(i)}</td>
    </tr>`;
  }).join('');
}

function instCitaVencida(i) {
  if (!['pendiente', 'programada', 'material_retirado', 'en_ruta', 'en_progreso'].includes(i.estado)
      || !i.fecha_programada || !i.hora_programada) return false;
  const cita = new Date(`${i.fecha_programada}T${i.hora_programada}:00`);
  return Number.isFinite(cita.getTime()) && cita < new Date();
}

/* Los botones de la fila salen de `acciones`, que calcula el servidor según el
   rol y el estado. Antes cada quien veía la misma lista y se enteraba de lo
   que no podía tocar por un 403; ahora el botón y la regla vienen del mismo
   sitio, así que lo que se ve es lo que se puede hacer. */
function instAcciones(i, contexto = 'fila') {
  const a = i.acciones || [];
  const saldo = Number(i.saldo_pendiente) || 0;
  const btn = [];
  /* El técnico ve una sola cosa a la vez: lo que toca hacer ahora. */
  if (contexto === 'fila' && state.empleado.rol === 'tecnico') {
    if (a.includes('entrega')) {
      return `<button class="btn btn-sm btn-primary" data-act="inst-entrega" data-id="${i.id}">Retirar material</button>`;
    }
    if (a.includes('avanzar')) {
      const sig = (i.puede_avanzar || [])[0];
      const txt = sig === 'en_ruta' ? 'Iniciar ruta' : sig === 'completada' ? 'Completar instalación' : 'Comenzar instalación';
      return `<button class="btn btn-sm btn-primary" data-act="inst-avanzar" data-id="${i.id}">${txt}</button>`;
    }
    if (a.includes('cobrar') && saldo > 0) {
      return `<button class="btn btn-sm btn-primary" data-act="inst-cobrar-saldo" data-id="${i.id}">Cobrar saldo</button>`;
    }
    /* Nada que hacer en campo: la fila dice en qué se quedó. */
    if (a.includes('tomar')) {
      return `<button class="btn btn-sm btn-primary" data-act="inst-ver" data-id="${i.id}">Tomar orden</button>`;
    }
  }
  if (a.includes('editar')) btn.push(`<button class="btn btn-sm" data-act="inst-editar" data-id="${i.id}">Editar</button>`);
  /* "Detalles" se ofrece siempre: es la única forma de llegar a la evidencia
     cuando la orden ya está cerrada y no queda ninguna acción pendiente. */
  btn.push(`<button class="btn btn-sm" data-act="inst-ver" data-id="${i.id}">Detalles</button>`);
  if (state.empleado.rol === 'admin' && a.some((x) => ['estado', 'entrega', 'cobrar'].includes(x))) {
    btn.push(`<button class="btn btn-sm btn-primary" data-act="inst-estado" data-id="${i.id}">Estado</button>`);
  }
  return btn.join(' ');
}

/* Aviso de si la mercadería de la orden sigue en el almacén. Las órdenes ya
   cerradas no se marcan: son anteriores al control de material. */
function materialBadge(i) {
  if (!i.items?.length) return '';
  if (['completada', 'cancelada'].includes(i.estado)) return '';
  if (i.pendientes_entrega > 0) {
    return `<div><span class="badge badge-warn">Material sin retirar</span></div>`;
  }
  return `<div><span class="badge badge-ok">Material entregado</span></div>`;
}

async function instFiltrar(mias = false) {
  const params = {
    estado: $('#inst-f-estado')?.value || '',
    sucursal_id: $('#inst-f-sucursal')?.value || '',
    tecnico_id: mias ? state.empleado.id : ($('#inst-f-tecnico')?.value || ''),
    buscar: $('#inst-f-buscar')?.value || '',
  };
  const r = await api('GET', '/api/instalaciones', params);
  const tb = $('#inst-tbody');
  if (tb) tb.innerHTML = instHtml(r.instalaciones);
  if (mias && $('#inst-f-tecnico')) $('#inst-f-tecnico').value = String(state.empleado.id);
}

function instPanelEstado(i) {
  const a = i.acciones || [];
  return `
    <div class="mb-2">${badgeInstalacion(i.estado)}</div>
    ${a.includes('estado') && i.puede_avanzar?.length ? `
      <div class="field"><span>Nuevo estado</span><select id="inst-nuevo-estado">
        <option value="">Selecciona un estado</option>
        ${i.puede_avanzar.map((e) => `<option value="${e}">${esc(ESTADO_INST[e] || e)}</option>`).join('')}
      </select></div>
      <button class="btn btn-primary btn-block mb-2" data-act="inst-estado-guardar" data-id="${i.id}">Confirmar estado</button>` : ''}
    ${a.includes('avanzar') ? (i.puede_avanzar || []).map((e) => `
      <button class="btn btn-primary btn-block mb-2" data-act="inst-set-estado" data-id="${i.id}" data-estado="${e}">${e === 'en_ruta' ? 'Iniciar ruta' : e === 'en_progreso' ? 'Comenzar instalación' : 'Completar instalación'}</button>`).join('') : ''}
    ${a.includes('entrega') ? `<button class="btn btn-block mb-2" data-act="inst-entrega" data-id="${i.id}">Retirar material</button>` : ''}
    ${a.includes('cobrar') ? `<button class="btn btn-block mb-2" data-act="inst-cobrar-saldo" data-id="${i.id}">Cobrar saldo ${fmt(i.saldo_pendiente)}</button>` : ''}
    ${i.pago_estado === 'pagada' ? '<p class="ok">Pagado en su totalidad</p>' : ''}`;
}

async function instEstado(id) {
  const { instalacion: i } = await api('GET', `/api/instalaciones/${id}`);
  openModal({ title: `Estado · ${i.codigo}`, body: instPanelEstado(i),
    footer: '<button class="btn btn-sm" data-act="modal-close">Cerrar</button>' });
}

async function instDetalle(id) {
  const r = await api('GET', `/api/instalaciones/${id}`);
  const i = r.instalacion;
  openModal({
    title: `Orden ${i.codigo}`,
    wide: true,
    body: `
      <div class="grid cols-2-1">
        <div>
          <div class="stat-line"><span>Producto</span><b>${esc(i.producto_nombre)} ${i.cantidad > 1 ? `× ${Number(i.cantidad).toLocaleString('es-ES')}` : ''}</b></div>
          <div class="stat-line"><span>Cliente</span><b>${esc(i.cliente_nombre || '—')}</b></div>
          <div class="stat-line"><span>Dirección</span><b>${esc(i.direccion || '—')}</b></div>
          <div class="stat-line"><span>Contacto</span><b>${esc(i.contacto || '—')}</b></div>
          <div class="stat-line"><span>Técnico</span><b>${esc(i.tecnico_nombre || 'Sin asignar')}</b></div>
          <div class="stat-line"><span>Registró</span><b>${esc(i.asesor_nombre || '—')}</b></div>
          <div class="stat-line"><span>Sucursal</span><b>${esc(i.sucursal_nombre || '—')}</b></div>
          <div class="stat-line"><span>Visita agendada</span><b>${i.fecha_programada ? `${esc(i.fecha_programada)} · ${esc(i.hora_programada || 'sin hora')}` : 'Sin definir'}</b></div>
          <div class="stat-line"><span>Inicio / fin</span><b>${fmtDT(i.fecha_inicio) || '—'} → ${fmtDT(i.fecha_fin) || '—'}</b></div>
          <div class="stat-line"><span>Total financiado</span><b>${fmt(i.monto_financiado ?? i.costo)}</b></div>
          <div class="stat-line"><span>Adelanto recibido</span><b>${fmt(i.adelanto)}</b></div>
          <div class="stat-line"><span>Saldo pendiente</span><b style="${Number(i.saldo_pendiente) > 0 ? 'color:var(--warn)' : ''}">${fmt(i.saldo_pendiente)}</b></div>
          ${Number(i.saldo_pendiente) > 0 ? `
          <div class="stat-line"><span>&nbsp;&nbsp;· Honorarios del técnico</span><b>${fmt(i.parte_tecnico)}</b></div>
          <div class="stat-line"><span>&nbsp;&nbsp;· A entregar en tienda</span><b style="color:var(--warn)">${fmt(i.parte_tienda)}</b></div>` : ''}
          ${i.fecha_pago_saldo ? `<div class="stat-line"><span>Saldo liquidado</span><b>${fmt(i.saldo_pagado)} · ${fmtDT(i.fecha_pago_saldo)}</b></div>` : ''}
          ${i.venta_numero ? `<div class="stat-line"><span>Venta</span><b class="mono">${esc(i.venta_numero)}</b></div>` : ''}
          ${i.notas ? `<div class="mt-2 text-muted" style="font-size:13px">${esc(i.notas)}</div>` : ''}

          <h3 class="mt-3">Cobros en campo</h3>
          ${i.pagos?.length ? i.pagos.map((p) => `
            <div class="list-item">
              <div><b>${fmt(p.monto)}</b><div class="table-muted">${esc(p.destino_nombre || 'Sin destino')}${p.destino_identificador ? ` (${esc(p.destino_identificador)})` : ''}${p.referencia ? ` · Op. ${esc(p.referencia)}` : ''}</div></div>
              <div class="table-muted">${fmtDT(p.fecha)}${p.recibido_por_nombre ? ` · ${esc(p.recibido_por_nombre)}` : ''}</div>
            </div>`).join('')
            : `<div class="table-muted" style="font-size:13px">${Number(i.saldo_pagado) > 0
              ? `Hay ${fmt(i.saldo_pagado)} cobrados antes de este registro, sin detalle de destino.`
              : 'Sin cobros en campo.'}</div>`}

          ${i.items?.length && !['completada', 'cancelada'].includes(i.estado) ? `
          <h3 class="mt-3">Mercadería de la visita</h3>
          <p class="table-muted" style="font-size:13px">
            ${i.pendientes_entrega > 0
              ? 'Lo que el técnico debe retirar del almacén para esta visita.'
              : 'Material ya registrado como entregado.'}
          </p>
          ${i.items.map((it) => `
            <div class="list-item">
              <div><b>${esc(it.nombre)}</b>
                <div class="table-muted">
                  ${it.fecha_entrega
                    ? `Entregado ${fmtDT(it.fecha_entrega)} · ${Number(it.cantidad_entregada)} de ${Number(it.cantidad_prevista)} piezas`
                    : `Pendiente · ${it.modo_retiro === 'caja'
                      ? `${Number(it.cantidad_prevista) / Math.max(1, Number(it.contenido_empaque) || 1)} caja(s) (${Number(it.cantidad_prevista)} piezas)`
                      : `${Number(it.cantidad_prevista)} pieza(s)`}`}
                  ${Number(it.devueltas) > 0 ? ` · ${Number(it.devueltas)} devuelto` : ''}
                </div>
              </div>
              <div>${it.fecha_entrega
                ? (Number(it.faltantes) > 0
                  ? `<span class="badge badge-danger">${Number(it.faltantes)} faltante</span>`
                  : `<span class="badge badge-ok">Completo</span>`)
                : '<span class="badge badge-warn">Sin entregar</span>'}</div>
            </div>`).join('')}
          ` : ''}

          <h3 class="mt-3">Seguimiento</h3>
          ${i.historial.length ? i.historial.map((h) => `
            <div class="list-item">
              <div><b>${esc(ESTADO_INST[h.estado] || h.estado)}</b><div class="table-muted">${fmtDT(h.fecha)} · ${esc(h.empleado_nombre || 'sistema')}</div></div>
            </div>
            ${h.comentario ? `<div class="table-muted" style="padding:0 0 8px">${esc(h.comentario)}</div>` : ''}`).join('')
            : '<div class="empty">Sin movimientos</div>'}
        </div>
        <div>
          <div class="card"><h3>Estado</h3>${instPanelEstado(i)}</div>${evidenciasCard(i.evidencias)}
          ${(i.acciones || []).includes('tomar') ? `
          <div class="card mt-2">
            <h3>Tomar la orden</h3>
            <p class="table-muted">Esta orden aún no tiene técnico. Puedes tomarla tú mismo.</p>
            <button class="btn btn-primary btn-block mt-2" data-act="inst-tomar" data-id="${i.id}">Asignarme</button>
          </div>` : ''}
        </div>
      </div>`,
    footer: `
      ${(i.acciones || []).includes('editar') ? `<button class="btn btn-sm" data-act="inst-editar" data-id="${i.id}">Editar</button>` : ''}
      <button class="btn btn-sm" data-act="inst-print" data-id="${i.id}">Imprimir orden</button>
      <button class="btn btn-primary btn-sm" data-act="modal-close">Cerrar</button>`,
  });
}

/* El saldo de la instalación lo recibe el técnico al terminar el trabajo. */
async function instCobrarSaldo(id) {
  const r = await api('GET', `/api/instalaciones/${id}`);
  const i = r.instalacion;
  const pendiente = Number(i.saldo_pendiente || 0);
  if (pendiente <= 0) { toast('Esta orden no tiene saldo pendiente', 'err'); return; }
  const desglose = `Te quedas ${fmt(i.parte_tecnico)} de honorarios y entregas ${fmt(i.parte_tienda)} en tienda.`;
  const dests = await getDestinos(i.sucursal_id);
  let destHtml = '<select id="inst-cobro-destino" required><option value="">Seleccione destino...</option>' +
    dests.map((d) => `<option value="${d.id}">${esc(d.nombre)}${d.identificador?` (${esc(d.identificador)})`:''}${d.sucursal_nombre?` · ${esc(d.sucursal_nombre)}`:''}</option>`).join('') + '</select>';
  const html = `
    <form id="inst-cobro-form" class="form-grid">
      <p class="table-muted">Cobro en orden ${esc(i.codigo)}. Saldo pendiente: ${fmt(pendiente)}. ${esc(desglose)}</p>
      <label>Monto cobrado</label>
      <input type="number" step="0.01" min="0.01" max="${pendiente}" value="${pendiente}" id="inst-cobro-monto" />
      <label>¿Dónde recibió el pago?</label>
      ${destHtml}
      <label id="inst-cobro-ref-label" style="display:none">N° de operación (Yape/Transferencia)</label>
      <input type="text" id="inst-cobro-referencia" style="display:none" />
    </form>
  `;
  openModal({
    title: 'Cobrar saldo',
    body: html,
    footer: `<button class="btn" data-act="modal-close">Cancelar</button><button class="btn btn-primary" id="inst-cobro-guardar">Cobrar</button>`,
  });
  const f = $('#inst-cobro-form');
  const dsel = $('#inst-cobro-destino');
  const refl = $('#inst-cobro-ref-label');
  const refi = $('#inst-cobro-referencia');
  function toggleRef() {
    const val = dsel.value;
    const dd = dests.find(x=>String(x.id)===String(val));
    const req = dd && (dd.tipo==='yape'||dd.tipo==='transferencia');
    refl.style.display = refi.style.display = req?'':'none';
  }
  dsel.addEventListener('change', toggleRef);
  toggleRef();
  $('#inst-cobro-guardar')?.addEventListener('click', async () => {
    const monto = Number($('#inst-cobro-monto').value)||0;
    const destId = Number(dsel.value)||0;
    const ref = String(refi.value||'').trim();
    if (!destId) { toast('Selecciona el destino de pago','err'); return; }
    const dd = dests.find(x=>String(x.id)===String(destId));
    if (dd && (dd.tipo==='yape'||dd.tipo==='transferencia') && !ref) { toast('Falta el N° de operación','err'); return; }
    if (monto < 0.01 || monto > pendiente+0.0001) { toast('Monto inválido','err'); return; }
    try {
      await api('POST', `/api/instalaciones/${id}/cobro`, { monto, destino_id: destId, referencia: ref });
      toast(`Saldo de ${i.codigo} cobrado`);
      closeTopModal(); render();
    } catch(e){ toast(e.message,'err'); }
  });
}

/* El técnico retira la mercadería con el lector. Antes era un formulario con
   números que había que fillar a mano: se podía dar por buena cualquier
   cantidad. Ahora el campo pide el código de barras y el servidor comprueba que
   el producto sea de esta orden, así que el conteo sale de lo que realmente
   pasó por el escáner y no de lo que alguien escribió. */
async function instRegistrarEntrega(id) {
  const r = await api('GET', `/api/instalaciones/${id}`);
  const i = r.instalacion;
  const pendientes = (i.items || []).filter((it) => !it.fecha_entrega);
  if (!pendientes.length) { toast('La entrega ya está registrada', 'err'); return; }

  /* Se lleva la cuenta de lo escaneado por línea, en piezas. El contador se
     reinicia al abrir el modal para que dos retiros no se suman. Se guardan
     también las líneas pendientes para no consultar la orden en cada escaneo:
     el lector dispara rápido y cada consulta es un viaje al servidor. */
  const sesion = { instId: i.id, porProducto: new Map(), escaneos: [], pendientes, lecturas: 0, guardando: false, modo: 'pza' };
  state.escaneo = sesion;
  const lineas = pendientes.map((it) => lineaEscaneo(it)).join('');

  openModal({
    title: `Retirar material · ${i.codigo}`,
    wide: true,
    body: `
      <p class="table-muted" style="margin-bottom:10px">
        Escanea cada cosa que llevas. El botón se habilita cuando estén todas las líneas completas.
        ${i.reserva_stock ? 'El stock sale del almacén al guardar.' : ''}
      </p>
      <div class="esc-modo">
        <span class="esc-modo-label">Cada escaneo suma:</span>
        <button type="button" class="esc-modo-btn ${sesion.modo === 'pza' ? 'activo' : ''}" data-modo="pza">1 pieza</button>
        <button type="button" class="esc-modo-btn ${sesion.modo === 'caja' ? 'activo' : ''}" data-modo="caja">Caja completa</button>
      </div>
      <div class="escaner">
        <input id="esc-codigo" class="mono" placeholder="Escanea o escribe el código de barras"
               autocomplete="off" autofocus>
        <div id="esc-feedback" class="esc-feedback">&nbsp;</div>
      </div>
      <div id="esc-lineas">${lineas}</div>
      <div class="field mt-2"><span>Observación</span>
        <input id="entrega-comentario" placeholder="Opcional">
      </div>`,
    footer: `<button class="btn btn-sm" data-act="modal-close">Cancelar</button>
             <button class="btn btn-sm btn-primary" id="esc-guardar" data-act="inst-entrega-guardar" data-id="${i.id}" disabled>Guardar y salir a ruta</button>`,
  });
  const inp = $('#esc-codigo');
  if (inp) {
    sesion.input = inp;
    inp.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') { ev.preventDefault(); escanearCodigo(); }
    });
    inp.focus();
  }
  document.querySelectorAll('.esc-modo-btn').forEach((b) => {
    b.addEventListener('click', () => {
      sesion.modo = b.dataset.modo;
      document.querySelectorAll('.esc-modo-btn').forEach((x) => x.classList.toggle('activo', x === b));
      escAviso($('#esc-feedback'), sesion.modo === 'caja'
        ? 'Cada escaneo sumará una caja completa.'
        : 'Cada escaneo sumará una pieza.');
    });
  });
}

function lineaEscaneo(it) {
  const porLectura = it.modo_retiro === 'caja' ? Math.max(1, Number(it.contenido_empaque) || 1) : 1;
  const lecturasPrevistas = Number(it.cantidad_prevista) / porLectura;
  const unidadLectura = it.modo_retiro === 'caja' ? 'caja(s)' : (UNIDAD[it.producto_unidad || 'pza'] || 'pza(s)');
  const esCaja = Math.max(1, Number(it.contenido_empaque) || 1) > 1;
  return `
    <div class="list-item" id="esc-l-${it.id}">
      <div>
        <b>${esc(it.nombre)}</b>
        <div class="table-muted">${esCaja
          ? `${Number(it.cantidad_prevista)} ${esc(UNIDAD[it.producto_unidad || 'pza'] || 'pza')} · caja de ${porLectura} · código ${esc(it.codigo_barras || 'sin código')}`
          : `${Number(it.cantidad_prevista)} ${esc(UNIDAD[it.producto_unidad || 'pza'] || 'pza')} · código ${esc(it.codigo_barras || 'sin código')}`}</div>
      </div>
      <div style="text-align:right">
        <div class="esc-cuenta"><span id="esc-n-${it.id}">0</span> / ${Number(it.cantidad_prevista)} pzas</div>
        <div class="esc-barra"><i id="esc-b-${it.id}" style="width:0%"></i></div>
      </div>
    </div>`;
}

/* Traduce el código que entró en el campo: pregunta al servidor qué producto
   es, y si es de esta orden suma una unidad de stock. */
async function escanearCodigo() {
  const inp = $('#esc-codigo');
  const fb = $('#esc-feedback');
  const sesion = state.escaneo;
  const { porProducto, escaneos, pendientes } = sesion || {};
  if (!inp || !pendientes || sesion.guardando) return;
  const codigo = (inp.value || '').trim();
  if (!codigo) return;
  inp.value = '';
  sesion.lecturas++;
  escRefrescarGuardar();
  const r = await api('GET', `/api/productos/barcode/${encodeURIComponent(codigo)}`).catch(() => null);
  sesion.lecturas--;
  if (state.escaneo !== sesion || !inp.isConnected) return;
  escRefrescarGuardar();
  if (!r || !r.producto) {
    escAviso(fb, `Ningún producto tiene el código ${codigo}`, 'err');
    return;
  }
  const p = r.producto;
  const item = pendientes.find((x) => x.producto_id === p.id);
  if (!item) {
    /* Es el error más común al tomar mercadería: el producto existe pero no
       está en esta orden. Se dice con su nombre, que es como lo busca el
       técnico en el almacén. */
    escAviso(fb, `${p.nombre} no está en esta orden`, 'err');
    return;
  }
  const previo = porProducto.get(p.id) || 0;
  /* El modo lo decide el técnico con el toggle: "caja" suma el contenido
     completo del empaque, "pza" suma una pieza. */
  const contenidoEmpaque = Math.max(1, Number(item.contenido_empaque) || 1);
  const piezasPorLectura = sesion.modo === 'caja' ? contenidoEmpaque : 1;
  const total = previo + piezasPorLectura;
  if (total > Number(item.cantidad_prevista)) {
    escAviso(fb, `Te pasaste de ${p.nombre}: la orden pide ${item.cantidad_prevista} piezas y ya llevas ${previo}`, 'err');
    return;
  }
  porProducto.set(p.id, total);
  escaneos.push({ codigo, modo: sesion.modo });
  const prev = Number(item.cantidad_prevista) || 1;
  const completo = total >= prev;
  const n = document.getElementById(`esc-n-${item.id}`);
  const b = document.getElementById(`esc-b-${item.id}`);
  if (n) n.textContent = String(total);
  if (b) b.style.width = `${Math.min(100, (total / prev) * 100)}%`;
  const linea = document.getElementById(`esc-l-${item.id}`);
  if (linea) linea.classList.toggle('completa', completo);
  const cuenta = sesion.modo === 'caja'
    ? `Caja completa · ${total} de ${prev} piezas`
    : `${total} de ${prev} piezas`;
  escAviso(fb, `${p.nombre} · ${cuenta}`, completo ? 'ok' : '');
  escRefrescarGuardar();
}

function escAviso(el, texto, clase) {
  if (!el) return;
  el.textContent = texto;
  el.className = `esc-feedback ${clase || ''}`;
}

/* El botón de guardar se habilita sólo si no quedó ninguna línea a medias: es
   la primera barrera contra llegar a casa del cliente con algo falta. El
   servidor vuelve a comprobarlo, así que esto es para no perder el viaje. */
function escRefrescarGuardar() {
  const { porProducto, pendientes } = state.escaneo || {};
  const b = $('#esc-guardar');
  if (!b || !pendientes) return;
  const completo = pendientes.every((it) => (porProducto.get(it.producto_id) || 0) >= Number(it.cantidad_prevista));
  b.disabled = !completo || state.escaneo.lecturas > 0 || state.escaneo.guardando;
  if (completo) escAviso($('#esc-feedback'), 'Todo listo. Puedes guardar y salir a ruta.', 'ok');
}

async function guardarEntrega(id) {
  const sesion = state.escaneo;
  if (!sesion || sesion.instId !== Number(id) || sesion.guardando || sesion.lecturas || !sesion.input?.isConnected) return;
  if (!sesion.pendientes.every((it) => sesion.porProducto.get(it.producto_id) === Number(it.cantidad_prevista))) return;
  sesion.guardando = true;
  escRefrescarGuardar();
  const { escaneos, modo } = sesion;
  /* Al servidor van los códigos leídos y nada más. No se le dice "entregué 3
     de este producto": eso es justo lo que hay que comprobar. Que el servidor
     resuelva cada código por su cuenta contra el catálogo y la orden.
     Cada escaneo va con su modo: el técnico puede cambiar de "pieza" a "caja"
     en medio del retiro y cada lectura debe contar según lo que marcó en ese
     momento. */
  const cuerpo = {
    escaneos: escaneos.map((s) => ({ codigo: s.codigo, veces: 1, modo: s.modo })),
    modo_escaneo: modo,
    comentario: $('#entrega-comentario')?.value?.trim() || '',
  };
  try {
    const res = await api('POST', `/api/instalaciones/${id}/entrega`, cuerpo);
    const nueva = res.instalacion;
    if (state.escaneo !== sesion || !sesion.input.isConnected) return;
    state.escaneo = null;
    toast(nueva.estado === 'en_ruta'
      ? `Material de ${nueva.codigo} retirado · la orden está en ruta`
      : `Entrega de ${nueva.codigo} registrada`);
    closeTopModal();
    render();
  } catch (err) { toast(err.message, 'err'); } finally {
    sesion.guardando = false;
    if (state.escaneo === sesion && sesion.input.isConnected) escRefrescarGuardar();
  }
}

async function instCambiarEstado(id, estado) {
  const closing = estado === 'completada';
  let files = [], previews = [], evidenceIds = null;
  const modal = openModal({
    title: closing ? 'Finalizar instalación' : (ESTADO_INST[estado] || estado),
    body: `<div class="field"><span>Comentario (opcional)</span><textarea id="estado-comentario"></textarea></div>
      ${closing ? '<div class="field"><span>Fotos de la instalación terminada (obligatorias)</span><input id="estado-fotos" type="file" accept="image/jpeg,image/png,image/webp" multiple><small>Entre 1 y 5 fotos, hasta 10 MB por foto. Puedes usar la cámara o la galería.</small><button class="btn" type="button" id="estado-camara">Tomar foto</button><input id="estado-captura" type="file" accept="image/*" capture="environment" hidden></div><div id="estado-previews" class="evidence-grid"></div>' : ''}
      <p class="form-error" role="alert"></p>`,
    footer: '<button class="btn" data-act="modal-close">Cancelar</button><button class="btn btn-primary" id="estado-confirmar">Confirmar</button>',
    onClose: () => previews.forEach(URL.revokeObjectURL),
  });
  const error = modal.root.querySelector('.form-error');
  function showFiles(next) {
    files = next; evidenceIds = null;
    previews.forEach(URL.revokeObjectURL); previews = files.map(file => URL.createObjectURL(file));
    modal.root.querySelector('#estado-previews').innerHTML = previews.map((url,i) => `<figure><img src="${url}" alt="Foto ${i+1}"><button type="button" class="btn" data-remove-photo="${i}">Quitar</button></figure>`).join('');
    error.textContent = files.length > 5 ? 'Selecciona como máximo cinco fotos.' : '';
  }
  if (closing) {
    modal.root.querySelector('#estado-fotos').onchange = e => showFiles([...e.target.files]);
    modal.root.querySelector('#estado-camara').onclick = () => modal.root.querySelector('#estado-captura').click();
    modal.root.querySelector('#estado-captura').onchange = e => showFiles([...files,...e.target.files]);
    modal.root.querySelector('#estado-previews').onclick = e => { const b=e.target.closest('[data-remove-photo]');if(b)showFiles(files.filter((_,i)=>i!==Number(b.dataset.removePhoto))); };
  }
  modal.root.querySelector('#estado-confirmar').onclick = async () => {
    const button = modal.root.querySelector('#estado-confirmar');
    if (button.disabled) return;
    if (closing && (!files.length || files.length > 5 || files.some(f => f.size > 10*1024*1024))) { error.textContent = 'Adjunta entre una y cinco fotos, de hasta 10 MB cada una.'; return; }
    button.disabled = true; modal.wrap._busy = true; error.textContent = '';
    modal.root.querySelectorAll('input,textarea,button').forEach(el => el.disabled = true);
    try {
      if (closing && !evidenceIds) {
        const form = new FormData(); files.forEach(f => form.append('fotos', f));
        const response = await fetch(`/api/instalaciones/${id}/evidencias`, {method:'POST',body:form});
        const data = await response.json(); if (!response.ok) throw new Error(data.error || 'No se pudieron guardar las fotos');
        evidenceIds = data.evidencias;
      }
      await api('POST', `/api/instalaciones/${id}/estado`, {estado,comentario:modal.root.querySelector('#estado-comentario').value,evidencias:evidenceIds});
      modal.wrap._busy = false; modal.close(); closeTopModal(); await render();
      toast(closing ? 'Instalación completada con evidencia' : `Orden marcada como ${ESTADO_INST[estado] || estado}`);
      if (closing) {
        const {instalacion} = await api('GET', `/api/instalaciones/${id}`);
        if (Number(instalacion.saldo_pendiente)>0 && await uiConfirm(`¿Registrar ahora el cobro de ${fmt(instalacion.saldo_pendiente)}?`)) await instCobrarSaldo(id);
      }
    } catch (err) { error.textContent = err.message; modal.wrap._busy = false; modal.root.querySelectorAll('input,textarea,button').forEach(el => el.disabled = false); }
  };
}

async function instEditarDatos(id) {
  const [r, tecnicos] = await Promise.all([api('GET', `/api/instalaciones/${id}`), getTecnicos()]);
  const i = r.instalacion;
  openModal({
    title: `Editar · ${i.codigo}`,
    body: `
      <div class="field"><span>Dirección de la visita</span>
        <input id="ed-dir" value="${esc(i.direccion || '')}" placeholder="Av. Siempre Viva 742">
      </div>
      <div class="field"><span>Contacto</span>
        <input id="ed-con" value="${esc(i.contacto || '')}" placeholder="Nombre y teléfono">
      </div>
      <div class="field"><span>Notas para el técnico</span>
        <textarea id="ed-notas" rows="3" placeholder="Cómo entrar, a qué hora, si hay que comprar algo...">${esc(i.notas || '')}</textarea>
      </div>
      <div class="field"><span>Técnico</span><select id="ed-tecnico">
        <option value="">Sin asignar</option>
        ${tecnicos.map((t) => `<option value="${t.id}" ${t.id === i.tecnico_id ? 'selected' : ''}>${esc(t.nombre)} · ${esc(t.sucursal_nombre || 'Sin sucursal')}</option>`).join('')}
      </select></div>
      <div class="form-grid">
        <div class="field"><span>Fecha de visita</span><input id="ed-fecha" type="date" value="${esc(i.fecha_programada || '')}"></div>
        <div class="field"><span>Hora de visita</span><input id="ed-hora" type="time" value="${esc(i.hora_programada || '')}"></div>
      </div>`,
    footer: `<button class="btn btn-sm" data-act="modal-close">Cancelar</button>
             <button class="btn btn-sm btn-primary" data-act="inst-editar-guardar" data-id="${i.id}">Guardar cambios</button>`,
  });
}

async function instEditarDatosGuardar(id) {
  const cuerpo = {
    direccion: $('#ed-dir')?.value?.trim() ?? '',
    contacto: $('#ed-con')?.value?.trim() ?? '',
    notas: $('#ed-notas')?.value?.trim() ?? '',
    tecnico_id: $('#ed-tecnico')?.value ? Number($('#ed-tecnico').value) : null,
    fecha_programada: $('#ed-fecha')?.value ?? '',
    hora_programada: $('#ed-hora')?.value ?? '',
  };
  try {
    await api('PATCH', `/api/instalaciones/${id}`, cuerpo);
    toast('Datos de la orden corregidos');
    closeTopModal();
    render();
  } catch (err) { toast(err.message, 'err'); }
}

function instPrint(id) {
  api('GET', `/api/instalaciones/${id}`).then((r) => {
    const i = r.instalacion;
    printHTML(`
      <h2 style="font-family:sans-serif">Orden de instalación ${esc(i.codigo)}</h2>
      <p style="font-family:sans-serif">${esc(state.config?.nombre_tienda || '')} · ${esc(i.sucursal_nombre || '')}</p>
      <table style="font-family:sans-serif;width:100%;margin-top:10px">
        <tr><td><b>Producto</b></td><td>${esc(i.producto_nombre)} × ${Number(i.cantidad).toLocaleString('es-ES')}</td></tr>
        <tr><td><b>Cliente</b></td><td>${esc(i.cliente_nombre || '')}</td></tr>
        <tr><td><b>Dirección</b></td><td>${esc(i.direccion || '')}</td></tr>
        <tr><td><b>Contacto</b></td><td>${esc(i.contacto || '')}</td></tr>
        <tr><td><b>Técnico</b></td><td>${esc(i.tecnico_nombre || 'Sin asignar')}</td></tr>
        <tr><td><b>Fecha programada</b></td><td>${esc(i.fecha_programada || '')}</td></tr>
        <tr><td><b>Estado</b></td><td>${esc(ESTADO_INST[i.estado] || i.estado)}</td></tr>
        <tr><td><b>Costo</b></td><td>${fmt(i.costo)}</td></tr>
      </table>
      <p style="font-family:sans-serif;margin-top:12px">Firma del cliente: ______________________</p>
      <p style="font-family:sans-serif">Firma del técnico: ______________________</p>`);
  }).catch((er) => toast(er.message, 'err'));
}

/* ---------- Sucursales ---------- */
async function v_sucursales() {
  const r = await api('GET', '/api/sucursales');
  const editable = puede('config:gestionar');
  const mes = hoyMes();
  const tieneAlquiler = r.sucursales.some((s) => s.alquiler_mensual > 0);
  return `
  <div class="page-head">
    <h3>Puntos de operación de la tienda</h3>
    ${editable ? `<button class="btn btn-primary" data-act="suc-new">+ Nueva sucursal</button>` : ''}
  </div>
  ${tieneAlquiler ? await tablaAlquileres(r.sucursales, mes) : ''}
  <div class="card">
    <div class="table-wrap">
      <table>
        <thead><tr><th>Código</th><th>Sucursal</th><th>Dirección</th><th>Teléfono</th><th>Propietario</th><th>Alquiler</th><th>Estado</th><th></th></tr></thead>
        <tbody>
          ${r.sucursales.length ? r.sucursales.map((s) => `
            <tr>
              <td class="mono">${esc(s.codigo)}</td>
              <td><b>${esc(s.nombre)}</b></td>
              <td>${esc(s.direccion || '—')}</td>
              <td>${esc(s.telefono || '—')}</td>
              <td>${esc(s.propietario_nombre || '—')}</td>
              <td>${s.alquiler_mensual ? fmt(s.alquiler_mensual) : '<span class="table-muted">—</span>'}</td>
              <td>${s.activo ? '<span class="badge badge-ok">Activa</span>' : '<span class="badge badge-neutral">Inactiva</span>'}</td>
              <td class="text-right">
                ${editable ? `
                  <button class="btn btn-sm" data-act="suc-edit" data-id="${s.id}">Editar</button>
                  <button class="btn btn-sm btn-danger" data-act="suc-del" data-id="${s.id}">Eliminar</button>
                ` : '<span class="table-muted">—</span>'}
              </td>
            </tr>`).join('')
          : '<tr><td colspan="8" class="empty">Sin sucursales registradas</td></tr>'}
        </tbody>
      </table>
    </div>
  </div>
  <p class="table-muted mt-2">El stock es único para toda la cadena: las sucursales clasifican ventas, empleados y órdenes de instalación, pero el inventario se administra de forma centralizada.</p>`;
}

/* Resumen de alquiler del mes en curso: cuánto se pactó, cuánto se pagó y qué
   falta. Sale del mismo cálculo que usa el reporte, para que el número que ve
   el dueño aquí sea el mismo que ve en Reportes. */
async function tablaAlquileres(sucursales, mes) {
  const r = await api('GET', `/api/gastos?mes=${mes}`);
  const mapa = new Map(r.alquileres.map((a) => [a.mes, a]));
  const filas = await Promise.all(sucursales.filter((s) => s.alquiler_mensual > 0).map(async (s) => {
    const g = (await api('GET', `/api/gastos?mes=${mes}&sucursal_id=${s.id}`));
    const a = g.alquileres[0];
    return { s, a };
  }));
  return `
  <div class="card mb-2">
    <div class="card-head">
      <h4>Alquiler del mes</h4>
      <span class="table-muted">${mesLabel(mes)}</span>
    </div>
    <div class="table-wrap">
      <table>
        <thead><tr><th>Sucursal</th><th>Pactado</th><th>Pagado</th><th>Pendiente</th><th>Vence</th><th>Estado</th><th></th></tr></thead>
        <tbody>
          ${filas.map(({ s, a }) => {
            const pend = a ? a.pendiente : s.alquiler_mensual;
            const pagado = a ? a.pagado : 0;
            const estado = pend > 0.009
              ? '<span class="badge badge-danger">Pendiente</span>'
              : (pagado > s.alquiler_mensual + 0.009
                ? '<span class="badge badge-warn">Pagado de más</span>'
                : '<span class="badge badge-ok">Al día</span>');
            return `
            <tr>
              <td><b>${esc(s.nombre)}</b></td>
              <td>${fmt(s.alquiler_mensual)}</td>
              <td>${fmt(pagado)}</td>
              <td class="${pend > 0.009 ? 'txt-err' : ''}">${pend > 0.009 ? fmt(pend) : '—'}</td>
              <td>${s.dia_alquiler ? `día ${s.dia_alquiler}` : '<span class="table-muted">—</span>'}</td>
              <td>${estado}</td>
              <td class="text-right">
                <button class="btn btn-sm" data-act="goto-gastos" data-suc="${s.id}" data-mes="${mes}">Registrar pago</button>
              </td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
    </div>
  </div>`;
}

async function sucModal(s = {}) {
  openModal({
    title: s.id ? `Editar ${s.nombre}` : 'Nueva sucursal',
    body: `
      <form id="suc-form" class="form-grid">
        <input type="hidden" name="id" value="${s.id || ''}">
        <div class="field"><span>${s.id ? '' : 'Código'}</span><input name="codigo" value="${esc(s.codigo || '')}" placeholder="Auto (S04…)" ${s.id ? 'disabled' : ''}></div>
        <div class="field"><span class="req">Nombre</span><input name="nombre" required value="${esc(s.nombre || '')}" placeholder="Sucursal Este"></div>
        <div class="field full"><span>Dirección</span><input name="direccion" value="${esc(s.direccion || '')}"></div>
        <div class="field"><span>Teléfono</span><input name="telefono" value="${esc(s.telefono || '')}"></div>
        <div class="field full"><span class="form-legend">Dueño del local</span></div>
        <div class="field"><span>Nombre del propietario</span><input name="propietario_nombre" value="${esc(s.propietario_nombre || '')}" placeholder="Nombre y apellido"></div>
        <div class="field"><span>DNI</span><input name="propietario_dni" value="${esc(s.propietario_dni || '')}" placeholder="DNI o RUC"></div>
        <div class="field"><span>Teléfono del propietario</span><input name="propietario_telefono" value="${esc(s.propietario_telefono || '')}"></div>
        <div class="field full"><span class="form-legend">Alquiler</span></div>
        <div class="field"><span>Alquiler mensual</span><input name="alquiler_mensual" type="number" step="0.01" min="0" value="${s.alquiler_mensual || ''}" placeholder="0.00"></div>
        <div class="field"><span>Día de pago</span><input name="dia_alquiler" type="number" min="0" max="31" value="${s.dia_alquiler || ''}" placeholder="1 a 31"></div>
        <div class="field full"><span>Notas</span><textarea name="notas" rows="2" placeholder="Contrato, condiciones, recordatorios…">${esc(s.notas || '')}</textarea></div>
        <div class="field full"><label class="flex" style="font-size:13.5px;font-weight:600"><input type="checkbox" name="activo" ${s.activo === 0 ? '' : 'checked'} style="width:auto"> Sucursal activa</label></div>
      </form>`,
    footer: `<button class="btn btn-sm" data-act="modal-close">Cancelar</button><button class="btn btn-sm btn-primary" data-act="suc-save">Guardar</button>`,
  });
}

async function guardarSucursal() {
  const form = $('#suc-form');
  if (!form) return;
  const fd = new FormData(form);
  const payload = {
    nombre: fd.get('nombre'), direccion: fd.get('direccion'), telefono: fd.get('telefono'),
    propietario_nombre: fd.get('propietario_nombre'),
    propietario_dni: fd.get('propietario_dni'),
    propietario_telefono: fd.get('propietario_telefono'),
    alquiler_mensual: fd.get('alquiler_mensual') || 0,
    dia_alquiler: fd.get('dia_alquiler') || 0,
    notas: fd.get('notas'),
    activo: fd.get('activo') ? 1 : 0,
  };
  if (!fd.get('id')) payload.codigo = fd.get('codigo');
  const id = fd.get('id');
  try {
    if (id) await api('PUT', `/api/sucursales/${id}`, payload);
    else await api('POST', '/api/sucursales', payload);
    invalidarSucursales();
    toast('Sucursal guardada');
    closeTopModal();
    render();
  } catch (err) { toast(err.message, 'err'); }
}

/* ---------- Productos ---------- */
async function v_productos() {
  const [cats, r] = await Promise.all([getCats(), api('GET', '/api/productos')]);
  return `
  <div class="page-head">
    <div class="toolbar" style="margin:0;flex:1">
      <input class="search" id="p-buscar" placeholder="Buscar por nombre o código…">
      <select id="p-cat">
        <option value="">Todas las categorías</option>
        ${cats.map((c) => `<option value="${c.id}">${esc(c.nombre)}</option>`).join('')}
      </select>
      <select id="p-filtro">
        <option value="">Todos</option>
        <option value="bajo">Stock bajo</option>
      </select>
    </div>
    ${puede('productos:editar') ? `<button class="btn" data-act="prod-etiquetas">🖨 Etiquetas</button>` : ''}
    ${puede('productos:ver') ? `<button class="btn" data-act="prod-pdf-todo" title="Baja un PDF con una etiqueta de cada producto que muestra esta lista. Hoja A4 en rejilla de 2 por 5: diez etiquetas de 100 × 50 mm por hoja, sin mandarlo a ninguna impresora">⬇ Exportar etiquetas en PDF</button>` : ''}
    ${puede('productos:editar') ? `<button class="btn btn-primary" data-act="prod-new">+ Nuevo producto</button>` : ''}
  </div>
  <div class="card">
    <div class="table-wrap">
      <table>
        <thead><tr><th>Código</th><th>Producto</th><th>Categoría</th><th class="num">Costo</th><th class="num">Precio</th><th class="num">Stock</th><th class="num">Valor inv.</th><th></th></tr></thead>
        <tbody id="prod-tbody">
          ${r.productos.map(productoFila).join('')}
        </tbody>
      </table>
    </div>
  </div>`;
}

/* Una fila del catálogo. Vive en una función porque el buscador vuelve a
   pintar la tabla y antes llevaba una copia: cuando se añadió el botón de
   historial, la copia se quedó con los dos botones viejos y el buscador
   dejaba de offercerlo. */
function productoFila(p) {
  return `
    <tr data-id="${p.id}">
      <td class="mono">${esc(p.codigo)}</td>
      <td><b>${esc(p.nombre)}</b>
        <div class="table-muted">${esc(p.descripcion || '')}</div>
        ${p.codigo_barras ? `<div class="table-muted mono">Código ${esc(p.codigo_barras)}${Number(p.contenido) > 1 ? ` · ${Number(p.contenido)} pzas por etiqueta` : ''}</div>` : ''}</td>
      <td>${esc(p.categoria_nombre || '—')}</td>
      <td class="num">${fmt(p.costo)}</td>
      <td class="num mono">${fmt(p.precio)}</td>
      <td class="num">${Number(p.stock).toLocaleString('es-ES')} ${UNIDAD[p.unidad] || 'pza'} ${badgeStock(p.stock, p.stock_minimo, p.stock_reservado)}</td>
      <td class="num">${fmt(p.stock * p.costo)}</td>
      <td class="text-right">
        ${puede('productos:editar') ? `<button class="btn btn-sm" data-act="prod-edit" data-id="${p.id}">Editar</button>` : ''}
        ${p.codigo_barras && puede('productos:ver') ? `<button class="btn btn-sm" data-act="prod-pdf" data-id="${p.id}" title="Descargar el PDF de la etiqueta de este producto. Solo baja el archivo: no lo manda a ninguna impresora">⬇ Etiqueta PDF</button>` : ''}
        ${puede('productos:editar') ? `<button class="btn btn-sm btn-danger" data-act="prod-del" data-id="${p.id}">Eliminar</button>` : ''}
        ${puede('inventario:ver') ? `<button class="btn btn-sm" data-act="prod-hist" data-id="${p.id}">Historial</button>` : ''}
      </td>
    </tr>`;
}

function prodForm(p = {}, codigoAuto = '') {
  const esNuevo = !p.id;
  return `
  <form id="prod-form" class="form-grid">
    <input type="hidden" name="id" value="${p.id || ''}">
    <div class="field full"><span>Código</span><input name="codigo" value="${esc(codigoAuto)}" placeholder="Se genera automáticamente" ${esNuevo ? 'readonly title="Se asigna automáticamente"' : ''}></div>
    <div class="field full"><span class="req">Nombre</span><input name="nombre" required value="${esc(p.nombre || '')}" placeholder="Nombre del producto"></div>
    <div class="field full"><span>Descripción</span><textarea name="descripcion" placeholder="Opcional">${esc(p.descripcion || '')}</textarea></div>
    <div class="field"><span>Categoría</span><select name="categoria_id">${prodCats(p.categoria_id)}</select></div>
    <div class="field"><span>Unidad</span><select name="unidad">${Object.entries(UNIDAD).map(([k, v]) => `<option value="${k}" ${(p.unidad || 'pza') === k ? 'selected' : ''}>${v}</option>`).join('')}</select></div>
    <div class="field"><span class="req">Costo</span><input type="number" name="costo" required min="0" step="0.01" value="${Number(p.costo || 0)}"></div>
    <div class="field"><span class="req">Precio venta</span><input type="number" name="precio" required min="0" step="0.01" value="${Number(p.precio || 0)}"></div>
    <div class="field"><span>Stock inicial</span><input type="number" name="stock" min="0" step="1" value="${Number(p.stock ?? 0)}" ${p.id ? 'disabled' : ''}></div>
    <div class="field"><span>Stock mínimo</span><input type="number" name="stock_minimo" min="0" step="1" value="${Number(p.stock_minimo ?? 5)}"></div>
    <div class="field"><span>Unidades por etiqueta</span><input type="number" name="contenido" min="1" step="1" value="${Number(p.contenido ?? 1)}" title="Si vendes en cajas o paquetes, cuántas piezas suma un escaneo. Deja 1 si el producto se maneja de a uno."></div>
    <div class="field"><span>Código de barras</span><input name="codigo_barras" value="${esc(p.codigo_barras || '')}" inputmode="numeric" placeholder="Se genera automáticamente" title="Solo dígitos. Si el proveedor ya trae etiqueta, escribe aquí su código."></div>
    <div class="field full"><label class="flex" style="font-size:13.5px;font-weight:600"><input type="checkbox" name="iva_aplicable" ${p.iva_aplicable === 0 ? '' : 'checked'} style="width:auto"> Aplicar IGV a este producto</label></div>
    ${p.codigo_barras ? `
    <div class="field full">
      <span>Vista previa de la etiqueta</span>
      <div class="etiqueta-preview">${etiquetaSvg(p.codigo_barras, p.nombre, p.unidad, p.contenido)}</div>
    </div>` : ''}
  </form>`;
}
function prodCats(sel) {
  const cats = state._cats || [];
  return `<option value="">Sin categoría</option>` + cats.map((c) => `<option value="${c.id}" ${Number(sel) === c.id ? 'selected' : ''}>${esc(c.nombre)}</option>`).join('');
}

async function openProdModal(p = {}) {
  const esNuevo = !p.id;
  /* El alta pide el código ya generado para que el asesor lo vea y no lo
     escriba; el backend igual lo genera si llega vacío (importaciones, API). */
  let codigo = p.codigo || '';
  if (esNuevo) {
    try { codigo = (await api('GET', '/api/productos/siguiente-codigo')).codigo || ''; } catch (_) { codigo = ''; }
  }
  const m = openModal({
    title: esNuevo ? 'Nuevo producto' : `Editar ${p.nombre}`,
    body: prodForm(p, codigo),
    footer: `<button class="btn btn-sm" data-act="modal-close">Cancelar</button>
             <button class="btn btn-sm btn-primary" data-act="prod-save">Guardar</button>`,
  });
  m.root.dataset.prodId = p.id || '';
}

async function guardarProducto() {
  const form = $('#prod-form');
  if (!form) return;
  const fd = new FormData(form);
  const payload = {
    codigo: fd.get('codigo'), nombre: fd.get('nombre'), descripcion: fd.get('descripcion'),
    categoria_id: fd.get('categoria_id') || null, unidad: fd.get('unidad'),
    costo: fd.get('costo'), precio: fd.get('precio'),
    stock: fd.get('stock') || 0, stock_minimo: fd.get('stock_minimo') || 0,
    contenido: fd.get('contenido') || 1,
    codigo_barras: fd.get('codigo_barras') || '',
    iva_aplicable: fd.get('iva_aplicable') ? 1 : 0,
  };
  const pid = $('input[name="id"]').value;
  try {
    if (pid) await api('PUT', `/api/productos/${pid}`, payload);
    else await api('POST', '/api/productos', payload);
    toast('Producto guardado');
    closeTopModal();
    render();
  } catch (err) { toast(err.message, 'err'); }
}

/* La etiqueta de un solo producto en PDF. Sale con el papel del tamaño de la
   etiqueta (100 × 150 mm) porque el caso de uso es pasarlo a la impresora de
   etiquetas, sin andar recortando una hoja. */
async function descargarEtiquetaProducto(id, boton) {
  const texto = boton.textContent;
  boton.disabled = true;
  boton.textContent = 'Generando…';
  try { toast(`${await descarga(`/api/impresion/etiquetas/${id}/pdf`)} descargado`); }
  catch (e) { toast(e.message, 'err'); }
  finally { boton.disabled = false; boton.textContent = texto; }
}

/* El botón de "todo lo que se ve": una etiqueta por producto de la lista, con
   los filtros que tenga puestos. No reimprime nada ni crea trabajos de impresión,
   solo baja el archivo. Sale en la hoja densa, que reparte la A4 en dos columnas
   por cinco filas de 100 × 50 mm: diez etiquetas por hoja en vez de dos. Cada
   etiqueta conserva su tamaño exacto porque src/labelpdf.js reparte la hoja sin
   escalarlas. */
async function exportarEtiquetasVisibles(boton) {
  const texto = boton.textContent;
  boton.disabled = true;
  boton.textContent = 'Generando…';
  try {
    /* La lista se recarga contra el servidor en cada cambio de filtro, así que
       esta consulta con los mismos filtros devuelve justo lo que hay en pantalla. */
    const r = await api('GET', '/api/productos', {buscar:$('#p-buscar')?.value || undefined,categoria_id:$('#p-cat')?.value || undefined,filtro:$('#p-filtro')?.value || undefined});
    const conCodigo = r.productos.filter(p => p.codigo_barras);
    if (!conCodigo.length) { toast('Ninguno de los productos de la lista tiene código de barras', 'err'); return; }
    if (conCodigo.length > 1000) { toast(`Son ${conCodigo.length} etiquetas y el máximo por PDF es 1000: acorta la lista con el buscador`, 'err'); return; }
    const nombre = await descarga('/api/impresion/etiquetas/pdf', {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({hoja:'a4densa',items:conCodigo.map(p=>({producto_id:p.id,copias:1}))})});
    const sinCodigo = r.productos.length - conCodigo.length;
    toast(sinCodigo ? `${conCodigo.length} etiquetas en ${nombre}. ${sinCodigo} productos sin código quedaron fuera` : `${conCodigo.length} etiquetas en ${nombre}`);
  } catch (e) { toast(e.message, 'err'); }
  finally { boton.disabled = false; boton.textContent = texto; }
}

/* Hoja de etiquetas: se manda a la impresora de la tienda o se baja en PDF.
   Entran los productos que hay en pantalla con los filtros de la lista puestos:
   si el administrador tocó "Stock bajo", sale solo esa hoja. El buscador de acá
   es aparte de esos filtros, solo acorta la lista para no tener que recorrer
   doscientos productos buscando uno, y lo que deja fuera no se imprime ni se
   exporta: en los dos casos sale lo que se ve. */
async function imprimirEtiquetas() {
  const [r, config, formatos] = await Promise.all([
    api('GET', '/api/productos', {buscar:$('#p-buscar')?.value || undefined,categoria_id:$('#p-cat')?.value || undefined,filtro:$('#p-filtro')?.value || undefined}),
    api('GET','/api/impresion/config'),
    /* Los formatos y su cuenta de etiquetas los manda el servidor: si el papel
       cambia, el selector se entera solo y no queda prometiendo dos por hoja. */
    api('GET','/api/impresion/etiquetas/formatos').catch(()=>({formatos:[{clave:'a4densa',nombre:'A4 · 10 etiquetas de 100 × 50 mm',porHoja:10}]})),
  ]);
  const products=r.productos.filter(p=>p.codigo_barras);
  if(!products.length){toast('No hay productos con código en esta búsqueda','err');return;}
  const modal=openModal({title:'Etiquetas · impresora 100 × 150 mm',wide:true,
    body:`<div class="label-panel">
      <div class="field"><span>Impresora</span><select id="label-printer" title="Solo se usa con «Enviar a impresora»">${config.printers.filter(p=>p.activo&&p.agente_activo).map(p=>`<option value="${p.id}">${esc(p.nombre)} · ${esc(p.language)} · ${p.dpi} dpi</option>`).join('')}</select></div>
      <div class="field"><span>Hoja del PDF</span><select id="label-hoja" title="Solo se usa con «Descargar PDF»">${formatos.formatos.map(f=>`<option value="${f.clave}">${esc(f.nombre)}</option>`).join('')}</select></div>
    </div>
      <div class="toolbar label-toolbar">
        <input class="search" id="label-buscar" placeholder="Buscar por nombre, código o código de barras…" aria-label="Buscar producto para su etiqueta">
        <button class="btn" id="label-config">Configurar impresoras</button><button class="btn" id="label-jobs">Ver trabajos</button>
        <button class="btn" id="label-pdf" title="Baja el PDF de las etiquetas que muestra la lista. No crea ningún trabajo de impresión">⬇ Descargar PDF</button>
      </div>
      <p class="label-resumen" id="label-resumen" role="status"></p>
      <p class="muted">Una etiqueta por copia. Escribe 0 para excluir un producto. Máximo 1000 etiquetas por trabajo. La impresora de la tienda usa su papel de 100 × 150 mm; la hoja del PDF es solo para el archivo.</p>
      <div class="table-wrap"><table><thead><tr><th>Producto</th><th>Código</th><th>Copias</th></tr></thead><tbody id="label-tbody">${products.map(p=>`<tr data-busca="${esc(sinAcentos(`${p.nombre} ${p.codigo} ${p.codigo_barras}`))}"><td>${esc(p.nombre)}</td><td class="mono">${esc(p.codigo_barras)}</td><td><input class="label-qty" type="number" min="0" max="1000" step="1" value="1" data-product="${p.id}"></td></tr>`).join('')}<tr id="label-sin-resultado" class="empty" hidden><td colspan="3">Ningún producto coincide con la búsqueda</td></tr></tbody></table></div>
      <p class="muted">Vista previa orientativa; el perfil de la impresora determina el resultado físico.</p><div class="label-preview">${etiquetaSvg(products[0].codigo_barras,products[0].nombre,products[0].unidad,products[0].contenido)}</div><p class="form-error" role="alert"></p>`,
    footer:'<button class="btn" data-act="modal-close">Cerrar</button><button class="btn btn-primary" id="label-send" title="Manda el trabajo a la cola de la impresora elegida; el PDF no pasa por aquí">🖨 Enviar a impresora</button>'});
  let requestKey=crypto.randomUUID();
  const el=sel=>modal.root.querySelector(sel),err=el('.form-error');
  const filas=()=>[...modal.root.querySelectorAll('#label-tbody tr[data-busca]')].filter(f=>!f.hidden);
  /* El contador evita la sorpresa de exportar veinte etiquetas y descubrir
     después que eran doscientas, y dice cuántas hojas de papel salen. */
  const resumen=()=>{const visibles=filas(),total=visibles.reduce((n,f)=>n+Math.max(0,Number($('.label-qty',f)?.value)||0),0);
    const porHoja=formatos.formatos.find(f=>f.clave===el('#label-hoja')?.value)?.porHoja||1;
    const hojas=Math.ceil(total/porHoja);
    el('#label-resumen').textContent=`${visibles.length} producto${visibles.length===1?'':'s'} en la lista · ${total} etiqueta${total===1?'':'s'} para imprimir o descargar`
      +`${hojas>0?` · ${hojas} hoja${hojas===1?'':'s'} de PDF`:''}`;};
  const filtrar=()=>{const q=sinAcentos(el('#label-buscar').value).trim();let visibles=0;
    for(const f of modal.root.querySelectorAll('#label-tbody tr[data-busca]')){const coincide=!q||f.dataset.busca.includes(q);f.hidden=!coincide;if(coincide)visibles++;}
    el('#label-sin-resultado').hidden=visibles>0;resumen();};
  const itemsVisibles=()=>filas().map(f=>{const i=$('.label-qty',f);return {producto_id:Number(i.dataset.product),copias:Number(i.value)};});
  const pideCantidades=items=>items.some(i=>!Number.isInteger(i.copias)||i.copias<0)||!items.some(i=>i.copias>0);
  modal.root.querySelector('#label-config').onclick=()=>printerSettings().catch(e=>toast(e.message,'err'));
  modal.root.querySelector('#label-jobs').onclick=()=>printJobs().catch(e=>toast(e.message,'err'));
  /* El identificador de solicitud solo se renueva cuando cambia el trabajo:
     buscar un producto o cambiar la hoja del PDF no toca lo que se imprime. */
  modal.root.addEventListener('change',e=>{
    if(e.target.classList.contains('label-qty')||e.target.id==='label-printer')requestKey=crypto.randomUUID();
    if(e.target.classList.contains('label-qty')||e.target.id==='label-hoja')resumen();
  });
  el('#label-buscar').addEventListener('input',filtrar);
  modal.root.querySelectorAll('.label-qty').forEach(input=>input.addEventListener('focus',()=>{const p=products.find(p=>p.id===Number(input.dataset.product));modal.root.querySelector('.label-preview').innerHTML=etiquetaSvg(p.codigo_barras,p.nombre,p.unidad,p.contenido);}));
  filtrar();
  el('#label-pdf').onclick=async()=>{
    const b=el('#label-pdf');if(b.disabled)return;err.textContent='';
    const items=itemsVisibles();
    if(pideCantidades(items)){err.textContent='Selecciona cantidades enteras válidas.';return;}
    b.disabled=true;b.textContent='Generando…';
    /* Solo se manda {hoja, items}: ni impresora, ni agente, ni cola. La hoja
       del PDF viaja porque es el papel que se quiere descargar. */
    try{toast(`${await descarga('/api/impresion/etiquetas/pdf',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({hoja:el('#label-hoja').value,items:items.filter(i=>i.copias>0)})})} descargado`);}
    catch(e){err.textContent=e.message;}
    finally{b.disabled=false;b.textContent='⬇ Descargar PDF';}
  };
el('#label-send').onclick=async()=>{
    const b=el('#label-send');if(b.disabled)return;
    err.textContent='';
    const items=itemsVisibles();
    if(pideCantidades(items)){err.textContent='Selecciona cantidades enteras válidas.';return;}
    b.disabled=true;modal.wrap._busy=true;modal.root.querySelectorAll('input,select,button').forEach(el=>el.disabled=true);
    try{await api('POST','/api/impresion/trabajos',{printer_id:Number(el('#label-printer').value),request_key:requestKey,items:items.filter(i=>i.copias>0)});modal.wrap._busy=false;modal.close();await printJobs();}
    catch(e){err.textContent=e.message;modal.wrap._busy=false;modal.root.querySelectorAll('input,select,button').forEach(el=>el.disabled=false);}
  };
}

/* ---------- Categorías ---------- */
async function v_categorias() {
  const r = await api('GET', '/api/categorias');
  return `
  <div class="page-head"><h3>Administra tus categorías</h3><button class="btn btn-primary" data-act="cat-new">+ Nueva categoría</button></div>
  <div class="card">
    <table>
      <thead><tr><th>Nombre</th><th>Descripción</th><th></th></tr></thead>
      <tbody>
        ${r.categorias.map((c) => `
          <tr>
            <td><b>${esc(c.nombre)}</b></td>
            <td class="table-muted">${esc(c.descripcion || '')}</td>
            <td class="text-right">
              <button class="btn btn-sm" data-act="cat-edit" data-id="${c.id}">Editar</button>
              <button class="btn btn-sm btn-danger" data-act="cat-del" data-id="${c.id}">Eliminar</button>
            </td>
          </tr>`).join('')}
      </tbody>
    </table>
  </div>`;
}

async function catModal(c = {}) {
  const m = openModal({
    title: c.id ? 'Editar categoría' : 'Nueva categoría',
    body: `
      <form id="cat-form">
        <input type="hidden" name="id" value="${c.id || ''}">
        <div class="field"><span class="req">Nombre</span><input name="nombre" required value="${esc(c.nombre || '')}"></div>
        <div class="field"><span>Descripción</span><textarea name="descripcion">${esc(c.descripcion || '')}</textarea></div>
      </form>`,
    footer: `<button class="btn btn-sm" data-act="modal-close">Cancelar</button><button class="btn btn-sm btn-primary" data-act="cat-save">Guardar</button>`,
  });
}

async function guardarCategoria() {
  const form = $('#cat-form');
  if (!form) return;
  const fd = new FormData(form);
  const payload = { nombre: fd.get('nombre'), descripcion: fd.get('descripcion') };
  const id = $('input[name="id"]').value;
  try {
    if (id) await api('PUT', `/api/categorias/${id}`, payload);
    else await api('POST', '/api/categorias', payload);
    invalidarCats();
    toast('Categoría guardada');
    closeTopModal();
    render();
  } catch (err) { toast(err.message, 'err'); }
}

async function borrarCategoria(id) {
  try {
    await api('DELETE', `/api/categorias/${id}`);
    invalidarCats();
    toast('Categoría eliminada');
    render();
  } catch (err) { toast(err.message, 'err'); }
}

/* ---------- Inventario ---------- */

/* Un movimiento no guarda la cantidad con signo: `cantidad` es siempre positiva
   y lo que dice si el stock subió o bajó es el tipo. Por eso el signo se saca
   de aquí y no de la cifra, que si no salía "+" en todas las salidas. */
const MOV_ENTRA = { entrada: 1, compra: 1, ajuste: 1 };

/* Historial de un producto: qué entró, qué salió y qué stock quedó después de
   cada movimiento. Es la vista del kardex, para cuando hay que saber por qué un
   producto está como está sin tener que revisar venta por venta. */
async function historialProducto(id) {
  const productoId = Number(id);
  if (!productoId) return;
  const [r, uno] = await Promise.all([
    api('GET', '/api/inventario/movimientos', { producto_id: productoId }),
    api('GET', '/api/productos').catch(() => ({ productos: [] })),
  ]);
  const p = uno.productos.find((x) => x.id === productoId);
  const movs = r.movimientos || [];
  const suma = (s) => movs.filter((m) => Boolean(MOV_ENTRA[m.tipo]) === s)
    .reduce((a, m) => a + Number(m.cantidad), 0);
  const entradas = suma(true);
  const salidas = suma(false);

  openModal({
    title: `Movimientos · ${p ? p.nombre : 'producto'}`,
    wide: true,
    body: `
      <p class="table-muted mb-2">${esc(p?.codigo || '')}${p?.codigo_barras ? ` · código de barras ${esc(p.codigo_barras)}` : ''}
        ${p ? ` · <b>${Number(p.stock).toLocaleString('es-ES')}</b> ${esc(UNIDAD[p.unidad] || 'pza')} en almacén` : ''}</p>
      <div class="grid cols-3 mb-2">
        <div class="card kpi"><span class="kpi-label">Entradas</span><span class="kpi-value ok">+${Number(entradas).toLocaleString('es-ES')}</span></div>
        <div class="card kpi"><span class="kpi-label">Salidas</span><span class="kpi-value" style="color:var(--danger)">-${Number(salidas).toLocaleString('es-ES')}</span></div>
        <div class="card kpi"><span class="kpi-label">Movimientos</span><span class="kpi-value">${movs.length}</span></div>
      </div>
      <div class="table-wrap" style="max-height:52vh;overflow:auto">
        <table>
          <thead><tr><th>Fecha</th><th>Tipo</th><th class="num">Cantidad</th><th class="num">Stock</th><th>Referencia</th><th>Sucursal</th><th>Usuario</th></tr></thead>
          <tbody>
            ${movs.length ? movs.map((m) => {
              const entra = Boolean(MOV_ENTRA[m.tipo]);
              return `<tr>
                <td class="table-muted">${fmtDT(m.fecha)}</td>
                <td><span class="badge badge-${m.tipo === 'venta' ? 'info' : m.tipo === 'salida' ? 'danger' : 'ok'}">${esc(TIPO_MOV[m.tipo] || m.tipo)}</span></td>
                <td class="num mono" style="color:${entra ? 'var(--ok)' : 'var(--danger)'}">${entra ? '+' : '-'}${Number(m.cantidad).toLocaleString('es-ES')}</td>
                <td class="num mono">${Number(m.stock_despues).toLocaleString('es-ES')}</td>
                <td>${esc(m.referencia || '')}${m.notas ? `<div class="table-muted">${esc(m.notas)}</div>` : ''}</td>
                <td class="table-muted">${esc(m.sucursal_nombre || '—')}</td>
                <td class="table-muted">${esc(m.empleado_nombre || '—')}</td>
              </tr>`;
            }).join('') : '<tr><td colspan="7" class="empty">Este producto todavía no tiene movimientos registrados</td></tr>'}
          </tbody>
        </table>
      </div>`,
    footer: '<button class="btn btn-sm btn-primary" data-act="modal-close">Cerrar</button>',
  });
}

async function v_inventario() {
  const [resumen, movs] = await Promise.all([
    api('GET', '/api/inventario/resumen'),
    api('GET', '/api/inventario/movimientos'),
  ]);
  const bajo = await api('GET', '/api/productos', { filtro: 'bajo' });
  const r = resumen.resumen;
  return `
  <div class="grid cols-3 mb-2">
    <div class="card kpi"><span class="kpi-label">Productos activos</span><span class="kpi-value">${r.total}</span><span class="kpi-sub">${Number(r.unidades).toLocaleString('es-ES')} unidades</span></div>
    <div class="card kpi primary-tint"><span class="kpi-label">Valor del inventario</span><span class="kpi-value">${fmt(r.valor_inventario)}</span><span class="kpi-sub">a costo</span></div>
    <div class="card kpi ${(r.unidades_reservadas || 0) > 0 ? 'info-tint' : 'ok-tint'}"><span class="kpi-label">Unidades reservadas</span><span class="kpi-value">${Number(r.unidades_reservadas || 0).toLocaleString('es-ES')}</span><span class="kpi-sub">comprometidas a visitas con instalación</span></div>
    <div class="card kpi ${r.stock_bajo ? 'warn-tint' : 'ok-tint'}"><span class="kpi-label">Productos con stock bajo</span><span class="kpi-value">${r.stock_bajo}</span><span class="kpi-sub">igual o bajo el mínimo disponible</span></div>
  </div>
  ${r.stock_bajo ? `
  <div class="card mb-2">
    <h3>Requieren reposición</h3>
    <div class="table-wrap">
      <table>
        <thead><tr><th>Código</th><th>Producto</th><th class="num">Stock actual</th><th class="num">Mínimo</th><th></th></tr></thead>
        <tbody>${bajo.productos.map((p) => `
          <tr>
            <td class="mono">${esc(p.codigo)}</td>
            <td>${esc(p.nombre)}</td>
            <td class="num">${Number(p.stock).toLocaleString('es-ES')}${(Number(p.stock_reservado)||0) > 0 ? `<div class="table-muted">${Number(p.stock_reservado)} reservado</div>` : ''}</td>
            <td class="num">${Number(p.stock_minimo).toLocaleString('es-ES')}</td>
            <td class="text-right"><button class="btn btn-sm" data-act="prod-compra" data-id="${p.id}">Hacer pedido</button></td>
          </tr>`).join('')}</tbody>
      </table>
    </div>
  </div>` : ''}
  <div class="card mb-2">
    <div class="flex-between mb-2">
      <h3>Movimientos de inventario</h3>
      <div class="flex">
        <select id="m-tipo">
          <option value="">Todos los tipos</option>
          ${Object.entries(TIPO_MOV).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}
        </select>
        <button class="btn btn-primary btn-sm" data-act="inv-ajuste">+ Registrar ajuste</button>
      </div>
    </div>
    <div class="table-wrap">
      <table>
        <thead><tr><th>Fecha</th><th>Producto</th><th>Tipo</th><th class="num">Cantidad</th><th class="num">Stock después</th><th>Referencia</th><th>Sucursal</th><th>Usuario</th></tr></thead>
        <tbody id="mov-tbody">
          ${movs.movimientos.length ? movs.movimientos.map((m) => `
            <tr>
              <td class="table-muted">${fmtDT(m.fecha)}</td>
              <td>${esc(m.producto_nombre || '—')} <span class="table-muted">${esc(m.producto_codigo || '')}</span></td>
              <td><span class="badge badge-${m.tipo === 'venta' ? 'info' : m.tipo === 'entrada' || m.tipo === 'compra' ? 'ok' : m.tipo === 'salida' ? 'danger' : 'neutral'}">${TIPO_MOV[m.tipo] || m.tipo}</span></td>
              <td class="num mono ${m.tipo === 'salida' || m.tipo === 'venta' ? '' : ''}">${m.cantidad >= 0 ? '+' : ''}${Number(m.cantidad).toLocaleString('es-ES')}</td>
              <td class="num">${Number(m.stock_despues).toLocaleString('es-ES')}</td>
              <td class="table-muted">${esc(m.referencia || '')}</td>
              <td class="table-muted">${esc(m.sucursal_nombre || '—')}</td>
              <td class="table-muted">${esc(m.empleado_nombre || '—')}</td>
            </tr>`).join('')
          : '<tr><td colspan="8" class="empty">Sin movimientos registrados</td></tr>'}
        </tbody>
      </table>
    </div>
  </div>`;
}

async function movTbody() {
  const tipo = $('#m-tipo')?.value || '';
  const r = await api('GET', '/api/inventario/movimientos', { tipo });
  const tb = $('#mov-tbody');
  if (!tb) return;
  tb.innerHTML = r.movimientos.length ? r.movimientos.map((m) => `
      <tr>
        <td class="table-muted">${fmtDT(m.fecha)}</td>
        <td>${esc(m.producto_nombre || '—')}</td>
        <td><span class="badge badge-neutral">${TIPO_MOV[m.tipo] || m.tipo}</span></td>
        <td class="num mono">${m.cantidad >= 0 ? '+' : ''}${Number(m.cantidad).toLocaleString('es-ES')}</td>
        <td class="num">${Number(m.stock_despues).toLocaleString('es-ES')}</td>
        <td class="table-muted">${esc(m.referencia || '')}</td>
        <td class="table-muted">${esc(m.sucursal_nombre || '—')}</td>
        <td class="table-muted">${esc(m.empleado_nombre || '—')}</td>
      </tr>`).join('')
    : '<tr><td colspan="8" class="empty">Sin movimientos</td></tr>';
}

async function ajusteModal() {
  const prods = await api('GET', '/api/productos');
  const m = openModal({
    title: 'Registrar ajuste de inventario',
    body: `
      <div class="field"><span class="req">Producto</span><select id="aj-producto">
        <option value="">Seleccione…</option>
        ${prods.productos.map((p) => `<option value="${p.id}">${esc(p.nombre)} · ${disponible(p).toLocaleString('es-ES')} disponibles${(Number(p.stock_reservado)||0) > 0 ? ` (${p.stock_reservado} reservado)` : ''}</option>`).join('')}
      </select></div>
      <div class="field"><span class="req">Tipo</span><select id="aj-tipo">
        <option value="entrada">Entrada (ingreso manual)</option>
        <option value="salida">Salida (merma / pérdida)</option>
      </select></div>
      <div class="field"><span class="req">Cantidad</span><input type="number" id="aj-cant" min="0" step="1" value="1"></div>
      <div class="field"><span>Notas</span><textarea id="aj-notas" placeholder="Motivo del ajuste"></textarea></div>`,
    footer: `<button class="btn btn-sm" data-act="modal-close">Cancelar</button><button class="btn btn-sm btn-primary" data-act="aj-save">Guardar</button>`,
  });
}

async function guardarAjuste() {
  const pid = $('#aj-producto').value;
  const tipo = $('#aj-tipo').value;
  const cant = Number($('#aj-cant').value);
  const notas = $('#aj-notas').value;
  if (!pid) { toast('Selecciona un producto', 'err'); return; }
  if (!cant || cant <= 0) { toast('Cantidad inválida', 'err'); return; }
  try {
    await api('POST', '/api/inventario/ajuste', { producto_id: pid, tipo, cantidad: cant, notas });
    toast('Ajuste registrado');
    closeTopModal();
    render();
  } catch (err) { toast(err.message, 'err'); }
}

/* ---------- Compras ---------- */
async function v_compras() {
  const r = await api('GET', '/api/compras');
  return `
  <div class="page-head">
    <h3>Gestiona pedidos a proveedores</h3>
    <div class="flex">
      <select id="c-estado">
        <option value="todas">Todos</option>
        <option value="pendiente">Pendientes</option>
        <option value="recibida">Recibidas</option>
        <option value="cancelada">Canceladas</option>
      </select>
      <button class="btn btn-primary" data-act="comp-new">+ Nueva compra</button>
    </div>
  </div>
  <div class="card">
    <table>
      <thead><tr><th>N°</th><th>Fecha</th><th>Proveedor</th><th>Usuario</th><th>Art.</th><th class="num">Subtotal</th><th class="num">Total</th><th>Estado</th><th></th></tr></thead>
      <tbody id="comp-tbody">
        ${r.compras.length ? r.compras.map((c) => `
          <tr>
            <td class="mono">${esc(c.numero)}</td>
            <td class="table-muted">${fmtDT(c.fecha)}</td>
            <td>${esc(c.proveedor_nombre || '—')}</td>
            <td>${esc(c.empleado_nombre || '—')}</td>
            <td class="num">${c.n_items}</td>
            <td class="num">${fmt(c.subtotal)}</td>
            <td class="num mono">${fmt(c.total)}</td>
            <td>${badgeEstado(c.estado)}</td>
            <td class="text-right">
              <button class="btn btn-sm" data-act="comp-ver" data-id="${c.id}">Ver</button>
              ${c.estado === 'pendiente' ? `
                <button class="btn btn-sm btn-ok" data-act="comp-recibir" data-id="${c.id}">Recibir</button>
                <button class="btn btn-sm btn-danger" data-act="comp-cancel" data-id="${c.id}">Cancelar</button>` : ''}
            </td>
          </tr>`).join('')
        : '<tr><td colspan="9" class="empty">Sin órdenes de compra</td></tr>'}
      </tbody>
    </table>
  </div>`;
}

async function compTbody() {
  const est = $('#c-estado')?.value || 'todas';
  const r = await api('GET', '/api/compras', { estado: est });
  const tb = $('#comp-tbody');
  if (!tb) return;
  tb.innerHTML = r.compras.map((c) => `
      <tr>
        <td class="mono">${esc(c.numero)}</td>
        <td class="table-muted">${fmtDT(c.fecha)}</td>
        <td>${esc(c.proveedor_nombre || '—')}</td>
        <td>${esc(c.empleado_nombre || '—')}</td>
        <td class="num">${c.n_items}</td>
        <td class="num">${fmt(c.subtotal)}</td>
        <td class="num mono">${fmt(c.total)}</td>
        <td>${badgeEstado(c.estado)}</td>
        <td class="text-right">
          <button class="btn btn-sm" data-act="comp-ver" data-id="${c.id}">Ver</button>
          ${c.estado === 'pendiente' ? `
            <button class="btn btn-sm btn-ok" data-act="comp-recibir" data-id="${c.id}">Recibir</button>
            <button class="btn btn-sm btn-danger" data-act="comp-cancel" data-id="${c.id}">Cancelar</button>` : ''}
        </td>
      </tr>`).join('');
}

let compLines = [];

async function compraModal() {
  compLines = [];
  const [prods, provs] = await Promise.all([api('GET', '/api/productos'), api('GET', '/api/proveedores')]);
  const igv = Number(state.config?.iva) || 16;
  const m = openModal({
    title: 'Nueva orden de compra',
    wide: true,
    body: `
      <div class="field"><span class="req">Proveedor</span>
        <select id="comp-proveedor"><option value="">Seleccione…</option>
          ${provs.proveedores.map((p) => `<option value="${p.id}">${esc(p.nombre)}</option>`).join('')}
        </select>
      </div>
      <div class="input-group mb-2">
        <select id="comp-add-prod">
          <option value="">Agregar producto…</option>
          ${prods.productos.map((p) => `<option value="${p.id}">${esc(p.nombre)} (${esc(p.codigo)})</option>`).join('')}
        </select>
        <input type="number" id="comp-add-cant" min="1" step="1" value="1" style="max-width:90px">
        <button class="btn btn-sm btn-ok" data-act="comp-add-line">+ Agregar</button>
      </div>
      <div class="table-wrap mb-2">
        <table id="comp-lineas">
          <thead><tr><th>Producto</th><th class="num">Cantidad</th><th class="num">Costo</th><th class="num">Subtotal</th><th></th></tr></thead>
          <tbody></tbody>
        </table>
      </div>
      <div class="flex-between">
        <div>IGV (${igv}%)</div><div id="comp-totales"></div>
      </div>
      <div class="field mt-2"><span>Notas</span><textarea id="comp-notas"></textarea></div>`,
    footer: `<button class="btn btn-sm" data-act="modal-close">Cancelar</button><button class="btn btn-sm btn-primary" data-act="comp-save">Guardar compra</button>`,
  });
  m.root.dataset.compProds = JSON.stringify(prods.productos);
  renderCompLines();
}

/* Una línea de la orden de compra. Igual que en el carrito, `cant` son piezas
   y `costo` es el costo por pieza: son los valores que se guardan. El interruptor
   solo cambia lo que se teclea, y en modo caja el campo Costo pasa a ser el
   precio de la bolsa o la caja entera, que es como lo cotiza el proveedor. */
function lineaCompra(l, i) {
  const c = Math.max(1, Number(l.cont) || 1);
  const enCajas = l.modo === 'caja' && c > 1;
  const cajas = Math.max(1, Math.round(l.cant / c));
  const cantEscrita = enCajas ? cajas : l.cant;
  const precioCaja = round2(l.costoCaja ?? l.costo * c);
  const costoEscrito = enCajas ? precioCaja : l.costo;
  /* El subtotal sale del precio de la caja, no de multiplicar el costo por
     pieza redondeado: así el total de la orden cuadra con la factura aunque la
     caja no se divida exacta. */
  const sub = enCajas ? round2(cajas * precioCaja) : round2(l.cant * l.costo);
  const pz = esc(UNIDAD[l.unidad] || 'pza');
  const paq = esc(nombrePaquete(l));
  return `<tr>
        <td>${esc(l.nombre)}${c > 1 ? `<div class="table-muted">se compra en ${paq} de ${c} ${pz}</div>` : ''}
          ${enCajas ? `<div class="linea-nota">= ${fmt(l.cant)} ${pz} a ${fmt(l.costo)} c/u</div>` : ''}</td>
        <td class="num">${c > 1 ? `<span class="modo-cantidad">
            <button type="button" class="modo-btn ${enCajas ? '' : 'on'}" data-act="comp-line-modo" data-modo="pza" data-idx="${i}">${pz}</button>
            <button type="button" class="modo-btn ${enCajas ? 'on' : ''}" data-act="comp-line-modo" data-modo="caja" data-idx="${i}">${paq}</button>
          </span>` : ''}
          <input class="qty-input" data-act="comp-line-cant" data-idx="${i}" value="${cantEscrita}" aria-label="Cantidad"></td>
        <td class="num"><input style="width:110px" type="number" min="0" step="0.01" data-act="comp-line-cost" data-idx="${i}" value="${costoEscrito}" aria-label="${enCajas ? `Precio de la ${nombrePaquete(l)}` : 'Costo por unidad'}"></td>
        <td class="num mono">${fmt(sub)}</td>
        <td class="text-right"><button class="icon-btn" data-act="comp-line-del" data-idx="${i}" style="color:var(--danger)" aria-label="Quitar">✕</button></td>
      </tr>`;
}

/* Subtotal de la línea con la misma cuenta que se ve en pantalla. */
function subtotalCompra(l) {
  const c = Math.max(1, Number(l.cont) || 1);
  if (l.modo === 'caja' && c > 1) {
    const cajas = Math.max(1, Math.round(l.cant / c));
    return round2(cajas * round2(l.costoCaja ?? l.costo * c));
  }
  return round2(l.cant * l.costo);
}

function renderCompLines() {
  const tb = $('#comp-lineas tbody');
  if (!tb) return;
  tb.innerHTML = compLines.map((l, i) => lineaCompra(l, i)).join('') ||
    '<tr><td colspan="5" class="empty">Agrega productos a la orden</td></tr>';
  const igv = Number(state.config?.iva) || 16;
  const sub = round2(compLines.reduce((a, l) => a + subtotalCompra(l), 0));
  const t = round2(sub + sub * (igv / 100));
  $('#comp-totales').innerHTML = `<div class="text-right"><div class="stat-line"><span>Subtotal</span><b>${fmt(sub)}</b></div><div class="stat-line"><span>IGV ${igv}%</span><b>${fmt(sub * igv / 100)}</b></div><div class="stat-line"><span><b>Total</b></span><b style="font-size:16px">${fmt(t)}</b></div></div>`;
}
async function guardarCompra() {
  const prov = $('#comp-proveedor').value;
  if (!prov) { toast('Selecciona un proveedor', 'err'); return; }
  if (!compLines.length) { toast('Agrega al menos un producto', 'err'); return; }
  try {
    await api('POST', '/api/compras', {
      proveedor_id: prov,
      /* Siempre se mandan piezas y costo por pieza. En modo caja se manda
         además el precio de la bolsa para que el total de la orden cuadre con
         lo que facturó el proveedor aunque la división no sea exacta. */
      items: compLines.map((l) => {
        const c = Math.max(1, Number(l.cont) || 1);
        const enCajas = l.modo === 'caja' && c > 1;
        return {
          producto_id: l.id,
          cantidad: l.cant,
          costo: l.costo,
          ...(enCajas ? { cajas: Math.max(1, Math.round(l.cant / c)), costo_caja: l.costoCaja ?? round2(l.costo * c) } : {}),
        };
      }),
      notas: $('#comp-notas')?.value || '',
    });
    toast('Orden de compra creada');
    closeTopModal();
    render();
  } catch (err) { toast(err.message, 'err'); }
}

async function compraDetalle(id, recibir = false) {
  if (recibir) { recepcionModal(id); return; }
  const r = await api('GET', `/api/compras/${id}`);
  const c = r.compra;
  const recibida = c.estado === 'recibida';
  openModal({
    title: `Compra ${c.numero}`,
    wide: true,
    body: `
      <div class="grid cols-2-1">
        <div class="table-wrap">
          <table>
            <thead><tr><th>Producto</th><th class="num">Cantidad</th>${recibida ? '<th class="num">Recibido</th><th class="num">Diferencia</th>' : ''}<th class="num">Costo</th><th class="num">Subtotal</th></tr></thead>
            <tbody>
              ${c.items.map((i) => {
                const dif = Number(i.cantidad_recibida) - Number(i.cantidad);
                return `<tr><td>${esc(i.nombre)}</td>
                  <td class="num">${Number(i.cantidad).toLocaleString('es-ES')}</td>
                  ${recibida ? `<td class="num">${Number(i.cantidad_recibida).toLocaleString('es-ES')}</td>
                    <td class="num ${dif !== 0 ? (dif < 0 ? 'txt-falta' : 'txt-sobra') : 'table-muted'}">${dif === 0 ? '—' : (dif > 0 ? '+' : '') + Number(dif).toLocaleString('es-ES')}</td>` : ''}
                  <td class="num">${fmt(i.costo)}</td><td class="num mono">${fmt(i.subtotal)}</td></tr>`;
              }).join('')}
            </tbody>
          </table>
        </div>
        <div>
          <div class="stat-line"><span>Proveedor</span><b>${esc(c.proveedor_nombre || '—')}</b></div>
          <div class="stat-line"><span>Fecha</span><b>${fmtDT(c.fecha)}</b></div>
          <div class="stat-line"><span>Estado</span>${badgeEstado(c.estado)}</div>
          <div class="stat-line"><span>Subtotal</span><b>${fmt(c.subtotal)}</b></div>
          <div class="stat-line"><span>IGV</span><b>${fmt(c.impuestos)}</b></div>
          <div class="stat-line"><span>Total</span><b style="font-size:16px">${fmt(c.total)}</b></div>
        </div>
      </div>`,
    footer: `<button class="btn btn-sm" data-act="modal-close">Cerrar</button>`,
  });
}

/* ---------- Recepción con lector de códigos ---------- */
/* Pantalla de conteo: se escanea cada caja y la pantalla lleva la cuenta. Un
   escaneo suma el contenido del producto, así que una caja de 12 con contenido
   12 suma 12 al stock. Al final se ve qué línea quedó corta o sobrante antes de
   confirmar. */
async function recepcionModal(id) {
  const r = await api('GET', `/api/compras/${id}`);
  const c = r.compra;
  if (c.estado !== 'pendiente') { toast('Esta compra ya fue recibida', 'err'); return; }

  /* La línea ya viene con el código de barras y el contenido del producto; la
     línea sola guarda el nombre, que es una foto del momento de pedir la orden.
     Si el producto ya no existe, se cuenta a mano con los botones. */
  const enriched = c.items.map((it) => ({
    ...it,
    contenido: Number(it.contenido) || 1,
    codigo_barras: it.codigo_barras || '',
  }));

  const modal = openModal({
    title: `Recibir ${c.numero}`,
    wide: true,
    body: `
      <p class="muted" style="margin-top:0">Escanea el código de cada caja. Si no usas lector, escribe el código y pulsa Enter.</p>
      <div class="recepcion">
        <label class="field recepcion-lector">
          <span>Código escaneado</span>
          <input id="rec-codigo" inputmode="numeric" autocomplete="off" placeholder="Escanea o escribe el código…">
        </label>
        <div id="rec-msg" class="recepcion-msg" role="status" aria-live="polite"></div>
        <div class="table-wrap recepcion-tabla">
          <table>
            <thead><tr><th>Producto</th><th class="num">Pedido</th><th class="num">Escaneos</th><th class="num">Entra</th><th class="num">Diferencia</th></tr></thead>
            <tbody id="rec-tbody">
              ${enriched.map((it) => filaRecepcion(it)).join('')}
            </tbody>
          </table>
        </div>
        <div class="recepcion-resumen" id="rec-resumen"></div>
      </div>`,
    footer: `<button class="btn btn-sm" data-act="modal-close">Cancelar</button>
             <button class="btn btn-sm btn-primary" data-act="rec-confirmar" data-id="${id}">Confirmar recepción</button>`,
  });
  const raiz = modal.root;
  raiz.dataset.compraId = id;

  const tabla = $('#rec-tbody', raiz);
  const campo = $('#rec-codigo', raiz);
  const mensaje = $('#rec-msg', raiz);
  const resumen = $('#rec-resumen', raiz);
  const porId = new Map(enriched.map((it) => [it.id, it]));
  const filaDe = (idItem) => $(`tr[data-item="${idItem}"]`, tabla);

  /* El contenido multiplica los escaneos: una caja de 12 con contenido 12
     suma 12 al stock por cada lectura. */
  const entraDe = (fila) => {
    const it = porId.get(Number(fila.dataset.item));
    if (!it) return { pedido: 0, entra: 0, cont: 1 };
    return {
      pedido: Number(it.cantidad),
      entra: Number(fila.dataset.escaneos || 0) * (Number(it.contenido) || 1),
      cont: Number(it.contenido) || 1,
    };
  };

  const refrescar = () => {
    let conFalta = 0;
    let conSobra = 0;
    for (const fila of tabla.rows) {
      const it = porId.get(Number(fila.dataset.item));
      if (!it) continue;
      const { pedido, entra, cont } = entraDe(fila);
      const dif = Math.round((entra - pedido) * 100) / 100;
      $('[data-campo="escaneos"]', fila).textContent = String(Number(fila.dataset.escaneos || 0));
      $('[data-campo="entra"]', fila).textContent = Number(entra).toLocaleString('es-ES');
      const celda = $('[data-campo="diferencia"]', fila);
      celda.textContent = dif === 0
        ? 'completo'
        : `${dif > 0 ? '+' : ''}${Number(dif).toLocaleString('es-ES')}${cont > 1 ? ` ${UNIDAD[it.unidad] || 'pza'}` : ''}`;
      celda.className = `num ${dif === 0 ? 'txt-ok' : dif < 0 ? 'txt-falta' : 'txt-sobra'}`;
      if (dif < 0) conFalta++;
      else if (dif > 0) conSobra++;
    }
    resumen.innerHTML = conFalta || conSobra
      ? `<div class="recepcion-aviso">${conFalta ? `${conFalta} línea(s) incompleta(s)` : ''}${conFalta && conSobra ? ' · ' : ''}${conSobra ? `${conSobra} con sobrante` : ''}. Confirma solo si el faltante es real.</div>`
      : '<div class="recepcion-ok">Todo lo pedido está completo.</div>';
  };

  /* Avisa sin sacar el foco del campo: el lector puede traer otro escaneo
     seguido y romper el conteo si el foco se pierde entre códigos. */
  const avisar = (texto, tono = 'ok') => {
    mensaje.innerHTML = texto ? `<div class="recepcion-msg-${tono}">${esc(texto)}</div>` : '';
  };

  const sumar = (idItem, delta) => {
    const fila = filaDe(idItem);
    if (!fila) return;
    fila.dataset.escaneos = String(Math.max(0, Number(fila.dataset.escaneos || 0) + delta));
    refrescar();
  };

  const procesarCodigo = (crudo) => {
    const codigo = String(crudo || '').replace(/\D/g, '');
    if (!codigo) { avisar('No se leyó ningún código.', 'err'); return; }
    const it = enriched.find((x) => x.codigo_barras === codigo);
    if (!it) {
      avisar(`El código ${codigo} no está en esta compra. Revisa que sea la caja correcta.`, 'err');
      return;
    }
    sumar(it.id, 1);
    const cont = Number(it.contenido) || 1;
    avisar(cont > 1
      ? `+1 caja de ${it.nombre} (${cont} ${UNIDAD[it.unidad] || 'pza'})`
      : `+1 ${it.nombre}`);
  };

  campo.addEventListener('keydown', (ev) => {
    if (ev.key !== 'Enter') return;
    ev.preventDefault();
    const valor = campo.value;
    campo.value = '';
    procesarCodigo(valor);
  });

  /* Los botones de + y - son el respaldo cuando el lector no sirve. */
  raiz.addEventListener('click', (ev) => {
    const btn = ev.target.closest('[data-rec-acc]');
    if (!btn) return;
    ev.preventDefault();
    sumar(Number(btn.closest('tr').dataset.item), Number(btn.dataset.recAcc));
    campo.focus();
  });

  refrescar();
  campo.focus();
}

/* Una fila de la tabla de conteo. Los botones corrigen a mano si el lector
   falla; el número legible siempre es el que va impreso en la etiqueta. */
function filaRecepcion(it) {
  const pedido = Number(it.cantidad);
  const cont = Number(it.contenido) || 1;
  const codigo = it.codigo_barras
    ? `<div class="table-muted mono">${esc(it.codigo_barras)}${cont > 1 ? ` · ${cont} pzas por caja` : ''}</div>`
    : '<div class="table-muted">Sin código: usa los botones</div>';
  return `<tr data-item="${it.id}" data-escaneos="0">
    <td><b>${esc(it.nombre)}</b>${codigo}</td>
    <td class="num">${pedido.toLocaleString('es-ES')}</td>
    <td class="num">
      <div class="contador">
        <button class="btn btn-sm" data-rec-acc="-1" type="button" aria-label="Quitar un caja">−</button>
        <b data-campo="escaneos">0</b>
        <button class="btn btn-sm" data-rec-acc="1" type="button" aria-label="Sumar un caja">+</button>
      </div>
    </td>
    <td class="num" data-campo="entra">0</td>
    <td class="num" data-campo="diferencia">—</td>
  </tr>`;
}

async function confirmarRecepcion(id) {
  const modal = $('#modal-root .modal');
  const cuerpo = $('#rec-tbody', modal);
  if (!cuerpo) { toast('La ventana de recepción ya no está abierta', 'err'); return; }
  const recibido = [...cuerpo.rows].map((fila) => ({
    item: Number(fila.dataset.item),
    escaneos: Number(fila.dataset.escaneos || 0),
  }));
  const hayCero = recibido.some((x) => x.escaneos === 0);
  if (hayCero && !(await uiConfirm('Hay líneas sin escanear. ¿Confirmar de todos modos? Lo que no escanees no contará como recibido.'))) return;
  try {
    const res = await api('POST', `/api/compras/${id}/recibir`, { recibido });
    const dif = res.diferencias || [];
    if (!dif.length) toast('Compra recibida y stock actualizado');
    else {
      const txt = dif.map((d) => `${d.nombre}: ${d.pedido} pedidos, ${d.recibido} recibidos`).join(' · ');
      toast(`Recibida con diferencias — ${txt}`, 'err');
    }
    closeTopModal();
    render();
  } catch (err) { toast(err.message, 'err'); }
}

/* ---------- Proveedores ---------- */
async function v_proveedores() {
  const r = await api('GET', '/api/proveedores');
  return `
  <div class="page-head"><h3>Catálogo de proveedores</h3><button class="btn btn-primary" data-act="prov-new">+ Nuevo proveedor</button></div>
  <div class="card">
    <table>
      <thead><tr><th>Nombre</th><th>Contacto</th><th>Documento</th><th>Teléfono</th><th>Email</th><th></th></tr></thead>
      <tbody>
        ${r.proveedores.map((p) => `
          <tr>
            <td><b>${esc(p.nombre)}</b></td>
            <td>${esc(p.contacto || '—')}</td>
            <td class="mono">${esc(p.documento || '—')}</td>
            <td>${esc(p.telefono || '—')}</td>
            <td>${esc(p.email || '—')}</td>
            <td class="text-right">
              <button class="btn btn-sm" data-act="prov-edit" data-id="${p.id}">Editar</button>
              <button class="btn btn-sm btn-danger" data-act="prov-del" data-id="${p.id}">Eliminar</button>
            </td>
          </tr>`).join('')}
      </tbody>
    </table>
  </div>`;
}

async function provModal(p = {}) {
  openModal({
    title: p.id ? 'Editar proveedor' : 'Nuevo proveedor',
    body: `
      <form id="prov-form" class="form-grid">
        <input type="hidden" name="id" value="${p.id || ''}">
        <div class="field full"><span class="req">Nombre / Razón social</span><input name="nombre" required value="${esc(p.nombre || '')}"></div>
        <div class="field"><span>Contacto</span><input name="contacto" value="${esc(p.contacto || '')}"></div>
        <div class="field"><span>Documento (NIT/RUC)</span><input name="documento" value="${esc(p.documento || '')}"></div>
        <div class="field"><span>Teléfono</span><input name="telefono" value="${esc(p.telefono || '')}"></div>
        <div class="field"><span>Email</span><input type="email" name="email" value="${esc(p.email || '')}"></div>
        <div class="field full"><span>Dirección</span><input name="direccion" value="${esc(p.direccion || '')}"></div>
      </form>`,
    footer: `<button class="btn btn-sm" data-act="modal-close">Cancelar</button><button class="btn btn-sm btn-primary" data-act="prov-save">Guardar</button>`,
  });
}

async function guardarProveedor() {
  const form = $('#prov-form');
  if (!form) return;
  const fd = new FormData(form);
  const payload = Object.fromEntries(fd.entries());
  const id = $('input[name="id"]').value;
  try {
    if (id) await api('PUT', `/api/proveedores/${id}`, payload);
    else await api('POST', '/api/proveedores', payload);
    toast('Proveedor guardado');
    closeTopModal();
    render();
  } catch (err) { toast(err.message, 'err'); }
}

/* ---------- Clientes ---------- */
async function v_clientes() {
  const r = await api('GET', '/api/clientes');
  return `
  <div class="page-head">
    <div class="toolbar" style="margin:0;flex:1">
      <input class="search" id="cli-buscar" placeholder="Buscar por nombre, documento o código…">
    </div>
    <button class="btn btn-primary" data-act="cli-new">+ Nuevo cliente</button>
  </div>
  <div class="card">
    <table>
      <thead><tr><th>Código</th><th>Nombre</th><th>Documento</th><th>Teléfono</th><th class="num">Compras</th><th class="num">Total comprado</th><th>Activo</th><th></th></tr></thead>
      <tbody id="cli-tbody">
        ${clientesHtml(r.clientes)}
      </tbody>
    </table>
  </div>`;
}
function clientesHtml(clientes) {
  return (clientes.length ? clientes.map((c) => `
      <tr>
        <td class="mono">${esc(c.codigo)}</td>
        <td><b>${esc(c.nombre)}</b></td>
        <td>${esc(c.documento || '—')}</td>
        <td>${esc(c.telefono || '—')}</td>
        <td class="num">${c.total_compras}</td>
        <td class="num mono">${fmt(c.total_comprado)}</td>
        <td>${c.activo ? '<span class="badge badge-ok">Activo</span>' : '<span class="badge badge-neutral">Inactivo</span>'}</td>
        <td class="text-right">
          <button class="btn btn-sm" data-act="cli-ver" data-id="${c.id}">Historial</button>
          <button class="btn btn-sm" data-act="cli-edit" data-id="${c.id}">Editar</button>
          ${c.activo ? `<button class="btn btn-sm btn-danger" data-act="cli-del" data-id="${c.id}">Dar de baja</button>` : ''}
        </td>
      </tr>`).join('')
  : '<tr><td colspan="8" class="empty">Sin clientes registrados</td></tr>');
}

async function cliModal(c = {}) {
  openModal({
    title: c.id ? `Editar ${c.nombre}` : 'Nuevo cliente',
    body: `
      <form id="cli-form" class="form-grid">
        <input type="hidden" name="id" value="${c.id || ''}">
        <div class="field full"><span class="req">Nombre</span><input name="nombre" required value="${esc(c.nombre || '')}"></div>
        <div class="field"><span>Código</span><input name="codigo" value="${esc(c.codigo || '')}" placeholder="Auto (C05, C06…)"></div>
        <div class="field"><span>Documento (NIT/CI)</span><input name="documento" value="${esc(c.documento || '')}"></div>
        <div class="field"><span>Teléfono</span><input name="telefono" value="${esc(c.telefono || '')}"></div>
        <div class="field"><span>Email</span><input type="email" name="email" value="${esc(c.email || '')}"></div>
        <div class="field full"><span>Dirección</span><input name="direccion" value="${esc(c.direccion || '')}"></div>
      </form>`,
    footer: `<button class="btn btn-sm" data-act="modal-close">Cancelar</button><button class="btn btn-sm btn-primary" data-act="cli-save">Guardar</button>`,
  });
}

async function guardarCliente() {
  const form = $('#cli-form');
  if (!form) return;
  const fd = new FormData(form);
  const payload = Object.fromEntries(fd.entries());
  const id = $('input[name="id"]').value;
  try {
    if (id) await api('PUT', `/api/clientes/${id}`, payload);
    else await api('POST', '/api/clientes', payload);
    toast('Cliente guardado');
    closeTopModal();
    render();
  } catch (err) { toast(err.message, 'err'); }
}

async function cliHistorial(id) {
  const r = await api('GET', `/api/clientes`);
  /* El id viene de data-id, o sea como texto: sin Number() el === no encuentra
     al cliente y el modal se cierra sin avisar nada. */
  const clienteId = Number(id);
  const c = r.clientes.find((x) => x.id === clienteId);
  if (!c) { toast('No se encontró el cliente', 'err'); return; }
  const ventas = await api('GET', '/api/ventas', { desde: haceNDias(365), hasta: hoy() });
  /* El mismo Number() aplica al filtro: la API devuelve cliente_id numérico y
     compararlo con el texto del botón dejaba la tabla siempre vacía aunque la
     ficha dijera que el cliente tiene compras. */
  const suyas = ventas.ventas.filter((v) => v.cliente_id === clienteId && v.estado === 'completada');
  openModal({
    title: `Historial de ${c.nombre}`,
    wide: true,
    body: `
      <div class="grid cols-4 mb-2">
        <div class="card kpi"><span class="kpi-label">Compras</span><span class="kpi-value">${c.total_compras}</span></div>
        <div class="card kpi"><span class="kpi-label">Total</span><span class="kpi-value">${fmt(c.total_comprado)}</span></div>
        <div class="card kpi"><span class="kpi-label">Última</span><span class="kpi-value" style="font-size:18px">${suyas.length ? fmtDT(suyas[0].fecha) : '—'}</span></div>
        <div class="card kpi"><span class="kpi-label">Documento</span><span class="kpi-value" style="font-size:18px">${esc(c.documento || '—')}</span></div>
      </div>
      <div class="table-wrap">
        <table>
          <thead><tr><th>N°</th><th>Fecha</th><th>Pago</th><th class="num">Total</th></tr></thead>
          <tbody>
            ${suyas.length ? suyas.map((v) => `<tr><td class="mono">${esc(v.numero)}</td><td>${fmtDT(v.fecha)}</td><td>${METODO[v.metodo_pago] || v.metodo_pago}</td><td class="num mono">${fmt(v.total)}</td></tr>`).join('') : '<tr><td colspan="4" class="empty">Sin compras registradas</td></tr>'}
          </tbody>
        </table>
      </div>`,
    footer: '<button class="btn btn-sm btn-primary" data-act="modal-close">Cerrar</button>',
  });
}

/* ---------- Empleados ---------- */
const ROL_BADGE = { admin: 'danger', asesor: 'info', tecnico: 'warn' };

async function v_empleados() {
  const [r, sucursales] = await Promise.all([api('GET', '/api/empleados'), getSucursales()]);
  return `
  <div class="page-head"><h3>Equipo de trabajo</h3><button class="btn btn-primary" data-act="emp-new">+ Nuevo empleado</button></div>
  <div class="card">
    <div class="table-wrap">
      <table>
        <thead><tr><th>Nombre</th><th>Usuario</th><th>Rol</th><th>Sucursal</th><th>Teléfono</th><th>Estado</th><th></th></tr></thead>
        <tbody>
          ${r.empleados.map((e) => `
            <tr>
              <td><b>${esc(e.nombre)}</b></td>
              <td class="mono">${esc(e.usuario)}</td>
              <td><span class="badge badge-${ROL_BADGE[e.rol] || 'neutral'}">${ROLES[e.rol] || e.rol}</span></td>
              <td class="table-muted">${esc(e.sucursal_nombre || '—')}</td>
              <td>${esc(e.telefono || '—')}</td>
              <td>${e.activo ? '<span class="badge badge-ok">Activo</span>' : '<span class="badge badge-neutral">Inactivo</span>'}</td>
              <td class="text-right">
                <button class="btn btn-sm" data-act="emp-edit" data-id="${e.id}">Editar</button>
                ${e.activo && e.id !== state.empleado.id ? `<button class="btn btn-sm btn-danger" data-act="emp-del" data-id="${e.id}">Desactivar</button>` : ''}
              </td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>
  </div>
  <div class="card mt-2">
    <h3>Permisos por rol</h3>
    <div class="table-wrap">
      <table>
        <thead><tr><th>Módulo</th><th>Administrador</th><th>Asesor de ventas</th><th>Técnico</th></tr></thead>
        <tbody>
          ${[
            ['Dashboard', 1, 1, 1],
            ['Punto de venta', 1, 1, 0],
            ['Ventas', 1, 'Propias', 0],
            ['Anular ventas', 1, 0, 0],
            ['Productos', 1, 'Consulta', 'Consulta'],
            ['Categorías', 1, 0, 0],
            ['Inventario y ajustes', 1, 0, 0],
            ['Compras y proveedores', 1, 0, 0],
            ['Clientes', 1, 1, 0],
            ['Instalaciones', 1, 'Ver, crear y editar en su sucursal', 'Asignadas y disponibles'],
            ['Sucursales', 1, 'Consulta', 'Consulta'],
            ['Empleados y configuración', 1, 0, 0],
          ].map(([mod, a, as, t]) => `
            <tr><td>${mod}</td>${[a, as, t].map((v) => `<td>${v === 1 ? 'Sí' : v === 0 ? 'No' : `<span class="badge badge-neutral">${esc(v)}</span>`}</td>`).join('')}</tr>`).join('')}
        </tbody>
      </table>
    </div>
  </div>`;
}

async function empModal(e = {}) {
  const sucursales = await getSucursales();
  openModal({
    title: e.id ? `Editar ${e.nombre}` : 'Nuevo empleado',
    body: `
      <form id="emp-form" class="form-grid">
        <input type="hidden" name="id" value="${e.id || ''}">
        <div class="field full"><span class="req">Nombre y apellido</span><input name="nombre" required value="${esc(e.nombre || '')}"></div>
        <div class="field"><span class="req">Usuario</span><input name="usuario" required value="${esc(e.usuario || '')}"></div>
        <div class="field"><span class="req">Rol</span><select name="rol" id="emp-rol">
          ${Object.entries(ROLES).map(([k, v]) => `<option value="${k}" ${e.rol === k ? 'selected' : ''}>${v}</option>`).join('')}
        </select></div>
        <div class="field"><span class="req">Sucursal</span><select name="sucursal_id" id="emp-sucursal">
          ${sucursales.map((s) => `<option value="${s.id}" ${Number(e.sucursal_id) === s.id ? 'selected' : ''}>${esc(s.nombre)}</option>`).join('')}
        </select></div>
        <div class="field"><span>Teléfono</span><input name="telefono" value="${esc(e.telefono || '')}"></div>
        <div class="field full"><span class="${e.id ? '' : 'req'}">Contraseña${e.id ? ' (dejar vacía para no cambiar)' : ''}</span><input type="password" name="clave" ${e.id ? '' : 'required'} placeholder="Mínimo 4 caracteres"></div>
        <div class="field full" id="emp-activo-field" ${e.id ? '' : 'hidden'}>
          <label class="flex" style="font-size:13.5px;font-weight:600"><input type="checkbox" name="activo" ${e.activo === 0 ? '' : 'checked'} style="width:auto"> Empleado activo</label>
        </div>
      </form>`,
    footer: `<button class="btn btn-sm" data-act="modal-close">Cancelar</button><button class="btn btn-sm btn-primary" data-act="emp-save">Guardar</button>`,
  });
}

async function guardarEmpleado() {
  const form = $('#emp-form');
  if (!form) return;
  const fd = new FormData(form);
  const payload = {
    nombre: fd.get('nombre'), usuario: fd.get('usuario'), rol: fd.get('rol'),
    sucursal_id: fd.get('sucursal_id') ? Number(fd.get('sucursal_id')) : null,
    telefono: fd.get('telefono'),
  };
  if (fd.get('activo') !== null) payload.activo = fd.get('activo') ? 1 : 0;
  const clave = fd.get('clave');
  if (clave) payload.clave = clave;
  const id = $('input[name="id"]').value;
  try {
    if (id) await api('PUT', `/api/empleados/${id}`, payload);
    else await api('POST', '/api/empleados', payload);
    invalidarTecnicos();
    toast('Empleado guardado');
    closeTopModal();
    render();
  } catch (err) { toast(err.message, 'err'); }
}

/* ---------- Gastos de sucursal ---------- */
async function v_gastos() {
  const sucursales = await getSucursales();
  const editable = puede('gastos:gestionar');
  const mes = hoyMes();
  const r = await api('GET', '/api/gastos', { mes });
  const hayAlquiler = r.alquileres.length > 0;

  return `
  <div class="page-head">
    <h3>Gastos de las sucursales</h3>
    ${editable ? `<button class="btn btn-primary" data-act="gas-new">+ Registrar gasto</button>` : ''}
  </div>

  <div class="toolbar">
    <select id="g-mes" data-act="gas-filtrar">
      ${mesesRango(13).map((m) => `<option value="${m}" ${m === mes ? 'selected' : ''}>${mesLabel(m)}</option>`).join('')}
    </select>
    ${state.empleado.rol === 'asesor' ? `<span class="badge badge-info">${esc(state.empleado.sucursal_nombre || 'Sin sucursal asignada')}</span>` : `
    <select id="g-suc" data-act="gas-filtrar">
      <option value="">Todas las sucursales</option>
      ${sucursales.map((s) => `<option value="${s.id}">${esc(s.nombre)}</option>`).join('')}
    </select>`}
    <select id="g-cat" data-act="gas-filtrar">
      <option value="">Todas las categorías</option>
      ${r.categorias.map((c) => `<option value="${c}">${esc(categoriaLabel(c))}</option>`).join('')}
    </select>
  </div>

  <div class="grid cols-3 mb-2">
    <div class="card kpi warn-tint">
      <span class="kpi-label">Total del mes</span>
      <span class="kpi-value">${fmt(r.resumen.total)}</span>
      <span class="kpi-sub">${r.resumen.n} registro(s) · ${mesLabel(mes)}</span>
    </div>
    ${hayAlquiler ? `
    <div class="card kpi ${r.alquileres.some((a) => a.pendiente > 0.009) ? 'danger-tint' : 'ok-tint'}">
      <span class="kpi-label">Alquiler pendiente</span>
      <span class="kpi-value">${fmt(r.alquileres.reduce((a, b) => a + Math.max(0, b.pendiente), 0))}</span>
      <span class="kpi-sub">de ${fmt(r.alquileres.reduce((a, b) => a + b.pactado, 0))} pactados</span>
    </div>` : ''}
    ${hayAlquiler ? `
    <div class="card kpi ${r.alquileres.some((a) => a.pendiente > 0.009) ? 'warn-tint' : 'ok-tint'}">
      <span class="kpi-label">Tiendas al día</span>
      <span class="kpi-value">${r.alquileres.filter((a) => a.pendiente <= 0.009).length}/${r.alquileres.length}</span>
      <span class="kpi-sub">con el alquiler pagado</span>
    </div>` : ''}
  </div>

  ${hayAlquiler ? `
  <div class="card mb-2">
    <div class="card-head"><h4>Alquiler pactado por tienda</h4></div>
    <div class="table-wrap">
      <table>
        <thead><tr><th>Sucursal</th><th class="num">Pactado</th><th class="num">Pagado</th><th class="num">Pendiente</th><th>Vence</th><th>Estado</th><th></th></tr></thead>
        <tbody id="g-alq-tbody">
          ${await filasAlquiler(r.alquileres, editable)}
        </tbody>
      </table>
    </div>
  </div>` : ''}

  <div class="grid cols-2 mt-2">
    <div class="card">
      <h3>Por categoría</h3>
      <div id="g-cat-bars"></div>
    </div>
    <div class="card">
      <h3>Detalle de gastos</h3>
      <div class="table-wrap" style="max-height:420px;overflow:auto">
        <table>
          <thead><tr><th>Fecha</th><th>Sucursal</th><th>Categoría</th><th>Concepto</th><th class="num">Monto</th><th></th></tr></thead>
          <tbody id="g-tbody">
            ${filasGastos(r.gastos, editable)}
          </tbody>
        </table>
      </div>
    </div>
  </div>`;
}

function filasAlquiler(alquileres, editable) {
  if (!alquileres.length) return '<tr><td colspan="7" class="empty">Ninguna sucursal tiene alquiler pactado</td></tr>';
  return alquileres.map((a) => {
    const pend = a.pendiente;
    return `
    <tr>
      <td><b>${esc(a.sucursal_nombre || '—')}</b></td>
      <td class="num mono">${fmt(a.pactado)}</td>
      <td class="num mono">${fmt(a.pagado)}</td>
      <td class="num mono ${pend > 0.009 ? 'txt-err' : ''}">${pend > 0.009 ? fmt(pend) : '—'}</td>
      <td>${a.dia ? `día ${a.dia}` : '—'}</td>
      <td>${pend > 0.009 ? '<span class="badge badge-danger">Pendiente</span>' : '<span class="badge badge-ok">Al día</span>'}</td>
      <td class="text-right">${editable && pend > 0.009 ? `<button class="btn btn-sm" data-act="gas-pagar" data-mes="${a.mes}">Registrar pago</button>` : ''}</td>
    </tr>`;
  }).join('');
}

function filasGastos(gastos, editable) {
  if (!gastos.length) return '<tr><td colspan="6" class="empty">Sin gastos registrados en este periodo</td></tr>';
  return gastos.map((g) => `
    <tr>
      <td class="mono">${esc(g.fecha)}</td>
      <td>${esc(g.sucursal_nombre || '—')}</td>
      <td><span class="badge badge-neutral">${esc(categoriaLabel(g.categoria))}</span></td>
      <td>${esc(g.concepto || '—')}<span class="table-muted">${g.proveedor ? ` · ${esc(g.proveedor)}` : ''}</span></td>
      <td class="num mono">${fmt(g.monto)}</td>
      <td class="text-right">
        ${editable ? `
          <button class="btn btn-sm" data-act="gas-edit" data-id="${g.id}">Editar</button>
          <button class="btn btn-sm btn-danger" data-act="gas-del" data-id="${g.id}">Eliminar</button>
        ` : '<span class="table-muted">—</span>'}
      </td>
    </tr>`).join('');
}

const CATEGORIAS_GASTO = ['alquiler', 'luz', 'agua', 'internet', 'telefono', 'mantenimiento', 'transporte', 'publicidad', 'impuestos', 'otros'];

function categoriaLabel(c) {
  const i = CATEGORIAS_GASTO.indexOf(c);
  return i >= 0 ? c[0].toUpperCase() + c.slice(1) : c;
}

/* Los últimos N meses, del más nuevo al más viejo, para el selector. */
function mesesRango(n) {
  const out = [];
  const d = new Date();
  d.setDate(1);
  for (let i = 0; i < n; i++) {
    out.push(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
    d.setMonth(d.getMonth() - 1);
  }
  return out;
}

async function gasModal(g = {}) {
  const sucursales = await getSucursales();
  const editable = puede('gastos:gestionar');
  const mesSugerido = g.mes_cobro || (state.gastosMes || hoyMes());
  openModal({
    title: g.id ? 'Editar gasto' : 'Registrar gasto',
    body: `
      <form id="gas-form" class="form-grid">
        <input type="hidden" name="id" value="${g.id || ''}">
        <div class="field"><span class="req">Sucursal</span>
          <select name="sucursal_id" required>
            ${sucursales.map((s) => `<option value="${s.id}" ${Number(g.sucursal_id) === s.id ? 'selected' : ''}>${esc(s.nombre)}</option>`).join('')}
          </select>
        </div>
        <div class="field"><span class="req">Categoría</span>
          <select name="categoria" required>
            ${CATEGORIAS_GASTO.map((c) => `<option value="${c}" ${g.categoria === c ? 'selected' : ''}>${categoriaLabel(c)}</option>`).join('')}
          </select>
        </div>
        <div class="field"><span class="req">Monto</span><input name="monto" type="number" step="0.01" min="0.01" required value="${g.monto != null ? g.monto : ''}"></div>
        <div class="field"><span>Fecha del pago</span><input name="fecha" type="date" value="${g.fecha || hoy()}">
          <small class="table-muted">Cuándo salió la plata.</small>
        </div>
        <div class="field"><span>Mes al que se carga</span>
          <select name="mes_cobro">
            ${mesesRango(13).map((m) => `<option value="${m}" ${m === mesSugerido ? 'selected' : ''}>${mesLabel(m)}</option>`).join('')}
          </select>
          <small class="table-muted">Pagar el alquiler el 5 no lo convierte en gasto de ese mes.</small>
        </div>
        <div class="field"><span>Proveedor</span><input name="proveedor" value="${esc(g.proveedor || '')}" placeholder="Opcional"></div>
        <div class="field"><span>Concepto</span><input name="concepto" value="${esc(g.concepto || '')}" placeholder="Factura de luz de setiembre"></div>
        <div class="field"><span>Documento</span><input name="documento" value="${esc(g.documento || '')}" placeholder="N.° de recibo o factura"></div>
        <div class="field full"><span>Notas</span><input name="notas" value="${esc(g.notas || '')}"></div>
      </form>`,
    footer: `<button class="btn btn-sm" data-act="modal-close">Cancelar</button>
             ${editable ? `<button class="btn btn-sm btn-primary" data-act="gas-save">Guardar</button>` : ''}`,
  });
}

/* Registra un pago de alquiler con los datos ya conocidos de la tienda, para no
   volver a escribirlos: el dueño solo confirma el monto. */
async function pagarAlquiler(mes, sucursalId) {
  const sucursales = await getSucursales();
  const r = await api('GET', `/api/gastos?mes=${mes}${sucursalId ? `&sucursal_id=${sucursalId}` : ''}`);
  const a = r.alquileres.find((x) => x && Number(sucursalId) === x.sucursal_id) || r.alquileres[0];
  const sucursal = sucursales.find((s) => Number(sucursalId) === s.id) || (a ? sucursales.find((s) => s.id === a.sucursal_id) : null);
  if (!a || !sucursal) return;
  const sugerido = round2(Math.max(0, a.pendiente));
  openModal({
    title: `Pagar alquiler · ${sucursal.nombre}`,
    body: `
      <form id="gas-form" class="form-grid">
        <input type="hidden" name="id" value="">
        <input type="hidden" name="sucursal_id" value="${sucursal.id}">
        <input type="hidden" name="categoria" value="alquiler">
        <input type="hidden" name="concepto" value="Alquiler ${mesLabel(mes)}">
        <input type="hidden" name="mes_cobro" value="${mes}">
        <input type="hidden" name="fecha" value="${hoy()}">
        <div class="field"><span>Pactado</span><input value="${fmt(a.pactado)}" disabled></div>
        <div class="field"><span class="req">Monto a pagar</span><input name="monto" type="number" step="0.01" min="0.01" required value="${sugerido}"></div>
        <div class="field"><span>Fecha del pago</span><input name="fecha_pago" type="date" value="${hoy()}"></div>
        <div class="field"><span>Proveedor</span><input name="proveedor" value="${esc(sucursal.propietario_nombre || '')}"></div>
        <div class="field full"><span>Documento</span><input name="documento" placeholder="N.° de recibo"></div>
      </form>`,
    footer: `<button class="btn btn-sm" data-act="modal-close">Cancelar</button><button class="btn btn-sm btn-primary" data-act="gas-save">Registrar pago</button>`,
  });
}

async function guardarGasto() {
  const form = $('#gas-form');
  if (!form) return;
  const fd = new FormData(form);
  const id = fd.get('id');
  /* El modal de pago rápido esconde la fecha real para que el valor por defecto
     sea el de hoy, pero el usuario puede corregirla en el campo visible. */
  const fecha = fd.get('fecha_pago') || fd.get('fecha') || hoy();
  const payload = {
    sucursal_id: Number(fd.get('sucursal_id')),
    categoria: fd.get('categoria'),
    concepto: fd.get('concepto'),
    proveedor: fd.get('proveedor'),
    monto: fd.get('monto'),
    fecha,
    mes_cobro: fd.get('mes_cobro') || fecha.slice(0, 7),
    documento: fd.get('documento'),
    notas: fd.get('notas'),
  };
  try {
    if (id) await api('PUT', `/api/gastos/${id}`, payload);
    else await api('POST', '/api/gastos', payload);
    toast(id ? 'Gasto actualizado' : 'Gasto registrado');
    closeTopModal();
    render();
  } catch (er) { toast(er.message, 'err'); }
}

async function cargarGastos() {
  const mes = $('#g-mes')?.value || state.gastosMes || hoyMes();
  const sucursal = $('#g-suc')?.value || '';
  const cat = $('#g-cat')?.value || '';
  state.gastosMes = mes;
  const q = { mes };
  if (sucursal) q.sucursal_id = sucursal;
  if (cat) q.categoria = cat;
  const r = await api('GET', '/api/gastos', q);
  const editable = puede('gastos:gestionar');

  const tb = $('#g-tbody'); if (tb) tb.innerHTML = filasGastos(r.gastos, editable);
  const bars = $('#g-cat-bars');
  if (bars) {
    const max = Math.max(...r.porCategoria.map((c) => c.total), 1);
    bars.innerHTML = r.porCategoria.length ? r.porCategoria.map((c) => `
      <div class="mb-2">
        <div class="flex-between"><span><b>${esc(categoriaLabel(c.categoria))}</b> <span class="table-muted">${c.n}</span></span><b>${fmt(c.total)}</b></div>
        <div style="background:#eef2f6;border-radius:6px;height:12px;margin-top:4px;overflow:hidden">
          <div style="width:${Math.round(c.total / max * 100)}%;height:100%;background:linear-gradient(90deg,#f59e0b,#ea580c);border-radius:6px"></div>
        </div>
      </div>`).join('') : '<div class="empty">Sin gastos en este periodo</div>';
  }
  const cab = $('#g-alq-tbody');
  if (cab) cab.innerHTML = filasAlquiler(r.alquileres, editable);
}

/* ---------- Reportes ---------- */
async function v_reportes() {
  const desde = haceNDias(29), hasta = hoy();
  const [rep, prod, cats, sucursales, empleados] = await Promise.all([
    api('GET', '/api/reportes/ventas', { desde, hasta }),
    api('GET', '/api/reportes/productos', { desde, hasta }),
    getCats(), getSucursales(), puede('config:gestionar') ? api('GET', '/api/empleados') : Promise.resolve({ empleados: [] }),
  ]);
  state.repFiltros = { desde, hasta, granularidad: 'dia', sucursal_id: '', categoria_id: '', producto_id: '', metodo_pago: '', estado: 'completada' };
  state.repData = { rep, prod };

  const f = state.repFiltros;
  return `
  <div class="toolbar">
    <input type="date" id="r-desde" value="${desde}">
    <input type="date" id="r-hasta" value="${hasta}">
    ${state.empleado.rol === 'asesor' ? `<span class="badge badge-info">${esc(state.empleado.sucursal_nombre || 'Sin sucursal asignada')}</span>` : `
    <select id="r-suc">
      <option value="">Todas las sucursales</option>
      ${sucursales.map((s) => `<option value="${s.id}">${esc(s.nombre)}</option>`).join('')}
    </select>`}
    <select id="r-cat">
      <option value="">Todas las categorías</option>
      ${cats.map((c) => `<option value="${c.id}">${esc(c.nombre)}</option>`).join('')}
    </select>
    ${puede('config:gestionar') ? `
    <select id="r-emp">
      <option value="">Todos los vendedores</option>
      ${(empleados.empleados || []).map((e) => `<option value="${e.id}">${esc(e.nombre)}</option>`).join('')}
    </select>` : ''}
    <select id="r-metodo">
      <option value="">Todos los métodos</option>
      ${Object.entries(METODO).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join('')}
    </select>
    <select id="r-estado">
      <option value="completada">Solo completadas</option>
      <option value="anulada">Solo anuladas</option>
      <option value="todas">Todas</option>
    </select>
  </div>
  <div class="toolbar">
    <div class="seg" id="r-gran">
      <button class="seg-btn active" data-act="rep-gran" data-v="dia">Día</button>
      <button class="seg-btn" data-act="rep-gran" data-v="semana">Semana</button>
      <button class="seg-btn" data-act="rep-gran" data-v="mes">Mes</button>
    </div>
    <button class="btn btn-primary btn-sm" data-act="rep-filtrar">Actualizar</button>
    <button class="btn btn-sm" data-act="rep-print">Imprimir reporte</button>
  </div>

  <div class="grid cols-5 mb-2" id="rep-kpis"></div>

  <div class="grid cols-2 mt-2">
    <div class="card">
      <h3 id="rep-graf-titulo">Ventas por día</h3>
      <div class="bars" id="rep-bars"></div>
    </div>
    <div class="card">
      <h3>Ventas por método de pago</h3>
      <div id="rep-metodo"></div>
    </div>
  </div>

  <div class="card mt-2">
    <h3>Utilidad por sucursal</h3>
    <p class="table-muted">Lo que deja cada tienda después de pagar el producto y los gastos del periodo.</p>
    <div class="table-wrap">
      <table>
        <thead><tr><th>Sucursal</th><th class="num">Ventas</th><th class="num">Costo</th><th class="num">Ganancia</th><th class="num">Gastos</th><th class="num">Utilidad</th></tr></thead>
        <tbody id="rep-suc"></tbody>
      </table>
    </div>
  </div>

  <div class="card mt-2">
    <h3>Productos <span class="hint">haz clic en una fila para ver las ventas que lo llevaron</span></h3>
    <div class="table-wrap">
      <table>
        <thead><tr><th>Producto</th><th>Categoría</th><th class="num">Ventas</th><th class="num">Unidades</th><th class="num">Venta</th><th class="num">Costo</th><th class="num">Ganancia</th><th class="num">Margen</th></tr></thead>
        <tbody id="rep-items"></tbody>
      </table>
    </div>
  </div>

  <div class="grid cols-2 mt-2">
    <div class="card" id="rep-cat"><h3>Ventas por categoría</h3></div>
    <div class="card" id="rep-catsuc"><h3>Productos por sucursal</h3></div>
  </div>`;
}

function leerFiltrosReporte() {
  const f = state.repFiltros || {};
  return {
    desde: $('#r-desde')?.value || haceNDias(29),
    hasta: $('#r-hasta')?.value || hoy(),
    granularidad: f.granularidad || 'dia',
    sucursal_id: $('#r-suc')?.value || '',
    categoria_id: $('#r-cat')?.value || '',
    empleado_id: $('#r-emp')?.value || '',
    metodo_pago: $('#r-metodo')?.value || '',
    estado: $('#r-estado')?.value || 'completada',
  };
}

function renderReporte(rep, prod) {
  const gran = rep.granularidad;
  const titulo = { dia: 'Ventas por día', semana: 'Ventas por semana', mes: 'Ventas por mes' }[gran] || 'Ventas';
  const t = $('#rep-graf-titulo'); if (t) t.textContent = titulo;

  const kpis = $('#rep-kpis'); if (kpis) {
    const r = rep.resumen;
    const margen = r.costo ? Math.round(r.ganancia / r.costo * 100) : 0;
    kpis.innerHTML = `
      <div class="card kpi primary-tint"><span class="kpi-label">Ventas</span><span class="kpi-value">${r.n_ventas}</span><span class="kpi-sub">operaciones</span></div>
      <div class="card kpi ok-tint"><span class="kpi-label">Ingresos</span><span class="kpi-value">${fmt(r.total)}</span><span class="kpi-sub">${fmt(r.base)} sin IGV</span></div>
      <div class="card kpi info-tint"><span class="kpi-label">Ganancia bruta</span><span class="kpi-value">${fmt(r.ganancia)}</span><span class="kpi-sub">margen ${margen}% · costo ${fmt(r.costo)}</span></div>
      <div class="card kpi warn-tint"><span class="kpi-label">Gastos</span><span class="kpi-value">${fmt(r.gastos)}</span><span class="kpi-sub">alquiler y servicios</span></div>
      <div class="card kpi ${r.utilidad >= 0 ? 'ok-tint' : 'danger-tint'}"><span class="kpi-label">Utilidad</span><span class="kpi-value">${fmt(r.utilidad)}</span><span class="kpi-sub">ganancia menos gastos</span></div>`;
  }

  /* El gráfico usa la serie rellenada, no porDia: así se ven también los días,
     semanas o meses en cero, que antes desaparecían del reporte. */
  const bars = $('#rep-bars'); if (bars) {
    const serie = rep.serie || [];
    const max = Math.max(...serie.map((d) => d.total), 1);
    bars.innerHTML = serie.length ? serie.map((d) => `
      <div class="bar-col" title="${esc(d.etiqueta)}: ${fmt(d.total)} · utilidad ${fmt(d.utilidad)}">
        <span class="bar-value">${d.n ? fmt(d.total) : ''}</span>
        <div class="bar-track"><div class="bar" style="height:${d.n ? Math.round((d.total / max) * 100) : 0}%"></div></div>
        <span class="bar-label">${esc(d.etiqueta)}</span>
      </div>`).join('') : '<div class="empty">Sin datos</div>';
  }

  const met = $('#rep-metodo'); if (met) {
    const max = Math.max(...rep.porMetodo.map((m) => m.total), 1);
    met.innerHTML = rep.porMetodo.length ? rep.porMetodo.map((m) => `
      <div class="mb-2">
        <div class="flex-between"><span><b>${METODO[m.metodo_pago] || m.metodo_pago}</b> · ${m.n} venta(s)</span><b>${fmt(m.total)}</b></div>
        <div style="background:#eef2f6;border-radius:6px;height:12px;margin-top:4px;overflow:hidden"><div style="width:${Math.round(m.total / max * 100)}%;height:100%;background:linear-gradient(90deg,#4f46e5,#7c3aed);border-radius:6px"></div></div>
      </div>`).join('') : '<div class="empty">Sin datos</div>';
  }

  const suc = $('#rep-suc'); if (suc) {
    suc.innerHTML = rep.porSucursal.length ? rep.porSucursal.map((s) => `
      <tr>
        <td><b>${esc(s.sucursal)}</b></td>
        <td class="num mono">${fmt(s.total)}</td>
        <td class="num mono">${fmt(s.costo)}</td>
        <td class="num mono">${fmt(s.ganancia)}</td>
        <td class="num mono txt-err">${fmt(s.gastos)}</td>
        <td class="num mono"><b class="${s.utilidad >= 0 ? 'txt-ok' : 'txt-err'}">${fmt(s.utilidad)}</b></td>
      </tr>`).join('') : '<tr><td colspan="6" class="empty">Sin datos</td></tr>';
  }

  const items = $('#rep-items'); if (items && prod) {
    items.innerHTML = prod.items.length ? prod.items.map((i) => `
      <tr class="row-click" data-act="rep-detalle" data-id="${i.producto_id}" data-nombre="${esc(i.nombre)}">
        <td><b>${esc(i.nombre)}</b> <span class="table-muted">${esc(i.codigo || '')}</span></td>
        <td>${esc(i.categoria || '—')}</td>
        <td class="num">${i.ventas}</td>
        <td class="num mono">${Number(i.cantidad).toLocaleString('es-ES')} ${esc(i.unidad || '')}</td>
        <td class="num mono">${fmt(i.venta)}</td>
        <td class="num">${fmt(i.costo)}</td>
        <td class="num mono">${fmt(i.ganancia)}</td>
        <td class="num"><span class="badge ${i.margen >= 40 ? 'badge-ok' : i.margen >= 15 ? 'badge-warn' : 'badge-danger'}">${i.margen}%</span></td>
      </tr>`).join('') : '<tr><td colspan="8" class="empty">Sin datos en el rango</td></tr>';
  }

  const cat = $('#rep-cat'); if (cat && prod) {
    const max = Math.max(...prod.porCategoria.map((c) => c.venta), 1);
    cat.innerHTML = `<h3>Ventas por categoría</h3>` + (prod.porCategoria.length ? prod.porCategoria.map((c) => `
        <div class="mb-2">
          <div class="flex-between"><span><b>${esc(c.categoria)}</b></span><b>${fmt(c.venta)} <span class="table-muted">(${Number(c.cantidad).toLocaleString('es-ES')} uds · ganancia ${fmt(c.ganancia)})</span></b></div>
          <div style="background:#eef2f6;border-radius:6px;height:12px;margin-top:4px;overflow:hidden"><div style="width:${Math.round(c.venta / max * 100)}%;height:100%;background:linear-gradient(90deg,#22c55e,#16a34a);border-radius:6px"></div></div>
        </div>`).join('') : '<div class="empty">Sin datos</div>');
  }

  const catsuc = $('#rep-catsuc'); if (catsuc && prod) {
    const max = Math.max(...(prod.porSucursal || []).map((c) => c.venta), 1);
    catsuc.innerHTML = `<h3>Productos por sucursal</h3>` + ((prod.porSucursal || []).length ? prod.porSucursal.map((c) => `
        <div class="mb-2">
          <div class="flex-between"><span><b>${esc(c.sucursal)}</b></span><b>${fmt(c.venta)} <span class="table-muted">(${Number(c.cantidad).toLocaleString('es-ES')} uds · ganancia ${fmt(c.ganancia)})</span></b></div>
          <div style="background:#eef2f6;border-radius:6px;height:12px;margin-top:4px;overflow:hidden"><div style="width:${Math.round(c.venta / max * 100)}%;height:100%;background:linear-gradient(90deg,#0ea5e9,#2563eb);border-radius:6px"></div></div>
        </div>`).join('') : '<div class="empty">Sin datos</div>');
  }
}

/* Al hacer clic en un producto se abre el ticket de las ventas que lo llevaron:
   qué día, en qué tienda, a quién y con qué precio. */
async function detalleProducto(id) {
  const f = leerFiltrosReporte();
  const r = await api('GET', `/api/reportes/producto/${id}`, f);
  openModal({
    title: r.producto.nombre,
    wide: true,
    body: `
      <p class="table-muted mb-2">${esc(r.producto.codigo || '')} · ${esc(f.desde)} → ${esc(f.hasta)} ·
        <b>${r.resumen.n}</b> venta(s), ${Number(r.resumen.cantidad).toLocaleString('es-ES')} unidades,
        venta ${fmt(r.resumen.venta)}, ganancia ${fmt(r.resumen.ganancia)}</p>
      <div class="table-wrap" style="max-height:52vh;overflow:auto">
        <table>
          <thead><tr><th>Venta</th><th>Fecha</th><th>Sucursal</th><th>Cliente</th><th>Vendedor</th><th>Pago</th><th class="num">Cant.</th><th class="num">Precio</th><th class="num">Venta</th><th class="num">Ganancia</th></tr></thead>
          <tbody>
            ${r.ventas.length ? r.ventas.map((v) => `
              <tr>
                <td class="mono">${esc(v.numero)}</td>
                <td class="mono">${esc(v.fecha)}</td>
                <td>${esc(v.sucursal)}</td>
                <td>${esc(v.cliente)}</td>
                <td>${esc(v.empleado)}</td>
                <td>${METODO[v.metodo_pago] || v.metodo_pago || '—'}</td>
                <td class="num mono">${Number(v.cantidad).toLocaleString('es-ES')}</td>
                <td class="num mono">${fmt(v.precio)}</td>
                <td class="num mono">${fmt(v.venta)}</td>
                <td class="num mono">${fmt(v.venta - v.costo)}</td>
              </tr>`).join('') : '<tr><td colspan="10" class="empty">Sin ventas en este rango</td></tr>'}
          </tbody>
        </table>
      </div>`,
    footer: `<button class="btn btn-sm" data-act="modal-close">Cerrar</button>`,
  });
}

/* La impresión de antes solo sacaba las categorías, así que el papel no
   respaldaba los números de arriba. Ahora se imprime el reporte completo. */
function imprimirReporte(rep, prod) {
  const f = leerFiltrosReporte();
  const gran = { dia: 'por día', semana: 'por semana', mes: 'por mes' }[rep.granularidad];
  const cuerpo = `
    <h3>Indicadores</h3>
    <table><tbody>
      <tr><th>Ventas</th><td>${rep.resumen.n_ventas}</td><th>Ingresos</th><td>${fmt(rep.resumen.total)}</td></tr>
      <tr><th>Base sin IGV</th><td>${fmt(rep.resumen.base)}</td><th>IGV</th><td>${fmt(rep.resumen.impuestos)}</td></tr>
      <tr><th>Descuentos</th><td>${fmt(rep.resumen.descuento)}</td><th>Costo</th><td>${fmt(rep.resumen.costo)}</td></tr>
      <tr><th>Ganancia bruta</th><td>${fmt(rep.resumen.ganancia)}</td><th>Gastos</th><td>${fmt(rep.resumen.gastos)}</td></tr>
      <tr><th>Utilidad</th><td>${fmt(rep.resumen.utilidad)}</td><th></th><td></td></tr>
    </tbody></table>
    <h3>Utilidad por sucursal</h3>
    <table><thead><tr><th>Sucursal</th><th>Ventas</th><th>Costo</th><th>Ganancia</th><th>Gastos</th><th>Utilidad</th></tr></thead><tbody>
      ${rep.porSucursal.map((s) => `<tr><td>${esc(s.sucursal)}</td><td>${fmt(s.total)}</td><td>${fmt(s.costo)}</td><td>${fmt(s.ganancia)}</td><td>${fmt(s.gastos)}</td><td>${fmt(s.utilidad)}</td></tr>`).join('')}
    </tbody></table>
    <h3>Ventas ${esc(gran)}</h3>
    <table><thead><tr><th>Periodo</th><th>Ventas</th><th>Ingresos</th><th>Costo</th><th>Utilidad</th></tr></thead><tbody>
      ${(rep.serie || []).filter((d) => d.n).map((d) => `<tr><td>${esc(d.etiqueta)}</td><td>${d.n}</td><td>${fmt(d.total)}</td><td>${fmt(d.costo)}</td><td>${fmt(d.utilidad)}</td></tr>`).join('')}
    </tbody></table>
    <h3>Productos</h3>
    <table><thead><tr><th>Producto</th><th>Categoría</th><th>Unidades</th><th>Venta</th><th>Costo</th><th>Ganancia</th><th>Margen</th></tr></thead><tbody>
      ${prod.items.map((i) => `<tr><td>${esc(i.nombre)}</td><td>${esc(i.categoria || '—')}</td><td>${i.cantidad}</td><td>${fmt(i.venta)}</td><td>${fmt(i.costo)}</td><td>${fmt(i.ganancia)}</td><td>${i.margen}%</td></tr>`).join('')}
    </tbody></table>`;
  printHTML(`<h2>Reporte de ventas</h2>
    <p>${esc(f.desde)} → ${esc(f.hasta)} · ${esc(state.config?.nombre_tienda || '')}</p>
    <p class="table-muted">Sucursal: ${state.empleado.rol === 'asesor' ? esc(state.empleado.sucursal_nombre || 'Sin sucursal asignada') : f.sucursal_id ? esc($('#r-suc')?.selectedOptions[0]?.textContent || '') : 'Todas'} ·
    ${f.estado === 'todas' ? 'Todos los estados' : esc(f.estado)}</p>` + cuerpo);
}

/* ---------- Configuración ---------- */
async function v_config() {
  const c = state.config || {};
  setTimeout(() => cfgCargarDestinos().catch(() => {}), 0);
  return `
  <div class="grid cols-2">
    <div class="card">
      <h3>Datos de la tienda</h3>
      <form id="cfg-form" class="form-grid">
        <div class="field"><span>Nombre</span><input name="nombre_tienda" value="${esc(c.nombre_tienda || '')}"></div>
        <div class="field"><span>Lema</span><input name="lema" value="${esc(c.lema || '')}"></div>
        <div class="field"><span>Documento (NIT/RUC)</span><input name="documento" value="${esc(c.documento || '')}"></div>
        <div class="field"><span>Teléfono</span><input name="telefono" value="${esc(c.telefono || '')}"></div>
        <div class="field full"><span>Dirección</span><input name="direccion" value="${esc(c.direccion || '')}"></div>
        <div class="field"><span>Moneda</span><select name="moneda">
          ${['$', '€', 'Bs', 'S/', 'Q', '₲', 'C$'].map((m) => `<option value="${m}" ${c.moneda === m ? 'selected' : ''}>${m}</option>`).join('')}
        </select></div>
        <div class="field"><span>IGV (%)</span><input type="number" name="iva" min="0" max="100" step="0.01" value="${esc(c.iva || '16')}"></div>
        <div class="field"><span>Tarifa de instalación</span><input type="number" name="precio_instalacion" min="0" step="0.01" value="${esc(c.precio_instalacion || '52')}">
          <small class="table-muted">Precio que el punto de venta propone al cotizar una visita. El asesor puede ajustarlo.</small>
        </div>
        <div class="field"><span>Prefijo ventas</span><input name="prefijo_venta" value="${esc(c.prefijo_venta || 'V')}"></div>
        <div class="field"><span>Prefijo compras</span><input name="prefijo_compra" value="${esc(c.prefijo_compra || 'C')}"></div>
        <div class="field"><span>Prefijo instalaciones</span><input name="prefijo_instalacion" value="${esc(c.prefijo_instalacion || 'INS')}"></div>
        <div class="field full"><span>Pie del ticket</span><textarea name="pie_ticket" style="min-height:48px">${esc(c.pie_ticket || '')}</textarea></div>
      </form>
      <button class="btn btn-primary mt-1" data-act="cfg-save">Guardar configuración</button>
    </div>
    <div class="grid">
      <div class="card">
        <h3>Modelo de operación</h3>
        <div class="stat-line"><span>Roles</span><b>Admin · Asesor · Técnico</b></div>
        <div class="stat-line"><span>Inventario</span><b>Global (stock único)</b></div>
        <div class="stat-line"><span>Sucursales</span><b>${(await getSucursales()).length} registradas</b></div>
        <div class="stat-line"><span>Instalación</span><b>Venta → orden → técnico</b></div>
        <div class="mt-2 text-muted" style="font-size:13px">El asesor cobra y asigna el técnico durante la venta. Si no hay técnico disponible, la orden queda <b>pendiente</b> para que el administrador la asigne.</div>
      </div>
      <div class="card">
        <h3>Usuarios de demostración</h3>
        <div class="stat-line"><span>Administrador</span><b>admin / admin123</b></div>
        <div class="stat-line"><span>Asesor</span><b>asesor / asesor123</b></div>
        <div class="stat-line"><span>Técnico</span><b>tecnico / tecnico123</b></div>
        <div class="stat-line"><span>Técnico (Sucursal Norte)</span><b>marco / marco123</b></div>
      </div>
    </div>
  </div>`;
}

async function guardarConfig() {
  const form = $('#cfg-form');
  if (!form) return;
  const fd = new FormData(form);
  const payload = Object.fromEntries(fd.entries());
  try {
    const r = await api('PUT', '/api/config', payload);
    state.config = r.config;
    toast('Configuración guardada');
    renderNav();
  } catch (err) { toast(err.message, 'err'); }
}

/* ============ Delegación de eventos ============ */
document.addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const act = btn.dataset.act;
  const id = btn.dataset.id;
  const idx = btn.dataset.idx;
  const dataset = btn.dataset;

  switch (act) {
    case 'nav': go(btn.dataset.nav); break;
    case 'modal-close': closeTopModal(); break;
    case 'ev-ver': abrirEvidencia(btn.dataset.grupo, Number(btn.dataset.idx) || 0); break;

    case 'pos-prod': {
      const prods = await api('GET', '/api/productos');
      const p = prods.productos.find((x) => x.id === Number(btn.dataset.id));
      if (p) addToCart(p);
      break;
    }
    case 'cart-clear':
      state.cart = [];
      state.inst = nuevaInstalacion();
      renderCart();
      break;
    case 'cart-del': state.cart.splice(Number(idx), 1); renderCart(); break;
    case 'cart-modo': {
      const l = state.cart[Number(idx)];
      if (!l) break;
      const c = contenidoDe(l.producto);
      if (btn.dataset.modo === 'caja') {
        if (disponible(l.producto) < c) {
          toast(`Solo quedan ${fmt(disponible(l.producto))} ${UNIDAD[l.producto.unidad] || 'pza'}: no alcanza para una ${nombrePaquete(l.producto)} de ${c}`, 'err');
          break;
        }
        l.modo = 'caja';
        /* Al cambiar a cajas la cantidad se redondea hacia abajo al múltiplo de
           caja más cercano, y nunca baja de uno. */
        l.cant = Math.max(c, Math.floor(l.cant / c) * c || c);
        l.cant = Math.min(l.cant, disponible(l.producto));
      } else {
        l.modo = 'pza';
      }
      renderCart();
      break;
    }
    case 'cart-cobrar': checkout(); break;

    case 'ticket-print': {
      const idAct = btn.dataset.id;
      if (idAct) { printTicketData(idAct).catch((er) => toast(er.message, 'err')); }
      else {
        const html = $('#ticket-html')?.innerHTML;
        if (html) printHTML(html);
      }
      break;
    }

    case 'ventas-filtrar': {
      state.fVentas = {
        desde: $('#f-desde')?.value || haceNDias(7),
        hasta: $('#f-hasta')?.value || hoy(),
        estado: $('#f-estado')?.value || 'todas',
        sucursal_id: $('#f-sucursal')?.value || '',
        buscar: $('#f-buscar')?.value || '',
      };
      render();
      break;
    }
    case 'venta-ver': ventaDetalle(id); break;
    case 'venta-anular': anularVenta(id).catch((er) => toast(er.message, 'err')); break;

    case 'inst-filtrar': instFiltrar().catch((er) => toast(er.message, 'err')); break;
    case 'inst-f-mias': instFiltrar(true).catch((er) => toast(er.message, 'err')); break;
    case 'inst-ver': instDetalle(id).catch((er) => toast(er.message, 'err')); break;
    case 'inst-estado': instEstado(id).catch((er) => toast(er.message, 'err')); break;
    case 'inst-estado-guardar': {
      const estado = $('#inst-nuevo-estado')?.value;
      if (!estado) { toast('Selecciona un estado', 'err'); break; }
      await instCambiarEstado(id, estado);
      break;
    }
    case 'inst-set-estado': instCambiarEstado(id, btn.dataset.estado).catch((er) => toast(er.message, 'err')); break;
    case 'inst-cobrar-saldo': instCobrarSaldo(id).catch((er) => toast(er.message, 'err')); break;
    case 'inst-entrega':
      if (btn.closest('.modal')) closeTopModal();
      instRegistrarEntrega(id).catch((er) => toast(er.message, 'err')); break;
    case 'inst-entrega-guardar': guardarEntrega(id).catch((er) => toast(er.message, 'err')); break;
    case 'inst-editar':
      if (btn.closest('.modal')) closeTopModal();
      instEditarDatos(id).catch((er) => toast(er.message, 'err')); break;
    case 'inst-editar-guardar': instEditarDatosGuardar(id).catch((er) => toast(er.message, 'err')); break;
    case 'inst-print': instPrint(id); break;
    case 'inst-tomar': {
      try {
        await api('POST', `/api/instalaciones/${id}/tomar`);
        toast('Orden asignada');
        closeTopModal();
        render();
      } catch (er) { toast(er.message, 'err'); }
      break;
    }
    case 'inst-avanzar': {
      const r = await api('GET', `/api/instalaciones/${id}`).catch((er) => { toast(er.message, 'err'); return null; });
      if (!r) break;
      const sig = r.instalacion.puede_avanzar?.[0];
      if (!sig) { toast('No hay transición disponible', 'err'); break; }
      await instCambiarEstado(id, sig);
      break;
    }

    case 'suc-new': sucModal(); break;
    case 'suc-edit': {
      const r = await api('GET', '/api/sucursales');
      const s = r.sucursales.find((x) => x.id === Number(id));
      if (s) sucModal(s);
      break;
    }
    case 'suc-del': {
      if (!(await uiConfirm('¿Eliminar esta sucursal?'))) return;
      try {
        await api('DELETE', `/api/sucursales/${id}`);
        invalidarSucursales();
        toast('Sucursal eliminada');
        render();
      } catch (er) { toast(er.message, 'err'); }
      break;
    }
    case 'suc-save': guardarSucursal().catch((er) => toast(er.message, 'err')); break;

    case 'prod-new': openProdModal(); break;
    case 'prod-edit': {
      const r = await api('GET', '/api/productos');
      const p = r.productos.find((x) => x.id === Number(id));
      if (p) openProdModal(p);
      break;
    }
    case 'prod-hist': historialProducto(id).catch((er) => toast(er.message, 'err')); break;
    case 'prod-pdf': descargarEtiquetaProducto(Number(id), btn); break;
    case 'prod-pdf-todo': exportarEtiquetasVisibles(btn); break;
    case 'prod-del': {
      if (!(await uiConfirm('¿Eliminar este producto?'))) return;
      try { await api('DELETE', `/api/productos/${id}`); toast('Producto eliminado'); render(); }
      catch (err) { toast(err.message, 'err'); }
      break;
    }
    case 'prod-save': guardarProducto().catch((er) => toast(er.message, 'err')); break;

    case 'cat-new': catModal(); break;
    case 'cat-edit': {
      const r = await api('GET', '/api/categorias');
      const c = r.categorias.find((x) => x.id === Number(id));
      if (c) catModal(c);
      break;
    }
    case 'cat-del': { if ((await uiConfirm('¿Eliminar esta categoría?'))) await borrarCategoria(id).catch((er) => toast(er.message, 'err')); break; }
    case 'cat-save': guardarCategoria().catch((er) => toast(er.message, 'err')); break;

    case 'inv-ajuste': ajusteModal().catch((er) => toast(er.message, 'err')); break;
    case 'aj-save': guardarAjuste().catch((er) => toast(er.message, 'err')); break;

    case 'comp-new': compraModal().catch((er) => toast(er.message, 'err')); break;
    case 'comp-add-line': {
      const sel = $('#comp-add-prod');
      const pid = Number(sel?.value);
      const cant = Number($('#comp-add-cant')?.value) || 1;
      if (!pid) { toast('Selecciona un producto', 'err'); return; }
      const prods = JSON.parse($('.modal')?.dataset?.compProds || '[]');
      const p = prods.find((x) => x.id === pid);
      if (!p) { toast('No se encontró el producto seleccionado', 'err'); return; }
      const exist = compLines.find((l) => l.id === pid);
      if (exist) { exist.cant += cant; exist.modo = 'pza'; }
      else compLines.push({ id: pid, nombre: p.nombre, unidad: p.unidad, cont: contenidoDe(p), cant, costo: p.costo, modo: 'pza' });
      renderCompLines();
      break;
    }
    case 'comp-line-modo': {
      const l = compLines[Number(idx)];
      if (!l) break;
      const c = Math.max(1, Number(l.cont) || 1);
      if (btn.dataset.modo === 'caja' && c > 1) {
        l.modo = 'caja';
        l.cant = Math.max(c, Math.floor(l.cant / c) * c || c);
        /* El precio de la caja no se inventa: si aún no se ha escrito, sale del
           costo por pieza que ya tenía la línea. */
        if (l.costoCaja == null) l.costoCaja = round2(l.costo * c);
      } else {
        l.modo = 'pza';
        l.costoCaja = null;
      }
      renderCompLines();
      break;
    }
    case 'comp-line-del': compLines.splice(Number(idx), 1); renderCompLines(); break;
    case 'comp-save': guardarCompra().catch((er) => toast(er.message, 'err')); break;
    case 'comp-ver': compraDetalle(id).catch((er) => toast(er.message, 'err')); break;
    case 'comp-recibir': compraDetalle(id, true).catch((er) => toast(er.message, 'err')); break;
    case 'rec-confirmar': confirmarRecepcion(id).catch((er) => toast(er.message, 'err')); break;
    case 'prod-etiquetas': imprimirEtiquetas().catch((er) => toast(er.message, 'err')); break;
    case 'comp-cancel': {
      if (!(await uiConfirm('¿Cancelar esta orden de compra?'))) return;
      try { await api('POST', `/api/compras/${id}/cancelar`); toast('Compra cancelada'); render(); }
      catch (err) { toast(err.message, 'err'); }
      break;
    }

    case 'prov-new': provModal(); break;
    case 'prov-edit': {
      const r = await api('GET', '/api/proveedores');
      const p = r.proveedores.find((x) => x.id === Number(id));
      if (p) provModal(p);
      break;
    }
    case 'prov-del': {
      const r = await api('GET', '/api/proveedores');
      const p = r.proveedores.find((x) => x.id === Number(id));
      if (!(await uiConfirm(`¿Dar de baja a ${p?.nombre}?`))) return;
      try { await api('DELETE', `/api/proveedores/${id}`); toast('Proveedor dado de baja'); render(); }
      catch (err) { toast(err.message, 'err'); }
      break;
    }
    case 'prov-save': guardarProveedor().catch((er) => toast(er.message, 'err')); break;

    case 'cli-new': cliModal(); break;
    case 'cli-edit': {
      const r = await api('GET', '/api/clientes');
      const c = r.clientes.find((x) => x.id === Number(id));
      if (c) cliModal(c);
      break;
    }
    case 'cli-del': {
      if (!(await uiConfirm('¿Dar de baja a este cliente?'))) return;
      try { await api('DELETE', `/api/clientes/${id}`); toast('Cliente dado de baja'); render(); }
      catch (err) { toast(err.message, 'err'); }
      break;
    }
    case 'cli-ver': cliHistorial(id).catch((er) => toast(er.message, 'err')); break;
    case 'cli-save': guardarCliente().catch((er) => toast(er.message, 'err')); break;

    case 'emp-new': empModal(); break;
    case 'emp-edit': {
      const r = await api('GET', '/api/empleados');
      const e = r.empleados.find((x) => x.id === Number(id));
      if (e) empModal({ ...e });
      break;
    }
    case 'emp-del': {
      if (!(await uiConfirm('¿Desactivar este empleado?'))) return;
      try { await api('DELETE', `/api/empleados/${id}`); toast('Empleado desactivado'); render(); }
      catch (err) { toast(err.message, 'err'); }
      break;
    }
    case 'emp-save': guardarEmpleado().catch((er) => toast(er.message, 'err')); break;

    case 'rep-filtrar':
    case 'rep-print': {
      const f = leerFiltrosReporte();
      const [rep, prod] = await Promise.all([
        api('GET', '/api/reportes/ventas', f),
        api('GET', '/api/reportes/productos', f),
      ]);
      state.repFiltros = f;
      renderReporte(rep, prod);
      if (act === 'rep-print') imprimirReporte(rep, prod);
      break;
    }
    case 'rep-gran': {
      state.repFiltros = { ...(state.repFiltros || {}), granularidad: dataset.v || 'dia' };
      document.querySelectorAll('#r-gran .seg-btn').forEach((b) => b.classList.toggle('active', b.dataset.v === state.repFiltros.granularidad));
      const f = leerFiltrosReporte();
      const [rep, prod] = await Promise.all([
        api('GET', '/api/reportes/ventas', f),
        api('GET', '/api/reportes/productos', f),
      ]);
      renderReporte(rep, prod);
      break;
    }
    case 'rep-detalle': detalleProducto(id).catch((er) => toast(er.message, 'err')); break;

    // ---------------- Gastos ----------------
    case 'gas-filtrar': await cargarGastos(); break;
    case 'gas-new': await gasModal(); break;
    case 'gas-pagar': await pagarAlquiler(dataset.mes || hoyMes(), dataset.suc || ''); break;
    case 'gas-edit': {
      const r = await api('GET', '/api/gastos', { mes: state.gastosMes || hoyMes() });
      const g = r.gastos.find((x) => x.id === Number(id));
      if (g) await gasModal(g);
      break;
    }
    case 'gas-del': {
      if (!(await uiConfirm('¿Eliminar este gasto?'))) return;
      try {
        await api('DELETE', `/api/gastos/${id}`);
        toast('Gasto eliminado');
        await cargarGastos();
      } catch (er) { toast(er.message, 'err'); }
      break;
    }
    case 'gas-save': await guardarGasto(); break;
    case 'goto-gastos':
      state.view = 'gastos';
      state.gastosMes = dataset.mes || hoyMes();
      render();
      break;

    case 'cfg-save': guardarConfig().catch((er) => toast(er.message, 'err')); break;
    case 'cfg-dest-add': cfgDestAdd(); break;
    case 'cfg-dest-ed': cfgDestEd(id); break;
    case 'cfg-dest-toggle': cfgDestToggle(id); break;

    case 'prod-compra': {
      go('compras');
      setTimeout(async () => {
        try {
          await compraModal();
          const sel = $('#comp-add-prod');
          if (!sel) return;
          sel.value = String(id);
          $('[data-act="comp-add-line"]')?.click();
          sel.focus();
        } catch (er) { toast(er.message, 'err'); }
      }, 150);
      break;
    }
  }
});

/* Cambios e inputs */
document.addEventListener('change', async (e) => {
  const el = e.target;
  if (el.dataset.act === 'cart-qty') {
    const l = state.cart[Number(el.dataset.idx)];
    if (l) {
      fijarCantidadCarrito(l, el.value);
      renderCart();
    }
  }
  if (el.id === 'cart-destino') actualizarEfectivoUI();
  if (el.id === 'cart-descuento' || el.id === 'cart-efectivo') renderCart();
  if (el.id === 'cart-cliente') prefillInstalacionCliente(true);
  if (el.id === 'inst-switch') {
    state.inst.on = el.checked;
    if (el.checked && state.inst.precio === null) state.inst.precio = tarifaInstalacionSugerida() || null;
    if (!el.checked) state.inst.adelanto = null;
    renderPanelInstalacion();
    actualizarTotales();
  }
  if (el.dataset.act === 'comp-line-cant') {
    const l = compLines[Number(el.dataset.idx)];
    if (l) {
      const c = Math.max(1, Number(l.cont) || 1);
      const n = Math.max(1, Math.floor(Number(el.value) || 1));
      /* En modo caja lo tecleado son bolsas, y lo que se guarda son piezas. */
      l.cant = l.modo === 'caja' && c > 1 ? n * c : n;
      renderCompLines();
    }
  }
  if (el.dataset.act === 'comp-line-cost') {
    const l = compLines[Number(el.dataset.idx)];
    if (l) {
      const c = Math.max(1, Number(l.cont) || 1);
      const v = Number(el.value) || 0;
      /* En modo caja lo tecleado es el precio de la bolsa; el costo por pieza
         se deduce de ahí, que es justo lo que evita que el inventario quede
         valuado a precio de bolsa. */
      if (l.modo === 'caja' && c > 1) {
        l.costoCaja = round2(v);
        l.costo = v > 0 ? round2(v / c) : 0;
      } else {
        l.costo = v;
      }
      renderCompLines();
    }
  }
  if (el.id === 'm-tipo') movTbody().catch(() => {});
  if (el.id === 'c-estado') compTbody().catch(() => {});
  /* Los filtros de gastos viven en selects, que avisan con change y no con
     click. Un listener de change se evita poner un botón "Actualizar" aquí. */
  if (el.dataset.act === 'gas-filtrar') cargarGastos().catch((er) => toast(er.message, 'err'));
});

document.addEventListener('input', debounce(async (e) => {
  const el = e.target;
  if (el.id === 'pos-buscar' || el.id === 'pos-cat') {
    const busca = $('#pos-buscar').value;
    const cat = $('#pos-cat').value;
    const r = await api('GET', '/api/productos', { categoria_id: cat }).catch(() => ({ productos: [] }));
    const grid = $('#pos-grid');
    if (grid) grid.innerHTML = renderChips(r.productos, busca);
  }
  if (el.id === 'p-buscar' || el.id === 'p-cat' || el.id === 'p-filtro') {
    const r = await api('GET', '/api/productos', {
      buscar: $('#p-buscar').value, categoria_id: $('#p-cat').value, filtro: $('#p-filtro').value,
    }).catch(() => ({ productos: [] }));
    const tb = $('#prod-tbody');
    if (tb) tb.innerHTML = r.productos.length ? r.productos.map(productoFila).join('')
      : '<tr><td colspan="8" class="empty">Sin productos que coincidan</td></tr>';
  }
  if (el.id === 'cli-buscar') {
    const r = await api('GET', '/api/clientes', { buscar: el.value }).catch(() => ({ clientes: [] }));
    const tb = $('#cli-tbody');
    if (tb) tb.innerHTML = clientesHtml(r.clientes);
  }
}, 250));

/* La ficha de instalación se guarda al instante: el costo y el adelanto cambian
   los importes mientras el asesor escribe, y los datos de la visita se
   conservan si el carrito se redibuja. Va sin debounce a propósito. */
document.addEventListener('input', (e) => {
  const el = e.target;
  if (el.id === 'inst-precio') {
    state.inst.precio = Number(el.value) || 0;
    if ($('#inst-adelanto')) $('#inst-adelanto').max = el.value;
    actualizarSaldoInstalacion();
    actualizarTotales();
  }
  if (el.id === 'inst-adelanto') {
    state.inst.adelanto = Number(el.value) || 0;
    actualizarSaldoInstalacion();
    actualizarTotales();
  }
  if (el.id === 'inst-direccion') { state.inst.direccion = el.value; state.inst.direccionTocada = true; }
  if (el.id === 'inst-contacto') { state.inst.contacto = el.value; state.inst.contactoTocada = true; }
  if (el.id === 'inst-fecha') state.inst.fecha = el.value;
  if (el.id === 'inst-hora') state.inst.hora = el.value;
  if (el.id === 'inst-notas') state.inst.notas = el.value;
});
document.addEventListener('change', (e) => {
  if (e.target.id === 'inst-tecnico') state.inst.tecnico_id = e.target.value;
});

/* ---------- Lector de códigos de barras en el punto de venta ---------- */
/* El lector se comporta como un teclado: escribe el código y manda Enter. Por eso
   al pulsar Enter en el buscador se intenta primero resolver el texto como
   código de barras; si no es de ningún producto se deja la búsqueda normal. */
document.addEventListener('keydown', async (e) => {
  if (e.key !== 'Enter') return;
  const el = e.target;
  if (el.id !== 'pos-buscar') return;
  e.preventDefault();
  const texto = el.value.trim();
  if (!texto) return;
  const codigo = texto.replace(/\D/g, '');
  /* Solo tiene sentido como código si viene casi todo de dígitos: si el asesor
     escribió un nombre con números, se respeta la búsqueda textual. */
  if (!codigo || codigo.length < texto.replace(/\s/g, '').length * 0.6) return;
  try {
    const r = await api('GET', `/api/productos/barcode/${codigo}`);
    addToCart(r.producto);
    el.value = '';
    toast(`Añadido: ${r.producto.nombre}`);
  } catch (err) {
    toast(err.message, 'err');
  }
});

function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

/* ============ Login / arranque ============ */
$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const errEl = $('#login-error');
  errEl.textContent = '';
  try {
    const r = await api('POST', '/api/login', {
      usuario: $('#login-usuario').value, clave: $('#login-clave').value,
    });
    await entrar(r.empleado);
  } catch (err) { errEl.textContent = err.message; }
});

async function entrar(empleado) {
  state.empleado = empleado;
  state._destinos = null;
  await loadConfig();
  $('#login-screen').classList.add('hidden');
  $('#app').classList.remove('hidden');
  go(state.route);
}

$('#btn-logout').addEventListener('click', async () => {
  try { await api('POST', '/api/logout'); } catch (_) {}
  state.empleado = null;
  state.config = null;
  state._destinos = null;
  state.cart = [];
  $('#app').classList.add('hidden');
  $('#login-screen').classList.remove('hidden');
  $('#login-usuario').value = '';
  $('#login-clave').value = '';
  location.hash = '';
});

window.addEventListener('hashchange', render);

(async function boot() {
  try {
    const r = await api('GET', '/api/me');
    if (r.empleado) {
      await entrar(r.empleado);
      return;
    }
  } catch (_) {}
  $('#login-screen').classList.remove('hidden');
})();

async function cfgCargarDestinos() {
  const div = $('#cfg-destinos');
  if (!div) return;
  try {
    const r = await api('GET', '/api/destinos-pago');
    const dests = r.destinos || [];
    div.innerHTML = dests.length ? `
      <table class="compact"><thead><tr><th>Nombre</th><th>Tipo</th><th>Identificador</th><th>Sucursal</th><th>Estado</th><th class="text-right">Acciones</th></tr></thead><tbody>
        ${dests.map(d => `
          <tr>
            <td>${esc(d.nombre)}</td>
            <td>${esc(d.tipo)}</td>
            <td>${esc(d.identificador||'—')}</td>
            <td>${esc(d.sucursal_nombre||'(toda la tienda)')}</td>
            <td>${d.activo ? '<span class="badge badge-ok">Activo</span>' : '<span class="badge badge-neutral">Inactivo</span>'}</td>
            <td class="text-right"><button class="btn btn-xs" data-act="cfg-dest-ed" data-id="${d.id}">Editar</button><button class="btn btn-xs btn-ghost" data-act="cfg-dest-toggle" data-id="${d.id}">${d.activo?'Desactivar':'Activar'}</button></td>
          </tr>`).join('')}
      </tbody></table>` : '<div class="empty">Sin destinos configurados</div>';
  } catch(e){ div.innerHTML = `<div class="empty">${esc(e.message)}</div>`; }
}
async function cfgDestAdd() {
  const suc = await getSucursales();
  const html = `
    <form id="cfg-dest-form" class="form-grid">
      <label>Nombre</label><input name="nombre" required />
      <label>Tipo</label><select name="tipo" required>
        <option value="efectivo">Efectivo</option>
        <option value="tarjeta">Tarjeta</option>
        <option value="transferencia">Transferencia</option>
        <option value="yape">Yape</option>
      </select>
      <label>Identificador (cuenta/celular/alias)</label><input name="identificador" />
      <label>Sucursal</label><select name="sucursal_id">
        <option value="">Toda la tienda</option>
        ${suc.map(s=>`<option value="${s.id}">${esc(s.nombre)}</option>`).join('')}
      </select>
      <small class="table-muted full">Efectivo: lo habitual es asignarlo a una sucursal.</small>
    </form>`;
  openModal({title:'Nuevo destino de pago', body:html, footer:`<button class="btn" data-act="modal-close">Cancelar</button><button class="btn btn-primary" id="cfg-dest-save">Guardar</button>`});
  $('#cfg-dest-save')?.addEventListener('click', async ()=>{
    const fd=new FormData($('#cfg-dest-form')); const p=Object.fromEntries(fd.entries());
    if (!p.sucursal_id) delete p.sucursal_id;
    try{ await api('POST','/api/destinos-pago', p); closeTopModal(); cfgCargarDestinos(); invalidarDestinos(); toast('Destino creado'); }catch(e){toast(e.message,'err');}
  });
}


async function cfgDestEd(id) {
  const r = await api('GET','/api/destinos-pago');
  const d = (r.destinos||[]).find(x=>String(x.id)===String(id));
  if(!d) return;
  const suc = await getSucursales();
  const html = `
    <form id="cfg-dest-form" class="form-grid">
      <label>Nombre</label><input name="nombre" value="${esc(d.nombre)}" required />
      <label>Tipo</label><select name="tipo" required>
        ${['efectivo','tarjeta','transferencia','yape'].map(t=>`<option value="${t}" ${d.tipo===t?'selected':''}>${t}</option>`).join('')}
      </select>
      <label>Identificador</label><input name="identificador" value="${esc(d.identificador||'')}" />
      <label>Sucursal</label><select name="sucursal_id">
        <option value="">Toda la tienda</option>
        ${suc.map(s=>`<option value="${s.id}" ${String(d.sucursal_id)===String(s.id)?'selected':''}>${esc(s.nombre)}</option>`).join('')}
      </select>
      <label>Activo</label><select name="activo"><option value="1" ${d.activo?'selected':''}>Sí</option><option value="0" ${!d.activo?'selected':''}>No</option></select>
    </form>`;
  openModal({title:'Editar destino de pago', body:html, footer:`<button class="btn" data-act="modal-close">Cancelar</button><button class="btn btn-primary" id="cfg-dest-save">Guardar</button>`});
  $('#cfg-dest-save')?.addEventListener('click', async ()=>{
    const fd=new FormData($('#cfg-dest-form')); const p=Object.fromEntries(fd.entries());
    if (!p.sucursal_id) p.sucursal_id = null;
    try{ await api('PUT',`/api/destinos-pago/${id}`, p); closeTopModal(); cfgCargarDestinos(); invalidarDestinos(); toast('Destino actualizado'); }catch(e){toast(e.message,'err');}
  });
}
async function cfgDestToggle(id) {
  const r = await api('GET','/api/destinos-pago');
  const d = (r.destinos||[]).find(x=>String(x.id)===String(id));
  if(!d) return;
  const activo = d.activo?0:1;
  try{ await api('PUT',`/api/destinos-pago/${id}`, {activo}); cfgCargarDestinos(); invalidarDestinos(); toast(activo?'Activado':'Desactivado'); }catch(e){toast(e.message,'err');}
}
async function cargarDestinosCart(forzar = false) {
  const sel = $('#cart-destino');
  if (!sel) return;
  if (state._destinos && sel.options.length > 1 && !forzar) return;
  try {
    const dests = await getDestinos();
    state._destinos = dests;
    const prev = sel.value;
    sel.innerHTML = '<option value="">¿Dónde recibió el pago?</option>' +
      dests.map((d) => {
        const amb = d.sucursal_nombre ? ` · ${esc(d.sucursal_nombre)}` : '';
        const iden = d.identificador ? ` (${esc(d.identificador)})` : '';
        return `<option value="${d.id}">${esc(d.nombre)}${iden}${amb}</option>`;
      }).join('');
    if (prev && dests.find((d) => String(d.id) === String(prev))) sel.value = prev;
    actualizarEfectivoUI();
  } catch (e) { /* ignora */ }
}
