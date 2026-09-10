'use strict';

/**
 * sessionSyncService.js — Cross-platform conversation state synchronization.
 *
 * Maintains a shared conversation store that all platforms (terminal, web, desktop,
 * mobile) can read and write to. Changes propagate in real-time via the crossPlatformHub.
 *
 * Storage:
 *   - In-memory active sessions for fast access
 *   - Persistent storage in ~/.khyquant/sync/conversations/
 *
 * Sync strategy:
 *   - Each conversation has a version vector for conflict resolution
 *   - Last-write-wins for simple fields, merge for messages array
 *   - Full state broadcast on change (delta computation is platform-agnostic)
 *
 * @module services/crossPlatform/sessionSyncService
 */

const fs = require('fs');
const path = require('path');
const { EventEmitter } = require('events');
const crypto = require('crypto');

let _instance = null;

class SessionSyncService extends EventEmitter {
  constructor() {
    super();
    this._hub = null;
    this._syncDir = null;
    this._activeSessions = new Map();
    this._started = false;
  }

  static getInstance() {
    if (!_instance) {
      _instance = new SessionSyncService();
    }
    return _instance;
  }

  /**
   * Initialize session sync with the hub.
   * @param {object} hub - CrossPlatformHub instance
   * @param {string} syncDir - Path to persistent sync storage
   */
  initialize(hub, syncDir) {
    if (this._started) {
      return;
    }

    this._hub = hub;
    this._syncDir = syncDir;

    // Ensure sync directory exists
    try {
      fs.mkdirSync(this._syncDir, { recursive: true });
    } catch {
      // Directory already exists or permission denied
    }

    // Subscribe to hub events
    this._hub.on('session:updated', ({ sessionId, session, sourceDeviceId }) => {
      this._persistSession(sessionId, session);
      this.emit('sync:updated', { sessionId, session, sourceDeviceId });
    });

    this._hub.on('presence:broadcast', (message) => {
      this.emit('presence:update', message);
    });

    this._started = true;
  }

  // ── Conversation CRUD ──────────────────────────────────────────────

  /**
   * Create a new shared conversation.
   * @param {object} options
   * @param {string} options.title - Conversation title
   * @param {string} options.userId - Owner user ID
   * @param {string} [options.platform] - Platform that created it
   * @param {string} [options.model] - AI model to use
   * @param {object} [options.metadata] - Additional metadata
   * @returns {object} Created conversation
   */
  createConversation(options) {
    const {
      title = '新建对话',
      userId = 'anonymous',
      platform = 'unknown',
      model = null,
      metadata = {},
    } = options;

    const conversationId = crypto.randomBytes(12).toString('hex');
    const now = Date.now();

    const conversation = {
      id: conversationId,
      title,
      userId,
      platform,
      model,
      metadata,
      messages: [],
      state: {
        status: 'idle',     // idle | processing | waiting_approval | error
        contextTokens: 0,
        totalTokens: 0,
        currentTool: null,
        thinkingContent: '',
      },
      version: 1,
      createdAt: now,
      updatedAt: now,
      createdBy: platform,
      lastModifiedBy: platform,
      participants: [{ platform, deviceId: null, joinedAt: now }],
    };

    this._activeSessions.set(conversationId, conversation);
    this._hub.registerSession(conversationId, { userId, platform });

    this._persistSession(conversationId, conversation);
    this.emit('conversation:created', conversation);
    return conversation;
  }

  /**
   * Get a conversation by ID.
   * @param {string} conversationId
   */
  getConversation(conversationId) {
    // Check memory first
    let conversation = this._activeSessions.get(conversationId);

    // Fall back to disk
    if (!conversation) {
      conversation = this._loadFromDisk(conversationId);
      if (conversation) {
        this._activeSessions.set(conversationId, conversation);
      }
    }

    return conversation ? { ...conversation } : null;
  }

  /**
   * List conversations for a user.
   * @param {string} userId
   * @param {object} [options]
   * @param {number} [options.limit=50]
   * @param {number} [options.offset=0]
   * @param {string} [options.platform] - Filter by platform
   */
  listConversations(userId, options = {}) {
    const { limit = 50, offset = 0, platform } = options;

    const conversations = [];

    // Load from memory
    for (const conv of this._activeSessions.values()) {
      if (conv.userId === userId) {
        if (!platform || conv.platform === platform) {
          conversations.push({ ...conv });
        }
      }
    }

    // Also scan disk for conversations not in memory
    try {
      const files = fs.readdirSync(this._syncDir);
      for (const file of files) {
        if (!file.endsWith('.json')) {
          continue;
        }
        const conversationId = file.replace('.json', '');

        // Skip if already in memory
        if (this._activeSessions.has(conversationId)) {
          continue;
        }

        const conversation = this._loadFromDisk(conversationId);
        if (conversation && conversation.userId === userId) {
          if (!platform || conversation.platform === platform) {
            conversations.push({ ...conversation });
          }
        }
      }
    } catch {
      // Directory not accessible
    }

    // Sort by updatedAt descending
    conversations.sort((a, b) => b.updatedAt - a.updatedAt);

    return conversations.slice(offset, offset + limit);
  }

  /**
   * Add a message to a conversation.
   * @param {string} conversationId
   * @param {object} message
   * @param {string} message.role - user | assistant | system | tool
   * @param {string} message.content
   * @param {string} [message.platform] - Source platform
   * @param {object} [message.metadata]
   */
  addMessage(conversationId, message) {
    const conversation = this._activeSessions.get(conversationId);
    if (!conversation) {
      return null;
    }

    const msg = {
      id: crypto.randomBytes(8).toString('hex'),
      role: message.role,
      content: message.content,
      platform: message.platform || 'unknown',
      metadata: message.metadata || {},
      timestamp: Date.now(),
    };

    conversation.messages.push(msg);
    conversation.updatedAt = Date.now();
    conversation.version = (conversation.version || 0) + 1;
    conversation.lastModifiedBy = message.platform || 'unknown';

    // Update token counts
    if (message.metadata?.tokens) {
      conversation.state.totalTokens += message.metadata.tokens;
    }

    this._persistSession(conversationId, conversation);
    this.emit('conversation:message', { conversationId, message: msg });
    return msg;
  }

  /**
   * Update conversation state.
   * @param {string} conversationId
   * @param {object} stateUpdate
   * @param {string} sourceDeviceId
   */
  updateState(conversationId, stateUpdate, sourceDeviceId) {
    const conversation = this._activeSessions.get(conversationId);
    if (!conversation) {
      return null;
    }

    conversation.state = { ...conversation.state, ...stateUpdate };
    conversation.updatedAt = Date.now();
    conversation.version = (conversation.version || 0) + 1;
    conversation.lastModifiedBy = sourceDeviceId;

    // Sync via hub
    this._hub.updateSession(conversationId, conversation.state, sourceDeviceId);

    this._persistSession(conversationId, conversation);
    this.emit('conversation:state', { conversationId, state: conversation.state });
    return conversation.state;
  }

  /**
   * Set conversation participants (which platforms are viewing).
   * @param {string} conversationId
   * @param {Array<object>} participants
   */
  setParticipants(conversationId, participants) {
    const conversation = this._activeSessions.get(conversationId);
    if (!conversation) {
      return null;
    }

    conversation.participants = participants;
    conversation.updatedAt = Date.now();
    this._persistSession(conversationId, conversation);
    return conversation.participants;
  }

  /**
   * Join a conversation from a platform.
   * @param {string} conversationId
   * @param {object} participant
   * @param {string} participant.platform
   * @param {string} [participant.deviceId]
   */
  joinConversation(conversationId, participant) {
    const conversation = this._activeSessions.get(conversationId);
    if (!conversation) {
      return null;
    }

    const existing = conversation.participants.find(
      (p) => p.platform === participant.platform && p.deviceId === participant.deviceId
    );

    if (!existing) {
      conversation.participants.push({
        platform: participant.platform,
        deviceId: participant.deviceId || null,
        joinedAt: Date.now(),
      });
      conversation.updatedAt = Date.now();
      this._persistSession(conversationId, conversation);
    }

    return { ...conversation };
  }

  /**
   * Delete a conversation.
   * @param {string} conversationId
   */
  deleteConversation(conversationId) {
    this._activeSessions.delete(conversationId);
    this._hub.deleteSession(conversationId);

    try {
      const filePath = this._getFilePath(conversationId);
      fs.unlinkSync(filePath);
    } catch {
      // File doesn't exist
    }

    this.emit('conversation:deleted', { conversationId });
  }

  // ── Real-time Sync ─────────────────────────────────────────────────

  /**
   * Broadcast a conversation update to all connected platforms.
   * @param {string} conversationId
   * @param {string} sourceDeviceId
   */
  broadcastUpdate(conversationId, sourceDeviceId) {
    const conversation = this._activeSessions.get(conversationId);
    if (!conversation) {
      return;
    }

    this._hub.updateSession(conversationId, conversation.state, sourceDeviceId);
  }

  /**
   * Sync a conversation from another platform to local state.
   * Used when a platform receives a sync message.
   * @param {string} conversationId
   * @param {object} remoteState
   */
  syncFromRemote(conversationId, remoteState) {
    const conversation = this._activeSessions.get(conversationId);
    if (!conversation) {
      return null;
    }

    // Merge strategy: remote wins for conflicting simple fields
    // Messages are concatenated (dedup by id)
    if (remoteState.messages) {
      const existingIds = new Set(conversation.messages.map((m) => m.id));
      for (const msg of remoteState.messages) {
        if (!existingIds.has(msg.id)) {
          conversation.messages.push(msg);
        }
      }
      conversation.messages.sort((a, b) => a.timestamp - b.timestamp);
    }

    if (remoteState.state) {
      conversation.state = { ...conversation.state, ...remoteState.state };
    }

    conversation.updatedAt = Date.now();
    conversation.version = Math.max(conversation.version || 0, remoteState.version || 0);

    this._persistSession(conversationId, conversation);
    this.emit('sync:merged', { conversationId, conversation });
    return conversation;
  }

  // ── Persistence ────────────────────────────────────────────────────

  _getFilePath(conversationId) {
    return path.join(this._syncDir, `${conversationId}.json`);
  }

  _persistSession(conversationId, conversation) {
    try {
      const filePath = this._getFilePath(conversationId);
      const tmpPath = filePath + '.tmp';
      fs.writeFileSync(tmpPath, JSON.stringify(conversation, null, 2), 'utf-8');
      fs.renameSync(tmpPath, filePath);
    } catch {
      // Permission denied or disk full
    }
  }

  _loadFromDisk(conversationId) {
    try {
      const filePath = this._getFilePath(conversationId);
      const data = fs.readFileSync(filePath, 'utf-8');
      return JSON.parse(data);
    } catch {
      return null;
    }
  }

  // ── Status ─────────────────────────────────────────────────────────

  getStatus() {
    return {
      started: this._started,
      activeSessions: this._activeSessions.size,
      syncDir: this._syncDir,
    };
  }
}

// ── Module exports ────────────────────────────────────────────────────

const service = SessionSyncService.getInstance();

module.exports = {
  service,
  SessionSyncService,
};
