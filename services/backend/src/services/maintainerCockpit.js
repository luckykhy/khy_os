'use strict';

/**
 * maintainerCockpit.js — 单人维护者健康驾驶舱（确定性地板）
 *
 * 目标：让**一个人**也能轻松维护与升级 KHY-OS。把分散在各处、需要分别记忆与运行的
 * 可维护性信号聚合成**一条命令、一个裁决、一个下一步**：
 *
 *   ① `.ai/` 种子文档新鲜度（projectMetadataService）——「无 AI 也能理解本项目」的地基。
 *   ② 架构债**新增量**（archDebtScan 对基线）——单人重构时不让分层/巨石/环债务悄悄增长。
 *   ③ 基建裸奔审计（selfSustainingInfra 对**本次改动文件**）——你刚动过的文件里，
 *      有哪些公共面缺契约/裸 any/隐式依赖。正是「单人提交前自检」场景，
 *      也顺带接通此前零侵入、未接 CLI 的 selfSustainingInfra 子系统。
 *   ④ 版本信息（确定性、无网络）——升级前先知道当前在哪。
 *
 * 设计纪律（与全仓一致）：
 *   - 确定性地板：默认零网络、零模型，离线可跑；任何增强都是叠加，不是前置条件。
 *   - fail-soft：任一检查抛错只降级为 `unknown`，驾驶舱仍返回完整裁决，绝不挂死。
 *   - 零硬编码：阈值/范围/开关走 `KHY_MAINTAIN_*` env。
 *   - 依赖注入：每个检查都可被 opts.* 覆盖，便于离线确定性测试（不依赖真实仓库状态）。
 *   - 只读：驾驶舱绝不改业务代码，只观测与建议。
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

// ── 状态分级与聚合 ────────────────────────────────────────────────────
const STATUS = Object.freeze({ GREEN: 'green', YELLOW: 'yellow', RED: 'red', UNKNOWN: 'unknown' });
// 裁决排序：red 最严重，unknown 视为「信息缺失」不强于 yellow（不让探测失败把全局拖红）。
const SEVERITY = Object.freeze({ green: 0, unknown: 1, yellow: 2, red: 3 });

// 收敛到 utils/envIntNonNeg 单一真源(逐字节委托,调用点不变)
const _envInt = require('../utils/envIntNonNeg');

function _envFloat(name, def, min) {
  const n = Number.parseFloat(String(process.env[name] || '').trim());
  return Number.isFinite(n) && n >= (min == null ? 0 : min) ? n : def;
}

const AUDIT_MAX_FILES = () => _envInt('KHY_MAINTAIN_AUDIT_MAX_FILES', 40);
const GIT_TIMEOUT_MS = () => _envInt('KHY_MAINTAIN_GIT_TIMEOUT_MS', 4000);
const MAX_FILE_BYTES = () => _envInt('KHY_MAINTAIN_MAX_FILE_BYTES', 512 * 1024);
// 巨石预警带：文件 LOC 达到「巨石阈值的 GOD_WARN_PCT%」即提前预警（默认 80%）。
// 表为整数百分比以复用 _envInt；阈值本身从 archDebtScan 单一真源读取，绝不在此硬编码。
const GOD_WARN_PCT = () => _envInt('KHY_MAINTAIN_GOD_WARN_PCT', 80);
// 已承认 SCC 漂移容差：既存（基线已承认）巨型 SCC 的成员漂移，curSize ≤ baseSize×此比值
// 时按「跟踪不阻断」的 YELLOW（这正是基线的语义——已承认债不报警），超过则视为失控、回到 RED。
// 默认 1.25（25% 增长余量）；非为贴合当前规模而设，仅作「已承认债不得无界膨胀」的硬上限。
const SCC_DRIFT_MAX_RATIO = () => _envFloat('KHY_MAINTAIN_SCC_DRIFT_MAX_RATIO', 1.25, 1.0);

const BACKEND_ROOT = path.resolve(__dirname, '..', '..');

/** 自下而上找 git 仓库根（认 `.git`）。失败回落到 backend 上两级或 cwd。 */
function _findRepoRoot(startDir) {
  let dir = startDir || process.env.KHYQUANT_CWD || BACKEND_ROOT;
  try { dir = path.resolve(dir); } catch { return process.cwd(); }
  for (let i = 0; i < 12; i++) {
    try {
      if (fs.existsSync(path.join(dir, '.git'))) return dir;
    } catch { /* ignore */ }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // 回落：backend 上两级通常即仓库根（services/backend → repo）。
  const guess = path.resolve(BACKEND_ROOT, '..', '..');
  return fs.existsSync(path.join(guess, '.ai')) ? guess : (process.env.KHYQUANT_CWD || process.cwd());
}

// ── 检查 ①：.ai/ 元数据新鲜度 ──────────────────────────────────────────
function _checkMetadata(root, opts) {
  try {
    const check = typeof opts.checkMetadata === 'function'
      ? opts.checkMetadata
      : require('./projectMetadataService').checkProjectMetadata;
    const s = check(root) || {};
    if (s.ok) {
      return { id: 'metadata', label: '可维护性元数据 (.ai/)', status: STATUS.GREEN, detail: '齐备且最新', action: null };
    }
    if (!s.exists) {
      return {
        id: 'metadata', label: '可维护性元数据 (.ai/)', status: STATUS.RED,
        detail: '缺少 .ai/ 种子文档（无 AI 时维护者无依据）', action: 'khy metadata gen',
      };
    }
    // stale：是否「自愈」取决于 pre-commit 钩子。钩子已装 → 下次提交确定性自动刷新，
    // 维护者无需手动干预（驾驶舱不应把自愈项渲染得像需要人工救火）；未装 → 这是真正的
    // 可维护性缺口，建议装钩子让 .ai/ 永远随提交保持新鲜（升级友好）。
    let healing = false;
    try {
      const hookStatus = typeof opts.hookStatus === 'function'
        ? opts.hookStatus
        : require('./metadataHook').hookStatus;
      const hs = hookStatus(root) || {};
      healing = !!(hs.installed && hs.ours);
    } catch { /* 钩子探测失败不影响主判定 */ }
    return healing
      ? {
        id: 'metadata', label: '可维护性元数据 (.ai/)', status: STATUS.YELLOW,
        detail: '结构已变更、元数据已过期（钩子已装，将于下次 git commit 自动刷新）',
        action: 'khy metadata refresh', selfHealing: true,
      }
      : {
        id: 'metadata', label: '可维护性元数据 (.ai/)', status: STATUS.YELLOW,
        detail: '结构已变更、元数据已过期（未装自动刷新钩子，提交后仍会过期）',
        action: 'khy metadata hook install', selfHealing: false,
      };
  } catch (e) {
    return { id: 'metadata', label: '可维护性元数据 (.ai/)', status: STATUS.UNKNOWN, detail: `检查失败：${e && e.message}`, action: null };
  }
}

// ── 检查 ②：架构债新增量（对基线） ────────────────────────────────────
function _checkArchDebt(root, opts) {
  try {
    const scan = typeof opts.scanArchDebt === 'function' ? opts.scanArchDebt : _defaultArchDebtScan;
    const r = scan() || {};
    const neu = r.neu || { layering: [], godFiles: [], cycles: [] };
    const baseCount = r.baselineCount;
    const layeringN = (neu.layering || []).length;
    const godN = (neu.godFiles || []).length;
    const cyclesArr = (neu.cycles || []);

    // 环新债分类：把「指纹变化的新环」拆成
    //   · HARD（真正新独立环 kind:'new'，或既存 SCC 失控膨胀超容差）→ 计入阻断性新债（RED）；
    //   · SOFT（既存已承认 SCC 在容差内的成员漂移 kind:'drift'）→ 跟踪不阻断（YELLOW）。
    // 这正是基线的语义：已承认的结构债（含其有界漂移）不报警，只有**新**债或**失控**才阻断。
    // 缺 cycleDrift 数据（旧注入桩）→ 一律按 HARD（绝不弱于既有行为，向后兼容）。
    const { hardCycles, softDrift } = _classifyCycles(cyclesArr, r.cycleDrift, SCC_DRIFT_MAX_RATIO());
    const cycleNote = _attributeCycles(neu, r.cycleDrift);

    const hardTotal = layeringN + godN + hardCycles;
    if (hardTotal > 0) {
      const parts = [];
      if (layeringN) parts.push(`分层倒置 ${layeringN}`);
      if (godN) parts.push(`巨石文件 ${godN}`);
      if (hardCycles) parts.push(`循环依赖 ${hardCycles}`);
      // 点名巨石文件（取 basename + LOC，最多 3 个），让单人维护者一眼判断
      // 「是不是我刚动过的文件」——是则提交前拆分，否则系既存承认债、勿被误导。
      const named = (neu.godFiles || []).slice(0, 3)
        .map(g => `${path.basename(String(g.file || g.path || ''))} ${g.loc || g.lines || '?'}`)
        .filter(Boolean);
      const namedSuffix = named.length
        ? `（${named.join('、')}${godN > named.length ? '…' : ''}）`
        : '';
      // 自动归因：把「新债 vs 基线」进一步与**本次未提交改动集**求交。新债巨石若不在改动集，
      // 即系既存 committed 债（基线滞后所致），并非本次引入——单人无须自责或排查；若**在**改动集，
      // 则是本次亲手做大的文件，提交前应拆分。把人工排查变确定性标注。
      const attribution = _attributeArchDebt(root, neu, opts);
      return {
        id: 'arch-debt', label: '架构债（新增 vs 基线）', status: STATUS.RED,
        detail: `引入 ${hardTotal} 处新债：${parts.join('、')}${namedSuffix}${attribution.note}${cycleNote}`,
        action: 'npm run arch:debt', introducedByCurrentWork: attribution.byCurrent,
      };
    }
    if (softDrift > 0) {
      // 仅余「已承认 SCC 的有界漂移」——无新增阻断债。按设计原则降为 YELLOW（跟踪不阻断），
      // 避免 gate 对既存结构债永久泛红、把单人训练成忽略告警。漂移叙述（含点名累积模块 +
      // 「需解环 campaign」）直接作为 detail，并标 sccDrift:true 供上层识别。
      const drift = (Array.isArray(r.cycleDrift) ? r.cycleDrift : []).filter(d => d && d.kind === 'drift');
      const inner = _attributeCycles(neu, r.cycleDrift).replace(/^；环：/, '');
      const ratio = SCC_DRIFT_MAX_RATIO();
      return {
        id: 'arch-debt', label: '架构债（新增 vs 基线）', status: STATUS.YELLOW,
        detail: `无新增阻断债；既存已承认 SCC 有界漂移（≤基线×${ratio} 容差，跟踪不阻断）：${inner}`,
        action: 'npm run arch:debt', sccDrift: true, driftCount: drift.length,
      };
    }
    return {
      id: 'arch-debt', label: '架构债（新增 vs 基线）', status: STATUS.GREEN,
      detail: baseCount != null ? `无新增（基线存量 ${baseCount} 项已承认）` : '无新增债务', action: null,
    };
  } catch (e) {
    return { id: 'arch-debt', label: '架构债（新增 vs 基线）', status: STATUS.UNKNOWN, detail: `扫描失败：${e && e.message}`, action: null };
  }
}

/**
 * 把新环按「真正新债 vs 既存已承认 SCC 的有界漂移」分类。
 * @returns {{hardCycles:number, softDrift:number}}
 *   hardCycles = 真正新独立环 + 失控膨胀（curSize > baseSize×ratioMax）的既存 SCC；
 *   softDrift  = 容差内的既存 SCC 漂移（跟踪不阻断）。
 * 缺 cycleDrift（旧桩/不可用）→ 全部计 hard（向后兼容，绝不弱于既有 RED 行为）。
 */
function _classifyCycles(cyclesArr, cycleDrift, ratioMax) {
  const n = (cyclesArr || []).length;
  if (n === 0) return { hardCycles: 0, softDrift: 0 };
  if (!Array.isArray(cycleDrift) || cycleDrift.length === 0) return { hardCycles: n, softDrift: 0 };
  let hard = 0;
  let soft = 0;
  for (const d of cycleDrift) {
    if (d && d.kind === 'drift') {
      const within = d.baseSize > 0 && d.curSize <= Math.floor(d.baseSize * ratioMax);
      if (within) soft++; else hard++; // 超容差 = 失控膨胀，回到阻断
    } else {
      hard++; // kind:'new' = 真正新独立环
    }
  }
  // 安全网：若有未被 drift 分析解释的新环（理论上不应发生），按 hard 计，绝不漏报。
  if (n > cycleDrift.length) hard += (n - cycleDrift.length);
  return { hardCycles: hard, softDrift: soft };
}

function _defaultArchDebtScan() {
  const scanner = require('../../scripts/archDebtScan');
  const result = scanner.scanAll();
  const baseline = scanner.loadBaseline();
  const neu = scanner.computeNew(result, baseline);
  const baselineCount = (baseline.layering || []).length + (baseline.godFiles || []).length + (baseline.cycles || []).length;
  // 环漂移还原：把「指纹变化的新环」分辨为既存 SCC 漂移 vs 真正新独立环。
  let cycleDrift = [];
  try { cycleDrift = scanner.analyzeCycleDrift(result, baseline); } catch { /* 可选增益，失败不影响主判定 */ }
  return { neu, baselineCount, cycleDrift };
}

/**
 * 把新债巨石文件归因到「本次未提交改动」还是「既存承认债」。
 * 返回 { byCurrent:boolean|null, note:string }。fail-soft：取改动集失败 → byCurrent:null、note:''。
 */
function _attributeArchDebt(root, neu, opts) {
  try {
    const god = (neu.godFiles || []);
    if (god.length === 0) return { byCurrent: null, note: '' };
    const changed = typeof opts.gitChangedFiles === 'function' ? opts.gitChangedFiles(root) : _gitChangedJsFiles(root);
    if (!Array.isArray(changed)) return { byCurrent: null, note: '' };
    const changedBase = new Set(changed.map(f => path.basename(String(f))));
    const hit = god
      .map(g => path.basename(String(g.file || g.path || '')))
      .filter(b => b && changedBase.has(b));
    if (hit.length > 0) {
      const head = hit.slice(0, 3).join('、');
      return { byCurrent: true, note: `，⚠ 含本次改动：${head}${hit.length > 3 ? '…' : ''}（提交前应拆分）` };
    }
    return { byCurrent: false, note: '，均非本次改动（系既存承认债，基线滞后）' };
  } catch {
    return { byCurrent: null, note: '' };
  }
}

/**
 * 把循环依赖新债还原为可信叙述：既存巨型 SCC 漂移（成员累积）vs 真正新独立环。
 * 前者点名「新累积」的模块（长期结构债、需解环 campaign、非本次亲手造），后者标⚠应即解开。
 * 杜绝把 74→82 的成员漂移误报成「全新 82 节点环」吓到单人维护者。fail-soft：无数据 → ''。
 */
function _attributeCycles(neu, cycleDrift) {
  if (!(neu.cycles || []).length) return '';
  if (!Array.isArray(cycleDrift) || cycleDrift.length === 0) return '';
  const notes = [];
  const driftAll = cycleDrift.filter(d => d && d.kind === 'drift'
    && typeof d.curSize === 'number' && typeof d.baseSize === 'number');
  const newAll = cycleDrift.filter(d => d && d.kind !== 'drift');

  // 解环 campaign 把同一既存基线 SCC **拆分**成多个仍成环的片段时，每个片段都独立对照
  // 整条基线 → 若逐条各报「已净解开 N」会重复计数误导。按 baseSize 归并同源片段，按
  // 「总在环 = Σ片段·净解开 = 基线 − 总在环」给出一条诚实叙述（避免双重计数夸大战果）。
  const byBase = new Map();
  for (const d of driftAll) {
    const g = byBase.get(d.baseSize) || { baseSize: d.baseSize, frags: [], added: [] };
    g.frags.push(d.curSize);
    g.added.push(...(d.added || []));
    byBase.set(d.baseSize, g);
  }
  for (const g of byBase.values()) {
    if (g.frags.length > 1) {
      const totalCur = g.frags.reduce((a, b) => a + b, 0);
      const net = g.baseSize - totalCur;
      const fragStr = g.frags.slice().sort((a, b) => b - a).join('+');
      if (net > 0) {
        notes.push(`既存巨型 SCC 解环 campaign 进行中 ${g.baseSize}→拆分为[${fragStr}]（累计在环 ${totalCur}·已净解开 ${net} 个节点·长期结构债持续收敛）`);
      } else {
        const adds = g.added.slice(0, 3).map(m => path.basename(String(m))).join('、');
        const more = g.added.length > 3 ? '…' : '';
        notes.push(`既存巨型 SCC 漂移 ${g.baseSize}→拆分为[${fragStr}]（累计在环 ${totalCur}·+${g.added.length} 模块累积${adds ? '：' + adds + more : ''}·需解环 campaign）`);
      }
    } else {
      // 单片段（无拆分）：保持原方向感知叙述（§6.5）。
      const curSize = g.frags[0];
      if (curSize < g.baseSize) {
        notes.push(`既存巨型 SCC 解环 campaign 进行中 ${g.baseSize}→${curSize}（已净解开 ${g.baseSize - curSize} 个节点·已低于基线·长期结构债持续收敛）`);
      } else {
        const adds = g.added.slice(0, 3).map(m => path.basename(String(m))).join('、');
        const more = g.added.length > 3 ? '…' : '';
        notes.push(`既存巨型 SCC 漂移 ${g.baseSize}→${curSize}（+${g.added.length} 模块累积${adds ? '：' + adds + more : ''}，属长期结构债·需解环 campaign·非本次新增）`);
      }
    }
  }
  for (const d of newAll) {
    const adds = (d.added || []).slice(0, 3).map(m => path.basename(String(m))).join('、');
    const more = (d.added || []).length > 3 ? '…' : '';
    notes.push(`⚠ 新独立环 ${d.curSize} 节点（${adds}${more}，应即解开）`);
  }
  return notes.length ? `；环：${notes.join('；')}` : '';
}

// ── 检查 ③：巨石预警（逼近阈值，预防而非救火） ────────────────────────
/**
 * 把架构债从「越线即红」的**事后**信号，补成「逼近即黄」的**事前**信号：
 * 列出 LOC ∈ (warnFloor, threshold] 的文件——它们尚非债（未越巨石阈值、不入任何基线），
 * 但已逼近。给单人维护者**拆分余量**：趁文件还看得懂时动手，而非越线后才发现。
 * 永远只到 YELLOW（非紧急、不抢 nextAction），且不依赖基线（预防面 vs 既存债面正交）。
 */
function _checkApproachingGod(root, opts) {
  try {
    const scan = typeof opts.scanApproaching === 'function' ? opts.scanApproaching : _defaultApproachingScan;
    const r = scan() || {};
    const threshold = r.threshold;
    const band = r.approaching || []; // 文件 LOC ∈ (warnFloor, threshold]
    if (band.length === 0) {
      return {
        id: 'approaching-god', label: '巨石预警（逼近阈值）', status: STATUS.GREEN,
        detail: threshold ? `无文件逼近 ${threshold} 行巨石阈值` : '无文件逼近巨石阈值', action: null,
      };
    }
    const named = band.slice(0, 3)
      .map(g => `${path.basename(String(g.file || g.path || ''))} ${g.loc || g.lines || '?'}`)
      .filter(Boolean);
    const more = band.length > named.length ? '…' : '';
    return {
      id: 'approaching-god', label: '巨石预警（逼近阈值）', status: STATUS.YELLOW,
      detail: `${band.length} 个文件逼近巨石阈值（>${r.warnFloor} 且未越 ${threshold} 行）：${named.join('、')}${more}，建议趁早拆分留出余量`,
      action: 'npm run arch:debt',
    };
  } catch (e) {
    return { id: 'approaching-god', label: '巨石预警（逼近阈值）', status: STATUS.UNKNOWN, detail: `扫描失败：${e && e.message}`, action: null };
  }
}

function _defaultApproachingScan() {
  const scanner = require('../../scripts/archDebtScan');
  const threshold = scanner.GOD_FILE_LOC; // 单一真源：阈值不在驾驶舱硬编码
  const warnFloor = Math.floor(threshold * (GOD_WARN_PCT() / 100));
  // scanGodFiles(dir, warnFloor) 返回 LOC > warnFloor 的全部文件；再剔除已越阈值
  // （那些是真债、已由 arch-debt 单独点名），剩下即「逼近带」。
  const overWarn = scanner.scanGodFiles(scanner.SRC_DIR, warnFloor) || [];
  const approaching = overWarn.filter(g => (g.loc || 0) <= threshold);
  return { approaching, threshold, warnFloor };
}

// ── 检查 ④：基建裸奔（对本次改动的 JS 文件） ──────────────────────────
function _gitChangedJsFiles(root) {
  // 工作树改动 + 暂存改动，去重，仅 services/backend/src 下的 .js（审计面）。
  const out = new Set();
  const run = (args) => {
    try {
      const txt = execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', timeout: GIT_TIMEOUT_MS() });
      return String(txt || '').split('\n').map(s => s.trim()).filter(Boolean);
    } catch { return []; }
  };
  // porcelain 给出全部已改/新增；XY 两列状态 + 路径。
  for (const line of run(['status', '--porcelain'])) {
    const file = line.slice(3).trim().replace(/^"|"$/g, '');
    if (/\.js$/.test(file) && file.includes('services/backend/src/')) out.add(file);
  }
  return [...out];
}

function _checkInfraGaps(root, opts) {
  try {
    const changed = typeof opts.gitChangedFiles === 'function' ? opts.gitChangedFiles(root) : _gitChangedJsFiles(root);
    if (!changed || changed.length === 0) {
      return { id: 'infra-gaps', label: '基建裸奔（改动文件）', status: STATUS.GREEN, detail: '无改动的后端 JS 文件，无需审计', action: null };
    }
    const cap = AUDIT_MAX_FILES();
    const picked = changed.slice(0, cap);
    const fileMap = {};
    const readFile = typeof opts.readFile === 'function' ? opts.readFile : _safeReadRel;
    for (const rel of picked) {
      const src = readFile(root, rel);
      if (typeof src === 'string') fileMap[rel] = src;
    }
    if (Object.keys(fileMap).length === 0) {
      return { id: 'infra-gaps', label: '基建裸奔（改动文件）', status: STATUS.UNKNOWN, detail: '改动文件无法读取', action: null };
    }
    const audit = typeof opts.auditInfra === 'function' ? opts.auditInfra : _defaultAuditInfra;
    const { gaps, byKind } = audit(fileMap) || { gaps: [], byKind: {} };
    // 驾驶舱聚焦「可确定性判定」的裸奔（缺契约/裸 any/隐式依赖）；
    // missing-test 需已测符号索引，留给 commitGate（避免无依据误报）。
    const focus = (gaps || []).filter(g => g && g.kind !== 'missing-test');
    if (focus.length === 0) {
      return { id: 'infra-gaps', label: '基建裸奔（改动文件）', status: STATUS.GREEN, detail: `${picked.length} 个改动文件，公共面完备`, action: null };
    }
    const summary = Object.entries(byKind || {})
      .filter(([k]) => k !== 'missing-test')
      .map(([k, v]) => `${k} ${v}`).join('、');
    const truncated = changed.length > cap ? `（已审 ${cap}/${changed.length}）` : '';
    return {
      id: 'infra-gaps', label: '基建裸奔（改动文件）', status: STATUS.YELLOW,
      detail: `${focus.length} 处待补：${summary}${truncated}`, action: 'khy maintain audit',
    };
  } catch (e) {
    return { id: 'infra-gaps', label: '基建裸奔（改动文件）', status: STATUS.UNKNOWN, detail: `审计失败：${e && e.message}`, action: null };
  }
}

function _safeReadRel(root, rel) {
  try {
    const abs = path.join(root, rel);
    const st = fs.statSync(abs);
    if (!st.isFile() || st.size > MAX_FILE_BYTES()) return null;
    return fs.readFileSync(abs, 'utf8');
  } catch { return null; }
}

function _defaultAuditInfra(fileMap) {
  const { SelfSustainingInfra } = require('./selfSustainingInfra');
  return new SelfSustainingInfra().audit(fileMap);
}

// ── 检查 ④：版本（确定性、无网络） ────────────────────────────────────
function _checkVersion(root, opts) {
  try {
    const read = typeof opts.readVersion === 'function' ? opts.readVersion : _defaultReadVersion;
    const v = read(root);
    return {
      id: 'version', label: '当前版本', status: STATUS.GREEN,
      detail: v ? `v${v}（升级查询：khy update）` : '未知版本', action: null,
    };
  } catch (e) {
    return { id: 'version', label: '当前版本', status: STATUS.UNKNOWN, detail: `读取失败：${e && e.message}`, action: null };
  }
}

function _defaultReadVersion(root) {
  for (const p of [path.join(BACKEND_ROOT, 'package.json'), path.join(root, 'package.json')]) {
    try {
      const pkg = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (pkg && pkg.version) return String(pkg.version);
    } catch { /* try next */ }
  }
  return null;
}

// ── 聚合 ──────────────────────────────────────────────────────────────
/**
 * 运行驾驶舱，返回结构化健康裁决。
 * @param {object} [opts]
 *   root            {string}   仓库根（默认自动发现）
 *   checkMetadata   {function} 注入：(root) => {ok,exists,stale,...}
 *   hookStatus      {function} 注入：(root) => {installed,ours,...}（元数据自愈钩子探测）
 *   scanArchDebt    {function} 注入：() => {neu:{layering,godFiles,cycles}, baselineCount}
 *   scanApproaching {function} 注入：() => {approaching:[{file,loc}], threshold, warnFloor}
 *   gitChangedFiles {function} 注入：(root) => string[]（相对路径）
 *   readFile        {function} 注入：(root, rel) => string|null
 *   auditInfra      {function} 注入：(fileMap) => {gaps, byKind}
 *   readVersion     {function} 注入：(root) => string|null
 * @returns {{version,generatedAt,root,checks,level,nextAction,ok}}
 */
function runCockpit(opts = {}) {
  const root = opts.root || _findRepoRoot();
  const checks = [
    _checkMetadata(root, opts),
    _checkArchDebt(root, opts),
    _checkApproachingGod(root, opts),
    _checkInfraGaps(root, opts),
    _checkVersion(root, opts),
  ];

  // 裁决 = 最严重状态（unknown 不强于 yellow）。
  let level = STATUS.GREEN;
  for (const c of checks) {
    if ((SEVERITY[c.status] || 0) > (SEVERITY[level] || 0)) level = c.status;
  }
  if (level === STATUS.UNKNOWN) level = STATUS.GREEN; // 仅探测失败、无真实问题 → 不渲染为告警级

  // nextAction = 第一个 red 的行动，否则第一个 yellow 的行动。
  const firstWith = (st) => (checks.find(c => c.status === st && c.action) || {}).action || null;
  const nextAction = firstWith(STATUS.RED) || firstWith(STATUS.YELLOW) || null;

  return {
    version: '1',
    generatedAt: opts._now || new Date().toISOString(),
    root,
    checks,
    level,
    nextAction,
    ok: level !== STATUS.RED,
  };
}

module.exports = {
  STATUS,
  SEVERITY,
  runCockpit,
  _findRepoRoot,
  // 暴露供测试/诊断
  _checkMetadata,
  _checkArchDebt,
  _attributeCycles,
  _classifyCycles,
  _checkApproachingGod,
  _checkInfraGaps,
  _checkVersion,
  _gitChangedJsFiles,
};
