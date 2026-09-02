'use strict';

/**
 * Clipboard command handlers extracted from replSession.js (T-020 B3).
 *
 * Owns, verbatim from the former inline dispatch branches:
 *   - handleClipboardBridgeCommand: clipboard bridge / img2file / 剪贴板桥接
 *     (status/start/stop/restart) — drives windowsClipboardImg2FileService
 *     (re-required internally: leaf module, NOT part of the require-graph SCC)
 *   - handleClipboardRelayCommand: clipboard relay / 剪贴板中继 / webai
 *     (list/set/open/status or direct prompt) — the clipboardRelayAdapter is
 *     **injected** by the caller (it is a require-graph SCC member; a static
 *     require here would join the giant cycle and trip the R3 gate — see
 *     T-021 C3-P2 IoC lesson)
 *
 * Busy/FSM side effects go through injected setters so the closure state
 * (_busy / _replFsm) stays owned by replSession.
 */

const { printLines } = require('../bulkLines');
const renderer = () => require('../aiRenderer');

function createClipboardCommands(deps) {
  const { c, printInfo, printSuccess, printError, fsmFire, setBusy, startBusyPromptKeepalive } =
    deps;

  async function handleClipboardBridgeCommand(actionArg) {
    const action = String(actionArg || 'status').trim().toLowerCase();
    const bridge = require('../../services/windowsClipboardImg2FileService');
    const showStatus = () => {
      const status = bridge.getClipboardImg2FileBridgeStatus();
      if (!status.supported) {
        printInfo('图片粘贴桥接仅支持 Windows 平台');
        return;
      }
      if (!status.enabled) {
        printInfo('图片粘贴桥接已禁用（设置 KHY_CLIPBOARD_IMG2FILE_ENABLED=true 可启用）');
        return;
      }
      if (status.running) {
        const pollMs = status.meta?.pollMs || 500;
        const keepFiles = status.meta?.keepFiles || 8;
        printSuccess(
          `图片粘贴桥接运行中：位图监听 ${pollMs}ms/次，保留最近 ${keepFiles} 张，PID ${status.pid}`
        );
      } else {
        printInfo('图片粘贴桥接未运行，可执行: clipboard bridge start');
      }
    };

    if (action === 'start' || action === 'on' || action === 'enable' || action === '开启') {
      const result = bridge.startClipboardImg2FileBridge();
      if (result.started) {
        const pollMs = result.meta?.pollMs || 500;
        printSuccess(`图片粘贴桥接已启动：监听位图剪贴板并注入路径文本（轮询 ${pollMs}ms）`);
      } else if (result.reason === 'already_running') {
        printInfo('图片粘贴桥接已在运行中');
      } else {
        showStatus();
      }
    } else if (
      action === 'stop' ||
      action === 'off' ||
      action === 'disable' ||
      action === '关闭'
    ) {
      const stopped = bridge.stopClipboardImg2FileBridge();
      if (stopped) {
        printSuccess('图片粘贴桥接已停止');
      } else {
        printInfo('图片粘贴桥接未运行');
      }
    } else if (action === 'restart' || action === '重启') {
      bridge.stopClipboardImg2FileBridge();
      const result = bridge.startClipboardImg2FileBridge();
      if (result.started || result.reason === 'already_running') {
        printSuccess('图片粘贴桥接重启完成');
      } else {
        showStatus();
      }
    } else if (action === 'help' || action === 'h' || action === '?') {
      printInfo('用法: clipboard bridge [status|start|stop|restart]');
      printInfo('说明: 自动把剪贴板位图转换为 PNG 文件路径，便于在 CLI 中 Ctrl+V');
    } else {
      showStatus();
    }
  }

  async function handleClipboardRelayCommand(subCmd, clipAdapter) {
    // Sub-commands: service list, service set, open, or direct prompt
    if (subCmd === 'list' || subCmd === '列表') {
      const services = clipAdapter.getServices();
      const current = clipAdapter.getPreferredService();
      printInfo('可用的 Web AI 服务:');
      for (const [key, svc] of Object.entries(services)) {
        const marker = key === current ? c.green(' ← 当前') : '';
        console.log(
          `  ${c.cyan(key.padEnd(10))} ${svc.name.padEnd(20)} ${c.dim(svc.url)}${marker}`
        );
      }
    } else if (subCmd.startsWith('set ') || subCmd.startsWith('切换 ')) {
      const serviceKey = subCmd.replace(/^(set|切换)\s+/i, '').trim();
      if (clipAdapter.setService(serviceKey)) {
        const services = clipAdapter.getServices();
        printSuccess(`已切换到 ${services[serviceKey].name}`);
      } else {
        printError(`未知服务: ${serviceKey} — 运行 clipboard relay list 查看可用服务`);
      }
    } else if (subCmd === 'open' || subCmd === '打开') {
      const services = clipAdapter.getServices();
      const current = clipAdapter.getPreferredService();
      const svc = services[current];
      clipAdapter.openBrowser(svc.url);
      printInfo(`已打开 ${svc.name}: ${svc.url}`);
    } else if (subCmd === 'status' || subCmd === '状态' || !subCmd) {
      const status = clipAdapter.getStatus();
      if (status.available) {
        printSuccess(status.detail);
      } else {
        printError(status.detail);
      }
    } else {
      // Treat as a prompt to relay via clipboard
      setBusy(true);
      fsmFire('input_start');
      fsmFire('submit');
      startBusyPromptKeepalive();
      try {
        const result = await clipAdapter.generate(subCmd);
        if (result.success) {
          renderer().printStepLine('success', 'AI 回复', result.provider);
          const rendered = renderer().renderAiResponse(result.content);
          printLines(rendered, '  ');
        } else {
          printError(result.content);
        }
      } finally {
        setBusy(false);
        fsmFire('done');
      }
    }
  }

  return { handleClipboardBridgeCommand, handleClipboardRelayCommand };
}

module.exports = { createClipboardCommands };
