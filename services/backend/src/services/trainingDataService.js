/**
 * Training Data Collector — records user-AI interactions for model fine-tuning
 *
 * Architecture concept ("水厂模型"):
 * - Local base model (qwen3.5:4b) = "火锅基底"
 * - User interaction logs = "食材与方法改进"
 * - Continuously collected data enables periodic model fine-tuning
 *
 * Storage: JSONL format (compatible with OpenAI, Hugging Face, llama.cpp training)
 * Each line is a complete conversation turn suitable for SFT (supervised fine-tuning).
 */
const fs = require('fs');
const fsp = require('fs').promises;
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = process.env.TRAINING_DATA_DIR
  || path.join(__dirname, '../../data/training');
const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB per file, then rotate
const MAX_TOTAL_SIZE = parseInt(process.env.TRAINING_MAX_SIZE_MB || '500', 10) * 1024 * 1024; // 500MB default cap
const RETENTION_DAYS = parseInt(process.env.TRAINING_RETENTION_DAYS || '90', 10); // 90 days default

let _currentFile = null;
let _currentSize = 0;
let _fileIndex = 0;
let _totalRecords = 0;

/**
 * Ensure data directory exists.
 */
function ensureDataDir() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

/**
 * Get current output file path (auto-rotate when too large).
 */
function getOutputPath() {
  if (!_currentFile || _currentSize > MAX_FILE_SIZE) {
    ensureDataDir();
    const dateStr = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    _fileIndex++;
    _currentFile = path.join(DATA_DIR, `interactions_${dateStr}_${_fileIndex}.jsonl`);
    _currentSize = 0;
    if (fs.existsSync(_currentFile)) {
      _currentSize = fs.statSync(_currentFile).size;
    }
  }
  return _currentFile;
}

/**
 * Record a single interaction turn.
 *
 * @param {Object} record
 * @param {string} record.userId - Anonymous user identifier
 * @param {string} record.sessionId - Conversation session ID
 * @param {Array} record.messages - [{role, content}] conversation messages
 * @param {string} record.response - AI response text
 * @param {string} record.model - Model used (e.g., 'qwen3.5:4b', 'Local (qwen3.5:4b)')
 * @param {string} record.intent - Detected intent category
 * @param {number} [record.rating] - User feedback rating (1-5, null if not rated)
 * @param {boolean} [record.thumbsUp] - Quick feedback (true/false/null)
 * @param {Object} [record.metadata] - Additional metadata
 */
function recordInteraction(record) {
  try {
    const entry = {
      timestamp: new Date().toISOString(),
      version: '1.0',
      user_id: anonymizeId(record.userId),
      session_id: record.sessionId || null,
      messages: sanitizeMessages(record.messages || []),
      response: record.response || '',
      model: record.model || 'unknown',
      intent: record.intent || 'general',
      rating: record.rating || null,
      thumbs_up: record.thumbsUp ?? null,
      response_time_ms: record.responseTimeMs || null,
      metadata: {
        source: record.metadata?.source || 'web',
        adapter: record.metadata?.adapter || null,
        tokens_used: record.metadata?.tokensUsed || null,
      },
    };

    const line = JSON.stringify(entry) + '\n';
    const filePath = getOutputPath();
    // Non-blocking write
    fsp.appendFile(filePath, line, 'utf-8').catch(err => {
      console.error('[TrainingData] Async write failed:', err.message);
    });
    _currentSize += Buffer.byteLength(line);
    _totalRecords++;

    return true;
  } catch (err) {
    console.error('[TrainingData] Failed to record interaction:', err.message);
    return false;
  }
}

/**
 * Record user feedback on a previous response.
 */
function recordFeedback(sessionId, messageIndex, feedback) {
  try {
    const entry = {
      timestamp: new Date().toISOString(),
      type: 'feedback',
      session_id: sessionId,
      message_index: messageIndex,
      rating: feedback.rating || null,
      thumbs_up: feedback.thumbsUp ?? null,
      correction: feedback.correction || null,
      comment: feedback.comment || null,
    };

    const line = JSON.stringify(entry) + '\n';
    const filePath = getOutputPath();
    // Non-blocking write
    fsp.appendFile(filePath, line, 'utf-8').catch(err => {
      console.error('[TrainingData] Async write failed:', err.message);
    });
    _currentSize += Buffer.byteLength(line);

    return true;
  } catch (err) {
    console.error('[TrainingData] Failed to record feedback:', err.message);
    return false;
  }
}

/**
 * Anonymize user ID (hash to prevent PII leakage in training data).
 */
function anonymizeId(userId) {
  if (!userId) return 'anonymous';
  return crypto.createHash('sha256').update(String(userId)).digest('hex').slice(0, 32);
}

/**
 * Sanitize messages for training (remove PII patterns).
 */
function sanitizeMessages(messages) {
  return messages.map(msg => ({
    role: msg.role,
    content: String(msg.content || '')
      // Remove Chinese mobile phone numbers (1[3-9]xxxxxxxxx)
      .replace(/1[3-9]\d{9}/g, '[PHONE]')
      // Remove Chinese ID card numbers (18 digits ending with digit or X)
      .replace(/\d{17}[\dXx]/g, '[ID]')
      // Remove email addresses
      .replace(/[\w.-]+@[\w.-]+\.\w+/g, '[EMAIL]')
      // Remove bank card numbers (13-19 digits, with optional spaces/dashes)
      .replace(/\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4,7}\b/g, '[BANKCARD]')
      // Remove IP addresses
      .replace(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/g, '[IP]')
      // Keep everything else
  }));
}

/**
 * Export training data in SFT format (for fine-tuning).
 * Returns conversations formatted for standard training pipelines.
 */
function exportForTraining(options = {}) {
  const { minRating = 0, format = 'chatml' } = options;
  ensureDataDir();

  const files = fs.readdirSync(DATA_DIR).filter(f => f.endsWith('.jsonl')).sort();
  const conversations = [];

  for (const file of files) {
    const lines = fs.readFileSync(path.join(DATA_DIR, file), 'utf-8').split(/\r?\n/).filter(Boolean);
    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        if (entry.type === 'feedback') continue; // Skip feedback-only entries
        if (minRating > 0 && (entry.rating || 0) < minRating) continue;

        if (format === 'chatml') {
          // ChatML format (compatible with Qwen training)
          const conv = {
            conversations: [
              ...entry.messages.map(m => ({ from: m.role === 'user' ? 'human' : 'gpt', value: m.content })),
              { from: 'gpt', value: entry.response },
            ],
          };
          conversations.push(conv);
        } else if (format === 'openai') {
          // OpenAI fine-tuning format
          const conv = {
            messages: [
              ...entry.messages,
              { role: 'assistant', content: entry.response },
            ],
          };
          conversations.push(conv);
        }
      } catch { /* skip malformed lines */ }
    }
  }

  return conversations;
}

/**
 * Get statistics about collected training data.
 */
function getStats() {
  ensureDataDir();

  const files = fs.readdirSync(DATA_DIR).filter(f => f.endsWith('.jsonl'));
  let totalSize = 0;
  let totalLines = 0;

  for (const file of files) {
    const stat = fs.statSync(path.join(DATA_DIR, file));
    totalSize += stat.size;
    const content = fs.readFileSync(path.join(DATA_DIR, file), 'utf-8');
    totalLines += content.split('\n').filter(Boolean).length;
  }

  return {
    dataDir: DATA_DIR,
    files: files.length,
    totalRecords: totalLines,
    totalSizeMB: (totalSize / (1024 * 1024)).toFixed(2),
    maxSizeMB: (MAX_TOTAL_SIZE / (1024 * 1024)).toFixed(0),
    retentionDays: RETENTION_DAYS,
    sessionRecords: _totalRecords,
  };
}

/**
 * Purge training data files older than RETENTION_DAYS.
 * Returns { deleted: number, freedMB: string }.
 */
function purgeExpired() {
  ensureDataDir();
  const cutoff = Date.now() - RETENTION_DAYS * 86400_000;
  const files = fs.readdirSync(DATA_DIR).filter(f => f.endsWith('.jsonl')).sort();
  let deleted = 0;
  let freedBytes = 0;

  for (const file of files) {
    const filePath = path.join(DATA_DIR, file);
    const stat = fs.statSync(filePath);
    if (stat.mtimeMs < cutoff) {
      freedBytes += stat.size;
      fs.unlinkSync(filePath);
      deleted++;
    }
  }

  // Reset state if current file was deleted
  if (_currentFile && !fs.existsSync(_currentFile)) {
    _currentFile = null;
    _currentSize = 0;
  }

  return { deleted, freedMB: (freedBytes / (1024 * 1024)).toFixed(2) };
}

/**
 * Enforce MAX_TOTAL_SIZE by deleting oldest files first.
 * Returns { deleted: number, freedMB: string }.
 */
function enforceSizeLimit() {
  ensureDataDir();
  const files = fs.readdirSync(DATA_DIR).filter(f => f.endsWith('.jsonl')).sort(); // oldest first
  let totalSize = 0;
  const fileSizes = [];

  for (const file of files) {
    const stat = fs.statSync(path.join(DATA_DIR, file));
    totalSize += stat.size;
    fileSizes.push({ file, size: stat.size });
  }

  let deleted = 0;
  let freedBytes = 0;

  // Delete oldest files until under limit
  while (totalSize > MAX_TOTAL_SIZE && fileSizes.length > 0) {
    const oldest = fileSizes.shift();
    const filePath = path.join(DATA_DIR, oldest.file);
    fs.unlinkSync(filePath);
    totalSize -= oldest.size;
    freedBytes += oldest.size;
    deleted++;
  }

  if (_currentFile && !fs.existsSync(_currentFile)) {
    _currentFile = null;
    _currentSize = 0;
  }

  return { deleted, freedMB: (freedBytes / (1024 * 1024)).toFixed(2) };
}

/**
 * Delete all raw JSONL files (call after successful export + training).
 * Returns { deleted: number, freedMB: string }.
 */
function purgeAll() {
  ensureDataDir();
  const files = fs.readdirSync(DATA_DIR).filter(f => f.endsWith('.jsonl'));
  let freedBytes = 0;

  for (const file of files) {
    const filePath = path.join(DATA_DIR, file);
    freedBytes += fs.statSync(filePath).size;
    fs.unlinkSync(filePath);
  }

  _currentFile = null;
  _currentSize = 0;
  _fileIndex = 0;

  return { deleted: files.length, freedMB: (freedBytes / (1024 * 1024)).toFixed(2) };
}

/**
 * Run periodic maintenance: purge expired files + enforce size limit.
 * Safe to call from a cron job or on server startup.
 */
function runMaintenance() {
  const expired = purgeExpired();
  const sized = enforceSizeLimit();
  const total = {
    expiredDeleted: expired.deleted,
    sizeDeleted: sized.deleted,
    totalFreedMB: (parseFloat(expired.freedMB) + parseFloat(sized.freedMB)).toFixed(2),
  };
  if (total.expiredDeleted + total.sizeDeleted > 0) {
    console.log(`[TrainingData] Maintenance: deleted ${total.expiredDeleted} expired + ${total.sizeDeleted} over-limit files, freed ${total.totalFreedMB}MB`);
  }
  return total;
}

module.exports = {
  recordInteraction,
  recordFeedback,
  exportForTraining,
  getStats,
  purgeExpired,
  enforceSizeLimit,
  purgeAll,
  runMaintenance,
};
