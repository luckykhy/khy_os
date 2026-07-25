'use strict';

/**
 * acceptanceCriteria.js
 *
 * Task-aware acceptance packs for delivery evaluation.
 *
 * The previous implementation used a single hard-coded coding checklist for
 * every task. That caused false failures for bugfixes and overly weak checks
 * for real scaffold/container work. This module keeps the mode-level exports
 * for compatibility while adding buildAcceptancePack(), which activates
 * profiles according to task signals.
 */

const fs = require('fs');
const path = require('path');

const PROJECT_CONFIG_PATTERN = '{package.json,pom.xml,Cargo.toml,go.mod,requirements.txt,pyproject.toml,build.gradle,CMakeLists.txt}';
const EDIT_TOOL_RE = /^(editFile|edit_file|edit|write_file|writeFile|scaffoldFiles|apply_patch)$/i;
const SCAFFOLD_SIGNAL_RE = /\b(create|scaffold|bootstrap|generate|init|starter|boilerplate|from scratch|new (?:app|project|service|cli)|创建|新建|搭建|脚手架|初始化)\b/i;
const CONTAINER_SIGNAL_RE = /\b(docker|dockerfile|container|compose|docker-compose|k8s|kubernetes|容器|镜像)\b/i;
const COMPOSE_SIGNAL_RE = /\b(docker[ -]?compose|docker-compose|compose|编排)\b/i;
const TEST_SIGNAL_RE = /\b(test|tests|unit test|integration test|regression|验证|回归|测试)\b/i;
const COMMON_TEST_DIRS = ['backend/tests', 'tests', 'test', '__tests__', 'unit_tests', 'API_tests'];

function _annotateCriteria(criteria, profileId, profileLabel) {
  return (criteria || []).map((criterion) => ({
    ...criterion,
    profileId,
    profileLabel,
  }));
}

// 收敛到 utils/trimLowerCase 单一真源(逐字节委托,调用点不变)
const _normalizeText = require('../utils/trimLowerCase');

function _safeToolLog(toolCallLog) {
  return Array.isArray(toolCallLog) ? toolCallLog : [];
}

function _hasEditSignals(toolCallLog) {
  return _safeToolLog(toolCallLog).some((entry) => EDIT_TOOL_RE.test(entry?.tool || entry?.name || ''));
}

function _hasMatchingPath(toolCallLog, pattern) {
  return _safeToolLog(toolCallLog).some((entry) => {
    const filePath = String(entry?.params?.path || entry?.params?.file_path || entry?.params?.filePath || '');
    return pattern.test(filePath);
  });
}

function _projectHasAny(projectRoot, relativePaths) {
  if (!projectRoot) return false;
  return relativePaths.some((relativePath) => fs.existsSync(path.join(projectRoot, relativePath)));
}

function _hasVisibleTestAssets(projectRoot) {
  return _projectHasAny(projectRoot, COMMON_TEST_DIRS);
}

const CODING_ACCEPTANCE = [
  {
    id: 'workspace_change_evidence',
    label: 'Workspace changes captured in tool log',
    phase: 1,
    required: true,
    check: 'custom',
    validator: 'meaningful_workspace_edits',
  },
  {
    id: 'delivery_evidence',
    label: 'Final response cites concrete files or edits',
    phase: 1,
    required: true,
    check: 'custom',
    validator: 'evidence_or_edits_in_response',
  },
];

const CODING_SCAFFOLD_ACCEPTANCE = [
  {
    id: 'config_file',
    label: 'Project config file',
    phase: 2,
    required: true,
    check: 'glob_min',
    target: PROJECT_CONFIG_PATTERN,
    minFiles: 1,
  },
  {
    id: 'readme',
    label: 'README.md',
    phase: 2,
    required: true,
    check: 'file_exists',
    target: 'README.md',
  },
];

const CODING_CONTAINER_ACCEPTANCE = [
  {
    id: 'dockerfile',
    label: 'Dockerfile',
    phase: 4,
    required: true,
    check: 'file_exists',
    target: 'Dockerfile',
  },
  {
    id: 'docker_compose',
    label: 'docker-compose.yml',
    phase: 4,
    required: false,
    check: 'file_exists',
    target: 'docker-compose.yml',
  },
  {
    id: 'dockerignore',
    label: '.dockerignore',
    phase: 4,
    required: false,
    check: 'file_exists',
    target: '.dockerignore',
  },
  {
    id: 'readme_docker',
    label: 'README mentions docker compose',
    phase: 4,
    required: false,
    check: 'file_contains',
    target: 'README.md',
    contains: ['docker compose', 'docker-compose'],
  },
];

const CODING_TEST_EVIDENCE_ACCEPTANCE = [
  {
    id: 'test_assets',
    label: 'Test assets present in common locations',
    phase: 5,
    required: false,
    check: 'custom',
    validator: 'test_assets_present',
  },
  {
    id: 'test_entrypoint',
    label: 'Runnable test entrypoint present',
    phase: 5,
    required: false,
    check: 'custom',
    validator: 'test_entrypoint_present',
  },
];

const ULTRAWORK_ACCEPTANCE = [
  {
    id: 'plan_exists',
    label: 'Execution plan created',
    phase: 1,
    required: true,
    check: 'custom',
    validator: 'plan_in_response',
  },
];

const ANALYZE_ACCEPTANCE = [
  {
    id: 'evidence_cited',
    label: 'Evidence with file paths',
    phase: 1,
    required: true,
    check: 'custom',
    validator: 'evidence_in_response',
  },
];

const GOAL_ACCEPTANCE = [
  {
    id: 'plan_executed',
    label: 'Execution plan created and followed',
    phase: 1,
    required: true,
    check: 'custom',
    validator: 'plan_in_response',
  },
  {
    id: 'evidence_cited',
    label: 'Evidence with file paths or tool output',
    phase: 2,
    required: true,
    check: 'custom',
    validator: 'evidence_in_response',
  },
];

const MODE_ACCEPTANCE = {
  coding: CODING_ACCEPTANCE,
  ultrawork: ULTRAWORK_ACCEPTANCE,
  analyze: ANALYZE_ACCEPTANCE,
  goal: GOAL_ACCEPTANCE,
};

function buildAcceptancePack(options = {}) {
  const modes = [...new Set((options.modes || []).filter(Boolean))];
  const userMessage = String(options.userMessage || '');
  const finalResponse = String(options.finalResponse || '');
  const toolCallLog = _safeToolLog(options.toolCallLog);
  const projectRoot = options.projectRoot ? path.resolve(options.projectRoot) : '';
  const combinedText = `${userMessage}\n${finalResponse}`;

  const signals = {
    hasEditSignals: _hasEditSignals(toolCallLog),
    scaffoldRequested: SCAFFOLD_SIGNAL_RE.test(combinedText) || _safeToolLog(toolCallLog).some((entry) => /scaffold/i.test(entry?.tool || entry?.name || '')),
    containerRequested: CONTAINER_SIGNAL_RE.test(combinedText)
      || _hasMatchingPath(toolCallLog, /(?:^|\/)(Dockerfile|docker-compose\.ya?ml|\.dockerignore)$/i)
      || _projectHasAny(projectRoot, ['Dockerfile', 'docker-compose.yml', 'docker-compose.yaml']),
    composeRequested: COMPOSE_SIGNAL_RE.test(combinedText)
      || _hasMatchingPath(toolCallLog, /docker-compose\.ya?ml$/i)
      || _projectHasAny(projectRoot, ['docker-compose.yml', 'docker-compose.yaml']),
    testsMentioned: TEST_SIGNAL_RE.test(combinedText),
    projectHasTests: _hasVisibleTestAssets(projectRoot),
  };

  const profiles = [];
  const criteria = [];

  function activate(profileId, profileLabel, profileCriteria, reason) {
    profiles.push({
      id: profileId,
      label: profileLabel,
      reason,
      criteriaIds: (profileCriteria || []).map((criterion) => criterion.id),
    });
    criteria.push(..._annotateCriteria(profileCriteria, profileId, profileLabel));
  }

  for (const mode of modes) {
    switch (_normalizeText(mode)) {
      case 'coding': {
        activate('coding_core', 'Coding core evidence', CODING_ACCEPTANCE, 'Activated for every coding task.');
        activate(
          'coding_test_evidence',
          'Coding test evidence',
          CODING_TEST_EVIDENCE_ACCEPTANCE,
          signals.projectHasTests || signals.testsMentioned
            ? 'Project already exposes tests or the task explicitly mentions verification.'
            : 'Activated as a non-blocking readiness signal for code delivery.'
        );

        if (signals.scaffoldRequested) {
          activate(
            'coding_scaffold',
            'Scaffold deliverables',
            CODING_SCAFFOLD_ACCEPTANCE,
            'The task looks like project scaffolding or fresh file generation.'
          );
        }

        if (signals.containerRequested) {
          const containerCriteria = CODING_CONTAINER_ACCEPTANCE.map((criterion) => (
            criterion.id === 'docker_compose'
              ? { ...criterion, required: signals.composeRequested || criterion.required }
              : criterion
          ));
          activate(
            'coding_container_delivery',
            'Container delivery assets',
            containerCriteria,
            signals.composeRequested
              ? 'The task explicitly references Docker Compose.'
              : 'The task references container delivery or the project already contains container assets.'
          );
        }
        break;
      }

      case 'ultrawork':
        activate('ultrawork_plan', 'Ultrawork plan evidence', ULTRAWORK_ACCEPTANCE, 'Activated by ultrawork mode.');
        break;

      case 'analyze':
        activate('analyze_evidence', 'Analyze evidence', ANALYZE_ACCEPTANCE, 'Activated by analyze mode.');
        break;

      case 'goal':
        activate('goal_delivery', 'Goal execution evidence', GOAL_ACCEPTANCE, 'Activated by goal mode.');
        break;

      default:
        break;
    }
  }

  const dedupedCriteria = [];
  const seen = new Map();
  for (const criterion of criteria) {
    const existingIdx = seen.get(criterion.id);
    if (existingIdx === undefined) {
      seen.set(criterion.id, dedupedCriteria.length);
      dedupedCriteria.push({ ...criterion });
      continue;
    }

    const existing = dedupedCriteria[existingIdx];
    dedupedCriteria[existingIdx] = {
      ...existing,
      required: existing.required || criterion.required,
      phase: Math.min(existing.phase, criterion.phase),
      profileId: existing.profileId || criterion.profileId,
      profileLabel: existing.profileLabel || criterion.profileLabel,
    };
  }

  return {
    modes,
    profiles,
    criteria: dedupedCriteria,
    signals,
  };
}

module.exports = {
  PROJECT_CONFIG_PATTERN,
  COMMON_TEST_DIRS,
  CODING_ACCEPTANCE,
  CODING_SCAFFOLD_ACCEPTANCE,
  CODING_CONTAINER_ACCEPTANCE,
  CODING_TEST_EVIDENCE_ACCEPTANCE,
  ULTRAWORK_ACCEPTANCE,
  ANALYZE_ACCEPTANCE,
  GOAL_ACCEPTANCE,
  MODE_ACCEPTANCE,
  buildAcceptancePack,
};
