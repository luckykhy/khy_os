# 快速配置命令（复制粘贴到 PowerShell）

# ============================================
# Khy-OS 全局命令 - 快速配置
# 复制下面的所有内容，粘贴到 PowerShell 中执行
# ============================================

# 1. 创建配置文件（如果不存在）
if (!(Test-Path -Path $PROFILE)) {
    Write-Host "创建 PowerShell 配置文件..." -ForegroundColor Yellow
    New-Item -ItemType File -Path $PROFILE -Force | Out-Null
}

# 2. 添加 khy 函数
Write-Host "配置 khy 全局命令..." -ForegroundColor Green
$khyConfig = @"

# ============================================
# Khy-OS Global Command
# ============================================
function khy {
    node C:\khy-os\services\backend\bin\khy.js `$args
}
"@

Add-Content -Path $PROFILE -Value $khyConfig

# 3. 重新加载配置
Write-Host "重新加载配置..." -ForegroundColor Green
. $PROFILE

# 4. 测试
Write-Host ""
Write-Host "============================================" -ForegroundColor Cyan
Write-Host " ✓ 配置完成！" -ForegroundColor Green
Write-Host "============================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "测试命令：" -ForegroundColor Yellow
Write-Host "  khy --version" -ForegroundColor White
Write-Host "  khy --help" -ForegroundColor White
Write-Host ""

# 执行测试
khy --version
