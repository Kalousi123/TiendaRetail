/* Quita acentos y deja solo lo que una etiqueta y un PDF saben escribir: sin
   tildes, sin saltos de línea y sin los caracteres que el ZPL o el PDF toman
   como comando. Lo comparte el PDF con el título del archivo. */
export const textoEtiqueta = value => String(value ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^a-zA-Z0-9 .,():+\/-]/g, ' ').trim();
/* Lo que dice una etiqueta, sin importar en qué se imprima: el nombre partido
   en hasta cuatro líneas y el pie con el contenido. Lo usan tanto el ZPL/TSPL
   de src/labels.js como el PDF de src/labelpdf.js, para que la impresora
   térmica y el PDF no se contradigan en qué pone el producto. */
export function preparacionEtiqueta(item) {
  const code = String(item.codigo_barras);
  if (!/^\d{1,32}$/.test(code)) throw new Error('El código debe tener entre 1 y 32 dígitos');
  const nombre = textoEtiqueta(item.nombre).slice(0,120);
  const words = nombre.match(/.{1,30}(?:\s|$)|.{1,30}/g) || ['Producto'];
  const lines = words.slice(0,4).map(x => x.trim());
  const footer = textoEtiqueta(`Contiene ${item.contenido || 1} ${item.unidad || 'pza'}`);
  /* El precio solo lo usa la etiqueta compacta del PDF: en la de 100 × 150 no
     cabe sin tapar las barras, y la impresora térmica sigue con su diseño de
     cuatro renglones. Sin símbolo de moneda porque la etiqueta ya sale de la
     tienda: el número es lo que se compara con la lista de precios. */
  const precio = item.precio === null || item.precio === undefined || item.precio === '' ? '' : textoEtiqueta(importeDe(item.precio));
  return { code, lines, footer, nombre, precio };
}

/* Milares con coma y dos decimales, como se escribe un precio en el Perú.
   Se arma a mano en vez de con toLocaleFormat porque el separador de la etiqueta
   no puede depender del idioma del sistema donde se generó el PDF. */
function importeDe(valor) {
  const n = Number(valor);
  if (!Number.isFinite(n)) return '';
  const [entero, decimales] = Math.abs(n).toFixed(2).split('.');
  return `${n < 0 ? '-' : ''}${entero.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${decimales}`;
}
export function generateLabels(printer, items) {
  if (!['ZPL','TSPL'].includes(printer.language) || ![203,300].includes(Number(printer.dpi))) throw new Error('Perfil de impresora inválido');
  const dots = mm => Math.round(mm * Number(printer.dpi) / 25.4);
  const x = mm => dots(mm + Number(printer.offset_x || 0));
  const y = mm => dots(mm + Number(printer.offset_y || 0));
  return items.map(item => {
    if (!Number.isInteger(item.copias) || item.copias < 1 || item.copias > 1000) throw new Error('Cantidad inválida');
    const { code, lines, footer } = preparacionEtiqueta(item);
    const module = Math.max(1, Math.min(dots(0.5), Math.floor(dots(80) / ((code.length + 3) * 11 + 22))));
    if (printer.language === 'ZPL') return [
      '^XA', `^PW${dots(100)}^LL${dots(150)}^LH0,0^CI28`,
      ...lines.map((line,i)=>`^FO${x(8)},${y(12+i*8)}^A0N,${dots(5)},${dots(4)}^FD${line}^FS`),
      `^FO${x(8)},${y(60)}^BY${module},2,${dots(30)}^BCN,${dots(30)},N,N,N^FD${code}^FS`,
      `^FO${x(8)},${y(97)}^A0N,${dots(5)},${dots(3.5)}^FD${code}^FS`,
      `^FO${x(8)},${y(120)}^A0N,${dots(4)},${dots(3)}^FD${footer}^FS`,
      `^PQ${item.copias}^XZ`,
    ].join('\n');
    return [
      'SIZE 100 mm,150 mm', `GAP ${Number(printer.gap_mm || 0)} mm,0 mm`, 'DIRECTION 1', 'REFERENCE 0,0', 'CLS',
      ...lines.map((line,i)=>`TEXT ${x(8)},${y(12+i*8)},"3",0,${Number(printer.dpi)===300?2:1},${Number(printer.dpi)===300?2:1},"${line}"`),
      `BARCODE ${x(8)},${y(60)},"128",${dots(30)},0,0,${module},${module},"${code}"`,
      `TEXT ${x(8)},${y(97)},"3",0,1,1,"${code}"`,
      `TEXT ${x(8)},${y(120)},"3",0,1,1,"${footer}"`, `PRINT ${item.copias},1`,
    ].join('\r\n');
  }).join('\r\n')+'\r\n';
}
