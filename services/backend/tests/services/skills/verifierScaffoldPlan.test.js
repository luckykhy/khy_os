'use strict';

/**
 * verifierScaffoldPlan.test.js — 纯叶子 `/init-verifiers` 逻辑契约(node:test,零 IO)。
 *
 * 锁定:planVerifierName / planVerifierNameScoped 命名约定;buildScaffoldInstructions 含五阶段、
 * 含 khy 真发现结构(.khy/skills + manifest.json + prompt.md)、**绝不**写 CC 的 .claude/skills/SKILL.md、
 * 含「verifier 子串」约定、密钥用环境变量;门控梯。
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const {
  VERIFIER_TYPES,
  DEFAULT_SKILLS_DIR,
  planVerifierName,
  planVerifierNameScoped,
  buildScaffoldInstructions,
  isEnabled,
} = require('../../../src/services/skills/verifierScaffoldPlan');

describe('planVerifierName', () => {
  test('web → verifier-playwright', () => {
    assert.equal(planVerifierName('web'), 'verifier-playwright');
  });
  test('cli → verifier-cli', () => {
    assert.equal(planVerifierName('cli'), 'verifier-cli');
  });
  test('api → verifier-api', () => {
    assert.equal(planVerifierName('api'), 'verifier-api');
  });
  test('按 type 别名也命中', () => {
    assert.equal(planVerifierName('playwright'), 'verifier-playwright');
  });
  test('未知 → 通用 verifier', () => {
    assert.equal(planVerifierName('weird'), 'verifier');
    assert.equal(planVerifierName(''), 'verifier');
    assert.equal(planVerifierName(null), 'verifier');
  });
});

describe('planVerifierNameScoped', () => {
  test('多领域 → verifier-<project>-<type>', () => {
    assert.equal(planVerifierNameScoped('My App', 'web'), 'verifier-my-app-playwright');
    assert.equal(planVerifierNameScoped('khy-os', 'api'), 'verifier-khy-os-api');
  });
  test('无项目名 → verifier-<type>', () => {
    assert.equal(planVerifierNameScoped('', 'cli'), 'verifier-cli');
  });
  test('未知类型 → app token', () => {
    assert.equal(planVerifierNameScoped('proj', 'weird'), 'verifier-proj-app');
  });
});

describe('buildScaffoldInstructions', () => {
  const out = buildScaffoldInstructions();

  test('含五阶段', () => {
    assert.match(out, /Phase 1/);
    assert.match(out, /Phase 2/);
    assert.match(out, /Phase 3/);
    assert.match(out, /Phase 4/);
    assert.match(out, /Phase 5/);
  });
  test('目标 khy 真发现结构:.khy/skills + manifest.json + prompt.md', () => {
    assert.match(out, /\.khy\/skills/);
    assert.match(out, /manifest\.json/);
    assert.match(out, /prompt\.md/);
  });
  test('诚实分歧:目标 .khy/skills,且显式提醒别用 CC 的 .claude/skills', () => {
    // 正向脚手架目标必须是 khy 真发现路径。
    assert.match(out, /把每个校验器写到 `\.khy\/skills/);
    // 且必须显式提醒不要用 .claude/skills(诚实告知分歧)。
    assert.match(out, /不要.*\.claude\/skills|\.claude\/skills.*不发现/);
  });
  test('含 verifier 子串发现约定', () => {
    assert.match(out, /verifier.*子串|含 "verifier"/);
  });
  test('密钥安全:用环境变量,不写明文', () => {
    assert.match(out, /环境变量/);
    assert.match(out, /TEST_USER|TEST_PASSWORD/);
    assert.match(out, /绝不.*明文|明文.*绝不/);
  });
  test('自定义 skillsDir 注入', () => {
    const o2 = buildScaffoldInstructions({ skillsDir: 'custom/skills' });
    assert.match(o2, /custom\/skills/);
  });
  test('默认 skillsDir 常量', () => {
    assert.equal(DEFAULT_SKILLS_DIR, '.khy/skills');
  });
  test('三类校验器都出现', () => {
    for (const v of VERIFIER_TYPES) assert.ok(out.includes(v.name), v.name);
  });
});

describe('门控 isEnabled', () => {
  test('默认 → 开', () => {
    assert.equal(isEnabled({}), true);
    assert.equal(isEnabled({ KHY_INIT_VERIFIERS: 'true' }), true);
  });
  test('falsy → 关', () => {
    for (const v of ['0', 'false', 'off', 'no', '']) {
      assert.equal(isEnabled({ KHY_INIT_VERIFIERS: v }), false);
    }
  });
});
