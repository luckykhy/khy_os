/**
 * coverageReport.test.js — unit tests for coverage_report tool.
 *
 * Tests: lcov parsing, coverage-summary.json parsing, cobertura XML parsing,
 * auto-detection (path given / auto-find), threshold gating, missing report,
 * unknown format — all without real FS side effects via temp dir fixtures.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const coverageReport = require('../../src/tools/coverageReport');

describe('coverage_report tool', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'covrpt-'));
  });

  afterEach(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best-effort */ }
  });

  function writeFile(rel, content) {
    const full = path.join(tmpDir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
    return full;
  }

  // ── LCOV ───────────────────────────────────────────────────────────────────

  test('parses lcov.info', async () => {
    writeFile('coverage/lcov.info', [
      'TN:',
      'SF:src/foo.js',
      'DA:1,5',
      'DA:2,0',
      'DA:3,3',
      'LF:3',
      'LH:2',
      'BRF:2',
      'BRH:1',
      'FNF:1',
      'FNH:1',
      'end_of_record',
      'SF:src/bar.js',
      'DA:1,0',
      'LF:1',
      'LH:0',
      'BRF:0',
      'BRH:0',
      'FNF:0',
      'FNH:0',
      'end_of_record',
    ].join('\n'));

    const origCwd = process.env.KHYQUANT_CWD;
    process.env.KHYQUANT_CWD = tmpDir;
    const res2 = await coverageReport.execute({ path: 'coverage/lcov.info' });
    if (origCwd === undefined) delete process.env.KHYQUANT_CWD;
    else process.env.KHYQUANT_CWD = origCwd;

    expect(res2.success).toBe(true);
    expect(res2.meta.format).toBe('lcov');
    expect(res2.meta.files).toBe(2);
    // foo.js 2h/3l = 66.67%, bar.js 0h/1l = 0% → overall 2h/4l = 50%
    expect(res2.meta.lineCoverage).toBeCloseTo(50, 0);
    expect(res2.content).toContain('lcov');
    expect(res2.content).toContain('2 files');
  });

  // ── JSON coverage-summary ──────────────────────────────────────────────────

  test('parses coverage-summary.json', async () => {
    writeFile('coverage/coverage-summary.json', JSON.stringify({
      total: { lines: { total: 100, covered: 85, pct: 85 } },
      'src/a.js': { lines: { total: 50, covered: 45, pct: 90 } },
      'src/b.js': { lines: { total: 50, covered: 40, pct: 80 } },
      'src/c.js': { lines: { total: 10, covered: 1, pct: 10 } },
    }));

    process.env.KHYQUANT_CWD = tmpDir;
    const res = await coverageReport.execute({ path: 'coverage/coverage-summary.json' });
    delete process.env.KHYQUANT_CWD;

    expect(res.success).toBe(true);
    expect(res.meta.format).toBe('json');
    expect(res.meta.files).toBe(3);
    expect(res.meta.lineCoverage).toBeCloseTo(78.18, 1); // (45+40+1)/(50+50+10)=86/110
    expect(res.meta.filesBelowThreshold).toBe(1); // c.js at 10%
    expect(res.content).toContain('src/c.js');
  });

  test('parses coverage-final.json (Istanbul)', async () => {
    writeFile('coverage/coverage-final.json', JSON.stringify({
      'src/x.js': {
        s: { 0: 1, 1: 0, 2: 1 },
        b: { 0: [1, 0] },
        f: { 0: 1 },
      },
    }));

    process.env.KHYQUANT_CWD = tmpDir;
    const res = await coverageReport.execute({ path: 'coverage/coverage-final.json' });
    delete process.env.KHYQUANT_CWD;

    expect(res.success).toBe(true);
    expect(res.meta.format).toBe('json');
    expect(res.meta.files).toBe(1);
  });

  // ── Cobertura XML ──────────────────────────────────────────────────────────

  test('parses cobertura xml', async () => {
    writeFile('coverage/cobertura-coverage.xml', [
      '<?xml version="1.0"?>',
      '<coverage line-rate="0.5" branch-rate="0.5">',
      '<packages><package name="pkg">',
      '<classes>',
      '<class filename="src/app.js" line-rate="0.8" branch-rate="0.5">',
      '<lines>',
      '<line number="1" hits="5"/>',
      '<line number="2" hits="0"/>',
      '<line number="3" hits="3"/>',
      '</lines>',
      '</class>',
      '<class filename="src/util.js" line-rate="0.2" branch-rate="0">',
      '<lines>',
      '<line number="1" hits="0"/>',
      '<line number="2" hits="1"/>',
      '</lines>',
      '</class>',
      '</classes>',
      '</package></packages>',
      '</coverage>',
    ].join('\n'));

    process.env.KHYQUANT_CWD = tmpDir;
    const res = await coverageReport.execute({ path: 'coverage/cobertura-coverage.xml' });
    delete process.env.KHYQUANT_CWD;

    expect(res.success).toBe(true);
    expect(res.meta.format).toBe('cobertura');
    expect(res.meta.files).toBe(2);
    expect(res.content).toContain('src/util.js');
    expect(res.content).toContain('cobertura');
  });

  // ── Missing / unknown ──────────────────────────────────────────────────────

  test('reports missing when no report found', async () => {
    process.env.KHYQUANT_CWD = tmpDir;
    const res = await coverageReport.execute({});
    delete process.env.KHYQUANT_CWD;

    expect(res.success).toBe(false);
    expect(res.content).toContain('No coverage report found');
  });

  test('rejects unknown format', async () => {
    writeFile('coverage/report.txt', 'some random text that is not coverage');

    process.env.KHYQUANT_CWD = tmpDir;
    const res = await coverageReport.execute({ path: 'coverage/report.txt' });
    delete process.env.KHYQUANT_CWD;

    expect(res.success).toBe(false);
    expect(res.meta.format).toBe('unknown');
  });

  // ── Threshold gating ──────────────────────────────────────────────────────

  test('applies custom threshold', async () => {
    writeFile('coverage/lcov.info', [
      'TN:', 'SF:src/ok.js', 'DA:1,9', 'DA:2,1', 'LF:2', 'LH:2', 'end_of_record',
      'SF:src/low.js', 'DA:1,5', 'DA:2,0', 'DA:3,0', 'DA:4,1', 'DA:5,0', 'LF:5', 'LH:2', 'end_of_record',
    ].join('\n'));

    process.env.KHYQUANT_CWD = tmpDir;
    const res = await coverageReport.execute({ path: 'coverage/lcov.info', threshold: 50 });
    delete process.env.KHYQUANT_CWD;

    expect(res.success).toBe(true);
    // src/low.js = 2/5 = 40%, below 50% threshold
    expect(res.meta.filesBelowThreshold).toBe(1);
    expect(res.content).toContain('src/low.js');
  });

  // ── Schema ─────────────────────────────────────────────────────────────────

  test('schema allows all fields and defaults', () => {
    const ok = coverageReport.validate({});
    expect(ok.valid).toBe(true);

    const withPath = coverageReport.validate({ path: 'coverage/lcov.info', threshold: 90 });
    expect(withPath.valid).toBe(true);
  });
});
