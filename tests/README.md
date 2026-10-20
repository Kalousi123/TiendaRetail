# Pruebas aisladas

Requisitos: Node.js 22.5 o posterior y Chromium en `/usr/bin/chromium`.

```sh
npm test
```

El arnés copia el código a una carpeta temporal, crea una base MySQL aislada con nombre `retail_test_*`, carga registros demo desechables y arranca el servidor en un puerto libre. Chromium usa su propio perfil. El arnés necesita permisos para crear y borrar bases en una instancia MySQL de prueba. Nunca importa la base real del proyecto.

Las pruebas cubren permisos y alcance por rol, entregas y stock, estados y cobros, y los recorridos de interfaz. Se incluyen las comprobaciones anteriores de gastos, sucursales, reportes, clientes y autocompletado del punto de venta.

- `SKIP_UI=1 npm test`: ejecutar únicamente API.
- `KEEP_TEST_ARTIFACTS=1 npm test`: conservar la copia temporal y el registro del servidor para diagnóstico; se imprime su ubicación.

Configura `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD` o `DB_SOCKET` para alcanzar el MySQL de pruebas. Las cuentas demo usan `test1234` únicamente en la base desechable. Al terminar el arnés elimina esa base y sus archivos. La suite falla si hay aserciones incumplidas o errores internos del servidor.
