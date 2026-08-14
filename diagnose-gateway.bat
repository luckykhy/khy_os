@echo off
chcp 65001 >nul
echo.
echo ======================================
echo   诊断 Claude 适配器检测问题
echo ======================================
echo.

cd /d "%~dp0services\backend"

echo [1/5] 检查 claude 命令是否存在...
where claude >nul 2>&1
if %errorlevel% equ 0 (
    echo ✓ claude 命令已找到
    claude --version
) else (
    echo ✗ 未找到 claude 命令
    echo.
    echo 原因分析：
    echo - Claude Code CLI 可能未安装
    echo - claude 命令不在 PATH 中
    echo.
)

echo.
echo [2/5] 检查 Node.js 环境...
node --version
echo.

echo [3/5] 测试网关适配器检测...
node -e "const adapter = require('./src/services/gateway/adapters/claudeAdapter'); console.log('Claude 适配器检测结果:', adapter.detect());"

echo.
echo [4/5] 检查环境变量...
echo ANTHROPIC_API_KEY: %ANTHROPIC_API_KEY%
echo ANTHROPIC_BASE_URL: %ANTHROPIC_BASE_URL%

echo.
echo [5/5] 查看所有可用适配器...
node -e "const gateway = require('./src/services/gateway/aiGateway'); gateway.init().then(() => { const status = gateway.getStatus(); status.forEach(s => console.log(s.type + ':', s.enabled ? '已启用' : '已禁用', '-', s.available ? '可用' : '不可用')); });"

echo.
echo ======================================
echo   诊断完成
echo ======================================
echo.
pause
