'use strict';

/**
 * progressLog.js — 「学习/工作进度检查点」纯叶子(零 IO、零状态、不读时钟、绝不抛)。
 *
 * 诉求根因(goal 2026-07-03「…感觉 khy 特别健忘,比如我建一个考公文件夹让 khy 教我学习,
 * 但没有记忆记不住我学到哪,下一次又重新开始,无法形成闭环」):
 *   四层记忆的**写入侧**只由 memoryTrigger 的 4 条窄正则(记住/我叫/我习惯用/项目约定)触发,
 *   而「学到哪了、下一步学什么」既不是显式指令、也不是身份/偏好/项目约定 → 永不被写下;
 *   加之系统提示**明令**不得保存「in-progress work / 当前会话上下文」(memdir 的防噪护栏,
 *   load-bearing 不能削弱)→ 进度天然无处落盘 → 下次会话从零开始 → 闭环断在**写入**这一环。
 *
 * 本刀补的正是这条闭环,且刻意**与人类维护的项目 MEMORY.md 分离**(那份契约禁写易逝状态,
 * 是对的);进度写进独立的、追加式的 PROGRESS.md(每项目一份,按项目根隔离)。三段弧:
 *   ①写:模型在里程碑处调 RecordProgress 工具 → memdir.appendProjectProgress 追加一条检查点;
 *   ②存:append-only,天然不覆盖历史,每条含 时间/主题/已覆盖/下一步;
 *   ③召:新会话开场,把「每个主题最近一次检查点」装配进系统提示 = 「你上次学到哪、接着学什么」。
 *
 * 本叶子只做**纯变换**:格式化一条检查点为可追加的 markdown 块、把原文解析回结构化条目、
 * 按主题去重留最新、渲染成开场召回段。真正写盘/读盘/读时钟归 memdir.js 的 IO 壳(时钟由其
 * 以 nowIso 参数注入,保持本叶子零时钟依赖 → 确定性可测)。
 *
 * 机器数据编码进哨兵注释(encodeURIComponent:绝不含空格与 `-->`,故解析对任意含换行/空格/
 * CJK 的自由文本都健壮);可见行仅供人读。解析只认哨兵行,与散文彻底解耦。
 *
 * 门控(默认开,值 ∈{0,false,off,no} 关;并遵从 KHY_DISABLE_MEMORY 总开关):
 *   KHY_PROGRESS_LOG         —— 进度日志总开关(写 + 召回)。关 ⇒ 写为 no-op、召回返 null。
 *   KHY_PROGRESS_LOG_RECALL  —— 仅开场召回子层(独立)。关 ⇒ 仍写、但不注入系统提示。
 */

const OFF = new Set(['0', 'false', 'off', 'no']);

function _off(v) {
  return OFF.has(String(v == null ? '' : v).trim().toLowerCase());
}

/** 进度日志总门控(默认开)。遵从 KHY_DISABLE_MEMORY(=1/true 时整体关)。 */
function isEnabled(env) {
  const e = env || process.env || {};
  const dis = String(e.KHY_DISABLE_MEMORY || '').trim().toLowerCase();
  if (dis === '1' || dis === 'true') return false;
  return !_off(e.KHY_PROGRESS_LOG);
}

/** 开场召回子门控(默认开)。父关即关(父→子优先级)。 */
function isRecallEnabled(env) {
  if (!isEnabled(env)) return false;
  return !_off((env || process.env || {}).KHY_PROGRESS_LOG_RECALL);
}

// 单条字段上限(防止无界膨胀;超出截断并加省略号)。
const MAX_FIELD = 600;
// 召回时最多展示多少个主题的最近检查点。
const MAX_RECALL_TOPICS = 8;

/** 新建 PROGRESS.md 时的一次性文件头(人类可读,说明这份文件的性质)。 */
const PROGRESS_HEADER = [
  '# 项目进度检查点 (Project Progress Log)',
  '',
  '> 追加式记录:模型在学习/工作里程碑处写下「已覆盖 / 下一步」,',
  '> 供下次会话开场召回,形成跨会话闭环。按项目根隔离,与人类维护的 MEMORY.md 分离。',
  '> 每条以 `<!-- @progress ... -->` 哨兵开头(机器可解析),下面几行供人阅读。',
  '',
  '',
].join('\n');

// 收敛到 utils/collapseWhitespace 单一真源(逐字节委托,调用点不变)
const _oneLine = require('../../utils/collapseWhitespace');

function _clip(s) {
  const t = String(s == null ? '' : s);
  return t.length > MAX_FIELD ? (t.slice(0, MAX_FIELD - 1) + '…') : t;
}

function _enc(s) {
  return encodeURIComponent(_clip(_oneLine(s)));
}

function _dec(s) {
  try { return decodeURIComponent(String(s || '')); } catch { return String(s || ''); }
}

/** ISO 时间戳 → 人类可读日期(YYYY-MM-DD HH:MM)。绝不抛;坏输入原样返回。 */
function _humanDate(iso) {
  const s = String(iso || '');
  const m = s.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/);
  return m ? `${m[1]} ${m[2]}` : s;
}

/**
 * 把一条进度检查点格式化为**可追加**的 markdown 块(以哨兵行开头 + 尾随空行)。
 * 机器字段全编码进哨兵;可见行仅供人读。绝不抛。
 *
 * @param {object} e
 * @param {string} e.topic     主题(如「考公-行测」);缺省归一为「(未命名)」
 * @param {string} e.covered   本次已覆盖/已学到的内容(单行化)
 * @param {string} [e.next]    下一步(单行化,可空)
 * @param {string} e.nowIso    调用方(IO 壳)注入的 ISO 时间戳
 * @returns {string} 一个以 '\n' 结尾的块
 */
function formatProgressEntry(e) {
  try {
    const o = e && typeof e === 'object' ? e : {};
    const topic = _oneLine(o.topic) || '(未命名)';
    const covered = _oneLine(o.covered);
    const next = _oneLine(o.next);
    const iso = String(o.nowIso || '');
    const sentinel =
      `<!-- @progress v=1 ts=${_enc(iso)} topic=${_enc(topic)} covered=${_enc(covered)} next=${_enc(next)} -->`;
    const lines = [
      sentinel,
      `### 📌 ${_clip(topic)} · ${_humanDate(iso)}`,
      `- 已覆盖:${_clip(covered) || '(未填)'}`,
      `- 下一步:${_clip(next) || '(未填)'}`,
      '',
      '',
    ];
    return lines.join('\n');
  } catch {
    return '';
  }
}

const _SENTINEL_RE =
  /<!-- @progress v=1 ts=([^\s]*) topic=([^\s]*) covered=([^\s]*) next=([^\s]*) -->/g;

/**
 * 从 PROGRESS.md 原文解析出结构化检查点条目(只认哨兵行 → 对散文健壮)。绝不抛。
 *
 * @param {string} raw
 * @returns {Array<{tsIso:string, topic:string, covered:string, next:string}>} 按文件顺序
 */
function parseProgressEntries(raw) {
  const out = [];
  if (typeof raw !== 'string' || !raw) return out;
  try {
    const re = new RegExp(_SENTINEL_RE.source, 'g'); // 每次新建,避免 lastIndex 复用陷阱
    let m;
    while ((m = re.exec(raw)) !== null) {
      out.push({
        tsIso: _dec(m[1]),
        topic: _dec(m[2]) || '(未命名)',
        covered: _dec(m[3]),
        next: _dec(m[4]),
      });
    }
  } catch { /* fail-soft */ }
  return out;
}

/**
 * 按主题去重,每个主题只留**最近一次**(ISO 时间戳字典序即时间序)检查点。
 * 返回按时间倒序(最新在前)的数组。绝不抛。
 *
 * @param {Array<{tsIso,topic,covered,next}>} entries
 * @returns {Array<{tsIso,topic,covered,next}>}
 */
function latestPerTopic(entries) {
  if (!Array.isArray(entries)) return [];
  const byTopic = new Map();
  for (const e of entries) {
    if (!e || typeof e !== 'object') continue;
    const key = String(e.topic || '(未命名)');
    const prev = byTopic.get(key);
    if (!prev || String(e.tsIso || '') >= String(prev.tsIso || '')) byTopic.set(key, e);
  }
  const list = [...byTopic.values()];
  list.sort((a, b) => String(b.tsIso || '').localeCompare(String(a.tsIso || '')));
  return list;
}

/**
 * 渲染开场召回段:「你上次学到哪、接着学什么」。无条目 ⇒ 返回 null(调用方据此字节回退)。
 * 段内附一句**门控内的**引导,授权模型在里程碑处调 RecordProgress —— 这条授权只活在进度段,
 * 不触碰、也不削弱全局记忆「不存易逝状态」的护栏。绝不抛。
 *
 * @param {Array<{tsIso,topic,covered,next}>} latest  已去重的最近检查点
 * @param {object} [opts]
 * @param {number} [opts.maxTopics=MAX_RECALL_TOPICS]
 * @returns {string|null}
 */
function renderProgressRecall(latest, opts = {}) {
  try {
    if (!Array.isArray(latest) || latest.length === 0) return null;
    const cap = Number.isFinite(opts.maxTopics) && opts.maxTopics > 0
      ? Math.floor(opts.maxTopics) : MAX_RECALL_TOPICS;
    const shown = latest.slice(0, cap);
    const lines = [
      '# 进度检查点 · 上次学到哪 (Where You Left Off)',
      '',
      '这是当前项目**跨会话**的进度记录(按项目根隔离,与全局/项目记忆分离)。',
      '每个主题只显示最近一次检查点。请据此**接着上次继续**,不要从头重来:',
      '',
    ];
    for (const e of shown) {
      lines.push(`## ${String(e.topic || '(未命名)')}  ·  ${_humanDate(e.tsIso)}`);
      lines.push(`- 上次覆盖到:${_oneLine(e.covered) || '(未记录)'}`);
      lines.push(`- 计划下一步:${_oneLine(e.next) || '(未记录)'}`);
      lines.push('');
    }
    if (latest.length > shown.length) {
      lines.push(`_(另有 ${latest.length - shown.length} 个主题的检查点未显示)_`);
      lines.push('');
    }
    lines.push(
      '> 到达新的学习/工作里程碑时,调用 **RecordProgress** 工具追加一条检查点(主题 + 已覆盖 + 下一步),'
      + '让下次会话能接上。这仅适用于此类需要跨会话续接的进度,不改变其它记忆的保存规则。',
    );
    return lines.join('\n');
  } catch {
    return null;
  }
}

module.exports = {
  isEnabled,
  isRecallEnabled,
  formatProgressEntry,
  parseProgressEntries,
  latestPerTopic,
  renderProgressRecall,
  PROGRESS_HEADER,
  MAX_FIELD,
  MAX_RECALL_TOPICS,
};
