'use strict';

const fs = require('fs');
const path = require('path');
const { getDataHome } = require('../../utils/dataHome');

const STATE_FILE_VERSION = 1;

// 收敛到 utils/envFlagByName 单一真源(逐字节委托,调用点不变)
const _envFlag = require('../../utils/envFlagByName');

function _defaultStatePath() {
  return path.join(getDataHome(), 'remote', 'ssh_state.json');
}

class RemoteStatePersistence {
  constructor(options = {}) {
    const enabledFromOptions = options.enabled;
    this._enabled = typeof enabledFromOptions === 'boolean'
      ? enabledFromOptions
      : _envFlag('KHY_REMOTE_SSH_PERSIST_STATE', false);
    this._statePath = options.statePath
      || process.env.KHY_REMOTE_SSH_STATE_PATH
      || _defaultStatePath();
  }

  isEnabled() {
    return this._enabled;
  }

  getStatePath() {
    return this._statePath;
  }

  load() {
    if (!this._enabled) return null;
    try {
      if (!fs.existsSync(this._statePath)) return null;
      const raw = fs.readFileSync(this._statePath, 'utf-8');
      const parsed = JSON.parse(raw);
      const approvals = Array.isArray(parsed?.approvals) ? parsed.approvals : [];
      const streams = Array.isArray(parsed?.streams) ? parsed.streams : [];
      return {
        version: Number.parseInt(parsed?.version, 10) || STATE_FILE_VERSION,
        approvals,
        streams,
      };
    } catch {
      return null;
    }
  }

  save({ approvals = [], streams = [] }) {
    if (!this._enabled) return { saved: false, reason: 'persistence_disabled' };

    try {
      const dir = path.dirname(this._statePath);
      fs.mkdirSync(dir, { recursive: true });

      const payload = {
        version: STATE_FILE_VERSION,
        saved_at: new Date().toISOString(),
        approvals: Array.isArray(approvals) ? approvals : [],
        streams: Array.isArray(streams) ? streams : [],
      };

      const tempPath = `${this._statePath}.tmp`;
      fs.writeFileSync(tempPath, JSON.stringify(payload, null, 2), 'utf-8');
      fs.renameSync(tempPath, this._statePath);
      return {
        saved: true,
        path: this._statePath,
        approvals: payload.approvals.length,
        streams: payload.streams.length,
      };
    } catch (error) {
      return {
        saved: false,
        reason: error?.message || 'save_failed',
      };
    }
  }

  clear() {
    if (!this._enabled) return { cleared: false, reason: 'persistence_disabled' };
    try {
      if (fs.existsSync(this._statePath)) {
        fs.unlinkSync(this._statePath);
      }
      return { cleared: true };
    } catch (error) {
      return { cleared: false, reason: error?.message || 'clear_failed' };
    }
  }
}

module.exports = {
  RemoteStatePersistence,
  createRemoteStatePersistence: (options = {}) => new RemoteStatePersistence(options),
};
