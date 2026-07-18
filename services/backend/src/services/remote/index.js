'use strict';

const sshConfigService = require('./sshConfigService');
const sshCredentialGuard = require('./sshCredentialGuard');
const { createSshConnectionManager } = require('./sshConnectionManager');
const remoteWorkspaceResolver = require('./remoteWorkspaceResolver');
const { createRemoteApprovalBridge } = require('./remoteApprovalBridge');
const { RemoteExecService } = require('./remoteExecService');
const { createRemoteFileTransferService } = require('./remoteFileTransferService');
const { createDeployOrchestrator } = require('./deployOrchestrator');
const { RemoteStateSyncService } = require('./remoteStateSyncService');
const {
  createRemoteExecStreamStore,
  buildRemoteExecStreamRequestFingerprint,
} = require('./remoteExecStreamStore');
const { createRemoteStatePersistence } = require('./remoteStatePersistence');

const DEFAULT_PERSIST_DEBOUNCE_MS = 200;
const DEFAULT_PERSIST_ALERT_MAX = 120;
const DEFAULT_PERSIST_ALERT_RETENTION_MS = 24 * 60 * 60 * 1000;

function _readPositiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

const sshConnectionManager = createSshConnectionManager();
const remoteStatePersistence = createRemoteStatePersistence();
const persistDebounceMs = _readPositiveInt(
  process.env.KHY_REMOTE_SSH_PERSIST_DEBOUNCE_MS,
  DEFAULT_PERSIST_DEBOUNCE_MS
);
const persistAlertMax = _readPositiveInt(
  process.env.KHY_REMOTE_SSH_PERSIST_ALERT_MAX,
  DEFAULT_PERSIST_ALERT_MAX
);
const persistAlertRetentionMs = _readPositiveInt(
  process.env.KHY_REMOTE_SSH_PERSIST_ALERT_RETENTION_MS,
  DEFAULT_PERSIST_ALERT_RETENTION_MS
);
let hydrationInProgress = false;
let remoteExecStreamStore = null;
let remoteStateHydration = {
  loaded: false,
  reason_code: 'not_initialized',
  reason: 'Remote state hydration has not started yet.',
  attempted_at: null,
  started_at: null,
  completed_at: null,
  duration_ms: 0,
  approvals_loaded: 0,
  streams_loaded: 0,
  path: remoteStatePersistence.getStatePath(),
};
let persistAlertSeq = 0;
const persistAlerts = [];
const persistAlertSubscribers = new Set();

const persistRuntime = {
  timer: null,
  dirty: false,
  lastSavedAtMs: 0,
  stats: {
    enabled: remoteStatePersistence.isEnabled(),
    state_path: remoteStatePersistence.getStatePath(),
    debounce_ms: persistDebounceMs,
    total_save_count: 0,
    last_save_at: null,
    last_save_status: 'never',
    last_saved_approvals: 0,
    last_saved_streams: 0,
    last_error: null,
    last_trigger_source: null,
    last_trigger_reason: null,
  },
};

function _clearPersistTimer() {
  if (!persistRuntime.timer) return;
  clearTimeout(persistRuntime.timer);
  persistRuntime.timer = null;
}

function _cleanupPersistAlerts() {
  const nowMs = Date.now();
  while (persistAlerts.length > 0) {
    const oldest = persistAlerts[0];
    const tsMs = Date.parse(oldest.ts || '');
    if (!Number.isFinite(tsMs) || (nowMs - tsMs) <= persistAlertRetentionMs) break;
    persistAlerts.shift();
  }
  if (persistAlerts.length > persistAlertMax) {
    persistAlerts.splice(0, persistAlerts.length - persistAlertMax);
  }
}

function _clonePersistAlert(alert) {
  if (!alert || typeof alert !== 'object') return null;
  return {
    ...alert,
    details: alert.details && typeof alert.details === 'object'
      ? { ...alert.details }
      : null,
  };
}

function _notifyPersistAlertSubscribers(alert) {
  if (!alert) return;
  const subscribers = Array.from(persistAlertSubscribers);
  for (const listener of subscribers) {
    try {
      listener(_clonePersistAlert(alert));
    } catch {
      /* ignore subscriber callback errors */
    }
  }
}

function _appendPersistAlert({
  severity = 'error',
  code,
  message,
  mutation = null,
  details = null,
}) {
  if (!code || !message) return null;
  const alert = {
    alert_id: ++persistAlertSeq,
    ts: new Date().toISOString(),
    severity: String(severity || 'error'),
    code: String(code),
    message: String(message),
    acked: false,
    acked_at: null,
    acked_by: null,
    trigger_source: mutation?.source || null,
    trigger_reason: mutation?.reason || null,
    details: details && typeof details === 'object' ? { ...details } : null,
  };
  persistAlerts.push(alert);
  _cleanupPersistAlerts();
  const cloned = _clonePersistAlert(alert);
  _notifyPersistAlertSubscribers(cloned);
  return cloned;
}

function listPersistenceAlerts({ afterId = 0, limit = 20, onlyUnacked = false } = {}) {
  _cleanupPersistAlerts();
  const safeAfterId = Number.isFinite(Number.parseInt(afterId, 10))
    ? Number.parseInt(afterId, 10)
    : 0;
  const safeLimit = Math.max(1, Math.min(200, Number.parseInt(limit, 10) || 20));
  const filtered = persistAlerts.filter((item) => {
    if (item.alert_id <= safeAfterId) return false;
    if (onlyUnacked && item.acked) return false;
    return true;
  });
  if (filtered.length <= safeLimit) {
    return filtered.map((item) => _clonePersistAlert(item));
  }
  return filtered
    .slice(filtered.length - safeLimit)
    .map((item) => _clonePersistAlert(item));
}

function subscribePersistenceAlerts(listener) {
  if (typeof listener !== 'function') return () => {};
  persistAlertSubscribers.add(listener);
  return () => {
    persistAlertSubscribers.delete(listener);
  };
}

function markPersistenceAlertsAcknowledged({
  alertId = null,
  upToId = null,
  reviewer = null,
} = {}) {
  _cleanupPersistAlerts();
  const parsedAlertId = Number.parseInt(alertId, 10);
  const parsedUpToId = Number.parseInt(upToId, 10);
  const hasAlertId = Number.isFinite(parsedAlertId) && parsedAlertId > 0;
  const hasUpToId = Number.isFinite(parsedUpToId) && parsedUpToId > 0;

  if (!hasAlertId && !hasUpToId) {
    return {
      ok: false,
      code: 'ack_target_required',
      acked_count: 0,
      alerts: [],
    };
  }

  const acked = [];
  for (const alert of persistAlerts) {
    const shouldAck = hasAlertId
      ? alert.alert_id === parsedAlertId
      : alert.alert_id <= parsedUpToId;
    if (!shouldAck) continue;
    if (alert.acked) continue;
    alert.acked = true;
    alert.acked_at = new Date().toISOString();
    alert.acked_by = reviewer ? String(reviewer).trim() || null : null;
    acked.push(_clonePersistAlert(alert));
  }

  return {
    ok: true,
    code: 'ack_completed',
    acked_count: acked.length,
    alerts: acked,
  };
}

function _isForcePersistMutation(mutation) {
  if (!mutation || typeof mutation !== 'object') return false;
  if (mutation.reason === 'clear_all' || mutation.reason === 'import_state') return true;
  if (
    mutation.source === 'remote_exec_stream_store'
    && mutation.reason === 'append_event'
    && mutation.payload
    && mutation.payload.done
  ) {
    return true;
  }
  return false;
}

function _saveRemoteStateNow(mutation = null) {
  if (!remoteStatePersistence.isEnabled()) {
    persistRuntime.stats.last_save_status = 'skipped_disabled';
    return { saved: false, reason: 'persistence_disabled' };
  }
  if (hydrationInProgress) {
    persistRuntime.stats.last_save_status = 'skipped_hydration';
    return { saved: false, reason: 'hydration_in_progress' };
  }
  if (!remoteExecStreamStore) {
    persistRuntime.stats.last_save_status = 'skipped_store_not_ready';
    return { saved: false, reason: 'stream_store_not_ready' };
  }

  const result = remoteStatePersistence.save({
    approvals: remoteApprovalBridge.exportState(),
    streams: remoteExecStreamStore.exportState(),
  });

  const nowIso = new Date().toISOString();
  persistRuntime.stats.last_trigger_source = mutation?.source || 'manual';
  persistRuntime.stats.last_trigger_reason = mutation?.reason || 'manual';

  const previousStatus = persistRuntime.stats.last_save_status;

  if (result.saved) {
    persistRuntime.lastSavedAtMs = Date.now();
    persistRuntime.stats.total_save_count += 1;
    persistRuntime.stats.last_save_at = nowIso;
    persistRuntime.stats.last_save_status = 'saved';
    persistRuntime.stats.last_saved_approvals = result.approvals || 0;
    persistRuntime.stats.last_saved_streams = result.streams || 0;
    persistRuntime.stats.last_error = null;
    if (previousStatus === 'failed') {
      _appendPersistAlert({
        severity: 'info',
        code: 'persist_save_recovered',
        message: 'Remote state persistence recovered after a previous save failure.',
        mutation,
        details: {
          approvals: result.approvals || 0,
          streams: result.streams || 0,
          state_path: remoteStatePersistence.getStatePath(),
        },
      });
    }
  } else {
    persistRuntime.stats.last_save_at = nowIso;
    persistRuntime.stats.last_save_status = 'failed';
    persistRuntime.stats.last_error = result.reason || 'save_failed';
    _appendPersistAlert({
      severity: 'error',
      code: 'persist_save_failed',
      message: 'Remote state persistence save failed.',
      mutation,
      details: {
        error: result.reason || 'save_failed',
        state_path: remoteStatePersistence.getStatePath(),
      },
    });
  }

  return result;
}

function _schedulePersistSave(mutation = null, force = false) {
  if (!remoteStatePersistence.isEnabled()) return;
  if (hydrationInProgress) return;
  if (!remoteExecStreamStore) return;

  const shouldForce = force || _isForcePersistMutation(mutation);
  if (shouldForce || persistDebounceMs <= 0) {
    persistRuntime.dirty = false;
    _clearPersistTimer();
    _saveRemoteStateNow(mutation);
    return;
  }

  const nowMs = Date.now();
  if (
    persistRuntime.lastSavedAtMs === 0
    || (nowMs - persistRuntime.lastSavedAtMs) >= persistDebounceMs
  ) {
    persistRuntime.dirty = false;
    _saveRemoteStateNow(mutation);
    return;
  }

  persistRuntime.dirty = true;
  if (persistRuntime.timer) return;

  const waitMs = Math.max(1, persistDebounceMs - (nowMs - persistRuntime.lastSavedAtMs));
  persistRuntime.timer = setTimeout(() => {
    persistRuntime.timer = null;
    if (!persistRuntime.dirty) return;
    persistRuntime.dirty = false;
    _saveRemoteStateNow({
      source: 'remote_state_persistence',
      reason: 'debounce_flush',
      payload: {},
    });
    if (persistRuntime.dirty) {
      _schedulePersistSave({
        source: 'remote_state_persistence',
        reason: 'debounce_followup',
        payload: {},
      });
    }
  }, waitMs);
  if (persistRuntime.timer && typeof persistRuntime.timer.unref === 'function') {
    persistRuntime.timer.unref();
  }
}

function persistRemoteState(mutation = null) {
  if (mutation == null) {
    _schedulePersistSave(
      {
        source: 'manual',
        reason: 'manual_flush',
        payload: {},
      },
      true
    );
    return;
  }
  _schedulePersistSave(mutation, false);
}

function _buildPersistenceStatus() {
  _cleanupPersistAlerts();
  const latestAlert = persistAlerts.length > 0
    ? _clonePersistAlert(persistAlerts[persistAlerts.length - 1])
    : null;
  const unacked = persistAlerts.filter((item) => !item.acked);
  const latestUnacked = unacked.length > 0
    ? _clonePersistAlert(unacked[unacked.length - 1])
    : null;
  return {
    ...persistRuntime.stats,
    pending_flush: Boolean(persistRuntime.dirty),
    timer_active: Boolean(persistRuntime.timer),
    alert_total: persistAlerts.length,
    alert_subscriber_total: persistAlertSubscribers.size,
    unacked_alert_total: unacked.length,
    latest_alert: latestAlert,
    latest_unacked_alert: latestUnacked,
    hydration: remoteStateHydration,
  };
}

const remoteApprovalBridge = createRemoteApprovalBridge({
  onMutate: (mutation) => persistRemoteState(mutation),
});

const remoteExecService = new RemoteExecService({
  connectionManager: sshConnectionManager,
  approvalBridge: remoteApprovalBridge,
});

const remoteFileTransferService = createRemoteFileTransferService({
  connectionManager: sshConnectionManager,
});

// End-to-end deploy pipeline (build bundle -> scp -> remote docker compose up).
// The bundle builder now lives in the services layer (services/publish/*), so the
// remote subsystem depends DOWNWARD on it instead of reaching up into the CLI
// handler graph. The builders are lazy-required to keep them off the module-load
// path; logging stays silent here (the orchestrator surfaces its own progress).
const deployOrchestrator = createDeployOrchestrator({
  connectionManager: sshConnectionManager,
  approvalBridge: remoteApprovalBridge,
  execService: remoteExecService,
  fileTransferService: remoteFileTransferService,
  sshConfigService,
  sshCredentialGuard,
  workspaceResolver: remoteWorkspaceResolver,
  buildDockerBundle: (projectRoot) => {
    const { _findProjectRoot, _readState } = require('../publish/projectState');
    const { buildDockerBundle } = require('../publish/dockerBundleBuilder');
    const root = _findProjectRoot(projectRoot || process.cwd());
    const state = _readState(root);
    return buildDockerBundle(root, state, {});
  },
});

const remoteStateSyncService = new RemoteStateSyncService({
  connectionManager: sshConnectionManager,
  approvalBridge: remoteApprovalBridge,
  getPersistenceStatus: () => _buildPersistenceStatus(),
});

remoteExecStreamStore = createRemoteExecStreamStore({
  onMutate: (mutation) => persistRemoteState(mutation),
});

function hydrateRemoteStateFromDisk() {
  const startedAtMs = Date.now();
  const startedAtIso = new Date(startedAtMs).toISOString();
  const finalize = (payload) => ({
    attempted_at: startedAtIso,
    started_at: startedAtIso,
    completed_at: new Date().toISOString(),
    duration_ms: Math.max(0, Date.now() - startedAtMs),
    approvals_loaded: 0,
    streams_loaded: 0,
    path: remoteStatePersistence.getStatePath(),
    ...payload,
  });

  if (!remoteStatePersistence.isEnabled()) {
    return finalize({
      loaded: false,
      reason_code: 'persistence_disabled',
      reason: 'Remote state persistence is disabled.',
    });
  }
  const loaded = remoteStatePersistence.load();
  if (!loaded) {
    return finalize({
      loaded: false,
      reason_code: 'state_file_missing_or_invalid',
      reason: 'State file is missing or invalid.',
    });
  }

  hydrationInProgress = true;
  try {
    const approvals = remoteApprovalBridge.importState(loaded.approvals);
    const streams = remoteExecStreamStore.importState(loaded.streams);
    return finalize({
      loaded: true,
      approvals_loaded: approvals,
      streams_loaded: streams,
      version: loaded.version,
      reason_code: null,
      reason: null,
    });
  } catch (error) {
    return finalize({
      loaded: false,
      reason_code: 'hydration_exception',
      reason: error?.message || 'unknown_hydration_error',
    });
  } finally {
    hydrationInProgress = false;
  }
}

remoteStateHydration = hydrateRemoteStateFromDisk();

function resetRemoteStateForTests() {
  _clearPersistTimer();
  persistRuntime.dirty = false;
  persistRuntime.lastSavedAtMs = 0;
  persistRuntime.stats.total_save_count = 0;
  persistRuntime.stats.last_save_at = null;
  persistRuntime.stats.last_save_status = 'reset';
  persistRuntime.stats.last_saved_approvals = 0;
  persistRuntime.stats.last_saved_streams = 0;
  persistRuntime.stats.last_error = null;
  persistRuntime.stats.last_trigger_source = null;
  persistRuntime.stats.last_trigger_reason = null;
  persistAlerts.splice(0, persistAlerts.length);
  persistAlertSubscribers.clear();
  persistAlertSeq = 0;
  remoteStateHydration = {
    loaded: false,
    reason_code: 'reset',
    reason: 'State was reset for tests.',
    attempted_at: null,
    started_at: null,
    completed_at: null,
    duration_ms: 0,
    approvals_loaded: 0,
    streams_loaded: 0,
    path: remoteStatePersistence.getStatePath(),
  };
  sshConnectionManager.clearAll();
  remoteApprovalBridge.clearAll();
  remoteExecStreamStore.clearAll();
  remoteStatePersistence.clear();
}

module.exports = {
  sshConfigService,
  sshCredentialGuard,
  sshConnectionManager,
  remoteWorkspaceResolver,
  remoteExecService,
  remoteFileTransferService,
  deployOrchestrator,
  remoteApprovalBridge,
  remoteStateSyncService,
  remoteExecStreamStore,
  remoteStatePersistence,
  remoteStateHydration,
  buildRemoteExecStreamRequestFingerprint,
  persistRemoteState,
  listPersistenceAlerts,
  subscribePersistenceAlerts,
  markPersistenceAlertsAcknowledged,
  hydrateRemoteStateFromDisk,
  resetRemoteStateForTests,
};
