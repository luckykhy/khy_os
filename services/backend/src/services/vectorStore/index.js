'use strict';

/**
 * Vector Store service — store and query vector embeddings.
 * Supports multiple vector database backends.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

function _env(name) {
  return String(process.env[`KHY_VECTOR_STORE_${name}`] || '').trim();
}

// ── In-Memory Vector Store (default) ──
class InMemoryVectorStore {
  constructor() {
    this.vectors = new Map();
    this.metadata = new Map();
  }

  async add(id, vector, metadata = {}) {
    this.vectors.set(id, vector);
    this.metadata.set(id, metadata);
    return { id, added: true };
  }

  async addBatch(items) {
    const results = [];
    for (const item of items) {
      const result = await this.add(item.id, item.vector, item.metadata);
      results.push(result);
    }
    return results;
  }

  async query(queryVector, topK = 10) {
    const scores = [];
    for (const [id, vector] of this.vectors.entries()) {
      const score = this._cosineSimilarity(queryVector, vector);
      scores.push({ id, score, metadata: this.metadata.get(id) });
    }
    scores.sort((a, b) => b.score - a.score);
    return scores.slice(0, topK);
  }

  async delete(id) {
    this.vectors.delete(id);
    this.metadata.delete(id);
    return { id, deleted: true };
  }

  async size() {
    return this.vectors.size;
  }

  _cosineSimilarity(a, b) {
    if (a.length !== b.length || a.length === 0) return 0;
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < a.length; i++) {
      const x = Number(a[i]) || 0;
      const y = Number(b[i]) || 0;
      dot += x * y;
      na += x * x;
      nb += y * y;
    }
    if (na === 0 || nb === 0) return 0;
    return dot / (Math.sqrt(na) * Math.sqrt(nb));
  }
}

// ── File-backed Vector Store ──
class FileVectorStore {
  constructor(storePath) {
    this.storePath = storePath || path.join(os.homedir(), '.khy', 'vector_store');
    this.vectors = new Map();
    this.metadata = new Map();
    this._ensureDir();
    this._loadFromDisk();
  }

  _ensureDir() {
    if (!fs.existsSync(this.storePath)) {
      fs.mkdirSync(this.storePath, { recursive: true });
    }
  }

  _loadFromDisk() {
    const vectorsFile = path.join(this.storePath, 'vectors.json');
    if (fs.existsSync(vectorsFile)) {
      try {
        const data = JSON.parse(fs.readFileSync(vectorsFile, 'utf-8'));
        this.vectors = new Map(Object.entries(data.vectors || {}));
        this.metadata = new Map(Object.entries(data.metadata || {}));
      } catch (e) {
        // ignore
      }
    }
  }

  async _saveToDisk() {
    const vectorsFile = path.join(this.storePath, 'vectors.json');
    const data = {
      vectors: Object.fromEntries(this.vectors),
      metadata: Object.fromEntries(this.metadata),
    };
    fs.writeFileSync(vectorsFile, JSON.stringify(data), 'utf-8');
  }

  async add(id, vector, metadata = {}) {
    this.vectors.set(id, vector);
    this.metadata.set(id, metadata);
    await this._saveToDisk();
    return { id, added: true };
  }

  async addBatch(items) {
    const results = [];
    for (const item of items) {
      this.vectors.set(item.id, item.vector);
      this.metadata.set(item.id, item.metadata || {});
      results.push({ id: item.id, added: true });
    }
    await this._saveToDisk();
    return results;
  }

  async query(queryVector, topK = 10) {
    const scores = [];
    for (const [id, vector] of this.vectors.entries()) {
      const score = this._cosineSimilarity(queryVector, vector);
      scores.push({ id, score, metadata: this.metadata.get(id) });
    }
    scores.sort((a, b) => b.score - a.score);
    return scores.slice(0, topK);
  }

  async delete(id) {
    this.vectors.delete(id);
    this.metadata.delete(id);
    await this._saveToDisk();
    return { id, deleted: true };
  }

  async size() {
    return this.vectors.size;
  }

  _cosineSimilarity(a, b) {
    if (a.length !== b.length || a.length === 0) return 0;
    let dot = 0, na = 0, nb = 0;
    for (let i = 0; i < a.length; i++) {
      const x = Number(a[i]) || 0;
      const y = Number(b[i]) || 0;
      dot += x * y;
      na += x * x;
      nb += y * y;
    }
    if (na === 0 || nb === 0) return 0;
    return dot / (Math.sqrt(na) * Math.sqrt(nb));
  }
}

// ── Provider registry ──
const PROVIDERS = [
  { id: 'memory', name: 'In-Memory', create: () => new InMemoryVectorStore() },
  { id: 'file', name: 'File-Backed', create: (opts) => new FileVectorStore(opts?.path) },
];

function listProviders() {
  return PROVIDERS.map((p) => ({ id: p.id, name: p.name }));
}

function createStore(providerId, options = {}) {
  const provider = PROVIDERS.find((p) => p.id === providerId);
  if (!provider) throw new Error(`Unknown provider: ${providerId}`);
  return provider.create(options);
}

module.exports = {
  listProviders,
  createStore,
  InMemoryVectorStore,
  FileVectorStore,
};
