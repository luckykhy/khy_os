Get-PnpDevice -PresentOnly | Where-Object { $_.InstanceId -match 'VID_339B' } | Select-Object Status,Class,FriendlyName,InstanceId | Format-Table -AutoSize -Wrap
