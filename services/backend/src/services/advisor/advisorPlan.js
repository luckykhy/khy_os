'use strict';

/**
 * advisorPlan.js — `/advisor`(模型顾问 · 推荐当前最佳可执行模型)的零 IO 确定性单一真源(纯叶子)。
 *
 * 契约 (CONTRACT): 零 IO、确定性、绝不抛、无副作用;候选模型列表、各臂 UCB 统计、env 全经入参注入,
 * 本叶子绝不读 process.env、绝不触文件、绝不探测网络、绝不调 Date、绝不持有状态。真正的「探测各通道连通性
 * + 取 UCB 臂统计」(有网络/单例状态副作用)都在薄壳 handlers/advisor.js,委托既有 SSOT
 * (gateway/buildGatewayModelChoices 探测 + gateway/ucbRouter.rank 排名),绝不另起炉灶。本叶子只做:
 * 语法解析 + 把「候选 + 排名」合成为一份带理由的推荐 + 文本渲染。
 *
 * 背后的逻辑(对齐 Claude Code /advisor —— 但**诚实落到 khy 的本地语义**):CC 的 /advisor 是把一个**更强的
 * 云端 reviewer 模型**配成 server-tool,让主回合模型中途求教(纯云、绑定 Anthropic 一方、有 opus-4-7/
 * sonnet-4-6 之类**模型白名单硬编码**)。khy 没有云端 server-tool 这一层,**绝不伪造一个云顾问**;但 khy
 * **真有**一套本地可复用的同构基质 —— ① gateway 能探测「此刻哪些通道/模型真的可执行」(buildGatewayModelChoices),
 * ② ucbRouter 是一台**多臂老虎机**,以「成功率×速度」在线学习各 adapter 的实测回报(rank/select)。把这两者一合,
 * khy 的 /advisor = **基于实测表现,推荐此刻最该用的模型**,并给出理由(为何排第一、各臂均值/抽样次数)。这正是
 * 「学习 CC 显示的内容,更注重它背后的逻辑」:CC 的逻辑是「让更强模型给建议」,khy 的本地诚实兑现是「让实测数据
 * 给出最优选择建议」。绝不引入任何 host/port/model 硬编码 —— 候选与排名全来自既有探测/老虎机,模型名一律来自
 * 用户已配置的通道。
 *
 * 诚实边界(刻意不编造 khy 没有的语义):① khy 没有「云端 reviewer server-tool」,故本命令是**只读推荐器**,
 * 不会代替模型去做二次推理,只输出「该选谁 + 为何」;② 无任何臂统计时(老虎机尚无观测)如实说明「尚无实测数据,
 * 仅按可用性/失败次序排序」,绝不假装有学习证据;③ 不写 model 白名单 —— 任何用户已配且实测可执行的模型都能被
 * 推荐;④ 推荐**不自动切换**模型(只建议),切换仍走既有 /model 人工闸门。
 *
 * 注意:本文件刻意不在注释里书写 require-调用样式,避免架构债扫描器把它当成幽灵依赖边。本叶子零依赖。
 */

const _RECOMMEND_WORDS = new Set([
  'recommend', 'rec', 'suggest', 'best', 'pick', 'advise', 'advice',
  '推荐', '建议', '最佳', '选', '选哪个', '哪个好',
]);
const _STATUS_WORDS = new Set([
  'status', 'state', 'stat', 'stats', 'list', 'show',
  '状态', '查看', '列出', '列表',
]);
const _HELP_WORDS = new Set(['help', '-h', '--help', '帮助', '用法']);

/**
 * 解析 `/advisor [recommend|status|help]`。空参 = recommend(对齐 CC 默认给建议的语义)。
 * @param {string[]} args
 * @returns {{action:'recommend'|'status'|'help', valid:boolean, parseError:(string|null)}}
 */
function parseAdvisorArgs(args) {
  const list = Array.isArray(args) ? args : [];
  const first = list.length > 0 ? String(list[0] == null ? '' : list[0]).trim().toLowerCase() : '';

  if (first === '') return { action: 'recommend', valid: true, parseError: null };
  if (_HELP_WORDS.has(first)) return { action: 'help', valid: true, parseError: null };
  if (_RECOMMEND_WORDS.has(first)) return { action: 'recommend', valid: true, parseError: null };
  if (_STATUS_WORDS.has(first)) return { action: 'status', valid: true, parseError: null };

  return { action: 'recommend', valid: false, parseError: 'unknown_action' };
}

/**
 * 由「候选模型(来自探测)+ adapter 排名(来自 UCB 老虎机)」合成一份带理由的推荐。纯函数。
 *
 * @param {object} input
 * @param {Array<{adapter:string, model:(string|null), label?:string}>} input.candidates
 *   可执行候选(adapter+model);label 为人面展示串(可含可用性/延迟标记),缺则由 adapter/model 拼。
 * @param {Array<{adapter:string, value:number, mean:number, pulls:number}>} [input.ranking]
 *   ucbRouter.rank 的输出(按 UCB 值降序);可空(无臂统计时)。
 * @returns {{
 *   recommended: ({adapter:string, model:(string|null), mean:number, pulls:number, value:number}|null),
 *   ranked: Array<{adapter:string, model:(string|null), label:string, mean:number, pulls:number, value:number}>,
 *   hasEvidence: boolean,
 *   reason: string
 * }}
 */
function buildRecommendation(input) {
  const src = input && typeof input === 'object' ? input : {};
  const candidates = Array.isArray(src.candidates) ? src.candidates.filter(_isCand) : [];
  const ranking = Array.isArray(src.ranking) ? src.ranking : [];

  // adapter(小写) → 排名条目,便于把候选模型对齐到其 adapter 的 UCB 统计。
  const rankByAdapter = new Map();
  for (const r of ranking) {
    if (!r || r.adapter == null) continue;
    const key = String(r.adapter).trim().toLowerCase();
    if (key && !rankByAdapter.has(key)) rankByAdapter.set(key, r);
  }

  // 任意一臂有真实抽样(pulls>0)即视为「有实测证据」。
  let hasEvidence = false;
  for (const r of ranking) {
    if (r && Number(r.pulls) > 0) { hasEvidence = true; break; }
  }

  // 给每个候选附上其 adapter 的 UCB 统计;无对应统计 → 0/0(诚实留白)。
  const annotated = candidates.map((c, index) => {
    const adapter = String(c.adapter || '').trim();
    const r = rankByAdapter.get(adapter.toLowerCase()) || {};
    return {
      adapter,
      model: c.model == null ? null : String(c.model),
      label: _candLabel(c),
      mean: _num(r.mean),
      pulls: _intNonNeg(r.pulls),
      value: Number.isFinite(Number(r.value)) ? Number(r.value) : 0,
      _index: index, // 稳定 tie-break:保留候选入场次序
    };
  });

  // 排序:有 UCB value 用 value 降序;value 全相等(无证据)→ 保候选次序(稳定)。
  annotated.sort((a, b) => {
    if (a.value !== b.value) return b.value - a.value;
    return a._index - b._index;
  });

  const ranked = annotated.map((a) => ({
    adapter: a.adapter, model: a.model, label: a.label,
    mean: a.mean, pulls: a.pulls, value: a.value,
  }));

  const top = ranked.length > 0 ? ranked[0] : null;
  const recommended = top
    ? { adapter: top.adapter, model: top.model, mean: top.mean, pulls: top.pulls, value: top.value }
    : null;

  const reason = _buildReason(recommended, hasEvidence, ranked.length);
  return { recommended, ranked, hasEvidence, reason };
}

function _buildReason(top, hasEvidence, count) {
  if (!top) {
    return '当前无可执行模型可推荐 —— 请先用 /model 或 /gateway 配置并实测一个可用通道。';
  }
  const who = _modelLabel(top.adapter, top.model);
  if (hasEvidence && top.pulls > 0) {
    const meanPct = Math.round(top.mean * 100);
    return `推荐 ${who}:在 ${count} 个可执行候选中,其实测回报(成功率×速度)经多臂老虎机评估最高`
      + `(均值 ${meanPct}/100,样本 ${top.pulls} 次)。`;
  }
  return `推荐 ${who}:当前尚无足够实测数据,暂按可用性/失败切换次序排序给出首选;`
    + `随着实际调用累积,推荐会自动收敛到表现最好的通道。`;
}

/**
 * 渲染推荐文本(action=recommend)。
 * @param {object} rec - buildRecommendation 的输出
 * @returns {string}
 */
function buildRecommendText(rec) {
  const r = rec && typeof rec === 'object' ? rec : {};
  const lines = [];
  lines.push('🧭 模型顾问(advisor) —— 基于实测表现推荐当前最佳可执行模型');
  if (!r.recommended) {
    lines.push(`  ${r.reason || '当前无可推荐模型。'}`);
    return lines.join('\n');
  }
  lines.push(`  ▶ 首选: ${_modelLabel(r.recommended.adapter, r.recommended.model)}`);
  lines.push(`    理由: ${r.reason}`);
  const ranked = Array.isArray(r.ranked) ? r.ranked : [];
  if (ranked.length > 1) {
    lines.push('  候选排名(按实测 UCB 值):');
    ranked.slice(0, 8).forEach((c, i) => {
      lines.push(`    ${i + 1}. ${_modelLabel(c.adapter, c.model)}${_evidenceSuffix(c)}`);
    });
    if (ranked.length > 8) lines.push(`    … 另有 ${ranked.length - 8} 个候选未列出`);
  }
  lines.push('  说明: 这是只读建议,不会自动切换;采纳请用 /model 选择(人工确认)。');
  return lines.join('\n');
}

/**
 * 渲染状态文本(action=status)—— 透出每个候选的实测均值/样本,诚实呈现学习进度。
 * @param {object} rec - buildRecommendation 的输出
 * @returns {string}
 */
function buildStatusText(rec) {
  const r = rec && typeof rec === 'object' ? rec : {};
  const ranked = Array.isArray(r.ranked) ? r.ranked : [];
  const lines = [];
  lines.push('🧭 模型顾问 · 实测表现快照');
  if (ranked.length === 0) {
    lines.push('  当前无可执行候选(请先用 /model 或 /gateway 配置可用通道)。');
    return lines.join('\n');
  }
  lines.push(`  ${r.hasEvidence ? '已积累实测数据(成功率×速度,经多臂老虎机评估):' : '尚无实测数据 —— 下方仅按可用性/失败次序排序:'}`);
  ranked.forEach((c, i) => {
    const meanPct = Math.round(c.mean * 100);
    const ev = c.pulls > 0 ? `均值 ${meanPct}/100 · 样本 ${c.pulls}` : '无样本';
    lines.push(`    ${i + 1}. ${_modelLabel(c.adapter, c.model)}  [${ev}]`);
  });
  return lines.join('\n');
}

function buildHelpText() {
  return [
    '/advisor —— 模型顾问:基于实测表现推荐当前最佳可执行模型(对齐 Claude Code /advisor 的「求一个更优建议」逻辑)',
    '  用法:',
    '    /advisor            推荐当前最佳可执行模型(默认)',
    '    /advisor recommend  同上',
    '    /advisor status     查看各候选的实测表现快照(均值/样本数)',
    '  说明:',
    '    · khy 的 advisor 是**本地只读推荐器** —— 复用 gateway 的连通性探测 + 多臂老虎机(成功率×速度)的实测回报,',
    '      推荐此刻最该用的模型并给出理由;它**不会自动切换**(采纳请用 /model 人工确认)。',
    '    · 与 CC 的云端 reviewer server-tool 语义不同:khy 不伪造云顾问,只用本地实测数据给出诚实建议。',
  ].join('\n');
}

function buildUnknownText() {
  return `未知子命令。${buildHelpText()}`;
}

/**
 * 门控 KHY_ADVISOR_COMMAND(默认开;关时薄壳字节回退为「不接管」)。
 * @param {object} env
 * @returns {boolean}
 */
function isEnabled(env) {
  const e = env || {};
  const raw = e.KHY_ADVISOR_COMMAND === undefined ? 'true' : e.KHY_ADVISOR_COMMAND;
  const s = String(raw == null ? '' : raw).trim().toLowerCase();
  return !(s === '' || s === '0' || s === 'false' || s === 'off' || s === 'no');
}

// ── 内部纯助手 ───────────────────────────────────────────────────────────────
function _isCand(c) {
  return c && typeof c === 'object' && c.adapter != null && String(c.adapter).trim() !== '';
}
function _candLabel(c) {
  if (c && typeof c.label === 'string' && c.label.trim() !== '') return c.label;
  return _modelLabel(c && c.adapter, c && c.model);
}
function _modelLabel(adapter, model) {
  const a = String(adapter == null ? '' : adapter).trim() || '(未知通道)';
  const m = model == null || String(model).trim() === '' ? '(默认模型)' : String(model).trim();
  return `${m} · 通道 ${a}`;
}
function _evidenceSuffix(c) {
  if (!c || _intNonNeg(c.pulls) <= 0) return '';
  return `  (均值 ${Math.round(_num(c.mean) * 100)}/100 · 样本 ${_intNonNeg(c.pulls)})`;
}
// 有限数强转家族单一真源 utils/finiteNumber(见 finiteNumber.js)。
const _num = require('../../utils/finiteNumber').toFiniteOr0;
function _intNonNeg(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.floor(n);
}

module.exports = {
  parseAdvisorArgs,
  buildRecommendation,
  buildRecommendText,
  buildStatusText,
  buildHelpText,
  buildUnknownText,
  isEnabled,
};
