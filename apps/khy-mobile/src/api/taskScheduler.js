// khy.taskScheduler：本地任务调度（仿 ClawMobile tasks 概念）。
//
// 任务 = { id, name, prompt, provider, baseUrl, model, schedule, status, lastRunAt, lastResult, history }
// schedule: 'once' | { kind: 'interval', minutes: 30 } | { kind: 'cron', expr: '0 9 * * *' }
//   简化版：先实现 once + interval（分钟级）。
// status: 'idle' | 'running' | 'paused' | 'done' | 'failed' | 'disabled'
//
// 执行流程：runTaskOnce -> 调对应 provider 拿到回复 -> 写 history -> 通知订阅者。
// 后端同步（可选）：tryBackendSync() 探活，如果 /api/tasks 存在就 POST 增量。
// 红线 3：不设硬超时；每个任务单跑最多 5 分钟（足够 LLM 响应），由调用方 AbortController 取消。

import { Preferences } from '@capacitor/preferences';
import { streamChatCompletion } from './standalone';
import { getStandaloneApiKey } from './standalone';

const KEY = 'khy_tasks_v1';
const HISTORY_KEY = 'khy_task_history_v1';
const listeners = new Set();
let pollTimer = null;
let loaded = false;
let cache = [];

function notify() {
  for (const fn of listeners) {
    try { fn(cache); } catch (e) { /* ignore */ }
  }
}

function nextRunAt(task, now = Date.now()) {
  if (task.status === 'paused' || task.status === 'disabled') return null;
  if (!task.schedule || task.schedule === 'once') {
    if (task.status === 'done' || task.status === 'running') return null;
    return task.nextRunAt || now;
  }
  if (task.schedule.kind === 'interval') {
    const minutes = Math.max(1, task.schedule.minutes || 30);
    const last = task.lastRunAt || (task.createdAt || now);
    return last + minutes * 60 * 1000;
  }
  return null;
}

async function load() {
  const { value } = await Preferences.get({ key: KEY });
  cache = value ? JSON.parse(value) : [];
  loaded = true;
  return cache;
}

async function persist() {
  await Preferences.set({ key: KEY, value: JSON.stringify(cache) });
}

export async function listTasks() {
  if (!loaded) await load();
  return cache.slice();
}

export async function getTask(id) {
  if (!loaded) await load();
  return cache.find((t) => t.id === id) || null;
}

export async function upsertTask(task) {
  if (!loaded) await load();
  const now = Date.now();
  const existing = cache.findIndex((t) => t.id === task.id);
  const next = { ...task, updatedAt: now };
  if (existing >= 0) cache[existing] = { ...cache[existing], ...next };
  else cache.push({ ...next, createdAt: now, history: [], status: next.status || 'idle' });
  await persist();
  notify();
  return next;
}

export async function removeTask(id) {
  if (!loaded) await load();
  cache = cache.filter((t) => t.id !== id);
  await persist();
  notify();
}

export async function clearHistory(id) {
  if (!loaded) await load();
  const t = cache.find((x) => x.id === id);
  if (!t) return;
  t.history = [];
  t.lastResult = null;
  await persist();
  notify();
}

export async function setTaskStatus(id, status) {
  if (!loaded) await load();
  const t = cache.find((x) => x.id === id);
  if (!t) return;
  t.status = status;
  t.updatedAt = Date.now();
  await persist();
  notify();
}

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

async function runTaskOnce(task, { signal } = {}) {
  const provider = task.provider || 'openai';
  const apiKey = await getStandaloneApiKey(provider).catch(() => null);
  if (!apiKey) throw new Error('该任务对应的 provider 未配置 API Key');
  const providerConfig = (await import('./standalone.js')).standaloneProviders()
    .find((p) => p.id === provider);
  const baseUrl = task.baseUrl || providerConfig?.baseUrl;
  if (!baseUrl) throw new Error('该任务未配置 baseUrl');
  let acc = '';
  await streamChatCompletion({
    baseUrl,
    apiKey,
    model: task.model || providerConfig?.models?.[0] || 'gpt-4o-mini',
    messages: [{ role: 'user', content: task.prompt }],
    signal,
    onChunk: (chunk) => { acc += chunk; },
    onDone: () => {},
  });
  return acc;
}

export async function triggerTask(id) {
  const t = await getTask(id);
  if (!t) return;
  if (t.status === 'running') return;
  await setTaskStatus(id, 'running');
  const controller = new AbortController();
  t._controller = controller;
  const startedAt = Date.now();
  let result = '';
  let error = null;
  try {
    result = await runTaskOnce(t, { signal: controller.signal });
  } catch (cause) {
    if (cause.name !== 'AbortError') error = cause.message || String(cause);
  } finally {
    t._controller = null;
  }
  const finishedAt = Date.now();
  t.history = (t.history || []).concat([{ startedAt, finishedAt, result, error }]).slice(-50);
  t.lastRunAt = finishedAt;
  t.lastResult = error ? null : result.slice(0, 500);
  if (error) t.status = 'failed';
  else if (t.schedule === 'once' || (t.schedule && t.schedule.kind === undefined)) t.status = 'done';
  else t.status = 'idle';
  await persist();
  notify();
}

async function tick() {
  if (!loaded) await load();
  const now = Date.now();
  for (const t of cache) {
    if (t.status === 'paused' || t.status === 'disabled' || t.status === 'running' || t.status === 'done') continue;
    if (!t.schedule) continue;
    const at = nextRunAt(t, now);
    if (at && at <= now) triggerTask(t.id).catch(() => {});
  }
  // 每轮 tick 也尝试云端同步（5min 一次，节流在调度器启动时设）
  if (!lastSyncAt || Date.now() - lastSyncAt > 5 * 60 * 1000) {
    tryBackendSync().catch(() => {});
  }
}

let lastSyncAt = 0;

export async function startScheduler() {
  if (!loaded) await load();
  if (pollTimer) return;
  pollTimer = setInterval(() => { tick().catch(() => {}); }, 30 * 1000);
  // 启动后立刻跑一次 tick，让刚到点的任务不被卡 30s
  tick().catch(() => {});
}

export function stopScheduler() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

// 后端同步：探测 + 双向增量
// 流程：probe → 拉 since=lastServerSyncedAt → 合并本地 → 推本地全量 → 记录 lastSyncedAt
// 任何一步失败静默（不影响本地调度）
const SYNC_AT_KEY = 'khy_tasks_last_server_sync_v1';

export async function tryBackendSync() {
  if (!loaded) await load();
  try {
    const { loadRuntime } = await import('./runtime.js');
    const rt = await loadRuntime();
    if (!rt?.apiBaseUrl) return { skipped: true, reason: 'no remote' };
    const base = rt.apiBaseUrl.replace(/\/+$/, '');

    // 1) 探测
    let probe;
    try {
      const { apiFetch } = await import('./client.js');
      probe = await apiFetch('/api/tasks/probe', { auth: true, retryAuth: false });
    } catch (cause) {
      return { skipped: true, reason: 'probe failed: ' + (cause.message || cause) };
    }
    if (!probe?.success) return { skipped: true, reason: 'probe not supported' };

    // 2) 读上次同步时间戳
    const { Preferences } = await import('@capacitor/preferences');
    const { value: sinceStr } = await Preferences.get({ key: SYNC_AT_KEY });
    const since = Number(sinceStr) || 0;

    // 3) 拉取增量
    const { apiFetch } = await import('./client.js');
    const url = since ? `/api/tasks?since=${since}` : '/api/tasks';
    const pull = await apiFetch(url, { auth: true, retryAuth: false });
    const remoteTasks = Array.isArray(pull?.data?.tasks) ? pull.data.tasks : [];
    const serverUpdatedAt = Number(pull?.data?.serverUpdatedAt) || Date.now();

    // 4) 合并：以 id 为键，本地优先 + 远端补缺
    const map = new Map(cache.map((t) => [t.id, t]));
    for (const rt of remoteTasks) {
      const local = map.get(rt.id);
      // 远端 updatedAt 较新就覆盖（多设备编辑合并：last-write-wins）
      if (!local || Number(rt.updatedAt || 0) >= Number(local.updatedAt || 0)) {
        map.set(rt.id, { ...local, ...rt });
      }
    }
    const merged = Array.from(map.values());
    cache = merged;
    await persist();
    notify();

    // 5) 推本地全量（包含刚合并后的）
    const payload = cache.map((t) => ({
      id: t.id, name: t.name, prompt: t.prompt, provider: t.provider, model: t.model,
      schedule: t.schedule, status: t.status, lastRunAt: t.lastRunAt, lastResult: t.lastResult,
      history: t.history, updatedAt: t.updatedAt, createdAt: t.createdAt,
    }));
    await apiFetch('/api/tasks', {
      method: 'POST', auth: true, retryAuth: false,
      body: JSON.stringify({ tasks: payload }),
    });

    // 6) 记录同步时间
    await Preferences.set({ key: SYNC_AT_KEY, value: String(serverUpdatedAt) });
    return { synced: true, remote: remoteTasks.length, local: cache.length };
  } catch (cause) {
    return { skipped: true, reason: cause.message || String(cause) };
  }
}
