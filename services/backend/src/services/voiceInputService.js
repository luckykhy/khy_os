'use strict';

/**
 * voiceInputService — 模拟 Win+H 唤起 Windows 语音听写面板。
 *
 * 通过 PowerShell 内联 C#（Add-Type 调 user32.dll keybd_event）发送
 * Win(0x5B) down → H(0x48) down → H up → Win up 按键序列。
 * 仅支持 Windows；超时上限由 serviceDefaults.VOICE_INPUT_TRIGGER_TIMEOUT_MS 控制。
 */

const { spawn } = require('child_process');

const { VOICE_INPUT_TRIGGER_TIMEOUT_MS } = require('../constants/serviceDefaults');

// keybd_event 的 P/Invoke 签名（含双引号，故外层用 PowerShell 单引号字符串包裹）。
// 注意：命令各行必须用 \n 拼接（PowerShell 语句分隔），不能折成一行分号串里混用。
const PS_COMMAND = [
  '$sig = \'[DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, System.UIntPtr dwExtraInfo);\'',
  'Add-Type -MemberDefinition $sig -Name KhyKbd -Namespace KhyVoice',
  '[KhyVoice.KhyKbd]::keybd_event(0x5B, 0, 0, [UIntPtr]::Zero)',
  'Start-Sleep -Milliseconds 50',
  '[KhyVoice.KhyKbd]::keybd_event(0x48, 0, 0, [UIntPtr]::Zero)',
  'Start-Sleep -Milliseconds 50',
  '[KhyVoice.KhyKbd]::keybd_event(0x48, 0, 2, [UIntPtr]::Zero)',
  'Start-Sleep -Milliseconds 50',
  '[KhyVoice.KhyKbd]::keybd_event(0x5B, 0, 2, [UIntPtr]::Zero)',
].join('\n');

/**
 * 触发 Win+H 语音听写。
 * @returns {Promise<{ success: boolean, error?: string }>}
 */
function triggerWinH() {
  if (process.platform !== 'win32') {
    return Promise.resolve({ success: false, error: '语音输入功能仅在 Windows 上可用' });
  }

  return new Promise((resolve) => {
    let settled = false;
    let timer = null;
    const done = (result) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timer) {
        clearTimeout(timer);
      }
      resolve(result);
    };

    let child;
    try {
      child = spawn('powershell.exe', ['-NoProfile', '-Command', PS_COMMAND], {
        windowsHide: true,
        stdio: 'pipe',
      });
    } catch (e) {
      done({ success: false, error: `启动 PowerShell 失败：${e.message}` });
      return;
    }

    timer = setTimeout(() => {
      try {
        child.kill();
      } catch {
        /* ignore */
      }
      done({ success: false, error: `触发语音输入超时（${VOICE_INPUT_TRIGGER_TIMEOUT_MS}ms）` });
    }, VOICE_INPUT_TRIGGER_TIMEOUT_MS);

    let stderr = '';
    if (child.stderr) {
      child.stderr.on('data', (chunk) => {
        stderr += chunk;
      });
    }

    child.on('error', (e) => {
      done({ success: false, error: `启动 PowerShell 失败：${e.message}` });
    });

    child.on('close', (code) => {
      if (code === 0) {
        done({ success: true });
      } else {
        const detail = stderr.trim().slice(0, 300);
        done({ success: false, error: `PowerShell 退出码 ${code}${detail ? `：${detail}` : ''}` });
      }
    });
  });
}

module.exports = { triggerWinH };
