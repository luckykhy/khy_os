'use strict';

/**
 * resumeHint — 会话退出时「如何还原上下文」提示文案的单一真源(SSOT)。
 *
 * 背景(为何存在):经典 REPL(replSession.js::printResumeRecoveryHints)与 Ink TUI
 *   (tui/app.jsx::printInkResumeHint)各自内联了这段提示的中文文案。两处本应一致,
 *   实际已轻微漂移(经典把「或指定会话」整行 dim;TUI 把命令片段 cyan)。改一处忘另一处
 *   正是分叉源。本叶子把 liveId 分支的文案+着色抽成两入口共同消费的结构化段,收敛为一份。
 *
 * 契约(纯叶子·零 IO·确定性·绝不抛·不 mutate 入参):
 *   buildResumeHintLines({ liveId }) → 行数组;每行是 [{ text, tone }] 段序列,
 *   tone ∈ 'dim' | 'cyan'。调用方按各自 chalk 把 tone 映射为颜色后拼接输出——
 *   保证两入口对同一 liveId 渲染**完全一致**。liveId 为空 → 返回 [](无可提示)。
 *
 * 着色约定(收敛后的规范形态):命令 token(/resume、khy resume <id>)用 cyan,
 *   其余说明文字用 dim。这统一了历史上经典 REPL 第二行「全 dim」与 TUI「命令 cyan」的分叉。
 *
 * === HOW TO EXTEND ===
 *   要改提示文案/着色:只改这里。经典 REPL 与 TUI 都消费 buildResumeHintLines,自动同步。
 *   新增 tone 时,两个调用方的 tone→chalk 映射也要各加一支(dim/cyan 已覆盖当前所有段)。
 */

/**
 * 构造 liveId 分支的还原提示行。
 * @param {object} args
 * @param {string} [args.liveId] 当前/最近会话 id
 * @returns {Array<Array<{text:string, tone:'dim'|'cyan'}>>} 行数组(每行为段序列)
 */
function buildResumeHintLines({ liveId } = {}) {
  const id = String(liveId || '').trim();
  if (!id) return [];
  return [
    [
      { text: '  完整对话已保存，下次启动输入 ', tone: 'dim' },
      { text: '/resume', tone: 'cyan' },
      { text: ' 即可还原完整上下文', tone: 'dim' },
    ],
    [
      { text: '  或指定会话: ', tone: 'dim' },
      { text: `khy resume ${id}`, tone: 'cyan' },
    ],
  ];
}

/**
 * 便利渲染器:给定 tone→着色函数映射,把行数组拼成字符串数组(每行一条)。
 * 调用方可直接 forEach(console.log)。着色函数缺失时按原文透传(绝不抛)。
 * @param {Array<Array<{text:string,tone:string}>>} lines
 * @param {Object<string,(s:string)=>string>} toneFns 例 { dim: chalk.dim, cyan: chalk.cyan }
 * @returns {string[]}
 */
function renderResumeHintLines(lines, toneFns = {}) {
  const rows = Array.isArray(lines) ? lines : [];
  return rows.map((segs) =>
    (Array.isArray(segs) ? segs : [])
      .map((seg) => {
        const fn = seg && toneFns && typeof toneFns[seg.tone] === 'function' ? toneFns[seg.tone] : null;
        const text = (seg && seg.text) || '';
        return fn ? fn(text) : text;
      })
      .join(''),
  );
}

module.exports = { buildResumeHintLines, renderResumeHintLines };
