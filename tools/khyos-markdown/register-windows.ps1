<#
.SYNOPSIS
  register-windows.ps1 — 在 Windows 注册「使用 khyosMarkdown 打开」.md 右键菜单（仅当前用户）。

.DESCRIPTION
  宪法红线4（系统纯净）：本脚本只写 HKEY_CURRENT_USER，绝不写 HKEY_LOCAL_MACHINE，
  因此无需管理员权限、不触发 UAC 弹窗。注册项指向自定位的 khyos-md-launch.vbs，
  由其隐藏式调起 node 桥接器。卸载请运行 unregister-windows.ps1，零残留。

  写入位置（用户级文件关联动词）：
    HKCU:\Software\Classes\SystemFileAssociations\.md\shell\khyosMarkdown
    HKCU:\Software\Classes\SystemFileAssociations\.markdown\shell\khyosMarkdown

  写入位置（「打开方式」列表，用户级 ProgID）：
    HKCU:\Software\Classes\KhyOS.Markdown\shell\open\command
    HKCU:\Software\Classes\.md\OpenWithProgids\KhyOS.Markdown
    HKCU:\Software\Classes\.markdown\OpenWithProgids\KhyOS.Markdown

  命令模板（红线3 路径免疫：%1 双引号包裹）：
    wscript.exe "<scriptDir>\khyos-md-launch.vbs" "%1"

.NOTES
  无任何硬编码绝对路径：脚本目录经 $PSScriptRoot 自解析。
#>

$ErrorActionPreference = 'Stop'

# 自定位脚本目录与启动器（绝不硬编码路径）。
$scriptDir = $PSScriptRoot
$launcher  = Join-Path $scriptDir 'khyos-md-launch.vbs'
$bridge    = Join-Path $scriptDir 'khyos-md-bridge.js'
$verbLabel = '使用 khyosMarkdown 打开'

if (-not (Test-Path $launcher)) { throw "启动器缺失：$launcher" }
if (-not (Test-Path $bridge))   { throw "桥接器缺失：$bridge" }

# 预检 node（缺失不阻断注册，但给出明确提示）。
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Write-Warning '未在 PATH 中检测到 node。请先安装 Node.js：https://nodejs.org/  （右键打开时将无法启动桥接器）'
}

# 命令：wscript 隐藏调起 VBS；%1 双引号包裹以免路径含空格/中文断裂。
$command = "wscript.exe `"$launcher`" `"%1`""

$exts = @('.md', '.markdown')
foreach ($ext in $exts) {
  $shellKey = "HKCU:\Software\Classes\SystemFileAssociations\$ext\shell\khyosMarkdown"
  $cmdKey   = "$shellKey\command"
  New-Item -Path $cmdKey -Force | Out-Null
  # 动词显示名 + 图标。
  New-ItemProperty -Path $shellKey -Name '(default)' -Value $verbLabel -PropertyType String -Force | Out-Null
  New-ItemProperty -Path $shellKey -Name 'Icon' -Value 'shell32.dll,70' -PropertyType String -Force | Out-Null
  # 命令行。
  New-ItemProperty -Path $cmdKey -Name '(default)' -Value $command -PropertyType String -Force | Out-Null
  Write-Host "  [register] OK  $ext  ->  $verbLabel"
}

# ---- ProgID：让 khyos 出现在「打开方式」(Open With) 应用列表 ----
# 右键动词只填 shell 菜单；「打开方式」列表由 OpenWithProgids 指向的 ProgID 填充。
# 注册一个用户级 ProgID，再把它挂到各扩展名的 OpenWithProgids 下（仅 HKCU）。
$progId       = 'KhyOS.Markdown'
$friendlyName = 'KhyOS Markdown'
$progIdKey    = "HKCU:\Software\Classes\$progId"
$progCmdKey   = "$progIdKey\shell\open\command"
New-Item -Path $progCmdKey -Force | Out-Null
# ProgID 描述、友好名（决定「打开方式」里显示的应用名）、图标。
New-ItemProperty -Path $progIdKey -Name '(default)'       -Value $friendlyName    -PropertyType String -Force | Out-Null
New-ItemProperty -Path $progIdKey -Name 'FriendlyAppName' -Value $friendlyName    -PropertyType String -Force | Out-Null
New-Item         -Path "$progIdKey\DefaultIcon" -Force | Out-Null
New-ItemProperty -Path "$progIdKey\DefaultIcon" -Name '(default)' -Value 'shell32.dll,70' -PropertyType String -Force | Out-Null
# 打开命令：与右键动词同源，隐藏调起 VBS，%1 双引号包裹。
New-ItemProperty -Path $progCmdKey -Name '(default)' -Value $command -PropertyType String -Force | Out-Null

foreach ($ext in $exts) {
  # OpenWithProgids 下写一个空值(REG_SZ 空串)，值名即 ProgID —— 这是「打开方式」列表的填充机制。
  $owpKey = "HKCU:\Software\Classes\$ext\OpenWithProgids"
  New-Item -Path $owpKey -Force | Out-Null
  New-ItemProperty -Path $owpKey -Name $progId -Value '' -PropertyType String -Force | Out-Null
  Write-Host "  [register] OK  $ext  OpenWithProgids += $progId"
}

# ---- Applications\<app>\SupportedTypes：让 khyos 进「建议的应用/Recommended apps」----
# OpenWithProgids 让 ProgID 进「更多选项」列表；但「选择应用打开.md」对话框顶部的
# **建议的应用/Recommended Programs** 由 Applications\<app>\SupportedTypes\.md 填充
# （Microsoft Win32 shell 文档：SupportedTypes「causes the application to appear in the
# Recommended Programs list」）。SSOT 见 services/backend/src/services/mdSuggestedAppsPlan.js，
# 契约测钉死本段与之不漂移。仅写 HKCU（红线：不写 HKLM、免 UAC）。
$appKey     = 'khyos-md-launch.vbs'
$appBase    = "HKCU:\Software\Classes\Applications\$appKey"
$appCmdKey  = "$appBase\shell\open\command"
$appSupport = "$appBase\SupportedTypes"
New-Item -Path $appCmdKey  -Force | Out-Null
New-Item -Path $appSupport -Force | Out-Null
# 友好名（决定「建议的应用」里显示名）+ 图标。
New-ItemProperty -Path $appBase -Name 'FriendlyAppName' -Value $friendlyName -PropertyType String -Force | Out-Null
New-Item         -Path "$appBase\DefaultIcon" -Force | Out-Null
New-ItemProperty -Path "$appBase\DefaultIcon" -Name '(default)' -Value 'shell32.dll,70' -PropertyType String -Force | Out-Null
# 打开命令：与右键动词 / ProgID 同源，隐藏调起 VBS，%1 双引号包裹。
New-ItemProperty -Path $appCmdKey -Name '(default)' -Value $command -PropertyType String -Force | Out-Null
foreach ($ext in $exts) {
  # SupportedTypes 下每个扩展名一条空值(值名即扩展名) —— 这是「建议的应用」的填充机制。
  New-ItemProperty -Path $appSupport -Name $ext -Value '' -PropertyType String -Force | Out-Null
  Write-Host "  [register] OK  $ext  Applications\$appKey\SupportedTypes += $ext (建议的应用)"
}

Write-Host ''
Write-Host '  [register] 完成（仅当前用户，未触发 UAC）。右键任意 .md 文件即可见「使用 khyosMarkdown 打开」，'
Write-Host "  [register] 且「打开方式」列表中出现「$friendlyName」。"
Write-Host '  [register] 卸载：powershell -ExecutionPolicy Bypass -File unregister-windows.ps1'
