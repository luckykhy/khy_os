'use strict';

/**
 * learningCurriculum.js — KHY OS 交互式学习课程引擎
 *
 * 课程数据从 backend/src/data/curriculum.json 加载（可热重载），
 * 第 10 层 Bug 案例从 bugCases.js 动态合入。
 * 支持 CRUD 操作和文件引用校验，确保课程随代码同步演进。
 * 进度持久化到 ~/.khyquant/growth/learning_progress.json。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const chalkModule = require('chalk');
const chalk = chalkModule.default || chalkModule;
const { BUG_CASES, exportBugCasesForTraining, getBugCase, searchBugCases } = require('../data/bugCases');
const { getBaseDataDir } = require('../utils/dataHome');

// ── 终端适配 ─────────────────────────────────────────────────────────

/** 获取终端可用列数 (最小 40, 左右各留 2 缩进) */
function _cols() { return Math.max(40, (process.stdout.columns || 80)); }

/** 内容区宽度 (去掉左右 2 字符缩进) */
function _inner() { return _cols() - 4; }

/** 生成填充到内容宽度的分隔线 */
function _rule(ch = '─') { return ch.repeat(Math.max(8, _inner())); }

/**
 * 按终端宽度自动折行。
 * @param {string} text  原始文本
 * @param {number} indent 每行前导空格数
 * @param {number} [width] 可用宽度 (默认终端宽度 - indent)
 * @returns {string[]} 折行后的行数组 (不含缩进前缀)
 */
function _wrapLines(text, indent, width) {
  const w = width || (_cols() - indent);
  if (w <= 10) return [text];
  const result = [];
  let pos = 0;
  while (pos < text.length) {
    let end = pos + w;
    if (end >= text.length) { result.push(text.slice(pos)); break; }
    // 在空格/标点处断行
    let bp = text.lastIndexOf(' ', end);
    if (bp <= pos) bp = text.lastIndexOf('，', end);
    if (bp <= pos) bp = text.lastIndexOf('、', end);
    if (bp <= pos) bp = text.lastIndexOf('。', end);
    if (bp <= pos) bp = end; // 无断点则硬切
    result.push(text.slice(pos, bp));
    pos = bp;
    if (text[pos] === ' ') pos++; // 跳过空格
  }
  return result;
}

// ── 教程渲染主题 ─────────────────────────────────────────────────────
const T = {
  title:   chalk.bold.cyan,          // 标题 / 层名
  layerNum: chalk.bold.yellow,       // 层号
  summary: chalk.dim,                // 概要 / 描述
  done:    chalk.green,              // 已完成标记 ✓
  pending: chalk.gray,               // 未完成标记 ○
  partial: chalk.yellow,             // 部分完成 ▸
  filePath: chalk.italic.cyan,       // 文件路径
  frame:   chalk.dim,                // 代码框线 ┌│└
  code:    chalk.white,              // 代码内容
  lineNum: chalk.dim.yellow,         // 行号
  nav:     chalk.magenta,            // 导航命令
  xp:      chalk.bold.green,         // 经验值
  warn:    chalk.red,                // 警告 / 失效
  hint:    chalk.dim.italic,         // 提示语
  tag:     chalk.cyan,               // 标签
  bar:     chalk.green,              // 进度条填充
  barBg:   chalk.dim,                // 进度条背景
  header:  chalk.bold.underline,     // 区块标题
  sep:     chalk.dim.cyan,           // 分隔线
};

// ── 课程数据加载 ────────────────────────────────────────────────────

// Resolve the repository / pip-bundle ROOT (where services/ + docs/ live).
// A naive `../../..` is fragile: after the "forest" restructure the backend
// lives at <root>/services/backend, so this file sits at
// <root>/services/backend/src/services — repo root is FOUR levels up, not three.
// In a pip install __dirname is under site-packages/khy_os/bundled/..., so we
// can't hard-code a depth. Walk up to the first ancestor that looks like the
// root (has both services/ and docs/), preferring the env hint when present.
function _resolveProjectRoot() {
  const looksLikeRoot = (dir) => {
    try {
      return !!dir
        && fs.existsSync(path.join(dir, 'services'))
        && fs.existsSync(path.join(dir, 'docs'));
    } catch { return false; }
  };
  // KHYQUANT_ROOT points at <root>/services/backend → repo root is two up.
  const envBackend = String(process.env.KHYQUANT_ROOT || '').trim();
  if (envBackend) {
    const cand = path.resolve(envBackend, '..', '..');
    if (looksLikeRoot(cand)) return cand;
  }
  let dir = __dirname;
  for (let i = 0; i < 10; i++) {
    if (looksLikeRoot(dir)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  // Last resort: historical layout assumption (four levels up = repo root).
  return path.resolve(__dirname, '..', '..', '..', '..');
}
const PROJECT_ROOT = _resolveProjectRoot();

// The "forest" restructure moved top-level dirs (backend → services/backend,
// khy_platform → platform/khy_platform, ...). curriculum.json and the scan
// rules below still carry some pre-restructure prefixes, so every reference to
// them showed "(无法读取)". Remap old → new on the fly so existing entries —
// and any externally-authored ones — keep resolving without a data migration.
const _PATH_REMAPS = [
  [/^backend\//, 'services/backend/'],
  [/^ai-backend\//, 'services/ai-backend/'],
  [/^khy_platform\//, 'platform/khy_platform/'],
  [/^frontend\//, 'apps/ai-frontend/'],
];

/**
 * Resolve a curriculum-relative path to an existing absolute path, trying the
 * literal path first then the old→new prefix remaps. Returns null if none exist.
 */
function _resolveSourceAbs(relPath) {
  const candidates = [];
  // 动态自愈：覆盖层若记录了该失效引用的新位置，优先尝试（重构后路径变化即时生效）。
  try {
    // 只依赖覆盖层叶子模块（纯持久化/合并，不反向依赖 dynamic 编排），避免 curriculum ⇄ dynamic 环。
    const ov = require('./learningOverlay');
    const healed = ov.remapFile(relPath, ov.loadOverlay());
    if (healed) candidates.push(healed);
  } catch { /* fail-soft */ }
  candidates.push(relPath);
  for (const [re, to] of _PATH_REMAPS) {
    if (re.test(relPath)) candidates.push(relPath.replace(re, to));
  }
  for (const rel of candidates) {
    const abs = path.resolve(PROJECT_ROOT, rel);
    try { if (fs.existsSync(abs)) return abs; } catch { /* ignore */ }
  }
  return null;
}
const CURRICULUM_FILE = path.join(__dirname, '..', 'data', 'curriculum.json');

let _layersCache = null;
let _layersMtime = 0;

function _loadCurriculumJSON() {
  try {
    const stat = fs.statSync(CURRICULUM_FILE);
    if (_layersCache && stat.mtimeMs === _layersMtime) return _layersCache;
    const raw = JSON.parse(fs.readFileSync(CURRICULUM_FILE, 'utf-8'));
    _layersMtime = stat.mtimeMs;
    _layersCache = raw;
    return raw;
  } catch (e) {
    if (_layersCache) return _layersCache;
    throw new Error(`Failed to load curriculum.json: ${e.message}`);
  }
}

function _saveCurriculumJSON(layers) {
  fs.writeFileSync(CURRICULUM_FILE, JSON.stringify(layers, null, 2) + '\n', 'utf-8');
  _layersCache = layers;
  _layersMtime = fs.statSync(CURRICULUM_FILE).mtimeMs;
}

function _buildLayers() {
  const base = _loadCurriculumJSON();
  const bugLayer = {
    id: 10,
    title: '实战 Bug 修复案例',
    summary: '真实 bug 的排查思路、根因分析和修复方案 — 同时作为小模型调试范例',
    topics: BUG_CASES.map(c => ({
      id: c.id,
      title: c.title,
      desc: c.symptom,
      files: c.detailDoc ? [...c.files, c.detailDoc] : c.files,
      _bugCase: true,
    })),
  };
  // Merge JSON-defined layers with the dynamic bug layer, then order by id.
  // The bug layer (id 10) was historically appended last and happened to be in
  // ascending order; once a layer is added after it (the kernel deep-dive at
  // id 11), an explicit sort keeps the roadmap numerically consistent and
  // future-proofs any addLayer-generated layer (which also skips the reserved 10).
  let layers = [...base, bugLayer].sort((a, b) => a.id - b.id);

  // 动态覆盖层（有 AI/网络时自动发现/AI 扩充的知识点）。地板始终在前，覆盖层只叠加；
  // 只依赖覆盖层叶子模块（纯持久化/合并），避免 curriculum ⇄ dynamic 环；任何失败回落纯地板。
  try {
    const ov = require('./learningOverlay');
    layers = ov.applyOverlay(layers, ov.loadOverlay());
  } catch { /* fail-soft：纯地板 */ }

  return layers;
}

// Getter — always returns fresh merged array (JSON is mtime-cached)
function getLayers() { return _buildLayers(); }

// ── 进度管理 ─────────────────────────────────────────────────────────

// 学习进度归属「底座」(khyos)，持久化于 ~/.khyos/growth/learning_progress.json。
// 该位置在用户主目录内，pip 升级 / 重装不会覆盖 → 进度永不丢失。
// 早期版本曾写在应用领地 ~/.khyquant/growth/（数据主权违规），故首次加载时做一
// 次性安全迁移：读旧 → 写新 → 保留旧文件原样（不删，最坏只是多一份冗余副本）。
// 收敛到 utils/growthDataDir 单一真源(逐字节委托,调用点不变) // ~/.khyos/growth
const _progressDir = require('../utils/growthDataDir');
function _progressFile() { return path.join(_progressDir(), 'learning_progress.json'); }
function _progressBak() { return path.join(_progressDir(), 'learning_progress.bak'); }
function _legacyProgressFile() {
  return path.join(os.homedir(), '.khyquant', 'growth', 'learning_progress.json');
}

/** 全新用户的初始进度结构（单一真源，resetProgress 复用） */
function _freshProgress() {
  return {
    completedTopics: [],    // "layerId:topicId" — 已完成
    viewedTopics: [],       // "layerId:topicId" — 浏览过但未完成
    currentLayer: 0,
    totalXP: 0,
    startedAt: new Date().toISOString(),
    lastVisit: null,        // { layerId, topicId, at: ISO }
    streak: { count: 0, lastDate: null },  // 连续学习天数
    notes: {},
  };
}

/** schema 兜底 — 老版本可能缺字段；返回规范化对象，非对象返回 null */
function _normalizeProgress(p) {
  if (!p || typeof p !== 'object') return null;
  if (!Array.isArray(p.completedTopics)) p.completedTopics = [];
  if (!Array.isArray(p.viewedTopics)) p.viewedTopics = [];
  if (typeof p.currentLayer !== 'number') p.currentLayer = 0;
  if (typeof p.totalXP !== 'number') p.totalXP = 0;
  if (!p.startedAt) p.startedAt = new Date().toISOString();
  if (!p.lastVisit) p.lastVisit = null;
  if (!p.streak || typeof p.streak !== 'object') p.streak = { count: 0, lastDate: null };
  if (!p.notes || typeof p.notes !== 'object') p.notes = {};
  return p;
}

function _readProgressFile(file) {
  try {
    if (fs.existsSync(file)) {
      const p = _normalizeProgress(JSON.parse(fs.readFileSync(file, 'utf-8')));
      if (p) return p;
    }
  } catch { /* corrupt / unreadable — 视为不存在 */ }
  return null;
}

function _loadProgress() {
  // 1. 正常路径：底座位置
  const current = _readProgressFile(_progressFile());
  if (current) return current;

  // 2. 底座为空 → 从旧应用领地一次性迁移（读旧 → 写新 → 旧文件保留不删）
  const legacy = _readProgressFile(_legacyProgressFile());
  if (legacy) {
    _saveProgress(legacy);
    return legacy;
  }

  // 3. 全新用户
  return _freshProgress();
}

function _saveProgress(progress) {
  try {
    const dir = _progressDir();           // getBaseDataDir 已确保目录存在
    const file = _progressFile();
    // 写前轮转单份备份，文件损坏时可回退
    try { if (fs.existsSync(file)) fs.copyFileSync(file, _progressBak()); } catch { /* best-effort */ }
    // 原子写：同目录临时文件 + rename（同卷 rename 原子，避免半写损坏）
    const tmp = path.join(dir, `.learning_progress.${process.pid}.tmp`);
    fs.writeFileSync(tmp, JSON.stringify(progress, null, 2), 'utf-8');
    fs.renameSync(tmp, file);
  } catch { /* best-effort — 绝不打断学习流 */ }
}

function getProgress() { return _loadProgress(); }

function markTopicCompleted(layerId, topicId) {
  const LAYERS = getLayers();
  const progress = _loadProgress();
  const key = `${layerId}:${topicId}`;
  if (!progress.completedTopics.includes(key)) {
    progress.completedTopics.push(key);
    progress.totalXP += 10;
  }
  // 从 viewedTopics 移除 (已完成的不再算"浏览未完成")
  const vIdx = progress.viewedTopics ? progress.viewedTopics.indexOf(key) : -1;
  if (vIdx >= 0) progress.viewedTopics.splice(vIdx, 1);

  const layer = LAYERS.find(l => l.id === layerId);
  if (layer) {
    const allDone = layer.topics.every(t => progress.completedTopics.includes(`${layerId}:${t.id}`));
    if (allDone && layerId >= progress.currentLayer) {
      progress.currentLayer = Math.min(layerId + 1, LAYERS.length - 1);
      progress.totalXP += 50;
    }
  }
  _updateStreak(progress);
  _saveProgress(progress);
  return progress;
}

function addNote(layerId, topicId, note) {
  const progress = _loadProgress();
  if (!progress.notes) progress.notes = {};
  const key = `${layerId}:${topicId}`;
  const existing = progress.notes[key];
  progress.notes[key] = existing ? `${existing}\n${note}` : note;
  _saveProgress(progress);
  return progress;
}

function buildLearningMemoryContext() {
  const LAYERS = getLayers();
  const progress = _loadProgress();
  if (progress.completedTopics.length === 0) return '';

  const lines = ['[学习记忆 — 用户已掌握的知识点]'];
  const byLayer = {};
  for (const key of progress.completedTopics) {
    const [lid, tid] = key.split(':');
    if (!byLayer[lid]) byLayer[lid] = [];
    byLayer[lid].push({ tid, key });
  }

  for (const lid of Object.keys(byLayer).sort((a, b) => +a - +b)) {
    const layer = LAYERS.find(l => l.id === +lid);
    if (!layer) continue;
    lines.push(`\n第 ${lid} 层 ${layer.title}:`);
    for (const { tid, key } of byLayer[lid]) {
      const topic = layer.topics.find(t => t.id === tid);
      const title = topic ? topic.title : tid;
      const note = progress.notes && progress.notes[key];
      lines.push(`  ✓ ${title}${note ? ` — 笔记: ${note.split('\n')[0]}` : ''}`);
    }
  }

  lines.push(`\n总 XP: ${progress.totalXP} | 已完成: ${progress.completedTopics.length} 个知识点`);
  lines.push('');
  lines.push('教学时请：');
  lines.push('- 主动关联已学知识点，用"你之前学过的 XXX"来建立连接');
  lines.push('- 如果当前知识点依赖已学内容，直接引用而非重复讲解');
  lines.push('- 如果发现已学内容与当前知识点有对比价值，做对比表格');
  lines.push('- 参考用户笔记了解其关注点和理解程度');
  return lines.join('\n');
}

/**
 * 记录知识点已浏览 (但未完成), 同时更新 lastVisit 和 streak。
 */
function markTopicViewed(layerId, topicId) {
  const progress = _loadProgress();
  const key = `${layerId}:${topicId}`;
  if (!progress.viewedTopics.includes(key) && !progress.completedTopics.includes(key)) {
    progress.viewedTopics.push(key);
  }
  progress.lastVisit = { layerId, topicId, at: new Date().toISOString() };
  _updateStreak(progress);
  _saveProgress(progress);
  return progress;
}

/** 更新连续学习天数 */
function _updateStreak(progress) {
  const today = new Date().toISOString().slice(0, 10);
  if (!progress.streak) progress.streak = { count: 0, lastDate: null };
  if (progress.streak.lastDate === today) return; // 今天已计
  if (progress.streak.lastDate) {
    const last = new Date(progress.streak.lastDate);
    const diff = Math.floor((Date.now() - last.getTime()) / 86400000);
    if (diff === 1) {
      progress.streak.count += 1; // 连续
    } else if (diff > 1) {
      progress.streak.count = 1; // 断了，重新开始
    }
  } else {
    progress.streak.count = 1;
  }
  progress.streak.lastDate = today;
}

/**
 * 生成轻推提示 — 根据学习状态返回一条提示文本 (或 null)。
 * 场景:
 *   1. 有浏览未完成的知识点 → 提示继续
 *   2. 距上次学习超过 3 天 → 提示回来
 *   3. 当前层即将学完 → 鼓励冲刺
 *   4. 连续学习 → 表扬 streak
 *   5. 刚学完一层 → 祝贺 + 推荐下一层
 */
function getNudge() {
  const LAYERS = getLayers();
  const p = _loadProgress();
  const inner = _inner();

  // 没有任何记录 → 不轻推
  if (p.completedTopics.length === 0 && p.viewedTopics.length === 0) return null;

  const layer = LAYERS.find(l => l.id === p.currentLayer);
  if (!layer) return null;

  const total = layer.topics.length;
  const done = layer.topics.filter(t => p.completedTopics.includes(`${layer.id}:${t.id}`)).length;
  const viewed = layer.topics.filter(t =>
    p.viewedTopics.includes(`${layer.id}:${t.id}`) && !p.completedTopics.includes(`${layer.id}:${t.id}`)
  );

  const lines = [];

  // 1. 连续学习表扬 (streak >= 3)
  if (p.streak && p.streak.count >= 3) {
    lines.push(T.xp(`🔥 连续学习 ${p.streak.count} 天！`));
  }

  // 2. 距上次学习超过 3 天
  if (p.lastVisit && p.lastVisit.at) {
    const daysSince = Math.floor((Date.now() - new Date(p.lastVisit.at).getTime()) / 86400000);
    if (daysSince >= 3) {
      const lastTopic = layer.topics.find(t => t.id === p.lastVisit.topicId);
      const where = lastTopic
        ? `第 ${p.lastVisit.layerId} 层 · ${lastTopic.title}`
        : `第 ${p.lastVisit.layerId} 层`;
      lines.push(T.hint(`📌 上次学到 ${where} (${daysSince} 天前)，输入 `) + T.nav('learn next') + T.hint(' 继续'));
    }
  }

  // 3. 有浏览未完成的知识点
  if (viewed.length > 0 && viewed.length <= 3) {
    const names = viewed.map(t => chalk.white(t.title)).join(T.hint('、'));
    lines.push(T.hint(`💡 ${names} 已浏览但未标记完成，完成后可获 XP`));
  } else if (viewed.length > 3) {
    lines.push(T.hint(`💡 本层有 ${viewed.length} 个知识点已浏览未完成`));
  }

  // 4. 当前层即将学完 (>=70%)
  if (total > 0 && done > 0 && done < total) {
    const pct = Math.round((done / total) * 100);
    if (pct >= 70) {
      lines.push(T.partial(`⚡ 第 ${layer.id} 层已完成 ${pct}%，还差 ${total - done} 个知识点！`));
    }
  }

  // 5. 刚学完一层 (所有完成 + 上一层完成但下一层没开始)
  if (done === total && total > 0) {
    const nextLayer = LAYERS.find(l => l.id === p.currentLayer);
    const nextDone = nextLayer ? nextLayer.topics.filter(t => p.completedTopics.includes(`${nextLayer.id}:${t.id}`)).length : 0;
    if (nextDone === 0 && nextLayer) {
      lines.push(T.done(`🎉 第 ${layer.id} 层已全部完成！`) + T.hint(' 下一站: ') + T.nav(`learn ${nextLayer.id}`));
    }
  }

  if (lines.length === 0) return null;
  return lines.join('\n  ');
}

function resetProgress() {
  const fresh = _freshProgress();
  _saveProgress(fresh);
  return fresh;
}

// ── 课程查询 ─────────────────────────────────────────────────────────

function getLayer(id) {
  return getLayers().find(l => l.id === id) || null;
}

function getAllLayers() { return getLayers(); }

function getNextTopic() {
  const LAYERS = getLayers();
  const progress = _loadProgress();
  const layer = LAYERS.find(l => l.id === progress.currentLayer);
  if (!layer) return null;
  for (const topic of layer.topics) {
    if (!progress.completedTopics.includes(`${layer.id}:${topic.id}`)) {
      return { layer, topic };
    }
  }
  const nextLayer = LAYERS.find(l => l.id === progress.currentLayer + 1);
  if (nextLayer && nextLayer.topics.length > 0) {
    return { layer: nextLayer, topic: nextLayer.topics[0] };
  }
  return null;
}

function findByQuery(query) {
  if (!query) return null;
  const LAYERS = getLayers();
  const q = query.toLowerCase();

  const num = parseInt(q, 10);
  if (!isNaN(num) && num >= 0 && num <= LAYERS.length - 1) {
    return { layer: LAYERS.find(l => l.id === num) || LAYERS[num], topic: null };
  }

  for (const layer of LAYERS) {
    if (layer.title.toLowerCase().includes(q) || layer.summary.toLowerCase().includes(q)) {
      return { layer, topic: null };
    }
    for (const topic of layer.topics) {
      if (topic.title.toLowerCase().includes(q) || topic.desc.toLowerCase().includes(q)) {
        return { layer, topic };
      }
      if (topic.files.some(f => f.toLowerCase().includes(q))) {
        return { layer, topic };
      }
    }
  }

  const bugMatch = searchBugCases(q);
  if (bugMatch.length > 0) {
    const bugLayer = LAYERS.find(l => l.id === 10);
    const matchedTopic = bugLayer && bugLayer.topics.find(t => t.id === bugMatch[0].id);
    if (bugLayer && matchedTopic) return { layer: bugLayer, topic: matchedTopic };
  }

  return null;
}

// ── 静态富文本渲染（无模型/离线学习） ────────────────────────────────

/**
 * 读取源文件，提取前 N 行有效代码（跳过文件头注释）。
 * 无法读取时静默返回 null。
 */
function _readFilePreview(relPath, maxLines = 18) {
  try {
    const abs = _resolveSourceAbs(relPath);
    if (!abs) return null;
    const stat = fs.statSync(abs);
    if (stat.isDirectory()) {
      // 目录：列出直接子文件
      const entries = fs.readdirSync(abs, { withFileTypes: true })
        .filter(e => !e.name.startsWith('.'))
        .slice(0, 12)
        .map(e => `  ${e.isDirectory() ? e.name + '/' : e.name}`);
      return { type: 'dir', lines: entries, total: entries.length };
    }
    const raw = fs.readFileSync(abs, 'utf-8');
    const allLines = raw.split('\n');
    // 跳过文件头注释块
    let start = 0;
    while (start < allLines.length && /^\s*(\/\/|\/\*|\*|#!\/?|#\s|$)/.test(allLines[start])) start++;
    if (start >= allLines.length) start = 0; // 全是注释则从头开始
    const preview = allLines.slice(start, start + maxLines);
    return { type: 'file', lines: preview, total: allLines.length, startLine: start + 1 };
  } catch {
    return null;
  }
}

/**
 * 层级总览 — 纯文本渲染，不依赖 AI。
 */
function formatLayerOverviewRich(layer) {
  const progress = _loadProgress();
  const inner = _inner();
  const lines = [];
  lines.push('');
  lines.push(`  ${T.sep('━━')} ${T.layerNum(`第 ${layer.id} 层`)}${T.sep(':')} ${T.title(layer.title)} ${T.sep('━━')}`);
  for (const wl of _wrapLines(layer.summary, 2, inner)) {
    lines.push(`  ${T.summary(wl)}`);
  }
  lines.push('');
  lines.push(`  ${T.header('知识点')}`);
  layer.topics.forEach((t, i) => {
    const isDone = progress.completedTopics.includes(`${layer.id}:${t.id}`);
    const mark = isDone ? T.done('✓') : T.pending('○');
    lines.push(`    ${mark} ${chalk.bold(`${i + 1}.`)} ${isDone ? T.done(t.title) : chalk.white(t.title)}`);
    for (const wl of _wrapLines(t.desc, 7, inner - 5)) {
      lines.push(`       ${T.summary(wl)}`);
    }
    if (t.files && t.files.length > 0) {
      lines.push(`       ${T.hint('源码:')} ${t.files.map(f => T.filePath(f)).join(T.hint(', '))}`);
    }
  });
  lines.push('');
  lines.push(`  ${T.hint('开始学习:')} ${T.nav(`learn ${layer.id}.1`)}`);
  lines.push(`  ${T.hint('查看进度:')} ${T.nav('learn progress')}`);
  lines.push('');
  return lines.join('\n');
}

/**
 * 知识点详情 — 纯文本渲染 + 源码预览，不依赖 AI。
 */
function formatTopicDetailRich(layer, topic, opts = {}) {
  // aiTeaching=true 表示有模型、将由 AI 讲解 —— 此时本地源码只是辅助，
  // 读不到就静默略过，不打扰；无模型(离线)时源码预览是主要内容，读不到给温和降级说明。
  const aiTeaching = opts.aiTeaching === true;
  const inner = _inner();
  const codeW = inner - 12;          // "    │ 1234 " = 12 chars prefix
  const lines = [];
  lines.push('');
  lines.push(`  ${T.sep('━━')} ${T.layerNum(`第 ${layer.id} 层`)} ${T.sep('·')} ${T.title(topic.title)} ${T.sep('━━')}`);
  for (const wl of _wrapLines(topic.desc, 2, inner)) {
    lines.push(`  ${T.summary(wl)}`);
  }
  lines.push('');

  if (topic.files && topic.files.length > 0) {
    // 本地源码是辅助资料：先分出可读/不可读，可读的正常预览，不可读的不再逐条刷
    // "(无法读取)" 噪音（这正是 pip 精简安装下"所有课程都显示无法读取"的根源）。
    const previews = topic.files.map(f => ({ file: f, preview: _readFilePreview(f) }));
    const readable = previews.filter(p => p.preview);
    const unreadableCount = previews.length - readable.length;

    if (readable.length > 0) {
      lines.push(`  ${T.header('关键源码')}`);
    }
    for (const { file, preview } of readable) {
      if (preview.type === 'dir') {
        lines.push(`    ${T.partial('▸')} ${T.filePath(file + '/')}  ${T.hint(`(${preview.total} 项)`)}`);
        preview.lines.forEach(l => lines.push(`      ${T.summary(l)}`));
      } else {
        const loc = preview.total > preview.lines.length
          ? `行 ${preview.startLine}-${preview.startLine + preview.lines.length - 1} / 共 ${preview.total} 行`
          : `${preview.total} 行`;
        lines.push(`    ${T.partial('▸')} ${T.filePath(file)}  ${T.hint(`(${loc})`)}`);
        lines.push(`    ${T.frame('┌' + '─'.repeat(Math.max(2, inner - 5)))}`);
        preview.lines.forEach((l, idx) => {
          const num = T.lineNum(String(preview.startLine + idx).padStart(4));
          const truncated = codeW > 0 && l.length > codeW ? l.slice(0, codeW - 1) + '…' : l;
          lines.push(`    ${T.frame('│')} ${num} ${T.code(truncated)}`);
        });
        if (preview.total > preview.startLine + preview.lines.length - 1) {
          lines.push(`    ${T.frame('│')} ${T.hint(`... (剩余 ${preview.total - preview.startLine - preview.lines.length + 1} 行)`)}`);
        }
        lines.push(`    ${T.frame('└' + '─'.repeat(Math.max(2, inner - 5)))}`);
      }
      lines.push('');
    }

    // 读不到的源码：不刷噪音，给一行温和说明（辅助资料缺失不阻断学习）
    if (unreadableCount > 0) {
      if (aiTeaching) {
        if (readable.length === 0) {
          lines.push(`  ${T.hint('（本环境无本地源码，下面由 AI 基于知识点讲解）')}`);
          lines.push('');
        }
      } else if (readable.length === 0) {
        lines.push(`  ${T.hint('本环境暂无本地源码可预览，已转为概念 + 自测模式。')}`);
        lines.push(`  ${T.hint('完整代码见源码版仓库；接入模型后可由 AI 直接讲解本知识点。')}`);
        lines.push('');
      } else {
        lines.push(`  ${T.hint(`（另有 ${unreadableCount} 个源码文件本环境不可读，已略过）`)}`);
        lines.push('');
      }
    }
  }

  // 导航
  const topicIdx = layer.topics.indexOf(topic);
  lines.push(`  ${T.header('导航')}`);
  if (topicIdx > 0) lines.push(`    ${T.nav(`learn ${layer.id}.${topicIdx}`)}     ${T.hint('上一个:')} ${T.summary(layer.topics[topicIdx - 1].title)}`);
  if (topicIdx < layer.topics.length - 1) lines.push(`    ${T.nav(`learn ${layer.id}.${topicIdx + 2}`)}     ${T.hint('下一个:')} ${T.summary(layer.topics[topicIdx + 1].title)}`);
  lines.push(`    ${T.nav(`learn done ${layer.id} ${topic.id}`)}   ${T.hint('标记完成')}`);
  lines.push(`    ${T.nav(`learn note ${layer.id} ${topic.id} <笔记>`)}   ${T.hint('添加笔记')}`);
  lines.push('');
  return lines.join('\n');
}

// ── AI 提示生成 ──────────────────────────────────────────────────────

// RAG grounding block — when learningRetrieval has surfaced real chunks from
// the KHY-OS knowledge base (mode 3), inject them so the model teaches from the
// actual code/docs instead of recalling files on its own (raises recall). The
// chunk text is PLAIN (no ANSI) — the terminal-colored version is rendered
// separately by learningRetrieval.formatSection for the offline modes. Empty
// ragContext → returns '' so every builder stays backward-compatible.
function _ragGroundingBlock(ragContext) {
  const ctx = ragContext == null ? '' : String(ragContext).trim();
  if (!ctx) return '';
  return `\n以下是从 KHY-OS 代码库（源码+文档+课程）检索到的相关材料，请优先据此讲解，不要臆造代码或行号：
${ctx}\n`;
}

// 零基础讲解指令块 —— 仅当学习者档位为 'beginner' 时追加（否则返回 ''，输出与默认字节一致）。
// 面向「三零」学员（不懂编程语言/不懂算法/不懂智能体概念），要求逐行解释语法 +「这门语言为什么
// 这样写」+ 算法直觉 + Agent 概念日常类比，并在结尾邀请学员一起「发现不足」（呼应 learn improve）。
function _beginnerBlock(level) {
  if (level !== 'beginner') return '';
  return `\n[零基础讲解模式 — 面向三零学员（不懂编程语言/不懂算法/不懂智能体概念）]
请在上面的讲解基础上，额外做到：
1. 先用一个生活化的比喻说明这段代码到底在做什么（先比喻，后术语）。
2. 逐行点出关键语法：这个关键字/运算符/语言特性是什么，以及"这门语言为什么要这样写"
   （例如：为什么用 async/await、为什么用 Map 而不是普通对象、为什么用 try/catch 做 fail-soft）。
3. 讲算法时给直觉、不堆术语，必要时用排队、查字典之类的日常类比。
4. 涉及 Agent/智能体概念时用日常类比解释（如"工具调用"=请人帮忙做一件具体的事）。
最后用一句话主动指出本段代码 1-2 个潜在不足或可改进点，邀请学员一起"发现不足"——
可以用 learn improve <你的发现> 记进改进清单（与 AI 一起完善 KHY）。`;
}

// 小模型/本地模型的紧凑零基础提示 —— 单句，保住「3-5 句话」本意，避免 prompt 膨胀。
function _beginnerBlockSimple(level) {
  if (level !== 'beginner') return '';
  return `\n[零基础] 先给一句生活比喻，再点出 1-2 个关键语法"为什么这样写"，避免术语。`;
}

// ── 面谈式提示（适合高能力模型） ─────────────────────────────────────

function buildLearningPrompt(layer, topic, opts = {}) {
  const fileList = topic.files.map(f => `  - ${f}`).join('\n');
  const memory = buildLearningMemoryContext();
  const rag = _ragGroundingBlock(opts.ragContext);
  return `[语言: 默认中文讲解，除非用户明确要求其他语言]

你是一位资深软件工程师，正在带一位同事走读 KHY OS 代码库。

当前层级: 第 ${layer.id} 层 — ${layer.title}
知识点: ${topic.title} — ${topic.desc}
${memory ? `\n${memory}\n` : ''}${rag}
参考源码（可选辅助，若能读到就结合代码讲）:
${fileList}

指导方式:
- 先用一两句话点明这个模块在系统里扮演什么角色、解决什么问题
- 若能读取上面的源码，挑出最能体现设计意图的 2-3 处代码，解释"为什么这样写"
- 用"数据怎么流"或"用户操作触发了什么调用链"来讲解
- 指出容易踩坑的地方和背后的工程权衡
- 给一个小实验让对方动手验证（改配置、加 log、写个小测试）
- 最后简短预告下一个知识点的关联

像两个工程师在白板前聊代码，不要写教案或编号列表。
重要：上面的源码文件只是辅助参考。若当前环境读不到这些文件（例如精简安装、无源码树），
就基于上面的知识点描述和你自己的工程知识把概念讲清楚——绝不要因为读不到文件而拒绝、
中断或只回一句"无法读取"。读得到就结合真实代码，读不到也要完整教学，但不要凭空编造具体代码行。${_beginnerBlock(opts.level)}`;
}

function buildLayerOverviewPrompt(layer, opts = {}) {
  const topicList = layer.topics.map((t, i) => `  ${i + 1}. ${t.title} — ${t.desc}`).join('\n');
  const memory = buildLearningMemoryContext();
  const rag = _ragGroundingBlock(opts.ragContext);
  return `[语言: 默认中文讲解，除非用户明确要求其他语言]

你是一位资深软件工程师，正在给一位新同事做项目导读。

对方刚进入第 ${layer.id} 层: ${layer.title}
概要: ${layer.summary}
${memory ? `\n${memory}\n` : ''}${rag}
本层知识点:
${topicList}

聊法:
- 先讲"为什么"——这层要解决什么问题，不存在会怎样
- 各知识点之间怎么串联——数据流或依赖关系
- 如果对方学过前面的层，和已学内容建立联系
- 学完这层能做什么（具体能力，不是虚的）
- 推荐从哪个知识点切入

像面谈一样自然交流。
对方可以说 "下一个" 或 "learn ${layer.id}.1" 进入具体知识点。${_beginnerBlock(opts.level)}`;
}

// ── 精简提示（适合小模型/本地模型） ──────────────────────────────────

function buildSimpleLayerPrompt(layer, opts = {}) {
  const topicList = layer.topics.map((t, i) => `${i + 1}. ${t.title}: ${t.desc}`).join('\n');
  const rag = _ragGroundingBlock(opts.ragContext);
  return `简要介绍 KHY OS 第 ${layer.id} 层「${layer.title}」。

${layer.summary}
${rag}
知识点:
${topicList}

用 3-5 句话概括本层重点和知识点之间的关系。默认中文，除非用户明确要求其他语言。${_beginnerBlockSimple(opts.level)}`;
}

function buildSimpleTopicPrompt(layer, topic, opts = {}) {
  const fileList = topic.files.map(f => `- ${f}`).join('\n');
  const rag = _ragGroundingBlock(opts.ragContext);
  return `解释 KHY OS 的「${topic.title}」模块。

描述: ${topic.desc}
层级: 第 ${layer.id} 层 — ${layer.title}
${rag}参考源码（可选）: ${fileList}

用 3-5 句话解释核心功能。能读到上面的文件就结合代码讲；读不到就基于描述讲清概念，
不要因为读不到文件而中断。默认中文，除非用户明确要求其他语言。${_beginnerBlockSimple(opts.level)}`;
}

function buildBugCasePrompt(bugCase) {
  const fileList = bugCase.files.map(f => `  - ${f}`).join('\n');
  const detailLine = bugCase.detailDoc ? `\n详细修复文档:\n  - ${bugCase.detailDoc}\n` : '';
  const memory = buildLearningMemoryContext();
  return `[LEARNING MODE — 第 10 层: 实战 Bug 修复案例]
[语言: 默认中文讲解，除非用户明确要求其他语言]

你是 KHY OS 的教学助手。当前进入实战 Bug 修复案例教学模式。
案例: ${bugCase.title}
严重等级: ${bugCase.severity}
标签: ${bugCase.tags.join(', ')}
${memory ? `\n${memory}\n` : ''}
症状描述:
${bugCase.symptom}

相关源码文件（可选辅助，读不到也能讲——本案例的根因/修复/经验已在下方给出）:
${fileList}
${detailLine}
教学要求（分步引导，不要一次性全给出）:
说明：下面提到的源码/文档若当前环境读不到（精简安装无源码树），不要中断或只回"无法读取"，
直接基于本提示已给出的症状/根因/修复/经验完整教学；能读到文件则结合真实代码更佳。

**第一步：现象还原**
- 用 2-3 句话描述用户遇到的问题表现
- 让用户思考：如果你遇到这个问题，你会从哪里开始排查？

**第二步：根因分析**
- 若能读到相关源码文件，展示导致 bug 的关键代码片段；读不到则基于下面的根因描述讲解
- 画出调用链 / 数据流，解释为什么这段代码会产生问题
- 根因: ${bugCase.rootCause}

**第三步：修复方案**
- 展示修复前后的代码对比 (before/after)
- 解释为什么这样修复，有没有其他方案
- 修复要点: ${bugCase.fix}

**第四步：举一反三**
- 这个 bug 属于哪类常见模式？在其他场景中如何防御？
- 经验总结: ${bugCase.lesson}

**第五步：小模型范例格式**
- 将此案例的排查过程整理为结构化的 input → reasoning → output 三元组
- 这个格式可以直接作为小模型的 few-shot 训练样本

参考范例:
  input: ${bugCase.example.input}
  reasoning: ${bugCase.example.reasoning}
  output: ${bugCase.example.output}

注意:
- 读取实际源码和修复文档讲解，不要凭空编造
- 默认中文讲解（除非用户明确要求其他语言），代码注释保持原样
- 重点是思维过程，不是最终答案 — 教用户"如何排查"而非"记住答案"
- 最后预告下一个案例（如有）`;
}

// ── CRUD 操作 ────────────────────────────────────────────────────────

function addLayer(title, summary) {
  const layers = _loadCurriculumJSON();
  const maxId = layers.reduce((m, l) => Math.max(m, l.id), -1);
  // ID 10 is reserved for the dynamic bug case layer
  const newId = maxId + 1 >= 10 ? maxId + 2 : maxId + 1;
  const newLayer = { id: newId, title, summary, topics: [] };
  layers.push(newLayer);
  _saveCurriculumJSON(layers);
  return newLayer;
}

function removeLayer(layerId) {
  const layers = _loadCurriculumJSON();
  const idx = layers.findIndex(l => l.id === layerId);
  if (idx === -1) return null;
  const removed = layers.splice(idx, 1)[0];
  _saveCurriculumJSON(layers);
  return removed;
}

function updateLayer(layerId, updates) {
  const layers = _loadCurriculumJSON();
  const layer = layers.find(l => l.id === layerId);
  if (!layer) return null;
  if (updates.title !== undefined) layer.title = updates.title;
  if (updates.summary !== undefined) layer.summary = updates.summary;
  _saveCurriculumJSON(layers);
  return layer;
}

function addTopic(layerId, topicId, title, desc, files) {
  const layers = _loadCurriculumJSON();
  const layer = layers.find(l => l.id === layerId);
  if (!layer) return null;
  if (layer.topics.find(t => t.id === topicId)) return { error: 'duplicate', topicId };
  const topic = { id: topicId, title, desc, files: files || [] };
  layer.topics.push(topic);
  _saveCurriculumJSON(layers);
  return topic;
}

function removeTopic(layerId, topicId) {
  const layers = _loadCurriculumJSON();
  const layer = layers.find(l => l.id === layerId);
  if (!layer) return null;
  const idx = layer.topics.findIndex(t => t.id === topicId);
  if (idx === -1) return null;
  const removed = layer.topics.splice(idx, 1)[0];
  _saveCurriculumJSON(layers);
  return removed;
}

function updateTopic(layerId, topicId, updates) {
  const layers = _loadCurriculumJSON();
  const layer = layers.find(l => l.id === layerId);
  if (!layer) return null;
  const topic = layer.topics.find(t => t.id === topicId);
  if (!topic) return null;
  if (updates.title !== undefined) topic.title = updates.title;
  if (updates.desc !== undefined) topic.desc = updates.desc;
  if (updates.files !== undefined) topic.files = updates.files;
  _saveCurriculumJSON(layers);
  return topic;
}

function moveTopic(fromLayerId, topicId, toLayerId, position) {
  const layers = _loadCurriculumJSON();
  const from = layers.find(l => l.id === fromLayerId);
  const to = layers.find(l => l.id === toLayerId);
  if (!from || !to) return null;
  const idx = from.topics.findIndex(t => t.id === topicId);
  if (idx === -1) return null;
  const [topic] = from.topics.splice(idx, 1);
  const insertAt = (position !== undefined && position >= 0) ? Math.min(position, to.topics.length) : to.topics.length;
  to.topics.splice(insertAt, 0, topic);
  _saveCurriculumJSON(layers);
  return topic;
}

// ── 文件引用校验 ─────────────────────────────────────────────────────

function checkFileReferences() {
  const LAYERS = getLayers();
  const results = { ok: [], missing: [], total: 0 };

  for (const layer of LAYERS) {
    for (const topic of layer.topics) {
      for (const filePath of topic.files) {
        results.total++;
        const abs = _resolveSourceAbs(filePath);
        if (abs) {
          results.ok.push({ layer: layer.id, topic: topic.id, file: filePath });
        } else {
          results.missing.push({ layer: layer.id, topic: topic.id, file: filePath });
        }
      }
    }
  }
  return results;
}

// ── 课程自动同步 ─────────────────────────────────────────────────────

const SCAN_RULES = [
  { dir: 'backend/src/cli/handlers',                glob: '*.js',           layer: 2, category: 'handler',  label: 'CLI Handler' },
  { dir: 'backend/src/services/gateway/adapters',    glob: '*Adapter.js',    layer: 3, category: 'adapter',  label: 'AI 适配器' },
  { dir: 'backend/src/tools',                        glob: '*/index.js',     layer: 4, category: 'tool',     label: '工具' },
  { dir: 'backend/src/services',                     glob: '*.js',           layer: 5, category: 'service',  label: '服务', maxDepth: 1 },
  { dir: 'backend/src/coordinator',                  glob: '*.js',           layer: 9, category: 'coord',    label: '协调器' },
  { dir: 'backend/src/skills/built-in',              glob: '*/prompt.md',    layer: 9, category: 'skill',    label: '技能' },
  { dir: 'frontend/src/views',                       glob: '*.vue',          layer: 8, category: 'view',     label: '前端视图' },
];

function _scanDir(dir, globPattern, maxDepth) {
  const absDir = _resolveSourceAbs(dir);
  if (!absDir) return [];

  const results = [];
  const parts = globPattern.split('/');

  if (parts.length === 2 && parts[0] === '*') {
    // Pattern: */index.js — scan subdirectories
    const entries = fs.readdirSync(absDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('_') || entry.name.startsWith('.')) continue;
      const target = path.join(absDir, entry.name, parts[1]);
      if (fs.existsSync(target)) {
        results.push(path.join(dir, entry.name, parts[1]));
      }
    }
  } else if (parts.length === 2 && parts[0] === '*' && parts[1].endsWith('.md')) {
    // Pattern: */prompt.md
    const entries = fs.readdirSync(absDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const target = path.join(absDir, entry.name, parts[1]);
      if (fs.existsSync(target)) {
        results.push(path.join(dir, entry.name, parts[1]));
      }
    }
  } else {
    // Simple glob: *.js, *Adapter.js, *.vue
    const ext = path.extname(globPattern);
    const prefix = globPattern.replace('*', '').replace(ext, '');
    const entries = fs.readdirSync(absDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (entry.name.startsWith('_') || entry.name.startsWith('.')) continue;
      if (!entry.name.endsWith(ext)) continue;
      if (prefix && !entry.name.endsWith(prefix + ext)) continue;
      results.push(path.join(dir, entry.name));
    }
  }

  return results;
}

function syncCurriculum() {
  const layers = _loadCurriculumJSON();
  const allRefs = new Set();
  for (const layer of layers) {
    for (const topic of layer.topics) {
      for (const f of topic.files) allRefs.add(f);
    }
  }
  // Also include bug case refs
  for (const c of BUG_CASES) {
    for (const f of c.files) allRefs.add(f);
    if (c.detailDoc) allRefs.add(c.detailDoc);
  }

  const report = { uncovered: [], stale: [], suggestions: [] };

  // Scan each rule
  for (const rule of SCAN_RULES) {
    const found = _scanDir(rule.dir, rule.glob, rule.maxDepth);
    for (const filePath of found) {
      if (!allRefs.has(filePath)) {
        report.uncovered.push({
          file: filePath,
          suggestedLayer: rule.layer,
          category: rule.category,
          label: rule.label,
        });
      }
    }
  }

  // Find stale references (files in curriculum that don't exist)
  const check = checkFileReferences();
  report.stale = check.missing;

  // Generate suggestions
  const byCat = {};
  for (const u of report.uncovered) {
    if (!byCat[u.category]) byCat[u.category] = [];
    byCat[u.category].push(u);
  }
  for (const [cat, items] of Object.entries(byCat)) {
    if (items.length >= 3) {
      report.suggestions.push({
        action: 'add-topic',
        layer: items[0].suggestedLayer,
        reason: `${items.length} 个新${items[0].label}未纳入课程`,
        files: items.map(i => i.file).slice(0, 5),
        count: items.length,
      });
    }
  }
  for (const s of report.stale) {
    report.suggestions.push({
      action: 'fix-ref',
      layer: s.layer,
      topic: s.topic,
      reason: `文件不存在: ${s.file}`,
      file: s.file,
    });
  }

  return report;
}

function buildSyncPrompt(report) {
  const lines = ['[CURRICULUM SYNC — 课程自动同步]'];
  lines.push('[语言: 默认中文，除非用户明确要求其他语言]');
  lines.push('');
  lines.push('你是 KHY OS 课程维护助手。以下是自动扫描发现的课程与代码的差异。');
  lines.push('请根据差异生成课程更新方案，输出可直接执行的 learn edit 命令。');
  lines.push('');

  if (report.stale.length > 0) {
    lines.push(`## 失效引用 (${report.stale.length} 个)`);
    for (const s of report.stale) {
      lines.push(`  ✗ 第 ${s.layer} 层 / ${s.topic}: ${s.file}`);
    }
    lines.push('  → 请检查文件是否被重命名/移动，生成 learn edit update-topic 命令修复');
    lines.push('');
  }

  if (report.uncovered.length > 0) {
    const byCat = {};
    for (const u of report.uncovered) {
      if (!byCat[u.category]) byCat[u.category] = [];
      byCat[u.category].push(u);
    }
    lines.push(`## 未纳入课程的文件 (${report.uncovered.length} 个)`);
    for (const [cat, items] of Object.entries(byCat)) {
      lines.push(`\n### ${items[0].label} (${items.length} 个, 建议层: ${items[0].suggestedLayer})`);
      for (const item of items.slice(0, 10)) {
        lines.push(`  + ${item.file}`);
      }
      if (items.length > 10) lines.push(`  ... 还有 ${items.length - 10} 个`);
    }
    lines.push('');
    lines.push('  → 判断哪些是核心文件值得加入课程，哪些是内部实现可忽略');
    lines.push('  → 对值得加入的，生成 learn edit add-topic 命令');
    lines.push('  → 可以批量归入现有知识点（扩展 files 列表），也可以新增知识点');
  }

  if (report.uncovered.length === 0 && report.stale.length === 0) {
    lines.push('课程与代码完全同步，无需更新。');
  }

  return lines.join('\n');
}

function formatSyncReport(report) {
  const lines = [];
  lines.push('');
  lines.push(`  ${T.title('课程同步检查')}`);
  lines.push(`  ${T.sep(_rule())}`);

  if (report.stale.length > 0) {
    lines.push('');
    lines.push(`  ${T.warn(`失效引用: ${report.stale.length} 个`)}`);
    for (const s of report.stale) {
      lines.push(`    ${T.warn('✗')} ${T.layerNum(`第 ${s.layer} 层`)} / ${chalk.white(s.topic)}: ${T.filePath(s.file)}`);
    }
  }

  if (report.uncovered.length > 0) {
    const byCat = {};
    for (const u of report.uncovered) {
      if (!byCat[u.category]) byCat[u.category] = [];
      byCat[u.category].push(u);
    }
    lines.push('');
    lines.push(`  ${T.partial(`未纳入课程: ${report.uncovered.length} 个文件`)}`);
    for (const [cat, items] of Object.entries(byCat)) {
      lines.push(`    ${chalk.bold.white(items[0].label)}: ${T.summary(`${items.length} 个`)} ${T.hint(`(建议层 ${items[0].suggestedLayer})`)}`);
      for (const i of items.slice(0, 3)) {
        lines.push(`      ${T.done('+')} ${T.filePath(i.file)}`);
      }
      if (items.length > 3) lines.push(`      ${T.hint(`... +${items.length - 3}`)}`);
    }
  }

  if (report.suggestions.length > 0) {
    lines.push('');
    lines.push(`  ${T.header(`建议操作: ${report.suggestions.length} 项`)}`);
    for (const s of report.suggestions) {
      if (s.action === 'fix-ref') {
        lines.push(`    ${T.warn('→')} ${T.warn('修复:')} ${T.layerNum(`第 ${s.layer} 层`)} / ${chalk.white(s.topic)} ${T.sep('—')} ${T.summary(s.reason)}`);
      } else {
        lines.push(`    ${T.done('→')} ${T.done('新增:')} ${T.layerNum(`第 ${s.layer} 层`)} ${T.sep('—')} ${T.summary(s.reason)}`);
      }
    }
  }

  if (report.uncovered.length === 0 && report.stale.length === 0) {
    lines.push('');
    lines.push(`  ${T.done('✓ 课程与代码完全同步')}`);
  }

  lines.push('');
  lines.push(`  ${T.hint('使用')} ${T.nav('"learn sync auto"')} ${T.hint('让 AI 自动生成更新方案')}`);
  lines.push('');
  return lines.join('\n');
}

// ── 格式化输出 ────────────────────────────────────────────────────────

// ── 修仙境界阶梯（成长路线）─────────────────────────────────────────
//
// 用「已通关层数」(一层内所有知识点都完成) 驱动段位，比裸 XP 更有里程碑感、
// 更适合零基础用户建立成长路标。阈值集中在 RANKS 单一真源，零硬编码散落。
//   凡人(白纸) → 练气 → 筑基 → 金丹 → 元婴 → 化神 → 大乘 → 大师(渡劫飞升)
const RANKS = [
  { level: 0, name: '凡人', alias: '白纸',   minLayers: 0 },
  { level: 1, name: '练气', alias: '',       minLayers: 1 },
  { level: 2, name: '筑基', alias: '',       minLayers: 3 },
  { level: 3, name: '金丹', alias: '',       minLayers: 5 },
  { level: 4, name: '元婴', alias: '',       minLayers: 7 },
  { level: 5, name: '化神', alias: '',       minLayers: 9 },
  { level: 6, name: '大乘', alias: '',       minLayers: 11 }, // 通关全部内容层
  { level: 7, name: '大师', alias: '渡劫飞升', minLayers: 12 }, // 全部层（含 Bug 层）
];

/**
 * 「地板层」视图：只保留随包确定性课程层（剔除动态覆盖层），且每层只保留地板知识点
 * （剔除动态注入的知识点）。段位/毕业线必须锚定地板，否则动态课程会改变「通关层数」
 * 分母、让「大师」毕业线漂移、甚至永远够不到。
 */
function _floorLayers() {
  return getLayers()
    .filter(l => !l._source)
    .map(l => (l.topics || []).some(t => t._dynamic)
      ? { ...l, topics: l.topics.filter(t => !t._dynamic) }
      : l);
}

/** 统计「已通关层数」= 该地板层所有地板知识点都在 completedTopics 里的层数 */
function countCompletedLayers(progress) {
  const p = progress || _loadProgress();
  const done = new Set(p.completedTopics || []);
  return _floorLayers().filter(
    l => l.topics.length > 0 && l.topics.every(t => done.has(`${l.id}:${t.id}`))
  ).length;
}

/**
 * 计算当前修仙境界。
 * @returns {{level,name,alias,completedLayers,next,layersToNext,inRankPct,isMaster,totalXP,streak}}
 */
function getRank(progress) {
  const p = progress || _loadProgress();
  const layers = countCompletedLayers(p);
  let cur = RANKS[0];
  for (const r of RANKS) { if (layers >= r.minLayers) cur = r; else break; }
  const idx = RANKS.indexOf(cur);
  const next = RANKS[idx + 1] || null;
  let layersToNext = 0;
  let inRankPct = 100;
  if (next) {
    layersToNext = Math.max(0, next.minLayers - layers);
    const span = next.minLayers - cur.minLayers;
    inRankPct = span > 0 ? Math.min(100, Math.round(((layers - cur.minLayers) / span) * 100)) : 100;
  }
  return {
    level: cur.level,
    name: cur.name,
    alias: cur.alias || '',
    completedLayers: layers,
    next: next ? next.name : null,
    layersToNext,
    inRankPct,
    isMaster: !next,
    totalXP: p.totalXP || 0,
    streak: (p.streak && p.streak.count) || 0,
  };
}

/** 渲染完整成长路线图（修仙阶梯 + 当前境界横幅 + 下一步鼓励） */
function formatRoadmap(progress) {
  const p = progress || _loadProgress();
  const totalLayers = _floorLayers().length;
  const rank = getRank(p);
  const completed = rank.completedLayers;
  const aliasOf = r => (r.alias ? `（${r.alias}）` : '');
  const lines = [];

  lines.push('');
  lines.push(`  ${T.title('KHY OS 修行之路')} ${T.sep('—')} ${T.hint('从白纸到大师')}`);
  lines.push(`  ${T.sep(_rule())}`);
  lines.push('');

  // 当前境界横幅
  const badge = rank.isMaster
    ? T.xp(`★ ${rank.name}${aliasOf(rank)} ★`)
    : T.xp(`${rank.name}${aliasOf(rank)}`);
  const streakTag = rank.streak >= 2 ? `   ${T.partial(`🔥 ${rank.streak} 天`)}` : '';
  lines.push(`  ${T.hint('当前境界:')} ${badge}   ${T.hint('已通关')} ${T.layerNum(`${completed}/${totalLayers}`)} ${T.hint('层')}   ${T.hint('经验')} ${T.xp(`${rank.totalXP} XP`)}${streakTag}`);
  lines.push('');

  // 阶梯：从高到低渲染（顶端=大师），当前境界高亮
  for (let i = RANKS.length - 1; i >= 0; i--) {
    const r = RANKS[i];
    const reached = completed >= r.minLayers;
    const isCurrent = r.level === rank.level;
    const mark = reached ? T.done('✓') : T.pending('○');
    const label = `Lv${r.level} ${r.name}${aliasOf(r)}`;
    const labelColored = isCurrent ? chalk.bold.white(label) : (reached ? T.done(label) : T.pending(label));
    const need = T.hint(`需通关 ${r.minLayers} 层`);
    const cursor = isCurrent ? T.xp('  ◄ 你在这里') : '';
    lines.push(`  ${mark} ${labelColored}  ${need}${cursor}`);
  }
  lines.push('');

  // 下一步鼓励
  if (rank.isMaster) {
    lines.push(`  ${T.done('🎉 渡劫飞升！你已通关全部课程，成为 KHY-OS 大师。')}`);
  } else {
    lines.push(`  ${T.partial(`⚡ 距「${rank.next}」还差 ${rank.layersToNext} 层（当前境界内进度 ${rank.inRankPct}%）`)}`);
    lines.push(`  ${T.hint('用 ')}${T.nav('learn next')}${T.hint(' 继续修行，每通关一层即可突破境界。')}`);
  }
  lines.push('');
  return lines.join('\n');
}

// ── 进度导出 / 导入（换电脑带得走）──────────────────────────────────

const PROGRESS_EXPORT_VERSION = 1;

/** 导出进度为可携带 JSON（带版本信封）。默认写到 ./khy-learning-progress.json */
function exportProgress(destPath) {
  const p = _loadProgress();
  const payload = {
    tool: 'khy-learn',
    type: 'learning-progress',
    version: PROGRESS_EXPORT_VERSION,
    exportedAt: new Date().toISOString(),
    progress: p,
  };
  const dest = destPath && String(destPath).trim()
    ? path.resolve(String(destPath).trim())
    : path.resolve(process.cwd(), 'khy-learning-progress.json');
  try {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, JSON.stringify(payload, null, 2), 'utf-8');
    return { ok: true, path: dest, completed: p.completedTopics.length, totalXP: p.totalXP };
  } catch (e) {
    return { ok: false, error: 'WRITE_FAILED', message: e.message, path: dest };
  }
}

/** 合并两份进度：completed/viewed 取并集，XP/层级/streak 取较大，notes 拼接 */
function _mergeProgress(base, incoming) {
  const out = _normalizeProgress(JSON.parse(JSON.stringify(base))) || _freshProgress();
  const inc = _normalizeProgress(incoming);
  if (!inc) return out;
  out.completedTopics = Array.from(new Set([...out.completedTopics, ...inc.completedTopics]));
  const completedSet = new Set(out.completedTopics);
  out.viewedTopics = Array.from(new Set([...out.viewedTopics, ...inc.viewedTopics]))
    .filter(k => !completedSet.has(k));
  out.totalXP = Math.max(out.totalXP, inc.totalXP);
  out.currentLayer = Math.max(out.currentLayer, inc.currentLayer);
  const baseStreak = (out.streak && out.streak.count) || 0;
  const incStreak = (inc.streak && inc.streak.count) || 0;
  if (incStreak > baseStreak) out.streak = inc.streak;
  if (inc.startedAt && (!out.startedAt || inc.startedAt < out.startedAt)) out.startedAt = inc.startedAt;
  if (inc.lastVisit && inc.lastVisit.at &&
      (!out.lastVisit || !out.lastVisit.at || inc.lastVisit.at > out.lastVisit.at)) {
    out.lastVisit = inc.lastVisit;
  }
  out.notes = out.notes || {};
  for (const [k, v] of Object.entries(inc.notes || {})) {
    if (!out.notes[k]) out.notes[k] = v;
    else if (out.notes[k] !== v) out.notes[k] = `${out.notes[k]}\n${v}`;
  }
  return out;
}

/**
 * 导入进度文件。默认合并（merge=true），merge=false 时整体覆盖。
 * 接受带信封 {progress} 或裸 progress 对象。失败返回结构化错误，绝不损坏现有进度。
 */
function importProgress(srcPath, opts = {}) {
  const merge = opts.merge !== false;
  const src = srcPath && String(srcPath).trim() ? path.resolve(String(srcPath).trim()) : '';
  if (!src) return { ok: false, error: 'NO_PATH', message: '未指定导入文件路径' };
  let raw;
  try {
    if (!fs.existsSync(src)) return { ok: false, error: 'NOT_FOUND', message: `文件不存在: ${src}`, path: src };
    raw = JSON.parse(fs.readFileSync(src, 'utf-8'));
  } catch (e) {
    return { ok: false, error: 'PARSE_FAILED', message: `无法解析 JSON: ${e.message}`, path: src };
  }
  const incoming = raw && raw.progress ? raw.progress : raw;
  const normalized = _normalizeProgress(incoming);
  if (!normalized) return { ok: false, error: 'INVALID_SCHEMA', message: '文件不是有效的学习进度数据', path: src };

  const before = _loadProgress();
  const result = merge
    ? _mergeProgress(before, normalized)
    : (_normalizeProgress(JSON.parse(JSON.stringify(normalized))) || _freshProgress());
  _saveProgress(result); // 内部已先轮转 .bak，安全
  return {
    ok: true,
    path: src,
    mode: merge ? 'merge' : 'replace',
    completedBefore: before.completedTopics.length,
    completedAfter: result.completedTopics.length,
    totalXP: result.totalXP,
  };
}

function formatProgressTable(progress) {
  const LAYERS = getLayers();
  const W = _inner();                              // 可用总宽
  const colId = 4;                                  // " 层 " 列
  const colBar = Math.max(16, Math.min(36, W - 30));// 进度条列 (自适应)
  const colTitle = Math.max(8, W - colId - colBar - 4); // 标题列 (扣除分隔符)
  const barLen = Math.max(6, colBar - 12);          // 进度条块数 (去掉 " 100% 0/0 ")

  const hRule = (l, m, r) => T.sep(l + '─'.repeat(colId) + m + '─'.repeat(colTitle) + m + '─'.repeat(colBar) + r);
  const lines = [];

  // 标题行
  const titleText = T.title('KHY OS 学习进度');
  const pad1 = Math.max(0, W - 20);
  lines.push(T.sep('╭─── ') + titleText + T.sep(' ' + '─'.repeat(Math.max(1, pad1 - 5)) + '╮'));

  // 汇总行
  const sumText = `  ${T.hint('总经验:')} ${T.xp(String(progress.totalXP).padEnd(6) + ' XP')}    ${T.hint('当前层级:')} ${T.layerNum('第 ' + progress.currentLayer + ' 层')}`;
  lines.push(T.sep('│') + sumText + ' '.repeat(Math.max(1, W - 40)) + T.sep('│'));

  // 境界行 — 当前修仙段位 + 连续学习天数
  const rank = getRank(progress);
  const rankBadge = `${rank.name}${rank.alias ? '（' + rank.alias + '）' : ''}`;
  const rankText = `  ${T.hint('当前境界:')} ${T.xp(rankBadge)}    ${T.hint('连续学习:')} ${T.partial(rank.streak + ' 天')}`;
  lines.push(T.sep('│') + rankText + ' '.repeat(Math.max(1, W - 40)) + T.sep('│'));

  lines.push(hRule('├', '┬', '┤'));
  lines.push(T.sep('│') + T.header(' 层 '.padEnd(colId)) + T.sep('│') + T.header(' 标题'.padEnd(colTitle)) + T.sep('│') + T.header(' 进度'.padEnd(colBar)) + T.sep('│'));
  lines.push(hRule('├', '┼', '┤'));

  for (const layer of LAYERS) {
    const total = layer.topics.length;
    const done = layer.topics.filter(t => progress.completedTopics.includes(`${layer.id}:${t.id}`)).length;
    const pct = total > 0 ? Math.round((done / total) * 100) : 0;
    const filled = Math.round((pct / 100) * barLen);
    const bar = T.bar('█'.repeat(filled)) + T.barBg('░'.repeat(barLen - filled));

    const idStr = T.layerNum(String(layer.id).padStart(2));
    const titleStr = chalk.white(layer.title.length > colTitle - 2 ? layer.title.slice(0, colTitle - 3) + '…' : layer.title.padEnd(colTitle - 2));
    const status = done === total ? T.done('✓') : T.summary(`${done}/${total}`);
    const pctStr = pct === 100 ? T.done(String(pct).padStart(3) + '%') : T.summary(String(pct).padStart(3) + '%');

    lines.push(`${T.sep('│')} ${idStr} ${T.sep('│')} ${titleStr} ${T.sep('│')} ${bar} ${pctStr} ${status} ${T.sep('│')}`);
  }

  lines.push(hRule('╰', '┴', '╯'));
  return lines.join('\n');
}

function formatLayerList() {
  const LAYERS = getLayers();
  const progress = _loadProgress();
  const inner = _inner();
  const lines = [];
  lines.push('');
  lines.push(`  ${T.title('KHY OS 学习路线图')} ${T.sep('—')} ${T.hint('从零到精通')}`);
  lines.push(`  ${T.sep(_rule())}`);
  lines.push('');
  for (const layer of LAYERS) {
    const total = layer.topics.length;
    const done = layer.topics.filter(t => progress.completedTopics.includes(`${layer.id}:${t.id}`)).length;
    const icon = done === total ? T.done('✓') : (done > 0 ? T.partial('▸') : T.pending('○'));
    const current = layer.id === progress.currentLayer ? T.xp(' ← 当前') : '';
    lines.push(`  ${icon} ${T.layerNum(`第 ${layer.id} 层`)}: ${chalk.bold.white(layer.title)} ${T.summary(`(${done}/${total})`)}${current}`);
    for (const wl of _wrapLines(layer.summary, 4, inner - 2)) {
      lines.push(`    ${T.summary(wl)}`);
    }
    lines.push('');
  }
  const hintText = '使用 "learn <层号>" 进入学习，"learn bugs" 浏览 Bug 案例，"learn progress" 查看详细进度';
  for (const wl of _wrapLines(hintText, 2, inner)) {
    lines.push(`  ${T.hint(wl)}`);
  }
  lines.push('');
  return lines.join('\n');
}

function formatBugCaseList() {
  const progress = _loadProgress();
  const inner = _inner();
  const symptomW = Math.max(20, inner - 5);
  const severityIcon = { critical: '🔴', high: '🟠', medium: '🟡' };
  const severityColor = { critical: chalk.red, high: chalk.hex('#FF8C00'), medium: chalk.yellow };
  const lines = [];
  lines.push('');
  lines.push(`  ${T.title('实战 Bug 修复案例')} ${T.sep('—')} ${T.layerNum('第 10 层')}`);
  lines.push(`  ${T.sep(_rule())}`);
  lines.push('');
  for (let i = 0; i < BUG_CASES.length; i++) {
    const c = BUG_CASES[i];
    const isDone = progress.completedTopics.includes(`10:${c.id}`);
    const mark = isDone ? T.done('✓') : T.pending('○');
    const icon = severityIcon[c.severity] || '○';
    const colorFn = severityColor[c.severity] || chalk.white;
    lines.push(`  ${mark} ${chalk.bold(`${i + 1}.`)} ${icon} ${chalk.bold.white(c.title)}  ${colorFn(`[${c.severity}]`)}`);
    lines.push(`     ${c.tags.map(t => T.tag(t)).join(T.hint(', '))}`);
    const symptomSnip = c.symptom.length > symptomW ? c.symptom.slice(0, symptomW - 1) + '…' : c.symptom;
    lines.push(`     ${T.summary(symptomSnip)}`);
    lines.push('');
  }
  lines.push(`  ${T.hint('使用')} ${T.nav('"learn 10.<序号>"')} ${T.hint('或')} ${T.nav('"learn bugs <id>"')} ${T.hint('进入具体案例')}`);
  lines.push(`  ${T.hint('使用')} ${T.nav('"learn bugs export"')} ${T.hint('导出小模型训练数据 (JSONL)')}`);
  lines.push('');
  return lines.join('\n');
}

module.exports = {
  getLayers,
  getLayer,
  getAllLayers,
  getProgress,
  markTopicCompleted,
  markTopicViewed,
  getNudge,
  addNote,
  resetProgress,
  getNextTopic,
  findByQuery,
  buildLearningPrompt,
  buildLayerOverviewPrompt,
  buildSimpleLayerPrompt,
  buildSimpleTopicPrompt,
  buildBugCasePrompt,
  buildLearningMemoryContext,
  formatLayerOverviewRich,
  formatTopicDetailRich,
  formatProgressTable,
  formatLayerList,
  formatBugCaseList,
  // 成长路线（修仙境界）+ 进度携带
  RANKS,
  countCompletedLayers,
  getRank,
  formatRoadmap,
  exportProgress,
  importProgress,
  exportBugCasesForTraining,
  getBugCase,
  searchBugCases,
  // CRUD
  addLayer,
  removeLayer,
  updateLayer,
  addTopic,
  removeTopic,
  updateTopic,
  moveTopic,
  // integrity
  checkFileReferences,
  syncCurriculum,
  buildSyncPrompt,
  formatSyncReport,
  // filesystem helpers reused by learningRetrieval (single source for the
  // PROJECT_ROOT walk + old→new path remaps; no second copy of that logic).
  PROJECT_ROOT,
  resolveSourceAbs: _resolveSourceAbs,
  readFilePreview: _readFilePreview,
  scanDir: _scanDir,
  // for tests
  get LAYERS() { return getLayers(); },
};
