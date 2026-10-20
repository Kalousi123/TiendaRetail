-- Destinos de pago: saber a qué caja, cuenta o número llegó la plata.
--
-- Antes el método de pago era un texto libre que el backend.defaultaba a
-- 'efectivo' si no reconocía el valor. Eso hacía que un Yape quedara guardado
-- como efectivo sin error ni aviso, y nada registraba a qué cuenta había ido.
-- Ahora el destino es la fuente de la verdad y el método se deduce de él:
-- un pago a Yape queda como Yape porque no hay forma de escribir otra cosa.

CREATE TABLE IF NOT EXISTS destinos_pago (
  id INTEGER PRIMARY KEY AUTO_INCREMENT,
  sucursal_id INTEGER ,
  nombre VARCHAR(191) NOT NULL,
  tipo VARCHAR(191) NOT NULL CHECK (tipo IN ('efectivo','tarjeta','transferencia','yape')),
  identificador VARCHAR(191) NOT NULL DEFAULT (''),
  activo TINYINT NOT NULL DEFAULT 1,
  creado_en VARCHAR(191) NOT NULL DEFAULT (DATE_FORMAT(NOW(), '%Y-%m-%d %H:%i:%s'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

CREATE TABLE IF NOT EXISTS instalacion_pagos (
  id INTEGER PRIMARY KEY AUTO_INCREMENT,
  instalacion_id INTEGER NOT NULL ,
  fecha VARCHAR(191) NOT NULL DEFAULT (DATE_FORMAT(NOW(), '%Y-%m-%d %H:%i:%s')),
  monto DECIMAL(18,4) NOT NULL DEFAULT 0,
  destino_id INTEGER ,
  referencia VARCHAR(191) NOT NULL DEFAULT '',
  recibido_por INTEGER ,
  nota TEXT DEFAULT (''),
  creado_en VARCHAR(191) NOT NULL DEFAULT (DATE_FORMAT(NOW(), '%Y-%m-%d %H:%i:%s'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

ALTER TABLE ventas ADD COLUMN destino_id INTEGER ;
ALTER TABLE ventas ADD COLUMN referencia VARCHAR(191) NOT NULL DEFAULT '';
ALTER TABLE ventas ADD CONSTRAINT ck_ventas_metodo_pago CHECK (metodo_pago IN ('efectivo','tarjeta','transferencia','yape'));

-- Una caja por sucursal activa. El efectivo se queda donde se cobró, así que su
-- destino siempre pertenece a una sucursal. Los demás (Yape, cuentas, tarjeta)
-- pueden ser de toda la tienda, y por eso sucursal_id admite NULL.
INSERT INTO destinos_pago (sucursal_id, nombre, tipo, identificador, activo)
SELECT s.id, CONCAT('Caja ', s.nombre), 'efectivo', '', 1
FROM sucursales s
WHERE s.activo = 1
  AND NOT EXISTS (
    SELECT 1 FROM destinos_pago d WHERE d.sucursal_id = s.id AND d.tipo = 'efectivo'
  );

-- El efectivo histórico se le asigna la caja de su sucursal, que es donde
-- estuvo el dinero. Tarjeta y transferencia quedan sin destino: no sabemos a
-- qué cuenta fueron y adivinar sería peor que no saber.
UPDATE ventas v
JOIN destinos_pago d ON d.sucursal_id = v.sucursal_id AND d.tipo = 'efectivo'
SET v.destino_id = d.id
WHERE v.metodo_pago = 'efectivo' AND v.destino_id IS NULL;

CREATE INDEX idx_ventas_destino_id ON ventas (destino_id);
CREATE INDEX idx_instalacion_pagos_inst ON instalacion_pagos (instalacion_id);
CREATE INDEX idx_instalacion_pagos_destino ON instalacion_pagos (destino_id);
CREATE UNIQUE INDEX uq_destinos_sucursal_tipo_nombre ON destinos_pago (sucursal_id, tipo, nombre);

ALTER TABLE destinos_pago ADD CONSTRAINT fk_destinos_sucursal_id FOREIGN KEY (sucursal_id) REFERENCES sucursales(id) ON DELETE CASCADE;
ALTER TABLE ventas ADD CONSTRAINT fk_ventas_destino_id FOREIGN KEY (destino_id) REFERENCES destinos_pago(id) ON DELETE SET NULL;
ALTER TABLE instalacion_pagos ADD CONSTRAINT fk_inst_pagos_instalacion_id FOREIGN KEY (instalacion_id) REFERENCES instalaciones(id) ON DELETE CASCADE;
ALTER TABLE instalacion_pagos ADD CONSTRAINT fk_inst_pagos_destino_id FOREIGN KEY (destino_id) REFERENCES destinos_pago(id) ON DELETE SET NULL;
ALTER TABLE instalacion_pagos ADD CONSTRAINT fk_inst_pagos_recibido_por FOREIGN KEY (recibido_por) REFERENCES empleados(id) ON DELETE SET NULL;
