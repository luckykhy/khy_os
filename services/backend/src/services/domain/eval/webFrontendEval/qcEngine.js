'use strict';

/**
 * qcEngine — quality control validation for Web Frontend trajectory annotation packages.
 *
 * Checks performed:
 *   1. Self-check (self_check.md) — does the annotator's checklist pass?
 *   2. Structure integrity — required files present, workspace builds
 *   3. Content completeness — API calls recorded, screenshots present, artifacts exist
 *   4. Resource compliance — assets have source/license info
 *   5. Level alignment — does the output match L1/L2/L3 acceptance criteria?
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

/**
 * Run full QC on a trajectory package.
 * @param {string} pkgDir
 * @param {object} task
 * @param {object} manifest
 * @returns {{ passed: boolean, score: number, defects: Array<{key, severity, description}>, verdict: string }}
 */
function runQC(pkgDir, task, manifest) {
  const defects = [];

  // 1. Self-check validation
  const selfCheck = _checkSelfCheck(pkgDir);
  if (!selfCheck.passed) {
    defects.push({ key: 'self_check', severity: 'major', description: '自检清单未通过或缺失' });
  }

  // 2. Structure integrity
  const structure = _checkStructure(pkgDir);
  if (!structure.passed) {
    structure.issues.forEach((issue) =>
      defects.push({ key: 'structure', severity: 'critical', description: issue })
    );
  }

  // 3. Content completeness
  const content = _checkContent(pkgDir, manifest);
  content.issues.forEach((issue) => defects.push(issue));

  // 4. Resource compliance
  const resources = _checkResources(pkgDir, task);
  resources.issues.forEach((issue) => defects.push(issue));

  // 5. Level alignment (basic)
  const alignment = _checkLevelAlignment(pkgDir, task);
  alignment.issues.forEach((issue) => defects.push(issue));

  // Score: start at 1.0, subtract per defect
  let score = 1.0;
  for (const d of defects) {
    if (d.severity === 'critical') {
      score -= 0.3;
    } else if (d.severity === 'major') {
      score -= 0.15;
    } else {
      score -= 0.05;
    }
  }
  score = Math.max(0, Math.round(score * 1000) / 1000);

  const passed = defects.filter((d) => d.severity === 'critical').length === 0 && score >= 0.6;
  const verdict = passed ? (score >= 0.85 ? 'pass' : 'needs_rework') : 'fail';

  return { passed, score, defects, verdict };
}

// ── Individual Checkers ─────────────────────────────────────────

function _checkSelfCheck(pkgDir) {
  const scPath = path.join(pkgDir, 'qc', 'self_check.md');
  if (!fs.existsSync(scPath)) {
    return { passed: false, reason: 'missing' };
  }

  const content = fs.readFileSync(scPath, 'utf-8');
  const requiredChecks = [
    /轨迹.*完整/,
    /产物.*可运行/,
    /依赖.*锁定/,
    /截图|录屏/,
    /自检.*完成|完成.*自检/,
  ];

  const passed = requiredChecks.every((re) => re.test(content));
  return { passed, reason: passed ? 'all_checked' : 'incomplete' };
}

function _checkStructure(pkgDir) {
  const issues = [];
  const required = [
    'task/prompt.md',
    'trajectory/',
    'screenshots/',
    'workspace/src/',
    'workspace/dist/',
    'env/',
    'qc/',
  ];

  for (const rel of required) {
    if (!fs.existsSync(path.join(pkgDir, rel))) {
      issues.push(`Missing required path: ${rel}`);
    }
  }

  // Check prompt.md has content
  const promptPath = path.join(pkgDir, 'task', 'prompt.md');
  if (fs.existsSync(promptPath)) {
    const stat = fs.statSync(promptPath);
    if (stat.size < 10) {
      issues.push('prompt.md is empty or too small');
    }
  }

  // Check workspace/dist has content
  const distDir = path.join(pkgDir, 'workspace', 'dist');
  if (fs.existsSync(distDir)) {
    const entries = fs.readdirSync(distDir);
    if (entries.length === 0) {
      issues.push('workspace/dist/ is empty — no built output');
    }
  }

  return { passed: issues.length === 0, issues };
}

function _checkContent(pkgDir, manifest) {
  const issues = [];
  const pkg = manifest?.package || {};

  if (!pkg.apiCallCount || pkg.apiCallCount === 0) {
    issues.push({
      key: 'no_api_calls',
      severity: 'critical',
      description: '未记录任何 API 调用轨迹',
    });
  }

  if (!pkg.screenshots || pkg.screenshots === 0) {
    issues.push({
      key: 'no_screenshots',
      severity: 'major',
      description: '无过程截图，轨迹可追溯性不足',
    });
  }

  if (!pkg.workspaceDistFiles || pkg.workspaceDistFiles === 0) {
    issues.push({
      key: 'no_dist',
      severity: 'critical',
      description: 'workspace/dist/ 无构建产物',
    });
  }

  if (!pkg.hasLockfile) {
    issues.push({
      key: 'no_lockfile',
      severity: 'major',
      description: '缺少依赖锁文件（package-lock/pnpm-lock/yarn.lock）',
    });
  }

  if (!pkg.hasEnvSnapshot) {
    issues.push({
      key: 'no_env_snapshot',
      severity: 'minor',
      description: '缺少 env_snapshot.json 环境快照',
    });
  }

  if (!pkg.hasBuildMd) {
    issues.push({ key: 'no_build_md', severity: 'minor', description: '缺少 build.md 构建说明' });
  }

  return { issues };
}

function _checkResources(pkgDir, task) {
  const issues = [];
  const assetsDir = path.join(pkgDir, 'task', 'assets');

  if (!fs.existsSync(assetsDir)) {
    return { issues };
  }

  try {
    const entries = fs.readdirSync(assetsDir);
    const assetTypes = new Set(
      entries.filter((f) => {
        const ext = path.extname(f).toLowerCase();
        return [
          '.png',
          '.jpg',
          '.jpeg',
          '.webp',
          '.glb',
          '.gltf',
          '.obj',
          '.fbx',
          '.hdr',
          '.exr',
          '.mp3',
          '.wav',
          '.ogg',
          '.mp4',
        ].includes(ext);
      })
    );

    if (assetTypes.size > 0 && !fs.existsSync(path.join(pkgDir, 'task', 'assets_license.md'))) {
      issues.push({
        key: 'no_asset_license',
        severity: 'major',
        description: `存在 ${assetTypes.size} 个资源文件但缺少授权说明 (assets_license.md)`,
      });
    }
  } catch {
    /* ignore */
  }

  return { issues };
}

function _checkLevelAlignment(pkgDir, task) {
  const issues = [];
  const level = task?.level || 'L1';

  // Check that acceptance criteria file exists
  const acPath = path.join(pkgDir, 'task', 'acceptance_criteria.json');
  if (!fs.existsSync(acPath)) {
    issues.push({
      key: 'no_acceptance_criteria',
      severity: 'minor',
      description: '缺少验收标准文件 (acceptance_criteria.json)',
    });
  }

  // Level-specific checks
  if (level === 'L3') {
    const manifest = _readManifest(pkgDir);
    if (manifest?.package?.screenshots < 3) {
      issues.push({
        key: 'l3_screenshots',
        severity: 'major',
        description: 'L3 任务建议提供至少 3 张过程截图',
      });
    }
  }

  return { issues };
}

function _readManifest(pkgDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(pkgDir, 'manifest.json'), 'utf-8'));
  } catch {
    return null;
  }
}

module.exports = { runQC };
