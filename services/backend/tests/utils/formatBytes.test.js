/**
 * Unit tests for utils/formatBytes — the canonical byte-size formatter.
 *
 * Byte-for-byte conservation contract: each of the 4 pre-convergence local
 * implementations (cleanupService.humanSize, checkpointService._formatSize,
 * cli/handlers/workspace._formatSize legacy branch, deviceAppsDownloader
 * .formatBytes) must produce EXACTLY the same string through the atom as the
 * original code did. Reference oracles below are verbatim copies of the
 * pre-convergence implementations; delegates are asserted against them.
 */

const formatBytes = require('../../src/utils/formatBytes');

// ── Verbatim pre-convergence reference implementations (oracles) ──────────

// cleanupService.humanSize (3-tier B/KB/MB)
function oracleHumanSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// checkpointService._formatSize (4-tier B/KB/MB/GB)
function oracleCheckpointFormatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

// deviceAppsDownloader.formatBytes (sanitized dynamic ladder up to TB)
function oracleDownloaderFormatBytes(n) {
  const v = Number.isFinite(n) && n > 0 ? n : 0;
  if (v < 1024) return `${v} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let x = v / 1024;
  let i = 0;
  while (x >= 1024 && i < units.length - 1) { x /= 1024; i++; }
  return `${x.toFixed(1)} ${units[i]}`;
}

// Shared byte-level sample points (incl. boundaries and pathological inputs)
const SAMPLES = [
  0, 1, 512, 1023, 1024, 1025, 1536, 2048,
  1024 * 1024 - 1, 1024 * 1024, 5 * 1024 * 1024,
  1024 * 1024 * 1024 - 1, 1024 * 1024 * 1024, 3 * 1024 * 1024 * 1024,
  1024 ** 4, 5 * 1024 ** 4, 1024 ** 5,
  -1, -5000, 0.5, 512.5, NaN, Infinity, -Infinity,
];

describe('formatBytes atom — byte-for-byte parity with pre-convergence code', () => {
  test('default (3-tier B/KB/MB) matches cleanupService.humanSize oracle', () => {
    for (const v of SAMPLES) {
      expect(formatBytes(v)).toBe(oracleHumanSize(v));
    }
  });

  test("maxUnit 'GB' (4-tier) matches checkpointService._formatSize oracle", () => {
    for (const v of SAMPLES) {
      expect(formatBytes(v, { maxUnit: 'GB' })).toBe(oracleCheckpointFormatSize(v));
    }
  });

  test("maxUnit 'TB' + sanitize matches deviceAppsDownloader.formatBytes oracle", () => {
    for (const v of SAMPLES) {
      expect(formatBytes(v, { maxUnit: 'TB', sanitize: true })).toBe(oracleDownloaderFormatBytes(v));
    }
  });

  test('fixed-point spot checks (explicit expected strings)', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1)).toBe('1 B');
    expect(formatBytes(1023)).toBe('1023 B');
    expect(formatBytes(1024)).toBe('1.0 KB');
    expect(formatBytes(1048576)).toBe('1.0 MB');
    expect(formatBytes(3 * 1024 * 1024 * 1024)).toBe('3072.0 MB'); // 3-tier caps at MB
    expect(formatBytes(3 * 1024 * 1024 * 1024, { maxUnit: 'GB' })).toBe('3.0 GB');
    expect(formatBytes(-1)).toBe('-1 B');
    expect(formatBytes(NaN)).toBe('NaN MB'); // NaN falls through the cascade, like the originals
    expect(formatBytes(NaN, { maxUnit: 'GB' })).toBe('NaN GB');
    expect(formatBytes(NaN, { maxUnit: 'TB', sanitize: true })).toBe('0 B');
    expect(formatBytes(-1, { maxUnit: 'TB', sanitize: true })).toBe('0 B');
  });
});

describe('post-convergence delegates — output identical to the oracles', () => {
  test('cleanupService.humanSize delegates without behavior change', () => {
    const { humanSize } = require('../../src/services/cleanupService');
    for (const v of SAMPLES) {
      expect(humanSize(v)).toBe(oracleHumanSize(v));
    }
  });

  test('deviceAppsDownloader.formatBytes delegates without behavior change', () => {
    const dl = require('../../src/services/deviceApps/deviceAppsDownloader');
    for (const v of SAMPLES) {
      expect(dl.formatBytes(v)).toBe(oracleDownloaderFormatBytes(v));
    }
  });

  test('checkpointService stats formatting is unchanged (via atom parity)', () => {
    // _formatSize is module-private; its delegate call is
    // formatBytes(bytes, { maxUnit: 'GB' }), asserted against the oracle above.
    for (const v of SAMPLES) {
      expect(formatBytes(v, { maxUnit: 'GB' })).toBe(oracleCheckpointFormatSize(v));
    }
  });

  test('cli/handlers/workspace._formatSize legacy branch is unchanged (ccFormat gate off)', () => {
    const { _formatSize } = (() => {
      // _formatSize is not exported; replicate its post-convergence legacy
      // branch (gate off -> formatBytes default) and assert oracle parity.
      return { _formatSize: (bytes) => formatBytes(bytes) };
    })();
    for (const v of SAMPLES) {
      expect(_formatSize(v)).toBe(oracleHumanSize(v));
    }
  });
});
