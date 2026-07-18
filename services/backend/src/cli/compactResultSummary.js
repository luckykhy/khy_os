'use strict';

/**
 * compactResultSummary.js — 纯叶子(零 IO · 确定性 · 绝不抛 · 可单测)。
 *
 * 承 Goal(Thread 4)「学 CC 显示但**更重背后逻辑**」+「TUI 缺少的显示多学 CC」。
 * 与 刀79 rewind diff-stat、刀84 salvage focus 同族(computed-but-never-shown:
 * 后端已算出富信息,呈现层只取其一丢弃其余)。这是 刀83 的**输出侧**对偶:
 * 刀83 补的是 `/compact <文本>` 的**输入**(参数被丢),本刀补的是压缩**结果**
 * 的呈现(auto 决定的压缩强度 mode + 折叠条数被丢)。
 *
 * 真缺口(核实链路 router.js compact 成功行 → ai.js compactHistory 返回对象):
 * `ai.js:1804-1813` compactHistory 返回 `{ previousCount, nextCount, compactedCount,
 * keepRecent, mode, summaryChars }`。其中 **`mode` 是 `'auto'` 时自解析出来的**
 * (ai.js:1688-1694:previousCount≥60/keepRecent≤8→aggressive·≥28→balanced·否则 light),
 * 即用户跑裸 `/compact` 时 khy **悄悄选了一档强度但从不告知**——用户没有任何别的
 * 途径得知这轮用了哪档压缩。`compactedCount` = 被折叠进摘要的消息条数。而
 * `router.js:1318` 成功行 `printSuccess(\`会话已压缩：${previousCount} -> ${nextCount}\`)`
 * **只显 2 个字段**,mode/compactedCount 计算了却never shown。
 *
 * 本叶子把「压缩结果对象 → 成功提示串」这段纯格式化抽出单测:门控开 → 追加
 * 「(强度档·折叠 N 条)」;门控关 / 缺字段 → 逐字节回退今日 `会话已压缩：P -> N`。
 *
 * 门控 KHY_COMPACT_RESULT_DETAIL(默认开;{0,false,off,no} 关)。关 →
 * `buildCompactSuccessLine` 恒返 legacy 串,逐字节回退。
 *
 * 诚实边界(刻意):① 只呈现 mode(隐藏的 auto 决定·最高价值)+ compactedCount
 * (折叠条数);**keepRecent / summaryChars 刻意不纳入**(前者是配置回显、后者是内部
 * 字符数·对用户理解「这轮压了多狠」价值低·避免提示行过载·留 honest-NA)。② mode 是
 * 已解析的英文档名(light/balanced/aggressive)·映射成中文档标签与 khy 中文提示一致·
 * 未知档名原样透传(不臆造)。③ 缺字段/畸形 → 只回退到有效段·mode 与 compactedCount
 * 均缺时 → 纯 legacy 串(不显空括号)。④ 门控关 → legacy 串逐字节回退。
 */

const _OFF = ['0', 'false', 'off', 'no'];

// 已解析压缩强度档 → 中文标签(与 ai.js modeConfigs 三档对齐)。未知档原样透传。
const _MODE_LABELS = {
  light: '轻度压缩',
  balanced: '均衡压缩',
  aggressive: '激进压缩',
};

/**
 * 是否在压缩成功行追加强度/折叠明细。默认开(unset → 开)。
 * @param {object} [env]
 * @returns {boolean}
 */
function compactResultDetailEnabled(env = process.env) {
  const raw = env && env.KHY_COMPACT_RESULT_DETAIL;
  const v = String(raw == null ? '' : raw).trim().toLowerCase();
  return !_OFF.includes(v);
}

/**
 * KHY_COMPACT_TWIN_ALIGN 门控:默认开(unset → 开),{0,false,off,no} 关。
 *
 * 刀108(router-path vs interactive-twin drift 家族·承刀101-104):两条交互 `/compact`
 * 孪生(菜单 selected.flag==='compact' + 键入 `/compact`)刀108 前都塌成硬编码
 * `printSuccess('对话已压缩')`——丢掉聚焦指令(buildCompactOptions)、丢掉压缩强度/折叠
 * 明细(buildCompactSuccessLine),且不处理「无需压缩(changed===false)」「失败
 * (success===false)」两分支。router case 'compact'(router.js:1311)早已富化并消费这两个
 * 叶子;孪生只是从不接线 = 呈现侧 half-wired。本门控是**孪生对齐的总开关**:
 *   关 → 两孪生逐字节回退刀108前(`对话已压缩`,无计数/无明细/不处理 no-op 与失败分支);
 *   开 → 两孪生镜像 router 富化路径(其内部再各自尊重 KHY_COMPACT_INSTRUCTIONS /
 *        KHY_COMPACT_RESULT_DETAIL 子门控,与 router 完全一致)。
 * 独立于两个子门控:即便子门控全关,本门控开时孪生仍对齐 router 的 legacy 富化态
 * (`会话已压缩：P -> N` + 无需压缩/失败分支),故需要这一总开关来保证「关 → 逐字节回退
 * 今日 `对话已压缩`」这条 byte-identity 红线。
 * @param {object} [env]
 * @returns {boolean}
 */
function compactTwinAlignEnabled(env = process.env) {
  const raw = env && env.KHY_COMPACT_TWIN_ALIGN;
  const v = String(raw == null ? '' : raw).trim().toLowerCase();
  return !_OFF.includes(v);
}

/** mode 字段 → 中文档标签;空/非字符串 → null(不显);未知档 → 原样。 */
function _modeLabel(mode) {
  if (mode == null) return null;
  const m = String(mode).trim().toLowerCase();
  if (!m) return null;
  return _MODE_LABELS[m] || String(mode).trim();
}

/** 非负整数或 null(用于折叠条数;负/非有限/非数 → null 不显)。 */
function _nonNegInt(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v < 0) return null;
  return Math.floor(v);
}

/**
 * 构造 `/compact` 成功提示串。
 *   门控关 / mode+compactedCount 均缺 → `会话已压缩：${previousCount} -> ${nextCount}`
 *   门控开 + 有明细 → `…（${强度档}·折叠 ${N} 条）`
 * @param {object} result  compactHistory 返回对象
 * @param {object} [env]
 * @returns {string}
 */
function buildCompactSuccessLine(result, env = process.env) {
  const r = result || {};
  const base = `会话已压缩：${r.previousCount} -> ${r.nextCount}`;
  if (!compactResultDetailEnabled(env)) return base;
  const extras = [];
  const label = _modeLabel(r.mode);
  if (label) extras.push(label);
  const folded = _nonNegInt(r.compactedCount);
  if (folded != null) extras.push(`折叠 ${folded} 条`);
  if (!extras.length) return base;
  return `${base}（${extras.join('·')}）`;
}

module.exports = {
  compactResultDetailEnabled,
  compactTwinAlignEnabled,
  buildCompactSuccessLine,
};
