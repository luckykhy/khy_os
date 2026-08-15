@echo off
echo.
echo ======================================
echo   Khy-OS Gateway Diagnostic Tool
echo ======================================
echo.

:: Repo root is two levels up: this script lives in <root>\scripts\setup\
cd /d "%~dp0..\..\services\backend"

echo [1/5] Checking claude command...
where claude >nul 2>&1
if %errorlevel% equ 0 (
    echo [OK] claude command found
    claude --version 2>nul || echo [WARN] claude version check failed
) else (
    echo [ERROR] claude command not found
    echo.
    echo Possible reasons:
    echo - Claude Code CLI not installed
    echo - claude command not in PATH
    echo.
)

echo.
echo [2/5] Checking Node.js...
node --version

echo.
echo [3/5] Testing Claude adapter detection...
node -e "try { const adapter = require('./src/services/gateway/adapters/claudeAdapter'); console.log('Claude adapter detect:', adapter.detect()); } catch(e) { console.error('Error:', e.message); }"

echo.
echo [4/5] Checking environment variables...
if defined ANTHROPIC_API_KEY (
    echo ANTHROPIC_API_KEY: [SET]
) else (
    echo ANTHROPIC_API_KEY: [NOT SET]
)
if defined ANTHROPIC_BASE_URL (
    echo ANTHROPIC_BASE_URL: %ANTHROPIC_BASE_URL%
) else (
    echo ANTHROPIC_BASE_URL: [NOT SET]
)

echo.
echo [5/5] Checking all adapters...
node -e "const gateway = require('./src/services/gateway/aiGateway'); gateway.init().then(() => { const status = gateway.getStatus(); console.log('\nAdapter Status:'); status.forEach(s => console.log('  ' + s.type.padEnd(15) + ':', (s.enabled ? '[Enabled]' : '[Disabled]').padEnd(12), s.available ? '[Available]' : '[Not Available]')); process.exit(0); }).catch(e => { console.error('Gateway init failed:', e.message); process.exit(1); });"

echo.
echo ======================================
echo   Diagnostic Complete
echo ======================================
echo.
pause
