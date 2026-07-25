<#
.SYNOPSIS
  unregister-windows.ps1 — 干净卸载 khyosMarkdown 的 .md 右键菜单（零残留）。

.DESCRIPTION
  删除 register-windows.ps1 写入的全部 HKCU 注册项，不留任何残留键值。
  与注册脚本对称，仅操作 HKEY_CURRENT_USER，无需管理员权限。
#>

$ErrorActionPreference = 'Stop'

$exts = @('.md', '.markdown')
$removed = 0
foreach ($ext in $exts) {
  $shellKey = "HKCU:\Software\Classes\SystemFileAssociations\$ext\shell\khyosMarkdown"
  if (Test-Path $shellKey) {
    Remove-Item -Path $shellKey -Recurse -Force
    Write-Host "  [unregister] 已移除  $ext"
    $removed++
  } else {
    Write-Host "  [unregister] 未注册  $ext（跳过）"
  }
}

# ---- 清除「打开方式」ProgID 及其 OpenWithProgids 挂载点（与注册脚本对称）----
$progId = 'KhyOS.Markdown'
foreach ($ext in $exts) {
  $owpKey = "HKCU:\Software\Classes\$ext\OpenWithProgids"
  if ((Test-Path $owpKey) -and ($null -ne (Get-ItemProperty -Path $owpKey -Name $progId -ErrorAction SilentlyContinue))) {
    Remove-ItemProperty -Path $owpKey -Name $progId -Force
    Write-Host "  [unregister] 已移除  $ext  OpenWithProgids\$progId"
    $removed++
    # 若 OpenWithProgids 已空则一并清除，避免残留空键。
    if (-not (Get-Item -Path $owpKey).Property) { Remove-Item -Path $owpKey -Force }
  } else {
    Write-Host "  [unregister] 未注册  $ext  OpenWithProgids\$progId（跳过）"
  }
}

$progIdKey = "HKCU:\Software\Classes\$progId"
if (Test-Path $progIdKey) {
  Remove-Item -Path $progIdKey -Recurse -Force
  Write-Host "  [unregister] 已移除  ProgID $progId"
  $removed++
} else {
  Write-Host "  [unregister] 未注册  ProgID $progId（跳过）"
}

# ---- 清除「建议的应用」Applications\<app> 注册（与 register 的 SupportedTypes 段对称，零残留）----
$appKey  = 'khyos-md-launch.vbs'
$appBase = "HKCU:\Software\Classes\Applications\$appKey"
if (Test-Path $appBase) {
  Remove-Item -Path $appBase -Recurse -Force
  Write-Host "  [unregister] 已移除  Applications\$appKey（建议的应用）"
  $removed++
} else {
  Write-Host "  [unregister] 未注册  Applications\$appKey（跳过）"
}

Write-Host ''
if ($removed -gt 0) { Write-Host '  [unregister] 完成，右键菜单已清除，零残留。' }
else { Write-Host '  [unregister] 无可清除项（此前未注册）。' }
