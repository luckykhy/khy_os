'use strict';

/**
 * Tests for D5 quality dashboard and dimension health exports.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// Repo root: this file lives at <root>/services/backend/tests/ci/, four levels up.
const ROOT = path.resolve(__dirname, '../../../..');

describe('D5: quality dashboard export', () => {
  const dashboardPath = path.join(ROOT, 'docs', '_报告', '质量看板.json');

  test('export-quality-dashboard.js runs without error', () => {
    const healthScript = path.join(ROOT, 'scripts/ci/export-dimension-health.js');
    execSync(`node ${healthScript}`, { cwd: ROOT, stdio: 'pipe' });
    const script = path.join(ROOT, 'scripts/ci/export-quality-dashboard.js');
    expect(fs.existsSync(script)).toBe(true);
    execSync(`node ${script}`, { cwd: ROOT, stdio: 'pipe' });
    expect(fs.existsSync(dashboardPath)).toBe(true);
  });

  test('missing evidence makes the dashboard export fail', () => {
    const healthScript = path.join(ROOT, 'scripts/ci/export-dimension-health.js');
    const dashboardScript = path.join(ROOT, 'scripts/ci/export-quality-dashboard.js');
    const evidence = path.join(ROOT, 'AGENTS.md');
    const backup = `${evidence}.quality-dashboard-test-backup`;
    fs.renameSync(evidence, backup);
    try {
      expect(() => execSync(`node ${healthScript}`, { cwd: ROOT, stdio: 'pipe' })).toThrow();
      expect(() => execSync(`node ${dashboardScript}`, { cwd: ROOT, stdio: 'pipe' })).toThrow();
    } finally {
      fs.renameSync(backup, evidence);
      execSync(`node ${healthScript}`, { cwd: ROOT, stdio: 'pipe' });
      execSync(`node ${dashboardScript}`, { cwd: ROOT, stdio: 'pipe' });
    }
  });

  test('dashboard JSON has correct structure', () => {
    const data = JSON.parse(fs.readFileSync(dashboardPath, 'utf8'));
    expect(data).toHaveProperty('generatedAt');
    expect(data).toHaveProperty('dimensions');
    expect(data).toHaveProperty('checks');
    expect(data).toHaveProperty('exitCriteria');
    expect(Object.keys(data.dimensions)).toEqual(['D1', 'D2', 'D3', 'D4', 'D5']);
    for (const dim of Object.values(data.dimensions)) {
      expect(dim).toHaveProperty('score');
      expect(dim).toHaveProperty('name');
      expect(dim.score).toBeGreaterThanOrEqual(2);
    }
    const health = JSON.parse(fs.readFileSync(path.join(ROOT, 'docs', '_报告', '维度健康.json'), 'utf8'));
    for (const [dim, entry] of Object.entries(health.dimensions)) {
      expect(data.dimensions[dim].score).toBe(entry.healthy ? 3 : 1);
    }
    expect(data.exitCriteria.met).toBe(true);
  });
});

describe('D5: dimension health export', () => {
  const healthPath = path.join(ROOT, 'docs', '_报告', '维度健康.json');

  test('export-dimension-health.js runs without error', () => {
    const script = path.join(ROOT, 'scripts/ci/export-dimension-health.js');
    expect(fs.existsSync(script)).toBe(true);
    execSync(`node ${script}`, { cwd: ROOT, stdio: 'pipe' });
    expect(fs.existsSync(healthPath)).toBe(true);
  });

  test('missing evidence makes the health export fail', () => {
    const script = path.join(ROOT, 'scripts/ci/export-dimension-health.js');
    const evidence = path.join(ROOT, 'AGENTS.md');
    const backup = `${evidence}.quality-dashboard-test-backup`;
    fs.renameSync(evidence, backup);
    try { expect(() => execSync(`node ${script}`, { cwd: ROOT, stdio: 'pipe' })).toThrow(); }
    finally { fs.renameSync(backup, evidence); execSync(`node ${script}`, { cwd: ROOT, stdio: 'pipe' }); }
  });

  test('health JSON has correct structure', () => {
    const data = JSON.parse(fs.readFileSync(healthPath, 'utf8'));
    expect(data).toHaveProperty('generatedAt');
    expect(data).toHaveProperty('dimensions');
    for (const [dim, entry] of Object.entries(data.dimensions)) {
      expect(entry).toHaveProperty('name');
      expect(entry).toHaveProperty('filesPresent');
      expect(entry).toHaveProperty('filesMissing');
      expect(entry).toHaveProperty('healthy');
      expect(typeof entry.filesPresent).toBe('number');
    }
  });

  test('D3 exports are verified', () => {
    const data = JSON.parse(fs.readFileSync(healthPath, 'utf8'));
    const d3 = data.dimensions.D3;
    expect(d3.exportChecks.length).toBeGreaterThanOrEqual(3);
    const rateLimitCheck = d3.exportChecks.find(c => c.export === 'rateLimitGuard');
    expect(rateLimitCheck).toBeTruthy();
    expect(rateLimitCheck.ok).toBe(true);
  });

  test('D4 exports are verified', () => {
    const data = JSON.parse(fs.readFileSync(healthPath, 'utf8'));
    const d4 = data.dimensions.D4;
    const routeCheck = d4.exportChecks.find(c => c.export === 'routeMessage');
    expect(routeCheck).toBeTruthy();
    expect(routeCheck.ok).toBe(true);
  });
});
