const fs = require('fs');
const path = require('path');
const os = require('os');
const { randomUUID } = require('crypto');

const SESSIONS_DIR = path.join(os.homedir(), '.khyquant', 'conversations');

function ensureDir() {
  if (!fs.existsSync(SESSIONS_DIR)) {
    fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  }
}

function sessionFile(id) {
  return path.join(SESSIONS_DIR, `${id}.json`);
}

function loadSession(id) {
  try {
    const raw = fs.readFileSync(sessionFile(id), 'utf-8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function saveSession(session) {
  ensureDir();
  fs.writeFileSync(sessionFile(session.id), JSON.stringify(session, null, 2), 'utf-8');
}

function listSessionFiles() {
  ensureDir();
  return fs
    .readdirSync(SESSIONS_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => f.replace('.json', ''));
}

const sessionService = {
  async list(limit = 50) {
    const ids = listSessionFiles();
    const sessions = ids
      .map((id) => loadSession(id))
      .filter(Boolean)
      .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
      .slice(0, limit);
    return sessions;
  },

  async create(data = {}) {
    const now = Date.now();
    const session = {
      id: randomUUID(),
      title: data.title || '新对话',
      messages: [],
      createdAt: now,
      updatedAt: now,
      metadata: data.metadata || {},
    };
    saveSession(session);
    return session;
  },

  async get(id) {
    const session = loadSession(id);
    if (!session) {
      throw new Error(`会话不存在：${id}`);
    }
    return session;
  },

  async update(id, data) {
    const session = loadSession(id);
    if (!session) {
      throw new Error(`会话不存在：${id}`);
    }
    Object.assign(session, data, { updatedAt: Date.now() });
    saveSession(session);
    return session;
  },

  async delete(id) {
    try {
      fs.unlinkSync(sessionFile(id));
    } catch {
      // Already deleted.
    }
    return { success: true };
  },

  async fork(id, index) {
    const source = loadSession(id);
    if (!source) {
      throw new Error(`会话不存在：${id}`);
    }
    const now = Date.now();
    const forked = {
      id: randomUUID(),
      title: `${source.title} (分支)`,
      messages: source.messages.slice(0, index),
      createdAt: now,
      updatedAt: now,
      metadata: { ...source.metadata, forkedFrom: id, forkIndex: index },
    };
    saveSession(forked);
    return forked;
  },
};

module.exports = sessionService;
