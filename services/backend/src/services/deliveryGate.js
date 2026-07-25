'use strict';

/**
 * deliveryGate.js
 *
 * Post-loop delivery validation engine.
 * Scans the workspace against machine-readable acceptance criteria and
 * produces a structured delivery verdict that can be consumed by the harness,
 * CI, or release tooling.
 */

const fs = require('fs');
const path = require('path');

const { COMMON_TEST_DIRS, buildAcceptancePack } = require('./acceptanceCriteria');

const EDIT_TOOL_RE = /^(editFile|edit_file|edit|write_file|writeFile|scaffoldFiles|apply_patch)$/i;
// 路径分量有界 {1,255}(文件系统单分量硬上限)防灾难性回溯 ReDoS:`[\w./\\-]+\.(ext)`
// 字符类含 `.` 与必需 `\.(ext)` 后缀重叠·长无扩展名 token 触发 O(n²)。作用于
// context.finalResponse(模型生成·但可能回显用户粘贴的超长 token)。对真实文本逐字节等价。
// 门控 KHY_DELIVERY_FILEREF_REDOS_GUARD 默认开·关时回退无界形态。
const FILE_REF_RE_BOUNDED = /(?:[\w./\\-]{1,255}\.(?:js|ts|py|java|go|rs|rb|c|cpp|h|vue|jsx|tsx|json|yml|yaml|xml|sql|sh|md))/gi;
const FILE_REF_RE = /(?:[\w./\\-]+\.(?:js|ts|py|java|go|rs|rb|c|cpp|h|vue|jsx|tsx|json|yml|yaml|xml|sql|sh|md))/gi;

function _fileRefRe() {
  const off = ['0', 'false', 'off', 'no'].includes(
    String(process.env.KHY_DELIVERY_FILEREF_REDOS_GUARD || '').trim().toLowerCase(),
  );
  const src = off ? FILE_REF_RE : FILE_REF_RE_BOUNDED;
  return new RegExp(src.source, src.flags);
}

function _clip(value, maxLen = 240) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  if (text.length <= maxLen) return text;
  return `${text.slice(0, Math.max(0, maxLen - 1))}…`;
}

// 收敛到 utils/readJsonFileSafe 单一真源(逐字节委托,调用点不变)
const _loadJson = require('../utils/readJsonFileSafe');

function _rel(projectRoot, absolutePath) {
  if (!projectRoot || !absolutePath) return absolutePath;
  const relativePath = path.relative(projectRoot, absolutePath);
  return relativePath && !relativePath.startsWith('..') ? relativePath : absolutePath;
}

function _listEditedFiles(toolCallLog) {
  const files = new Set();
  for (const entry of (toolCallLog || [])) {
    const tool = String(entry?.tool || entry?.name || '');
    if (!EDIT_TOOL_RE.test(tool)) continue;
    const filePath = entry?.params?.path || entry?.params?.file_path || entry?.params?.filePath;
    if (filePath) files.add(path.resolve(filePath));
  }
  return [...files];
}

function _walkDir(dir, maxDepth, depth) {
  if (depth > maxDepth) return [];
  const results = [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return results;
  }

  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      results.push(..._walkDir(full, maxDepth, depth + 1));
    } else {
      results.push(full);
    }
  }
  return results;
}

function _globSync(pattern, root) {
  const braceMatch = pattern.match(/^\{([^}]+)\}$/);
  if (braceMatch) {
    const alternatives = braceMatch[1].split(',');
    return alternatives
      .map((alt) => path.join(root, alt.trim()))
      .filter((candidate) => fs.existsSync(candidate));
  }

  const parts = pattern.split('/');
  if (parts.includes('**')) {
    const baseDir = parts.slice(0, parts.indexOf('**')).join('/');
    const searchRoot = baseDir ? path.join(root, baseDir) : root;
    if (!fs.existsSync(searchRoot)) return [];
    return _walkDir(searchRoot, 5, 0);
  }

  const target = path.join(root, pattern);
  return fs.existsSync(target) ? [target] : [];
}

function _scanCommonTestDirs(projectRoot) {
  const evidence = [];
  for (const relativeDir of COMMON_TEST_DIRS) {
    const dirPath = path.join(projectRoot, relativeDir);
    if (!fs.existsSync(dirPath)) continue;
    const files = _walkDir(dirPath, 4, 0);
    if (files.length > 0) {
      evidence.push({
        path: relativeDir,
        fileCount: files.length,
      });
    }
  }
  return evidence;
}

function _detectTestEntrypoints(projectRoot) {
  const found = [];

  const packageJsonCandidates = [
    path.join(projectRoot, 'package.json'),
    path.join(projectRoot, 'backend', 'package.json'),
    path.join(projectRoot, 'frontend', 'package.json'),
  ];
  for (const pkgPath of packageJsonCandidates) {
    if (!fs.existsSync(pkgPath)) continue;
    const pkg = _loadJson(pkgPath);
    if (pkg?.scripts?.test) {
      found.push({
        kind: 'package_script',
        path: _rel(projectRoot, pkgPath),
        command: String(pkg.scripts.test),
      });
    }
  }

  const fileCandidates = [
    'run_tests.sh',
    'Makefile',
    'tox.ini',
    'pytest.ini',
    '.github/workflows/ci.yml',
    '.github/workflows/test.yml',
  ];
  for (const relativePath of fileCandidates) {
    const full = path.join(projectRoot, relativePath);
    if (fs.existsSync(full)) {
      found.push({
        kind: 'file',
        path: relativePath,
      });
    }
  }

  return found;
}

function _normalizeCheckResult(result, fallbackDetail) {
  if (typeof result === 'string') {
    return {
      status: result === 'pass' ? 'pass' : 'fail',
      detail: result === 'pass' ? '' : fallbackDetail,
      evidence: null,
    };
  }

  if (result && typeof result === 'object') {
    const status = result.status === 'pass' ? 'pass' : 'fail';
    return {
      status,
      detail: status === 'pass'
        ? String(result.detail || '')
        : String(result.detail || fallbackDetail),
      evidence: result.evidence ?? null,
    };
  }

  return {
    status: 'fail',
    detail: fallbackDetail,
    evidence: null,
  };
}

const CUSTOM_VALIDATORS = {
  plan_in_response(context) {
    const text = String(context.finalResponse || '');
    const numberedItems = text.match(/(?:^|\n)\s*\d+[.)]\s+\S/gm);
    return numberedItems && numberedItems.length >= 2
      ? {
          status: 'pass',
          detail: `Detected ${numberedItems.length} numbered plan item(s).`,
          evidence: { itemCount: numberedItems.length },
        }
      : {
          status: 'fail',
          detail: 'Final response does not contain a numbered execution plan.',
        };
  },

  evidence_in_response(context) {
    const text = String(context.finalResponse || '');
    const pathRefs = text.match(_fileRefRe());
    return pathRefs && pathRefs.length >= 1
      ? {
          status: 'pass',
          detail: `Final response cites ${pathRefs.length} file reference(s).`,
          evidence: { fileRefs: pathRefs.slice(0, 10) },
        }
      : {
          status: 'fail',
          detail: 'Final response does not cite concrete file paths.',
        };
  },

  meaningful_workspace_edits(context) {
    const editedFiles = _listEditedFiles(context.toolCallLog || []);
    return editedFiles.length > 0
      ? {
          status: 'pass',
          detail: `Captured ${editedFiles.length} edited file(s) in the tool log.`,
          evidence: { files: editedFiles.map((filePath) => _rel(context.projectRoot, filePath)) },
        }
      : {
          status: 'fail',
          detail: 'No write/edit/scaffold tool calls were captured for this task.',
        };
  },

  evidence_or_edits_in_response(context) {
    const evidenceInResponse = CUSTOM_VALIDATORS.evidence_in_response(context);
    if (evidenceInResponse.status === 'pass') return evidenceInResponse;

    const editEvidence = CUSTOM_VALIDATORS.meaningful_workspace_edits(context);
    if (editEvidence.status === 'pass') {
      return {
        status: 'pass',
        detail: 'Tool log contains concrete workspace edits even though the final response is sparse.',
        evidence: editEvidence.evidence,
      };
    }

    return {
      status: 'fail',
      detail: 'Neither the final response nor the tool log provides concrete delivery evidence.',
    };
  },

  test_assets_present(context) {
    const projectRoot = context.projectRoot || process.cwd();
    const dirEvidence = _scanCommonTestDirs(projectRoot);
    if (dirEvidence.length > 0) {
      return {
        status: 'pass',
        detail: `Found test assets in ${dirEvidence.length} common location(s).`,
        evidence: { locations: dirEvidence },
      };
    }

    const editedFiles = _listEditedFiles(context.toolCallLog || [])
      .map((filePath) => _rel(projectRoot, filePath))
      .filter((filePath) => /(?:^|\/)(?:__tests__|tests?|unit_tests|API_tests)\//i.test(filePath)
        || /\.(?:test|spec)\.[^.]+$/i.test(filePath));
    if (editedFiles.length > 0) {
      return {
        status: 'pass',
        detail: `Edited ${editedFiles.length} test file(s) during the task.`,
        evidence: { files: editedFiles },
      };
    }

    return {
      status: 'fail',
      detail: 'No test assets were found in common test locations.',
    };
  },

  test_entrypoint_present(context) {
    const projectRoot = context.projectRoot || process.cwd();
    const entrypoints = _detectTestEntrypoints(projectRoot);
    return entrypoints.length > 0
      ? {
          status: 'pass',
          detail: `Detected ${entrypoints.length} test entrypoint(s).`,
          evidence: { entrypoints: entrypoints.slice(0, 10) },
        }
      : {
          status: 'fail',
          detail: 'No runnable test entrypoint was detected.',
        };
  },
};

function _runCheckDetailed(criterion, projectRoot, context) {
  switch (criterion.check) {
    case 'file_exists': {
      const full = path.join(projectRoot, criterion.target);
      const exists = fs.existsSync(full);
      return {
        status: exists ? 'pass' : 'fail',
        detail: exists ? `Found ${criterion.target}.` : `${criterion.target} not found.`,
        evidence: exists ? { path: criterion.target } : null,
      };
    }

    case 'glob_min': {
      const matches = _globSync(criterion.target, projectRoot);
      const minFiles = criterion.minFiles || 1;
      const pass = matches.length >= minFiles;
      return {
        status: pass ? 'pass' : 'fail',
        detail: pass
          ? `${criterion.target} matched ${matches.length} file(s).`
          : `${criterion.target} matched ${matches.length}/${minFiles} required file(s).`,
        evidence: matches.length > 0
          ? { matches: matches.slice(0, 20).map((candidate) => _rel(projectRoot, candidate)), count: matches.length }
          : null,
      };
    }

    case 'file_contains': {
      const full = path.join(projectRoot, criterion.target);
      if (!fs.existsSync(full)) {
        return {
          status: 'fail',
          detail: `${criterion.target} not found.`,
          evidence: null,
        };
      }

      try {
        const content = fs.readFileSync(full, 'utf-8').toLowerCase();
        const needles = criterion.contains || [];
        const foundNeedle = needles.find((needle) => content.includes(String(needle).toLowerCase()));
        return foundNeedle
          ? {
              status: 'pass',
              detail: `${criterion.target} contains "${foundNeedle}".`,
              evidence: { path: criterion.target, matched: foundNeedle },
            }
          : {
              status: 'fail',
              detail: `${criterion.target} does not contain any expected token.`,
              evidence: { path: criterion.target, expected: needles },
            };
      } catch {
        return {
          status: 'fail',
          detail: `Unable to read ${criterion.target}.`,
          evidence: null,
        };
      }
    }

    case 'custom': {
      const validator = CUSTOM_VALIDATORS[criterion.validator];
      if (!validator) {
        return {
          status: 'pass',
          detail: `Custom validator "${criterion.validator}" is not registered; skipped.`,
          evidence: null,
        };
      }

      try {
        return _normalizeCheckResult(
          validator(context || {}, criterion),
          `${criterion.validator || criterion.id} failed.`,
        );
      } catch (err) {
        return {
          status: 'fail',
          detail: `Custom validator "${criterion.validator}" threw: ${_clip(err?.message || 'unknown error')}`,
          evidence: null,
        };
      }
    }

    default:
      return {
        status: 'pass',
        detail: `Unknown check "${criterion.check}" treated as pass.`,
        evidence: null,
      };
  }
}

function _runCheck(criterion, projectRoot, context) {
  return _runCheckDetailed(criterion, projectRoot, context).status;
}

function evaluateDelivery(projectRoot, criteria, context = {}) {
  const resolvedRoot = path.resolve(projectRoot || process.cwd());
  const ctx = {
    ...context,
    projectRoot: resolvedRoot,
  };

  const results = [];
  const missing = [];
  const warnings = [];
  let passedCount = 0;
  let failedCount = 0;

  for (const criterion of (criteria || [])) {
    const checked = _runCheckDetailed(criterion, resolvedRoot, ctx);
    const result = {
      id: criterion.id,
      label: criterion.label,
      phase: criterion.phase,
      required: !!criterion.required,
      check: criterion.check,
      target: criterion.target || null,
      validator: criterion.validator || null,
      profileId: criterion.profileId || null,
      profileLabel: criterion.profileLabel || null,
      status: checked.status,
      detail: checked.detail,
      evidence: checked.evidence,
    };
    results.push(result);

    if (checked.status === 'pass') {
      passedCount++;
      continue;
    }

    failedCount++;
    if (criterion.required) missing.push(result);
    else warnings.push(result);
  }

  const verdict = missing.length > 0 ? 'fail' : warnings.length > 0 ? 'warn' : 'pass';
  const acceptancePack = context.acceptancePack || null;
  const profileIds = [...new Set(results.map((result) => result.profileId).filter(Boolean))];

  return {
    passed: verdict !== 'fail',
    verdict,
    projectRoot: resolvedRoot,
    criteriaCount: results.length,
    requiredCount: results.filter((result) => result.required).length,
    optionalCount: results.filter((result) => !result.required).length,
    passedCount,
    failedCount,
    profileIds,
    modes: Array.isArray(acceptancePack?.modes) ? acceptancePack.modes : [],
    profiles: Array.isArray(acceptancePack?.profiles) ? acceptancePack.profiles : [],
    signals: acceptancePack?.signals || null,
    summary: `Delivery gate ${verdict.toUpperCase()}: ${passedCount}/${results.length} criteria passed, ${missing.length} required missing, ${warnings.length} optional warning(s).`,
    results,
    missing,
    warnings,
  };
}

function buildRemediationPrompt(originalMessage, missing, warnings, round, maxRounds) {
  const lines = [
    `[SYSTEM: Delivery Gate — remediation round ${round}/${maxRounds}]`,
    '',
    '[Original task]',
    String(originalMessage || '').slice(0, 500),
    '',
    '[REQUIRED deliverables still missing — you MUST create these]:',
    ...missing.map((item, index) => `  ${index + 1}. ${item.label}: ${item.detail || 'not found'}`),
  ];

  if (warnings.length > 0) {
    lines.push('', '[RECOMMENDED deliverables also missing]:');
    lines.push(...warnings.map((item, index) => `  ${index + 1}. ${item.label}: ${item.detail || 'not found'}`));
  }

  lines.push(
    '',
    '[Instructions]',
    'Create ONLY the missing deliverables listed above.',
    'Do NOT recreate files that already exist.',
    'Do NOT rewrite the entire project.',
    'Use scaffoldFiles for batch creation when possible.',
    'Focus exclusively on the missing items.',
  );

  return lines.join('\n');
}

function inferProjectRoot(toolCallLog, fallbackCwd) {
  for (const entry of (toolCallLog || [])) {
    const tool = String(entry?.tool || entry?.name || '');

    if (/scaffold/i.test(tool)) {
      const root = entry?.params?.root || entry?.params?.directory;
      if (root) return path.resolve(root);
    }

    if (/write|edit/i.test(tool)) {
      const filePath = entry?.params?.path || entry?.params?.file_path || entry?.params?.filePath;
      if (!filePath) continue;

      let dir = path.dirname(path.resolve(filePath));
      const indicators = ['package.json', 'pom.xml', 'Cargo.toml', 'go.mod', 'requirements.txt', 'pyproject.toml', 'build.gradle'];
      for (let i = 0; i < 5 && dir !== path.dirname(dir); i++) {
        if (indicators.some((indicator) => fs.existsSync(path.join(dir, indicator)))) return dir;
        dir = path.dirname(dir);
      }
    }
  }

  return fallbackCwd || process.cwd();
}

function _extractChangedFiles(toolCallLog) {
  return _listEditedFiles(toolCallLog);
}

function buildHarnessDeliveryVerdict(input = {}) {
  const runtimeFailed = !!input.loopResult?.errorType || !!input.loopResult?.stopped;
  const blockedBy = [];
  const warningSources = [];

  if (runtimeFailed) blockedBy.push('runtime');
  if (input.deliveryGateReport?.verdict === 'fail') blockedBy.push('delivery_gate');
  else if (input.deliveryGateReport?.verdict === 'warn') warningSources.push('delivery_gate');

  if (input.verificationReport && !input.verificationReport.passed) blockedBy.push('verification_gate');
  if (input.regressionGateReport && !input.regressionGateReport.skipped && input.regressionGateReport.passed === false) {
    blockedBy.push('regression_gate');
  }

  const verdict = blockedBy.length > 0 ? 'fail' : warningSources.length > 0 ? 'warn' : 'pass';
  const changedFiles = _extractChangedFiles(input.toolCallLog || []).map((filePath) => (
    input.deliveryGateReport?.projectRoot ? _rel(input.deliveryGateReport.projectRoot, filePath) : filePath
  ));

  const summaryParts = [];
  if (runtimeFailed) {
    summaryParts.push(`runtime reported ${input.loopResult?.errorType || 'stop signal'}`);
  }
  if (input.deliveryGateReport) {
    summaryParts.push(`delivery gate ${input.deliveryGateReport.verdict.toUpperCase()} (${input.deliveryGateReport.summary})`);
  }
  if (input.verificationReport) {
    summaryParts.push(`verification gate ${input.verificationReport.passed ? 'PASS' : 'FAIL'} (${_clip(input.verificationReport.summary || '')})`);
  }
  if (input.regressionGateReport && !input.regressionGateReport.skipped) {
    summaryParts.push(`regression gate ${input.regressionGateReport.passed ? 'PASS' : 'FAIL'} (${_clip(input.regressionGateReport.summary || '')})`);
  }

  return {
    verdict,
    needsHumanReview: verdict === 'warn',
    blockedBy,
    warningSources,
    summary: `Delivery verdict ${verdict.toUpperCase()}: ${summaryParts.length > 0 ? summaryParts.join('; ') : 'no blocking gates failed.'}`,
    gates: {
      runtime: {
        passed: !runtimeFailed,
        errorType: input.loopResult?.errorType || null,
        stopped: !!input.loopResult?.stopped,
      },
      deliveryGate: input.deliveryGateReport ? {
        verdict: input.deliveryGateReport.verdict,
        passed: input.deliveryGateReport.passed,
        summary: input.deliveryGateReport.summary,
        missingIds: input.deliveryGateReport.missing.map((item) => item.id),
        warningIds: input.deliveryGateReport.warnings.map((item) => item.id),
      } : null,
      verificationGate: input.verificationReport ? {
        verdict: input.verificationReport.passed ? 'pass' : 'fail',
        passed: input.verificationReport.passed,
        summary: input.verificationReport.summary,
      } : null,
      regressionGate: input.regressionGateReport ? {
        verdict: input.regressionGateReport.skipped
          ? 'pass'
          : input.regressionGateReport.passed ? 'pass' : 'fail',
        passed: !!input.regressionGateReport.passed,
        skipped: !!input.regressionGateReport.skipped,
        summary: input.regressionGateReport.summary || '',
      } : null,
    },
    evidence: {
      projectRoot: input.deliveryGateReport?.projectRoot || null,
      modes: input.acceptancePack?.modes || input.deliveryGateReport?.modes || [],
      profiles: input.acceptancePack?.profiles || input.deliveryGateReport?.profiles || [],
      changedFiles,
      iterations: Number(input.loopResult?.iterations || 0),
      continuationRounds: Number(input.loopResult?.continuationRounds || 0),
    },
  };
}

async function evaluateDeliveryEnhanced(params = {}) {
  const cwd = params.cwd || process.cwd();
  const maxRounds = Math.max(0, Number(params.maxRemediationRounds || 2) || 2);
  let toolCallLog = Array.isArray(params.toolCallLog) ? params.toolCallLog : [];
  let round = 0;
  let adversarialResult = null;

  while (round <= maxRounds) {
    const projectRoot = params.projectRoot || inferProjectRoot(toolCallLog, cwd);
    let acceptancePack = params.acceptancePack || null;
    let criteria = Array.isArray(params.criteria) ? params.criteria : null;

    if (!criteria) {
      acceptancePack = acceptancePack || buildAcceptancePack({
        modes: params.mode ? [params.mode] : [],
        userMessage: params.originalMessage || params.adversarial?.taskDescription || '',
        finalResponse: params.finalResponse || '',
        toolCallLog,
        projectRoot,
      });
      criteria = acceptancePack.criteria;
    }

    const staticResult = evaluateDelivery(projectRoot, criteria, {
      finalResponse: params.finalResponse || '',
      toolCallLog,
      acceptancePack,
    });

    if (params.adversarial?.executeAI) {
      try {
        const { adversarialVerify } = require('./verificationAgent');
        adversarialResult = await adversarialVerify({
          files: _extractChangedFiles(toolCallLog),
          cwd,
          taskDescription: params.adversarial.taskDescription || params.originalMessage || '',
          executeAI: params.adversarial.executeAI,
        });
      } catch {
        adversarialResult = { verdict: 'SKIP', summary: 'Adversarial verification unavailable.' };
      }
    }

    const staticPassed = staticResult.passed;
    const adversarialPassed = !adversarialResult || ['PASS', 'SKIP'].includes(adversarialResult.verdict);
    if (staticPassed && adversarialPassed) {
      return { passed: true, staticResult, adversarialResult, rounds: round };
    }

    round++;
    if (round > maxRounds || typeof params.onRemediation !== 'function') {
      return { passed: false, staticResult, adversarialResult, rounds: round - 1 };
    }

    let remediationPrompt = '';
    if (!staticPassed) {
      remediationPrompt += buildRemediationPrompt(
        params.originalMessage || params.adversarial?.taskDescription || '',
        staticResult.missing,
        staticResult.warnings,
        round,
        maxRounds,
      );
      remediationPrompt += '\n\n';
    }
    if (adversarialResult && adversarialResult.verdict === 'FAIL') {
      const failedChecks = (adversarialResult.checks || [])
        .filter((check) => check.result === 'FAIL')
        .map((check) => `- ${check.command}: ${check.output}`)
        .join('\n');
      remediationPrompt += `Adversarial verification failed:\n${failedChecks}\nFix the issues above before retrying.`;
    }

    try {
      const newLog = await params.onRemediation(remediationPrompt, round);
      if (Array.isArray(newLog)) toolCallLog = [...toolCallLog, ...newLog];
    } catch {
      return { passed: false, staticResult, adversarialResult, rounds: round };
    }
  }

  return { passed: false, staticResult: null, adversarialResult, rounds: round };
}

module.exports = {
  evaluateDelivery,
  evaluateDeliveryEnhanced,
  buildHarnessDeliveryVerdict,
  buildRemediationPrompt,
  inferProjectRoot,
  _runCheck,
  _runCheckDetailed,
  _globSync,
  _extractChangedFiles,
  CUSTOM_VALIDATORS,
};
