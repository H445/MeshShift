#Requires -Version 5.1
<#
.SYNOPSIS
    Launch the MeshShift web app development server.

.DESCRIPTION
    Starts the shared Node/Vite launcher from the repository root. Any
    arguments are forwarded to Vite.

.EXAMPLE
    .\start.ps1
    .\start.ps1 --port 5180 --open
#>

$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSCommandPath
$devScript = Join-Path $projectRoot 'scripts\dev.mjs'
$nodeCommand = Get-Command node -ErrorAction SilentlyContinue

if (-not $nodeCommand) {
    Write-Error 'MeshShift requires Node.js 20 or newer.'
    exit 1
}

& $nodeCommand.Source $devScript @args
exit $LASTEXITCODE
