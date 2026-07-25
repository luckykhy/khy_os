'use strict';

/**
 * tipScheduler.js — 启动轮换提示的选择逻辑。**纯叶子**（零 IO、确定性、绝不抛、
 * 门控字节回退）。移植 Claude Code tips 系统「背后的逻辑」而非其文案：
 *
 *   CC src/services/tips/tipHistory.ts   getSessionsSinceLastShown / recordTipShown
 *   CC src/services/tips/tipScheduler.ts selectTipWithLongestTimeSinceShown
 *   CC src/services/tips/tipRegistry.ts  getRelevantTips（cooldownSessions + isRelevant 过滤）
 *
 * 关键逻辑（可移植、确定性、无云）：
 *   1) 每条 tip 带 per-tip `cooldownSessions`——距上次显示的会话数 < 冷却值则不候选。
 *   2) `isRelevant(ctx)` 相关性判定（此处为**同步纯函数**，ctx-in；CC 用 async，khy
 *      收敛为同步以保持叶子纯净——诚实分歧，无功能损失，因判定只依赖 numStartups）。
 *   3) 候选中选「最久未显示」的一条（sessionsSinceLastShown 降序取首）——非轮询、非随机。
 *   4) 会话计数 + 每条 tip 的 lastShown 由**上层 IO 壳**（services/tipHistoryStore）跨会话
 *      持久化；本叶子只接收 history / numStartups 作参数，绝不读盘。
 *
 * khy 现状（本刀修复的缺口）：cli/repl.js 的 TIPS 数组 + `_tipIdx % length` 轮转
 * **喂给了空**（_tipIdx 从未被读），spinner.js 的 `_tipShown` 5s 标志也**不显示任何东西**——
 * 即 tips 是死代码。本刀让选择逻辑真正生效并跨会话持久，在启动横幅后浮现一条。
 */

const OFF_VALUES = ['0', 'false', 'off', 'no'];
const GATE = 'KHY_STARTUP_TIPS';

function tipsEnabled(env) {
  const raw = env && env[GATE];
  const v = String(raw == null ? '' : raw).trim().toLowerCase();
  return !OFF_VALUES.includes(v);
}

function _startups(ctx) {
  const n = ctx && Number(ctx.numStartups);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

// 内置 tips 注册表（khy 自有文案，指向真实存在的命令/功能）。每条：
//   { id, text, cooldownSessions, isRelevant?(ctx) }
// cooldownSessions 参差（对齐 CC 的 0/2/3/5/10… 分布），使不同提示的复现频率不同。
// isRelevant 仅少数几条使用（新用户早期提示），演示相关性逻辑——判定为同步纯函数。
const TIPS = [
  { id: 'btw', text: '/btw 在 AI 工作时插入不打断的提示', cooldownSessions: 5 },
  { id: 'review', text: '/review 自动多轮代码审查', cooldownSessions: 4 },
  { id: 'cost', text: '/cost 查看 AI 费用统计', cooldownSessions: 6 },
  { id: 'model', text: '/model 快速切换 AI 模型', cooldownSessions: 4 },
  { id: 'plan', text: '/plan 生成执行计划再动手', cooldownSessions: 5 },
  { id: 'hud', text: '/hud 展开完整仪表盘', cooldownSessions: 6 },
  { id: 'pool', text: 'pool list 管理 AI 账号池', cooldownSessions: 8 },
  { id: 'image', text: 'image <路径> 图片分析/网页还原', cooldownSessions: 8 },
  { id: 'shell', text: '!<命令> 直接跑 shell，输出进上下文（如 !git status）', cooldownSessions: 5 },
  { id: 'web-tools', text: '/web-tools 查看联网搜索后端与运行期动态引擎', cooldownSessions: 6 },
  // 新用户早期提示：仅前若干次启动相关（演示 isRelevant）。
  {
    id: 'esc-rewind',
    text: '双击 Esc 可回到上一条消息，编辑后重试',
    cooldownSessions: 3,
    isRelevant: (ctx) => _startups(ctx) < 15,
  },
  {
    id: 'trust-check',
    text: '陌生目录首次启动会先做一次安全检查——这是 khy 的一道护栏',
    cooldownSessions: 3,
    isRelevant: (ctx) => _startups(ctx) < 8,
  },
];

// CC tipHistory.getSessionsSinceLastShown：从未显示 → Infinity；否则 numStartups - lastShown。
function getSessionsSinceLastShown(tipId, history, numStartups) {
  const h = history && typeof history === 'object' ? history : {};
  const lastShown = h[tipId];
  if (lastShown == null || !Number.isFinite(Number(lastShown))) return Infinity;
  const n = Number(numStartups);
  const base = Number.isFinite(n) ? n : 0;
  const since = base - Number(lastShown);
  return Number.isFinite(since) ? since : Infinity;
}

// CC tipRegistry.getRelevantTips：保留 isRelevant(ctx) 为真 且 sessionsSince >= cooldownSessions 的。
function getRelevantTips(tips, history, numStartups, ctx) {
  const list = Array.isArray(tips) ? tips : [];
  const out = [];
  for (const tip of list) {
    if (!tip || typeof tip !== 'object' || !tip.id || !tip.text) continue;
    let relevant = true;
    if (typeof tip.isRelevant === 'function') {
      try {
        relevant = !!tip.isRelevant(ctx);
      } catch {
        relevant = false;
      }
    }
    if (!relevant) continue;
    const cooldown = Number(tip.cooldownSessions);
    const cd = Number.isFinite(cooldown) && cooldown >= 0 ? cooldown : 0;
    if (getSessionsSinceLastShown(tip.id, history, numStartups) >= cd) out.push(tip);
  }
  return out;
}

// CC tipScheduler.selectTipWithLongestTimeSinceShown：0→undefined，1→该条，否则按
// sessionsSince 降序取首（最久未显示）。稳定：等值（含全 Infinity 的首次启动）保持输入顺序。
function selectTipWithLongestTimeSinceShown(availableTips, history, numStartups) {
  const list = Array.isArray(availableTips) ? availableTips : [];
  if (list.length === 0) return undefined;
  if (list.length === 1) return list[0];
  let best = list[0];
  let bestSince = getSessionsSinceLastShown(best.id, history, numStartups);
  for (let i = 1; i < list.length; i++) {
    const since = getSessionsSinceLastShown(list[i].id, history, numStartups);
    if (since > bestSince) {
      best = list[i];
      bestSince = since;
    }
  }
  return best;
}

/**
 * 顶层编排：门控关 → null；否则过滤相关候选 → 选最久未显 → 返回 {id, text} 或 null。
 * 纯函数——history / numStartups / ctx 全由调用方（IO 壳）传入。
 * @param {Object} state {tips?, history?, numStartups?, ctx?}
 * @param {Object} env
 * @returns {{id:string, text:string}|null}
 */
function selectStartupTip(state, env) {
  try {
    if (!tipsEnabled(env)) return null;
    if (!state || typeof state !== 'object' || Array.isArray(state)) return null;
    const s = state;
    const tips = Array.isArray(s.tips) ? s.tips : TIPS;
    const history = s.history && typeof s.history === 'object' ? s.history : {};
    const numStartups = Number.isFinite(Number(s.numStartups)) ? Number(s.numStartups) : 0;
    const ctx = s.ctx && typeof s.ctx === 'object' ? s.ctx : { numStartups };
    const relevant = getRelevantTips(tips, history, numStartups, ctx);
    const tip = selectTipWithLongestTimeSinceShown(relevant, history, numStartups);
    if (!tip || !tip.id || !tip.text) return null;
    return { id: tip.id, text: tip.text };
  } catch {
    return null;
  }
}

module.exports = {
  TIPS,
  tipsEnabled,
  getSessionsSinceLastShown,
  getRelevantTips,
  selectTipWithLongestTimeSinceShown,
  selectStartupTip,
};
