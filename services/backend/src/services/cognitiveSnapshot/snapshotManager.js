'use strict';

/**
 * snapshotManager.js — 状态快照与热插拔接力（§3.3）。
 *
 * 每个 Agent 步骤执行完毕，把「当前进度 + 压缩后的记忆」融合成一张**极简快照**并原子
 * 落盘。快照是任务的唯一真源状态机——上下文窗口只是短期工作台，可随时被压缩/截断，但
 * 快照在盘上，新会话据此**零误差热启**。
 *
 * 快照必含七要素（§3.3）：
 *   taskId          全局任务 ID
 *   step            当前步数
 *   ultimateGoal    终极目标（永不删除的指南针）
 *   compressedHistory 压缩后的历史流（来自 compressionEngine）
 *   nextInstruction 下一步具体指令
 *   offloadPointers 外部卸载指针集
 *   retryCount      当前错误重试计数
 *
 * 复用 `utils/dataHome.getProjectDataDir` 分桶持久化（与 sessionPersistence 一致），
 * 原子 tmp+fsync+rename 落盘。这是对既有 `canonicalState`（6 维、无跨会话热启）的**扩展
 * 而非复制**：补齐 taskId/step/nextInstruction/offloadPointers/retryCount 五个缺字段，
 * 并真正接上 hotStart 自动注入。
 */

const fs = require('fs');
const path = require('path');

const SNAPSHOT_VERSION = 1;
const STATUS = Object.freeze({ ACTIVE: 'active', DONE: 'done', EMERGENCY: 'emergency' });

function _dir() {
  try {
    const { getProjectDataDir } = require('../../utils/dataHome');
    return getProjectDataDir('cognitive_snapshots');
  } catch {
    const os = require('os');
    return path.join(os.tmpdir(), 'khy-cognitive-snapshots');
  }
}

const _safe = require('../../utils/slugifyToken'); // 文件名安全化单一真源

function _file(taskId) {
  return path.join(_dir(), `${_safe(taskId)}.json`);
}

function _stamp() { try { return Date.now(); } catch { return 0; } }

/**
 * 构建一张快照对象（不落盘）。缺失终极目标即抛——指南针不可空（防呆⑥ 的前提）。
 * @param {object} input 见 §3.3 七要素 + 可选 entities/lessons/notes/model/workspace
 * @returns {object} snapshot
 */
function build(input = {}) {
  if (!input.taskId) throw new Error('snapshot.build: taskId 必填（全局任务 ID）');
  if (!input.ultimateGoal) throw new Error('snapshot.build: ultimateGoal 必填（永不删除的指南针）');
  return {
    version: SNAPSHOT_VERSION,
    status: input.status || STATUS.ACTIVE,
    timestamp: _stamp(),
    taskId: String(input.taskId),
    step: Number.isFinite(input.step) ? input.step : 0,
    ultimateGoal: String(input.ultimateGoal),       // 指南针：永不删除
    compressedHistory: input.compressedHistory || [],
    nextInstruction: input.nextInstruction || '',
    offloadPointers: Array.isArray(input.offloadPointers) ? input.offloadPointers : [],
    retryCount: Number.isFinite(input.retryCount) ? input.retryCount : 0,
    // 骨相保底（防呆③在快照层的镜像）：实体与错误教训随快照常驻。
    entities: Array.isArray(input.entities) ? input.entities : [],
    lessons: Array.isArray(input.lessons) ? input.lessons : [],
    constraints: {
      model: input.model || process.env.KHY_MODEL || 'unknown',
      workspace: input.workspace || process.cwd(),
      notes: input.notes || '',
    },
  };
}

/**
 * 原子落盘。返回是否成功——上层据此判定「无快照步骤视为无效」（防呆②）。
 * @returns {{ok:boolean, file?:string, error?:string}}
 */
function persist(snapshot) {
  try {
    if (!snapshot || !snapshot.taskId) return { ok: false, error: 'missing taskId' };
    const dir = _dir();
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const file = _file(snapshot.taskId);
    const tmp = `${file}.tmp-${process.pid}`;
    const fd = fs.openSync(tmp, 'w');
    try {
      fs.writeFileSync(fd, JSON.stringify(snapshot, null, 2));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, file);
    return { ok: true, file };
  } catch (e) {
    return { ok: false, error: e && e.message ? e.message : String(e) };
  }
}

/** 读取快照（缺失/损坏 → null，绝不抛）。 */
function load(taskId) {
  try {
    const file = _file(taskId);
    if (!fs.existsSync(file)) return null;
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch {
    return null;
  }
}

/** 标记任务完成——hotStart 会跳过已完成快照，不再热启。 */
function markComplete(taskId) {
  const s = load(taskId);
  if (!s) return { ok: false, error: 'not found' };
  s.status = STATUS.DONE;
  s.timestamp = _stamp();
  return persist(s);
}

/**
 * 跨会话热启（§3.4 + 防呆⑥）：检测到未完成快照即自动解压注入，**绝不要求用户复述**。
 * @param {string} taskId
 * @returns {{found:boolean, resumable:boolean, snapshot?:object, injectionPrompt?:string, reason?:string}}
 */
function hotStart(taskId) {
  const snapshot = load(taskId);
  if (!snapshot) return { found: false, resumable: false, reason: 'no snapshot' };
  if (snapshot.status === STATUS.DONE) {
    return { found: true, resumable: false, snapshot, reason: 'task already done' };
  }
  return {
    found: true,
    resumable: true,
    snapshot,
    injectionPrompt: formatInjection(snapshot),
  };
}

/**
 * 把快照渲染为「跳过寒暄、直接接力」的注入提示（§3.4 跨会话热启）。系统据此全自动注入
 * 状态，模型从断点指令继续——不询问、不复述（防呆⑥）。
 */
function formatInjection(snapshot) {
  if (!snapshot) return '';
  const p = [];
  p.push('[SESSION HOT-START — 检测到未完成任务快照，跳过寒暄，直接从断点接力]');
  p.push(`## 终极目标（指南针，永不偏离）\n${snapshot.ultimateGoal}`);
  p.push(`## 进度\n任务 ${snapshot.taskId} · 已到第 ${snapshot.step} 步 · 重试计数 ${snapshot.retryCount}`);
  if (snapshot.lessons && snapshot.lessons.length) {
    p.push(`## 错误教训（务必规避）\n${snapshot.lessons.map((l) => `- ${l}`).join('\n')}`);
  }
  if (snapshot.entities && snapshot.entities.length) {
    p.push(`## 核心实体状态\n${snapshot.entities.map((e) => `- ${e}`).join('\n')}`);
  }
  if (snapshot.compressedHistory && snapshot.compressedHistory.length) {
    p.push(`## 压缩历史流\n\`\`\`json\n${_trunc(JSON.stringify(snapshot.compressedHistory), 2000)}\n\`\`\``);
  }
  if (snapshot.offloadPointers && snapshot.offloadPointers.length) {
    p.push(`## 外部卸载指针（需要时按 ref 回读）\n${snapshot.offloadPointers.map((r) => `- ${typeof r === 'string' ? r : r.ref}`).join('\n')}`);
  }
  p.push(`## 下一步具体指令（从此处继续）\n${snapshot.nextInstruction || '（无显式指令——依终极目标推进下一步）'}`);
  return p.join('\n\n');
}

function _trunc(s, n) {
  s = String(s || '');
  return s.length > n ? s.slice(0, n) + '…' : s;
}

module.exports = {
  SNAPSHOT_VERSION,
  STATUS,
  build,
  persist,
  load,
  markComplete,
  hotStart,
  formatInjection,
};
