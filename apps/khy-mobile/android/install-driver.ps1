$ErrorActionPreference = "Stop"

# Install Google USB driver to driver store (needs admin)
$infPath = "C:\Users\25789\.khyos\android_sdk\extras\google\usb_driver\android_winusb.inf"
Write-Host "=== Installing Google USB driver to driver store ==="
Write-Host "INF: $infPath"

$isAdmin = ([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
  Write-Host "Not running as Administrator. Trying to elevate..."
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = "powershell.exe"
  $psi.Arguments = "-ExecutionPolicy Bypass -File `"$PSCommandPath`""
  $psi.Verb = "runas"
  $psi.UseShellExecute = $true
  try {
    [System.Diagnostics.Process]::Start($psi) | Out-Null
    Write-Host "Elevated process started. Re-run this script in admin context."
    exit 0
  } catch {
    Write-Host "Failed to elevate: $($_.Exception.Message)"
    exit 1
  }
}

# We are admin now
Add-Type -AssemblyName System.IO.Compression.FileSystem
$store = "$env:TEMP\googledriver"
if (Test-Path $store) { Remove-Item -Recurse -Force $store }
New-Item -ItemType Directory -Path $store | Out-Null
Copy-Item "$infPath" "$store\android_winusb.inf" -Force
Copy-Item "C:\Users\25789\.khyos\android_sdk\extras\google\usb_driver\amd64" "$store\amd64" -Recurse -Force
Copy-Item "C:\Users\25789\.khyos\android_sdk\extras\google\usb_driver\i386" "$store\i386" -Recurse -Force
Copy-Item "C:\Users\25789\.khyos\android_sdk\extras\google\usb_driver\*.cat" "$store" -Force

# Use pnputil to add to driver store
$output = pnputil /add-driver "$store\android_winusb.inf" /install 2>&1
Write-Host "pnputil output:"
$output | ForEach-Object { Write-Host "  $_" }

Write-Host "=== After install, forcing re-enumeration of HDB device ==="
$dev = Get-PnpDevice | Where-Object { $_.InstanceId -match 'VID_339B&PID_107D&MI_02' }
if ($dev) {
  Write-Host "Found HDB device. Trying Disable+Enable..."
  & devcon.exe disable "USB\VID_339B&PID_107D&MI_02*" 2>&1
  Start-Sleep -Seconds 2
  & devcon.exe enable "USB\VID_339B&PID_107D&MI_02*" 2>&1
  Start-Sleep -Seconds 3
  $dev2 = Get-PnpDevice -InstanceId $dev.InstanceId
  Write-Host "Status after: $($dev2.Status)"
}
Write-Host "=== Done ==="
