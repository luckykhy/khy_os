/**
 * Task Board — SQLite-backed shared task list for coordinator & workers.
 *
 * 借鉴 Hermes Agent kanban_db.py:
 * - SQLite WAL + BEGIN IMMEDIATE 实现 CAS 原子认领
 * - 7 状态 Kanban 状态机: triage → todo → ready → running → blocked/done → archived
 * - 父子任务链 (parent_id) + 依赖检查
 * - claim_lock + claim_expires 防止僵尸认领
 * - consecutive_failures + max_retries → dead_letter
 *
 * 保持文件级 API 向后兼容，底层从 JSON 文件迁移到 SQLite。
 */
'use strict';

const path = require('path');
const crypto = require('crypto');

// ── State Constants ──

const STATUS = Object.freeze({
  TRIAGE: 'triage',
  TODO: 'todo',
  READY: 'ready',
  RUNNING: 'running',
  BLOCKED: 'blocked',
  DONE: 'done',
  ARCHIVED: 'archived',
  // Legacy compat
  PENDING: 'pending',
  CLAIMED: 'claimed',
  COMPLETED: 'completed',
  FAILED: 'failed',
});

// Legacy status → canonical status mapping
const LEGACY_TO_CANONICAL = {
  pending: STATUS.READY,
  claimed: STATUS.RUNNING,
  completed: STATUS.DONE,
  failed: STATUS.BLOCKED,
};

const CANONICAL_TO_LEGACY = {
  [STATUS.TRIAGE]: 'pending',
  [STATUS.TODO]: 'pending',
  [STATUS.READY]: 'pending',
  [STATUS.RUNNING]: 'claimed',
  [STATUS.BLOCKED]: 'failed',
  [STATUS.DONE]: 'completed',
  [STATUS.ARCHIVED]: 'completed',
};

const DEFAULT_CLAIM_TTL_MS = 300_000; // 5 分钟认领过期
const DEFAULT_MAX_RETRIES = 3;

let _db = null;
let _stmts = {};
let _available = false;

// ── Database ──

function _dbPath() {
  try {
    const { getDataDir } = require('../utils/dataHome');
    return path.join(getDataDir(), 'taskboard.db');
  } catch {
    const os = require('os');
    const dir = path.join(os.homedir(), '.khyquant');
    const fs = require('fs');
    try { fs.mkdirSync(dir, { recursive: true }); } catch { /* ok */ }
    return path.join(dir, 'taskboard.db');
  }
}

function _initDb() {
  if (_db) return _available;

  let Database;
  try {
    Database = require('better-sqlite3');
  } catch {
    _available = false;
    return false;
  }

  try {
    _db = new Database(_dbPath());
    _db.pragma('journal_mode = WAL');
    _db.pragma('synchronous = NORMAL');

    _db.exec(`
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL DEFAULT '',
        description TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'ready',
        assignee TEXT,
        priority TEXT NOT NULL DEFAULT 'medium',
        parent_id TEXT,
        dependencies TEXT DEFAULT '[]',
        claim_lock TEXT,
        claim_expires REAL,
        consecutive_failures INTEGER DEFAULT 0,
        max_retries INTEGER DEFAULT ${DEFAULT_MAX_RETRIES},
        result TEXT,
        skills TEXT DEFAULT '[]',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        completed_at INTEGER,
        started_at INTEGER,
        FOREIGN KEY (parent_id) REFERENCES tasks(id)
      );

      CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
      CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(parent_id);
      CREATE INDEX IF NOT EXISTS idx_tasks_assignee ON tasks(assignee);

      CREATE TABLE IF NOT EXISTS task_runs (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        agent TEXT,
        started_at INTEGER,
        finished_at INTEGER,
        result TEXT,
        FOREIGN KEY (task_id) REFERENCES tasks(id)
      );
    `);

    // Prepare statements
    _stmts.insert = _db.prepare(`
      INSERT INTO tasks (id, title, description, status, assignee, priority, parent_id,
                         dependencies, max_retries, skills, created_at, updated_at)
      VALUES (@id, @title, @description, @status, @assignee, @priority, @parentId,
              @dependencies, @maxRetries, @skills, @createdAt, @updatedAt)
    `);

    _stmts.get = _db.prepare('SELECT * FROM tasks WHERE id = ?');

    _stmts.update = _db.prepare(`
      UPDATE tasks SET title=@title, description=@description, status=@status,
        assignee=@assignee, priority=@priority, dependencies=@dependencies,
        result=@result, updated_at=@updatedAt, completed_at=@completedAt,
        started_at=@startedAt, claim_lock=@claimLock, claim_expires=@claimExpires,
        consecutive_failures=@consecutiveFailures
      WHERE id = @id
    `);

    // CAS 认领: BEGIN IMMEDIATE + WHERE status='ready' AND claim_lock IS NULL
    _stmts.claim = _db.prepare(`
      UPDATE tasks
      SET status='running', claim_lock=@claimLock, claim_expires=@claimExpires,
          assignee=@assignee, started_at=COALESCE(started_at, @now), updated_at=@now
      WHERE id=@id AND status='ready' AND claim_lock IS NULL
    `);

    _stmts.insertRun = _db.prepare(`
      INSERT INTO task_runs (id, task_id, agent, started_at) VALUES (@id, @taskId, @agent, @startedAt)
    `);

    _stmts.list = _db.prepare('SELECT * FROM tasks ORDER BY priority ASC, created_at ASC');
    _stmts.listByStatus = _db.prepare('SELECT * FROM tasks WHERE status = ? ORDER BY priority ASC, created_at ASC');
    _stmts.listByAssignee = _db.prepare('SELECT * FROM tasks WHERE assignee = ? ORDER BY priority ASC, created_at ASC');
    _stmts.listByParent = _db.prepare('SELECT * FROM tasks WHERE parent_id = ? ORDER BY created_at ASC');

    _stmts.cleanOld = _db.prepare(`
      DELETE FROM tasks WHERE status IN ('done','archived') AND completed_at < ?
    `);

    _stmts.expireStaleClaims = _db.prepare(`
      UPDATE tasks SET status='ready', claim_lock=NULL, claim_expires=NULL,
        consecutive_failures=consecutive_failures+1, updated_at=?
      WHERE status='running' AND claim_expires IS NOT NULL AND claim_expires < ?
    `);

    _stmts.deadLetter = _db.prepare(`
      UPDATE tasks SET status='blocked', updated_at=?
      WHERE status='ready' AND consecutive_failures >= max_retries
    `);

    _available = true;
  } catch {
    _db = null;
    _available = false;
  }

  return _available;
}

function _newId() {
  return 't_' + crypto.randomBytes(8).toString('hex');
}

function _parseJson(str, fallback) {
  try { return JSON.parse(str); } catch { return fallback; }
}

function _toRecord(row) {
  if (!row) return null;
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    status: row.status,
    assignee: row.assignee,
    priority: row.priority,
    parentId: row.parent_id,
    dependencies: _parseJson(row.dependencies, []),
    claimLock: row.claim_lock,
    claimExpires: row.claim_expires,
    consecutiveFailures: row.consecutive_failures,
    maxRetries: row.max_retries,
    result: row.result,
    skills: _parseJson(row.skills, []),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
    startedAt: row.started_at,
  };
}

// ── CRUD Operations ──

/**
 * Create a new task.
 * @param {object} task
 * @param {string} task.description
 * @param {string} [task.title]
 * @param {string} [task.assignee]
 * @param {string[]} [task.dependencies] - IDs of tasks that must complete first
 * @param {string} [task.priority] - low/medium/high
 * @param {string} [task.parentId] - Parent task ID
 * @param {string} [task.status] - Initial status (default: ready)
 * @returns {object} Created task with id
 */
function createTask(task) {
  if (!_initDb()) {
    // Fallback: 文件模式 (向后兼容)
    return _createTaskFile(task);
  }

  const id = _newId();
  const now = Date.now();
  // 将 legacy 'pending' 映射为 'ready'
  const status = LEGACY_TO_CANONICAL[task.status] || task.status || STATUS.READY;

  _stmts.insert.run({
    id,
    title: task.title || task.description || '',
    description: task.description || '',
    status,
    assignee: task.assignee || null,
    priority: task.priority || 'medium',
    parentId: task.parentId || null,
    dependencies: JSON.stringify(task.dependencies || []),
    maxRetries: task.maxRetries || DEFAULT_MAX_RETRIES,
    skills: JSON.stringify(task.skills || []),
    createdAt: now,
    updatedAt: now,
  });

  return _toRecord(_stmts.get.get(id));
}

function getTask(id) {
  if (!_initDb()) return _getTaskFile(id);
  return _toRecord(_stmts.get.get(id));
}

function updateTask(id, updates) {
  if (!_initDb()) return _updateTaskFile(id, updates);

  const existing = _stmts.get.get(id);
  if (!existing) return null;

  const now = Date.now();
  // 将 legacy status 映射为 canonical
  let status = updates.status || existing.status;
  if (LEGACY_TO_CANONICAL[status]) status = LEGACY_TO_CANONICAL[status];

  _stmts.update.run({
    id,
    title: updates.title || existing.title,
    description: updates.description || existing.description,
    status,
    assignee: updates.assignee !== undefined ? updates.assignee : existing.assignee,
    priority: updates.priority || existing.priority,
    dependencies: updates.dependencies ? JSON.stringify(updates.dependencies) : existing.dependencies,
    result: updates.result !== undefined ? updates.result : existing.result,
    updatedAt: now,
    completedAt: updates.completedAt || existing.completed_at,
    startedAt: updates.startedAt || existing.started_at,
    claimLock: updates.claimLock !== undefined ? updates.claimLock : existing.claim_lock,
    claimExpires: updates.claimExpires !== undefined ? updates.claimExpires : existing.claim_expires,
    consecutiveFailures: updates.consecutiveFailures !== undefined
      ? updates.consecutiveFailures : existing.consecutive_failures,
  });

  return _toRecord(_stmts.get.get(id));
}

function listTasks(filter = {}) {
  if (!_initDb()) return _listTasksFile(filter);

  // 先清理过期认领 + dead letter
  const now = Date.now();
  try {
    _stmts.expireStaleClaims.run(now, now);
    _stmts.deadLetter.run(now);
  } catch { /* non-fatal */ }

  let rows;
  if (filter.status) {
    const canonical = LEGACY_TO_CANONICAL[filter.status] || filter.status;
    rows = _stmts.listByStatus.all(canonical);
  } else if (filter.assignee) {
    rows = _stmts.listByAssignee.all(filter.assignee);
  } else {
    rows = _stmts.list.all();
  }

  return rows.map(_toRecord);
}

/**
 * CAS 原子认领 (借鉴 Hermes Agent kanban_db.py claim_task).
 * BEGIN IMMEDIATE + WHERE status='ready' AND claim_lock IS NULL
 *
 * @param {string} id
 * @param {string} workerId
 * @param {object} [opts]
 * @param {number} [opts.claimTtlMs] - 认领过期时间 (默认 5 分钟)
 * @returns {boolean} true if claim succeeded
 */
function claimTask(id, workerId, opts = {}) {
  if (!_initDb()) return _claimTaskFile(id, workerId, opts);

  const now = Date.now();
  const ttl = opts.claimTtlMs || DEFAULT_CLAIM_TTL_MS;
  const claimLock = `${workerId}:${crypto.randomBytes(4).toString('hex')}`;

  // 先检查依赖
  const task = _stmts.get.get(id);
  if (!task) return false;

  const deps = _parseJson(task.dependencies, []);
  if (deps.length > 0) {
    for (const depId of deps) {
      const dep = _stmts.get.get(depId);
      if (!dep || dep.status !== 'done') return false;
    }
  }

  // 检查父任务
  if (task.parent_id) {
    const parent = _stmts.get.get(task.parent_id);
    if (parent && parent.status !== 'running' && parent.status !== 'done') return false;
  }

  // CAS: 在事务中执行
  const txn = _db.transaction(() => {
    const result = _stmts.claim.run({
      id,
      claimLock,
      claimExpires: now + ttl,
      assignee: workerId,
      now,
    });

    if (result.changes !== 1) return false;

    // 记录 task_run
    _stmts.insertRun.run({
      id: crypto.randomBytes(8).toString('hex'),
      taskId: id,
      agent: workerId,
      startedAt: now,
    });

    return true;
  });

  return txn();
}

function completeTask(id, result) {
  return updateTask(id, {
    status: STATUS.DONE,
    result,
    completedAt: Date.now(),
  });
}

function failTask(id, error) {
  if (!_initDb()) return _updateTaskFile(id, { status: 'failed', result: error, completedAt: Date.now() });

  const existing = _stmts.get.get(id);
  if (!existing) return null;

  const failures = (existing.consecutive_failures || 0) + 1;
  const status = failures >= (existing.max_retries || DEFAULT_MAX_RETRIES) ? STATUS.BLOCKED : STATUS.READY;

  return updateTask(id, {
    status,
    result: error,
    completedAt: status === STATUS.BLOCKED ? Date.now() : null,
    claimLock: null,
    claimExpires: null,
    consecutiveFailures: failures,
  });
}

/**
 * 获取子任务列表.
 * @param {string} parentId
 * @returns {object[]}
 */
function getChildTasks(parentId) {
  if (!_initDb()) return [];
  return _stmts.listByParent.all(parentId).map(_toRecord);
}

function cleanup(olderThanMs = 3600000) {
  if (!_initDb()) return _cleanupFile(olderThanMs);
  const cutoff = Date.now() - olderThanMs;
  const result = _stmts.cleanOld.run(cutoff);
  return result.changes;
}

// ── File-based fallback (向后兼容，SQLite 不可用时) ──

function _tasksDir() {
  const { getDataDir } = require('../utils/dataHome');
  return getDataDir('tasks');
}

function _taskPath(id) {
  return path.join(_tasksDir(), `${id}.json`);
}

function _createTaskFile(task) {
  const fs = require('fs');
  const id = 't-' + Date.now().toString(36) + '-' + crypto.randomBytes(2).toString('hex');
  const record = {
    id, description: task.description, status: 'pending',
    assignee: task.assignee || null, dependencies: task.dependencies || [],
    priority: task.priority || 'medium', result: null,
    createdAt: Date.now(), updatedAt: Date.now(), completedAt: null,
  };
  fs.writeFileSync(_taskPath(id), JSON.stringify(record, null, 2), 'utf-8');
  return record;
}

function _getTaskFile(id) {
  const fs = require('fs');
  try { return JSON.parse(fs.readFileSync(_taskPath(id), 'utf-8')); } catch { return null; }
}

function _updateTaskFile(id, updates) {
  const fs = require('fs');
  const task = _getTaskFile(id);
  if (!task) return null;
  Object.assign(task, updates, { updatedAt: Date.now() });
  fs.writeFileSync(_taskPath(id), JSON.stringify(task, null, 2), 'utf-8');
  return task;
}

function _listTasksFile(filter = {}) {
  const fs = require('fs');
  const dir = _tasksDir();
  let files;
  try { files = fs.readdirSync(dir).filter(f => f.endsWith('.json')); } catch { return []; }
  const tasks = [];
  for (const file of files) {
    try {
      const task = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf-8'));
      if (filter.status && task.status !== filter.status) continue;
      if (filter.assignee && task.assignee !== filter.assignee) continue;
      tasks.push(task);
    } catch { /* skip */ }
  }
  const po = { high: 0, medium: 1, low: 2 };
  tasks.sort((a, b) => (po[a.priority] ?? 1) - (po[b.priority] ?? 1) || a.createdAt - b.createdAt);
  return tasks;
}

function _claimTaskFile(id, workerId, opts = {}) {
  const task = _getTaskFile(id);
  if (!task || task.status !== 'pending') return false;
  if (task.dependencies && task.dependencies.length > 0) {
    for (const depId of task.dependencies) {
      const dep = _getTaskFile(depId);
      if (!dep || dep.status !== 'completed') return false;
    }
  }
  task.status = 'claimed'; task.assignee = workerId; task.updatedAt = Date.now();
  const fs = require('fs');
  fs.writeFileSync(_taskPath(id), JSON.stringify(task, null, 2), 'utf-8');
  return true;
}

function _cleanupFile(olderThanMs = 3600000) {
  const fs = require('fs');
  const cutoff = Date.now() - olderThanMs;
  let removed = 0;
  const tasks = _listTasksFile();
  for (const task of tasks) {
    if ((task.status === 'completed' || task.status === 'failed') && task.completedAt < cutoff) {
      try { fs.unlinkSync(_taskPath(task.id)); removed++; } catch { /* ok */ }
    }
  }
  return removed;
}

module.exports = {
  createTask, getTask, updateTask, listTasks,
  claimTask, completeTask, failTask, cleanup,
  getChildTasks,
  STATUS,
  LEGACY_TO_CANONICAL,
  CANONICAL_TO_LEGACY,
};
