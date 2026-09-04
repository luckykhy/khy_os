'use strict';

/**
 * channel.js — Driver 到 Worker 的唯一通道（一段纯自然语言文本）。
 *
 * 隔离的要点不是「少说点」，而是**信息单向且只有一条路**：Driver 侧知道任务编号、
 * 轮次要求、质检口径、验收标准；Worker 侧一个字都不能知道。原因很实在：Worker
 * 一旦知道自己在被打分，产出就会朝着评分表走而不是朝着真实需求走，轨迹也就失去了
 * 作为审计记录的意义。
 *
 * 于是本模块做三件事，每件都是「拒绝」而不是「悄悄改写」：
 *   1. scanForbidden()      扫项目管理词汇。命中硬词直接拦，绝不静默删词 —— 删词会
 *                           把一段本意含管理信息的文本伪装成干净文本，人看不出来，
 *                           问题会一路留到轨迹里。
 *   2. sanitizeEnv()        环境变量按白名单放行（deny by default），并额外扫放行
 *                           变量的值，值里带管理词的照样丢掉。
 *   3. buildWorkerMessage() 组装通道载荷：只有一段文本，不带任何附加字段。
 *
 * 误报是必须防的：中文里「轮」「分」太常用（轮播图、轮廓、评分组件都是正经前端
 * 需求），所以硬词一律用足够长的组合词，单字绝不入表；确有歧义的（评分、打分）
 * 降级成 soft，默认只报告不拦截，strict 模式才拦。
 *
 * @module services/auditTrajectory/channel
 */

/** 硬禁词：命中即拒绝。都是不可能出现在正经前端需求里的项目管理词汇。 */
const HARD_PATTERNS = [
  { re: /任务编号|任务号|任务\s*(?:id|ID)|工单号?/g, why: '任务编号属于项目管理信息' },
  { re: /第\s*[0-9一二三四五六七八九十]+\s*轮|轮次|轮数|本轮|上一轮|下一轮|这一轮|每一轮|有效轮|无效轮/g, why: '轮次要求属于项目管理信息' },
  { re: /质检|质量检查|抽检/g, why: '质检口径不能进入 Worker 上下文' },
  { re: /验收/g, why: '验收标准不能进入 Worker 上下文' },
  { re: /交付物|交付标准|交付清单/g, why: '交付物口径属于项目管理信息' },
  { re: /评分标准|打分标准|满分|得分率/g, why: '评分口径会让产出朝评分表走' },
  { re: /审计/g, why: '审计视角不能进入 Worker 上下文' },
  { re: /对话轨迹|开发轨迹|轨迹文件|轨迹记录/g, why: '轨迹是审计侧概念' },
  { re: /提示词|起草器?/g, why: '提示词生产过程属于 Driver 侧' },
  { re: /进度档案|项目管理/g, why: '项目管理档案不能进入 Worker 上下文' },
  { re: /\bQA\b/gi, why: 'QA 属于质检侧词汇' },
  { re: /\bacceptance\b|\bdeliverable(?:s)?\b|\brubric\b/gi, why: '验收、交付物、评分表属于项目管理词汇' },
  { re: /\bround\s*\d+\b|\biteration\s*\d+\b/gi, why: '轮次编号属于项目管理信息' },
  { re: /\btask\s*(?:id|no\.?|#)\b/gi, why: '任务编号属于项目管理信息' },
  { re: /\baudit\s*(?:trail|log|trajectory)\b/gi, why: '审计轨迹属于质检侧概念' },
];

/** 软禁词：有正经前端语义的歧义词，默认只报告；strict 模式才拦。 */
const SOFT_PATTERNS = [
  { re: /评分|打分/g, why: '可能指质检评分，也可能是评分组件需求，建议换词' },
  { re: /里程碑/g, why: '可能指项目里程碑' },
  { re: /\bmilestone\b|\bscore\b/gi, why: '可能指项目评分或里程碑' },
];

/**
 * 环境变量白名单：只有基础设施变量能进 Worker，且必须与项目管理无关。
 * KHY_AUDIT_TRAJECTORY 在列 —— 它只是「是否记录轨迹」的开关，值恒为 0 或 1，
 * 不携带任何任务、轮次、质检信息；Worker 需要它才能把自己的轨迹写下来。
 */
const ENV_ALLOW_EXACT = new Set([
  'KHY_AUDIT_TRAJECTORY',
  'KHY_AUDIT_PINNED_CWD',
  'KHYQUANT_CWD',
  'KHY_INK_TUI_ACTIVE',
]);

/** 进程跑不起来就缺不了的系统变量（原样透传）。 */
const ENV_ALLOW_SYSTEM = [
  'PATH', 'Path', 'PATHEXT', 'SystemRoot', 'SystemDrive', 'windir', 'ComSpec', 'TEMP', 'TMP', 'TMPDIR',
  'HOME', 'HOMEDRIVE', 'HOMEPATH', 'USERPROFILE', 'USERNAME', 'USER', 'LOGNAME', 'SHELL',
  'LANG', 'LC_ALL', 'TZ', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'OS',
  'APPDATA', 'LOCALAPPDATA', 'PROGRAMFILES', 'PROGRAMDATA', 'PUBLIC',
  'NODE_PATH', 'NODE_OPTIONS', 'NVM_DIR', 'npm_config_cache',
];

/** 变量名一看就带管理语义的，即使在系统白名单里也丢掉（防同名夹带）。 */
const ENV_NAME_DENY = /TASK|ROUND|ITERATION|QA|REVIEW|SCORE|GRADE|DELIVER|ACCEPT|RUBRIC|MILESTONE|DRAFT/i;

class ChannelViolationError extends Error {
  constructor(message, detail = {}) {
    super(message);
    this.name = 'ChannelViolationError';
    this.code = detail.code || 'CHANNEL_FORBIDDEN_VOCABULARY';
    Object.assign(this, detail);
  }
}

function _scan(patterns, text) {
  const hits = [];
  for (const p of patterns) {
    const flags = p.re.flags.includes('g') ? p.re.flags : p.re.flags + 'g';
    const re = new RegExp(p.re.source, flags);
    let m;
    while ((m = re.exec(text)) !== null) {
      hits.push({
        term: m[0],
        index: m.index,
        why: p.why,
        snippet: text.slice(Math.max(0, m.index - 12), m.index + m[0].length + 12).replace(/\s+/g, ' '),
      });
      if (m[0].length === 0) {
        re.lastIndex += 1; // 零宽匹配保护
      }
    }
  }
  return hits.sort((a, b) => a.index - b.index);
}

/**
 * 扫一段文本里的项目管理词汇。
 * @param {string} text
 * @returns {{ok:boolean, hard:Array, soft:Array, status:string}}
 */
function scanForbidden(text) {
  const s = String(text === undefined || text === null ? '' : text);
  const hard = _scan(HARD_PATTERNS, s);
  const soft = _scan(SOFT_PATTERNS, s);
  return {
    ok: hard.length === 0,
    hard,
    soft,
    status: '扫描 Worker 通道文本 ' + s.length + ' 字：硬禁词 ' + hard.length + ' 处 / 待确认 ' + soft.length + ' 处',
  };
}

/**
 * 组装通道载荷。这是 Driver 到 Worker 的唯一出口：只有 message 一个字段。
 *
 * @param {string} text 纯自然语言需求文本
 * @param {object} [opts] { strict: 软禁词也拦, minLength }
 * @returns {{ok:boolean, message:string, hard:Array, soft:Array, code?:string, reason?:string, status:string}}
 */
function buildWorkerMessage(text, opts = {}) {
  const message = String(text === undefined || text === null ? '' : text).trim();
  const minLength = Number.isFinite(opts.minLength) ? opts.minLength : 1;
  const scan = scanForbidden(message);

  if (message.length < minLength) {
    return {
      ok: false,
      message: '',
      hard: scan.hard,
      soft: scan.soft,
      code: 'CHANNEL_EMPTY',
      reason: '组装 Worker 通道文本：正文 ' + message.length + ' 字少于下限 ' + minLength + '，拒绝发出',
      status: scan.status,
    };
  }

  const blocking = !scan.ok ? scan.hard : opts.strict ? scan.soft : [];
  if (blocking.length > 0) {
    const list = blocking.slice(0, 6).map((h) => '「' + h.term + '」(' + h.why + ')').join('、');
    return {
      ok: false,
      message: '',
      hard: scan.hard,
      soft: scan.soft,
      code: 'CHANNEL_FORBIDDEN_VOCABULARY',
      // 不做静默删词：删掉之后人看不出这段文本原本带着管理信息，问题会一路留到轨迹里。
      reason: '组装 Worker 通道文本：命中 ' + blocking.length + ' 处项目管理词汇（' + list + '），拒绝发出，请改写后重试',
      status: scan.status,
    };
  }

  return { ok: true, message, hard: [], soft: scan.soft, status: scan.status };
}

/**
 * 同 buildWorkerMessage，不通过就抛。
 * @throws {ChannelViolationError}
 */
function assertWorkerMessage(text, opts = {}) {
  const r = buildWorkerMessage(text, opts);
  if (!r.ok) {
    throw new ChannelViolationError(r.reason, { code: r.code, hard: r.hard, soft: r.soft });
  }
  return r;
}

/**
 * 环境变量白名单过滤：deny by default，且放行变量的值也要过一遍硬禁词。
 *
 * @param {object} [env] 源环境（默认 process.env）
 * @param {object} [opts] { extra: 额外允许的变量名数组, overrides: 强制写入的键值 }
 * @returns {{env:object, dropped:Array, status:string}}
 */
function sanitizeEnv(env = process.env, opts = {}) {
  const src = env && typeof env === 'object' ? env : {};
  const extra = new Set((Array.isArray(opts.extra) ? opts.extra : []).map(String));
  const out = {};
  const dropped = [];

  for (const [name, value] of Object.entries(src)) {
    if (value === undefined || value === null) {
      continue;
    }
    const exact = ENV_ALLOW_EXACT.has(name);
    if (!exact && !ENV_ALLOW_SYSTEM.includes(name) && !extra.has(name)) {
      dropped.push({ name, why: '不在基础设施白名单内（deny by default）' });
      continue;
    }
    // 名字带管理语义的即使在系统白名单里也不放（防止用同名变量夹带）。
    if (!exact && ENV_NAME_DENY.test(name)) {
      dropped.push({ name, why: '变量名带项目管理语义' });
      continue;
    }
    const scan = scanForbidden(String(value));
    if (!scan.ok) {
      dropped.push({ name, why: '变量值命中管理词「' + scan.hard[0].term + '」' });
      continue;
    }
    out[name] = String(value);
  }

  for (const [name, value] of Object.entries(opts.overrides || {})) {
    if (value !== undefined && value !== null) {
      out[name] = String(value);
    }
  }

  return {
    env: out,
    dropped,
    status: '过滤 Worker 环境变量：放行 ' + Object.keys(out).length + ' 个 / 丢弃 ' + dropped.length + ' 个',
  };
}

module.exports = {
  ChannelViolationError,
  HARD_PATTERNS,
  SOFT_PATTERNS,
  ENV_ALLOW_EXACT,
  ENV_ALLOW_SYSTEM,
  ENV_NAME_DENY,
  scanForbidden,
  buildWorkerMessage,
  assertWorkerMessage,
  sanitizeEnv,
};
