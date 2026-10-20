import { withDatabase } from './db.js';
import { featureHandler } from './features.js';
import { readImages, cleanupImages } from './evidence.js';
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { handler, ApiError } from './routes.js';
import { parseCookies, getEmpleadoByToken, destroySession, COOKIE_NAME } from './auth.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = join(__dirname, '..', 'public');
process.env.TZ = process.env.TZ || 'America/Lima';
const PORT = process.env.PORT === undefined ? 3000 : Number(process.env.PORT);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.txt': 'text/plain; charset=utf-8',
};

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 2_000_000) req.destroy();
    });
    req.on('end', () => resolve(data));
    req.on('error', () => resolve(''));
  });
}

async function serveStatic(req, res, pathname) {
  let file = pathname === '/' ? '/index.html' : pathname;
  const target = normalize(join(PUBLIC_DIR, file));
  if (!target.startsWith(PUBLIC_DIR)) {
    res.writeHead(403).end('Forbidden');
    return;
  }
  try {
    const info = await stat(target);
    if (info.isDirectory()) throw new Error();
    const bytes = await readFile(target);
    res.writeHead(200, {
      'Content-Type': MIME[extname(target)] || 'application/octet-stream',
      /* Sin caché: tras un despliegue el asesor tiene que ver el código nuevo
         sin tener que recargar a la fuerza. */
      'Cache-Control': 'no-store, must-revalidate',
    });
    res.end(bytes);
  } catch {
    try {
      const bytes = await readFile(join(PUBLIC_DIR, 'index.html'));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(bytes);
    } catch {
      res.writeHead(404).end('Not found');
    }
  }
}

async function handleApi(req, res, url) {
  const cookies = parseCookies(req.headers.cookie);
  const token = cookies[COOKIE_NAME];
  const empleado = await getEmpleadoByToken(token);
  const isUpload = req.method === 'POST' && /^\/api\/instalaciones\/\d+\/evidencias$/.test(url.pathname);
  if (isUpload && !empleado) throw new ApiError(401, 'No autorizado');
  const raw = isUpload ? '' : await readBody(req);
  let body = isUpload ? await readImages(req) : {};
  if (raw) {
    try {
      body = JSON.parse(raw);
    } catch {
      throw new ApiError(400, 'JSON inválido en el cuerpo de la petición');
    }
  }
  if (req.method === 'GET') for (const [k, v] of url.searchParams) body[k] = v;

  /* Solo el login necesita mandar una cookie. Se deja en null para que el
     encabezado no salga en el resto de las respuestas. */
  let setCookie = null;
  const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim().toLowerCase();
  const secureRequest = req.socket.encrypted === true ||
    (process.env.TRUST_PROXY === '1' && forwardedProto === 'https');
  const result = await withDatabase(req.method !== 'GET', async () => {
    return await featureHandler(req, url.pathname, body, empleado) ?? await handler(req.method, url.pathname, body, empleado, (cookieHeader) => {
      setCookie = secureRequest ? cookieHeader : cookieHeader.replace(/; Secure(?=;|$)/i, '');
    });
  });
  if (result.binary) {
    const headers = {'Content-Type':result.contentType,'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'};
    /* El nombre va filtrado porque Content-Disposition acepta saltos de línea:
       uno sin querer ahí convierte la respuesta en otra petición distinta. */
    const nombre = typeof result.filename === 'string'
      ? result.filename.replace(/[^\x20-\x7E]/g, '').replace(/["\\]/g, '').slice(0, 150)
      : '';
    if (nombre) headers['Content-Disposition'] = `attachment; filename="${nombre}"`;
    res.writeHead(200, headers);
    res.end(result.binary); return;
  }

  if (req.method === 'POST' && url.pathname === '/api/logout') {
    destroySession(body.token || token);
  }

  const headers = { 'Content-Type': 'application/json; charset=utf-8' };
  if (setCookie) headers['Set-Cookie'] = setCookie;
  res.writeHead(result.status || 200, headers);
  res.end(JSON.stringify(result));
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (url.pathname.startsWith('/api/')) {
      await handleApi(req, res, url);
    } else {
      await serveStatic(req, res, url.pathname);
    }
  } catch (err) {
    if (err instanceof ApiError || [400,413].includes(err.status)) {
      res.writeHead(err.status, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: err.message }));
      return;
    }
    console.error('ERROR:', err);
    if (!res.headersSent) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: 'Error interno del servidor' }));
    }
  }
});

// Remove abandoned uploads and old orphan files on startup, then repeat daily.
const cleanupTimer = setInterval(() => {
  withDatabase(true, cleanupImages).catch((error) => console.error('EVIDENCE CLEANUP:', error.message));
}, 24 * 60 * 60 * 1000);
cleanupTimer.unref();
withDatabase(true, cleanupImages).catch((error) => console.error('EVIDENCE CLEANUP:', error.message));

server.listen(PORT, () => {
  console.log('');
  console.log('  Tienda Retail — sistema de gestión');
  console.log(`  Servidor: http://localhost:${server.address().port}`);
});
