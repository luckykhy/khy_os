@echo off
chcp 65001 >nul
echo.
echo ======================================
echo   快速修复 /model 菜单卡死问题
echo ======================================
echo.

cd /d "%~dp0services\backend"

echo [1/3] 正在备份 .env 文件...
if exist .env (
    copy /Y .env .env.backup.%date:~0,4%%date:~5,2%%date:~8,2% >nul
    echo ✓ 已备份到 .env.backup.*
) else (
    echo ℹ 未找到 .env 文件，将创建新文件
)

echo.
echo [2/3] 正在添加快速失败配置...

(
echo.
echo # ========================================
echo # /model 菜单快速失败配置 (自动添加)
echo # ========================================
echo.
echo # 跳过耗时的初始化步骤
echo KHY_MODEL_QUICK_FAIL=true
echo.
echo # 激进的超时设置
echo KHY_MODEL_PROBE_TIMEOUT_MS=2000
echo KHY_MODEL_PROBE_GENERATION_TIMEOUT_MS=3000
echo KHY_MODEL_OVERALL_TIMEOUT_MS=15000
echo KHY_MODEL_BUILD_TIMEOUT_MS=20000
echo.
) >> .env

echo ✓ 配置已添加到 .env 文件

echo.
echo [3/3] 配置完成！
echo.
echo ======================================
echo   现在可以测试了
echo ======================================
echo.
echo 运行以下命令测试：
echo.
echo   khy
echo.
echo 然后在 CLI 中输入: /model
echo.
echo ======================================
echo.
pause
