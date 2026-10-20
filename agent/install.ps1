#Requires -RunAsAdministrator
param([Parameter(Mandatory=$true)][string]$ServerUrl,
      [Parameter(Mandatory=$true)][string[]]$AllowedQueues,
      [string]$PublishDir = "$PSScriptRoot\publish")
$ErrorActionPreference = 'Stop'
if (([uri]$ServerUrl).Scheme -ne 'https') { throw 'ServerUrl debe usar HTTPS.' }
$destination = Join-Path $env:ProgramFiles 'TiendaRetailLabelAgent'
$token = Read-Host 'Credencial del agente (mostrada una sola vez por la web)' -AsSecureString
$plainToken = [System.Net.NetworkCredential]::new('', $token).Password
if (Get-Service TiendaRetailLabels -ErrorAction SilentlyContinue) { Stop-Service TiendaRetailLabels }
New-Item -ItemType Directory -Path $destination -Force | Out-Null
Copy-Item "$PublishDir\*" $destination -Recurse -Force
@{ServerUrl=$ServerUrl; AgentToken=$plainToken; AllowedQueues=@($AllowedQueues)} | ConvertTo-Json | Set-Content (Join-Path $destination 'appsettings.json') -Encoding UTF8
$plainToken = $null
# Protect both credentials and the durable journal from ordinary users.
& icacls.exe $destination /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' /T | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'No se pudieron proteger las credenciales.' }
$binary = '"' + (Join-Path $destination 'LabelAgent.exe') + '"'
if (-not (Get-Service TiendaRetailLabels -ErrorAction SilentlyContinue)) {
  New-Service -Name TiendaRetailLabels -BinaryPathName $binary -DisplayName 'Tienda Retail - Etiquetas' -StartupType Automatic | Out-Null
}
& sc.exe failure TiendaRetailLabels reset= 86400 actions= restart/10000/restart/30000/restart/60000 | Out-Null
Start-Service TiendaRetailLabels
Write-Host 'Agente instalado. En la web, configura la cola con su nombre exacto de Windows.'
