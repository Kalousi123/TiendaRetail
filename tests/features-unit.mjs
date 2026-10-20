import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateLabels, preparacionEtiqueta } from '../src/labels.js';
import { generarEtiquetasPdf, formatoDe } from '../src/labelpdf.js';
import { normalizarNombre } from '../src/db.js';
import { inflateSync } from 'node:zlib';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
const item={nombre:'Tornillo ñ ^XZ " ~JA\n',codigo_barras:'20000001',contenido:12,unidad:'pza',copias:2};
test('ZPL 100×150 a 203 y 300 dpi, copias y texto seguro',()=>{
 for(const dpi of [203,300]){
  const result=generateLabels({language:'ZPL',dpi},[item]);
  assert.ok(result.includes(`^PW${Math.round(100*dpi/25.4)}^LL${Math.round(150*dpi/25.4)}`));
  assert.ok(result.includes('^PQ2^XZ'));assert.equal(result.match(/\^XZ/g).length,1);assert.ok(!result.includes('~JA'));
 }
});
test('TSPL tamaño, separación, código y copias',()=>{
 const result=generateLabels({language:'TSPL',dpi:203,gap_mm:3},[item]);
 assert.match(result,/SIZE 100 mm,150 mm/);assert.match(result,/GAP 3 mm,0 mm/);assert.match(result,/PRINT 2,1/);assert.match(result,/"128"/);
});
test('rechaza comandos en código y cantidades inválidas',()=>{
 assert.throws(()=>generateLabels({language:'ZPL',dpi:203},[{...item,codigo_barras:'1^XZ'}]));
 assert.throws(()=>generateLabels({language:'TSPL',dpi:203},[{...item,copias:1.5}]));
});
/* El contenido de la página va comprimido, así que para leer lo que se dibuja
   hay que desinflar el flujo: es lo que distingue un PDF con la etiqueta
   dibujada de uno que solo dice que es un PDF. */
function flujoDe(pdf){return inflateSync(Buffer.from(/stream\n([\s\S]*?)\nendstream/.exec(pdf)[1],'latin1')).toString('latin1');}
/* Todas las páginas, para leer lo que dice el pie de la última hoja. */
const flujosDe=pdf=>[...pdf.matchAll(/stream\n([\s\S]*?)\nendstream/g)].map(m=>inflateSync(Buffer.from(m[1],'latin1')).toString('latin1'));
const pdfDe=hoja=>generarEtiquetasPdf([{nombre:'Tornillo (3/4)',codigo_barras:'20000001',contenido:12,unidad:'pza',copias:2}],{hoja}).toString('latin1');
test('el PDF trae una hoja por tamaño de etiqueta y una página por copia',()=>{
 const a4=pdfDe('a4'),suelta=pdfDe('etiqueta');
 assert.ok(a4.startsWith('%PDF-1.4'));
 assert.ok(a4.endsWith('%%EOF\n'));
 assert.match(a4,/<< \/Type \/Catalog \/Pages \d+ 0 R >>/);
 /* A4 reparte dos etiquetas por hoja; suelta es una por página del tamaño exacto. */
 assert.match(a4,/<< \/Type \/Pages \/Kids \[[^\]]+\] \/Count 1 >>/);
 assert.match(a4,/MediaBox \[0 0 595\.276 841\.89\]/);
 assert.match(suelta,/<< \/Type \/Pages \/Kids \[[^\]]+\] \/Count 2 >>/);
 assert.match(suelta,/MediaBox \[0 0 283\.465 425\.197\]/);
/* El nombre del archivo va en el PDF para que el visor lo muestre al abrirlo. */
  assert.match(suelta,/\/Title \(Tornillo \\\(3\/4\\\) · 2\)/);
  /* En A4 la hoja solo reparte: cada etiqueta sigue midiendo 100 × 150 y se
     coloca a 3 mm del borde y a 3 mm de la de al lado (103 mm de paso). */
  const origenes=[...flujoDe(a4).matchAll(/q 1 0 0 1 ([\d.]+) ([\d.]+) cm/g)].map(m=>[Number(m[1]),Number(m[2])]);
  assert.deepEqual(origenes,[[3.5,144],[106.5,144]]);
});
test('la etiqueta del PDF lleva el nombre, el código y las barras justas',()=>{
  const flujo=flujoDe(pdfDe('etiqueta'));
  /* Los paréntesis del nombre van escapados: sin eso el texto se trunca y el
     resto del nombre se dibuja fuera de la etiqueta. */
  assert.ok(flujo.includes('(Tornillo \\(3/4\\)) Tj'),flujo);
  assert.match(flujo,/\(20000001\) Tj/);
  assert.match(flujo,/\(Contiene 12 pza\) Tj/);
  assert.match(flujo,/0 0 0 rg/);
  const barras=[...flujo.matchAll(/^([\d.]+) ([\d.]+) ([\d.]+) ([\d.]+) re$/gm)].map(m=>m.slice(1).map(Number));
  assert.ok(barras.length>20,`faltan barras: ${barras.length}`);
});
test('las medidas del PDF son las de la etiqueta establecida de 100 × 150 mm',()=>{
  const flujo=flujoDe(pdfDe('etiqueta'));
  /* El marco punteado va de 0,5 a 99,5: la etiqueta entera, sin salirse del papel. */
  assert.ok(flujo.includes('0.5 0.5 99 149 re S'),flujo);
  const barras=[...flujo.matchAll(/^([\d.]+) ([\d.]+) ([\d.]+) ([\d.]+) re$/gm)].map(m=>m.slice(1).map(Number));
  const modulo=Math.min(...barras.map(b=>b[2]));
  const ancho=Math.max(...barras.map(b=>b[0]+b[2]))-barras[0][0];
  assert.equal(barras[0][0],8,'las barras arrancan a 8 mm del borde izquierdo');
  /* La misma regla de módulo que el ZPL: medio milímetro como tope, para que el
     lector que ya lee la impresora lea el PDF sin cambiar de ajuste. */
  assert.ok(modulo<=0.5,`el módulo no puede pasar de medio milímetro: ${modulo}`);
  assert.ok(ancho<=80,`la barra no puede pasar de 80 mm: ${ancho}`);
  assert.ok(barras.every(b=>b[1]===60&&b[3]===30),'la banda de barras va de 60 a 90 mm desde abajo');
  assert.ok(barras.every(b=>Math.abs(b[2]/modulo-Math.round(b[2]/modulo))<0.001),'cada barra es un múltiplo del módulo');
  /* Las bandas de texto se comparan desde arriba, como las cuenta el ZPL:
     nombre a 12 mm, número legible a 97 y pie a 120. */
  const nombres=[...flujo.matchAll(/BT \/F2 [\d.]+ Tf ([\d.]+) ([\d.]+) Td/g)].map(m=>[Number(m[1]),150-Number(m[2])-5]);
  assert.deepEqual(nombres,[[8,12]]);
  assert.match(flujo,/BT \/F3 5 Tf [\d.]+ 48 Td/,`el número legible va en su banda de 97 mm: ${flujo}`);
  assert.match(flujo,/BT \/F1 4 Tf 8 26 Td/,`el pie va en su banda de 120 mm: ${flujo}`);
});
test('el PDF no deja pasar comandos de impresora ni comillas sin escapar',()=>{
 const flujo=flujoDe(generarEtiquetasPdf([{nombre:'Tornillo ^XZ ~JA "comilla"',codigo_barras:'20000003',contenido:1,unidad:'pza',copias:1}],{hoja:'etiqueta'}).toString('latin1'));
 assert.doesNotMatch(flujo,/\^XZ|~JA/);
 assert.match(flujo,/\(Tornillo\s+XZ\s+JA\s+comilla\) Tj/);
});
test('el PDF rechaza lo que no se puede imprimir',()=>{
  assert.throws(()=>generarEtiquetasPdf([],{hoja:'a4'}));
  assert.throws(()=>generarEtiquetasPdf([{...item,copias:1.5}]));
  assert.throws(()=>generarEtiquetasPdf([{...item,codigo_barras:'1^XZ'}]));
  assert.throws(()=>generarEtiquetasPdf([{...item,copias:1001}]));
  assert.throws(()=>generarEtiquetasPdf([{...item,copias:2001},{...item,copias:1000}]));
});
test('cada hoja declara cuántas etiquetas caben y de qué tamaño son',()=>{
  const densa=formatoDe('a4densa'),avery=formatoDe('avery'),grande=formatoDe('a4');
  assert.equal(densa.columnas,2);assert.equal(densa.filas,5);assert.equal(densa.porHoja,10);
  assert.deepEqual([densa.etiqueta.ancho,densa.etiqueta.alto],[100,50]);
  assert.equal(avery.columnas,3);assert.equal(avery.filas,7);assert.equal(avery.porHoja,21);
  /* La hoja grande se queda en dos porque de alto no caben dos de 150: eso es
     lo que motivó la hoja densa, no un error de reparto. */
  assert.deepEqual([grande.columnas,grande.filas],[2,1]);
  assert.equal(formatoDe('etiqueta').porHoja,1);
  /* Nada se parte: la rejilla se parte de lo que sobra, nunca de la etiqueta. */
  for(const f of [densa,avery,grande]){
    assert.ok(f.columnas*f.etiqueta.ancho+(f.columnas-1)*f.hoja.separacion+2*f.hoja.margen<=f.hoja.ancho+0.001);
    assert.ok(f.filas*f.etiqueta.alto+(f.filas-1)*f.hoja.separacion+2*f.hoja.margen<=f.hoja.alto+0.001);
  }
});
test('la hoja densa reparte diez celdas del tamaño exacto, alineadas y sin encimarse',()=>{
  const pdf=generarEtiquetasPdf(Array.from({length:10},(_,i)=>({nombre:`Tornillo ${i}`,codigo_barras:String(20000001+i),contenido:1,unidad:'pza',precio:10+i,copias:1})),{hoja:'a4densa'}).toString('latin1');
  assert.match(pdf,/\/Count 1 >>/);
  const celdas=[...flujoDe(pdf).matchAll(/q 1 0 0 1 ([\d.]+) ([\d.]+) cm/g)].map(m=>[Number(m[1]),Number(m[2])]);
  assert.equal(celdas.length,10);
  /* Dos columnas y cinco filas, con la rejilla centrada en los 210 mm de ancho:
     sobran 0.5 mm a cada lado después de los 3 mm de aire. */
  assert.deepEqual([...new Set(celdas.map(c=>c[0]))],[3.5,106.5]);
  assert.deepEqual([...new Set(celdas.map(c=>c[1]))],[244,191,138,85,32]);
  for(const [x,y] of celdas){
    assert.ok(x>=0&&y>=0&&x+100<=210.001&&y+50<=297.001,`la celda ${x},${y} se sale de la hoja`);
  }
});
test('la etiqueta compacta lleva el precio, dos renglones de nombre y guías de corte',()=>{
  const flujo=flujoDe(generarEtiquetasPdf([{nombre:'Tornillo (3/4) zincado 40 mm',codigo_barras:'20000001',contenido:12,unidad:'pza',precio:1234.5,copias:1}],{hoja:'a4densa'}).toString('latin1'));
  assert.match(flujo,/\(1,234\.50\) Tj/);
  /* El pie con el contenido es de la etiqueta de bobina: acá no cabe y estorba. */
  assert.doesNotMatch(flujo,/Contiene 12 pza/);
  /* Dos renglones de nombre (F2) más el precio, y el número del código en Courier. */
  assert.equal([...flujo.matchAll(/\/F2 [\d.]+ Tf/g)].length,3);
  assert.match(flujo,/\(20000001\) Tj/);
  const barras=[...flujo.matchAll(/^([\d.]+) ([\d.]+) ([\d.]+) ([\d.]+) re$/gm)].map(m=>m.slice(1).map(Number));
  assert.ok(barras.every(b=>b[3]===21),`las barras miden 21 mm de alto en una etiqueta de 50: ${barras[0]}`);
  assert.ok(Math.max(...barras.map(b=>b[0]+b[2]))<=94,'las barras no pasan del ancho útil de la etiqueta');
  /* Cuatro esquinas de dos segmentos: por dónde se corta, sin el marco entero. */
  assert.equal([...flujo.matchAll(/ m /g)].length,8);
  assert.doesNotMatch(flujo,/99 149 re S/);
});
test('la hoja con rejilla dice al pie cuántas hojas van y cuántas caben',()=>{
  const uno=generarEtiquetasPdf([{nombre:'Tornillo',codigo_barras:'20000001',contenido:1,unidad:'pza',copias:1}],{hoja:'a4densa'}).toString('latin1');
  assert.match(flujoDe(uno),/\(pagina 1 de 1 - 2 x 5 etiquetas de 100 x 50 mm\) Tj/);
  const tres=generarEtiquetasPdf(Array.from({length:25},(_,i)=>({nombre:'Tornillo',codigo_barras:String(20000001+i),contenido:1,unidad:'pza',copias:1})),{hoja:'a4densa'}).toString('latin1');
  assert.match(tres,/\/Count 3 >>/);
  assert.ok(flujosDe(tres).some(f=>/\(pagina 3 de 3 - 2 x 5 etiquetas de 100 x 50 mm\) Tj/.test(f)));
  /* La etiqueta suelta es una por página y no lleva pie: es un papel exacto. */
  assert.doesNotMatch(flujoDe(pdfDe('etiqueta')),/pagina \d+ de/);
});
test('el precio de la etiqueta sale como número con miles y centavos',()=>{
  assert.equal(preparacionEtiqueta({nombre:'X',codigo_barras:'1',precio:1234.5}).precio,'1,234.50');
  assert.equal(preparacionEtiqueta({nombre:'X',codigo_barras:'1',precio:0}).precio,'0.00');
  assert.equal(preparacionEtiqueta({nombre:'X',codigo_barras:'1',precio:19.9}).precio,'19.90');
  assert.equal(preparacionEtiqueta({nombre:'X',codigo_barras:'1'}).precio,'');
});
test('el nombre se compara sin tildes, sin mayúsculas y sin espacios de más',()=>{
  assert.equal(normalizarNombre('  Cemento   PORTLAND '),'cemento portland');
  assert.equal(normalizarNombre('Café Molido'),normalizarNombre('cafe  molido'));
  assert.equal(normalizarNombre('Pintura Ñandú'),normalizarNombre('pintura nandu'));
  assert.notEqual(normalizarNombre('Cemento 1kg'),normalizarNombre('Cemento 5kg'));
});
test('la cámara no vuelve a contar un código mientras siga visible',async()=>{
 const source=await readFile(new URL('../public/scan-gate.js',import.meta.url),'utf8');
 const createScanGate=runInNewContext(`${source}; createScanGate`);
 const gate=createScanGate(650);
 assert.equal(gate.accept('200001',0),'200001');
 assert.equal(gate.accept('200001',900),'');
 assert.equal(gate.accept('',1200),'');
 assert.equal(gate.accept('200001',1250),'');
 assert.equal(gate.accept('',1600),'');
 assert.equal(gate.accept('',1910),'');
 assert.equal(gate.accept('200001',2000),'200001');
});
test('interfaz sin diálogos nativos',async()=>{
 for(const file of ['app.js','devices.js'])assert.doesNotMatch(await readFile(new URL('../public/'+file,import.meta.url),'utf8'),/\b(?:alert|confirm|prompt)\s*\(/);
});
