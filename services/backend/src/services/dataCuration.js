/**
 * dataCuration.js — zero-dependency dataset curation for khy-os training data.
 *
 * Borrows the distilabel patterns (MinHashLSH dedup + DEITA three-axis
 * scoring + train/val split) but implements them as pure Node functions so
 * no Python dependency (datasketch) is required and the module is unit
 * testable in isolation.
 *
 * Axes (DEITA — Gao et al. 2024):
 *   - diversity:   novelty of this record's shingle set vs. already-kept records
 *   - quality:     log-length + information density (deterministic proxy,
 *                  independent of user thumbs which are 100% neutral today)
 *   - complexity:  weighted count of code/formula/list markers
 *
 * All functions are pure (no fs, no process.env) except `curateDataset`
 * which composes them.
 */

/**
 * Character-shingle multiset for a text (N-gram of length N).
 * @param {string} text
 * @param {number} n
 * @returns {string[]} sorted unique shingles
 */
function shingles(text, n = 6) {
  const s = String(text || '').replace(/\s+/g, ' ').trim();
  if (s.length < n) return s ? [s] : [];
  const set = new Set();
  for (let i = 0; i <= s.length - n; i++) {
    set.add(s.slice(i, i + n));
  }
  return Array.from(set);
}

/**
 * Jaccard similarity over two shingle sets (intersection / union).
 * @param {string[]} a
 * @param {string[]} b
 * @returns {number} 0..1
 */
function jaccard(a, b) {
  if (!a.length || !b.length) return 0;
  const setB = new Set(b);
  let inter = 0;
  for (const x of a) if (setB.has(x)) inter++;
  const union = new Set([...a, ...b]).size;
  return union === 0 ? 0 : inter / union;
}

/**
 * Near-duplicate removal via shingle Jaccard.
 * O(n^2) over kept records; acceptable up to ~10k records because each
 * shingle set is bounded by instruction length (<= 12000 chars -> ~12k
 * shingles, but dedup short-circuits on the first kept record whose
 * similarity exceeds threshold).
 *
 * @param {Array<{instruction?: string, output?: string, [k: string]: any}>} records
 * @param {object} [opts]
 * @param {number} [opts.shingleN=6]
 * @param {number} [opts.threshold=0.6] — Jaccard above this = duplicate
 * @returns {{ kept: Array, dropped: Array<{index: number, dupOf: number, similarity: number}>, report: { total: number, kept: number, dropped: number, threshold: number } }}
 */
function shingleDedupe(records, opts = {}) {
  const n = opts.shingleN ?? 6;
  const threshold = opts.threshold ?? 0.6;
  const kept = [];
  const keptShingles = [];
  const dropped = [];

  for (let i = 0; i < records.length; i++) {
    const text = `${records[i].instruction || ''}\n${records[i].output || ''}`;
    const mine = shingles(text, n);
    let dupOf = -1;
    let bestSim = 0;
    for (let j = 0; j < keptShingles.length; j++) {
      const sim = jaccard(mine, keptShingles[j]);
      if (sim > bestSim) {
        bestSim = sim;
        dupOf = j;
      }
      if (bestSim >= threshold) break; // short-circuit on first near-dup
    }
    if (dupOf >= 0) {
      dropped.push({ index: i, dupOf, similarity: bestSim });
    } else {
      kept.push(records[i]);
      keptShingles.push(mine);
    }
  }

  return {
    kept,
    dropped,
    report: {
      total: records.length,
      kept: kept.length,
      dropped: dropped.length,
      threshold,
      shingleN: n,
    },
  };
}

/**
 * DEITA three-axis score for a single record (0..1).
 * Deterministic — does NOT read user feedback (quality field is 100% neutral).
 *
 * @param {object} record — training record with `instruction` / `output`
 * @param {Set<string>} [noveltyBaseline] — shingle set of already-kept records (for diversity axis)
 * @returns {{ score: number, quality: number, complexity: number, diversity: number }}
 */
function deitaScore(record, noveltyBaseline) {
  const instruction = String(record.instruction || '');
  const output = String(record.output || '');

  // ── quality axis: log-length + information density ──
  const len = output.length;
  const logLen = len > 0 ? Math.min(1, Math.log(len + 1) / Math.log(32001)) : 0;
  const dense =
    len > 0
      ? output.replace(/\s+/g, '').replace(/[0-9.,;:!?~`'"\\-]+/g, '').length / len
      : 0;
  const quality = 0.5 * logLen + 0.5 * dense;

  // ── complexity axis: code / formula / list markers (capped at 1) ──
  let complexity = 0;
  complexity += Math.min(1, (output.match(/```/g) || []).length / 2) * 0.4; // code blocks
  complexity += Math.min(1, (output.match(/\d+(?:\.\d+)?\s*%/g) || []).length / 5) * 0.2; // percentages
  complexity += Math.min(1, (output.match(/^\s*[•\-\*]\s+/gm) || []).length / 3) * 0.2; // list items
  complexity += Math.min(1, (output.match(/\b(function|if|for|while|import|return|class)\b/g) || []).length / 4) * 0.2; // code keywords
  complexity = Math.min(1, complexity);

  // ── diversity axis: novelty vs. baseline shingle set ──
  let diversity = 0.5; // neutral default when no baseline supplied
  if (noveltyBaseline && noveltyBaseline.size > 0) {
    const mine = shingles(`${instruction}\n${output}`);
    const novel = mine.filter((s) => !noveltyBaseline.has(s)).length;
    diversity = mine.length > 0 ? novel / mine.length : 0;
  }

  // DEITA weights: complexity-heavy (complex samples carry more signal)
  const score = 0.35 * quality + 0.4 * complexity + 0.25 * diversity;
  return { score: Math.max(0, Math.min(1, score)), quality, complexity, diversity };
}

/**
 * Deterministic LCG shuffle (reproducible, seed-stable).
 * @param {number[]} arr
 * @param {number} [seed=42]
 */
function lcgShuffle(arr, seed = 42) {
  let s = seed >>> 0;
  for (let i = arr.length - 1; i > 0; i--) {
    s = (s * 1664525 + 1013904223) >>> 0;
    const j = s % (i + 1);
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

/**
 * Train/val split: val set is the top-scored `valRatio` fraction (held-out
 * eval benchmark should be the strongest samples, not a random slice).
 *
 * @param {Array<{__score?: number}>} records — each record should carry `__score`
 * @param {object} [opts]
 * @param {number} [opts.valRatio=0.05]
 * @param {number} [opts.minSize=20] — below this, no split (val = null)
 * @returns {{ train: Array, val: Array|null }}
 */
function trainValSplit(records, opts = {}) {
  const valRatio = opts.valRatio ?? 0.05;
  const minSize = opts.minSize ?? 20;
  if (records.length < minSize) return { train: records.slice(), val: null };

  const scored = records.slice().sort((a, b) => (b.__score || 0) - (a.__score || 0));
  const valCount = Math.max(1, Math.round(records.length * valRatio));
  const val = scored.slice(0, valCount);
  const train = scored.slice(valCount);
  return { train, val };
}

/**
 * Full curation pipeline: dedup -> DEITA score -> train/val split.
 * Pure — no fs / no process.env.
 *
 * @param {Array} records
 * @param {object} [opts]
 * @param {number} [opts.shingleN=6]
 * @param {number} [opts.dedupThreshold=0.6]
 * @param {number} [opts.valRatio=0.05]
 * @returns {{
 *   train: Array,
 *   val: Array|null,
 *   report: {
 *     dedup: { total, kept, dropped, threshold, shingleN },
 *     scores: { min, max, mean },
 *     qualityBuckets: { high, mid, low },
 *   }
 * }}
 */
function curateDataset(records, opts = {}) {
  const { shingleN = 6, dedupThreshold = 0.6, valRatio = 0.05 } = opts;

  // 1) dedup
  const { kept, dropped, report: dedupReport } = shingleDedupe(records, {
    shingleN,
    threshold: dedupThreshold,
  });

  // 2) DEITA score + accumulate novelty baseline for the diversity axis
  const novelty = new Set();
  for (const r of kept) {
    const sc = deitaScore(r, novelty.size ? novelty : undefined);
    r.__score = sc.score;
    r.__deita = { quality: sc.quality, complexity: sc.complexity, diversity: sc.diversity };
    for (const s of shingles(`${r.instruction || ''}\n${r.output || ''}`, shingleN)) {
      novelty.add(s);
    }
  }

  // 3) train/val split (val = top-scored)
  const { train, val } = trainValSplit(kept, { valRatio });

  // report: score distribution + quality buckets
  const scores = kept.map((r) => r.__score || 0);
  const min = scores.length ? Math.min(...scores) : 0;
  const max = scores.length ? Math.max(...scores) : 0;
  const mean = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;
  const qualityBuckets = {
    high: kept.filter((r) => r.__score >= 0.66).length,
    mid: kept.filter((r) => r.__score >= 0.33 && r.__score < 0.66).length,
    low: kept.filter((r) => r.__score < 0.33).length,
  };

  return {
    train,
    val,
    report: {
      dedup: { ...dedupReport, droppedDetails: dropped.slice(0, 20) },
      scores: { min, max, mean },
      qualityBuckets,
    },
  };
}

/**
 * Text similarity used by multi-teacher voting (distill rejection sampling).
 * @param {string} a
 * @param {string} b
 * @returns {number} 0..1
 */
function responseSimilarity(a, b) {
  return jaccard(shingles(a), shingles(b));
}

module.exports = {
  shingles,
  jaccard,
  shingleDedupe,
  deitaScore,
  lcgShuffle,
  trainValSplit,
  curateDataset,
  responseSimilarity,
};
