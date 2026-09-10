$WshShell = New-Object -ComObject WScript.Shell
$DesktopPath = [Environment]::GetFolderPath('Desktop')
$ShortcutPath = Join-Path $DesktopPath "KhyOS Desktop.lnk"
$AppPath = "D:\Portable\khy-os\apps\khyos-desktop"

$Shortcut = $WshShell.CreateShortcut($ShortcutPath)
$Shortcut.TargetPath = "cmd.exe"
$Shortcut.Arguments = "/c `"cd /d `"$AppPath`" && npm run dev`""
$Shortcut.WorkingDirectory = $AppPath
$Shortcut.WindowStyle = 7
$Shortcut.Description = "KhyOS Desktop - ZCode 1:1"
$Shortcut.Save()

Write-Host "========================================" -ForegroundColor Cyan
Write-Host "  Desktop shortcut created!" -ForegroundColor Green
Write-Host "  Path: $ShortcutPath" -ForegroundColor White
Write-Host "========================================" -ForegroundColor Cyan
