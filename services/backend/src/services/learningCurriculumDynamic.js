'use strict';

/**
 * learningCurriculumDynamic.js — 课程动态覆盖层（地板 + 增强）
 *
 * 设计哲学：`curriculum.json` 永远是**离线确定性地板**（无网无模型也能学）。
 * 本模块在地板之上叠加一个**动态覆盖层**，当文件系统/网络/模型可用时：
 *   ① 自动发现代码里尚未纳入课程的新模块（纯文件系统，复用 syncCurriculum）；
 *   ② 自愈失效的文件引用（重构后路径变化 → 按 basename 重新定位）；
 *   ③ AI 为发现的知识点生成讲解（desc）；
 *   ④ AI 闭环扩充课程（buildSyncPrompt → 模型 → extractFirstJson → 校验 → 落库）。
 *
 * 覆盖层持久化于 `~/.khyos/growth/curriculum_overlay.json`（底座领地，随 pip 升级不丢，
 * 与学习进度同主权域）。**绝不修改随包 curriculum.json**。
 *
 * 全模块铁律：纯函数优先、bounded、fail-soft（任何失败都回落到地板，绝不挂死学习流）、
 * 原子写、零硬编码（阈值/开关走 KHY_LEARN_* env）。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// 覆盖层的纯持久化 + 纯合并原语下沉到叶子模块 learningOverlay（不依赖 curriculum），
// 以打破 curriculum ⇄ dynamic 循环依赖。本模块 re-export 这些纯函数以保持调用方/测试接口不变。
const overlayStore = require('./learningOverlay');
const {
  OVERLAY_VERSION,
  isDynamicEnabled,
  loadOverlay,
  clearOverlay,
  applyOverlay,
  remapFile,
  overlaySummary,
  writeOverlay,
  _emptyOverlay,
} = overlayStore;

// ── 环境开关（零硬编码） ──────────────────────────────────────────────
// 收敛到 utils/envIntNonNeg 单一真源(逐字节委托,调用点不变)
const _envInt = require('../utils/envIntNonNeg');

const TTL_MS = () => _envInt('KHY_LEARN_DYNAMIC_TTL_MS', 6 * 60 * 60 * 1000);  // 默认 6h
const MAX_DISCOVERED = () => _envInt('KHY_LEARN_DYNAMIC_MAX_TOPICS', 40);     // 发现知识点上限
const MAX_AI_DESC = () => _envInt('KHY_LEARN_DYNAMIC_AI_DESC_MAX', 12);       // 单次 AI 生成 desc 上限
const AI_TIMEOUT_MS = () => _envInt('KHY_LEARN_FETCH_TIMEOUT_MS', 4000);      // 复用既有取数超时
const WALK_MAX_FILES = () => _envInt('KHY_LEARN_DYNAMIC_WALK_MAX', 6000);     // 自愈索引扫描上限

// ── 发现 + 自愈（纯文件系统，无需模型/网络） ─────────────────────────
function _curriculum() { return require('./learningCurriculum'); }

/** 把 syncCurriculum 报告里的「未覆盖文件」转成动态知识点。 */
function _discoveredTopicsFromReport(report) {
  const cap = MAX_DISCOVERED();
  const out = [];
  const seen = new Set();
  for (const u of (report.uncovered || [])) {
    if (out.length >= cap) break;
    const file = u.file;
    if (!file || seen.has(file)) continue;
    seen.add(file);
    const base = path.basename(file).replace(/\.(js|vue|md|ts)$/i, '');
    const id = `dyn-${u.category || 'mod'}-${base}`.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 64);
    out.push({
      layer: u.suggestedLayer,
      id,
      title: `${base}（${u.label || '新模块'}）`,
      desc: '',                          // 留空：模式 3 由 AI 现场讲解；离线显示源码预览
      files: [file],
      source: 'discovered',
    });
  }
  return out;
}

/**
 * 自愈失效引用：对 report.stale 里每个找不到的文件，在仓库内按 basename
 * 唯一匹配重新定位，产出 { 旧相对路径: 新相对路径 } 的 remap。bounded walk。
 */
function _healStaleRefs(report, projectRoot) {
  const remaps = {};
  const stale = report.stale || [];
  if (stale.length === 0) return remaps;

  // 构建 basename -> [相对路径...] 索引（一次性、bounded）。
  const wanted = new Set(stale.map(s => path.basename(s.file)));
  const index = new Map();   // basename -> Set(relPath)
  const SKIP = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.venv', '__pycache__', 'vendor']);
  let budget = WALK_MAX_FILES();

  const walk = (absDir) => {
    if (budget <= 0) return;
    let entries;
    try { entries = fs.readdirSync(absDir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (budget <= 0) return;
      if (e.name.startsWith('.') && e.name !== '.ai') continue;
      const abs = path.join(absDir, e.name);
      if (e.isDirectory()) {
        if (SKIP.has(e.name)) continue;
        walk(abs);
      } else if (e.isFile()) {
        budget--;
        const bn = e.name;
        if (!wanted.has(bn)) continue;
        const rel = path.relative(projectRoot, abs).split(path.sep).join('/');
        if (!index.has(bn)) index.set(bn, new Set());
        index.get(bn).add(rel);
      }
    }
  };
  try { walk(projectRoot); } catch { /* ignore */ }

  for (const s of stale) {
    const bn = path.basename(s.file);
    const matches = index.get(bn);
    if (matches && matches.size === 1) {
      const [only] = matches;
      if (only && only !== s.file) remaps[s.file] = only;
    }
    // 多个同名或零匹配 → 不猜测（保守，避免错误重映射）。
  }
  return remaps;
}

function _computeFingerprint(report, caps) {
  const payload = {
    uncovered: (report.uncovered || []).map(u => u.file).sort(),
    stale: (report.stale || []).map(s => s.file).sort(),
    caps,
  };
  return crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
}

// ── AI 增强（可选，bounded，DI 友好） ────────────────────────────────
// 注意：模型调用（callModel）由 CLI 层注入（见 learn.js），本服务模块不反向 require
// cli/ai，以保持分层方向 cli→services（不制造 R1 分层倒置 / 巨型环）。
function _withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timeout`)), ms)),
  ]);
}

/** AI 为发现的知识点生成简洁 desc。失败/超时静默丢弃，topic 保留空 desc。 */
async function _aiEnrichDescriptions(topics, callModel) {
  const targets = topics.filter(t => t.source === 'discovered' && !t.desc).slice(0, MAX_AI_DESC());
  if (targets.length === 0) return topics;
  const list = targets.map((t, i) => `${i + 1}. ${t.title} → ${t.files[0] || ''}`).join('\n');
  const prompt = [
    '[CURRICULUM ENRICH — 课程知识点描述生成]',
    '[语言: 默认中文]',
    '你是 KHY OS 课程维护助手。为以下「待补充描述」的知识点各写一句话学习要点（≤40字，聚焦该文件在 Agent/OS 工程里的角色）。',
    '只输出 JSON 数组：[{"i":序号,"desc":"..."}]，不要解释、不要代码围栏。',
    '',
    list,
  ].join('\n');
  try {
    const reply = await _withTimeout(callModel(prompt), AI_TIMEOUT_MS(), 'enrich');
    const { extractFirstJson } = require('./gateway/safeJsonParse');
    const arr = extractFirstJson(reply, null);
    if (Array.isArray(arr)) {
      for (const item of arr) {
        const idx = Number(item && item.i) - 1;
        const desc = item && typeof item.desc === 'string' ? item.desc.trim() : '';
        if (idx >= 0 && idx < targets.length && desc) targets[idx].desc = desc.slice(0, 120);
      }
    }
  } catch { /* fail-soft：保留空 desc */ }
  return topics;
}

/**
 * AI 闭环扩充：把 buildSyncPrompt 的产物喂模型，解析模型建议的「新增知识点」，
 * 校验后并入覆盖层 topics。坏 JSON / 超时 → 返回空（地板不脏）。
 * 期望模型输出：{"topics":[{"layer":N,"id":"...","title":"...","desc":"...","files":["..."]}]}
 */
async function _aiExpandTopics(report, callModel) {
  try {
    const curriculum = _curriculum();
    const basePrompt = curriculum.buildSyncPrompt(report);
    const prompt = [
      basePrompt,
      '',
      '——',
      '[输出要求] 只输出 JSON：{"topics":[{"layer":数字,"id":"短横线英文id","title":"中文标题","desc":"≤40字要点","files":["相对路径"]}]}。',
      'files 必须取自上面列出的真实文件路径；不得编造路径；不要解释、不要代码围栏。',
    ].join('\n');
    const reply = await _withTimeout(callModel(prompt), AI_TIMEOUT_MS(), 'expand');
    const { extractFirstJson } = require('./gateway/safeJsonParse');
    const parsed = extractFirstJson(reply, null);
    const topics = Array.isArray(parsed) ? parsed : (parsed && Array.isArray(parsed.topics) ? parsed.topics : null);
    if (!Array.isArray(topics)) return [];
    // 真实路径白名单：只接受 report 里出现过的文件，杜绝模型臆造。
    const allowed = new Set((report.uncovered || []).map(u => u.file));
    const out = [];
    for (const t of topics) {
      if (!t || t.layer == null || !t.id) continue;
      const files = (Array.isArray(t.files) ? t.files : []).filter(f => allowed.has(f));
      if (files.length === 0) continue;
      out.push({
        layer: Number(t.layer),
        id: String(t.id).replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 64),
        title: String(t.title || t.id).slice(0, 80),
        desc: String(t.desc || '').slice(0, 120),
        files,
        source: 'ai',
      });
    }
    return out;
  } catch {
    return [];
  }
}

// ── 编排 ──────────────────────────────────────────────────────────────
/**
 * 刷新动态覆盖层。
 * @param {object} opts
 *   useNetwork {boolean} 是否允许网络增强
 *   useModel   {boolean} 是否允许 AI 增强/扩充
 *   model      {'smart'|'small'|'none'} 当前模型档位（写入 capabilities）
 *   callModel  {function} 可注入的单次模型调用（默认走 ai.chat），测试用
 *   force      {boolean} 忽略 fingerprint 强制重写
 * @returns {Promise<{ok,changed,discovered,healed,aiAdded,reason?}>}
 */
async function refreshDynamic(opts = {}) {
  const result = { ok: false, changed: false, discovered: 0, healed: 0, aiAdded: 0 };
  if (!isDynamicEnabled()) { result.reason = 'disabled'; return result; }

  const curriculum = _curriculum();
  const projectRoot = curriculum.PROJECT_ROOT;

  let report;
  try { report = curriculum.syncCurriculum(); }
  catch (e) { result.reason = `scan_failed:${e.message}`; return result; }

  const useModel = !!opts.useModel && opts.model && opts.model !== 'none';
  const useNetwork = !!opts.useNetwork;
  const caps = { fs: true, network: useNetwork, model: opts.model || 'none' };

  const fingerprint = _computeFingerprint(report, caps);
  const prev = loadOverlay();
  if (!opts.force && prev.fingerprint === fingerprint && prev.generatedAt) {
    // 扫描结果与能力都没变 → 跳过重写（机会式刷新省时省钱）。
    result.ok = true;
    result.reason = 'unchanged';
    result.discovered = (prev.topics || []).filter(t => t.source === 'discovered').length;
    result.aiAdded = (prev.topics || []).filter(t => t.source === 'ai').length;
    result.healed = Object.keys(prev.fileRemaps || {}).length;
    return result;
  }

  // ① 发现（纯 fs）
  let topics = _discoveredTopicsFromReport(report);
  // ② 自愈失效引用（纯 fs）
  const fileRemaps = _healStaleRefs(report, projectRoot);

  // ③④ AI 增强（可选）。callModel 必须由调用方（CLI 层）注入；缺失则跳过 AI 增强，
  //     仅保留纯 fs 的发现/自愈结果（不反向依赖 cli 层）。
  if (useModel && typeof opts.callModel === 'function') {
    const callModel = opts.callModel;
    topics = await _aiEnrichDescriptions(topics, callModel);
    const aiTopics = await _aiExpandTopics(report, callModel);
    // 合并 AI 扩充（去重 id）
    const ids = new Set(topics.map(t => t.id));
    for (const t of aiTopics) {
      if (!ids.has(t.id)) { topics.push(t); ids.add(t.id); result.aiAdded++; }
    }
  }

  const overlay = {
    version: OVERLAY_VERSION,
    generatedAt: opts._now || new Date().toISOString(),
    fingerprint,
    capabilities: caps,
    fileRemaps,
    topics,
    layers: [],           // 预留：当前 AI 扩充并入既有层；整层新增留作后续
  };

  const wrote = writeOverlay(overlay);
  result.ok = wrote;
  result.changed = wrote;
  result.discovered = topics.filter(t => t.source === 'discovered').length;
  result.healed = Object.keys(fileRemaps).length;
  if (!wrote) result.reason = 'write_failed';
  return result;
}

/**
 * 机会式刷新：TTL 内或扫描指纹未变则跳过。供 learn 入口低频调用，绝不阻断。
 */
async function maybeRefreshDynamic(opts = {}) {
  if (!isDynamicEnabled()) return { ok: false, reason: 'disabled' };
  try {
    const prev = loadOverlay();
    if (prev.generatedAt) {
      const age = Date.now() - Date.parse(prev.generatedAt);
      if (Number.isFinite(age) && age >= 0 && age < TTL_MS()) {
        return { ok: true, reason: 'fresh', skipped: true };
      }
    }
    return await refreshDynamic(opts);
  } catch (e) {
    return { ok: false, reason: `error:${e && e.message}` };
  }
}

module.exports = {
  isDynamicEnabled,
  loadOverlay,
  clearOverlay,
  applyOverlay,
  remapFile,
  discoverUncovered: () => {
    // 暴露纯发现结果（不写盘），供测试/诊断使用。
    const curriculum = _curriculum();
    const report = curriculum.syncCurriculum();
    return {
      topics: _discoveredTopicsFromReport(report),
      fileRemaps: _healStaleRefs(report, curriculum.PROJECT_ROOT),
    };
  },
  refreshDynamic,
  maybeRefreshDynamic,
  overlaySummary,
  // for tests
  _emptyOverlay,
  _computeFingerprint,
  _aiExpandTopics,
  _aiEnrichDescriptions,
};
