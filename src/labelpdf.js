/* Etiquetas de código de barras en PDF.

   El PDF se arma aquí, a mano, sin librerías: una etiqueta son rectángulos
   negros y cuatro líneas de texto, y el PDF es un formato de texto con una
   tabla de direcciones al final. Con eso sale un archivo de unas decenas de
   kilobytes y cero dependencias, en vez de los megabytes que baja una librería
   de PDF completa para dibujar lo mismo.

   Las barras se dibujan con los mismos patrones de Code 128 que la vista
   previa del navegador, así que lo que se ve en pantalla y lo que sale
   impreso son el mismo código. */
import { deflateSync } from 'node:zlib';
import { preparacionEtiqueta, textoEtiqueta } from './labels.js';
/* El códec vive en public/ porque el navegador lo carga para pintar la vista
   previa de la etiqueta. No usa el DOM al cargarse —solo al dibujar— y public/
   es la única carpeta que el servidor envía al cliente, así que mantenerlo en un
   solo sitio evita que la tabla de 107 patrones se desincronice entre la
   pantalla y el PDF. */
import '../public/barcode.js';
const Code128 = globalThis.Code128;

/* 1 mm en puntos. El PDF mide en puntos (1/72"), la etiqueta en milímetros. */
const MM = 72 / 25.4;

/* El mismo papel que imprime la impresora térmica, para que el PDF sirva tanto
   para mandar a una impresora de etiquetas como para imprimir en hoja. */
const ETIQUETA = { ancho: 100, alto: 150 };

/* Medidas de la etiqueta de bobina. Son las mismas que usa el ZPL/TSPL de
   src/labels.js —el formato establecido—: papel de 100 × 150 mm, todo a 8 mm
   del borde izquierdo y las bandas fijas, en milímetros desde ARRIBA: nombre a
   12, barras a 60 con 30 de alto, número legible a 97 y pie a 120. El PDF dibuja
   desde abajo, así que cada banda se traduce restando su altura del alto de la
   etiqueta; si se cambia una medida aquí, se cambia en los dos archivos o la
   etiqueta impresa y el PDF dejan de decir lo mismo. */
const MEDIDAS = {
  margen: 8,
  nombre: { arriba: 12, alto: 5, paso: 8, lineas: 4 },
  barras: { arriba: 60, alto: 30, ancho: 80, modulo: 0.5 },
  numero: { arriba: 97, alto: 5 },
  pie: { arriba: 120, alto: 4 },
};

/* Hojas admitidas. Cada una dice qué papel es, cuánto aire sobra a cada lado,
   cuánto hay entre etiqueta y etiqueta, y de qué tamaño es la etiqueta que se
   repite, porque sin ese dato no se puede saber cuántas caben.

   "etiqueta" es una etiqueta por página con el papel de su tamaño exacto, que es
   lo que se le entrega a una impresora de etiquetas. Las otras tres reparte una
   hoja A4. El aire es de 3 mm porque es lo que deja que dos etiquetas de 100 mm
   de ancho quepan en 210: 2 × 100 + 3 de separación + 6 de aire = 209.

   De alto, dos etiquetas de 150 no caben ni por poco (2 × 150 + 3 + 6 = 306 contra
   297), así que "a4" se queda en dos por hoja, una sola fila y medio papel en
   blanco. "a4densa" baja la etiqueta a 100 × 50 y entran dos por fila y cinco
   por columna: diez. "avery" es la hoja de etiquetas pegadas de 63.5 × 38.1, que
   entran tres por fila y siete por columna: veintiuna. */
const HOJAS = {
  etiqueta: { ancho: 100, alto: 150, margen: 0, separacion: 0, diseno: 'bobina' },
  a4: { ancho: 210, alto: 297, margen: 3, separacion: 3, diseno: 'bobina' },
  a4densa: { ancho: 210, alto: 297, margen: 3, separacion: 3, diseno: 'compacto', etiqueta: { ancho: 100, alto: 50 } },
  avery: { ancho: 210, alto: 297, margen: 5, separacion: 0, diseno: 'compacto', etiqueta: { ancho: 63.5, alto: 38.1 } },
};

/* Cuántas etiquetas caben en una hoja, de qué tamaño son y con qué diseño se
   dibujan. Se cuentan las columnas primero, que es como se cuentan a ojo. */
export function formatoDe(clave) {
  const hoja = HOJAS[clave] || HOJAS.a4;
  const etiqueta = hoja.etiqueta || ETIQUETA;
  return {
    clave, hoja, etiqueta, diseno: hoja.diseno,
    columnas: Math.max(1, Math.floor((hoja.ancho - 2 * hoja.margen + hoja.separacion) / (etiqueta.ancho + hoja.separacion))),
    filas: Math.max(1, Math.floor((hoja.alto - 2 * hoja.margen + hoja.separacion) / (etiqueta.alto + hoja.separacion))),
    porHoja: Math.max(1, Math.floor((hoja.ancho - 2 * hoja.margen + hoja.separacion) / (etiqueta.ancho + hoja.separacion)))
      * Math.max(1, Math.floor((hoja.alto - 2 * hoja.margen + hoja.separacion) / (etiqueta.alto + hoja.separacion))),
  };
}

/* Los formatos con su cuenta, para que el selector de la ventana de etiquetas no
   tenga que repetirlos a mano y termine jurando que en una hoja caben dos
   cuando caben diez. El nombre lleva las tres cosas que se preguntan al elegir
   el papel: cómo se reparte, de qué tamaño sale cada etiqueta y cuántas caben. */
const conCuenta=(clave,medida)=>{
  const f=formatoDe(clave);
  return { clave, nombre: `A4 · ${f.columnas} × ${f.filas} etiquetas de ${medida} · ${f.porHoja} por hoja`, porHoja: f.porHoja };
};
export const FORMATOS = [
  conCuenta('a4densa', '100 × 50 mm'),
  conCuenta('avery', '63.5 × 38.1 mm'),
  conCuenta('a4', '100 × 150 mm'),
  { clave: 'etiqueta', nombre: 'Una por página · 100 × 150 mm', porHoja: 1 },
];

/* Anchos de las fuentes base del PDF para los caracteres imprimibles (32 a 126).
   Sirven solo para medir y ajustar el texto a la etiqueta, así que se usan los
   valores habituales de Helvetica y Helvetica-Bold: si un visor midiera algo
   levemente distinto, el archivo seguiría siendo igual de válido. Courier es de
   ancho fijo y no necesita tabla. */
const ANCHOS = {
  F1: '278 278 355 556 556 889 667 191 333 333 389 584 278 333 278 278 '
    + '556 556 556 556 556 556 556 556 556 556 '
    + '278 278 584 584 584 556 1015 '
    + '667 667 722 722 667 611 778 722 278 500 667 556 833 722 778 667 '
    + '778 722 667 611 722 667 944 667 667 611 '
    + '278 278 278 469 556 333 '
    + '556 556 500 556 556 278 556 556 222 222 500 222 833 556 556 556 '
    + '556 333 500 278 556 500 722 500 500 500 '
    + '334 260 334 584',
  F2: '278 333 474 556 556 889 722 238 333 333 389 584 278 333 278 278 '
    + '556 556 556 556 556 556 556 556 556 556 '
    + '333 333 584 584 584 611 975 '
    + '722 722 722 722 667 611 778 722 278 556 722 611 833 722 778 667 '
    + '778 722 667 611 722 667 944 667 667 611 '
    + '333 278 333 584 556 333 '
    + '556 611 556 611 556 333 611 611 278 278 556 278 889 611 611 611 '
    + '611 389 556 333 611 556 778 556 556 500 '
    + '389 280 389 584',
};
const ANCHOS_NUM = { F1: ANCHOS.F1.split(' ').map(Number), F2: ANCHOS.F2.split(' ').map(Number) };

/* El PDF no acepta notación científica ni un punto suelto: los números salen
   redondeados a milésimas, que es más que suficiente para una etiqueta. */
const num = (valor) => {
  const n = Math.round(Number(valor) * 1000) / 1000;
  return n === 0 || !Number.isFinite(n) ? '0' : String(n);
};
/* Un texto va entre paréntesis, así que los paréntesis y la barra se escapan.
   El saneado de labels.js ya deja el texto en ASCII imprimible. */
const escapar = (txt) => String(txt).replace(/[\\()]/g, (c) => `\\${c}`);

function anchoDe(texto, fuente, size) {
  const tabla = ANCHOS_NUM[fuente];
  let milésimas = 0;
  for (const ch of String(texto)) {
    const codigo = ch.charCodeAt(0);
    milésimas += tabla ? tabla[codigo - 32] ?? 600 : 600;
  }
  return milésimas / 1000 * size;
}

/* Encoge la letra hasta que la línea quepa en `ancho` mm y, si con la letra
   más chica tampoco cabe, recorta el texto: un nombre incompleto se distingue,
   uno encima de las barras ya no se lee y el lector se equivoca. */
function ajustar(texto, fuente, size, ancho) {
  let s = size;
  while (s > 2.4 && anchoDe(texto, fuente, s) > ancho) s = Math.round((s - 0.2) * 10) / 10;
  let linea = String(texto);
  if (anchoDe(linea, fuente, s) > ancho) {
    while (linea.length > 3 && anchoDe(`${linea}...`, fuente, s) > ancho) linea = linea.slice(0, -1);
    linea = `${linea}...`;
  }
  return { texto: linea, size: s, ancho: anchoDe(linea, fuente, s) };
}

/* Escribe un texto. Las coordenadas van en mm desde la esquina inferior
   izquierda de la etiqueta. */
function texto(ops, fuente, size, x, y, cadena, ancho, centrar = false) {
  const a = ajustar(cadena, fuente, size, ancho);
  ops.push(`BT /${fuente} ${num(a.size)} Tf ${num(centrar ? x - a.ancho / 2 : x)} ${num(y)} Td (${escapar(a.texto)}) Tj ET`);
}

/* Las barras se dibujan como rectángulos negros llenados en un solo trazado:
   un `re` por barra y un `f` al final. El módulo sale con la misma regla que el
   ZPL —nunca más de medio milímetro— para que el lector que ya lee las
   etiquetas de la impresora lea también el PDF sin cambiar de ajuste. En una
   etiqueta angosta el módulo se achica lo que haga falta para que la barra
   quepa; achicarse es mejor que recortarse, porque el lector lee igual. */
function codigoDeBarras(ops, code, x, alto, altoBarra, anchoMax, moduloMax) {
  const valores = Code128.valores(code);
  const modulos = Code128.anchoModulos(code);
  if (!valores || !modulos) return 0;
  const modulo = Math.min(moduloMax, anchoMax / modulos);
  const ancho = modulo * modulos;
  let cursor = x;
  ops.push('0 0 0 rg');
  for (const valor of valores) {
    const patron = Code128.patrones[valor];
    for (let i = 0; i < patron.length; i++) {
      const w = Number(patron[i]) * modulo;
      if (i % 2 === 0) ops.push(`${num(cursor)} ${num(alto)} ${num(w)} ${num(altoBarra)} re`);
      cursor += w;
    }
  }
  ops.push('f');
  return ancho;
}

/* Las medidas de la etiqueta de bobina, en milímetros desde arriba. Son las
   mismas que usa el ZPL/TSPL de src/labels.js: si se cambia una, se cambia allá
   o la etiqueta de la impresora y la del PDF dejan de decir lo mismo. */
function medidasBobina(etiqueta) {
  return { ...MEDIDAS, ancho: etiqueta.ancho, alto: etiqueta.alto, precio: null };
}

/* Las medidas de las etiquetas de las hojas con rejilla. Las bandas van en
   fracción del alto y no en milímetros, para que el mismo diseño sirva en la
   hoja densa de 100 × 50 y en la de 63.5 × 38.1 sin mantener dos juegos de
   números que se desincronicen. En la de 50 mm quedan: nombre en dos renglones,
   precio en negrita a su derecha, barras de 21 mm de alto y el número debajo.
   El pie con el contenido se queda solo en la etiqueta grande. */
function medidasCompactas(etiqueta) {
  const alto = etiqueta.alto;
  return {
    ancho: etiqueta.ancho, alto, margen: 3,
    nombre: { arriba: 0.07 * alto, alto: 0.10 * alto, paso: 0.11 * alto },
    precio: { arriba: 0.05 * alto, alto: 0.17 * alto },
    barras: { arriba: 0.33 * alto, alto: 0.42 * alto, ancho: etiqueta.ancho - 6, modulo: 0.5 },
    numero: { arriba: 0.77 * alto, alto: 0.10 * alto },
    pie: null,
  };
}

/* Texto pegado al borde derecho. El precio va ahí porque en una etiqueta angosta
   no hay una banda propia: se apoya contra el margen derecho, arriba, al lado
   del nombre. */
function textoDerecha(ops, fuente, size, xDerecha, y, cadena, ancho) {
  const a = ajustar(cadena, fuente, size, ancho);
  ops.push(`BT /${fuente} ${num(a.size)} Tf ${num(xDerecha - a.ancho)} ${num(y)} Td (${escapar(a.texto)}) Tj ET`);
}

/* Por dónde se corta. En la hoja suelta va un marco punteado alrededor, que es lo
   que ya se veía; en las rejillas van cuatro escuadras en las esquinas de cada
   celda: menos tinta, y se distingue de golpe dónde termina una etiqueta y
   empieza la siguiente. */
function guias(ops, m, esquinas) {
  ops.push(esquinas ? '0.25 w 0.72 0.72 0.72 RG' : '0.6 w [2 1.6] 0 d 0.72 0.72 0.72 RG');
  if (!esquinas) {
    ops.push(`0.5 0.5 ${num(m.ancho - 1)} ${num(m.alto - 1)} re S`);
  } else {
    const brazo = 2.5;
    for (const [x, y, dx, dy] of [[0, 0, 1, 1], [m.ancho, 0, -1, 1], [0, m.alto, 1, -1], [m.ancho, m.alto, -1, -1]]) {
      ops.push(`${num(x)} ${num(y)} m ${num(x + dx * brazo)} ${num(y)} l S`);
      ops.push(`${num(x)} ${num(y)} m ${num(x)} ${num(y + dy * brazo)} l S`);
    }
  }
  ops.push('[] 0 d');
}

/* Una etiqueta. Las coordenadas van en milímetros desde la esquina inferior
   izquierda de la etiqueta, y las bandas llegan medidas desde arriba porque así
   están escritas en el ZPL y en la hoja. `m` trae el tamaño y las bandas del
   diseño que se está usando. */
function contenidoEtiqueta(prep, m, esquinas) {
  const ops = [];
  const desdeAbajo = (arriba, alto) => m.alto - arriba - alto;
  const util = m.ancho - 2 * m.margen;
  guias(ops, m, esquinas);
  /* El nombre va en negrita: es lo que se lee a un metro de la etiqueta. */
  const lineas = m.pie ? prep.lines : envolver(prep.nombre, 2, 26);
  lineas.forEach((linea, i) => texto(ops, 'F2', 5, m.margen,
    desdeAbajo(m.nombre.arriba + i * m.nombre.paso, m.nombre.alto), linea || ' ', util));
  if (m.precio && prep.precio) {
    textoDerecha(ops, 'F2', 5.5, m.ancho - m.margen,
      desdeAbajo(m.precio.arriba, m.precio.alto), prep.precio, util * 0.44);
  }
  const anchoBarras = codigoDeBarras(ops, prep.code, m.margen,
    desdeAbajo(m.barras.arriba + m.barras.alto, 0), m.barras.alto, m.barras.ancho, m.barras.modulo);
  if (!anchoBarras) {
    texto(ops, 'F1', 5, m.ancho / 2, desdeAbajo(m.barras.arriba + m.barras.alto / 2, 0), 'Sin código', util, true);
  }
  /* El número va debajo de las barras, centrado en Courier porque es de ancho
     fijo: el número que ve el lector tiene que ser el mismo que lleva la barra. */
  texto(ops, 'F3', 5, m.margen + anchoBarras / 2, desdeAbajo(m.numero.arriba, m.numero.alto), prep.code, util, true);
  if (m.pie && prep.footer) texto(ops, 'F1', 4, m.margen, desdeAbajo(m.pie.arriba, m.pie.alto), prep.footer, util);
  return ops;
}

/* Reparte un nombre en pocas líneas para las etiquetas donde no caben cuatro.
   Si sobra texto, la última línea se cierra con puntos suspensivos para que se
   vea que está cortada: el código de barras es lo que identifica el producto. */
function envolver(nombre, lineas, ancho) {
  const trozos = String(nombre || 'Producto').match(new RegExp(`.{1,${ancho}}(?:\\s|$)|.{1,${ancho}}`, 'g')) || ['Producto'];
  const lineasCaben = trozos.slice(0, lineas).map(x => x.trim());
  if (trozos.length > lineas && lineasCaben.length) {
    lineasCaben[lineasCaben.length - 1] = `${lineasCaben[lineasCaben.length - 1].slice(0, ancho - 3)}...`;
  }
  return lineasCaben.length ? lineasCaben : [' '];
}

/* Un objeto del PDF. Los diccionarios y las páginas van como texto; el
   contenido de la página va comprimido, que es lo que reduce el archivo. */
function agregar(objetos, cuerpo) {
  objetos.push(cuerpo);
  return objetos.length;
}

function flujo(datos) {
  const comprimido = deflateSync(Buffer.from(datos, 'latin1'));
  return Buffer.concat([
    Buffer.from(`<< /Length ${comprimido.length} /Filter /FlateDecode >>\nstream\n`, 'latin1'),
    comprimido,
    Buffer.from('\nendstream', 'latin1'),
  ]);
}

/* El archivo PDF en sí: objetos numerados, tabla de direcciones y trailer. */
function serializar(objetos, raiz, info) {
  const trozos = [Buffer.from('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n', 'latin1')];
  const posiciones = [0];
  let offset = trozos[0].length;
  objetos.forEach((cuerpo, i) => {
    posiciones.push(offset);
    const bloque = Buffer.concat([
      Buffer.from(`${i + 1} 0 obj\n`, 'latin1'),
      Buffer.isBuffer(cuerpo) ? cuerpo : Buffer.from(String(cuerpo), 'latin1'),
      Buffer.from('\nendobj\n', 'latin1'),
    ]);
    trozos.push(bloque);
    offset += bloque.length;
  });
  const inicioXref = offset;
  let tabla = `xref\n0 ${objetos.length + 1}\n0000000000 65535 f \n`;
  for (let i = 1; i <= objetos.length; i++) tabla += `${String(posiciones[i]).padStart(10, '0')} 00000 n \n`;
  tabla += `trailer\n<< /Size ${objetos.length + 1} /Root ${raiz} 0 R /Info ${info} 0 R >>\nstartxref\n${inicioXref}\n%%EOF\n`;
  trozos.push(Buffer.from(tabla, 'latin1'));
  return Buffer.concat(trozos);
}

/**
 * Arma el PDF de las etiquetas pedidas.
 *
 * Cada item trae los datos del producto (`codigo_barras`, `nombre`, `unidad`,
 * `contenido`, `precio`) y cuántas copias quiere de él. `opciones.hoja` elige el
 * papel: 'etiqueta' (una por página, 100 × 150 mm), 'a4' (dos por hoja),
 * 'a4densa' (diez de 100 × 50 mm) o 'avery' (veintiuna de 63.5 × 38.1 mm).
 *
 * @returns {Buffer} el archivo completo, listo para mandar como descarga.
 */
export function generarEtiquetasPdf(items, opciones = {}) {
  if (!Array.isArray(items) || items.length === 0) throw new Error('Selecciona productos');
  const { hoja: pagina, etiqueta, diseno, columnas, filas, porHoja } = formatoDe(opciones.hoja);

  /* Las copias se repiten antes de dibujar: así el reparto en páginas es el
     mismo para todos y no hace falta llevar la cuenta de lo que sobró. El texto
     se prepara una sola vez por producto, aunque se repitan sus copias. */
  const etiquetas = [];
  for (const item of items) {
    const prep = preparacionEtiqueta(item);
    const copias = Number(item.copias);
    if (!Number.isInteger(copias) || copias < 1 || copias > 1000) throw new Error('Cantidad inválida');
    for (let i = 0; i < copias; i++) etiquetas.push(prep);
  }
  if (etiquetas.length > 2000) throw new Error('Máximo 2000 etiquetas por PDF');

  const medidas = diseno === 'compacto' ? medidasCompactas(etiqueta) : medidasBobina(etiqueta);
  /* Si sobra ancho a un lado se reparte por mitades para que la rejilla quede
     centrada; el alto que sobra se queda abajo, debajo de la última fila. */
  const sobrante = pagina.ancho - 2 * pagina.margen - (columnas * etiqueta.ancho + (columnas - 1) * pagina.separacion);
  const x0 = pagina.margen + Math.max(0, sobrante / 2);
  const totalHojas = Math.ceil(etiquetas.length / porHoja);

  const objetos = [];
  const catalogo = agregar(objetos, null);
  const arbol = agregar(objetos, null);
  /* Las tres fuentes base del PDF: Helvetica y Helvetica-Bold para el texto,
     Courier para el número del código, que es de ancho fijo. */
  const f1 = agregar(objetos, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');
  const f2 = agregar(objetos, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>');
  const f3 = agregar(objetos, '<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>');

  const paginas = [];
  for (let p = 0; p < totalHojas; p++) {
    /* Toda la página se dibuja en milímetros: se escala una vez y abajo solo
       hay que pensar en medidas de etiqueta. */
    const ops = [`q ${num(MM)} 0 0 ${num(MM)} 0 0 cm`];
    for (let k = 0; k < porHoja; k++) {
      const item = etiquetas[p * porHoja + k];
      if (!item) break;
      const columna = k % columnas;
      const fila = Math.floor(k / columnas);
      const base = pagina.alto - pagina.margen - fila * (etiqueta.alto + pagina.separacion) - etiqueta.alto;
      ops.push(`q 1 0 0 1 ${num(x0 + columna * (etiqueta.ancho + pagina.separacion))} ${num(base)} cm`);
      ops.push(...contenidoEtiqueta(item, medidas, porHoja > 1));
      ops.push('Q');
    }
    /* En las hojas con rejilla, el aire que sobra abajo lleva la cuenta de lo
       que se está imprimiendo: si se pierde una hoja al cortado, se nota. */
    if (porHoja > 1) {
      textoDerecha(ops, 'F1', 2.6, pagina.ancho - pagina.margen, Math.max(0.8, pagina.margen / 2),
        `pagina ${p + 1} de ${totalHojas} - ${columnas} x ${filas} etiquetas de ${etiqueta.ancho} x ${etiqueta.alto} mm`, pagina.ancho - 2 * pagina.margen);
    }
    ops.push('Q');
    const contenido = agregar(objetos, flujo(ops.join('\n')));
    paginas.push(agregar(objetos, `<< /Type /Page /Parent ${arbol} 0 R`
      + ` /MediaBox [0 0 ${num(pagina.ancho * MM)} ${num(pagina.alto * MM)}]`
      + ` /Resources << /Font << /F1 ${f1} 0 R /F2 ${f2} 0 R /F3 ${f3} 0 R >> >>`
      + ` /Contents ${contenido} 0 R >>`));
  }

  objetos[catalogo - 1] = `<< /Type /Catalog /Pages ${arbol} 0 R >>`;
  objetos[arbol - 1] = `<< /Type /Pages /Kids [${paginas.map((id) => `${id} 0 R`).join(' ')}] /Count ${paginas.length} >>`;
  const info = agregar(objetos, `<< /Producer (Tienda Retail) /Creator (Tienda Retail)`
    + ` /Title (${escapar(tituloDe(items, etiquetas.length))}) >>`);
  return serializar(objetos, catalogo, info);
}

/* El título que muestra el visor al abrir el archivo. Pasa por el saneado de
   la etiqueta porque el PDF se escribe en latin1: un nombre con tilde o con un
   guion largo se convertiría en basura si se copiara tal cual. */
function tituloDe(items, total) {
  return `${textoEtiqueta(items[0]?.nombre).slice(0, 60) || 'Etiquetas'} · ${total}`;
}