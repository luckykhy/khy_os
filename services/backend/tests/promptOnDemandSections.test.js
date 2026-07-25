'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

describe('on-demand prompt sections', () => {
  test('omits optional capsules for small conversational requests', async () => {
    const {
      getSystemPrompt,
      assembleSystemPrompt,
      listOnDemandPromptSectionIds,
    } = require('../src/constants/prompts');

    const activeIds = listOnDemandPromptSectionIds({
      userMessage: '什么是 MACD？',
      taskScale: 'small',
      enabledTools: ['Read', 'Edit', 'Write', 'Bash', 'Glob', 'Grep', 'Agent'],
    });

    assert.deepEqual(activeIds, []);

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-prompt-capsule-'));
    try {
      const sections = await getSystemPrompt({
        cwd: tmpDir,
        enabledTools: ['Read', 'Edit', 'Write', 'Bash', 'Glob', 'Grep', 'Agent'],
        userMessage: '什么是 MACD？',
        taskScale: 'small',
      });
      const prompt = assembleSystemPrompt(sections);

      assert.doesNotMatch(prompt, /# File operations/);
      assert.doesNotMatch(prompt, /# Command execution/);
      assert.doesNotMatch(prompt, /# Search and exploration/);
      assert.doesNotMatch(prompt, /# Multi-agent collaboration/);
      assert.doesNotMatch(prompt, /# Executing actions with care/);
      assert.doesNotMatch(prompt, /# Security and permission boundaries/);
      assert.doesNotMatch(prompt, /# Sensitive data/);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('injects relevant capsules for coding work and verification', async () => {
    const {
      getSystemPrompt,
      assembleSystemPrompt,
      listOnDemandPromptSectionIds,
    } = require('../src/constants/prompts');

    const enabledTools = ['Read', 'Edit', 'Write', 'Bash', 'Glob', 'Grep'];
    const userMessage = '修复 backend 登录 bug，先搜索 router 和 service，再修改文件并运行 npm test 验证。';
    const activeIds = new Set(listOnDemandPromptSectionIds({
      userMessage,
      taskScale: 'medium',
      enabledTools,
    }));

    assert.ok(activeIds.has('scope_minimization'));
    assert.ok(activeIds.has('planning_verification'));
    assert.ok(activeIds.has('task_progress_management'));
    assert.ok(activeIds.has('error_handling_fallback'));
    assert.ok(activeIds.has('file_operations'));
    assert.ok(activeIds.has('command_execution'));
    assert.ok(activeIds.has('search_exploration'));
    assert.ok(activeIds.has('response_formatting'));
    assert.ok(!activeIds.has('feature_access_proxy_boundary'));
    assert.ok(!activeIds.has('multi_agent_collaboration'));

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-prompt-capsule-'));
    try {
      const sections = await getSystemPrompt({
        cwd: tmpDir,
        enabledTools,
        userMessage,
        taskScale: 'medium',
      });
      const prompt = assembleSystemPrompt(sections);

      assert.match(prompt, /# Scope minimization and sufficient execution/);
      assert.match(prompt, /# Planning and verification/);
      assert.match(prompt, /# Task and progress management/);
      assert.match(prompt, /# Error handling and fallback/);
      assert.match(prompt, /# File operations/);
      assert.match(prompt, /# Command execution/);
      assert.match(prompt, /# Search and exploration/);
      assert.match(prompt, /# Response formatting/);
      assert.doesNotMatch(prompt, /# Committing changes with git/);
      assert.doesNotMatch(prompt, /# Executing actions with care/);
      assert.doesNotMatch(prompt, /# Security and permission boundaries/);
      assert.doesNotMatch(prompt, /# Sensitive data/);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('injects feature access capsule only for KHY boundary work', async () => {
    const {
      getSystemPrompt,
      assembleSystemPrompt,
      listOnDemandPromptSectionIds,
    } = require('../src/constants/prompts');

    const enabledTools = ['Read', 'Edit', 'Write', 'Bash', 'Glob', 'Grep'];
    const userMessage = '解释 authGuard、featureKeyBuilder、gateway relay 和 khy claude 的登录边界。';
    const activeIds = new Set(listOnDemandPromptSectionIds({
      userMessage,
      taskScale: 'small',
      enabledTools,
    }));

    assert.ok(activeIds.has('feature_access_proxy_boundary'));
    assert.ok(!activeIds.has('command_execution'));
    assert.ok(!activeIds.has('git_operations'));

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-prompt-capsule-'));
    try {
      const sections = await getSystemPrompt({
        cwd: tmpDir,
        enabledTools,
        userMessage,
        taskScale: 'small',
      });
      const prompt = assembleSystemPrompt(sections);

      assert.match(prompt, /# Feature access and proxy boundary/);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('injects git capsule only for git-oriented requests', async () => {
    const {
      getSystemPrompt,
      assembleSystemPrompt,
      listOnDemandPromptSectionIds,
    } = require('../src/constants/prompts');

    const enabledTools = ['Read', 'Edit', 'Write', 'Bash', 'Glob', 'Grep'];
    const userMessage = '请帮我检查当前改动并创建 git commit。';
    const activeIds = new Set(listOnDemandPromptSectionIds({
      userMessage,
      taskScale: 'medium',
      enabledTools,
    }));

    assert.ok(activeIds.has('scope_minimization'));
    assert.ok(activeIds.has('git_operations'));

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-prompt-capsule-'));
    try {
      const sections = await getSystemPrompt({
        cwd: tmpDir,
        enabledTools,
        userMessage,
        taskScale: 'medium',
      });
      const prompt = assembleSystemPrompt(sections);

      assert.match(prompt, /# Scope minimization and sufficient execution/);
      assert.match(prompt, /# Committing changes with git/);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('injects multi-agent capsule for medium tasks only when agent tools are available', () => {
    const { listOnDemandPromptSectionIds } = require('../src/constants/prompts');

    const activeIds = new Set(listOnDemandPromptSectionIds({
      userMessage: '修复登录问题并验证结果。',
      taskScale: 'medium',
      enabledTools: ['Read', 'Edit', 'Write', 'Bash', 'Glob', 'Grep', 'Agent', 'SendMessage'],
    }));

    assert.ok(activeIds.has('multi_agent_collaboration'));
  });

  test('injects safety capsules only for risky or sensitive requests', async () => {
    const {
      getSystemPrompt,
      assembleSystemPrompt,
      listOnDemandPromptSectionIds,
    } = require('../src/constants/prompts');

    const enabledTools = ['Read', 'Edit', 'Write', 'Bash', 'Glob', 'Grep'];
    const userMessage = '请删除 logs 目录、检查 .env 里的 token 是否泄露，然后强制推送到远程。';
    const activeIds = new Set(listOnDemandPromptSectionIds({
      userMessage,
      taskScale: 'medium',
      enabledTools,
    }));

    assert.ok(activeIds.has('action_safety'));
    assert.ok(activeIds.has('security_permission_boundaries'));
    assert.ok(activeIds.has('sensitive_data'));

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-prompt-capsule-'));
    try {
      const sections = await getSystemPrompt({
        cwd: tmpDir,
        enabledTools,
        userMessage,
        taskScale: 'medium',
      });
      const prompt = assembleSystemPrompt(sections);

      assert.match(prompt, /# Executing actions with care/);
      assert.match(prompt, /# Security and permission boundaries/);
      assert.match(prompt, /# Sensitive data/);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('uses the same intent classifier for capsule ids and debug reasons', () => {
    const { getOnDemandPromptSectionDecision } = require('../src/constants/prompts');
    const enabledTools = ['Read', 'Edit', 'Write', 'Bash', 'Glob', 'Grep'];
    const decision = getOnDemandPromptSectionDecision({
      userMessage: '请检查 .env 里的 token 是否泄露，然后强制推送到远程。',
      taskScale: 'medium',
      enabledTools,
    });

    assert.ok(decision.ids.includes('git_operations'));
    assert.ok(decision.ids.includes('action_safety'));
    assert.ok(decision.ids.includes('security_permission_boundaries'));
    assert.ok(decision.ids.includes('sensitive_data'));
    assert.ok(decision.reasons.includes('git_keywords'));
    assert.ok(decision.reasons.includes('action_keywords'));
    assert.ok(decision.reasons.includes('security_keywords'));
    assert.ok(decision.reasons.includes('sensitive_data_keywords'));
  });

  test('keeps every on-demand section id reachable through classifier rules', () => {
    const { listOnDemandPromptSectionIds } = require('../src/constants/prompts');
    const enabledTools = ['Read', 'Edit', 'Write', 'Bash', 'Glob', 'Grep', 'Agent', 'SendMessage', 'TaskCreate', 'TaskUpdate', 'TaskList', 'TodoWrite'];
    const activeIds = listOnDemandPromptSectionIds({
      userMessage: '请按最小改动规划多文件修复 authGuard 和 featureKeyBuilder 的 gateway relay 登录边界，先并行搜索 backend/src/cli/router.js 并读取文件，诊断 error，执行 npm test，输出 markdown summary，检查 .env token 泄露，删除 logs 后 git push 到远程。',
      taskScale: 'large',
      enabledTools,
    });

    assert.deepEqual(activeIds, [
      'scope_minimization',
      'planning_verification',
      'task_progress_management',
      'error_handling_fallback',
      'multi_agent_collaboration',
      'file_operations',
      'command_execution',
      'search_exploration',
      'response_formatting',
      'feature_access_proxy_boundary',
      'git_operations',
      'action_safety',
      'security_permission_boundaries',
      'sensitive_data',
    ]);
  });

  test('avoids triggering safety capsules for generic product or explanation wording', () => {
    const { listOnDemandPromptSectionIds } = require('../src/constants/prompts');
    const enabledTools = ['Read', 'Edit', 'Write', 'Bash', 'Glob', 'Grep'];

    const marketingIds = new Set(listOnDemandPromptSectionIds({
      userMessage: '帮我做一个产品介绍页，强调高权限用户体验。',
      taskScale: 'small',
      enabledTools,
    }));
    assert.ok(!marketingIds.has('action_safety'));
    assert.ok(!marketingIds.has('security_permission_boundaries'));
    assert.ok(!marketingIds.has('sensitive_data'));

    const explainIds = new Set(listOnDemandPromptSectionIds({
      userMessage: '把生产环境发布流程解释一下。',
      taskScale: 'small',
      enabledTools,
    }));
    assert.ok(!explainIds.has('action_safety'));
    assert.ok(!explainIds.has('security_permission_boundaries'));
    assert.ok(!explainIds.has('sensitive_data'));

    const gitExplainIds = new Set(listOnDemandPromptSectionIds({
      userMessage: '解释一下 force push 的风险。',
      taskScale: 'small',
      enabledTools,
    }));
    assert.ok(gitExplainIds.has('git_operations'));
    assert.ok(!gitExplainIds.has('action_safety'));
    assert.ok(!gitExplainIds.has('command_execution'));

    const resetExplainIds = new Set(listOnDemandPromptSectionIds({
      userMessage: '请把 reset --hard 的行为解释清楚。',
      taskScale: 'small',
      enabledTools,
    }));
    assert.ok(resetExplainIds.has('git_operations'));
    assert.ok(!resetExplainIds.has('action_safety'));
    assert.ok(!resetExplainIds.has('command_execution'));

    const gitCommandExplainIds = new Set(listOnDemandPromptSectionIds({
      userMessage: '解释 git push 怎么执行。',
      taskScale: 'small',
      enabledTools,
    }));
    assert.ok(gitCommandExplainIds.has('git_operations'));
    assert.ok(!gitCommandExplainIds.has('command_execution'));

    const fileExplainIds = new Set(listOnDemandPromptSectionIds({
      userMessage: '解释一下 backend/src/cli/router.js 的作用。',
      taskScale: 'small',
      enabledTools,
    }));
    assert.ok(fileExplainIds.has('file_operations'));
    assert.ok(!fileExplainIds.has('search_exploration'));

    const searchLocateIds = new Set(listOnDemandPromptSectionIds({
      userMessage: '帮我在仓库里搜索 login handler 在哪里。',
      taskScale: 'small',
      enabledTools,
    }));
    assert.ok(searchLocateIds.has('search_exploration'));
    assert.ok(!searchLocateIds.has('file_operations'));
  });

  test('falls back to full optional section set for continuation turns', () => {
    const { listOnDemandPromptSectionIds } = require('../src/constants/prompts');

    const activeIds = listOnDemandPromptSectionIds({
      userMessage: '继续',
      taskScale: 'medium',
      enabledTools: ['Read', 'Edit', 'Write', 'Bash', 'Glob', 'Grep', 'Agent'],
    });

    assert.ok(activeIds.includes('planning_verification'));
    assert.ok(activeIds.includes('multi_agent_collaboration'));
    assert.ok(activeIds.includes('scope_minimization'));
    assert.ok(activeIds.includes('file_operations'));
    assert.ok(activeIds.includes('response_formatting'));
    assert.ok(activeIds.includes('feature_access_proxy_boundary'));
    assert.ok(activeIds.includes('git_operations'));
    assert.ok(activeIds.includes('action_safety'));
    assert.ok(activeIds.includes('security_permission_boundaries'));
    assert.ok(activeIds.includes('sensitive_data'));
  });

  test('legacy prompt appends optional capsules only when heuristics need them', async () => {
    const runtime = require('../src/services/khyUpgradeRuntime');

    const smallPrompt = await runtime.makeSystemPrompt('', {
      model: 'qwen2.5:32b',
      adapter: 'ollama',
    }, [], {
      userMessage: '什么是 MACD？',
      taskScale: 'small',
    });

    assert.doesNotMatch(smallPrompt, /## File Operations/);
    assert.doesNotMatch(smallPrompt, /## Scope Minimization/);
    assert.doesNotMatch(smallPrompt, /## Git Operations/);
    assert.doesNotMatch(smallPrompt, /# Error Recovery/);
    assert.doesNotMatch(smallPrompt, /# Output Format \(align with Claude Code style\)/);
    assert.doesNotMatch(smallPrompt, /# File operations/);
    assert.doesNotMatch(smallPrompt, /# Search and exploration/);
    assert.doesNotMatch(smallPrompt, /# Scope minimization and sufficient execution/);
    assert.doesNotMatch(smallPrompt, /# Committing changes with git/);
    assert.doesNotMatch(smallPrompt, /## Action Safety/);
    assert.doesNotMatch(smallPrompt, /## Security & Permission Boundaries/);
    assert.doesNotMatch(smallPrompt, /# Executing actions with care/);
    assert.doesNotMatch(smallPrompt, /# Security and permission boundaries/);
    assert.doesNotMatch(smallPrompt, /# Sensitive data/);

    const codingPrompt = await runtime.makeSystemPrompt('', {
      model: 'qwen2.5:32b',
      adapter: 'ollama',
    }, [], {
      userMessage: '修复 backend 登录 bug，先搜索 router 和 service，再修改文件并运行 npm test 验证。',
      taskScale: 'medium',
    });

    assert.doesNotMatch(codingPrompt, /## Scope Minimization/);
    assert.doesNotMatch(codingPrompt, /## File Operations/);
    assert.doesNotMatch(codingPrompt, /## Git Operations/);
    assert.match(codingPrompt, /# Scope minimization and sufficient execution/);
    assert.match(codingPrompt, /# File operations/);
    assert.match(codingPrompt, /# Error handling and fallback/);
    assert.match(codingPrompt, /# Command execution/);
    assert.match(codingPrompt, /# Search and exploration/);
    assert.match(codingPrompt, /# Response formatting/);
    assert.doesNotMatch(codingPrompt, /# Committing changes with git/);
    assert.doesNotMatch(codingPrompt, /# Executing actions with care/);
    assert.doesNotMatch(codingPrompt, /# Security and permission boundaries/);
    assert.doesNotMatch(codingPrompt, /# Sensitive data/);

    const gitPrompt = await runtime.makeSystemPrompt('', {
      model: 'qwen2.5:32b',
      adapter: 'ollama',
    }, [], {
      userMessage: '请帮我检查当前改动并创建 git commit。',
      taskScale: 'medium',
    });

    assert.doesNotMatch(gitPrompt, /## Git Operations/);
    assert.match(gitPrompt, /# Committing changes with git/);

    const riskyPrompt = await runtime.makeSystemPrompt('', {
      model: 'qwen2.5:32b',
      adapter: 'ollama',
    }, [], {
      userMessage: '请删除 logs 目录、检查 .env 里的 token 是否泄露，然后强制推送到远程。',
      taskScale: 'medium',
    });

    assert.doesNotMatch(riskyPrompt, /## Action Safety/);
    assert.doesNotMatch(riskyPrompt, /## Security & Permission Boundaries/);
    assert.match(riskyPrompt, /# Executing actions with care/);
    assert.match(riskyPrompt, /# Security and permission boundaries/);
    assert.match(riskyPrompt, /# Sensitive data/);
  });
});
