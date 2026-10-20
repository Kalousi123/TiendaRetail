/* Código de barras Code 128 dibujado como SVG.
   El proyecto no usa librerías externas, así que el códec vive aquí: patrón de
   barras, dígito de verificación mod-103 y cierre. Lo que se guarda en la base
   es solo el texto plano; el checksum se calcula sobre las barras, por eso no
   se guarda por separado. */
(function (global) {
  'use strict';

  /* Los 107 patrones de Code 128: 6 elementos (3 barras y 3 espacios) con su
     ancho en módulos, más el patrón de cierre que tiene 13. */
  var PATRONES = [
    '212222', '222122', '222221', '121223', '121322', '131222', '122213', '122312', '132212', '221213',
    '221312', '231212', '112232', '122132', '122231', '113222', '123122', '123221', '223211', '221132',
    '221231', '213212', '223112', '312131', '311222', '321122', '321221', '312212', '322112', '322211',
    '212123', '212321', '232121', '111323', '131123', '131321', '112313', '132113', '132311', '211313',
    '231113', '231311', '112133', '112331', '132131', '113123', '113321', '133121', '313121', '211331',
    '231131', '213113', '213311', '213131', '311123', '311321', '331121', '312113', '312311', '332111',
    '314111', '221411', '431111', '111224', '111422', '121124', '121421', '141122', '141221', '112214',
    '112412', '122114', '122411', '142112', '142211', '241211', '221114', '413111', '241112', '134111',
    '111242', '121142', '121241', '114212', '124112', '124211', '411212', '421112', '421211', '212141',
    '214121', '412121', '111143', '111341', '131141', '114113', '114311', '411113', '411311', '113141',
    '114131', '311141', '411131', '211412', '211214', '211232', '2331112',
  ];

  var INICIO_B = 104;   /* subconjunto B: cubre los caracteres imprimibles */
  var CIERRE = 106;

  function digitoVerificacion(valores) {
    var suma = valores[0];
    for (var i = 1; i < valores.length; i++) suma += valores[i] * i;
    return suma % 103;
  }

  /* Devuelve la secuencia de valores a codificar, o null si el texto tiene
     caracteres fuera del subconjunto B. */
  function aValores(texto) {
    var s = String(texto == null ? '' : texto).trim();
    if (!s) return null;
    for (var i = 0; i < s.length; i++) {
      var c = s.charCodeAt(i);
      if (c < 32 || c > 126) return null;
    }
    var valores = [INICIO_B];
    for (var j = 0; j < s.length; j++) valores.push(s.charCodeAt(j) - 32);
    valores.push(digitoVerificacion(valores));
    valores.push(CIERRE);
    return valores;
  }

  /* Ancho total en módulos: 11 por cada símbolo (inicio, datos y verificación)
     más los 13 del patrón de cierre. */
  function anchoModulos(texto) {
    var valores = aValores(texto);
    if (!valores) return 0;
    var total = 0;
    for (var i = 0; i < valores.length; i++) {
      var patron = PATRONES[valores[i]];
      for (var j = 0; j < patron.length; j++) total += Number(patron[j]);
    }
    return total;
  }

  function escapar(txt) {
    return String(txt).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* Devuelve el SVG del código. Opciones: texto (true por defecto, dibuja el
     número debajo), ancho (ancho en CSS, por defecto llena el contenedor) y
     margen (holgura alrededor de las barras). */
  function svg(texto, opciones) {
    var o = opciones || {};
    var limpio = String(texto == null ? '' : texto).trim();
    var valores = aValores(limpio);
    if (!valores) return '';

    var margen = o.margen === undefined ? 4 : o.margen;
    var altoBarras = o.altoBarras === undefined ? 56 : o.altoBarras;
    var conTexto = o.texto !== false;
    var altoTexto = conTexto ? 18 : 0;
    var altura = altoBarras + altoTexto + margen * 2;

    /* Un solo path con todas las barras: menos nodos y bordes limpios. */
    var x = margen;
    var d = '';
    for (var i = 0; i < valores.length; i++) {
      var patron = PATRONES[valores[i]];
      for (var j = 0; j < patron.length; j++) {
        var w = Number(patron[j]);
        if (j % 2 === 0) d += 'M' + x + ' ' + margen + 'h' + w + 'v' + altoBarras + 'h-' + w + 'z';
        x += w;
      }
    }
    var ancho = x + margen;
    var etiqueta = conTexto
      ? '<text x="' + (ancho / 2) + '" y="' + (margen + altoBarras + 14) + '" text-anchor="middle"'
        + ' font-family="ui-monospace, SFMono-Regular, Menlo, monospace" font-size="15"'
        + ' letter-spacing="2" fill="currentColor">' + escapar(limpio) + '</text>'
      : '';

    return '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ' + ancho + ' ' + altura + '"'
      + ' width="' + (o.ancho || '100%') + '" role="img"'
      + ' aria-label="Código de barras ' + escapar(limpio) + '">'
      + '<path d="' + d + '" fill="currentColor" shape-rendering="crispEdges"/>'
      + etiqueta
      + '</svg>';
  }

  global.Code128 = { svg: svg, anchoModulos: anchoModulos, digitoVerificacion: digitoVerificacion, valores: aValores, patrones: PATRONES };
})(typeof window !== 'undefined' ? window : globalThis);
