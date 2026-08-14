/**
 * TaskStore — persistence layer for delivery tasks.
 *
 * Uses SQLite (better-sqlite3) when available, falls back to JSON file.
 *
 * Table schema (SQLite):
 *   CREATE TABLE delivery_tasks (
 *     id          TEXT PRIMARY KEY,
 *     status      TEXT NOT NULL DEFAULT 'pending',  -- pending | processing | completed | failed
 *     content     TEXT NOT NULL,                     -- the source content
 *     format      TEXT NOT NULL DEFAULT 'markdown',  -- source format
 *     platforms   TEXT NOT NULL DEFAULT '[]',        -- JSON array of target platforms
 *     created_at  TEXT NOT NULL,
 *     updated_at  TEXT NOT NULL,
 *     result      TEXT,                               -- JSON delivery results
 *     retries     INTEGER DEFAULT 0,
 *     metadata    TEXT                                -- JSON object
 *   );
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

// ── JSON fallback store ─────────────────────────────────────────────────

class JsonTaskStore {
  constructor(filePath) {
    this.filePath = filePath;
    this._tasks = new Map();
    this._load();
  }

  _load() {
    try {
      if (fs.existsSync(this.filePath)) {
        const data = JSON.parse(fs.readFileSync(this.filePath, 'utf-8'));
        for (const [id, task] of Object.entries(data)) {
          this._tasks.set(id, task);
        }
      }
    } catch (e) {
      console.warn(`[TaskStore] Failed to load from ${this.filePath}: ${e.message}`);
    }
  }

  _save() {
    try {
      const dir = path.dirname(this.filePath);
      fs.mkdirSync(dir, { recursive: true });
      const data = Object.fromEntries(this._tasks);
      fs.writeFileSync(this.filePath, JSON.stringify(data, null, 2), 'utf-8');
    } catch (e) {
      console.error(`[TaskStore] Failed to save: ${e.message}`);
    }
  }

  create(task) {
    this._tasks.set(task.id, task);
    this._save();
    return task;
  }

  get(id) {
    return this._tasks.get(id) || null;
  }

  update(id, updates) {
    const existing = this._tasks.get(id);
    if (!existing) return null;
    const updated = { ...existing, ...updates, updated_at: new Date().toISOString() };
    this._tasks.set(id, updated);
    this._save();
    return updated;
  }

  list(filter = {}) {
    let results = [...this._tasks.values()];
    if (filter.status) results = results.filter((t) => t.status === filter.status);
    if (filter.platforms) results = results.filter((t) => filter.platforms.some((p) => t.platforms?.includes(p)));
    return results.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  }

  delete(id) {
    const existed = this._tasks.has(id);
    this._tasks.delete(id);
    if (existed) this._save();
    return existed;
  }
}

// ── SQLite store ────────────────────────────────────────────────────────

class SqliteTaskStore {
  constructor(dbPath) {
    let Database;
    try {
      Database = require('better-sqlite3');
    } catch {
      // Fallback to JSON
      this._fallback = new JsonTaskStore(dbPath.replace(/\.db$/, '.json'));
      this.db = null;
      return;
    }
    this.db = new Database(dbPath);
    this._initSchema();
  }

  _initSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS delivery_tasks (
        id          TEXT PRIMARY KEY,
        status      TEXT NOT NULL DEFAULT 'pending',
        content     TEXT NOT NULL,
        format      TEXT NOT NULL DEFAULT 'markdown',
        platforms   TEXT NOT NULL DEFAULT '[]',
        created_at  TEXT NOT NULL,
        updated_at  TEXT NOT NULL,
        result      TEXT,
        retries     INTEGER DEFAULT 0,
        metadata    TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_status ON delivery_tasks(status);
      CREATE INDEX IF NOT EXISTS idx_created ON delivery_tasks(created_at);
    `);
  }

  create(task) {
    const stmt = this.db.prepare(`
      INSERT INTO delivery_tasks (id, status, content, format, platforms, created_at, updated_at, result, retries, metadata)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    stmt.run(
      task.id, task.status || 'pending', task.content, task.format || 'markdown',
      JSON.stringify(task.platforms || []), task.created_at || new Date().toISOString(),
      task.updated_at || new Date().toISOString(), task.result ? JSON.stringify(task.result) : null,
      task.retries || 0, task.metadata ? JSON.stringify(task.metadata) : null
    );
    return task;
  }

  get(id) {
    const row = this.db.prepare('SELECT * FROM delivery_tasks WHERE id = ?').get(id);
    return row ? this._rowToTask(row) : null;
  }

  update(id, updates) {
    const existing = this.get(id);
    if (!existing) return null;
    const updated = { ...existing, ...updates, updated_at: new Date().toISOString() };
    const stmt = this.db.prepare(`
      UPDATE delivery_tasks SET status = ?, content = ?, platforms = ?, updated_at = ?, result = ?, retries = ?, metadata = ?
      WHERE id = ?
    `);
    stmt.run(
      updated.status, updated.content, JSON.stringify(updated.platforms),
      updated.updated_at, updated.result ? JSON.stringify(updated.result) : null,
      updated.retries || 0, updated.metadata ? JSON.stringify(updated.metadata) : null,
      id
    );
    return updated;
  }

  list(filter = {}) {
    let sql = 'SELECT * FROM delivery_tasks';
    const params = [];
    const clauses = [];
    if (filter.status) { clauses.push('status = ?'); params.push(filter.status); }
    if (filter.platforms && filter.platforms.length > 0) {
      clauses.push('platforms LIKE ?');
      params.push(`%${filter.platforms[0]}%`);
    }
    if (clauses.length > 0) sql += ' WHERE ' + clauses.join(' AND ');
    sql += ' ORDER BY created_at DESC';
    const rows = this.db.prepare(sql).all(...params);
    return rows.map(this._rowToTask);
  }

  delete(id) {
    const result = this.db.prepare('DELETE FROM delivery_tasks WHERE id = ?').run(id);
    return result.changes > 0;
  }

  _rowToTask(row) {
    return {
      id: row.id,
      status: row.status,
      content: row.content,
      format: row.format,
      platforms: JSON.parse(row.platforms || '[]'),
      created_at: row.created_at,
      updated_at: row.updated_at,
      result: row.result ? JSON.parse(row.result) : null,
      retries: row.retries,
      metadata: row.metadata ? JSON.parse(row.metadata) : null,
    };
  }
}

// ── Factory ─────────────────────────────────────────────────────────────

function createTaskStore(config = {}) {
  const dataDir = config.dataDir || path.join(os.homedir(), '.khyquant', 'delivery');
  fs.mkdirSync(dataDir, { recursive: true });

  const dbPath = path.join(dataDir, 'delivery_tasks.db');
  try {
    return new SqliteTaskStore(dbPath);
  } catch {
    const jsonPath = path.join(dataDir, 'delivery_tasks.json');
    return new JsonTaskStore(jsonPath);
  }
}

module.exports = { createTaskStore, JsonTaskStore, SqliteTaskStore };
