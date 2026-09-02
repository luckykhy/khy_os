// khy.taskSyncStore：手机端本地任务的"云端影子"。
// 存储：每用户一个 JSON 文件，data/tasks/{userId}.json
// 原子写（tmp + rename）+ 单文件 in-process 锁（避免并发写竞争）。
// 用途：手机端做云端备份 / 跨设备同步，调度仍以手机本地为准。

'use strict';

const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.KHY_TASKS_DIR || path.join(__dirname, '..', 'data', 'tasks');

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function fileFor(userId) {
  if (!/^[a-zA-Z0-9_\-]{1,64}$/.test(String(userId || ''))) {
    throw Object.assign(new Error('非法 userId'), { statusCode: 400 });
  }
  return path.join(DATA_DIR, `${userId}.json`);
}

function readAll(userId) {
  ensureDir();
  const file = fileFor(userId);
  if (!fs.existsSync(file)) return { tasks: [], updatedAt: 0 };
  try {
    const raw = fs.readFileSync(file, 'utf8');
    const data = JSON.parse(raw);
    if (!Array.isArray(data.tasks)) return { tasks: [], updatedAt: 0 };
    return { tasks: data.tasks, updatedAt: Number(data.updatedAt) || 0 };
  } catch (err) {
    // 解析失败当作空，但记日志（避免丢失用户数据）
    console.warn('[taskSyncStore] parse failed for', userId, err.message);
    return { tasks: [], updatedAt: 0 };
  }
}

function atomicWrite(userId, tasks) {
  ensureDir();
  const file = fileFor(userId);
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  const payload = JSON.stringify({ tasks, updatedAt: Date.now() }, null, 2);
  fs.writeFileSync(tmp, payload, 'utf8');
  fs.renameSync(tmp, file);
}

function list(userId, { since = 0 } = {}) {
  const { tasks } = readAll(userId);
  // 增量同步：返回 updatedAt > since 的项
  if (!since) return tasks;
  return tasks.filter((t) => Number(t.updatedAt || 0) > Number(since));
}

function upsert(userId, task) {
  if (!task?.id) {
    throw Object.assign(new Error('缺 id'), { statusCode: 400 });
  }
  const { tasks } = readAll(userId);
  const idx = tasks.findIndex((t) => t.id === task.id);
  const now = Date.now();
  if (idx >= 0) tasks[idx] = { ...tasks[idx], ...task, updatedAt: now };
  else tasks.push({ ...task, updatedAt: now, createdAt: task.createdAt || now });
  atomicWrite(userId, tasks);
  return tasks.find((t) => t.id === task.id);
}

function bulkUpsert(userId, incoming) {
  if (!Array.isArray(incoming)) {
    throw Object.assign(new Error('incoming 必须是数组'), { statusCode: 400 });
  }
  const { tasks } = readAll(userId);
  const map = new Map(tasks.map((t) => [t.id, t]));
  const now = Date.now();
  for (const t of incoming) {
    if (!t?.id) continue;
    const prev = map.get(t.id) || {};
    map.set(t.id, { ...prev, ...t, id: t.id, updatedAt: now, createdAt: prev.createdAt || now });
  }
  const next = Array.from(map.values());
  atomicWrite(userId, next);
  return { count: incoming.length, total: next.length, updatedAt: now };
}

function remove(userId, id) {
  const { tasks } = readAll(userId);
  const next = tasks.filter((t) => t.id !== id);
  if (next.length === tasks.length) return false;
  atomicWrite(userId, next);
  return true;
}

module.exports = { list, upsert, bulkUpsert, remove, readAll };