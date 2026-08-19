'use strict';

/**
 * backupAssetPlan.js — 「哪些资产进备份集、哪些不进」的单一真源(纯叶子:零 IO、
 * 确定性、绝不抛、可单测)。
 *
 * F5「不许散落硬编码」的落点:分级(tier)、排除规则、SQLite 库清单全部集中在此,
 * backupService / restoreService / 演练测试都只读这里,不各自内联路径字面量。
 *
 * ── 定性依据(阶段一调研实测)────────────────────────────────────────────
 * 「状态」= 权威且不可重建,丢了要人重配或永久损失;「缓存/派生物」= 可由状态或环境
 * 重新算出来。只备份状态。三条最关键的判定:
 *   1. `sessions.db`(含 -wal/-shm)**不备份**:它是会话 JSON 的 FTS5 搜索索引副本,
 *      `services/sessionSearchIndex.js` 的 `reindexAll()` 能从 `sessionPersistence`
 *      的会话 JSON 全量重建。现场实测 `sessions.db-wal`(1.2 MB)比库本体(1.1 MB)还大,
 *      直接拷贝必然得到不一致副本 —— 正是 F1 明令禁止的行为。
 *   2. `taskboard.db` **必须备份**:`coordinator/taskBoard.js` 头部记载它已**从 JSON
 *      迁到 SQLite**,没有 JSON 源可回放,是权威状态。
 *   3. `khyquant/data/khy-quant.db`(Sequelize 主库,41 张表)**必须备份**,且只能走
 *      热备原语。
 *
 * ── 为什么用「排除清单」而不是「收录清单」──────────────────────────────
 * 数据家目录会随功能增长长出新目录。若用收录白名单,新增的状态目录会**静默漏备**,
 * 而漏备直到用户需要恢复的那一刻才暴露。用排除黑名单,最坏情况只是多备一个小的未知
 * 目录 —— 代价对称性完全不同。故:默认收录,已确证的缓存/派生物逐条排除并附理由。
 *
 * ── SQLite 与文件遍历的硬边界(F1 机器化)────────────────────────────────
 * 任何 `.db` / `.sqlite` / `-wal` / `-shm` / `-journal` 一律从**文件遍历**里排除,
 * 理由 `sqlite:hot-copy-only`。SQLite 只能经 sqliteHotCopy 的 `VACUUM INTO` 进备份集。
 * 这条把「不小心 copy 了正在写的库」从「靠人自觉」变成「规则不允许」。
 *
 * 契约:零 IO(不碰 fs,只做字符串/集合运算)、确定性、绝不抛;未知输入 → 安全默认
 * (排除并给出理由,而不是静默收录一个说不清的东西)。
 *
 * @module services/backup/backupAssetPlan
 */

const path = require('path');

// ── 分级 ────────────────────────────────────────────────────────────────
// core:权威、体积可控、丢了要命。full:core + 体积大但不可重建的历史流水。
const TIER_CORE = 'core';
const TIER_FULL = 'full';
const TIERS = Object.freeze([TIER_CORE, TIER_FULL]);

// ── 数据家目录角色(manifest 里的 home 字段取值)────────────────────────
// user    = utils/dataHome.getDataHome()        ~/.khy
// project = utils/dataHome.getProjectDataHome() <appRoot>/.khy
// app     = utils/dataHome.getAppDataDir()      传统 ~/.khyquant(仅当已 established)
const HOME_USER = 'user';
const HOME_PROJECT = 'project';
const HOME_APP = 'app';
const HOMES = Object.freeze([HOME_USER, HOME_PROJECT, HOME_APP]);

// ── 需要热备的 SQLite 库(相对各自数据家目录)────────────────────────────
// 每项:{ home 角色不在此声明(由 service 按家目录逐一探测), rel, label, required }
// required=false ⇒ 库不存在不算失败(该功能可能从未被使用过)。
const SQLITE_ASSETS = Object.freeze([
  Object.freeze({
    rel: path.join('khyquant', 'data', 'khy-quant.db'),
    label: 'Sequelize 主库(用户/交易/策略/回测/密钥)',
    required: false,
  }),
  Object.freeze({
    rel: 'taskboard.db',
    label: '任务看板(权威状态,无 JSON 源)',
    required: false,
  }),
]);

// ── 排除:目录名(在数据家目录内任意深度命中即整棵剪掉)────────────────
const EXCLUDED_DIR_REASONS = Object.freeze({
  backups: '备份集自身(防递归)',
  logs: '日志,非状态',
  'clipboard-img2file': '剪贴板临时产物',
  gateway: '网关运行期缓存',
  cache: '缓存',
  node_modules: '依赖,非状态',
  tmp: '临时目录',
  '.tmp': '临时目录',
});

// ── 排除:仅 full 级收录的大体积历史流水 ────────────────────────────────
const FULL_ONLY_DIR_REASONS = Object.freeze({
  audit: '审计流水(10 MB / 1300+ 文件),core 级不收',
  receipts: '工具调用凭据流水,core 级不收',
  events: '事件流水,core 级不收',
  telemetry: '遥测流水,core 级不收',
  training: '训练样本,core 级不收',
  cognitive_snapshots: '认知快照流水,core 级不收',
});

const FULL_ONLY_FILE_REASONS = Object.freeze({
  'audit.jsonl': '审计流水,core 级不收',
});

// ── 冷导出:哪些目录可以用「按时间窗口的逻辑导出」代替逐文件复制 ──────────
// 全部取自 FULL_ONLY_DIR_REASONS —— 冷导出治的正是那批「体积大、只增不改、
// 绝大多数记录再也不会被读」的历史流水。core 级本来就不收它们,所以冷导出
// **只在 full 级或显式 includeCold 时**才有意义。
//
// 关键约束:被冷导出的东西不再逐文件复制 —— 两者是同一份数据的两种表示,同时收
// 等于把备份集体积翻倍,而体积正是这件事要治的东西。
//
// 但短路的粒度是**文件**而不是目录(见 coldExportService 的 coveredFiles)。窗口
// 过滤按记录判定,一个文件里完全可能既有 40 天前的冷记录、也有今天刚追加的热记录;
// 按目录短路会把那些热记录连同文件一起从备份集里抹掉,而 manifest 上看不出任何异常。
// 只有「每条记录都进了归档」的文件才从复制清单里去掉。
const COLD_EXPORT_DIR_REASONS = Object.freeze({
  audit: '审计流水:只增不改,按时间窗口冷封存',
  receipts: '工具调用凭据流水:只增不改,按时间窗口冷封存',
  events: '事件流水:只增不改,按时间窗口冷封存',
  telemetry: '遥测流水:只增不改,按时间窗口冷封存',
  training: '训练样本:只增不改,按时间窗口冷封存',
  cognitive_snapshots: '认知快照流水:只增不改,按时间窗口冷封存',
});

/**
 * 记录级时间戳提取。冷导出按时间窗口取记录,而每种流水的时间字段名都不一样。
 *
 * **取不到时间戳的记录一律判定为「留下」(返回 NaN,调用方据此不过滤)**,
 * 绝不因为读不懂就丢掉。冷导出是归档,不是清洗 —— 把一条格式意外的审计记录
 * 悄悄滤掉,和删除证据没有区别,而且没有任何人会发现。
 *
 * @param {*} record 已解析的 JSON 对象
 * @returns {number} 毫秒时间戳;无法判定返回 NaN
 */
function recordTimeMs(record) {
  try {
    if (!record || typeof record !== 'object') return NaN;
    for (const key of ['ts', 'timestamp', 'time', 'createdAt', 'created_at', 'at', 'date']) {
      if (!(key in record)) continue;
      const raw = record[key];
      if (typeof raw === 'number' && Number.isFinite(raw)) {
        // 十位数是秒级 epoch,十三位是毫秒级。判错会把 1970 和 2026 搞反,
        // 而窗口过滤一旦搞反就是整段流水被丢。
        return raw < 1e11 ? raw * 1000 : raw;
      }
      const t = Date.parse(String(raw));
      if (Number.isFinite(t)) return t;
    }
    return NaN;
  } catch {
    return NaN;
  }
}

/**
 * 一条记录是否落在冷导出窗口内。
 *
 * 语义:窗口是「最近 windowDays 天」的**补集** —— 冷导出封存的是**旧**记录。
 * 时间戳不可判定(NaN)时返回 true:见 recordTimeMs 的理由,宁可多存也不静默丢。
 *
 * @param {number} timeMs 记录时间;NaN 表示不可判定
 * @param {number} nowMs 当前时间(注入,保持确定性)
 * @param {number} windowDays 0 或负数 = 不设窗口,全部收录
 * @returns {boolean}
 */
function withinColdWindow(timeMs, nowMs, windowDays) {
  try {
    const days = Number(windowDays);
    if (!Number.isFinite(days) || days <= 0) return true;
    if (!Number.isFinite(timeMs)) return true;
    const now = Number.isFinite(Number(nowMs)) ? Number(nowMs) : 0;
    if (now <= 0) return true;
    return now - timeMs > days * 24 * 60 * 60 * 1000;
  } catch {
    return true;
  }
}

/**
 * 目录是否走冷导出。只在启用冷导出时问这个问题;未启用时返回 not-cold,
 * 让既有的 classifyDir 分级逻辑原样生效。
 *
 * @param {string} name 目录名
 * @param {boolean} enabled 冷导出是否启用
 * @returns {{cold: boolean, reason: string}}
 */
function classifyColdDir(name, enabled) {
  const out = { cold: false, reason: '' };
  try {
    if (!enabled) return out;
    const n = String(name == null ? '' : name).trim().toLowerCase();
    const reason = COLD_EXPORT_DIR_REASONS[n];
    if (!reason) return out;
    out.cold = true;
    out.reason = reason;
    return out;
  } catch {
    return out;
  }
}

// ── 排除:确切文件名(缓存 / 派生物 / 别的域)────────────────────────────
const EXCLUDED_FILE_REASONS = Object.freeze({
  // 派生物:能由已安装文件或环境重新算出来
  'integrity_manifest.json': '安装完整性清单,派生物,可重新生成',
  'hw_probe_cache.json': '硬件探针缓存',
  'version_cache.json': '版本探测缓存',
  'node_check.json': 'Node 环境探测缓存',
  'last_verified_model.json': '模型探测缓存',
  'ai_manage_runtime.json': '守护进程运行期端口,重启即变',
  'bootstrap_version.json': '引导版本标记,派生物',
  '.location-note-shown': '一次性提示标记',
  // 进程 / 运行期
  'daemon.pid': '进程 PID,恢复到别的机器上是错的',
  // 别的域(见 docs 备份与恢复手册「域边界」)
  '.install-ledger.jsonl': '安装副作用台账,归 khy uninstall 域,恢复进另一次安装是错的',
});

// ── 排除:文件名正则 ────────────────────────────────────────────────────
const EXCLUDED_FILE_PATTERNS = Object.freeze([
  Object.freeze({ re: /\.(?:db|sqlite|sqlite3)$/i, reason: 'sqlite:hot-copy-only' }),
  Object.freeze({ re: /\.(?:db|sqlite|sqlite3)-(?:wal|shm|journal)$/i, reason: 'sqlite:hot-copy-only' }),
  Object.freeze({ re: /\.log$/i, reason: '日志,非状态' }),
  Object.freeze({ re: /\.pid$/i, reason: '进程 PID' }),
  Object.freeze({ re: /\.lock$/i, reason: '锁文件,运行期' }),
  Object.freeze({ re: /^\.tmp-/, reason: '临时文件' }),
  Object.freeze({ re: /\.tmp-\d+/, reason: '临时文件(原子写残留)' }),
  Object.freeze({ re: /^\.restore-tmp-/, reason: '恢复临时文件' }),
]);

/** tier 归一:未知值 → core(安全默认:少备不如备错少,core 一定是权威子集)。 */
function normalizeTier(tier) {
  const t = String(tier == null ? '' : tier).trim().toLowerCase();
  return TIERS.includes(t) ? t : TIER_CORE;
}

/** full 级是否覆盖 core 级(用于 restore 时判断备份集完整度)。 */
function tierIncludes(tier, otherTier) {
  const a = normalizeTier(tier);
  const b = normalizeTier(otherTier);
  return a === TIER_FULL || a === b;
}

/**
 * 幽灵 `*.json` 目录:既存 bug 的产物,不是状态。
 *
 * `utils/dataHome.js` 的 `getDataDir()` / `getAppDataDir()` 对**拼接后的完整路径**执行
 * `_ensureDir`,于是 `getDataDir('custom_providers.json')` 这类误用会在数据家目录下造出
 * 一个**名为 `*.json` 的空目录**(现场可见 api_keys.json/ custom_providers.json/
 * search_engines.json/ tool_permissions.json/ skills_cache.json/ proxy_server_auth.json/
 * ai_gateway_*.json/ 全是空目录)。`services/tipHistoryStore.js` 的注释已记录过这个坑。
 * 根因在调用方误用,应另开任务修;备份侧只需认出它们不是状态。
 * @param {string} name 目录名
 * @returns {boolean}
 */
function isPhantomJsonDir(name) {
  return /\.json$/i.test(String(name || ''));
}

/**
 * 目录是否剪枝。
 * @param {string} name 目录名(单段,非路径)
 * @param {string} tier
 * @returns {{prune: boolean, reason: string}} prune=false 时 reason 为 ''
 */
function classifyDir(name, tier) {
  const n = String(name == null ? '' : name);
  if (!n || n === '.' || n === '..') {
    return { prune: true, reason: '非法目录名' };
  }
  if (isPhantomJsonDir(n)) {
    return { prune: true, reason: '幽灵 *.json 目录(dataHome 误用产物,非状态)' };
  }
  const hard = EXCLUDED_DIR_REASONS[n];
  if (hard) {
    return { prune: true, reason: hard };
  }
  const fullOnly = FULL_ONLY_DIR_REASONS[n];
  if (fullOnly && normalizeTier(tier) !== TIER_FULL) {
    return { prune: true, reason: fullOnly };
  }
  return { prune: false, reason: '' };
}

/**
 * 文件是否收录。
 * @param {string} name 文件名(单段,非路径)
 * @param {string} tier
 * @returns {{include: boolean, reason: string}} include=true 时 reason 为 ''
 */
function classifyFile(name, tier) {
  const n = String(name == null ? '' : name);
  if (!n) {
    return { include: false, reason: '非法文件名' };
  }
  const hard = EXCLUDED_FILE_REASONS[n];
  if (hard) {
    return { include: false, reason: hard };
  }
  for (const p of EXCLUDED_FILE_PATTERNS) {
    if (p.re.test(n)) {
      return { include: false, reason: p.reason };
    }
  }
  const fullOnly = FULL_ONLY_FILE_REASONS[n];
  if (fullOnly && normalizeTier(tier) !== TIER_FULL) {
    return { include: false, reason: fullOnly };
  }
  return { include: true, reason: '' };
}

/**
 * 恢复完成后需要重建/丢弃的派生物提示。restoreService 照此执行,manifest 也记录一份,
 * 使「为什么恢复后还要 reindex」对读 manifest 的人是自解释的。
 * @returns {Array<{kind: string, target: string, note: string}>}
 */
function restoreHints() {
  return [
    {
      kind: 'reindex',
      target: 'sessions.db',
      note: '会话 JSON 是主副本;经 sessionSearchIndex.reindexAll() 重建 FTS5 索引',
    },
    {
      kind: 'drop-wal',
      target: '*.db-wal / *.db-shm',
      note: '换库后必须删除同名 WAL/SHM,否则旧 WAL 会污染刚恢复的库',
    },
    {
      kind: 'discard',
      target: 'integrity_manifest.json',
      note: '安装完整性清单是派生物,删掉让其自然重建',
    },
  ];
}

module.exports = {
  TIER_CORE,
  TIER_FULL,
  TIERS,
  HOME_USER,
  HOME_PROJECT,
  HOME_APP,
  HOMES,
  SQLITE_ASSETS,
  EXCLUDED_DIR_REASONS,
  FULL_ONLY_DIR_REASONS,
  FULL_ONLY_FILE_REASONS,
  COLD_EXPORT_DIR_REASONS,
  recordTimeMs,
  withinColdWindow,
  classifyColdDir,
  EXCLUDED_FILE_REASONS,
  EXCLUDED_FILE_PATTERNS,
  normalizeTier,
  tierIncludes,
  isPhantomJsonDir,
  classifyDir,
  classifyFile,
  restoreHints,
};
