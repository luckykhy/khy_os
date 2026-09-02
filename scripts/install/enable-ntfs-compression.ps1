# enable-ntfs-compression.ps1
# One-shot, best-effort NTFS transparent compression (LZX) for a khy-os installation.
#
# Why: a khy-os tree is dominated by regenerable but constantly-used content
# (node_modules, build output, git objects). NTFS LZX compression keeps every
# file in place and decompresses on read, so development is unaffected while
# the on-disk footprint typically drops to ~50-60%. New files written into
# compressed directories inherit the compression attribute automatically,
# so the saving persists for the lifetime of the installation.
#
# Safety contract:
#   - Windows-only; on other systems this script exits 0 and does nothing.
#   - NTFS-only; FAT32/exFAT volumes (USB sticks) are detected and skipped.
#   - Best-effort: never throws, never fails the calling installer.
#   - Idempotent: re-running skips already-compressed files quickly.
#   - Locked files (running backends) are skipped and can be picked up later.
#
# compact.exe syntax note (hard-won): the positional argument is a FILE NAME
# pattern, not a directory. The recursion root must be given as /S:"<dir>" and
# an explicit "*" pattern must be passed, otherwise compact walks the current
# directory and compresses nothing.

param(
    # Root of the installation to compress. Defaults to the repo root that
    # contains this script (scripts/install/ -> repo root).
    [string]$ProjectRoot,

    # Wait for compression to finish and print the summary. Default is to
    # detach so installers stay fast on first run (large trees take minutes).
    [switch]$Foreground,

    # Skip compressing the shared pnpm content-addressable store.
    [switch]$NoPnpmStore
)

$ErrorActionPreference = 'SilentlyContinue'

function Write-Step {
    param([string]$Message)
    Write-Host "[ntfs-compress] $Message"
}

# --- Locate the installation root -------------------------------------------
if (-not $ProjectRoot) {
    $ProjectRoot = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
}
if (-not (Test-Path -LiteralPath $ProjectRoot)) {
    Write-Step "未找到安装目录: $ProjectRoot，跳过压缩 (0/3 步已执行)"
    exit 0
}

# --- Platform guard ----------------------------------------------------------
if ($env:OS -ne 'Windows_NT') {
    Write-Step "非 Windows 系统，NTFS 压缩不适用，已跳过 (共 0 项需处理)"
    exit 0
}
$compact = Join-Path $env:SystemRoot 'System32\compact.exe'
if (-not (Test-Path -LiteralPath $compact)) {
    Write-Step "未找到 compact.exe (Windows 10 以上自带)，跳过压缩 (0/3 步已执行)"
    exit 0
}

# --- Filesystem guard (NTFS only) --------------------------------------------
$driveLetter = $ProjectRoot.Substring(0, 1)
$driveInfo = New-Object System.IO.DriveInfo($driveLetter)
if ($driveInfo.DriveFormat -ine 'NTFS') {
    Write-Step "卷 $driveLetter`: 为 $($driveInfo.DriveFormat)，不支持 NTFS 压缩，已跳过 (0/3 步已执行)"
    exit 0
}

# --- Optional: shared pnpm store (hardlink source of node_modules) -----------
# .pnpm entries are hardlinks into the content-addressable store; compressing
# the store once compresses every hardlink view for free. Skipped when the
# store lives inside the project (the root pass already covers it).
$pnpmStore = $null
if (-not $NoPnpmStore) {
    $pnpmCmd = Get-Command pnpm -ErrorAction SilentlyContinue
    if ($pnpmCmd) {
        $pnpmStore = (& pnpm store path 2>$null | Select-Object -Last 1)
        if ($pnpmStore -and ((Resolve-Path -LiteralPath $pnpmStore -ErrorAction SilentlyContinue) -eq $null)) {
            $pnpmStore = $null
        }
        if ($pnpmStore -and $pnpmStore.StartsWith($ProjectRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
            $pnpmStore = $null
        }
    }
}

# --- Build the detached compression job ---------------------------------------
$targets = @($ProjectRoot)
if ($pnpmStore) { $targets += $pnpmStore }

$stamp = Get-Date -Format 'yyyyMMdd-HHmmss'
$logFile = Join-Path $env:TEMP "khy-os-ntfs-compress-$stamp.log"

if ($Foreground) {
    Write-Step "开始压缩目标 $($targets.Count) 个: $($targets -join ' ; ') (LZX 算法，前台执行)"
    foreach ($t in $targets) {
        Write-Step "正在压缩 $t (LZX 算法，递归全部文件，请稍等)..."
        & $compact /c /s:"$t" /q /exe:lzx * 2>&1 | Out-File -FilePath $logFile -Append -Encoding utf8
    }
    $summary = Get-Content -LiteralPath $logFile -ErrorAction SilentlyContinue |
        Where-Object { $_ -match '压缩率为|压缩比' } | Select-Object -Last 1
    Write-Step "压缩完成: 目标 $($targets.Count) 个 (明细见日志)"
    if ($summary) { Write-Step "压缩结果: $summary" }
    Write-Step "完整日志: $logFile"
} else {
    # Detached runner: target paths go through a file (no quoting pitfalls),
    # the runner walks them one by one and appends progress to the log.
    $targetFile = Join-Path $env:TEMP "khy-os-compress-targets-$stamp.txt"
    $targets | Set-Content -LiteralPath $targetFile -Encoding Unicode
    $runner = Join-Path $env:TEMP "khy-os-compress-runner-$stamp.ps1"
    @'
param([string]$CompactExe, [string]$TargetFile, [string]$LogFile)
$ErrorActionPreference = 'SilentlyContinue'
$targets = Get-Content -LiteralPath $TargetFile
foreach ($t in $targets) {
    if (-not $t) { continue }
    Add-Content -LiteralPath $LogFile -Value "=== compressing: $t ==="
    & $CompactExe /c /s:"$t" /q /exe:lzx * 2>&1 | Out-File -FilePath $LogFile -Append -Encoding utf8
    Add-Content -LiteralPath $LogFile -Value "=== done: $t ==="
}
'@ | Set-Content -LiteralPath $runner -Encoding UTF8
    Start-Process -FilePath 'powershell.exe' `
        -ArgumentList '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $runner, `
            '-CompactExe', $compact, '-TargetFile', $targetFile, '-LogFile', $logFile `
        -WindowStyle Hidden | Out-Null
    Write-Step "已在后台开始压缩 $($targets.Count) 个目录: $($targets -join ' ; ') (LZX 算法，新文件自动继承压缩)"
    Write-Step "进度日志: $logFile (不影响安装与日常使用，无需等待)"
}

exit 0
