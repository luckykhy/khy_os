# install_autostart.ps1
# Run once per machine after cloning the repo (no admin rights required).
# Dynamically generates a path-correct silent_launch.vbs for THIS checkout
# and installs it into the current user's Startup folder, so qoder_bridge.py
# auto-starts on every login. Safe to re-run (idempotent, always overwrites
# with the current checkout path).

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$startPs1 = Join-Path $scriptDir 'start_qoder_bridge.ps1'
$vbsPath = Join-Path $scriptDir 'silent_launch.vbs'

$vbsLines = @(
    'Dim sh : Set sh = CreateObject("WScript.Shell")'
    ('sh.Run "powershell -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File ""' + $startPs1 + '""", 0, False')
)
Set-Content -Path $vbsPath -Value $vbsLines -Encoding ASCII

$startupDir = [System.Environment]::GetFolderPath('Startup')
$dest = Join-Path $startupDir 'KhyOS-QoderBridge.vbs'
Copy-Item -Path $vbsPath -Destination $dest -Force

Write-Output "Autostart installed: $dest"
Write-Output "  -> triggers: $startPs1"
Write-Output "  -> bridge script: $(Join-Path $scriptDir 'qoder_bridge.py')"
Write-Output "Test it now with: wscript.exe `"$dest`""
