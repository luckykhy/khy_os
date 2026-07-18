'use strict';

/**
 * Tests for D2 drift detection (compareWithHistory) in CI runners.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

describe('compareWithHistory — skill-scenario drift detection', () => {
  let tmpDir;
  let historyDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'drift-test-'));
    historyDir = path.join(tmpDir, 'history');
    fs.mkdirSync(historyDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // Replicate the function logic for testing
  function compareWithHistory(current, hDir, regressionThresholds) {
    if (!hDir || !fs.existsSync(hDir)) return null;
    const files = fs.readdirSync(hDir).filter(f => f.endsWith('.json')).sort().reverse();
    if (files.length === 0) return null;

    const prev = JSON.parse(fs.readFileSync(path.join(hDir, files[0]), 'utf8'));
    const regressions = [];
    const improvements = [];

    for (const evalItem of (current.evals || [])) {
      const prevItem = (prev.evals || []).find(e => e.id === evalItem.id);
      if (!prevItem) { improvements.push({ id: evalItem.id, type: 'new_eval' }); continue; }
      const delta = (evalItem.passRate || 0) - (prevItem.passRate || 0);
      if (delta < -0.01) regressions.push({ id: evalItem.id, prev: prevItem.passRate, curr: evalItem.passRate, delta });
      else if (delta > 0.01) improvements.push({ id: evalItem.id, delta });
    }

    return {
      comparedWith: files[0],
      regressions,
      improvements,
      driftDetected: regressions.length > 0,
    };
  }

  test('returns null when history dir does not exist', () => {
    expect(compareWithHistory({ evals: [] }, '/nonexistent/dir')).toBeNull();
  });

  test('returns null when history dir is empty', () => {
    const emptyDir = path.join(tmpDir, 'empty');
    fs.mkdirSync(emptyDir, { recursive: true });
    expect(compareWithHistory({ evals: [] }, emptyDir)).toBeNull();
  });

  test('detects regression when passRate drops', () => {
    const prev = {
      evals: [
        { id: 'eval-1', passRate: 1.0 },
        { id: 'eval-2', passRate: 0.8 },
      ],
    };
    fs.writeFileSync(path.join(historyDir, 'report_2026-01-01.json'), JSON.stringify(prev));

    const current = {
      evals: [
        { id: 'eval-1', passRate: 0.9 },  // regression
        { id: 'eval-2', passRate: 0.8 },   // no change
      ],
    };

    const result = compareWithHistory(current, historyDir);
    expect(result.driftDetected).toBe(true);
    expect(result.regressions).toHaveLength(1);
    expect(result.regressions[0].id).toBe('eval-1');
    expect(result.regressions[0].delta).toBeCloseTo(-0.1);
  });

  test('detects improvement when passRate increases', () => {
    const prev = { evals: [{ id: 'eval-1', passRate: 0.5 }] };
    fs.writeFileSync(path.join(historyDir, 'report_2026-01-01.json'), JSON.stringify(prev));

    const current = { evals: [{ id: 'eval-1', passRate: 0.8 }] };

    const result = compareWithHistory(current, historyDir);
    expect(result.driftDetected).toBe(false);
    expect(result.improvements).toHaveLength(1);
    expect(result.improvements[0].id).toBe('eval-1');
  });

  test('marks new evals as improvements', () => {
    const prev = { evals: [{ id: 'eval-1', passRate: 1.0 }] };
    fs.writeFileSync(path.join(historyDir, 'report_2026-01-01.json'), JSON.stringify(prev));

    const current = {
      evals: [
        { id: 'eval-1', passRate: 1.0 },
        { id: 'eval-new', passRate: 1.0 },
      ],
    };

    const result = compareWithHistory(current, historyDir);
    expect(result.improvements).toHaveLength(1);
    expect(result.improvements[0].type).toBe('new_eval');
  });

  test('compares against the most recent snapshot', () => {
    const old = { evals: [{ id: 'e1', passRate: 0.5 }] };
    const recent = { evals: [{ id: 'e1', passRate: 0.9 }] };
    fs.writeFileSync(path.join(historyDir, 'report_2026-01-01.json'), JSON.stringify(old));
    fs.writeFileSync(path.join(historyDir, 'report_2026-05-01.json'), JSON.stringify(recent));

    const current = { evals: [{ id: 'e1', passRate: 0.85 }] };
    const result = compareWithHistory(current, historyDir);
    // Should compare against 2026-05-01 (most recent), so regression is 0.9->0.85
    expect(result.comparedWith).toBe('report_2026-05-01.json');
    expect(result.driftDetected).toBe(true);
    expect(result.regressions[0].prev).toBe(0.9);
  });
});
