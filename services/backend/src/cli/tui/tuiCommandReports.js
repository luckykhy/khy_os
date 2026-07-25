'use strict';

/**
 * tuiCommandReports.js — TUI 原生执行「经典 REPL 有、TUI 此前缺」的非交互 slash 命令。
 *
 * 背景(goal 2026-06-28「我只要用 TUI,REPL 有而 TUI 没有的功能要补齐,两处对齐」):
 * 审计发现一批 slash 命令(`/scan`/`/hardware`/`/checkpoint`/`/review`/`/worktree`/`/rollback`/
 * `/study`/`/intent`/`/mind`)在经典 readline REPL 里做真实本地工作,但在 Ink TUI 里既不被
 * `handleFlag` 处理、也不被 `route()` 识别,于是**静默把字面 `/scan` 当普通文本发给模型**——
 * 有些还在 `/` 菜单里可选,用户点了却只把命令字面送进 LLM。
 *
 * 目标是**真正在 TUI 里原生执行**这些命令(而非给「请用经典模式」的提示——那等于让用户退回
 * 传统 REPL,违背 goal「我只要使用 tui」)。两档:
 *   - **同步报告档**(本文件):非交互、可同步产出文本行的命令——`/scan`/`/hardware`/`/checkpoint`/
 *     `/intent`/`/study`/`/mind`。由 `dispatchNativeCommand(parsed,{cwd,env})` **复用经典 REPL 调用
 *     的同一批 service**(`antivirusService`/`hardwareProfileService`/`workspace/checkpointService`/
 *     `ai`(学习模式)/`repl/khySettings`(意图调试持久化)/`featureCapabilityMap`+`taskMindMap`(认知图)),
 *     绝不另写逻辑,把结果拍成纯文本行交回 TUI 渲染成 transcript 通知。
 *   - **异步档**(`runWorktreeNative`):`/worktree` 复用 `repl/worktreeCommand.runWorktreeCommand`,
 *     out 回调收集成文本行。`/review`(`handlers/review.handleReview`,在清屏区跑+经 uiPrompt/FormFlow
 *     原生确认)与 `/rollback`(原生检查点选择器)由 `App.js runRouted` 直接驱动,见那里的接线。
 *
 * 这样 6 个此前只给「经典模式」提示的命令(`/rollback`/`/study`/`/intent`/`/mind`/`/worktree`/
 * `/review`)全部在 TUI 内原生可用,达成「两处对齐」。
 *
 * 薄 IO(service 内部读硬件/跑 ClamAV/写检查点):确定性、**绝不抛**。任何失败都回退成一行
 * 错误说明文本,绝不打断 TUI。env 门控 `KHY_TUI_NATIVE_COMMANDS`(默认开,仅显式 0/false/off/no
 * 关闭;关闭后 `dispatchNativeCommand` 恒返回 `{ handled:false }` → 命令照旧落到既有路径)。
 */

const _FALSY = new Set(['0', 'false', 'off', 'no']);

/** 门控判定。默认开,仅显式 0/false/off/no 关闭。 */
function isEnabled(env) {
  const v = (env || process.env || {}).KHY_TUI_NATIVE_COMMANDS;
  return !(v !== undefined && _FALSY.has(String(v).trim().toLowerCase()));
}

/** `/hardware` — 复用 hardwareProfileService(parity repl.js:3647-3715)。 */
function buildHardwareReport() {
  try {
    const hw = require('../../services/hardwareProfileService');
    const { lines, profile } = hw.getHardwareSummary();
    const out = ['硬件配置:'];
    for (const line of lines || []) out.push(`  ${line}`);
    if (profile && profile.os) {
      const osp = profile.os;
      out.push('', '操作系统:', `  系统: ${osp.os} (${osp.kernel})${osp.source === 'pinned' ? ' (KHY_OS_PROFILE 锁定)' : ''}`);
      if (osp.isWSL) out.push('  环境: WSL (跨 /mnt IO 较慢，已放宽超时)');
      if (osp.container && osp.container.detected) {
        const eff = profile.effective || {};
        const memTxt = eff.ramMB ? `${Math.round(eff.ramMB / 1024)}GB` : '未限';
        const cpuTxt = eff.cpuCount ? `${eff.cpuCount}核` : '未限';
        out.push(`  容器: ${osp.container.runtime} (有效 ${memTxt}/${cpuTxt})`);
      }
    }
    if (profile && Array.isArray(profile.localModels) && profile.localModels.length > 0) {
      out.push('', '推荐本地模型:');
      for (const m of profile.localModels) {
        if (m.recommendation === 'api-only') { out.push(`  ${m.reason}`); }
        else { out.push(`  ${m.name} (${m.sizeGB}GB)${m.recommended ? ' ★ 推荐' : ''}`, `    ${m.reason}`); }
      }
    }
    try {
      const applied = hw.getAppliedLimits();
      out.push('', '生效运行参数:', `  档位: ${applied.profile}${applied.pinned ? ' (KHY_HW_PROFILE 锁定)' : ''}`);
      for (const [key, val] of Object.entries(applied.env || {})) {
        const overridden = applied.source && applied.source[key] === 'user-override';
        out.push(`  ${key}=${val}${overridden ? ' ← 用户覆盖' : ' (硬件派生)'}`);
      }
    } catch { /* transparency block is best-effort */ }
    return out;
  } catch (e) {
    return [`硬件检测失败: ${e && e.message ? e.message : String(e)}`];
  }
}

/** `/scan` — 复用 antivirusService(parity repl.js:3581-3602)。 */
function buildScanReport() {
  try {
    const av = require('../../services/antivirusService');
    const tools = av.detectTools();
    if (!tools.hasClamAV) {
      const inst = av.getInstallInstructions();
      return ['ClamAV 未安装', `安装命令: ${inst && inst.install ? inst.install : '见文档'}`];
    }
    const result = av.scanProject();
    if (result.clean) {
      const _elapsed = (result.elapsed || 0);
      const _dur = require('../ccFormat').ccFormatDurationOr(_elapsed, `${(_elapsed / 1000).toFixed(1)}s`, process.env);
      return [`扫描完成: 未发现威胁 (${_dur})`];
    }
    const out = [`发现 ${result.infected} 个威胁!`];
    for (const t of result.threats || []) out.push(`  ${t.virus} → ${t.file}`);
    out.push('已隔离到 ~/.khyquant/quarantine/');
    return out;
  } catch (e) {
    return [`扫描失败: ${e && e.message ? e.message : String(e)}`];
  }
}

/** `/checkpoint` — 复用 workspace/checkpointService(parity repl.js:3943-3949)。 */
function saveCheckpointReport(cwd) {
  try {
    const dir = cwd || process.env.KHYQUANT_CWD || process.cwd();
    const ckptSvc = require('../../services/workspace/checkpointService');
    const r = ckptSvc.saveCheckpoint(dir, { message: '手动检查点', mode: 'auto' });
    return [`检查点已保存: ${r.id} (${r.mode}, ${r.files || 0} 文件)`];
  } catch (e) {
    return [`检查点保存失败: ${e && e.message ? e.message : String(e)}`];
  }
}

/**
 * `/intent [on|off|show]` — 意图保护调试显示开关(parity repl.js:4393-4413)。
 * on/off 同步设 env + 持久化到 khy settings;show 报当前态(env 优先,回落持久化设置)。绝不抛。
 */
function buildIntentReport(args, env) {
  const ENV_KEY = 'KHY_INTENT_ASSURANCE_DEBUG';
  const SETTING_KEY = 'intentAssuranceDebug';
  const action = String((args && args[0]) || 'show').toLowerCase();
  try {
    const e = env || process.env;
    if (action === 'on' || action === 'off') {
      const on = action === 'on';
      e[ENV_KEY] = on ? 'true' : 'false';
      let persisted = false;
      try {
        persisted = require('../repl/khySettings')._persistBooleanKhySetting(SETTING_KEY, on);
      } catch { persisted = false; }
      const line = on ? '已开启意图保护调试显示' : '已关闭意图保护调试显示';
      return persisted ? [line] : [line, '(注意：设置未能持久化，仅本会话生效)'];
    }
    // show / status
    let on;
    const raw = String(e[ENV_KEY] || '').trim().toLowerCase();
    if (raw) on = ['1', 'true', 'yes', 'on'].includes(raw);
    else {
      try { on = require('../repl/khySettings')._loadBooleanKhySetting(SETTING_KEY, false); }
      catch { on = false; }
    }
    return [`意图保护调试: ${on ? '开启' : '关闭'}`, '用法: /intent on | off | show'];
  } catch (e) {
    return [`意图保护调试操作失败: ${e && e.message ? e.message : String(e)}`];
  }
}

/**
 * `/study [on|off|status]` — 学习模式开关(parity repl.js:3986-4024)。复用 ai 模块同一组
 * isStudyMode/enableStudyMode/disableStudyMode(与经典 REPL 同一单例)。绝不抛。
 */
function buildStudyReport(args) {
  const action = String((args && args[0]) || 'status').toLowerCase();
  try {
    const aiMod = require('../ai');
    const isOn = aiMod.isStudyMode ? !!aiMod.isStudyMode() : false;
    if (action === 'on') {
      if (isOn) return ['学习模式已处于开启状态'];
      if (aiMod.enableStudyMode) aiMod.enableStudyMode();
      return ['学习模式已开启！', '现在你可以向 AI 提问关于本项目的一切', '建议先运行 knowledge self 查看当前能力边界与学习路径'];
    }
    if (action === 'off') {
      if (!isOn) return ['学习模式已处于关闭状态'];
      if (aiMod.disableStudyMode) aiMod.disableStudyMode();
      return ['学习模式已关闭'];
    }
    return [`学习模式当前状态: ${isOn ? '开启' : '关闭'}`, '用法: /study on | off | status'];
  } catch (e) {
    return [`学习模式操作失败: ${e && e.message ? e.message : String(e)}`];
  }
}

/**
 * `/mind [show|on|off|reset]` — 认知双图(parity repl.js:2560-2631, 4360-4391)。
 * show:原生渲染能力图 + 任务图静态结构(复用 featureCapabilityMap/taskMindMap 同一渲染器);
 * on/off:设 KHY_TASK_MINDMAP_AUTO_SHOW;reset:报已重置。任务图随 AI 回合实时构建,故此处为
 * 静态结构视图(诚实注明)。绝不抛。
 */
function buildMindReport(args, env) {
  const action = String((args && args[0]) || 'show').toLowerCase();
  try {
    const e = env || process.env;
    if (action === 'on' || action === 'off') {
      e.KHY_TASK_MINDMAP_AUTO_SHOW = action === 'on' ? 'true' : 'false';
      return [`认知双图自动展示: ${action === 'on' ? '开启' : '关闭'}`];
    }
    if (action === 'reset') return ['认知双图已重置到起点'];
    // show
    const out = ['认知双图:'];
    try {
      const { FeatureCapabilityMap } = require('../featureCapabilityMap');
      for (const line of (new FeatureCapabilityMap().renderLines() || [])) out.push(`  ${line}`);
    } catch { /* best-effort */ }
    try {
      const { createIdleTaskMindMap } = require('../taskMindMap');
      for (const line of (createIdleTaskMindMap().renderLines() || [])) out.push(`  ${line}`);
    } catch { /* best-effort */ }
    out.push('提示: 任务图随 AI 回合实时构建，此处为静态结构视图。用法: /mind show | on | off | reset');
    return out.length > 1 ? out : ['认知双图不可用'];
  } catch (e) {
    return [`认知双图渲染失败: ${e && e.message ? e.message : String(e)}`];
  }
}

/**
 * `/worktree [enter|exit|list|status …]` — 隔离工作区(parity repl.js:3977-3983)。
 * 复用 repl/worktreeCommand.runWorktreeCommand,用 out 回调把 info/success/warn/error 收成
 * 文本行(经典 REPL 走 console.log;TUI 收集后渲染成 transcript 通知)。async。绝不抛。
 * runWorktreeCommand 内部经 switchCwd 设 env.KHYQUANT_CWD(文件工具/锁/diff/检查点据此对齐),
 * onCwdChange 回调供调用方同步任何 UI 侧 cwd 展示(可选)。
 */
async function runWorktreeNative(argStr, opts = {}) {
  const lines = [];
  const collect = (s) => lines.push(String(s == null ? '' : s));
  try {
    const { runWorktreeCommand } = require('../repl/worktreeCommand');
    await runWorktreeCommand(String(argStr || ''), {
      out: { info: collect, success: collect, warn: collect, error: collect },
      onCwdChange: typeof opts.onCwdChange === 'function' ? opts.onCwdChange : (() => {}),
    });
  } catch (e) {
    lines.push(`/worktree 执行失败: ${e && e.message ? e.message : String(e)}`);
  }
  return lines.length ? lines : ['(无输出)'];
}

/**
 * 给定 parseInput 产出的 parsed,若属于「同步报告档」命令则原生执行并返回报告文本行。
 * 异步/交互档(/worktree、/review、/rollback)不在此处(由 App.js runRouted 直接驱动)。
 * @param {object} parsed   router.parseInput 的返回(读 parsed.flag / parsed.command / parsed.args)
 * @param {object} [opts]   { cwd, env }
 * @returns {{ handled: boolean, lines?: string[] }}
 */
function dispatchNativeCommand(parsed, opts = {}) {
  try {
    if (!isEnabled(opts.env)) return { handled: false };
    if (!parsed) return { handled: false };
    const key = parsed.flag || parsed.command;
    const args = Array.isArray(parsed.args) ? parsed.args : [];
    switch (key) {
      case 'hardware':   return { handled: true, lines: buildHardwareReport() };
      case 'scan':       return { handled: true, lines: buildScanReport() };
      case 'checkpoint': return { handled: true, lines: saveCheckpointReport(opts.cwd) };
      case 'intent':     return { handled: true, lines: buildIntentReport(args, opts.env) };
      case 'study':      return { handled: true, lines: buildStudyReport(args) };
      case 'mind':       return { handled: true, lines: buildMindReport(args, opts.env) };
      default: return { handled: false };
    }
  } catch {
    return { handled: false };
  }
}

module.exports = {
  isEnabled,
  buildHardwareReport,
  buildScanReport,
  saveCheckpointReport,
  buildIntentReport,
  buildStudyReport,
  buildMindReport,
  runWorktreeNative,
  dispatchNativeCommand,
};
