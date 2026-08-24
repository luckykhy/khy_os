'use strict';

/**
 * Tests for D5 quality dashboard and dimension health exports.
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// Repo root: this file lives at <root>/services/backend/tests/ci/, four levels up.
const ROOT = path.resolve(__dirname, '../../../..');

const DASHBOARD_SCRIPT = path.join(ROOT, 'scripts/ci/export-quality-dashboard.js');
const HEALTH_SCRIPT = path.join(ROOT, 'scripts/ci/export-dimension-health.js');

function readJson(rel) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
}

// Mirror of dimensionScore() in export-quality-dashboard.js. dashboard must
// derive its score from the health evidence source, not hardcode a literal.
function expectedScore(healthDim) {
  if (!healthDim) return 1;
  if (healthDim.healthy) return 3;
  return healthDim.filesPresent > 0 ? 2 : 1;
}

describe('D5: quality dashboard export', () => {
  const dashboardPath = path.join(ROOT, 'docs/_报告/质量看板.json');

  test('export-quality-dashboard.js runs without error', () => {
    expect(fs.existsSync(DASHBOARD_SCRIPT)).toBe(true);
    execSync(`node ${DASHBOARD_SCRIPT}`, { cwd: ROOT, stdio: 'pipe' });
    expect(fs.existsSync(dashboardPath)).toBe(true);
  });

  test('dashboard JSON has correct structure', () => {
    const data = readJson('docs/_报告/质量看板.json');
    expect(data).toHaveProperty('generatedAt');
    expect(data).toHaveProperty('dimensions');
    expect(data).toHaveProperty('checks');
    expect(data).toHaveProperty('exitCriteria');
    expect(Object.keys(data.dimensions)).toEqual(['D1', 'D2', 'D3', 'D4', 'D5']);
    for (const dim of Object.values(data.dimensions)) {
      expect(dim).toHaveProperty('score');
      expect(dim).toHaveProperty('name');
    }
  });

  test('dashboard scores derive from dimension health, not hardcoded', () => {
    execSync(`node ${HEALTH_SCRIPT}`, { cwd: ROOT, stdio: 'pipe' });
    execSync(`node ${DASHBOARD_SCRIPT}`, { cwd: ROOT, stdio: 'pipe' });
    const data = readJson('docs/_报告/质量看板.json');
    const health = readJson('docs/_报告/维度健康.json');
    for (const [dim, entry] of Object.entries(health.dimensions)) {
      expect(data.dimensions[dim].score).toBe(expectedScore(entry));
    }
  });

  test('dashboard exitCriteria are derived from scores', () => {
    execSync(`node ${HEALTH_SCRIPT}`, { cwd: ROOT, stdio: 'pipe' });
    execSync(`node ${DASHBOARD_SCRIPT}`, { cwd: ROOT, stdio: 'pipe' });
    const data = readJson('docs/_报告/质量看板.json');
    const health = readJson('docs/_报告/维度健康.json');
    const scores = Object.keys(health.dimensions).map(d => expectedScore(health.dimensions[d]));
    const allAtLeast2 = scores.every(s => s >= 2);
    const twoAt3 = scores.filter(s => s >= 3).length >= 2;
    expect(data.exitCriteria.allAtLeast2).toBe(allAtLeast2);
    expect(data.exitCriteria.twoAt3).toBe(twoAt3);
    expect(data.exitCriteria.met).toBe(allAtLeast2 && twoAt3);
  });
});

describe('D5: dimension health export', () => {
  const healthPath = path.join(ROOT, 'docs/_报告/维度健康.json');

  test('export-dimension-health.js runs without error', () => {
    const script = path.join(ROOT, 'scripts/ci/export-dimension-health.js');
    expect(fs.existsSync(script)).toBe(true);
    execSync(`node ${script}`, { cwd: ROOT, stdio: 'pipe' });
    expect(fs.existsSync(healthPath)).toBe(true);
  });

  test('health JSON has correct structure', () => {
    const data = JSON.parse(fs.readFileSync(healthPath, 'utf8'));
    expect(data).toHaveProperty('generatedAt');
    expect(data).toHaveProperty('dimensions');
    for (const entry of Object.values(data.dimensions)) {
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
