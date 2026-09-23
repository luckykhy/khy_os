$t = $null; for ($i = 0; $i -lt 10; $i++) { try { $t = Get-Clipboard -Raw; break } catch { Start-Sleep -Milliseconds 200 } }
if ($null -eq $t) { $t = '' }
[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($t))
