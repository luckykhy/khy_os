'use strict';

/**
 * diskCleanupClarify.js — 「清理 C/D 盘前,把扫描深度与颗粒细度交给用户决定」纯叶子。
 *
 * 诉求(goal 2026-07-03「让我清理 c,d 盘时扫描深度与颗粒细度应给出用户多个选项由用户决定」):
 *   DiskCleanup 工具已存在(scan/plan/clean),但「清理C盘/D盘」是**清晰**指令 → 既有
 *   clarificationCards(只在提示词**模糊**时触发)不会弹卡,于是 khy 直接按固定全局阈值扫,
 *   用户对「扫多深、结果多细」毫无选择。本叶子补一条**话题定向**的澄清指令:检测到清盘意图时,
 *   提示模型**先用 AskUserQuestion** 把「扫描深度」「颗粒细度」作为选项卡交给用户选,再据选择跑。
 *
 * 与 clarificationCards 正交互补:那条治「提示词模糊」,这条治「清盘这类具体动作缺参数选择」。
 * 复用同款注入路径(directiveComposer → 系统提示词),门控 KHY_DISK_CLEANUP_CLARIFY 默认开。
 *
 * 本叶子还是「选项 → 真实工具参数」的**单一真源**:
 *   - SCAN_DEPTH_OPTIONS：扫描深度档 → scanner.measure 的递归深度上限(maxDepth)。
 *   - GRANULARITY_OPTIONS：颗粒细度档 → DiskCleanupTool scan 输出的聚合粒度。
 *   - resolveScanDepth / resolveGranularity：把工具收到的参数归一到上述档位(缺省→null 字节回退)。
 *   - shapeScanCandidates：按颗粒度聚合 scan 候选(coarse 按大类汇总 / fine 逐项按体积明细)。
 * 让「弹卡」与「兑现」共用一份定义,选项文案和参数映射绝不各写一套而漂移。
 *
 * 纯叶子:无 I/O、无随机、绝不抛。
 */

const OFF_VALUES = ['0', 'false', 'off', 'no'];

function _flagOn(raw, dflt = true) {
  const v = String(raw == null ? '' : raw).trim().toLowerCase();
  if (v === '') return dflt;
  return !OFF_VALUES.includes(v);
}

/** 门控:清盘澄清指令(默认开;仅显式 falsy 关 → 不注入,系统提示字节不变)。 */
function isEnabled(env = process.env) {
  return _flagOn(env && env.KHY_DISK_CLEANUP_CLARIFY, true);
}

// ── 选项 SSOT:扫描深度档(→ scanner.measure 递归深度上限) ─────────────────
// depth 值对齐 junkCatalog.thresholds.maxScanDepth 默认 6:standard 即默认档。
const DEPTH_MIN = 1;
const DEPTH_MAX = 64;
const SCAN_DEPTH_OPTIONS = Object.freeze([
  { value: 'standard', depth: 6, label: '标准(推荐)', description: '递归 6 层,兼顾速度与体积/在用判定的准确度(默认档)' },
  { value: 'shallow', depth: 2, label: '浅扫', description: '只看顶层 2 层,最快;深目录里的体积会被低估' },
  { value: 'deep', depth: 12, label: '深扫', description: '递归 12 层,体积/在用判定最准;深树较慢' },
]);

// ── 选项 SSOT:颗粒细度档(→ scan 输出聚合粒度) ────────────────────────────
const GRANULARITY_VALUES = Object.freeze(['coarse', 'standard', 'fine']);
const GRANULARITY_OPTIONS = Object.freeze([
  { value: 'standard', label: '按目录(推荐)', description: '每个垃圾目录列一行(默认档)' },
  { value: 'coarse', label: '按大类汇总', description: '同类目录合并,只给每类的总量与目录数' },
  { value: 'fine', label: '逐项明细', description: '按体积从大到小排序,并保留被保护/跳过原因' },
]);

// ── 意图检测:清理动作 + 磁盘/盘符目标(两者都出现才触发,零假阳性偏向) ─────
const _CLEAN_VERB_RE = /清理|清空|清一?下|清盘|清垃圾|腾(?:出)?空间|释放空间|清干净|clean(?:\s*up)?|free\s*(?:up\s*)?space/i;
const _DISK_TARGET_RE = /[A-Za-z]\s*盘|磁盘|硬盘|系统盘|盘符|回收站|缓存|垃圾文件|drive|disk|\b[A-Za-z]:\b/i;

/**
 * 是否为「清理磁盘」意图。要求同时出现清理动作与磁盘目标,保守偏向不误触。
 * @param {string} text
 * @returns {boolean}
 */
function detectDiskCleanupIntent(text) {
  const t = String(text || '');
  if (!t) return false;
  try {
    return _CLEAN_VERB_RE.test(t) && _DISK_TARGET_RE.test(t);
  } catch {
    return false;
  }
}

/**
 * 构建「清盘前先让用户选扫描深度与颗粒细度」的中文系统指令(确定性,无随机)。
 * @returns {string}
 */
function buildDiskCleanupDirective() {
  const depthLines = SCAN_DEPTH_OPTIONS.map(
    (o) => `     · ${o.label} → DiskCleanup 传 maxDepth:${o.depth}(${o.description})`
  );
  const granLines = GRANULARITY_OPTIONS.map(
    (o) => `     · ${o.label} → DiskCleanup 传 granularity:"${o.value}"(${o.description})`
  );
  const lines = [];
  lines.push('## 清理 C/D 盘 —— 扫描深度与颗粒细度交给用户决定');
  lines.push('用户想清理磁盘(C盘/D盘等)。**在真正扫描/清理之前**,先用 AskUserQuestion 把两个关键维度作为选项卡交给用户选择,别擅自用默认档一扫了事:');
  lines.push('1. 「扫描深度」卡(header 如「扫描深度」):至少给下面这几档,**把推荐档放第一并标「(推荐)」**,description 里说清各档的取舍:');
  lines.push(...depthLines);
  lines.push('2. 「颗粒细度」卡(header 如「颗粒细度」):至少给下面这几档,同样推荐档放第一:');
  lines.push(...granLines);
  lines.push('3. 两张卡可放进同一次 AskUserQuestion 调用(questions 数组);系统会自动为每张卡补「可讨论」与自由输入,你无需自己加。');
  lines.push('4. 拿到用户选择后,据其选的档把对应的 `maxDepth` 与 `granularity` 传进 DiskCleanup(先 mode:"scan" 或 "plan" 看清单,确认后再 mode:"clean" apply:true)。用户若已在消息里明确指定了深度/粒度,则**不必再问**,直接照其意思传参。');
  return lines.join('\n');
}

/**
 * 清盘澄清路由主入口(单一真源)。仅在门控开且检测到清盘意图时给出指令。
 * @param {object} input
 * @param {string} input.text
 * @param {object} [input.options]  env 覆盖({diskCleanupClarify})
 * @returns {{enabled:boolean, intentDetected:boolean, need:boolean, directive:(string|null)}}
 */
function routeDiskCleanupClarify(input = {}) {
  const options = input.options || {};
  const enabled = (options.diskCleanupClarify !== undefined)
    ? _flagOn(options.diskCleanupClarify, true)
    : isEnabled(input.env || process.env);
  const intentDetected = detectDiskCleanupIntent(input.text);
  const need = enabled && intentDetected;
  return {
    enabled,
    intentDetected,
    need,
    directive: need ? buildDiskCleanupDirective() : null,
  };
}

// ── 选项 → 真实工具参数 ───────────────────────────────────────────────────

function _clampDepth(n) {
  const v = Math.floor(Number(n));
  if (!Number.isFinite(v)) return null;
  if (v < DEPTH_MIN) return DEPTH_MIN;
  if (v > DEPTH_MAX) return DEPTH_MAX;
  return v;
}

/**
 * 把工具收到的深度参数归一为一个「递归深度上限」数值。
 *   - params.maxDepth 是有限正数 → 钳到 [1,64]。
 *   - 否则 params.scanDepth 命中某档 value → 该档 depth。
 *   - 都没有 → null(表示不覆盖,scanner 回退全局阈值 → 逐字节等价)。
 * @returns {number|null}
 */
function resolveScanDepth(params = {}) {
  if (params == null) return null;
  if (params.maxDepth != null && params.maxDepth !== '') {
    const c = _clampDepth(params.maxDepth);
    if (c != null) return c;
  }
  const key = String(params.scanDepth == null ? '' : params.scanDepth).trim().toLowerCase();
  if (key) {
    const hit = SCAN_DEPTH_OPTIONS.find((o) => o.value === key);
    if (hit) return hit.depth;
  }
  return null;
}

/**
 * 归一颗粒细度到 {coarse,standard,fine};无效/缺省 → 'standard'。
 * @returns {string}
 */
function resolveGranularity(params = {}) {
  const key = String((params && params.granularity) == null ? '' : params.granularity).trim().toLowerCase();
  return GRANULARITY_VALUES.includes(key) ? key : 'standard';
}

/**
 * 按颗粒度聚合 scan 候选(纯数据变换,不改单条字段语义)。
 *   - coarse:按 category 汇总 → 每类一行 {category, entryCount, sizeBytes, fileCount, eligibleCount}。
 *   - fine:按 sizeBytes 从大到小排序(稳定;保留全部字段)。
 *   - 其它(standard):原样返回同引用(逐字节等价)。
 * @param {Array} candidates  DiskCleanupTool 已映射的候选数组
 * @param {string} granularity
 * @returns {{granularity:string, rows:Array, rolledUp:boolean}}
 */
function shapeScanCandidates(candidates, granularity) {
  const list = Array.isArray(candidates) ? candidates : [];
  const g = resolveGranularity({ granularity });
  if (g === 'coarse') {
    const byCat = new Map();
    for (const c of list) {
      const cat = (c && c.category) || '(未分类)';
      const acc = byCat.get(cat) || { category: cat, entryCount: 0, sizeBytes: 0, fileCount: 0, eligibleCount: 0 };
      acc.entryCount += 1;
      acc.sizeBytes += Number(c && c.sizeBytes) || 0;
      acc.fileCount += Number(c && c.fileCount) || 0;
      if (c && c.eligible) acc.eligibleCount += 1;
      byCat.set(cat, acc);
    }
    const rows = [...byCat.values()].sort((a, b) => b.sizeBytes - a.sizeBytes);
    return { granularity: g, rows, rolledUp: true };
  }
  if (g === 'fine') {
    // 稳定按体积降序:同尺寸保持原相对序。
    const rows = list
      .map((c, i) => ({ c, i }))
      .sort((a, b) => (Number(b.c && b.c.sizeBytes) || 0) - (Number(a.c && a.c.sizeBytes) || 0) || a.i - b.i)
      .map((x) => x.c);
    return { granularity: g, rows, rolledUp: false };
  }
  return { granularity: 'standard', rows: list, rolledUp: false };
}

module.exports = {
  OFF_VALUES,
  DEPTH_MIN,
  DEPTH_MAX,
  SCAN_DEPTH_OPTIONS,
  GRANULARITY_VALUES,
  GRANULARITY_OPTIONS,
  isEnabled,
  detectDiskCleanupIntent,
  buildDiskCleanupDirective,
  routeDiskCleanupClarify,
  resolveScanDepth,
  resolveGranularity,
  shapeScanCandidates,
};
