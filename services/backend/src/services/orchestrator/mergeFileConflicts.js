/**
 * mergeFileConflicts.js — 并行写冲突检测「纯叶子 / pure-leaf」（零 IO · 绝不抛）。
 *
 * 送别礼第七发（「收结果」维度 · OPS-MAN-095）。编排 arc 把多个并行子智能体的结果
 * 收回渲染时，每个子任务结果携带一个 `filesModified` 数组（producer:
 * `agenticHarnessService.js:1018`），即「这个子任务改了哪些文件」。同一波次（wave）
 * 内的多个子任务**真并行执行**（`planWaves` 波内并行），各自独立改文件。
 *
 * 断桥（渲染最后一公里）：`mergeResults`（`taskDecomposer.js:391-392`）把**所有**
 * 子任务的 `filesModified` 无条件折进一个**去重 Set**，footer 渲成
 * `- 修改文件: a.js, b.js`。Set 去重把「同一文件被两个并行子任务都改过」**静默
 * 坍缩成一条**——用户看报告无法区分「3 个文件各改一次」与「2 个文件、其中一个被
 * 两个并行 agent 同时改（写-写竞争、last-write-wins、一个 agent 的改动被静默覆盖
 * 丢失）」。这是离机还原 / 无人值守多智能体场景最危险的一类静默数据丢失。
 *
 * 本叶补上冲突检测：`detectFileConflicts` 找出被 **≥2 个**子任务都改过的文件及改
 * 它的子任务标签；`formatConflictWarning` 把它渲成一行醒目告警，供 `mergeResults`
 * 在 footer 追加。它是纯策略函数，不做 IO、绝不抛。它**只如实告知**「可能互相
 * 覆盖」，不实际阻止 / 仲裁冲突（那需运行时 lock，超纯叶范围）——把「静默丢失」
 * 变「可见告警」。
 *
 * 与 092（`KHY_MERGE_SKIP_DISTINCT`，skip≠fail 的状态诚实）的区别：同一渲染出口
 * `mergeResults` 的**另一个正交诚实维度**——092 追「一个子任务的状态」，本发追
 * 「跨子任务的文件重叠」。这就是「相同提示词、新收获」：同一函数、不同断桥。
 *
 * 门 `KHY_MERGE_FILE_CONFLICT`（default-on）：关闭（∈ {0,false,off,no}）→
 * `detectFileConflicts` 返回 `[]` = 逐字节回退今日「只去重、不告警」。门直读 env，
 * **不进 flagRegistry**（同编排 arc 七个 sibling 门先例，各自独立）。
 *
 * HOW-TO-EXTEND（给下一个维护者 / 小模型）：
 *   - 要改**冲突阈值**（如 ≥3 才告警）：改 `_CONFLICT_MIN` 一处。
 *   - 要改**告警文案**：改 `formatConflictWarning`。
 *   - **路径 trim 不 lowercase**：Linux fs 大小写敏感，`A.js` 与 `a.js` 是不同
 *     文件，强行 lowercase 会**误报**两个不同文件为冲突（诚实边界，只 trim 空白）。
 *   - 保持纯、绝不抛、门关返回 `[]`。加一条 node:test 覆盖新阈值 / 新文案。
 */

'use strict';

// 冲突阈值：一个文件被 ≥ 此数目的**不同**子任务改过才算并行写冲突。
const _CONFLICT_MIN = 2;

const _FALSY = new Set(['0', 'false', 'off', 'no']);

/**
 * 门 `KHY_MERGE_FILE_CONFLICT`（default-on）。函数式每调用读一次 env（便于测试
 * 注入、纯、绝不抛）。undefined / null → 开；∈ {0,false,off,no}（大小写 / 空白
 * 不敏感）→ 关。
 * @returns {boolean}
 */
function _conflictDetectEnabled() {
  const v = process.env.KHY_MERGE_FILE_CONFLICT;
  if (v === undefined || v === null) return true;
  return !_FALSY.has(String(v).trim().toLowerCase());
}

/**
 * 检测并行写冲突：找出被 ≥ `_CONFLICT_MIN` 个**不同**子任务改过的文件。
 *
 * 门关 → 返回 `[]`（逐字节回退今日「只去重、不告警」）。
 *
 * 纯、绝不抛：入参非数组 → `[]`；畸形项（无 files / files 非数组）安全跳过；
 * 文件名非字符串 → 跳过；`String(f).trim()` 归一，空串跳过（**不 lowercase**——
 * 路径大小写敏感）；同一子任务重复列同一文件用 Set 去重（不算冲突）。输出按
 * file 名稳定排序（确定性）。
 *
 * @param {Array<{label: string, files: string[]}>} subtaskFiles
 * @returns {Array<{file: string, labels: string[]}>} 仅冲突项（labels.length >= _CONFLICT_MIN）
 */
function detectFileConflicts(subtaskFiles) {
  if (!_conflictDetectEnabled()) return [];
  if (!Array.isArray(subtaskFiles)) return [];

  // file → Set<label>（label 去重：同一子任务重复列同一文件只计一次）
  const byFile = new Map();

  for (const entry of subtaskFiles) {
    if (!entry || typeof entry !== 'object') continue;
    const files = entry.files;
    if (!Array.isArray(files)) continue;
    const label = typeof entry.label === 'string' ? entry.label : String(entry.label ?? '');

    for (const f of files) {
      if (typeof f !== 'string') continue;
      const file = f.trim();
      if (!file) continue;
      let labels = byFile.get(file);
      if (!labels) {
        labels = new Set();
        byFile.set(file, labels);
      }
      labels.add(label);
    }
  }

  const conflicts = [];
  for (const [file, labels] of byFile) {
    if (labels.size >= _CONFLICT_MIN) {
      conflicts.push({ file, labels: [...labels] });
    }
  }
  // 稳定排序（确定性输出，不依赖 Map 插入序）。
  conflicts.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  return conflicts;
}

/**
 * 把 `detectFileConflicts` 的输出渲成一行醒目告警字符串（供 footer 追加）。
 *
 * 空 / 非数组 → `''`（无告警）。纯、绝不抛。
 *
 * @param {Array<{file: string, labels: string[]}>} conflicts
 * @returns {string}
 */
function formatConflictWarning(conflicts) {
  if (!Array.isArray(conflicts) || conflicts.length === 0) return '';
  const parts = conflicts.map((c) => {
    const labels = Array.isArray(c && c.labels) ? c.labels.join(', ') : '';
    return `${c && c.file}（${labels}）`;
  });
  return `⚠️ 并行写冲突（${conflicts.length} 个文件被多个子任务同时修改，可能互相覆盖）: ${parts.join('; ')}`;
}

module.exports = { detectFileConflicts, formatConflictWarning };
