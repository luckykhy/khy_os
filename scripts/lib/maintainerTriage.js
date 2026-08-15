'use strict';

/**
 * maintainerTriage.js — Khy-OS 症状分诊器（确定性匹配模块）
 *
 * 送别礼的反向能力：把「一句症状 / 一段报错」→ 排序匹配到真实子系统，
 * 并交出「该读哪些文件 / 该跑哪条验证命令」。与 1000 条进化手册共用同一真源
 * （docs/_维护者/维护映射表.json），映射表长大它自动覆盖。
 *
 * 三类人都受益：
 *   - 使用者：对着报错不再发懵，知道下一步做什么。
 *   - 开发者：一句话定位子系统入口，不用通读全仓。
 *   - 维护者：照给出的 verify 命令自证「修好了」。
 *
 * 分层：核心打分函数 triageSymptom 是纯计算（无时钟 / 无随机 / 无网络 /
 * 同输入恒同输出）；读表函数 loadMap 是本模块唯一的 IO 边界，单独隔离且
 * fail-soft（读不到 / 解析失败一律返回空数组，绝不抛给调用方）。故本文件是
 * 「纯核心 + 隔离读表」的确定性模块，而非零 IO 文件——两者刻意分开。
 *
 * HOW-TO-EXTEND（给下一个维护者 / 小模型）
 *   1. 想让某类症状更易命中 → 往 SYMPTOM_HINTS 追加一条 { area:'<映射表里的 id>', words:[...] }。
 *      words 支持中英混写，会作为高权重关键词参与打分。
 *   2. 新子系统请先登记进 docs/_维护者/维护映射表.json（whenToUse/paths/docs/verify 齐全），
 *      本分诊器与速查表下次都会自动覆盖它，通常无需改本文件。
 *   3. 改完跑：node --test scripts/tests/maintainerTriage.test.js（必须绿）。
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const MAP_PATH = path.join(ROOT, 'docs', '_维护者', '维护映射表.json');

/**
 * 症状提示表：把常见「人话症状」与子系统 id 显式关联，作为高权重信号。
 * 这些是 whenToUse 之外的补充直觉，专为弱模型/新手把话说到点子上。
 * area 必须是维护映射表里真实存在的 id；不存在的条目在打分时被安全忽略。
 */
const SYMPTOM_HINTS = [
  { area: 'bootstrap-packaging', words: ['启动', '装不上', '安装', 'install', 'startup', 'bootstrap', 'pip', 'wheel', '版本', 'version', '打不开', 'cli 不启动', 'command not found'] },
  { area: 'cli-routing', words: ['命令', '别名', 'alias', 'slash', '斜杠', '路由', 'route', 'command not recognized', '找不到命令', '帮助', 'help'] },
  { area: 'prompt-capsule-system', words: ['提示词', 'prompt', '胶囊', 'capsule', 'system prompt', '系统提示', 'debug-prompt', '人格'] },
  { area: 'gateway-adapters', words: ['识图', '视觉', 'vision', '适配器', 'adapter', '模型', 'model', '流式', 'stream', '网关', 'gateway', '404', '429', '兜底', 'fallback', 'econnreset', '回答', '答复'] },
  { area: 'proxy-daemon-runtime', words: ['端口', 'port', '守护', 'daemon', '代理', 'proxy', '连不上', '重连', 'reconnect', '漂移', 'drift', '后台'] },
  { area: 'ai-management-surface', words: ['管理页', '管理界面', 'management', '前端', 'frontend', 'ui', '登录', 'login', '面板', 'admin', 'vite'] },
  { area: 'workspace-publish-verify', words: ['工作区', 'workspace', '发布', 'publish', '快照', 'snapshot', '验证命令', 'verify'] },
  { area: 'maintenance-safety', words: ['守卫', 'guard', '规则', 'rule', '门禁', 'gate', '安全', 'safety', 'agent-rules', 'change-safety', '交接'] },
  { area: 'release-rollback', words: ['回滚', 'rollback', '发版', 'release', '稳定版', 'stable', 'known-good', '版本同步', 'version sync'] },
  { area: 'env-optimize', words: ['打造最佳环境', '自检', 'selfcheck', 'self-check', '自愈', 'repair', '探针', 'probe', '垃圾', 'junk', '优化环境', 'doctor'] },
  { area: 'evolution-prompts', words: ['进化', 'evolution', '提示词手册', 'playbook', '1000', '改进清单', '进化清单'] },
  { area: 'triage', words: ['分诊', 'triage', '症状', 'symptom', '不知道从哪', '定位', '哪个子系统', '速查'] },
];

/** 归一化文本为小写并抽取词元（中英兼容：英文按非字母数字切，中文保留整串做子串匹配）。绝不抛。 */
function _tokenize(text) {
  try {
    const s = String(text == null ? '' : text).toLowerCase();
    // 英文/数字词元
    const latin = s.split(/[^a-z0-9]+/).filter((w) => w && w.length >= 2);
    return { raw: s, tokens: latin };
  } catch {
    return { raw: '', tokens: [] };
  }
}

/** 统计 needle 在 haystack(小写原串) 中作为子串出现与否；对中文/短语有效。绝不抛。 */
function _contains(hay, needle) {
  try {
    if (!hay || !needle) return false;
    return hay.indexOf(String(needle).toLowerCase()) !== -1;
  } catch {
    return false;
  }
}

/**
 * 对单个 area 计算与症状文本的匹配分。确定性、绝不抛。
 * 权重：症状提示词命中 > whenToUse 短语命中 > label/id 命中 > 路径尾名命中。
 */
function _scoreArea(area, norm, hintWordsByArea) {
  try {
    let score = 0;
    const hits = [];
    const { raw, tokens } = norm;
    const tokenSet = new Set(tokens);

    // 1) 症状提示词（高权重，5 分/命中）
    const hintWords = hintWordsByArea[area.id] || [];
    for (const w of hintWords) {
      const lw = String(w).toLowerCase();
      const isLatin = /^[a-z0-9 ]+$/.test(lw);
      const hit = isLatin ? (tokenSet.has(lw) || _contains(raw, lw)) : _contains(raw, lw);
      if (hit) {
        score += 5;
        hits.push(w);
      }
    }

    // 2) whenToUse 短语：整句子串命中 4 分；否则按其词元命中累加
    for (const phrase of area.whenToUse) {
      const lp = String(phrase).toLowerCase();
      if (lp && _contains(raw, lp)) {
        score += 4;
        hits.push(phrase);
        continue;
      }
      const pw = lp.split(/[^a-z0-9]+/).filter((x) => x && x.length >= 3);
      let phraseHit = 0;
      for (const w of pw) {
        if (tokenSet.has(w)) phraseHit += 1;
      }
      if (phraseHit) score += phraseHit; // 每个共享词 1 分
    }

    // 3) label / id 命中（2 分）
    for (const w of String(area.label).toLowerCase().split(/[^a-z0-9]+/).filter((x) => x && x.length >= 3)) {
      if (tokenSet.has(w)) { score += 2; break; }
    }
    if (_contains(raw, String(area.id).toLowerCase())) { score += 2; }

    // 4) 路径尾名命中（1 分，弱信号：用户可能直接贴了文件名）
    for (const p of area.paths) {
      const base = String(p).split('/').pop().toLowerCase().replace(/\.[a-z]+$/, '');
      if (base.length >= 4 && tokenSet.has(base)) { score += 1; hits.push(base); break; }
    }

    return { score, hits };
  } catch {
    return { score: 0, hits: [] };
  }
}

/** 规整 area 结构，缺字段安全补空。绝不抛。 */
function _normalizeArea(a) {
  return {
    id: String((a && a.id) || ''),
    label: String((a && a.label) || (a && a.id) || 'Unknown'),
    whenToUse: Array.isArray(a && a.whenToUse) ? a.whenToUse.map(String) : [],
    paths: Array.isArray(a && a.paths) ? a.paths.map(String) : [],
    docs: Array.isArray(a && a.docs) ? a.docs.map(String) : [],
    verify: Array.isArray(a && a.verify) ? a.verify.map(String) : [],
  };
}

/**
 * 分诊：把症状文本映射到排序后的子系统列表。
 * @param {string} text 症状 / 报错文本
 * @param {object} [opts]
 * @param {Array} [opts.map] 已加载的 areas 数组（不传则由调用方经 loadMap 提供；本函数零 IO）
 * @param {number} [opts.limit] 返回条数上限（默认 3）
 * @returns {Array<{id,label,score,hits,paths,docs,verify,firstFile,firstVerify}>}
 *          无匹配或异常 → 空数组。绝不抛。
 */
function triageSymptom(text, opts = {}) {
  try {
    const areasIn = Array.isArray(opts.map) ? opts.map : [];
    const limit = Number.isFinite(opts.limit) && opts.limit > 0 ? Math.floor(opts.limit) : 3;
    const norm = _tokenize(text);
    if (!norm.raw.trim()) return [];

    const hintWordsByArea = {};
    for (const h of SYMPTOM_HINTS) {
      if (!h || !h.area) continue;
      hintWordsByArea[h.area] = (hintWordsByArea[h.area] || []).concat(Array.isArray(h.words) ? h.words : []);
    }

    const scored = [];
    for (const rawArea of areasIn) {
      const a = _normalizeArea(rawArea);
      if (!a.id) continue;
      const { score, hits } = _scoreArea(a, norm, hintWordsByArea);
      if (score <= 0) continue;
      scored.push({
        id: a.id,
        label: a.label,
        score,
        hits: Array.from(new Set(hits)),
        paths: a.paths,
        docs: a.docs,
        verify: a.verify,
        firstFile: a.paths[0] || '',
        firstVerify: a.verify[0] || '',
      });
    }

    // 确定性排序：分高优先；同分按 id 字典序稳定，杜绝随机
    scored.sort((x, y) => (y.score - x.score) || (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));
    return scored.slice(0, limit);
  } catch {
    return [];
  }
}

/** 读维护映射表 areas（隔离 IO，fail-soft 返回 []）。绝不抛。 */
function loadMap(mapPath) {
  try {
    const raw = fs.readFileSync(mapPath || MAP_PATH, 'utf8');
    const json = JSON.parse(raw);
    return Array.isArray(json.areas) ? json.areas.map(_normalizeArea) : [];
  } catch {
    return [];
  }
}

module.exports = {
  triageSymptom,
  loadMap,
  SYMPTOM_HINTS,
  MAP_PATH,
  _tokenize,
  _scoreArea,
  _normalizeArea,
};
