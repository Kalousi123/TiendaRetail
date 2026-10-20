-- Un producto con el mismo nombre es el mismo artículo: se factura, se descuenta
-- stock y se reporta por separado. Dos renglones idénticos en el catálogo parten
-- el stock en dos y hacen que los reportes cuenten el doble. El código y el
-- código de barras ya tenían su índice único, al nombre le faltaba.
--
-- La comparación va sobre una columna calculada, no sobre el texto tal cual lo
-- escribió quien hizo el alta: sin tildes, en minúsculas y sin espacios de más,
-- para que "Cemento  PORTLAND" y "Cemento Portánd" cuenten como el mismo
-- producto. La calcula MySQL sola, así que el bloqueo se cumple también cuando
-- algo escribe sin pasar por la API (importar un catálogo, SQL a mano).
--
-- La expresión tiene que ser equivalente a normalizarNombre() de src/db.js, que
-- es la que decide el mensaje de error: si se cambia una, se cambian las dos.

ALTER TABLE productos
  ADD COLUMN nombre_clave VARCHAR(191) GENERATED ALWAYS AS (
    REGEXP_REPLACE(
      REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(REPLACE(
        LOWER(TRIM(nombre)),
        'á', 'a'), 'é', 'e'), 'í', 'i'), 'ó', 'o'),
      'ú', 'u'), 'ü', 'u'), 'ñ', 'n'), 'ç', 'c'),
    '  +', ' ')
  ) STORED;

-- Los productos archivados también ocupan su nombre: uno que tiene ventas no se
-- borra, se desactiva, y si su nombre volviera a salir el catálogo mostraría dos
-- renglones idénticos, uno invisible y otro con todo el stock.
ALTER TABLE productos ADD UNIQUE INDEX ux_productos_nombre_clave (nombre_clave);
