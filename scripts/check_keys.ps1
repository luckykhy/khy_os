# 薄封装：真正的实现在 scripts/check_builtin_keys.py
#
# 保留本文件只为兼容既有调用习惯。旧版把 6 个密钥前缀硬编码在这里，且 APK 路径写死在
# build/ 下（实际发布件在 release/），会漏检第 7 把 key 并在文件不存在时直接抛异常。
# 现在改为从 built_in_keys.dart 自动派生，不需要再维护清单。
#
# 用法：powershell -File scripts/check_keys.ps1
#       加 -SrcOnly 只扫源树；加 -Json 输出机器可读结果。

param(
    [switch]$SrcOnly,
    [switch]$Json
)

$ErrorActionPreference = 'Stop'

# 注意：不要用 $args / $script 作变量名（PowerShell 自动变量）
# $PSScriptRoot 比 $MyInvocation.MyCommand.Path 可靠（-File 调用下后者可能为空）
$here = $PSScriptRoot
if (-not $here) { $here = Split-Path -Parent $MyInvocation.MyCommand.Path }
if (-not $here) { $here = (Get-Location).Path }
$repoRoot = Split-Path -Parent $here
$toolPath = Join-Path $repoRoot 'scripts/check_builtin_keys.py'

if (-not (Test-Path $toolPath)) {
    Write-Error "找不到 $toolPath"
    exit 2
}

$pyExe = $null
foreach ($cand in @('python', 'python3', 'py')) {
    $cmd = Get-Command $cand -ErrorAction SilentlyContinue
    if ($cmd) { $pyExe = $cmd.Source; break }
}
if (-not $pyExe) {
    Write-Error '找不到 python，请自行运行 scripts/check_builtin_keys.py'
    exit 2
}

$cliArgs = @($toolPath)
if ($SrcOnly) { $cliArgs += '--src-only' }
if ($Json) { $cliArgs += '--json' }

# 子进程输出含中文：固定 UTF-8，避免按控制台代码页（GBK）误解码
# ⚠ 注意：本文件把 stdout 固定成 UTF-8。**调用方一旦重定向或管道**（`*>`、`| Select-Object` 等），
#   外层也必须按 UTF-8 解码（`[Console]::OutputEncoding = [Text.Encoding]::UTF8`），
#   否则会看到「鈥?」「婧愭爲」这类乱码 —— 那是**外层解码**造成的，不是本脚本输出错了。
$env:PYTHONIOENCODING = 'utf-8'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }

& $pyExe @cliArgs
exit $LASTEXITCODE
