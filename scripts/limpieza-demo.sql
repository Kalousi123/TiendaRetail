/* Limpieza de datos de demostración para empezar a trabajar en serio.

   Se conservan a propósito: el administrador (id 1), la sucursal real
   (id 7, Tienda la merced), su caja en destinos_pago y las 15 filas de
   configuracion (moneda, IGV, prefijos de numeración, formatos de etiqueta).

   El orden importa: las tablas hijas van primero para no depender de los
   CASCADE, y no se desactiva FOREIGN_KEY_CHECKS porque con las comprobaciones
   apagadas MySQL no ejecuta los ON DELETE CASCADE y quedarían filas huérfanas.

   Los correlativos (P001, V-00001, códigos de barras) se calculan con MAX()
   sobre la tabla, así que vuelven a empezar en 1 con las tablas vacías. */

START TRANSACTION;

DELETE FROM print_jobs;
DELETE FROM printers;
DELETE FROM print_agents;
DELETE FROM instalacion_evidencias;
DELETE FROM instalacion_pagos;
DELETE FROM instalacion_historial;
DELETE FROM instalacion_items;
DELETE FROM ventas;
DELETE FROM compras;
DELETE FROM instalaciones;
DELETE FROM gastos_sucursal;
DELETE FROM movimientos;
DELETE FROM productos;
DELETE FROM clientes;
DELETE FROM proveedores;
DELETE FROM categorias;
DELETE FROM empleados WHERE id <> 1;
DELETE FROM sucursales WHERE id <> 7;
DELETE FROM destinos_pago WHERE sucursal_id <> 7;

/* El admin queda en la sucursal real: si se queda en una que ya no existe
   pierde el alcance de datos de su tienda. */
UPDATE empleados SET sucursal_id = 7 WHERE id = 1;

COMMIT;

/* Los identificadores vuelven a empezar donde toca. En empleados y sucursales
   no pueden ir a 1 porque las filas conservadas ya ocupan ese número. */
ALTER TABLE productos AUTO_INCREMENT = 1;
ALTER TABLE ventas AUTO_INCREMENT = 1;
ALTER TABLE compras AUTO_INCREMENT = 1;
ALTER TABLE instalaciones AUTO_INCREMENT = 1;
ALTER TABLE clientes AUTO_INCREMENT = 1;
ALTER TABLE proveedores AUTO_INCREMENT = 1;
ALTER TABLE categorias AUTO_INCREMENT = 1;
ALTER TABLE gastos_sucursal AUTO_INCREMENT = 1;
ALTER TABLE movimientos AUTO_INCREMENT = 1;
ALTER TABLE venta_items AUTO_INCREMENT = 1;
ALTER TABLE compra_items AUTO_INCREMENT = 1;
ALTER TABLE instalacion_items AUTO_INCREMENT = 1;
ALTER TABLE instalacion_historial AUTO_INCREMENT = 1;
ALTER TABLE instalacion_pagos AUTO_INCREMENT = 1;
ALTER TABLE empleados AUTO_INCREMENT = 2;
ALTER TABLE sucursales AUTO_INCREMENT = 8;
