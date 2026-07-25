'use strict';

/**
 * futureProofing.js — 纯叶子 (pure leaf)：khyos「与时俱进」体检的单一真源。
 *
 * 契约 (CONTRACT)：零 IO、确定性、绝不抛、env 门控默认开 (KHY_FUTURE_PROOFING)。
 *   本模块不读文件、不连网、不读 env 做副作用——所有外部事实（当前日期、Node 版本、
 *   已钉选的模型、维护设施/守卫是否接线）都由调用方 (handler) 探测后**作为参数传入**，
 *   本叶子只做确定性的判级与给出可执行的修复命令。这样弱模型/无 AI 的维护者也能在提交前
 *   跑 `khy maintain freshness` 看清「项目是否还跟得上时代」，且每个发现都附「怎么修」。
 *
 * 设计意图 (为什么存在)：
 *   作者订阅到期后无法再亲自维护 khyos。要让它「在社会与资本中与时俱进不被淘汰」，
 *   必须把「该升级运行时了 / 该换模型了 / 维护免疫系统是否还在 / 守卫是否还接着」这些
 *   本来靠人记得的事，固化成一条确定性体检命令——把「跟上时代」从自觉变成可执行清单。
 *
 * 门控：KHY_FUTURE_PROOFING 默认开，置 {0,false,off,no} 关闭主动提示；
 *   但 buildFreshnessReport/renderFreshness 永远可用（门控只影响主动 hint）。
 */

// ── Node.js 主版本 EOL 基线表（确定性内置，随发布手动维护）─────────────────
// 来源：Node.js Release Working Group 的 LTS 计划。值为各 major 的 End-of-Life 日期。
// 维护者换 Node 不需要改这里；这里只用于提醒「你正在跑的 Node 是否已过保」。
const NODE_EOL = {
  12: '2022-04-30',
  14: '2023-04-30',
  16: '2023-09-11',
  18: '2025-04-30',
  20: '2026-04-30',
  22: '2027-04-30',
  23: '2025-06-01', // 奇数版本非 LTS，保期短
  24: '2028-04-30',
};
// 表中最高的 LTS major（比它更新的版本一律视为「足够新」，不误报）。
const NODE_NEWEST_KNOWN = 24;
// 距 EOL 多少天内算「临近」（yellow）。
const EOL_WARN_WINDOW_DAYS = 180;

// ── 已知退役/旧代模型 id（确定性内置，零假阳性：只列业内公认已被取代的精确 id）──
// 命中 IDENTITY 档（opus/sonnet/haiku）才告警；直连 legacy 档（openaiDirect 等）本就
// 是兼容旧端点的保留值，不在此表，避免误伤。维护者换模型只改 constants/models.js 一处。
const RETIRED_MODEL_IDS = new Set([
  'claude-1', 'claude-2', 'claude-2.1',
  'claude-instant-1', 'claude-instant-1.2',
  'gpt-3', 'gpt-3.5', 'text-davinci-003',
  'gemini-1.0-pro', 'gemini-pro',
]);

// ── 已排定退役日期的模型表（对齐 CC deprecation.ts·随发布手动维护）────────────
// 与上面的 RETIRED_MODEL_IDS **正交**：那张表是「已彻底退役、无日期」的旧代 id，只在
// `khy maintain freshness` 报告里出现；本表是「仍在服役但已排定退役日期」的模型,按 API
// 供应商分列日期（firstParty/bedrock/vertex/foundry，null=该供应商未排退役），供**启动时**
// 对当前钉选模型给一行 CC 风格提示。键为 model id 的**子串**（大小写不敏感匹配）；两表条目
// 刻意不重叠。加新退役模型只加一条。数据镜像 CC 的 DEPRECATED_MODELS（作者维护的快照）。
const MODEL_RETIREMENT = {
  'claude-3-opus': {
    name: 'Claude 3 Opus',
    dates: {
      firstParty: 'January 5, 2026', bedrock: 'January 15, 2026',
      vertex: 'January 5, 2026', foundry: 'January 5, 2026',
    },
  },
  'claude-3-7-sonnet': {
    name: 'Claude 3.7 Sonnet',
    dates: {
      firstParty: 'February 19, 2026', bedrock: 'April 28, 2026',
      vertex: 'May 11, 2026', foundry: 'February 19, 2026',
    },
  },
  'claude-3-5-haiku': {
    name: 'Claude 3.5 Haiku',
    dates: {
      firstParty: 'February 19, 2026', bedrock: null, vertex: null, foundry: null,
    },
  },
};

const STATUS = { GREEN: 'green', YELLOW: 'yellow', RED: 'red' };
const SEVERITY = { green: 0, yellow: 1, red: 2 };

/** 是否启用（仅影响主动 hint；门控关 → 字节回退）。 */
function isEnabled(env = (typeof process !== 'undefined' ? process.env : {})) {
  const v = String((env && env.KHY_FUTURE_PROOFING) || '').trim().toLowerCase();
  return !['0', 'false', 'off', 'no'].includes(v);
}

/** 解析 ISO/Date → epoch ms；fail-soft 返回 NaN（绝不抛）。 */
function _toMs(d) {
  try {
    if (d == null) return NaN;
    if (d instanceof Date) return d.getTime();
    const t = Date.parse(String(d));
    return Number.isFinite(t) ? t : NaN;
  } catch { return NaN; }
}

/** 从 'v18.19.0' / '18.19.0' / 18 解析出 major 整数；失败 → NaN。 */
function _nodeMajor(ver) {
  try {
    if (typeof ver === 'number' && Number.isFinite(ver)) return Math.trunc(ver);
    const m = String(ver || '').trim().replace(/^v/i, '').match(/^(\d+)/);
    return m ? parseInt(m[1], 10) : NaN;
  } catch { return NaN; }
}

const DAY_MS = 86400000;

/**
 * 运行时 EOL 检查：你跑的 Node 是否已过保 / 临近过保。
 * @param {string|number} nodeVersion  例 process.version
 * @param {number} nowMs               当前时刻 epoch ms（调用方传入，保持确定性）
 */
function _checkRuntimeEol(nodeVersion, nowMs) {
  const id = 'runtime-eol';
  const label = '运行时保期 (Node.js)';
  const major = _nodeMajor(nodeVersion);
  if (!Number.isFinite(major)) {
    return { id, label, status: STATUS.GREEN, detail: '无法识别 Node 版本，跳过（不阻断）', action: null };
  }
  if (major >= NODE_NEWEST_KNOWN) {
    return { id, label, status: STATUS.GREEN, detail: `Node ${major} 足够新`, action: null };
  }
  const eol = NODE_EOL[major];
  if (!eol || !Number.isFinite(nowMs)) {
    // 比已知最旧还旧（无表项）或时间不可用：低于已知最旧 LTS → 红，否则不阻断。
    const knownMajors = Object.keys(NODE_EOL).map(Number);
    const oldest = Math.min(...knownMajors);
    if (Number.isFinite(major) && major < oldest) {
      return {
        id, label, status: STATUS.RED,
        detail: `Node ${major} 早已停止支持`,
        action: '升级到当前 LTS：nvm install --lts && nvm use --lts',
      };
    }
    return { id, label, status: STATUS.GREEN, detail: `Node ${major}`, action: null };
  }
  const eolMs = _toMs(eol);
  if (nowMs > eolMs) {
    const overDays = Math.floor((nowMs - eolMs) / DAY_MS);
    return {
      id, label, status: STATUS.RED,
      detail: `Node ${major} 已于 ${eol} 停止支持（已过 ${overDays} 天，存安全风险）`,
      action: '升级到当前 LTS：nvm install --lts && nvm use --lts（或用系统包管理器）',
    };
  }
  const daysLeft = Math.ceil((eolMs - nowMs) / DAY_MS);
  if (daysLeft <= EOL_WARN_WINDOW_DAYS) {
    return {
      id, label, status: STATUS.YELLOW,
      detail: `Node ${major} 将于 ${eol} 停止支持（剩 ${daysLeft} 天）`,
      action: '提前规划升级到下一 LTS：nvm install --lts',
    };
  }
  return { id, label, status: STATUS.GREEN, detail: `Node ${major} 在保期内（至 ${eol}）`, action: null };
}

/**
 * 模型时效检查：把当前钉选的首选模型摆出来，并指明「换模型只改一处」的命令。
 * 确定性：命中内置退役表才 yellow，否则 green（不靠联网猜「有没有更新」）。
 * @param {Object} primaryModels  constants/models 的 PRIMARY map
 */
function _checkModelCurrency(primaryModels) {
  const id = 'model-currency';
  const label = '模型时效 (单一真源)';
  const p = (primaryModels && typeof primaryModels === 'object') ? primaryModels : {};
  const identityKeys = ['opus', 'sonnet', 'haiku'];
  const identity = identityKeys
    .map((k) => p[k])
    .filter((v) => typeof v === 'string' && v.trim());
  if (!identity.length) {
    return {
      id, label, status: STATUS.YELLOW,
      detail: '未能读到首选模型（constants/models.js 的 PRIMARY 可能缺失）',
      action: '检查 services/backend/src/constants/models.js 的 PRIMARY 映射',
    };
  }
  const retired = identity.filter((m) => RETIRED_MODEL_IDS.has(String(m).toLowerCase()));
  if (retired.length) {
    return {
      id, label, status: STATUS.YELLOW,
      detail: `身份模型疑似已退役：${retired.join('、')}`,
      action: '在 constants/models.js 把对应数组首位换成在售型号（改一处，全仓生效）',
    };
  }
  return {
    id, label, status: STATUS.GREEN,
    detail: `首选模型：${identity.join('、')}（换模型只改 constants/models.js 一处）`,
    action: null,
  };
}

/**
 * 自维护接线检查：维护者免疫系统的几根支柱是否还在。
 * @param {Object} wiring 形如 { aiSeedDocs, maintenanceLaunchers, inheritanceDoc, pipLifeline }
 *                        值为 boolean（调用方探测文件存在性后传入）
 */
function _checkSelfMaintenance(wiring) {
  const id = 'self-maintenance';
  const label = '自维护设施';
  const w = (wiring && typeof wiring === 'object') ? wiring : {};
  const pillars = [
    ['pipLifeline', 'pip 发布生命线 (setup.py)', 'pip 是唯一发布渠道，缺失即无法分发'],
    ['aiSeedDocs', '.ai/ 种子文档', '运行 khy metadata refresh 重建'],
    ['maintenanceLaunchers', 'maintenance/ 双击启动器', '运行 npm run maintenance:generate 重建'],
    ['inheritanceDoc', '传承书 (docs/传承/)', '它是无 AI 维护的操作宪法，应随仓库保留'],
  ];
  const missing = pillars.filter(([key]) => w[key] === false);
  if (!missing.length) {
    return { id, label, status: STATUS.GREEN, detail: '免疫系统四根支柱齐备', action: null };
  }
  // pip 生命线缺失 = red（无法分发）；其余 = yellow（可重建）。
  const lifelineGone = missing.some(([k]) => k === 'pipLifeline');
  return {
    id, label,
    status: lifelineGone ? STATUS.RED : STATUS.YELLOW,
    detail: `缺失：${missing.map(([, l]) => l).join('、')}`,
    action: (missing.find(([k]) => k === 'pipLifeline') || missing[0])[2],
  };
}

/**
 * 守卫覆盖检查：提交时门禁链（check:small-model:safety）是否还接着各机器守卫。
 * @param {Object} guards 形如 { 'check-agent-rules': true, 'check-leaf-contract': true, ... }
 *                        值为 boolean（调用方从 package.json 脚本串里解析后传入）
 */
function _checkGuardCoverage(guards) {
  const id = 'guard-coverage';
  const label = '守卫覆盖 (提交门禁)';
  const g = (guards && typeof guards === 'object') ? guards : {};
  const expected = [
    'check-agent-rules',
    'check-leaf-contract',
    'check-model-hardcoding',
    'check-change-safety',
  ];
  const known = expected.filter((k) => k in g);
  if (!known.length) {
    return {
      id, label, status: STATUS.YELLOW,
      detail: '无法解析守卫接线（package.json 脚本未传入）',
      action: '检查 package.json 的 check:small-model:safety 脚本串',
    };
  }
  const off = expected.filter((k) => g[k] === false);
  if (off.length) {
    return {
      id, label, status: STATUS.YELLOW,
      detail: `未接线的守卫：${off.join('、')}`,
      action: '把缺失守卫串回 package.json 的 check:small-model:safety',
    };
  }
  return { id, label, status: STATUS.GREEN, detail: `${known.length} 个机器守卫均已接入提交门禁`, action: null };
}

/**
 * 汇总「与时俱进」体检报告。纯函数：所有事实由 context 传入。
 * @param {Object} ctx
 * @param {Date|string} [ctx.now]            当前时刻（默认不可用时退化为只跑非时间项）
 * @param {string|number} [ctx.nodeVersion]  运行 Node 版本
 * @param {Object} [ctx.primaryModels]       constants/models 的 PRIMARY map
 * @param {Object} [ctx.wiring]              自维护设施存在性 booleans
 * @param {Object} [ctx.guards]              守卫接线 booleans
 * @returns {{checks:Array,level:string,summary:string,ok:boolean}}
 */
function buildFreshnessReport(ctx = {}) {
  const nowMs = _toMs(ctx.now);
  const checks = [
    _checkRuntimeEol(ctx.nodeVersion, nowMs),
    _checkModelCurrency(ctx.primaryModels),
    _checkSelfMaintenance(ctx.wiring),
    _checkGuardCoverage(ctx.guards),
  ];
  let level = STATUS.GREEN;
  for (const c of checks) {
    if ((SEVERITY[c.status] || 0) > (SEVERITY[level] || 0)) level = c.status;
  }
  const reds = checks.filter((c) => c.status === STATUS.RED).length;
  const yellows = checks.filter((c) => c.status === STATUS.YELLOW).length;
  let summary;
  if (level === STATUS.GREEN) summary = '项目与时代同步，无需处理。';
  else if (level === STATUS.RED) summary = `有 ${reds} 项需立即处理${yellows ? `、${yellows} 项待办` : ''}。`;
  else summary = `有 ${yellows} 项待办（非紧急）。`;
  return { checks, level, summary, ok: level !== STATUS.RED };
}

/**
 * 渲染报告为行数组（默认无色；传 color fn 才上色），确定性、零 IO。
 * @param {Object} report buildFreshnessReport 的返回
 * @param {Object} [opts]
 * @param {Function} [opts.color] (text, status) => string
 */
function renderFreshness(report, opts = {}) {
  const r = (report && Array.isArray(report.checks)) ? report : { checks: [], level: STATUS.GREEN, summary: '' };
  const color = typeof opts.color === 'function' ? opts.color : (t) => t;
  const icon = { green: '✓', yellow: '⚠', red: '✗' };
  const lines = [];
  lines.push(color('与时俱进体检', 'header'));
  for (const c of r.checks) {
    const head = `${icon[c.status] || '·'} ${c.label}：${c.detail || ''}`;
    lines.push(color(head, c.status));
    if (c.action) lines.push(color(`    → ${c.action}`, 'action'));
  }
  lines.push(color(`总体：${r.summary || ''}`, r.level));
  return lines;
}

/** 一行主动提示（门控 KHY_FUTURE_PROOFING）。 */
function freshnessHintLine(env) {
  if (!isEnabled(env)) return '';
  return '💡 想知道 khyos 是否还跟得上时代？运行 `khy maintain freshness` 做一次与时俱进体检。';
}

/** 模型退役启动提示是否启用（独立子门控 KHY_MODEL_DEPRECATION_NOTICE，默认开）。 */
function isModelDeprecationEnabled(env = (typeof process !== 'undefined' ? process.env : {})) {
  const v = String((env && env.KHY_MODEL_DEPRECATION_NOTICE) || '').trim().toLowerCase();
  return !['0', 'false', 'off', 'no'].includes(v);
}

/**
 * 把 khy 适配器名归一到 CC 的 API 供应商档（firstParty/bedrock/vertex/foundry）——决定
 * 用退役表的哪一列日期。khy 无 bedrock/vertex/foundry 集成，默认 firstParty（直连
 * Anthropic 或经中继仍是 Anthropic 模型）；仅当适配器名**显式**含 bedrock/vertex/
 * azure|foundry 才走对应档。诚实边界：非 Anthropic 模型 id 不在退役表中永不命中，故对
 * ollama/openai 等本地/异厂适配器归到 firstParty 也不会误报。
 */
function _apiProviderBucket(adapterName) {
  const s = String(adapterName || '').toLowerCase();
  if (s.includes('bedrock')) return 'bedrock';
  if (s.includes('vertex')) return 'vertex';
  if (s.includes('foundry') || s.includes('azure')) return 'foundry';
  return 'firstParty';
}

/**
 * 当前钉选模型的退役提示（对齐 CC getModelDeprecationWarning，加入时态感知）。
 * 纯函数：modelId / provider / 当前时刻均由调用方传入，叶子零 IO 确定性、绝不抛。
 * @param {string|null} modelId  当前 resolved 模型 id
 * @param {Object} [opts]
 * @param {string} [opts.adapterName]  khy 适配器名（映射到供应商档选日期列）
 * @param {string} [opts.provider]     直接给 CC 供应商档（优先于 adapterName）
 * @param {number} [opts.nowMs]        当前 epoch ms（决定「已于/将于」时态；缺省→中性「计划于」）
 * @param {Object} [opts.env]          门控 env
 * @returns {string|null}  一行中文提示，或 null（未命中/门控关/坏输入）
 */
function getModelRetirementNotice(modelId, opts = {}) {
  try {
    const env = opts.env || (typeof process !== 'undefined' ? process.env : {});
    if (!isModelDeprecationEnabled(env)) return null;
    if (typeof modelId !== 'string' || !modelId.trim()) return null;
    const lower = modelId.toLowerCase();
    const provider = opts.provider || _apiProviderBucket(opts.adapterName);
    for (const key of Object.keys(MODEL_RETIREMENT)) {
      const entry = MODEL_RETIREMENT[key];
      const date = entry && entry.dates ? entry.dates[provider] : null;
      if (!lower.includes(key) || !date) continue;
      // 时态：过去→已于；未来→将于；now 不可用→中性「计划于」（CC 无时态，恒 "will be retired"）。
      let verb = '计划于';
      const nowMs = opts.nowMs;
      const dateMs = _toMs(date);
      if (Number.isFinite(nowMs) && Number.isFinite(dateMs)) {
        verb = nowMs > dateMs ? '已于' : '将于';
      }
      return `⚠ ${entry.name} ${verb} ${date} 退役，建议切换到更新的模型。`;
    }
    return null;
  } catch {
    return null;
  }
}

module.exports = {
  buildFreshnessReport,
  renderFreshness,
  freshnessHintLine,
  isEnabled,
  isModelDeprecationEnabled,
  getModelRetirementNotice,
  // exposed for tests
  NODE_EOL,
  RETIRED_MODEL_IDS,
  MODEL_RETIREMENT,
  _apiProviderBucket,
  _checkRuntimeEol,
  _checkModelCurrency,
  _checkSelfMaintenance,
  _checkGuardCoverage,
};
