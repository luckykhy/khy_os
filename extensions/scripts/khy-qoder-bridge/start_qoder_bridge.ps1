# start_qoder_bridge.ps1
# Idempotent launcher for qoder-bridge: only starts it if port 3000 is not
# already listening. Intended to be triggered from the Windows Startup folder
# (see install_autostart.ps1) so the bridge survives reboots without manual
# intervention and without requiring administrator privileges.

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$bridgeScript = Join-Path $scriptDir 'qoder_bridge.py'
$logDir = Join-Path $scriptDir 'logs'
$stdoutLog = Join-Path $logDir 'bridge_stdout.log'
$stderrLog = Join-Path $logDir 'bridge_stderr.log'
$port = 3000

if (-not (Test-Path $logDir)) {
    New-Item -ItemType Directory -Path $logDir -Force | Out-Null
}

$listening = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
if ($listening) {
    exit 0
}

$pythonExe = (Get-Command pythonw.exe -ErrorAction SilentlyContinue).Source
if (-not $pythonExe) {
    $pythonExe = (Get-Command python.exe -ErrorAction SilentlyContinue).Source
}
if (-not $pythonExe) {
    Add-Content -Path $stderrLog -Value "$(Get-Date -Format o) start_qoder_bridge: python interpreter not found on PATH"
    exit 1
}

Start-Process -FilePath $pythonExe `
    -ArgumentList "`"$bridgeScript`"" `
    -WindowStyle Hidden `
    -RedirectStandardOutput $stdoutLog `
    -RedirectStandardError $stderrLog
