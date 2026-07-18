const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Resolve data root: bundled mode via KHY_BUNDLED_ROOT, dev mode via repo root
function resolveKhyDataRoot() {
  const bundledRoot = process.env.KHY_BUNDLED_ROOT;
  if (bundledRoot) {
    return path.join(bundledRoot, '.khy');
  }
  // Dev mode: go up from services/backend/src/services/ to repo root
  const repoRoot = path.resolve(__dirname, '..', '..', '..', '..');
  return path.join(repoRoot, '.khy');
}

const DATA_DIR = path.join(resolveKhyDataRoot(), 'growth');
const DATA_FILE = path.join(DATA_DIR, 'skill_gaps.json');
const MAX_RECORDS = 200;

// Ensure data directory exists
function ensureDir() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
  }
}

// Read gaps from disk, return empty array on any error
function readGaps() {
  try {
    const raw = fs.readFileSync(DATA_FILE, 'utf-8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

// Write gaps to disk with error handling
function writeGaps(gaps) {
  ensureDir();
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(gaps, null, 2), 'utf-8');
  } catch (err) {
    console.error('[skillGapRecorder] Failed to write gaps file:', err.message);
  }
}

/**
 * Record a skill gap. If the same (domain, taskType) already exists,
 * update lastSeen and increment count instead of creating a duplicate.
 */
function recordGap({ domain, taskType, description, missingCapabilities, confidence, timestamp }) {
  const gaps = readGaps();
  const ts = timestamp || new Date().toISOString();
  const existing = gaps.find(g => g.domain === domain && g.taskType === taskType);

  if (existing) {
    existing.lastSeen = ts;
    existing.count += 1;
    // Update description/capabilities if provided
    if (description) existing.description = description;
    if (missingCapabilities) existing.missingCapabilities = missingCapabilities;
    if (confidence !== undefined) existing.confidence = confidence;
  } else {
    gaps.push({
      id: crypto.randomUUID().slice(0, 8),
      domain,
      taskType,
      description: description || '',
      missingCapabilities: missingCapabilities || [],
      confidence: confidence || 0,
      firstSeen: ts,
      lastSeen: ts,
      count: 1,
      resolved: false,
    });
  }

  // LRU eviction: keep at most MAX_RECORDS entries
  if (gaps.length > MAX_RECORDS) {
    gaps.sort((a, b) => new Date(b.lastSeen) - new Date(a.lastSeen));
    gaps.length = MAX_RECORDS;
  }

  writeGaps(gaps);
  return existing ? 'updated' : 'created';
}

/**
 * List skill gaps, optionally filtered by domain.
 * Results sorted by count descending.
 */
function listGaps(filter) {
  let gaps = readGaps();
  if (filter && filter.domain) {
    gaps = gaps.filter(g => g.domain === filter.domain);
  }
  gaps.sort((a, b) => b.count - a.count);
  return gaps;
}

/**
 * Mark a specific gap as resolved by its ID.
 * Returns true if found and updated, false otherwise.
 */
function markResolved(gapId) {
  const gaps = readGaps();
  const gap = gaps.find(g => g.id === gapId);
  if (!gap) return false;

  gap.resolved = true;
  writeGaps(gaps);
  return true;
}

/**
 * Aggregate stats by domain: total gaps and unresolved gaps.
 */
function getStats() {
  const gaps = readGaps();
  const domainMap = new Map();

  for (const g of gaps) {
    if (!domainMap.has(g.domain)) {
      domainMap.set(g.domain, { domain: g.domain, totalGaps: 0, unresolvedGaps: 0 });
    }
    const entry = domainMap.get(g.domain);
    entry.totalGaps += 1;
    if (!g.resolved) entry.unresolvedGaps += 1;
  }

  return Array.from(domainMap.values());
}

module.exports = {
  recordGap,
  listGaps,
  markResolved,
  getStats,
};
