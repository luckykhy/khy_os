'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
describe('on-demand prompt sections', () => {
});

describe('Prompt On Demand Sections', () => {
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
    
          expect(prompt).not.toMatch(/# File operations/);
          expect(prompt).not.toMatch(/# Command execution/);
          expect(prompt).not.toMatch(/# Search and exploration/);
          expect(prompt).not.toMatch(/# Multi-agent collaboration/);
          expect(prompt).not.toMatch(/# Executing actions with care/);
          expect(prompt).not.toMatch(/# Security and permission boundaries/);
          expect(prompt).not.toMatch(/# Sensitive data/);
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
    
        expect(activeIds.has('scope_minimization').toBeTruthy());
        expect(activeIds.has('planning_verification').toBeTruthy());
        expect(activeIds.has('task_progress_management').toBeTruthy());
        expect(activeIds.has('error_handling_fallback').toBeTruthy());
        expect(activeIds.has('file_operations').toBeTruthy());
        expect(activeIds.has('command_execution').toBeTruthy());
        expect(activeIds.has('search_exploration').toBeTruthy());
        expect(activeIds.has('response_formatting').toBeTruthy());
        expect(!activeIds.has('feature_access_proxy_boundary').toBeTruthy());
        expect(!activeIds.has('multi_agent_collaboration').toBeTruthy());
    
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-prompt-capsule-'));
        try {
          const sections = await getSystemPrompt({
            cwd: tmpDir,
            enabledTools,
            userMessage,
            taskScale: 'medium',
          });
          const prompt = assembleSystemPrompt(sections);
    
          expect(prompt).toMatch(/# Scope minimization and sufficient execution/);
          expect(prompt).toMatch(/# Planning and verification/);
          expect(prompt).toMatch(/# Task and progress management/);
          expect(prompt).toMatch(/# Error handling and fallback/);
          expect(prompt).toMatch(/# File operations/);
          expect(prompt).toMatch(/# Command execution/);
          expect(prompt).toMatch(/# Search and exploration/);
          expect(prompt).toMatch(/# Response formatting/);
          expect(prompt).not.toMatch(/# Committing changes with git/);
          expect(prompt).not.toMatch(/# Executing actions with care/);
          expect(prompt).not.toMatch(/# Security and permission boundaries/);
          expect(prompt).not.toMatch(/# Sensitive data/);
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
    
        expect(activeIds.has('feature_access_proxy_boundary').toBeTruthy());
        expect(!activeIds.has('command_execution').toBeTruthy());
        expect(!activeIds.has('git_operations').toBeTruthy());
    
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-prompt-capsule-'));
        try {
          const sections = await getSystemPrompt({
            cwd: tmpDir,
            enabledTools,
            userMessage,
            taskScale: 'small',
          });
          const prompt = assembleSystemPrompt(sections);
    
          expect(prompt).toMatch(/# Feature access and proxy boundary/);
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
    
        expect(activeIds.has('scope_minimization').toBeTruthy());
        expect(activeIds.has('git_operations').toBeTruthy());
    
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-prompt-capsule-'));
        try {
          const sections = await getSystemPrompt({
            cwd: tmpDir,
            enabledTools,
            userMessage,
            taskScale: 'medium',
          });
          const prompt = assembleSystemPrompt(sections);
    
          expect(prompt).toMatch(/# Scope minimization and sufficient execution/);
          expect(prompt).toMatch(/# Committing changes with git/);
        } finally {
          fs.rmSync(tmpDir, { recursive: true, force: true });
        }
  });

  test('injects multi-agent capsule for medium tasks only when agent tools are available', async () => {
        const { listOnDemandPromptSectionIds } = require('../src/constants/prompts');
    
        const activeIds = new Set(listOnDemandPromptSectionIds({
          userMessage: '修复登录问题并验证结果。',
          taskScale: 'medium',
          enabledTools: ['Read', 'Edit', 'Write', 'Bash', 'Glob', 'Grep', 'Agent', 'SendMessage'],
        }));
    
        expect(activeIds.has('multi_agent_collaboration').toBeTruthy());
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
    
        expect(activeIds.has('action_safety').toBeTruthy());
        expect(activeIds.has('security_permission_boundaries').toBeTruthy());
        expect(activeIds.has('sensitive_data').toBeTruthy());
    
        const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-prompt-capsule-'));
        try {
          const sections = await getSystemPrompt({
            cwd: tmpDir,
            enabledTools,
            userMessage,
            taskScale: 'medium',
          });
          const prompt = assembleSystemPrompt(sections);
    
          expect(prompt).toMatch(/# Executing actions with care/);
          expect(prompt).toMatch(/# Security and permission boundaries/);
          expect(prompt).toMatch(/# Sensitive data/);
        } finally {
          fs.rmSync(tmpDir, { recursive: true, force: true });
        }
  });

  test('uses the same intent classifier for capsule ids and debug reasons', async () => {
        const { getOnDemandPromptSectionDecision } = require('../src/constants/prompts');
        const enabledTools = ['Read', 'Edit', 'Write', 'Bash', 'Glob', 'Grep'];
        const decision = getOnDemandPromptSectionDecision({
          userMessage: '请检查 .env 里的 token 是否泄露，然后强制推送到远程。',
          taskScale: 'medium',
          enabledTools,
        });
    
        expect(decision.ids).toContain('git_operations');
        expect(decision.ids).toContain('action_safety');
        expect(decision.ids).toContain('security_permission_boundaries');
        expect(decision.ids).toContain('sensitive_data');
        expect(decision.reasons).toContain('git_keywords');
        expect(decision.reasons).toContain('action_keywords');
        expect(decision.reasons).toContain('security_keywords');
        expect(decision.reasons).toContain('sensitive_data_keywords');
  });

  test('keeps every on-demand section id reachable through classifier rules', async () => {
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

  test('avoids triggering safety capsules for generic product or explanation wording', async () => {
        const { listOnDemandPromptSectionIds } = require('../src/constants/prompts');
        const enabledTools = ['Read', 'Edit', 'Write', 'Bash', 'Glob', 'Grep'];
    
        const marketingIds = new Set(listOnDemandPromptSectionIds({
          userMessage: '帮我做一个产品介绍页，强调高权限用户体验。',
          taskScale: 'small',
          enabledTools,
        }));
        expect(!marketingIds.has('action_safety').toBeTruthy());
        expect(!marketingIds.has('security_permission_boundaries').toBeTruthy());
        expect(!marketingIds.has('sensitive_data').toBeTruthy());
    
        const explainIds = new Set(listOnDemandPromptSectionIds({
          userMessage: '把生产环境发布流程解释一下。',
          taskScale: 'small',
          enabledTools,
        }));
        expect(!explainIds.has('action_safety').toBeTruthy());
        expect(!explainIds.has('security_permission_boundaries').toBeTruthy());
        expect(!explainIds.has('sensitive_data').toBeTruthy());
    
        const gitExplainIds = new Set(listOnDemandPromptSectionIds({
          userMessage: '解释一下 force push 的风险。',
          taskScale: 'small',
          enabledTools,
        }));
        expect(gitExplainIds.has('git_operations').toBeTruthy());
        expect(!gitExplainIds.has('action_safety').toBeTruthy());
        expect(!gitExplainIds.has('command_execution').toBeTruthy());
    
        const resetExplainIds = new Set(listOnDemandPromptSectionIds({
          userMessage: '请把 reset --hard 的行为解释清楚。',
          taskScale: 'small',
          enabledTools,
        }));
        expect(resetExplainIds.has('git_operations').toBeTruthy());
        expect(!resetExplainIds.has('action_safety').toBeTruthy());
        expect(!resetExplainIds.has('command_execution').toBeTruthy());
    
        const gitCommandExplainIds = new Set(listOnDemandPromptSectionIds({
          userMessage: '解释 git push 怎么执行。',
          taskScale: 'small',
          enabledTools,
        }));
        expect(gitCommandExplainIds.has('git_operations').toBeTruthy());
        expect(!gitCommandExplainIds.has('command_execution').toBeTruthy());
    
        const fileExplainIds = new Set(listOnDemandPromptSectionIds({
          userMessage: '解释一下 backend/src/cli/router.js 的作用。',
          taskScale: 'small',
          enabledTools,
        }));
        expect(fileExplainIds.has('file_operations').toBeTruthy());
        expect(!fileExplainIds.has('search_exploration').toBeTruthy());
    
        const searchLocateIds = new Set(listOnDemandPromptSectionIds({
          userMessage: '帮我在仓库里搜索 login handler 在哪里。',
          taskScale: 'small',
          enabledTools,
        }));
        expect(searchLocateIds.has('search_exploration').toBeTruthy());
        expect(!searchLocateIds.has('file_operations').toBeTruthy());
  });

  test('falls back to full optional section set for continuation turns', async () => {
        const { listOnDemandPromptSectionIds } = require('../src/constants/prompts');
    
        const activeIds = listOnDemandPromptSectionIds({
          userMessage: '继续',
          taskScale: 'medium',
          enabledTools: ['Read', 'Edit', 'Write', 'Bash', 'Glob', 'Grep', 'Agent'],
        });
    
        expect(activeIds).toContain('planning_verification');
        expect(activeIds).toContain('multi_agent_collaboration');
        expect(activeIds).toContain('scope_minimization');
        expect(activeIds).toContain('file_operations');
        expect(activeIds).toContain('response_formatting');
        expect(activeIds).toContain('feature_access_proxy_boundary');
        expect(activeIds).toContain('git_operations');
        expect(activeIds).toContain('action_safety');
        expect(activeIds).toContain('security_permission_boundaries');
        expect(activeIds).toContain('sensitive_data');
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
    
        expect(smallPrompt).not.toMatch(/## File Operations/);
        expect(smallPrompt).not.toMatch(/## Scope Minimization/);
        expect(smallPrompt).not.toMatch(/## Git Operations/);
        expect(smallPrompt).not.toMatch(/# Error Recovery/);
        expect(smallPrompt).not.toMatch(/# Output Format \(align with Claude Code style\)/);
        expect(smallPrompt).not.toMatch(/# File operations/);
        expect(smallPrompt).not.toMatch(/# Search and exploration/);
        expect(smallPrompt).not.toMatch(/# Scope minimization and sufficient execution/);
        expect(smallPrompt).not.toMatch(/# Committing changes with git/);
        expect(smallPrompt).not.toMatch(/## Action Safety/);
        expect(smallPrompt).not.toMatch(/## Security & Permission Boundaries/);
        expect(smallPrompt).not.toMatch(/# Executing actions with care/);
        expect(smallPrompt).not.toMatch(/# Security and permission boundaries/);
        expect(smallPrompt).not.toMatch(/# Sensitive data/);
    
        const codingPrompt = await runtime.makeSystemPrompt('', {
          model: 'qwen2.5:32b',
          adapter: 'ollama',
        }, [], {
          userMessage: '修复 backend 登录 bug，先搜索 router 和 service，再修改文件并运行 npm test 验证。',
          taskScale: 'medium',
        });
    
        expect(codingPrompt).not.toMatch(/## Scope Minimization/);
        expect(codingPrompt).not.toMatch(/## File Operations/);
        expect(codingPrompt).not.toMatch(/## Git Operations/);
        expect(codingPrompt).toMatch(/# Scope minimization and sufficient execution/);
        expect(codingPrompt).toMatch(/# File operations/);
        expect(codingPrompt).toMatch(/# Error handling and fallback/);
        expect(codingPrompt).toMatch(/# Command execution/);
        expect(codingPrompt).toMatch(/# Search and exploration/);
        expect(codingPrompt).toMatch(/# Response formatting/);
        expect(codingPrompt).not.toMatch(/# Committing changes with git/);
        expect(codingPrompt).not.toMatch(/# Executing actions with care/);
        expect(codingPrompt).not.toMatch(/# Security and permission boundaries/);
        expect(codingPrompt).not.toMatch(/# Sensitive data/);
    
        const gitPrompt = await runtime.makeSystemPrompt('', {
          model: 'qwen2.5:32b',
          adapter: 'ollama',
        }, [], {
          userMessage: '请帮我检查当前改动并创建 git commit。',
          taskScale: 'medium',
        });
    
        expect(gitPrompt).not.toMatch(/## Git Operations/);
        expect(gitPrompt).toMatch(/# Committing changes with git/);
    
        const riskyPrompt = await runtime.makeSystemPrompt('', {
          model: 'qwen2.5:32b',
          adapter: 'ollama',
        }, [], {
          userMessage: '请删除 logs 目录、检查 .env 里的 token 是否泄露，然后强制推送到远程。',
          taskScale: 'medium',
        });
    
        expect(riskyPrompt).not.toMatch(/## Action Safety/);
        expect(riskyPrompt).not.toMatch(/## Security & Permission Boundaries/);
        expect(riskyPrompt).toMatch(/# Executing actions with care/);
        expect(riskyPrompt).toMatch(/# Security and permission boundaries/);
        expect(riskyPrompt).toMatch(/# Sensitive data/);
  });

});
