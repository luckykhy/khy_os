'use strict';

/**
 * @pattern Facade, Visitor
 *
 * storageBaseline.js — 工作树体积基线的判定层（纯叶子：零 IO、确定性、绝不抛、可单测）。
 *
 * 背景：治理 `.khy/logs`（约 463M）、`.khy/checkpoints`（约 275M）和多份重复
 * node_modules 之前，必须先有一份**可复现的**体积快照，否则「省了多少」只能靠感觉。
 * 探测（walk 文件树、读 manifest）全部留在 extensions/scripts/khy-diagnostics/storage-baseline.js；
 * 本文件只接收已经采集好的事实，做归类、求和、去重收益计算与呈现。
 *
 * 这样拆分的收益：判定逻辑可在无文件系统的单测里全覆盖，而 CLI 只需守住
 * 「探针失败退化为 null」这一条 fail-soft 纪律。
 *
 * env 门控 KHY_STORAGE_BASELINE（默认开，仅显式 0/false/off/no 关闭；关闭后
 * summarize 返回 { disabled: true } 且不做任何计算）。
 */

const OFF = new Set(['0', 'false', 'off', 'no']);

/** 门控判定。纯字符串运算。 */
function isEnabled(env) {
  const v = (env || process.env || {}).KHY_STORAGE_BASELINE;
  return !(v !== undefined && OFF.has(String(v).trim().toLowerCase()));
}

/** 非负有限数，否则 0。所有求和都先过它，保证一个坏探针不会污染总量。 */
function num(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * 人类可读字节。与 services/backend 的 formatBytes 保持同一档位口径
 * （1024 进制、一位小数），便于两边报告直接对读。
 */
function formatBytes(bytes) {
  const n = num(bytes);
  if (n < 1024) return Math.round(n) + ' B';
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = n / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return value.toFixed(1) + ' ' + units[unit];
}

/**
 * checkpoint 逻辑 vs 物理。
 *
 * logicalBytes = 每个 manifest entry 声明的载荷大小之和（同一内容被 N 个 entry
 * 引用就算 N 次）；physicalBytes = 磁盘上实际占用。CAS 去重的收益就是两者之差，
 * 这也是判断「值不值得把 KHY_CHECKPOINT_STORAGE_MODE 切到 cas」的唯一依据。
 *
 * dedupRatio 在 physical 为 0 时返回 null 而不是 Infinity —— 未知就说未知。
 */
function summarizeCheckpoints(projects) {
  const list = Array.isArray(projects) ? projects : [];
  let logicalBytes = 0;
  let physicalBytes = 0;
  let entries = 0;
  let casEntries = 0;
  let objects = 0;

  for (const project of list) {
    if (!project || typeof project !== 'object') continue;
    logicalBytes += num(project.logicalBytes);
    physicalBytes += num(project.physicalBytes);
    entries += num(project.entries);
    casEntries += num(project.casEntries);
    objects += num(project.objects);
  }

  const savedBytes = Math.max(0, logicalBytes - physicalBytes);
  return {
    projects: list.length,
    entries,
    casEntries,
    objects,
    logicalBytes,
    physicalBytes,
    savedBytes,
    dedupRatio: physicalBytes > 0 ? Number((logicalBytes / physicalBytes).toFixed(2)) : null,
  };
}

/**
 * 日志分层统计。activeBytes/archiveBytes 之外单独报 emptyArchives——
 * 零字节 `.gz` 是压缩流程半途失败的指纹，数量本身就是一条告警。
 */
function summarizeLogs(logs) {
  const src = logs && typeof logs === 'object' ? logs : {};
  const activeBytes = num(src.activeBytes);
  const archiveBytes = num(src.archiveBytes);
  const legacyBytes = num(src.legacyBytes);
  return {
    activeBytes,
    archiveBytes,
    legacyBytes,
    totalBytes: activeBytes + archiveBytes + legacyBytes,
    activeFiles: num(src.activeFiles),
    archiveFiles: num(src.archiveFiles),
    emptyArchives: num(src.emptyArchives),
    compressionRatio: archiveBytes > 0 && num(src.archiveRawBytes) > 0
      ? Number((num(src.archiveRawBytes) / archiveBytes).toFixed(2))
      : null,
  };
}

/**
 * 依赖树统计。同一个包在 N 个 node_modules 里各装一份是本仓最大的可回收项，
 * 故按 tree 数量和总字节分别列出，而不是只报一个总和。
 *
 * 入参兼容两种形态：旧的裸数组，和探针发现式遍历后的
 * `{top:[{path,bytes,files}], nested:number}`。nested 是「一共多少处 node_modules
 * 目录」（含嵌套），单独报出来是因为它才是 du 口径下的那个数，而字节只能按顶层树
 * 算一次 —— 两个数混用会得出「省了 780 MB」这种自己骗自己的结论。
 */
function summarizeDependencies(trees) {
  const src = trees && !Array.isArray(trees) && typeof trees === 'object' ? trees : { top: trees };
  const list = Array.isArray(src.top) ? src.top : [];
  const sorted = list
    .filter((tree) => tree && typeof tree === 'object')
    .map((tree) => ({ path: String(tree.path || ''), bytes: num(tree.bytes), files: num(tree.files) }))
    .sort((a, b) => b.bytes - a.bytes);
  return {
    trees: sorted.length,
    dirs: num(src.nested) || sorted.length,
    totalBytes: sorted.reduce((sum, tree) => sum + tree.bytes, 0),
    totalFiles: sorted.reduce((sum, tree) => sum + tree.files, 0),
    largest: sorted.slice(0, 10),
  };
}

/** path/bytes 列表的通用归一：过滤非对象、字节转非负数、按大小降序。 */
function normalizeEntries(items) {
  return (Array.isArray(items) ? items : [])
    .filter((item) => item && typeof item === 'object')
    .map((item) => ({ path: String(item.path || ''), bytes: num(item.bytes) }))
    .sort((a, b) => b.bytes - a.bytes);
}

/**
 * 汇总。facts 里任何一项缺失都按「未采集」处理并计 0，不抛。
 * 返回结构对新增分类保持可加性：调用方读到未知 key 时应忽略而非报错。
 */
function summarize(facts, env) {
  if (!isEnabled(env)) return { disabled: true };
  const src = facts && typeof facts === 'object' ? facts : {};

  const logs = summarizeLogs(src.logs);
  const checkpoints = summarizeCheckpoints(src.checkpoints);
  const dependencies = summarizeDependencies(src.dependencies);
  const buildOutputs = normalizeEntries(src.buildOutputs);
  const lockfiles = normalizeEntries(src.lockfiles);

  const buildBytes = buildOutputs.reduce((sum, item) => sum + item.bytes, 0);
  const trackedBytes = logs.totalBytes
    + checkpoints.physicalBytes
    + dependencies.totalBytes
    + buildBytes;

  // 可回收只记已证实的部分：CAS 去重收益 + 空归档残渣。安装树和构建产物不计入——
  // 它们能否回收取决于 workspace 迁移与发布验收，属另一条路径的决策，先算进来会
  // 把「已经省下的」和「打算省的」混为一谈。
  const reclaimableBytes = checkpoints.savedBytes;

  return {
    logs,
    checkpoints,
    dependencies,
    buildOutputs: {
      count: buildOutputs.length,
      totalBytes: buildBytes,
      largest: buildOutputs.slice(0, 10),
    },
    lockfiles: {
      count: lockfiles.length,
      totalBytes: lockfiles.reduce((sum, item) => sum + item.bytes, 0),
      files: lockfiles,
    },
    totals: { trackedBytes, reclaimableBytes },
  };
}

/** 文本呈现。纯字符串拼接，供 CLI 直接打印。 */
function render(summary) {
  if (!summary || summary.disabled) return 'storage baseline: disabled (KHY_STORAGE_BASELINE)';
  const lines = [];
  // 至少留一个空格：路径比 30 列长时 padEnd 不补位，会让标签和数值粘成一团
  // （`.../mermaid-embed/node_modules127.7 MB`），读起来像另一个数。
  const row = (label, value) => {
    const text = String(label);
    lines.push('  ' + (text.length >= 30 ? text + ' ' : text.padEnd(30)) + value);
  };

  lines.push('Logs');
  row('active', formatBytes(summary.logs.activeBytes) + ' (' + summary.logs.activeFiles + ' files)');
  row('archive', formatBytes(summary.logs.archiveBytes) + ' (' + summary.logs.archiveFiles + ' files)');
  if (summary.logs.legacyBytes > 0) row('legacy (unlayered)', formatBytes(summary.logs.legacyBytes));
  if (summary.logs.emptyArchives > 0) row('empty .gz artifacts', String(summary.logs.emptyArchives));

  lines.push('Checkpoints');
  row('projects / entries', summary.checkpoints.projects + ' / ' + summary.checkpoints.entries);
  row('cas entries / objects', summary.checkpoints.casEntries + ' / ' + summary.checkpoints.objects);
  row('logical', formatBytes(summary.checkpoints.logicalBytes));
  row('physical', formatBytes(summary.checkpoints.physicalBytes));
  // CAS 未启用时不报「1x」—— 那读起来像去重跑过且毫无收益，而事实是压根没跑。
  row('dedup saved', summary.checkpoints.casEntries === 0
    ? formatBytes(summary.checkpoints.savedBytes) + ' (CAS 未启用)'
    : formatBytes(summary.checkpoints.savedBytes)
      + (summary.checkpoints.dedupRatio ? ' (' + summary.checkpoints.dedupRatio + 'x)' : ''));

  lines.push('Dependencies');
  row('node_modules trees', String(summary.dependencies.trees)
    + ' (' + summary.dependencies.dirs + ' dirs incl. nested)');
  row('total', formatBytes(summary.dependencies.totalBytes)
    + ' / ' + summary.dependencies.totalFiles + ' files');
  for (const tree of summary.dependencies.largest) {
    row('  ' + tree.path, formatBytes(tree.bytes));
  }

  lines.push('Build outputs');
  row('total', formatBytes(summary.buildOutputs.totalBytes)
    + ' (' + summary.buildOutputs.count + ' dirs)');
  for (const item of summary.buildOutputs.largest) {
    row('  ' + item.path, formatBytes(item.bytes));
  }

  lines.push('Lockfiles');
  row('count / total', summary.lockfiles.count + ' / ' + formatBytes(summary.lockfiles.totalBytes));

  lines.push('Totals');
  row('tracked', formatBytes(summary.totals.trackedBytes));
  row('reclaimable (dedup)', formatBytes(summary.totals.reclaimableBytes));

  return lines.join('\n');
}

module.exports = {
  isEnabled,
  formatBytes,
  summarizeLogs,
  summarizeCheckpoints,
  summarizeDependencies,
  summarize,
  render,
};
