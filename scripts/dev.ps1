#Requires -Version 5.1
<#
.SYNOPSIS
    Launch the gltf-to-fbx dev server (Vite + HMR).

.DESCRIPTION
    - Frees port 5173 if anything is already bound to it (with a warning).
    - Starts Vite via `node scripts/dev.mjs` in the project root.
    - Forwards Ctrl-C / SIGINT to the child process for clean shutdown.

.EXAMPLE
    .\scripts\dev.ps1
    .\scripts\dev.ps1 -Port 5180
#>
param(
    [int]$Port = 5173
)

$ErrorActionPreference = 'Stop'

# Resolve the project root (parent of this script's directory).
$projectRoot = Resolve-Path (Join-Path (Split-Path -Parent $PSCommandPath) '..')
Set-Location -Path $projectRoot

# --- Free the port if something is already listening on it ---------------
$existing = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if ($existing) {
    $pids = $existing | Select-Object -ExpandProperty OwningProcess -Unique | Where-Object { $_ -gt 4 }
    if ($pids) {
        Write-Warning "Port $Port is in use. Killing old process(es): $($pids -join ', ')"
        foreach ($p in $pids) {
            try { Stop-Process -Id $p -Force -ErrorAction Stop }
            catch { Write-Warning "  could not kill PID $p ($($_.Exception.Message))" }
        }
        Start-Sleep -Milliseconds 400
    }
}

# --- Launch Vite --------------------------------------------------------
$nodeExe = (Get-Command node.exe -ErrorAction Stop).Source
$devScript = Join-Path $projectRoot 'scripts\dev.mjs'

$env:G2F_ASSIMP_DIR = if ($env:G2F_ASSIMP_DIR) { $env:G2F_ASSIMP_DIR } else {
    Join-Path $projectRoot 'src\client\public'
}

Write-Host ""
Write-Host "  Starting Vite on http://localhost:$Port/  (Ctrl-C to stop)" -ForegroundColor Cyan
Write-Host "  Working dir: $projectRoot"
Write-Host ""

# Pass the absolute path of dev.mjs so node finds it regardless of CWD.
# -PassThru + WaitForExit propagates the exit code; the Ctrl-C handler below
# forwards the cancellation to the child.
$proc = Start-Process `
    -FilePath $nodeExe `
    -ArgumentList "`"$devScript`"" `
    -PassThru `
    -NoNewWindow `
    -WorkingDirectory $projectRoot

# Forward Ctrl-C / SIGINT (and PowerShell exit) to the child.
$handler = {
    if ($proc -and -not $proc.HasExited) {
        try { Stop-Process -Id $proc.Id -Force } catch {}
    }
}
try { [Console]::CancelKeyPress.Add($handler) } catch { } # no real console
Register-EngineEvent -SourceIdentifier PowerShell.Exiting -Action $handler | Out-Null

$null = $proc.WaitForExit()
exit $proc.ExitCode
