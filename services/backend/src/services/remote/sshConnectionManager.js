'use strict';

const crypto = require('crypto');

class SshConnectionManager {
  constructor() {
    this._connections = new Map();
  }

  connect({ hostEntry, workspace, purpose = 'development', traceId = null }) {
    if (!hostEntry || !hostEntry.alias) {
      const error = new Error('Cannot connect without a valid host entry.');
      error.code = 'invalid_host_entry';
      throw error;
    }

    const connectionId = crypto.randomUUID();
    const nowIso = new Date().toISOString();

    const record = {
      connectionId,
      status: 'connected',
      hostAlias: hostEntry.alias,
      host: hostEntry.host,
      port: hostEntry.port,
      remoteUser: hostEntry.user || null,
      remoteWorkspace: workspace || hostEntry.remoteWorkspace || null,
      purpose,
      traceId,
      connectedAt: nowIso,
      lastActivityAt: nowIso,
    };

    this._connections.set(connectionId, record);
    return { ...record };
  }

  disconnect(connectionId) {
    const key = String(connectionId || '').trim();
    if (!key) return { disconnected: false, status: 'invalid_connection_id' };

    const existing = this._connections.get(key);
    if (!existing) {
      return { disconnected: false, status: 'not_found' };
    }

    this._connections.delete(key);
    return {
      disconnected: true,
      status: 'disconnected',
      connectionId: key,
      hostAlias: existing.hostAlias,
      traceId: existing.traceId || null,
    };
  }

  getSession(connectionId) {
    const key = String(connectionId || '').trim();
    if (!key) return null;
    const record = this._connections.get(key);
    return record ? { ...record } : null;
  }

  touch(connectionId) {
    const key = String(connectionId || '').trim();
    if (!key) return false;
    const record = this._connections.get(key);
    if (!record) return false;
    record.lastActivityAt = new Date().toISOString();
    return true;
  }

  listSessions() {
    return Array.from(this._connections.values())
      .map((record) => ({ ...record }))
      .sort((a, b) => a.connectedAt.localeCompare(b.connectedAt));
  }

  clearAll() {
    this._connections.clear();
  }
}

module.exports = {
  SshConnectionManager,
  createSshConnectionManager: () => new SshConnectionManager(),
};
