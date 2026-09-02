$ErrorActionPreference = "Stop"
$dev = Get-PnpDevice | Where-Object { $_.InstanceId -match 'VID_339B&PID_107D&MI_02' }
if (-not $dev) {
  Write-Host "HDB Interface not found. Phone may not be in MTP mode."
  exit 1
}
Write-Host "Found: $($dev.InstanceId) Status=$($dev.Status) Class=$($dev.Class)"
if ($dev.Status -eq 'OK') {
  Write-Host "Already OK. Doing nothing."
  exit 0
}
Write-Host "Disabling..."
$dev | Disable-PnpDevice -Confirm:$false
Start-Sleep -Seconds 3
Write-Host "Re-enabling..."
$dev | Enable-PnpDevice -Confirm:$false
Start-Sleep -Seconds 3
$dev2 = Get-PnpDevice -InstanceId $dev.InstanceId
Write-Host "After reset: Status=$($dev2.Status)"
