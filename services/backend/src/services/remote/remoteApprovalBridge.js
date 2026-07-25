'use strict';

const crypto = require('crypto');

const RISK_WEIGHT = {
  safe: 0,
  moderate: 1,
  dangerous: 2,
  critical: 3,
};

const RISK_PATTERNS = [
  {
    risk: 'critical',
    reason: 'Potential system wipe or destructive disk operation detected.',
    pattern: /\b(rm\s+-rf\s+\/|mkfs\b|dd\s+if=|shutdown\b|reboot\b)\b/i,
  },
  {
    risk: 'dangerous',
    reason: 'Command mutates system or repository state and requires approval.',
    pattern: /\b(rm\s+-rf|kill\s+-9|git\s+push|chmod\s+-R|chown\s+-R|systemctl\s+restart)\b/i,
  },
  {
    risk: 'moderate',
    reason: 'Command changes dependency/runtime state and should be reviewed.',
    pattern: /\b(npm\s+install|pnpm\s+install|yarn\s+install|docker\s+compose\s+up|git\s+pull)\b/i,
  },
];

class RemoteApprovalBridge {
  constructor(options = {}) {
    this._tickets = new Map();
    this._onMutate = typeof options.onMutate === 'function' ? options.onMutate : null;
  }

  _notifyMutation(reason, payload = {}) {
    if (typeof this._onMutate !== 'function') return;
    try {
      this._onMutate({
        source: 'remote_approval_bridge',
        reason,
        payload,
      });
    } catch {
      /* ignore persistence callback failures */
    }
  }

  _sanitizeTicket(ticket) {
    if (!ticket || typeof ticket !== 'object') return null;
    const ticketId = String(ticket.ticket_id || '').trim();
    if (!ticketId) return null;
    return {
      ticket_id: ticketId,
      trace_id: ticket.trace_id || null,
      connection_id: ticket.connection_id || null,
      host_alias: ticket.host_alias || null,
      status: String(ticket.status || 'pending'),
      risk_level: String(ticket.risk_level || 'safe'),
      reason: String(ticket.reason || ''),
      idempotency_key: ticket.idempotency_key || null,
      commands: Array.isArray(ticket.commands) ? ticket.commands.map((item) => ({
        command: String(item?.command || ''),
        risk: String(item?.risk || 'safe'),
        reason: String(item?.reason || ''),
      })) : [],
      risk_context: ticket.risk_context && typeof ticket.risk_context === 'object'
        ? { ...ticket.risk_context }
        : null,
      created_at: ticket.created_at || new Date().toISOString(),
      expires_at: ticket.expires_at || null,
      approved_by: ticket.approved_by || null,
      approved_at: ticket.approved_at || null,
      rejected_by: ticket.rejected_by || null,
      rejected_at: ticket.rejected_at || null,
      rejected_reason: ticket.rejected_reason || null,
      consumed_at: ticket.consumed_at || null,
      consumed_by_idempotency_key: ticket.consumed_by_idempotency_key || null,
    };
  }

  classifyCommand(command) {
    const normalized = String(command || '').trim();
    if (!normalized) {
      return {
        command: normalized,
        risk: 'safe',
        reason: 'Empty command is treated as safe for validation only.',
      };
    }

    for (const rule of RISK_PATTERNS) {
      if (rule.pattern.test(normalized)) {
        return {
          command: normalized,
          risk: rule.risk,
          reason: rule.reason,
        };
      }
    }

    return {
      command: normalized,
      risk: 'safe',
      reason: 'No high-risk pattern detected.',
    };
  }

  evaluateCommands(commands) {
    const list = Array.isArray(commands) ? commands : [];
    const perCommand = list.map((item) => this.classifyCommand(item));

    const highest = perCommand.reduce((current, next) => {
      if (!current) return next;
      return RISK_WEIGHT[next.risk] > RISK_WEIGHT[current.risk] ? next : current;
    }, null) || { risk: 'safe', reason: 'No commands provided.', command: '' };

    const requiresApproval = RISK_WEIGHT[highest.risk] >= RISK_WEIGHT.dangerous;

    return {
      perCommand,
      highestRisk: highest.risk,
      highestReason: highest.reason,
      requiresApproval,
    };
  }

  createTicket({ traceId, connectionId, hostAlias, commands, idempotencyKey, riskContext = null }) {
    const evaluation = this.evaluateCommands(commands);
    const nowIso = new Date().toISOString();

    const ticket = {
      ticket_id: crypto.randomUUID(),
      trace_id: traceId || null,
      connection_id: connectionId || null,
      host_alias: hostAlias || null,
      status: 'pending',
      risk_level: evaluation.highestRisk,
      reason: evaluation.highestReason,
      idempotency_key: idempotencyKey || null,
      commands: evaluation.perCommand,
      risk_context: riskContext,
      created_at: nowIso,
      expires_at: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
      consumed_at: null,
      consumed_by_idempotency_key: null,
    };

    this._tickets.set(ticket.ticket_id, ticket);
    this._notifyMutation('create_ticket', { ticket_id: ticket.ticket_id });
    return { ...ticket };
  }

  approveTicket(ticketId, approvedBy = null) {
    const key = String(ticketId || '').trim();
    if (!key) return null;
    const ticket = this._tickets.get(key);
    if (!ticket) return null;

    ticket.status = 'approved';
    ticket.approved_by = approvedBy || null;
    ticket.approved_at = new Date().toISOString();
    this._notifyMutation('approve_ticket', { ticket_id: ticket.ticket_id });
    return { ...ticket };
  }

  rejectTicket(ticketId, rejectedBy = null, reason = 'rejected_by_reviewer') {
    const key = String(ticketId || '').trim();
    if (!key) return null;
    const ticket = this._tickets.get(key);
    if (!ticket) return null;

    ticket.status = 'rejected';
    ticket.rejected_by = rejectedBy || null;
    ticket.rejected_at = new Date().toISOString();
    ticket.rejected_reason = String(reason || 'rejected_by_reviewer');
    this._notifyMutation('reject_ticket', { ticket_id: ticket.ticket_id });
    return { ...ticket };
  }

  consumeApprovedTicket(ticketId, idempotencyKey) {
    const key = String(ticketId || '').trim();
    if (!key) {
      return { ok: false, code: 'ticket_id_required', message: 'approval ticket id is required.' };
    }
    const ticket = this._tickets.get(key);
    if (!ticket) {
      return { ok: false, code: 'ticket_not_found', message: 'approval ticket not found.' };
    }
    if (ticket.status !== 'approved') {
      return { ok: false, code: 'ticket_not_approved', message: `approval ticket status is ${ticket.status}.` };
    }
    if (ticket.consumed_at) {
      return { ok: false, code: 'ticket_already_consumed', message: 'approval ticket has already been consumed.' };
    }
    if (ticket.idempotency_key && idempotencyKey && ticket.idempotency_key !== idempotencyKey) {
      return { ok: false, code: 'idempotency_key_mismatch', message: 'idempotency_key does not match approval ticket.' };
    }

    ticket.consumed_at = new Date().toISOString();
    ticket.consumed_by_idempotency_key = idempotencyKey || null;
    this._notifyMutation('consume_ticket', { ticket_id: ticket.ticket_id });
    return { ok: true, ticket: { ...ticket } };
  }

  getTicket(ticketId) {
    const key = String(ticketId || '').trim();
    if (!key) return null;
    const ticket = this._tickets.get(key);
    return ticket ? { ...ticket } : null;
  }

  listPendingTickets() {
    return Array.from(this._tickets.values())
      .filter((ticket) => ticket.status === 'pending')
      .map((ticket) => ({ ...ticket }));
  }

  listTickets() {
    return Array.from(this._tickets.values()).map((ticket) => ({ ...ticket }));
  }

  exportState() {
    return this.listTickets();
  }

  importState(tickets = []) {
    this._tickets.clear();
    const nowMs = Date.now();
    const list = Array.isArray(tickets) ? tickets : [];
    for (const rawTicket of list) {
      const ticket = this._sanitizeTicket(rawTicket);
      if (!ticket) continue;

      const expiresMs = ticket.expires_at ? Date.parse(ticket.expires_at) : NaN;
      if (Number.isFinite(expiresMs) && expiresMs < nowMs && ticket.status === 'pending') {
        continue;
      }
      this._tickets.set(ticket.ticket_id, ticket);
    }
    this._notifyMutation('import_state', { total: this._tickets.size });
    return this._tickets.size;
  }

  clearAll() {
    this._tickets.clear();
    this._notifyMutation('clear_all');
  }
}

module.exports = {
  RemoteApprovalBridge,
  createRemoteApprovalBridge: (options = {}) => new RemoteApprovalBridge(options),
};
