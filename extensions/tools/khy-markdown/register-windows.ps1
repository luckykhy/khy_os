<#
.SYNOPSIS
  register-windows.ps1 — Windows 11 25H2 兼容方案：使用编译的 KhyosMarkdown.exe 注册文件关联。

.DESCRIPTION
  Windows 11 25H2 要求文件关联必须指向真正的 .exe（wscript/node 等解释器被系统拦截）。
  本脚本使用编译好的 KhyosMarkdown.exe（C# Windows Application，无控制台窗口）作为启动器，
  由其调起 node 执行 khyos-md-bridge.js 桥接器。

  仅写 HKCU（用户级），无需管理员权限、不触发 UAC。
  卸载请运行 unregister-windows.ps1。

  注册项：
    ProgID:       HKCU:\Software\Classes\KhyosMarkdown.exe
    Applications: HKCU:\Software\Classes\Applications\KhyosMarkdown.exe
    扩展名关联:    HKCU:\Software\Classes\.md, .markdown
    右键菜单:      HKCU:\Software\Classes\SystemFileAssociations\.md\.markdown\shell\khyosMarkdown

  命令格式: "<exe路径>" "%1"
#>

$ErrorActionPreference = 'Stop'

# ── 自定位 ──
$scriptDir = $PSScriptRoot
$exe       = Join-Path $scriptDir 'KhyosMarkdown.exe'
$bridge    = Join-Path $scriptDir 'khyos-md-bridge.js'

# ── 验证 KhyosMarkdown.exe 存在 ──
if (-not (Test-Path $exe)) {
  throw "启动器缺失：$exe`n请先编译 KhyosMarkdown.cs（见 README）。"
}
if (-not (Test-Path $bridge)) {
  Write-Warning "桥接器缺失：$bridge（注册可继续，但打开时将无法启动桥接器）"
}

# ── 预检 node（缺失警告不阻断） ──
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
  Write-Warning '未在 PATH 中检测到 node。请先安装 Node.js：https://nodejs.org/'
  Write-Warning '（KhyosMarkdown.exe 会自动搜索 fnm 路径，但建议确保 node 可用）'
}

# ── 注册参数 ──
$command      = "`"$exe`" `"%1`""
$progId       = 'KhyosMarkdown.exe'
$friendlyName = 'KhyOS Markdown'
$verbLabel    = '使用 khyosMarkdown 打开'
$exts         = @('.md', '.markdown', '.mdown', '.mkd')
$icoFile      = Join-Path $scriptDir 'khyosMarkdown.ico'
$iconValue    = if (Test-Path $icoFile) { "`"$icoFile`"" } else { "`"$exe`",0" }

# ── 1) 创建 ProgID: KhyosMarkdown.exe ──
Write-Host ''
Write-Host '  [1/5] 创建 ProgID ...'
$progIdKey = "HKCU:\Software\Classes\$progId"
$progCmdKey = "$progIdKey\shell\open\command"
New-Item -Path $progCmdKey -Force | Out-Null
New-ItemProperty -Path $progIdKey -Name '(default)' -Value $friendlyName -PropertyType String -Force | Out-Null
New-ItemProperty -Path $progIdKey -Name 'FriendlyAppName' -Value $friendlyName -PropertyType String -Force | Out-Null
New-Item -Path "$progIdKey\DefaultIcon" -Force | Out-Null
New-ItemProperty -Path "$progIdKey\DefaultIcon" -Name '(default)' -Value $iconValue -PropertyType String -Force | Out-Null
New-ItemProperty -Path $progCmdKey -Name '(default)' -Value $command -PropertyType String -Force | Out-Null
Write-Host "        ProgID = $progId"
Write-Host "        command = $command"

# ── 2) 注册 Applications\KhyosMarkdown.exe（供"打开方式"识别） ──
Write-Host '  [2/5] 注册 Applications ...'
$appBase    = "HKCU:\Software\Classes\Applications\$progId"
$appCmdKey  = "$appBase\shell\open\command"
$appSupport = "$appBase\SupportedTypes"
New-Item -Path $appCmdKey  -Force | Out-Null
New-Item -Path $appSupport -Force | Out-Null
New-ItemProperty -Path $appBase -Name 'FriendlyAppName' -Value $friendlyName -PropertyType String -Force | Out-Null
New-Item -Path "$appBase\DefaultIcon" -Force | Out-Null
New-ItemProperty -Path "$appBase\DefaultIcon" -Name '(default)' -Value $iconValue -PropertyType String -Force | Out-Null
New-ItemProperty -Path $appCmdKey -Name '(default)' -Value $command -PropertyType String -Force | Out-Null
foreach ($ext in $exts) {
  New-ItemProperty -Path $appSupport -Name $ext -Value '' -PropertyType String -Force | Out-Null
}
Write-Host "        Applications\$progId registered"

# ── 3) 将 .md 和 .markdown 扩展名关联到 ProgID ──
Write-Host '  [3/5] 关联扩展名 ...'
foreach ($ext in $exts) {
  $extKey = "HKCU:\Software\Classes\$ext"
  New-Item -Path $extKey -Force | Out-Null
  # 设置默认 ProgID（双击直接打开）
  New-ItemProperty -Path $extKey -Name '(default)' -Value $progId -PropertyType String -Force | Out-Null
  # Content Type 和 PerceivedType
  New-ItemProperty -Path $extKey -Name 'Content Type' -Value 'text/markdown' -PropertyType String -Force | Out-Null
  New-ItemProperty -Path $extKey -Name 'PerceivedType' -Value 'text' -PropertyType String -Force | Out-Null
  # OpenWithProgids
  $owpKey = "$extKey\OpenWithProgids"
  New-Item -Path $owpKey -Force | Out-Null
  New-ItemProperty -Path $owpKey -Name $progId -Value '' -PropertyType String -Force | Out-Null
  Write-Host "        $ext -> $progId (Content Type: text/markdown, PerceivedType: text)"
}

# ── 4) SystemFileAssociations 右键菜单动词（备用） ──
Write-Host '  [4/5] 注册右键菜单动词 ...'
foreach ($ext in $exts) {
  $shellKey = "HKCU:\Software\Classes\SystemFileAssociations\$ext\shell\khyosMarkdown"
  $cmdKey   = "$shellKey\command"
  New-Item -Path $cmdKey -Force | Out-Null
  New-ItemProperty -Path $shellKey -Name '(default)' -Value $verbLabel -PropertyType String -Force | Out-Null
  New-ItemProperty -Path $shellKey -Name 'Icon' -Value $iconValue -PropertyType String -Force | Out-Null
  New-ItemProperty -Path $cmdKey -Name '(default)' -Value $command -PropertyType String -Force | Out-Null
  Write-Host "        $ext  右键 -> $verbLabel"
}

# ── 5) SHChangeNotify 通知 Shell 刷新 ──
Write-Host '  [5/5] 通知 Shell 刷新关联 ...'
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class ShellNotify {
    [DllImport("shell32.dll", CharSet = CharSet.Auto)]
    public static extern void SHChangeNotify(int wEventId, int uFlags, IntPtr dwItem1, IntPtr dwItem2);
}
"@ -Language CSharp -ErrorAction SilentlyContinue
[ShellNotify]::SHChangeNotify(0x08000000, 0, [IntPtr]::Zero, [IntPtr]::Zero)  # SHCNE_ASSOCCHANGED
Write-Host '        Shell 已通知'

# ── 完成提示 ──
Write-Host ''
Write-Host '  ✅ 注册完成（仅当前用户，未触发 UAC）。'
Write-Host "     双击任意 .md 文件即可使用 $friendlyName 打开。"
Write-Host "     右键菜单可见「$verbLabel」。"
Write-Host ''
Write-Host '  卸载：powershell -ExecutionPolicy Bypass -File unregister-windows.ps1'
Write-Host ''
