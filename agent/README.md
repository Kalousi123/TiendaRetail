# Agente de etiquetas para Windows

El agente consulta trabajos del servidor por HTTPS, evita reclamar trabajos ya enviados y despacha su contenido al spooler de Windows en tipo RAW. La cola debe aceptar el lenguaje configurado (ZPL o TSPL). La credencial se muestra una sola vez al dar de alta el agente; solo queda guardada como hash en MySQL y se puede revocar desde la web.

Para compilar el paquete autocontenido con .NET SDK 8:

```powershell
dotnet publish .\agent\LabelAgent\LabelAgent.csproj -c Release -r win-x64 --self-contained true -o .\agent\publish
```

Abre PowerShell como administrador y ejecuta:

```powershell
.\agent\install.ps1 -ServerUrl https://tienda.example.com -AllowedQueues "Nombre exacto de la impresora en Windows"
```

El instalador solicita la credencial oculta, limita permisos de credencial, ejecutable y bitácora al sistema y administradores, crea un servicio de inicio automático y configura intentos de recuperación. La bitácora no incluye la clave ni el contenido de las etiquetas. El estado de conexión se ve en Configuración → Impresión.

Si la PC se interrumpe después de empezar el envío, el agente guarda la operación antes de imprimir y la informa como incierta al reconectar, sin repetirla. La interfaz ofrece una reimpresión expresa tras advertir que se compruebe la cola.

Usa una cuenta administradora al instalar; no configures como URL pública una dirección HTTP. Autoriza solo nombres de cola realmente instalados en esa PC.
