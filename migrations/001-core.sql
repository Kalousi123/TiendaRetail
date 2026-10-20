CREATE TABLE IF NOT EXISTS categorias (
  id INTEGER PRIMARY KEY AUTO_INCREMENT,
  nombre VARCHAR(191) NOT NULL UNIQUE,
  descripcion TEXT DEFAULT (''),
  creado_en VARCHAR(191) NOT NULL DEFAULT (DATE_FORMAT(NOW(), '%Y-%m-%d %H:%i:%s'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
CREATE TABLE IF NOT EXISTS sucursales (
  id INTEGER PRIMARY KEY AUTO_INCREMENT,
  codigo VARCHAR(191) NOT NULL UNIQUE,
  nombre VARCHAR(191) NOT NULL,
  direccion TEXT DEFAULT (''),
  telefono TEXT DEFAULT (''),
  propietario_nombre TEXT DEFAULT (''),
  propietario_dni TEXT DEFAULT (''),
  propietario_telefono TEXT DEFAULT (''),
  alquiler_mensual DECIMAL(18,4) NOT NULL DEFAULT 0,
  dia_alquiler INTEGER NOT NULL DEFAULT 0,
  notas TEXT DEFAULT (''),
  activo INTEGER NOT NULL DEFAULT 1,
  creado_en VARCHAR(191) NOT NULL DEFAULT (DATE_FORMAT(NOW(), '%Y-%m-%d %H:%i:%s'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
CREATE TABLE IF NOT EXISTS gastos_sucursal (
  id INTEGER PRIMARY KEY AUTO_INCREMENT,
  sucursal_id INTEGER NOT NULL ,
  categoria VARCHAR(191) NOT NULL DEFAULT 'otros',
  concepto TEXT NOT NULL DEFAULT (''),
  proveedor TEXT DEFAULT (''),
  monto DECIMAL(18,4) NOT NULL DEFAULT 0,
  fecha VARCHAR(191) NOT NULL DEFAULT (DATE_FORMAT(NOW(), '%Y-%m-%d %H:%i:%s')),
  mes_cobro VARCHAR(191) NOT NULL DEFAULT '',
  documento TEXT DEFAULT (''),
  notas TEXT DEFAULT (''),
  empleado_id INTEGER ,
  creado_en VARCHAR(191) NOT NULL DEFAULT (DATE_FORMAT(NOW(), '%Y-%m-%d %H:%i:%s'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
CREATE TABLE IF NOT EXISTS productos (
  id INTEGER PRIMARY KEY AUTO_INCREMENT,
  codigo VARCHAR(191) NOT NULL UNIQUE,
  codigo_barras VARCHAR(191),
  nombre VARCHAR(191) NOT NULL,
  categoria_id INTEGER ,
  descripcion TEXT DEFAULT (''),
  costo DECIMAL(18,4) NOT NULL DEFAULT 0,
  precio DECIMAL(18,4) NOT NULL DEFAULT 0,
  stock DECIMAL(18,4) NOT NULL DEFAULT 0,
  stock_minimo DECIMAL(18,4) NOT NULL DEFAULT 5,
  stock_reservado DECIMAL(18,4) NOT NULL DEFAULT 0,
  unidad TEXT NOT NULL DEFAULT ('pza'),
  contenido DECIMAL(18,4) NOT NULL DEFAULT 1,
  iva_aplicable INTEGER NOT NULL DEFAULT 1,
  requiere_instalacion INTEGER NOT NULL DEFAULT 0,
  precio_instalacion DECIMAL(18,4) NOT NULL DEFAULT 0,
  dias_instalacion INTEGER NOT NULL DEFAULT 1,
  activo INTEGER NOT NULL DEFAULT 1,
  creado_en VARCHAR(191) NOT NULL DEFAULT (DATE_FORMAT(NOW(), '%Y-%m-%d %H:%i:%s'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
CREATE TABLE IF NOT EXISTS clientes (
  id INTEGER PRIMARY KEY AUTO_INCREMENT,
  codigo VARCHAR(191) NOT NULL UNIQUE,
  nombre VARCHAR(191) NOT NULL,
  documento TEXT DEFAULT (''),
  telefono TEXT DEFAULT (''),
  email TEXT DEFAULT (''),
  direccion TEXT DEFAULT (''),
  saldo DECIMAL(18,4) NOT NULL DEFAULT 0,
  activo INTEGER NOT NULL DEFAULT 1,
  creado_en VARCHAR(191) NOT NULL DEFAULT (DATE_FORMAT(NOW(), '%Y-%m-%d %H:%i:%s'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
CREATE TABLE IF NOT EXISTS proveedores (
  id INTEGER PRIMARY KEY AUTO_INCREMENT,
  nombre VARCHAR(191) NOT NULL,
  contacto TEXT DEFAULT (''),
  documento TEXT DEFAULT (''),
  telefono TEXT DEFAULT (''),
  email TEXT DEFAULT (''),
  direccion TEXT DEFAULT (''),
  activo INTEGER NOT NULL DEFAULT 1,
  creado_en VARCHAR(191) NOT NULL DEFAULT (DATE_FORMAT(NOW(), '%Y-%m-%d %H:%i:%s'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
CREATE TABLE IF NOT EXISTS empleados (
  id INTEGER PRIMARY KEY AUTO_INCREMENT,
  nombre VARCHAR(191) NOT NULL,
  usuario VARCHAR(191) NOT NULL UNIQUE,
  clave_hash TEXT NOT NULL,
  rol TEXT NOT NULL CHECK (rol IN ('admin','asesor','tecnico')),
  sucursal_id INTEGER ,
  telefono TEXT DEFAULT (''),
  activo INTEGER NOT NULL DEFAULT 1,
  creado_en VARCHAR(191) NOT NULL DEFAULT (DATE_FORMAT(NOW(), '%Y-%m-%d %H:%i:%s'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
CREATE TABLE IF NOT EXISTS ventas (
  id INTEGER PRIMARY KEY AUTO_INCREMENT,
  numero VARCHAR(191) NOT NULL UNIQUE,
  fecha VARCHAR(191) NOT NULL DEFAULT (DATE_FORMAT(NOW(), '%Y-%m-%d %H:%i:%s')),
  cliente_id INTEGER ,
  empleado_id INTEGER ,
  sucursal_id INTEGER ,
  subtotal DECIMAL(18,4) NOT NULL DEFAULT 0,
  descuento DECIMAL(18,4) NOT NULL DEFAULT 0,
  impuestos DECIMAL(18,4) NOT NULL DEFAULT 0,
  total DECIMAL(18,4) NOT NULL DEFAULT 0,
  costo_total DECIMAL(18,4) NOT NULL DEFAULT 0,
  metodo_pago TEXT NOT NULL DEFAULT ('efectivo'),
  monto_pagado DECIMAL(18,4) NOT NULL DEFAULT 0,
  estado TEXT NOT NULL DEFAULT ('completada') CHECK (estado IN ('completada','anulada')),
  notas TEXT DEFAULT ('')
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
CREATE TABLE IF NOT EXISTS venta_items (
  id INTEGER PRIMARY KEY AUTO_INCREMENT,
  venta_id INTEGER NOT NULL ,
  producto_id INTEGER ,
  nombre VARCHAR(191) NOT NULL,
  cantidad DECIMAL(18,4) NOT NULL,
  precio DECIMAL(18,4) NOT NULL,
  precio_instalacion DECIMAL(18,4) NOT NULL DEFAULT 0,
  costo DECIMAL(18,4) NOT NULL DEFAULT 0,
  subtotal DECIMAL(18,4) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
CREATE TABLE IF NOT EXISTS compras (
  id INTEGER PRIMARY KEY AUTO_INCREMENT,
  numero VARCHAR(191) NOT NULL UNIQUE,
  fecha VARCHAR(191) NOT NULL DEFAULT (DATE_FORMAT(NOW(), '%Y-%m-%d %H:%i:%s')),
  proveedor_id INTEGER ,
  empleado_id INTEGER ,
  subtotal DECIMAL(18,4) NOT NULL DEFAULT 0,
  impuestos DECIMAL(18,4) NOT NULL DEFAULT 0,
  total DECIMAL(18,4) NOT NULL DEFAULT 0,
  estado TEXT NOT NULL DEFAULT ('pendiente') CHECK (estado IN ('pendiente','recibida','cancelada')),
  notas TEXT DEFAULT ('')
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
CREATE TABLE IF NOT EXISTS compra_items (
  id INTEGER PRIMARY KEY AUTO_INCREMENT,
  compra_id INTEGER NOT NULL ,
  producto_id INTEGER ,
  nombre VARCHAR(191) NOT NULL,
  cantidad DECIMAL(18,4) NOT NULL,
  cantidad_recibida DECIMAL(18,4) NOT NULL DEFAULT 0,
  costo DECIMAL(18,4) NOT NULL,
  subtotal DECIMAL(18,4) NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
CREATE TABLE IF NOT EXISTS instalaciones (
  id INTEGER PRIMARY KEY AUTO_INCREMENT,
  codigo VARCHAR(191) NOT NULL UNIQUE,
  fecha VARCHAR(191) NOT NULL DEFAULT (DATE_FORMAT(NOW(), '%Y-%m-%d %H:%i:%s')),
  venta_id INTEGER ,
  cliente_id INTEGER ,
  sucursal_id INTEGER ,
  producto_id INTEGER ,
  producto_nombre TEXT NOT NULL,
  cantidad DECIMAL(18,4) NOT NULL DEFAULT 1,
  tecnico_id INTEGER ,
  asesor_id INTEGER ,
  direccion TEXT NOT NULL DEFAULT (''),
  contacto TEXT DEFAULT (''),
  fecha_programada VARCHAR(191) NOT NULL DEFAULT '',
  hora_programada TEXT NOT NULL DEFAULT (''),
  estado TEXT NOT NULL DEFAULT ('pendiente') CHECK (estado IN ('pendiente','programada','material_retirado','en_ruta','en_progreso','completada','cancelada')),
  reserva_stock INTEGER NOT NULL DEFAULT 0,
  costo DECIMAL(18,4) NOT NULL DEFAULT 0,
  adelanto DECIMAL(18,4) NOT NULL DEFAULT 0,
  saldo_pagado DECIMAL(18,4) NOT NULL DEFAULT 0,
  fecha_pago_saldo VARCHAR(191) NOT NULL DEFAULT '',
  saldo_recibido_por INTEGER ,
  monto_financiado DECIMAL(18,4) NOT NULL DEFAULT 0,
  notas TEXT DEFAULT (''),
  fecha_inicio VARCHAR(191) DEFAULT '',
  fecha_fin VARCHAR(191) DEFAULT ''
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
CREATE TABLE IF NOT EXISTS instalacion_historial (
  id INTEGER PRIMARY KEY AUTO_INCREMENT,
  instalacion_id INTEGER NOT NULL ,
  estado TEXT NOT NULL,
  comentario TEXT DEFAULT (''),
  empleado_id INTEGER ,
  fecha VARCHAR(191) NOT NULL DEFAULT (DATE_FORMAT(NOW(), '%Y-%m-%d %H:%i:%s'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
CREATE TABLE IF NOT EXISTS instalacion_items (
  id INTEGER PRIMARY KEY AUTO_INCREMENT,
  instalacion_id INTEGER NOT NULL ,
  producto_id INTEGER ,
  nombre VARCHAR(191) NOT NULL,
  cantidad_prevista DECIMAL(18,4) NOT NULL DEFAULT 0,
  modo_retiro TEXT NOT NULL DEFAULT ('pza') CHECK (modo_retiro IN ('pza','caja')),
  contenido_empaque DECIMAL(18,4) NOT NULL DEFAULT 1,
  cantidad_entregada DECIMAL(18,4) NOT NULL DEFAULT 0,
  devueltas DECIMAL(18,4) NOT NULL DEFAULT 0,
  faltantes DECIMAL(18,4) NOT NULL DEFAULT 0,
  fecha_entrega VARCHAR(191) NOT NULL DEFAULT '',
  registrado_por INTEGER 
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
CREATE TABLE IF NOT EXISTS movimientos (
  id INTEGER PRIMARY KEY AUTO_INCREMENT,
  producto_id INTEGER ,
  sucursal_id INTEGER ,
  tipo TEXT NOT NULL CHECK (tipo IN ('entrada','salida','ajuste','venta','compra')),
  cantidad DECIMAL(18,4) NOT NULL,
  stock_despues DECIMAL(18,4) NOT NULL,
  referencia TEXT DEFAULT (''),
  empleado_id INTEGER ,
  notas TEXT DEFAULT (''),
  fecha VARCHAR(191) NOT NULL DEFAULT (DATE_FORMAT(NOW(), '%Y-%m-%d %H:%i:%s'))
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;
CREATE TABLE IF NOT EXISTS configuracion (
  clave VARCHAR(191) PRIMARY KEY,
  valor TEXT NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_bin;

ALTER TABLE gastos_sucursal ADD CONSTRAINT fk_gastos_sucursal_sucursal_id FOREIGN KEY (sucursal_id) REFERENCES sucursales(id) ON DELETE CASCADE;
ALTER TABLE gastos_sucursal ADD CONSTRAINT fk_gastos_sucursal_empleado_id FOREIGN KEY (empleado_id) REFERENCES empleados(id) ON DELETE SET NULL;
ALTER TABLE productos ADD CONSTRAINT fk_productos_categoria_id FOREIGN KEY (categoria_id) REFERENCES categorias(id) ON DELETE SET NULL;
ALTER TABLE empleados ADD CONSTRAINT fk_empleados_sucursal_id FOREIGN KEY (sucursal_id) REFERENCES sucursales(id) ON DELETE SET NULL;
ALTER TABLE ventas ADD CONSTRAINT fk_ventas_cliente_id FOREIGN KEY (cliente_id) REFERENCES clientes(id) ON DELETE SET NULL;
ALTER TABLE ventas ADD CONSTRAINT fk_ventas_empleado_id FOREIGN KEY (empleado_id) REFERENCES empleados(id) ON DELETE SET NULL;
ALTER TABLE ventas ADD CONSTRAINT fk_ventas_sucursal_id FOREIGN KEY (sucursal_id) REFERENCES sucursales(id) ON DELETE SET NULL;
ALTER TABLE venta_items ADD CONSTRAINT fk_venta_items_venta_id FOREIGN KEY (venta_id) REFERENCES ventas(id) ON DELETE CASCADE;
ALTER TABLE venta_items ADD CONSTRAINT fk_venta_items_producto_id FOREIGN KEY (producto_id) REFERENCES productos(id) ON DELETE SET NULL;
ALTER TABLE compras ADD CONSTRAINT fk_compras_proveedor_id FOREIGN KEY (proveedor_id) REFERENCES proveedores(id) ON DELETE SET NULL;
ALTER TABLE compras ADD CONSTRAINT fk_compras_empleado_id FOREIGN KEY (empleado_id) REFERENCES empleados(id) ON DELETE SET NULL;
ALTER TABLE compra_items ADD CONSTRAINT fk_compra_items_compra_id FOREIGN KEY (compra_id) REFERENCES compras(id) ON DELETE CASCADE;
ALTER TABLE compra_items ADD CONSTRAINT fk_compra_items_producto_id FOREIGN KEY (producto_id) REFERENCES productos(id) ON DELETE SET NULL;
ALTER TABLE instalaciones ADD CONSTRAINT fk_instalaciones_venta_id FOREIGN KEY (venta_id) REFERENCES ventas(id) ON DELETE SET NULL;
ALTER TABLE instalaciones ADD CONSTRAINT fk_instalaciones_cliente_id FOREIGN KEY (cliente_id) REFERENCES clientes(id) ON DELETE SET NULL;
ALTER TABLE instalaciones ADD CONSTRAINT fk_instalaciones_sucursal_id FOREIGN KEY (sucursal_id) REFERENCES sucursales(id) ON DELETE SET NULL;
ALTER TABLE instalaciones ADD CONSTRAINT fk_instalaciones_producto_id FOREIGN KEY (producto_id) REFERENCES productos(id) ON DELETE SET NULL;
ALTER TABLE instalaciones ADD CONSTRAINT fk_instalaciones_tecnico_id FOREIGN KEY (tecnico_id) REFERENCES empleados(id) ON DELETE SET NULL;
ALTER TABLE instalaciones ADD CONSTRAINT fk_instalaciones_asesor_id FOREIGN KEY (asesor_id) REFERENCES empleados(id) ON DELETE SET NULL;
ALTER TABLE instalaciones ADD CONSTRAINT fk_instalaciones_saldo_recibido_por FOREIGN KEY (saldo_recibido_por) REFERENCES empleados(id) ON DELETE SET NULL;
ALTER TABLE instalacion_historial ADD CONSTRAINT fk_instalacion_historial_instalacion_id FOREIGN KEY (instalacion_id) REFERENCES instalaciones(id) ON DELETE CASCADE;
ALTER TABLE instalacion_historial ADD CONSTRAINT fk_instalacion_historial_empleado_id FOREIGN KEY (empleado_id) REFERENCES empleados(id) ON DELETE SET NULL;
ALTER TABLE instalacion_items ADD CONSTRAINT fk_instalacion_items_instalacion_id FOREIGN KEY (instalacion_id) REFERENCES instalaciones(id) ON DELETE CASCADE;
ALTER TABLE instalacion_items ADD CONSTRAINT fk_instalacion_items_producto_id FOREIGN KEY (producto_id) REFERENCES productos(id) ON DELETE SET NULL;
ALTER TABLE instalacion_items ADD CONSTRAINT fk_instalacion_items_registrado_por FOREIGN KEY (registrado_por) REFERENCES empleados(id) ON DELETE SET NULL;
ALTER TABLE movimientos ADD CONSTRAINT fk_movimientos_producto_id FOREIGN KEY (producto_id) REFERENCES productos(id) ON DELETE SET NULL;
ALTER TABLE movimientos ADD CONSTRAINT fk_movimientos_sucursal_id FOREIGN KEY (sucursal_id) REFERENCES sucursales(id) ON DELETE SET NULL;
ALTER TABLE movimientos ADD CONSTRAINT fk_movimientos_empleado_id FOREIGN KEY (empleado_id) REFERENCES empleados(id) ON DELETE SET NULL;
CREATE UNIQUE INDEX ux_productos_codigo_barras ON productos(codigo_barras);
CREATE INDEX idx_ventas_fecha ON ventas(fecha);
CREATE INDEX idx_productos_nombre ON productos(nombre);
