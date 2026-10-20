CREATE TABLE print_agents (
 id INTEGER PRIMARY KEY AUTO_INCREMENT,
 nombre VARCHAR(191) NOT NULL,
 sucursal_id INTEGER NOT NULL,
 token_hash CHAR(64) NOT NULL UNIQUE,
 activo INTEGER NOT NULL DEFAULT 1,
 last_seen VARCHAR(32),
 FOREIGN KEY (sucursal_id) REFERENCES sucursales(id)
) ENGINE=InnoDB;
CREATE TABLE printers (
 id INTEGER PRIMARY KEY AUTO_INCREMENT,
 agent_id INTEGER NOT NULL,
 nombre VARCHAR(191) NOT NULL,
 queue_name VARCHAR(191) NOT NULL,
 language VARCHAR(4) NOT NULL,
 dpi INTEGER NOT NULL,
 offset_x DECIMAL(8,2) NOT NULL DEFAULT 0,
 offset_y DECIMAL(8,2) NOT NULL DEFAULT 0,
 gap_mm DECIMAL(8,2) NOT NULL DEFAULT 3,
 activo INTEGER NOT NULL DEFAULT 1,
 FOREIGN KEY (agent_id) REFERENCES print_agents(id),
 CHECK (language IN ('ZPL','TSPL')),
 CHECK (dpi IN (203,300))
) ENGINE=InnoDB;
CREATE TABLE print_jobs (
 id CHAR(36) PRIMARY KEY,
 request_key VARCHAR(64) NOT NULL,
 empleado_id INTEGER NOT NULL,
 printer_id INTEGER NOT NULL,
 items JSON NOT NULL,
 payload MEDIUMTEXT NOT NULL,
 status VARCHAR(16) NOT NULL DEFAULT 'pending',
 claim_token CHAR(36),
 claimed_at DATETIME,
 created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
 updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
 error TEXT,
 UNIQUE KEY request_once (empleado_id,request_key),
 FOREIGN KEY (empleado_id) REFERENCES empleados(id),
 FOREIGN KEY (printer_id) REFERENCES printers(id),
 INDEX pending_jobs (printer_id,status,created_at),
 CHECK (status IN ('pending','claimed','submitted','uncertain','failed'))
) ENGINE=InnoDB;
CREATE TABLE instalacion_evidencias (
 id CHAR(36) PRIMARY KEY,
 instalacion_id INTEGER NOT NULL,
 empleado_id INTEGER NOT NULL,
 filename VARCHAR(191) NOT NULL UNIQUE,
 bytes INTEGER NOT NULL,
 created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
 vinculada INTEGER NOT NULL DEFAULT 0,
 FOREIGN KEY (instalacion_id) REFERENCES instalaciones(id),
 FOREIGN KEY (empleado_id) REFERENCES empleados(id),
 INDEX evidence_order (instalacion_id,vinculada)
) ENGINE=InnoDB;
