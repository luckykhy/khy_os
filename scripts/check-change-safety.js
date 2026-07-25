#!/usr/bin/env node
/**
 * Changed-file safety checker for low-cost / small-model workflows.
 *
 * Usage:
 *   node scripts/check-change-safety.js --changed
 *   node scripts/check-change-safety.js --changed --strict-warnings
 *   node scripts/check-change-safety.js <file-or-dir> [more...]
 */
'use strict';

const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const cwd = process.cwd();
const repoRoot = path.resolve(__dirname, '..');
const maintainerMapPath = path.join(repoRoot, 'docs', '维护者', '维护映射表.json');
const args = process.argv.slice(2);
const strictWarnings = args.includes('--strict-warnings');
const changedMode = args.includes('--changed');
const rawTargets = args.filter(arg => !arg.startsWith('--'));
const maintainerPathTypeCache = new Map();

const IGNORE_DIRS = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  '.cache',
  '.tmp',
  'coverage',
  'logs',
]);

const WARN_CHANGED_FILE_COUNT = 8;
const ERROR_CHANGED_FILE_COUNT = 20;
const WARN_NEW_FILE_COUNT = 3;

const SENSITIVE_PATH_RE = /(?:^|\/)(?:\.env(?:\..*)?|credentials\.json|secrets?\.(?:ya?ml|json)|.*\.(?:pem|key))$/i;

const HIGH_RISK_PATH_RULES = [
  { re: /^services\/backend\/src\/services\/gateway\//, label: 'backend gateway core' },
  { re: /^services\/(?:backend|ai-backend)\/src\/routes\//, label: 'route layer' },
  { re: /^services\/backend\/src\/constants\/prompts\.js$/, label: 'system prompt core' },
  { re: /(?:^|\/)(?:package\.json|pyproject\.toml|setup\.py)$/, label: 'package/build config' },
  { re: /(?:^|\/)(?:khy_platform\/__init__\.py|(?:backend|npm)\/package\.json)$/, label: 'version sync file' },
];

// ── 弱模型就地护栏横幅存在性(不信任弱模型:防它顺手删掉高危位点的 [AI-弱模型] 标注)──
// 若受监控的高危文件被改动,其 [AI-弱模型] 横幅必须仍在(至少一处)。零假阳性:只在这几个文件、
// 只查横幅是否存在(不校验内容),文件未改动则不检查。横幅文案单一真源见 weakModelGuidance.js。
const WEAK_MODEL_BANNER_MARK = '[AI-弱模型';
const WEAK_MODEL_BANNER_FILES = [
  'services/backend/src/services/toolCalling.js',
  'services/backend/src/services/flagRegistry.js',
  'services/backend/src/services/goalStopGate.js',
  'services/backend/src/services/toolUseLoop.js',
  'services/backend/src/services/weakModelGuidance.js',
  // 5 个高危写/搜索工具:prompt() 带 weakModelToolNote() 注入,横幅提醒弱模型「先 Read 再改 / 参数照
  // schema / 别删注入」。改动即要求横幅仍在,防弱模型顺手删掉就地标注。
  'services/backend/src/tools/FileEditTool/index.js',
  'services/backend/src/tools/FileWriteTool/index.js',
  'services/backend/src/tools/GrepTool/index.js',
  'services/backend/src/tools/MultiEditTool/index.js',
  'services/backend/src/tools/ApplyPatchTool/index.js',
];

const RECOMMENDED_CHECK_RULES = [
  {
    match: file => file === 'services/backend/src/constants/prompts.js' || /^services\/backend\/tests\/prompt.*\.test\.js$/.test(file),
    commands: [
      'node --test services/backend/tests/promptOnDemandSections.test.js',
      'node --test services/backend/tests/promptLearningRules.test.js',
      'npx jest services/backend/tests/gatewayDebugPrompt.test.js --runInBand',
    ],
  },
  {
    match: file => /^services\/backend\/src\/cli\//.test(file) || /^services\/backend\/tests\/cli\//.test(file),
    commands: ['npm run test:maintainer:cli-routing'],
  },
  {
    match: file => /^services\/backend\/src\/services\/gateway\//.test(file) || /^services\/backend\/tests\/gateway\//.test(file),
    commands: ['npm run test:maintainer:gateway', 'khy doctor'],
  },
  {
    match: file => /^(services\/backend\/src\/services\/daemonManager\.js|services\/backend\/src\/services\/gateway\/proxyServer\.js|services\/backend\/src\/utils\/proxyBaseUrl\.js|services\/backend\/src\/constants\/serviceDefaults\.js|services\/backend\/tests\/daemonManager\.runtimePort\.test\.js|services\/backend\/tests\/gatewayManage\.portDrift\.integration\.test\.js|services\/backend\/tests\/services\/proxyBaseUrl\.test\.js|services\/backend\/tests\/services\/serviceDefaults\.test\.js)$/.test(file),
    commands: ['npm run test:maintainer:runtime'],
  },
  {
    match: file => /^(services\/backend\/src\/services\/aiManagementServer\.js|services\/ai-backend\/src\/routes\/aiGatewayAdmin\.js|services\/backend\/tests\/routes\/aiGatewayAdmin\.modelSlots\.test\.js|services\/backend\/tests\/gatewayManage\.apiDisplay\.test\.js)$/.test(file),
    commands: ['npm run test:maintainer:ai-management'],
  },
  {
    match: file => /^(pyproject\.toml|setup\.py|MANIFEST\.in|platform\/khy_platform\/__init__\.py|services\/backend\/package\.json|services\/backend\/tests\/publish\.)/.test(file),
    commands: ['npm run check:manifest-sync', 'npm run test:maintainer:publish', 'bash scripts/release/build-and-audit-pip-purity.sh'],
  },
  {
    match: file => /^apps\/ai-frontend\//.test(file),
    commands: ['npm run build --prefix apps/ai-frontend'],
  },
];

function run(cmd) {
  try {
    return cp.execSync(cmd, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
    }).trim();
  } catch {
    return '';
  }
}

function parseNameStatus(output) {
  return String(output || '')
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .map((line) => {
      const parts = line.split('\t').filter(Boolean);
      const statusToken = String(parts[0] || '').trim();
      const status = statusToken.charAt(0).toUpperCase() || 'M';
      const currentPath = parts.length > 1 ? parts[parts.length - 1] : '';
      return {
        status,
        path: currentPath,
      };
    })
    .filter(entry => !!entry.path);
}

function listChangedEntries() {
  const baseRef = String(process.env.GIT_BASE_REF || '').trim();
  if (baseRef) {
    const out = run(`git diff --name-status --find-renames --diff-filter=ACMRD ${baseRef}...HEAD`);
    if (out) return parseNameStatus(out);
  }

  const staged = run('git diff --name-status --find-renames --cached --diff-filter=ACMRD');
  if (staged) return parseNameStatus(staged);

  const head = run('git diff --name-status --find-renames --diff-filter=ACMRD HEAD');
  if (head) return parseNameStatus(head);

  return [];
}

function shouldIgnore(filePath) {
  const parts = String(filePath || '').split(path.sep);
  return parts.some(part => IGNORE_DIRS.has(part));
}

function collectFilesFromTarget(targetPath, out) {
  const full = path.resolve(cwd, targetPath);
  if (!fs.existsSync(full)) return;
  const stat = fs.statSync(full);
  if (stat.isDirectory()) {
    for (const entry of fs.readdirSync(full)) {
      collectFilesFromTarget(path.join(targetPath, entry), out);
    }
    return;
  }
  const rel = path.relative(cwd, full).replace(/\\/g, '/');
  if (shouldIgnore(rel)) return;
  out.push({ status: 'M', path: rel });
}

function gatherEntries() {
  if (changedMode) return listChangedEntries();

  const out = [];
  for (const target of rawTargets) collectFilesFromTarget(target, out);
  return out;
}

function uniquePaths(entries) {
  const seen = new Set();
  const out = [];
  for (const entry of entries) {
    const normalized = String(entry.path || '').replace(/\\/g, '/');
    if (!normalized || seen.has(normalized) || shouldIgnore(normalized)) continue;
    seen.add(normalized);
    out.push({
      status: entry.status || 'M',
      path: normalized,
    });
  }
  return out;
}

function topLevelBucket(relPath) {
  const normalized = String(relPath || '').replace(/\\/g, '/');
  const first = normalized.split('/')[0] || normalized;
  if (!first) return 'root';
  if (normalized === 'package.json') return 'root-config';
  return first;
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

function normalizeRepoPath(filePath) {
  return String(filePath || '')
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/\/+$/, '');
}

function loadMaintainerMapSafe() {
  try {
    if (!fs.existsSync(maintainerMapPath)) return null;
    const parsed = JSON.parse(fs.readFileSync(maintainerMapPath, 'utf8'));
    return Array.isArray(parsed && parsed.areas) ? parsed : null;
  } catch {
    return null;
  }
}

function getMaintainerPathType(relPath) {
  const normalized = normalizeRepoPath(relPath);
  if (!normalized) return 'missing';
  if (maintainerPathTypeCache.has(normalized)) {
    return maintainerPathTypeCache.get(normalized);
  }

  let type = 'missing';
  try {
    const fullPath = path.join(repoRoot, normalized);
    if (fs.existsSync(fullPath)) {
      type = fs.statSync(fullPath).isDirectory() ? 'dir' : 'file';
    }
  } catch {
    type = 'missing';
  }

  maintainerPathTypeCache.set(normalized, type);
  return type;
}

function pathMatchesMaintainerAreaPath(filePath, areaPath) {
  const normalizedFile = normalizeRepoPath(filePath);
  const normalizedAreaPath = normalizeRepoPath(areaPath);
  if (!normalizedFile || !normalizedAreaPath) return false;

  const areaPathType = getMaintainerPathType(normalizedAreaPath);
  if (areaPathType === 'dir') {
    return normalizedFile === normalizedAreaPath || normalizedFile.startsWith(`${normalizedAreaPath}/`);
  }
  if (areaPathType === 'file') {
    return normalizedFile === normalizedAreaPath;
  }

  return normalizedFile === normalizedAreaPath || normalizedFile.startsWith(`${normalizedAreaPath}/`);
}

function buildRecommendedCommands(entries) {
  const paths = entries.map(entry => entry.path);
  const commands = new Set();
  const maintainerMatchedPaths = new Set();

  if (changedMode) {
    commands.add('node scripts/check-agent-rules.js --changed');
  } else {
    commands.add(`node scripts/check-agent-rules.js ${paths.map(shellQuote).join(' ')}`);
  }

  if (paths.some(file => /\.(?:js|cjs|mjs|ts|tsx|vue|json|ya?ml)$/i.test(file))) {
    commands.add('npm run check:node-syntax');
  }
  if (paths.some(file => /\.py$/i.test(file))) {
    commands.add('npm run check:python-syntax');
  }

  const maintainerMap = loadMaintainerMapSafe();
  for (const area of (maintainerMap && maintainerMap.areas) || []) {
    const areaPaths = Array.isArray(area.paths) ? area.paths : [];
    const verifyCommands = Array.isArray(area.verify) ? area.verify : [];
    const matchedPaths = paths.filter(file => areaPaths.some(areaPath => pathMatchesMaintainerAreaPath(file, areaPath)));
    if (matchedPaths.length === 0) {
      continue;
    }
    for (const matchedPath of matchedPaths) {
      maintainerMatchedPaths.add(matchedPath);
    }
    for (const command of verifyCommands) {
      if (typeof command === 'string' && command.trim()) {
        commands.add(command.trim());
      }
    }
  }

  const fallbackPaths = paths.filter(file => !maintainerMatchedPaths.has(file));

  if (fallbackPaths.some(file => file === 'services/backend/src/constants/prompts.js' || /^services\/backend\/tests\/prompt.*\.test\.js$/.test(file))) {
    commands.add('node --test services/backend/tests/promptOnDemandSections.test.js');
    commands.add('node --test services/backend/tests/promptLearningRules.test.js');
    commands.add('npx jest services/backend/tests/gatewayDebugPrompt.test.js --runInBand');
  }
  if (fallbackPaths.some(file => /^services\/backend\/src\/cli\//.test(file))) {
    commands.add('npm run test:maintainer:cli-routing');
  }
  if (fallbackPaths.some(file => /^services\/backend\/src\/services\/gateway\//.test(file) || /^services\/backend\/src\/routes\//.test(file))) {
    commands.add('npm run test:maintainer:gateway');
    commands.add('khy doctor');
  }

  for (const rule of RECOMMENDED_CHECK_RULES) {
    if (!fallbackPaths.some(rule.match)) continue;
    for (const command of rule.commands) {
      commands.add(command);
    }
  }

  return [...commands];
}

function main() {
  const entries = uniquePaths(gatherEntries());
  const findings = [];

  if (entries.length === 0) {
    console.log('check-change-safety: no matching changed files.');
    process.exit(0);
  }

  const changedCount = entries.length;
  if (changedCount > ERROR_CHANGED_FILE_COUNT) {
    findings.push({
      severity: 'error',
      message: `Changed-file count is too large for a low-cost-model pass (${changedCount} files).`,
      detail: `Reduce the blast radius or split the task. Threshold: ${ERROR_CHANGED_FILE_COUNT}.`,
    });
  } else if (changedCount > WARN_CHANGED_FILE_COUNT) {
    findings.push({
      severity: 'warning',
      message: `Changed-file count is high for a low-cost-model pass (${changedCount} files).`,
      detail: `Consider splitting the work. Warning threshold: ${WARN_CHANGED_FILE_COUNT}.`,
    });
  }

  const deleted = entries.filter(entry => entry.status === 'D');
  if (deleted.length > 0) {
    findings.push({
      severity: 'warning',
      message: `Deletion detected in change set (${deleted.length} file(s)).`,
      detail: deleted.map(entry => entry.path).join(', '),
    });
  }

  const added = entries.filter(entry => entry.status === 'A');
  if (added.length > WARN_NEW_FILE_COUNT) {
    findings.push({
      severity: 'warning',
      message: `Many new files were added (${added.length} file(s)).`,
      detail: `New-file warning threshold: ${WARN_NEW_FILE_COUNT}.`,
    });
  }

  const sensitive = entries.filter(entry => SENSITIVE_PATH_RE.test(entry.path));
  if (sensitive.length > 0) {
    findings.push({
      severity: 'warning',
      message: `Sensitive path touched by change set (${sensitive.length} file(s)).`,
      detail: sensitive.map(entry => entry.path).join(', '),
    });
  }

  for (const rule of HIGH_RISK_PATH_RULES) {
    const hits = entries.filter(entry => rule.re.test(entry.path));
    if (hits.length === 0) continue;
    findings.push({
      severity: 'warning',
      message: `High-risk surface touched: ${rule.label}.`,
      detail: hits.map(entry => entry.path).join(', '),
    });
  }

  // 弱模型护栏横幅存在性:被改动且未删除的受监控高危文件,其 [AI-弱模型] 横幅必须仍在。
  for (const watched of WEAK_MODEL_BANNER_FILES) {
    const touched = entries.some(entry => entry.path === watched && entry.status !== 'D');
    if (!touched) continue;
    let content = '';
    try {
      content = fs.readFileSync(path.join(repoRoot, watched), 'utf8');
    } catch {
      continue; // 文件读不到(极少见)→ 不误报,跳过。
    }
    if (!content.includes(WEAK_MODEL_BANNER_MARK)) {
      findings.push({
        severity: 'error',
        message: `Weak-model guardrail banner missing after edit: ${watched}.`,
        detail: `This high-risk file must keep at least one "${WEAK_MODEL_BANNER_MARK}…]" banner. `
          + 'Restore it (source of truth: services/backend/src/services/weakModelGuidance.js).',
      });
    }
  }

  const buckets = [...new Set(entries.map(entry => topLevelBucket(entry.path)))];
  if (buckets.length > 3) {
    findings.push({
      severity: 'warning',
      message: `Change set spans many top-level areas (${buckets.length}).`,
      detail: buckets.join(', '),
    });
  }

  const recommendedCommands = buildRecommendedCommands(entries);

  console.log(`check-change-safety: scanned ${entries.length} changed file(s).`);
  console.log(`files: ${entries.map(entry => `${entry.status}:${entry.path}`).join(', ')}`);

  if (findings.length === 0) {
    console.log('result: no safety findings.');
  } else {
    console.log('result:');
    for (const finding of findings) {
      console.log(` - [${finding.severity}] ${finding.message}`);
      if (finding.detail) console.log(`   ${finding.detail}`);
    }
  }

  if (recommendedCommands.length > 0) {
    console.log('recommended checks:');
    for (const command of recommendedCommands) {
      console.log(` - ${command}`);
    }
  }

  const hasErrors = findings.some(finding => finding.severity === 'error');
  const hasWarnings = findings.some(finding => finding.severity === 'warning');
  if (hasErrors || (strictWarnings && hasWarnings)) {
    process.exit(1);
  }
}

main();
