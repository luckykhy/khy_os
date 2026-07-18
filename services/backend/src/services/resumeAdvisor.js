'use strict';

/**
 * resumeAdvisor.js — 让「被打断的项目构建」在新会话里可发现、可一键续作。
 *
 * 背景（用户痛点）：khy 在项目制作中途被打断（khy 故障 / 断电 / 断网 / token 耗尽 /
 * 用户关机休息），另起一个会话后「没办法接着完成」。
 *
 * 根因不是「没存」——`boulderState.js` 早已把 Ralph Loop 进度按 cwd 落盘成跨会话检查点
 * （每 3 轮 / 45s 一存，24h TTL，崩溃也能留下最后一次 in_progress 检查点）。真正的缺口是：
 *   1. 发现性：`hasPendingBoulder` 此前零调用者——新会话启动时没有任何提示，用户根本不知道
 *      存在可续的检查点；
 *   2. 摩擦：既有自动续作闸门（agenticHarnessService）只在用户「重新发送一条相似指令」且
 *      检查点状态为 in_progress 时才触发，用户既不知道要重发、也可能换了措辞。
 *
 * 本模块是 boulderState 之上的薄编排层（不引入新存储），提供三件事：
 *   - pendingForCwd(cwd)        → 该目录是否有可续构建（摘要），供启动横幅 / 命令发现；
 *   - formatStartupHint(p, opts)→ 渲染中文发现横幅（含确切续作命令），供 REPL 启动时打印；
 *   - armBareResume(cwd)        → 把该目录待续检查点重新武装为 in_progress 并回传原始指令，
 *                                 供「裸 resume」经 repl 的 aiForward 契约自动重提交，免重打。
 *
 * 铁律：全 fail-soft，任何异常都返回安全空值，绝不抛进启动 / 命令热路径；尊重既有
 * `KHY_BOULDER_RESUME` 开关（off/0/false/no 时不提示、不自动武装，与既有自动续作同源）。
 */

/**
 * 是否启用跨会话续作（与 agenticHarnessService 的 boulderResumeEnabled 同源开关）。
 * 用户显式关闭（KHY_BOULDER_RESUME=off/0/false/no）时，既不弹提示也不自动武装。
 * @returns {boolean}
 */
function _resumeEnabled() {
  const raw = String(process.env.KHY_BOULDER_RESUME || 'true').trim().toLowerCase();
  return !['0', 'false', 'off', 'no'].includes(raw);
}

/**
 * 查询指定工作目录是否存在「可续作」的构建检查点。
 * 仅当状态为 in_progress（崩溃/断电时残留的最后一次检查点）或 interrupted（Ctrl+C 标记）
 * 时返回摘要；completed / 过期（boulderState 自身按 TTL 判定）返回 null。
 *
 * @param {string} cwd - 工作目录绝对路径
 * @returns {{taskId:string|null,userMessage:string,iterations:number,status:string,updatedAt:number,ageMinutes:number|null,cwd:string}|null}
 */
function pendingForCwd(cwd) {
  if (!cwd || !_resumeEnabled()) return null;
  try {
    const boulder = require('./boulderState');
    const state = boulder.loadBoulderState(cwd); // 缺失 / 过期 → null
    if (!state) return null;
    const status = state.status || 'in_progress';
    if (status !== 'in_progress' && status !== 'interrupted') return null;

    const updatedAt = Number(state.lastCheckpointAt) || 0;
    const ageMs = updatedAt > 0 ? Math.max(0, Date.now() - updatedAt) : null;
    const ageMinutes = ageMs != null ? Math.max(0, Math.round(ageMs / 60000)) : null;

    return {
      taskId: state.taskId || null,
      userMessage: _cleanInstruction(state.userMessage),
      iterations: Number(state.iterations) || 0,
      status,
      updatedAt,
      ageMs,
      ageMinutes,
      cwd,
    };
  } catch {
    return null; // 发现性是增益，绝不阻断启动
  }
}

/**
 * 清洗原始指令：去掉续作时前置的 [SYSTEM: ...] 上下文段与换行，仅保留用户本意，
 * 便于在横幅里单行展示，也保证 armBareResume 回传的是干净指令。
 * @param {string} raw
 * @returns {string}
 */
function _cleanInstruction(raw) {
  let s = String(raw || '').trim();
  // 历史续作可能把 "[SYSTEM: Resuming ...] \n\n<原始指令>" 整段存进 userMessage；
  // 这里只在确实是该前缀时剥离，绝不误伤正常含方括号的指令。
  if (s.startsWith('[SYSTEM:')) {
    const idx = s.indexOf(']');
    if (idx !== -1) s = s.slice(idx + 1).trim();
  }
  return s.replace(/\s+/g, ' ').trim();
}

// CC 区间 unit → 中文「前」标签(保留 resumeAdvisor 既有中文本地化,不强行换英文)。
const _AGE_UNIT_ZH = {
  second: '刚刚', // <1 分钟统一显「刚刚」(与 legacy 同)
  minute: '分钟前',
  hour: '小时前',
  day: '天前',
  week: '周前',
  month: '个月前',
  year: '年前',
};

/**
 * 人类可读的「多久以前」标签。
 *
 * CC 后端口径对齐:走 ccFormat SSOT 的 `ccRelativeAgeParts`(CC `formatRelativeTime`
 * 的 **Math.trunc 截断** + 完整 year→second 区间表)——修掉旧口径用 `Math.round`
 * **向上虚报**的缺陷(23h59m 旧显「1 天前」、90s 旧显「2 分钟前」),并补齐
 * 周/月/年档。门控 KHY_CC_FORMAT(经 ccFormatEnabled)默认开;关 / require 失败 /
 * 拿不到原始 ms → 逐字节回退到旧的基于 ageMinutes 的口径。
 *
 * @param {number|null} ageMinutes  legacy 分钟数(回退口径用)。
 * @param {object} [env]            注入 env(测试 / 门控)。
 * @param {number|null} [ageMs]     原始毫秒差(CC 截断口径用;缺省则只能走 legacy)。
 * @returns {string}
 */
function _ageLabel(ageMinutes, env, ageMs) {
  try {
    const { ccFormatEnabled, ccRelativeAgeParts } = require('../cli/ccFormat');
    if (ccFormatEnabled(env) && ageMs != null && Number.isFinite(ageMs)) {
      const parts = ccRelativeAgeParts(ageMs);
      if (parts) {
        if (parts.unit === 'second') return _AGE_UNIT_ZH.second; // 刚刚
        const suffix = _AGE_UNIT_ZH[parts.unit];
        if (suffix) return `${parts.value} ${suffix}`;
      }
    }
  } catch { /* fall through to legacy */ }
  // byte-identical legacy(基于已 round 的 ageMinutes)。
  if (ageMinutes == null) return '';
  if (ageMinutes < 1) return '刚刚';
  if (ageMinutes < 60) return `${ageMinutes} 分钟前`;
  const hours = Math.floor(ageMinutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.floor(hours / 24)} 天前`;
}

/**
 * 渲染启动发现横幅（中文，含确切续作命令）。
 * color 可选传入 chalk 风格对象（含 .dim/.bold/.cyan/.yellow 方法）；缺省则纯文本。
 *
 * @param {object|null} pending - pendingForCwd 的返回
 * @param {object} [opts]
 * @param {object} [opts.color] - chalk 风格着色对象（可选）
 * @returns {string} 多行横幅文本；pending 为空时返回空串
 */
function formatStartupHint(pending, opts = {}) {
  if (!pending) return '';
  const color = opts.color && typeof opts.color === 'object' ? opts.color : null;
  const paint = (method, text) => {
    if (color && typeof color[method] === 'function') {
      try { return color[method](text); } catch { return text; }
    }
    return text;
  };

  const age = _ageLabel(pending.ageMinutes, opts.env, pending.ageMs);
  const ageNote = age ? `，${age}更新` : '';
  const rounds = pending.iterations > 0 ? `已执行 ${pending.iterations} 轮${ageNote}` : `进行中${ageNote}`;

  const instr = pending.userMessage
    ? (pending.userMessage.length > 80 ? `${pending.userMessage.slice(0, 80)}…` : pending.userMessage)
    : '(无原始指令记录)';

  const lines = [
    paint('yellow', `⏸  检测到未完成的构建任务（${rounds}）`),
    paint('dim', `   原始目标：${instr}`),
    paint('cyan', '   输入 ') + paint('bold', 'resume') + paint('cyan', ' 从断点继续') +
      paint('cyan', '，或 ') + paint('bold', 'resume tasks') + paint('cyan', ' 查看全部'),
  ];
  return lines.join('\n');
}

/**
 * 为「裸 resume」（无 taskId 参数）武装当前工作目录的待续检查点：
 *   - in_progress：自动续作闸门本就匹配，无需改状态，直接回传原始指令；
 *   - interrupted：先经 boulderState.rearmForResume 翻回 in_progress（使闸门匹配），
 *     taskId 寻址不可用（如无 sqlite）时退回直接 load→改状态→save 兜底。
 * 返回原始指令供调用方（router）经 repl 的 aiForward 契约自动重提交。
 *
 * @param {string} cwd
 * @returns {{taskId:string|null,userMessage:string,cwd:string}|null}
 */
function armBareResume(cwd) {
  if (!cwd || !_resumeEnabled()) return null;
  try {
    const boulder = require('./boulderState');
    const pending = pendingForCwd(cwd);
    if (!pending || !pending.userMessage) return null;

    if (pending.status === 'interrupted') {
      let flipped = false;
      if (pending.taskId) {
        const rearmed = boulder.rearmForResume(pending.taskId);
        if (rearmed) flipped = true;
      }
      if (!flipped) {
        // taskId 寻址不可用兜底：直接翻状态再存（保留既有 filesystemSnapshot）。
        try {
          const state = boulder.loadBoulderState(cwd);
          if (state) {
            state.status = 'in_progress';
            boulder.saveBoulderState(cwd, state);
          }
        } catch { /* 兜底失败也不抛——闸门仍可由用户手动重发触发 */ }
      }
    }

    return { taskId: pending.taskId, userMessage: pending.userMessage, cwd };
  } catch {
    return null;
  }
}

module.exports = {
  pendingForCwd,
  formatStartupHint,
  armBareResume,
  // 暴露内部助手供单测
  _resumeEnabled,
  _cleanInstruction,
  _ageLabel,
};
