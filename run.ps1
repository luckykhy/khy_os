#Requires -Version 5.1
<#
.SYNOPSIS
    Khy-OS 便携化自激活启动脚本
.DESCRIPTION
    自动定位 Node.js 运行时，安装依赖并运行 khy-os 项目（npm workspaces monorepo）。
    npm install 必须在项目根目录执行，且 Windows 下必须使用 --install-links 参数以避免 EPERM。
.PARAMETER Command
    要运行的命令：dev / build / start / shell / install / 或任意 npm script 名（默认 dev）
.PARAMETER Workspace
    可选，指定 workspace 名称，指定时以 npm run <cmd> --workspace=<name> 运行
.PARAMETER RuntimeRoot
    手动指定运行时根目录（可选）
.PARAMETER NodeVersion
    指定 Node.js 版本前缀（默认 node-v22）
.EXAMPLE
    .\run.ps1                              # npm run dev
    .\run.ps1 build                        # npm run build
    .\run.ps1 dev -Workspace khy-os-backend  # npm run dev --workspace=khy-os-backend
    .\run.ps1 install                      # 强制重新安装依赖
    .\run.ps1 shell                        # 进入带 node/npm 环境的 PowerShell
#>
param(
    [string]$Command = "dev",
    [string]$Workspace = "",
    [string]$RuntimeRoot = "",
    [string]$NodeVersion = "node-v22"
)

$ErrorActionPreference = "Stop"
$ProjectRoot = $PSScriptRoot

Write-Host "[便携环境] 正在启动 Khy-OS..." -ForegroundColor Cyan

# === 第一步：定位运行时（4级降级查找） ===
$NodeDir = $null

# 优先级1：项目内嵌运行时
$localRuntime = "$ProjectRoot\.runtime\$NodeVersion"
if (Test-Path "$localRuntime\node.exe") {
    $NodeDir = $localRuntime
    Write-Host "  运行时: 项目内嵌 ($NodeVersion)" -ForegroundColor Gray
}

# 优先级2：参数指定
if (-not $NodeDir -and $RuntimeRoot) {
    $paramRuntime = "$RuntimeRoot\nodejs\$NodeVersion"
    if (Test-Path "$paramRuntime\node.exe") {
        $NodeDir = $paramRuntime
        Write-Host "  运行时: 参数指定 ($paramRuntime)" -ForegroundColor Gray
    }
}

# 优先级3：环境变量 PORTABLE_ROOT
if (-not $NodeDir -and $env:PORTABLE_ROOT) {
    $envRuntime = "$env:PORTABLE_ROOT\runtime\nodejs\$NodeVersion"
    if (Test-Path "$envRuntime\node.exe") {
        $NodeDir = $envRuntime
        Write-Host "  运行时: 便携盘共享 ($envRuntime)" -ForegroundColor Gray
    }
}

# 优先级4：自动下载
if (-not $NodeDir) {
    Write-Host "  未找到 Node.js 运行时，正在自动下载..." -ForegroundColor Yellow
    $version = "22.12.0"
    $url = "https://nodejs.org/dist/v$version/node-v$version-win-x64.zip"
    $downloadDir = "$ProjectRoot\.runtime"
    $zipFile = "$downloadDir\node.zip"

    New-Item -ItemType Directory -Path $downloadDir -Force | Out-Null
    Write-Host "  下载: $url" -ForegroundColor Gray
    Invoke-WebRequest -Uri $url -OutFile $zipFile -UseBasicParsing

    Write-Host "  解压中..." -ForegroundColor Gray
    Expand-Archive -Path $zipFile -DestinationPath $downloadDir -Force

    # 重命名解压后的目录为统一前缀
    $extracted = Get-ChildItem $downloadDir -Directory | Where-Object { $_.Name -like "node-v*-win-x64" } | Select-Object -First 1
    if ($extracted -and $extracted.Name -ne $NodeVersion) {
        Rename-Item $extracted.FullName "$downloadDir\$NodeVersion" -Force
    }

    Remove-Item $zipFile -Force
    $NodeDir = "$downloadDir\$NodeVersion"
    Write-Host "  Node.js 已下载到: $NodeDir" -ForegroundColor Green
}

if (-not $NodeDir -or -not (Test-Path "$NodeDir\node.exe")) {
    Write-Error "无法定位 Node.js 运行时！请确保便携盘已插入或手动指定 -RuntimeRoot 参数"
    exit 1
}

# === 第二步：配置环境 ===
$env:PATH = "$NodeDir;$env:PATH"

# npm 缓存指向便携盘（如可用）
if ($env:PORTABLE_ROOT -and (Test-Path "$env:PORTABLE_ROOT\cache\npm-cache")) {
    $env:npm_config_cache = "$env:PORTABLE_ROOT\cache\npm-cache"
}

# === 第三步：依赖安装（monorepo：必须在根目录，且加 --install-links） ===
function Install-Dependencies {
    Write-Host "`n[依赖安装] 正在项目根目录执行 npm install --install-links ..." -ForegroundColor Yellow
    Push-Location $ProjectRoot
    & "$NodeDir\npm.cmd" install --install-links
    $code = $LASTEXITCODE
    Pop-Location
    if ($code -ne 0) {
        Write-Error "npm install 失败！请检查网络连接。"
        exit 1
    }
    Write-Host "[依赖安装] 完成！" -ForegroundColor Green
}

# 首次运行：无 node_modules 时自动安装
if ((Test-Path "$ProjectRoot\package.json") -and -not (Test-Path "$ProjectRoot\node_modules")) {
    Install-Dependencies
}

# === 第四步：执行命令 ===
Push-Location $ProjectRoot
try {
    switch ($Command) {
        "shell" {
            Write-Host "`n[Shell] 进入项目 Shell（node/npm 已可用），输入 exit 退出" -ForegroundColor Cyan
            powershell -NoExit -Command "Set-Location '$ProjectRoot'; Write-Host 'Khy-OS 便携 Node.js 环境已激活' -ForegroundColor Green"
        }
        "install" {
            Install-Dependencies
        }
        default {
            if ($Workspace) {
                Write-Host "`n[运行] npm run $Command --workspace=$Workspace" -ForegroundColor Cyan
                & "$NodeDir\npm.cmd" run $Command --workspace=$Workspace
            }
            else {
                Write-Host "`n[运行] npm run $Command" -ForegroundColor Cyan
                & "$NodeDir\npm.cmd" run $Command
            }
            exit $LASTEXITCODE
        }
    }
}
finally {
    Pop-Location
}
