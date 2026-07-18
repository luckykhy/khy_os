'use strict';

/**
 * sessionFileRepair.js — Structural validation and repair for session/conversation files.
 *
 * Ported from OpenClaw's session-file-repair.ts (321 lines).
 * Validates JSON session files for structural integrity, detects corruption,
 * and repairs by rebuilding from valid fragments. Uses atomic file replacement
 * to prevent data loss during repair.
 *
 * Key features:
 * - Structural validation: checks message ordering, role alternation, required fields
 * - Repair-by-rebuilding: extracts valid messages from corrupted files
 * - Atomic replacement: write to temp file → rename (no partial writes)
 * - Backup before repair: original file preserved as .bak
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ── Validation rules ──

const VALID_ROLES = new Set(['system', 'user', 'assistant', 'tool']);

const REQUIRED_MESSAGE_FIELDS = ['role', 'content'];

/**
 * @typedef {object} ValidationResult
 * @property {boolean} valid
 * @property {string[]} errors - Human-readable error descriptions
 * @property {string[]} warnings - Non-fatal issues
 * @property {number} messageCount
 * @property {number} repairable - Number of messages that can be salvaged
 */

/**
 * Validate a parsed session object.
 *
 * @param {object} session - Parsed session data
 * @returns {ValidationResult}
 */
function validateSession(session) {
  const errors = [];
  const warnings = [];
  let repairable = 0;

  if (!session || typeof session !== 'object') {
    return { valid: false, errors: ['Session is not a valid object'], warnings, messageCount: 0, repairable: 0 };
  }

  const messages = session.messages || session.conversation || [];
  if (!Array.isArray(messages)) {
    return { valid: false, errors: ['Messages field is not an array'], warnings, messageCount: 0, repairable: 0 };
  }

  if (messages.length === 0) {
    return { valid: true, errors, warnings: ['Session has no messages'], messageCount: 0, repairable: 0 };
  }

  let prevRole = null;
  let toolCallIds = new Set();
  let pendingToolCalls = new Set();

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];

    // Basic structure check
    if (!msg || typeof msg !== 'object') {
      errors.push(`Message ${i}: not an object`);
      continue;
    }

    // Required fields
    for (const field of REQUIRED_MESSAGE_FIELDS) {
      if (msg[field] === undefined && msg[field] !== null) {
        // content can be null for tool_call assistant messages
        if (field === 'content' && msg.role === 'assistant' && (msg.tool_calls || msg.toolCalls)) {
          continue;
        }
        errors.push(`Message ${i}: missing required field '${field}'`);
      }
    }

    // Role validation
    if (msg.role && !VALID_ROLES.has(msg.role)) {
      errors.push(`Message ${i}: invalid role '${msg.role}'`);
    }

    // Track tool_call / tool_result pairing
    if (msg.role === 'assistant') {
      const calls = msg.tool_calls || msg.toolCalls || [];
      for (const call of calls) {
        const callId = call.id || call.callId;
        if (callId) {
          if (toolCallIds.has(callId)) {
            warnings.push(`Message ${i}: duplicate tool_call id '${callId}'`);
          }
          toolCallIds.add(callId);
          pendingToolCalls.add(callId);
        }
      }
    }

    if (msg.role === 'tool') {
      const resultId = msg.tool_call_id || msg.toolCallId;
      if (resultId) {
        if (!toolCallIds.has(resultId)) {
          warnings.push(`Message ${i}: tool result references unknown call '${resultId}'`);
        }
        pendingToolCalls.delete(resultId);
      }
    }

    // Role alternation check (user/assistant should generally alternate)
    if (msg.role === 'user' && prevRole === 'user') {
      warnings.push(`Message ${i}: consecutive user messages`);
    }

    if (msg.role) {
      prevRole = msg.role;
      repairable++;
    }
  }

  // Check for orphaned tool calls
  if (pendingToolCalls.size > 0) {
    warnings.push(`${pendingToolCalls.size} tool call(s) without matching results`);
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    messageCount: messages.length,
    repairable,
  };
}

/**
 * Extract valid messages from a potentially corrupted session.
 * Preserves tool_call/result pairs; drops orphans.
 *
 * @param {object} session
 * @returns {object[]} repaired message array
 */
function extractValidMessages(session) {
  if (!session || typeof session !== 'object') return [];

  const messages = session.messages || session.conversation || [];
  if (!Array.isArray(messages)) return [];

  const valid = [];
  const toolCallMap = new Map(); // callId → assistant message index in valid[]

  for (const msg of messages) {
    if (!msg || typeof msg !== 'object') continue;
    if (!msg.role || !VALID_ROLES.has(msg.role)) continue;

    // Content must be present (or tool_calls for assistant)
    if (msg.content === undefined && msg.content !== null) {
      if (!(msg.role === 'assistant' && (msg.tool_calls || msg.toolCalls))) {
        continue;
      }
    }

    const idx = valid.length;
    valid.push({ ...msg });

    // Track tool calls from assistant messages
    if (msg.role === 'assistant') {
      const calls = msg.tool_calls || msg.toolCalls || [];
      for (const call of calls) {
        const callId = call.id || call.callId;
        if (callId) toolCallMap.set(callId, idx);
      }
    }
  }

  // Second pass: remove tool results that reference non-existent calls
  const repaired = [];
  for (const msg of valid) {
    if (msg.role === 'tool') {
      const resultId = msg.tool_call_id || msg.toolCallId;
      if (resultId && !toolCallMap.has(resultId)) {
        continue; // orphaned tool result
      }
    }
    repaired.push(msg);
  }

  return repaired;
}

/**
 * Repair a session file on disk.
 *
 * Steps:
 * 1. Read and parse the file
 * 2. Validate structure
 * 3. If invalid, extract valid messages and rebuild
 * 4. Write repaired file atomically (temp → rename)
 * 5. Backup original as .bak
 *
 * @param {string} filePath - Path to session file
 * @param {object} [opts]
 * @param {boolean} [opts.dryRun=false] - If true, validate but don't write
 * @param {boolean} [opts.backup=true] - If true, keep .bak of original
 * @returns {{ repaired: boolean, validation: ValidationResult, backupPath?: string }}
 */
function repairSessionFile(filePath, opts = {}) {
  const { dryRun = false, backup = true } = opts;

  // Read file
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    return {
      repaired: false,
      validation: {
        valid: false,
        errors: [`Cannot read file: ${err.message}`],
        warnings: [],
        messageCount: 0,
        repairable: 0,
      },
    };
  }

  // Parse JSON
  let session;
  try {
    session = JSON.parse(raw);
  } catch {
    // Try to recover from truncated JSON by finding valid prefix
    session = tryParsePartialJson(raw);
    if (!session) {
      return {
        repaired: false,
        validation: {
          valid: false,
          errors: ['File contains invalid JSON and cannot be parsed'],
          warnings: [],
          messageCount: 0,
          repairable: 0,
        },
      };
    }
  }

  // Validate
  const validation = validateSession(session);

  if (validation.valid && validation.warnings.length === 0) {
    return { repaired: false, validation };
  }

  if (dryRun) {
    return { repaired: false, validation };
  }

  // Extract valid messages and rebuild
  const repairedMessages = extractValidMessages(session);

  if (repairedMessages.length === 0 && validation.messageCount > 0) {
    return {
      repaired: false,
      validation: {
        ...validation,
        errors: [...validation.errors, 'No messages could be salvaged'],
      },
    };
  }

  // Build repaired session (preserve metadata)
  const repairedSession = { ...session };
  if (session.messages) {
    repairedSession.messages = repairedMessages;
  } else if (session.conversation) {
    repairedSession.conversation = repairedMessages;
  } else {
    repairedSession.messages = repairedMessages;
  }

  // Backup original
  let backupPath;
  if (backup) {
    backupPath = filePath + '.bak';
    try {
      fs.copyFileSync(filePath, backupPath);
    } catch {
      backupPath = undefined;
    }
  }

  // Atomic write: temp file → rename
  const tmpPath = filePath + '.tmp.' + crypto.randomBytes(4).toString('hex');
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(repairedSession, null, 2), 'utf8');
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    // Clean up temp file on failure
    try { fs.unlinkSync(tmpPath); } catch { /* ignore */ }
    return {
      repaired: false,
      validation: {
        ...validation,
        errors: [...validation.errors, `Failed to write repaired file: ${err.message}`],
      },
    };
  }

  return {
    repaired: true,
    validation: {
      valid: true,
      errors: [],
      warnings: [`Repaired: ${validation.messageCount} → ${repairedMessages.length} messages`],
      messageCount: repairedMessages.length,
      repairable: repairedMessages.length,
    },
    backupPath,
  };
}

/**
 * Attempt to parse truncated JSON by finding the last valid closing bracket.
 *
 * @param {string} raw
 * @returns {object|null}
 */
function tryParsePartialJson(raw) {
  // Try progressively shorter substrings ending with } or ]
  const trimmed = raw.trimEnd();

  for (let i = trimmed.length; i > 0; i--) {
    const ch = trimmed[i - 1];
    if (ch === '}' || ch === ']') {
      try {
        return JSON.parse(trimmed.slice(0, i));
      } catch {
        continue;
      }
    }
  }

  return null;
}

/**
 * Validate a session file without repairing.
 *
 * @param {string} filePath
 * @returns {ValidationResult}
 */
function validateSessionFile(filePath) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    return { valid: false, errors: [`Cannot read file: ${err.message}`], warnings: [], messageCount: 0, repairable: 0 };
  }

  let session;
  try {
    session = JSON.parse(raw);
  } catch {
    return { valid: false, errors: ['Invalid JSON'], warnings: [], messageCount: 0, repairable: 0 };
  }

  return validateSession(session);
}

module.exports = {
  validateSession,
  validateSessionFile,
  extractValidMessages,
  repairSessionFile,
  tryParsePartialJson,
};
