'use strict';

/**
 * diskCleanupClarify.js — 磁盘清理「选项单一真源」：方式/深度/颗粒三组档位定义 +
 * 「选项 → 真实工具参数」归一 + scan 结果整形。纯叶子:无 I/O、无随机、绝不抛。
 *
 * 触发模型（为什么这里没有意图检测）：
 *   「交互式分组清理」等选项由 DiskCleanupTool 的工具面自然承载——工具描述常驻模型
 *   上下文，任何措辞的清理请求（自然语言/命令/追问）进入清理情景时模型都能看到选项
 *   并用 AskUserQuestion 交给用户选。早期版本用「清理动词+磁盘目标」正则检测意图、
 *   把选项卡文案经 directiveComposer 注入系统提示词——那是关键词硬编码：换个措辞
 *   （如「C盘快满了」）就漏触发。已拆除，选项文案只从本模块渲染（DiskCleanupTool.prompt
 *   消费 CLEANUP_MODE_OPTIONS / SCAN_DEPTH_OPTIONS / GRANULARITY_OPTIONS）。
 *
 * 诉求溯源(goal 2026-07-03「让我清理 c,d 盘时扫描深度与颗粒细度应给出用户多个选项由用户决定」):
 *   深度/颗粒两维度的选项卡说明同样渲染进工具说明;resolveScanDepth / resolveGranularity
 *   把工具收到的参数归一到档位(缺省→null/standard 字节回退);shapeScanCandidates 按颗粒度
 *   聚合 scan 候选。让「弹卡」与「兑现」共用一份定义,选项文案和参数映射绝不各写一套而漂移。
 */

// ── 选项 SSOT:扫描深度档(→ scanner.measure 递归深度上限) ─────────────────
// depth 值对齐 junkCatalog.thresholds.maxScanDepth 默认 6:standard 即默认档。
const DEPTH_MIN = 1;
const DEPTH_MAX = 64;
const SCAN_DEPTH_OPTIONS = Object.freeze([
  {
    value: 'standard',
    depth: 6,
    label: '标准(推荐)',
    description: '递归 6 层,兼顾速度与体积/在用判定的准确度(默认档)',
  },
  {
    value: 'shallow',
    depth: 2,
    label: '浅扫',
    description: '只看顶层 2 层,最快;深目录里的体积会被低估',
  },
  { value: 'deep', depth: 12, label: '深扫', description: '递归 12 层,体积/在用判定最准;深树较慢' },
]);

// ── 选项 SSOT:颗粒细度档(→ scan 输出聚合粒度) ────────────────────────────
const GRANULARITY_VALUES = Object.freeze(['coarse', 'standard', 'fine']);
const GRANULARITY_OPTIONS = Object.freeze([
  { value: 'standard', label: '按目录(推荐)', description: '每个垃圾目录列一行(默认档)' },
  { value: 'coarse', label: '按大类汇总', description: '同类目录合并,只给每类的总量与目录数' },
  { value: 'fine', label: '逐项明细', description: '按体积从大到小排序,并保留被保护/跳过原因' },
]);

// ── 选项 SSOT:清理方式档(第一张卡;决定走 khy cleandisk 还是 DiskCleanup 工具) ──
// interactive 不是 DiskCleanupTool 的参数,而是「整条流程换轨」:经 SlashCommand 在
// REPL 同一进程内跑 khy cleandisk(stdin/stdout 仍是 TTY),交互式分组确认才跑得起来。
const CLEANUP_MODE_OPTIONS = Object.freeze([
  {
    value: 'interactive',
    label: '交互式分组清理(推荐)',
    description:
      '调 SlashCommand 工具传 command:"cleandisk"：先自动清引擎白名单垃圾(Temp/浏览器缓存/包管理缓存,两道否决),再把下载/桌面/AppData\\Local 大文件 4-5 个一组逐组请用户确认删除;交互问答在用户终端内完成,不要再问扫描深度/颗粒细度',
  },
  {
    value: 'engine',
    label: 'AI 引擎清理',
    description:
      '继续选扫描深度/颗粒细度,再走 DiskCleanup scan→plan→clean(clean+apply 前必须把清单给用户过目)',
  },
  {
    value: 'report',
    label: '只出报告先不删',
    description: '直接 DiskCleanup mode:"plan",把清单报告给用户,不动磁盘',
  },
]);

// ── 选项 → 真实工具参数 ───────────────────────────────────────────────────

function _clampDepth(n) {
  const v = Math.floor(Number(n));
  if (!Number.isFinite(v)) {
    return null;
  }
  if (v < DEPTH_MIN) {
    return DEPTH_MIN;
  }
  if (v > DEPTH_MAX) {
    return DEPTH_MAX;
  }
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
  if (params == null) {
    return null;
  }
  if (params.maxDepth != null && params.maxDepth !== '') {
    const c = _clampDepth(params.maxDepth);
    if (c != null) {
      return c;
    }
  }
  const key = String(params.scanDepth == null ? '' : params.scanDepth)
    .trim()
    .toLowerCase();
  if (key) {
    const hit = SCAN_DEPTH_OPTIONS.find((o) => o.value === key);
    if (hit) {
      return hit.depth;
    }
  }
  return null;
}

/**
 * 归一颗粒细度到 {coarse,standard,fine};无效/缺省 → 'standard'。
 * @returns {string}
 */
function resolveGranularity(params = {}) {
  const key = String((params && params.granularity) == null ? '' : params.granularity)
    .trim()
    .toLowerCase();
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
      const acc = byCat.get(cat) || {
        category: cat,
        entryCount: 0,
        sizeBytes: 0,
        fileCount: 0,
        eligibleCount: 0,
      };
      acc.entryCount += 1;
      acc.sizeBytes += Number(c && c.sizeBytes) || 0;
      acc.fileCount += Number(c && c.fileCount) || 0;
      if (c && c.eligible) {
        acc.eligibleCount += 1;
      }
      byCat.set(cat, acc);
    }
    const rows = [...byCat.values()].sort((a, b) => b.sizeBytes - a.sizeBytes);
    return { granularity: g, rows, rolledUp: true };
  }
  if (g === 'fine') {
    // 稳定按体积降序:同尺寸保持原相对序。
    const rows = list
      .map((c, i) => ({ c, i }))
      .sort(
        (a, b) =>
          (Number(b.c && b.c.sizeBytes) || 0) - (Number(a.c && a.c.sizeBytes) || 0) || a.i - b.i
      )
      .map((x) => x.c);
    return { granularity: g, rows, rolledUp: false };
  }
  return { granularity: 'standard', rows: list, rolledUp: false };
}

module.exports = {
  DEPTH_MIN,
  DEPTH_MAX,
  SCAN_DEPTH_OPTIONS,
  GRANULARITY_VALUES,
  GRANULARITY_OPTIONS,
  CLEANUP_MODE_OPTIONS,
  resolveScanDepth,
  resolveGranularity,
  shapeScanCandidates,
};
