# Tienda Retail

Aplicación de punto de venta, inventario e instalaciones. Requiere Node.js 22.5+ y MySQL 8.4.

## Instalación

1. Configura una base MySQL vacía, crea un usuario de aplicación con privilegios sobre esa base y copia `.env.example` a `.env`. Establece las credenciales con `DB_*`; para producción usa un proveedor HTTPS y establece `DB_SSL=true` al conectar con MySQL remoto. Si la aplicación está detrás de un proxy que termina HTTPS, define `TRUST_PROXY=1` y configura el proxy para enviar `X-Forwarded-Proto: https`; las cookies de sesión usan `Secure` solo en conexiones HTTPS.
2. Ejecuta `npm ci` y después `npm run db:migrate`.
3. Si comienzas con una base vacía, ejecuta `npm run db:admin` en una terminal interactiva para crear el primer administrador con contraseña oculta. Si importas los datos actuales, conserva los usuarios existentes y omite este paso. Para cambiarle la clave a un administrador sin borrarlo, usa `npm run db:admin:clave`: la cuenta conserva usuario, id y permisos.
4. Inicia con `npm start`. La aplicación no crea usuarios ni datos de muestra al arrancar.
5. Publica la web por HTTPS para permitir que los teléfonos usen la cámara. Conserva `data/evidence` en almacenamiento persistente y configura respaldos de MySQL y de las fotos.

## Conservar SQLite

Detén las escrituras de la tienda, realiza un respaldo propio y ejecuta primero `node scripts/verify-sqlite.js /ruta/a/tienda.db`. El verificador lee SQLite en modo de solo lectura, crea una instantánea consistente de su WAL y prueba la importación y la validación en una base temporal. No toca la base MySQL configurada para la aplicación. Para importar los datos reales, crea una base vacía, exporta `DB_NAME` para apuntar a ella y ejecuta `npm run db:import -- /ruta/a/tienda.db /ruta/segura/backups`. El importador confirma por fila y hash SHA-256 que todas las tablas coinciden y revierte cualquier fallo. Retén el original hasta validar una puesta en marcha.

Si varias personas trabajan en la tienda, mantenla en modo de mantenimiento durante el volcado y la importación para evitar escrituras posteriores en SQLite.

## Nombres de producto

Cada producto tiene un nombre único, y lo es de verdad: la comparación ignora mayúsculas, tildes y espacios sobrantes, así que "Cinta aislante", "CINTA  AISLANTE" y "Cinta  Aislante" son la misma mercadería. El nombre de un producto archivado (desactivado porque ya tiene ventas) sigue reservado: si el artículo volviera a salir, aparecería como producto nuevo con todo su stock al lado del que ya tiene historia. La validación vive en la API y en un índice único sobre la columna generada `productos.nombre_clave`, de modo que ni una importación ni un script pueden dejar dos productos con el mismo nombre.

## Impresión de etiquetas

En la web, configura un agente con una sucursal, copia la credencial que aparece una sola vez, configura la impresora y elige su lenguaje y resolución. El perfil admite etiquetas 100 × 150 mm, ZPL/TSPL y 203/300 dpi; los ajustes horizontales y verticales se indican en milímetros. La PC Windows necesita una cola de impresión que acepte el lenguaje elegido en modo RAW. Las marcas de impresora traducen ZPL/TSPL a resoluciones y formatos propios, así que comprueba una etiqueta de prueba, el tamaño, el margen, la separación y el lector antes de imprimir tiradas.

En Windows, instala el agente siguiendo [agent/README.md](agent/README.md). La web muestra si el agente está conectado, el estado de la cola y los errores informados. El estado "Enviado" confirma que Windows aceptó los bytes; la cola no certifica que haya salido una etiqueta.

## Etiquetas en PDF

Si no hay impresora a mano, cada producto descarga su etiqueta con el botón "⬇ Etiqueta PDF" de la lista, el botón "⬇ Exportar etiquetas en PDF" arma un solo archivo con una etiqueta de cada producto que se está viendo (con los filtros de la lista puestos), y la ventana de Etiquetas exporta a PDF lo que muestra su buscador y las cantidades de esa pantalla. El archivo lo arma el servidor sin librerías externas: reutiliza el mismo códec Code 128 que la vista previa e incluye el código legible bajo las barras. El selector "Hoja del PDF" ofrece cuatro papeles y dice cuántos caben en cada uno, porque es la pregunta que uno se hace al elegir: A4 en 2 × 5 etiquetas de 100 × 50 mm (10 por hoja), hoja de etiquetas en 3 × 7 de 63.5 × 38.1 mm con las guías por donde se corta (21 por hoja), A4 con dos etiquetas de 100 × 150 mm y una etiqueta de 100 × 150 mm por página. El contador de la ventana dice cuántas hojas de papel van a salir. Las hojas con varias etiquetas imprimen nombre, código de barras, código legible y precio; la de una sola por página es la de bobina y suma el contenido. Sin elegir hoja, la exportación usa la densa. `GET /api/impresion/etiquetas/formatos` devuelve esa lista para que el selector no tenga que repetirla. Con el agente instalado, esa misma lista se sigue mandando a la impresora térmica en su papel de 100 × 150 mm.

## Fotos de instalación

Para cambiar una instalación a completada, adjunta entre una y cinco fotos JPEG, PNG o WebP de hasta 10 MB. Se normalizan en JPEG y se guardan en `UPLOAD_DIR` (por defecto `data/evidence`) con acceso autenticado. El servidor elimina diariamente las cargas abandonadas y los archivos huérfanos; `npm run evidence:cleanup` permite lanzar la limpieza manualmente.

## Desarrollo y pruebas

`npm test` crea una base MySQL temporal con nombre `retail_test_*`, importa datos ficticios, ejecuta API, integración y pruebas de Chromium y elimina al final la base y los archivos temporales. Configura `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD` o `DB_SOCKET` para que el arnés alcance un MySQL dedicado. Requiere Chromium en `/usr/bin/chromium`. `npm run test:unit` valida ZPL/TSPL, el PDF de etiquetas, el tamaño de página y ausencia de diálogos nativos.
