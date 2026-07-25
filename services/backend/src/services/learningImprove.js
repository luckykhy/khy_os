'use strict';

/**
 * learningImprove.js — 「边学边发现不足」改进清单（findings backlog）
 *
 * 诉求：学习过程中和 AI 一起发现 KHY 的不足并完善。本模块把学习者随手记下的「不足」结构化落库，
 * 有模型时让 AI 现场给一份**具体修复提议**（只展示 + 随条目存档，**绝不自动改代码**），可 list 复盘。
 *
 * 数据落**底座领地** `~/.khyos/growth/learn_findings.json`（与学习进度/档位同主权域，随 pip 升级不丢），
 * 复用既有原子写 + .bak 惯例。
 *
 * 铁律：清单**永远先落库**（即使模型失败/超时也记下，只是没有提议）；纯函数优先、fail-soft、
 * 原子写、零硬编码（上限/超时走 KHY_LEARN_* env）；可选 evo 路由默认开（需调用方显式 route；KHY_EVO_ENGINE=off 关闭）。
 */

const fs = require('fs');
const path = require('path');

const { getBaseDataDir } = require('../utils/dataHome');

const FINDINGS_VERSION = 1;

// 收敛到 utils/envIntNonNeg 单一真源(逐字节委托,调用点不变)
const _envInt = require('../utils/envIntNonNeg');
function _envBool(name, def) {
  const v = String(process.env[name] == null ? '' : process.env[name]).trim().toLowerCase();
  if (v === '') return def;
  return !(v === '0' || v === 'false' || v === 'off' || v === 'no');
}

const MAX_FINDINGS = () => _envInt('KHY_LEARN_IMPROVE_MAX', 200);     // backlog 上限（FIFO 丢最旧）
const AI_TIMEOUT_MS = () => _envInt('KHY_LEARN_FETCH_TIMEOUT_MS', 4000); // 复用既有取数超时

// 收敛到 utils/growthDataDir 单一真源(逐字节委托,调用点不变) // ~/.khyos/growth
const _findingsDir = require('../utils/growthDataDir');
function _findingsFile() { return path.join(_findingsDir(), 'learn_findings.json'); }
function _findingsBak() { return path.join(_findingsDir(), 'learn_findings.bak'); }

function _emptyStore() { return { version: FINDINGS_VERSION, findings: [] }; }

/** 读清单；缺失/损坏 → 空清单。绝不抛。 */
function loadFindings() {
  try {
    const file = _findingsFile();
    if (!fs.existsSync(file)) return _emptyStore();
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
    if (!raw || typeof raw !== 'object' || !Array.isArray(raw.findings)) return _emptyStore();
    return { version: Number(raw.version) || FINDINGS_VERSION, findings: raw.findings };
  } catch {
    return _emptyStore();
  }
}

/** 原子写清单（.tmp → rename）+ 写前 .bak 轮转。fail-soft 返回布尔。 */
function _atomicWrite(store) {
  try {
    const dir = _findingsDir();           // getBaseDataDir 已确保目录存在
    const file = _findingsFile();
    try { if (fs.existsSync(file)) fs.copyFileSync(file, _findingsBak()); } catch { /* best-effort */ }
    const tmp = path.join(dir, `.learn_findings.${process.pid}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify(store, null, 2) + '\n', 'utf-8');
    fs.renameSync(tmp, file);
    return true;
  } catch {
    return false;
  }
}

// 关键词启发式分类（确定性地板，无需模型）。命中优先级自上而下。
const _KIND_RULES = [
  { kind: 'perf', re: /(慢|卡|性能|耗时|延迟|slow|perf|latency|timeout|超时)/i },
  { kind: 'bug', re: /(崩|挂|报错|异常|错误|失败|bug|crash|error|throw|exception|fail)/i },
  { kind: 'gap', re: /(缺|没有|未实现|不支持|遗漏|missing|lack|todo|尚未)/i },
  { kind: 'doc', re: /(文档|注释|说明|看不懂|不清楚|doc|comment|unclear|readme)/i },
  { kind: 'design', re: /(设计|架构|耦合|重构|可维护|design|architecture|coupl|refactor)/i },
];

/** 把一句自由描述确定性地归类，便于复盘聚合。无命中 → 'unknown'。 */
function classify(note) {
  const s = String(note == null ? '' : note);
  for (const r of _KIND_RULES) { if (r.re.test(s)) return r.kind; }
  return 'unknown';
}

/** 构造给模型的「修复提议」prompt（只产建议、不应用）。中文。 */
function buildImprovePrompt(finding) {
  const f = finding || {};
  const fileList = (Array.isArray(f.files) ? f.files : []).map(x => `  - ${x}`).join('\n') || '  （无关联源码）';
  return `[KHY 改进提议 — 学习者发现的不足]
[语言: 默认中文]
你是 KHY OS 的资深维护者。一位学习者在学习时发现了下面这个潜在不足，请给出一份**具体、可落地的修复/改进提议**。
注意：你的提议仅供人工参考，**不会被自动应用**——所以请聚焦"怎么改、为什么这样改"，不要假装已经改好。

关联知识点: 第 ${f.layerId} 层 / ${f.topicId}${f.topicTitle ? `（${f.topicTitle}）` : ''}
相关源码文件:
${fileList}

学习者的发现:
${f.note || '(未填写)'}

请输出（简洁）:
1. 你对这个不足的判断（是否成立、根因在哪）。
2. 具体修复方向：改哪个文件、加/改什么逻辑、注意哪些边界（fail-soft / 零硬编码 / 跨平台）。
3. 一个最小验证方式（写个什么测试或手测一步即可）。
读不到源码也要基于描述给出方向，不要因为读不到文件就拒绝；不要凭空编造具体代码行。`;
}

function _withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timeout`)), ms)),
  ]);
}

// 进程内单调计数 + pid，避免 Date.now 在某些受限环境的限制并保证同毫秒唯一。
let _seq = 0;
function _newId() {
  _seq += 1;
  return `imp-${process.pid}-${Date.now().toString(36)}-${_seq}`;
}

/**
 * 记录一条「不足」。清单**永远先落库**；有模型且未显式跳过时附 AI 修复提议。
 * @param {object} input { layerId, topicId, topicTitle, files[], note }
 * @param {object} opts
 *   callModel {function} 注入式单次模型调用（由 CLI 层提供，保持本服务模块不反向依赖 cli 层）；
 *             非函数（null/undefined）=跳过 AI 提议，清单照样落库。
 *   route     {boolean} 是否尝试路由到 evo 改进管线（默认开，KHY_EVO_ENGINE=off 时关闭）
 * @returns {Promise<{ok:boolean, finding:object}>}
 */
async function appendFinding(input = {}, opts = {}) {
  const finding = {
    id: _newId(),
    at: new Date().toISOString(),
    layerId: input.layerId == null ? null : Number(input.layerId),
    topicId: input.topicId == null ? null : String(input.topicId),
    topicTitle: input.topicTitle ? String(input.topicTitle) : '',
    files: Array.isArray(input.files) ? input.files.slice(0, 20).map(String) : [],
    note: String(input.note == null ? '' : input.note).slice(0, 2000),
    kind: classify(input.note),
    proposal: '',
    proposalSource: 'none',
    evoRouted: false,
  };

  // ① AI 修复提议（可选，bounded，fail-soft）。callModel 由 CLI 层注入，
  //    本服务模块不反向 require cli/ai（保持分层方向 cli→services）。
  if (typeof opts.callModel === 'function') {
    const callModel = opts.callModel;
    try {
      const reply = await _withTimeout(callModel(buildImprovePrompt(finding)), AI_TIMEOUT_MS(), 'improve');
      const text = String(reply == null ? '' : reply).trim();
      if (text) { finding.proposal = text.slice(0, 4000); finding.proposalSource = 'model'; }
    } catch { /* 超时/抛错 → 保持 proposal 空，清单照样落库 */ }
  }

  // ② 可选路由到 evo 改进管线（默认开，=off 关；仍需调用方显式 route 双重把关）
  if (opts.route === true && _envBool('KHY_EVO_ENGINE', true)) {
    try {
      const { observeFailure } = require('./evoEngine/frictionBridge');
      observeFailure({
        signal: 'interceptor-block',
        surface: `learn:${finding.layerId}:${finding.topicId}`,
        painPoint: finding.note,
        context: { source: 'learn-improve', files: finding.files, kind: finding.kind },
      });
      finding.evoRouted = true;
    } catch { /* fail-soft：路由失败不影响清单 */ }
  }

  // ③ 落库（FIFO 上限）
  const store = loadFindings();
  store.findings.push(finding);
  const cap = MAX_FINDINGS();
  if (cap > 0 && store.findings.length > cap) {
    store.findings.splice(0, store.findings.length - cap);   // 丢最旧
  }
  const wrote = _atomicWrite(store);
  return { ok: wrote, finding };
}

/** 列出清单，最新在前。opts.limit 截断。 */
function listFindings(opts = {}) {
  const all = loadFindings().findings.slice().reverse();   // newest-first
  const limit = opts && Number.isFinite(opts.limit) ? opts.limit : null;
  return limit && limit > 0 ? all.slice(0, limit) : all;
}

module.exports = {
  loadFindings,
  classify,
  buildImprovePrompt,
  appendFinding,
  listFindings,
};
