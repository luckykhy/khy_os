'use strict';

/**
 * resourceClassifier.js — 三级审批矩阵的「分级」单一真源。
 *
 * 把一个规约后的 Intent 映射到资源风险级别：
 *
 *   L0 绿灯（低风险读取）   → 只读、取系统时间、列非敏感目录。自动放行，仅记日志。
 *   L1 黄灯（有限写入/网络）→ 项目/家目录内写文件、向外发特定 API。首次询问，可会话免审。
 *   L2 红灯（毁灭性/不可逆/系统级）→ 删除、改宿主环境变量、全局装包、监听物理端口、
 *                                  杀非 khy-os 进程、写系统级路径、执行任意代码/命令、
 *                                  **跳出 OS 沙箱 / 全权执行**。
 *                                  强制挂起，必须输入 YES，**严禁免审**。
 *
 * 纯函数。**保守优先**：任何归类不确定的意图一律落到 L2（红灯），宁可多问一次，
 * 绝不少拦一次——这是「零隐式提权」的数学下界。
 */

const { ACTIONS, SCOPES } = require('./intentSchema');

const LEVELS = Object.freeze({ L0: 'L0', L1: 'L1', L2: 'L2' });

// 始终红灯的动作：天然不可逆 / 系统级，与资源作用域无关。
// SANDBOX_ESCAPE（跳出 OS 沙箱 / 全权执行）天然属系统级提权，与删除/装包同级红线。
const _ALWAYS_L2_ACTIONS = new Set([
  ACTIONS.DELETE, ACTIONS.KILL, ACTIONS.ENV, ACTIONS.INSTALL,
  ACTIONS.LISTEN, ACTIONS.EXEC_CODE, ACTIONS.SANDBOX_ESCAPE,
]);

// 自身可能黄可能红的动作，交给作用域细分。
function classify(intent) {
  const reasons = [];
  if (!intent || typeof intent !== 'object') {
    return { level: LEVELS.L2, reasons: ['意图缺失，按最高危处理'] };
  }
  const { action, scope, risk, isReadOnly, isDestructive } = intent;

  // 1) 天然红灯动作。
  if (_ALWAYS_L2_ACTIONS.has(action)) {
    reasons.push(`动作 ${action} 属毁灭性/系统级，红灯`);
    return { level: LEVELS.L2, reasons };
  }

  // 2) 工具自报「破坏性」——不论动作名，按红灯（如 writeFile 覆盖已存在文件且 isDestructive）。
  if (isDestructive === true && action !== ACTIONS.READ) {
    reasons.push('工具自报 isDestructive，红灯');
    return { level: LEVELS.L2, reasons };
  }

  // 3) 只读且非破坏性：必须先于 critical 短路裁决。只读不改变任何状态，天然不可逆危险
  //    无从谈起——一个 dir/ls/grep 即使承载它的工具静态声明 risk:'critical'（如通用
  //    shell_command 工具按最坏情况标 critical），也不该被强制 L2 键入 YES。工具**动态**
  //    自报的 isReadOnly 是比静态 risk 标签更精确的真相，故在此优先采纳。系统级只读仍按
  //    黄灯（可能读到敏感文件），项目/家/网络只读为绿灯。破坏性操作的 isReadOnly 恒为
  //    false，已在上一步被拦下，绝不会落入此分支——critical 红线对写/删/装零弱化。
  if (action === ACTIONS.READ || isReadOnly === true) {
    if (scope === SCOPES.SYSTEM) {
      reasons.push('读取系统级路径，可能触敏感文件，黄灯');
      return { level: LEVELS.L1, reasons };
    }
    reasons.push('只读且非系统级，绿灯');
    return { level: LEVELS.L0, reasons };
  }

  // 4) critical 风险声明 → 红灯（与既有 riskGate 的 critical 红线对齐，保证不弱化）。
  //    到此处已排除只读，故只对真正改变状态的 critical 操作生效。
  if (String(risk).toLowerCase() === 'critical') {
    reasons.push('风险等级 critical，红灯');
    return { level: LEVELS.L2, reasons };
  }

  // 5) 写入：项目/家目录内 → 黄灯；系统级 → 红灯。
  if (action === ACTIONS.WRITE) {
    if (scope === SCOPES.SYSTEM) {
      reasons.push('写入系统级路径，红灯');
      return { level: LEVELS.L2, reasons };
    }
    reasons.push(`写入 ${scope} 范围，黄灯`);
    return { level: LEVELS.L1, reasons };
  }

  // 6) 网络出站 / 起本地非破坏性进程 → 黄灯。
  if (action === ACTIONS.NETWORK) {
    reasons.push('网络出站请求，黄灯');
    return { level: LEVELS.L1, reasons };
  }
  if (action === ACTIONS.PROCESS) {
    reasons.push('起子进程/执行命令，黄灯（命令文本未命中红灯模式）');
    return { level: LEVELS.L1, reasons };
  }

  // 7) 兜底：未知一律红灯（保守优先）。
  reasons.push('未知动作，保守按红灯');
  return { level: LEVELS.L2, reasons };
}

/** L2 永不可被预审批清单/会话免审覆盖——分级层的硬不变量。 */
function isExemptible(level) {
  return level === LEVELS.L0 || level === LEVELS.L1;
}

module.exports = { LEVELS, classify, isExemptible };
