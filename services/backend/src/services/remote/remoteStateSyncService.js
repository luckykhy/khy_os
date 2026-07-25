'use strict';

class RemoteStateSyncService {
  constructor({ connectionManager, approvalBridge, getPersistenceStatus = null }) {
    this._connectionManager = connectionManager;
    this._approvalBridge = approvalBridge;
    this._getPersistenceStatus = typeof getPersistenceStatus === 'function'
      ? getPersistenceStatus
      : null;
  }

  getSnapshot() {
    const sessions = this._connectionManager.listSessions();
    const pendingApprovals = this._approvalBridge.listPendingTickets();
    const persistence = this._getPersistenceStatus ? this._getPersistenceStatus() : null;
    const lastHydration = persistence?.hydration || null;

    return {
      generated_at: new Date().toISOString(),
      active_remote_sessions: sessions,
      pending_remote_approvals: pendingApprovals,
      persistence,
      last_hydration: lastHydration,
      summary: {
        active_session_count: sessions.length,
        pending_approval_count: pendingApprovals.length,
        persistence_enabled: Boolean(persistence?.enabled),
        persistence_alert_count: Number.isFinite(persistence?.alert_total)
          ? persistence.alert_total
          : 0,
      },
    };
  }
}

module.exports = {
  RemoteStateSyncService,
};
