'use strict';

/**
 * projectMemoryRecall.test.js — 回归守卫:项目级记忆(仓库记忆)的**主动召回**。
 *
 * 背景(goal 2026-07-03「永久/仓库/会话/任务记忆…没把握主动写入与主动调用的时机,感觉特别健忘」):
 * 取证发现全局记忆(<root>/.khy/memory/MEMORY.md)每轮经 getMemorySection→loadMemoryPrompt 注入
 * 系统提示,而**项目级记忆**(<dataHome>/projects/<sha256(root)>/memory/MEMORY.md)有完整写入工具
 * (ensureProjectMemoryIndex 种契约、`/memory project` 人类入口)却**从不被读进模型上下文** —
 * 这正是用户所说的仓库记忆「没把握主动调用的时机」。本刀补上读侧:
 *   - memdir.loadProjectMemoryPrompt(projectRoot) 读项目 MEMORY.md 产系统提示段(空/无条目→null);
 *   - prompts.getMemorySection() 把它拼到全局记忆之后(门控 KHY_PROJECT_MEMORY_RECALL 默认开)。
 *
 * 关键契约:①未维护(无索引或只有空种子)→ null,字节回退不花上下文;②有真实指针条目 → 注入;
 * ③门控关 / KHY_DISABLE_MEMORY / KHY_PROJECT_MEMORY 关 → null;④绝不抛。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const memdir = require('../src/memdir/memdir');
const { getProjectMemoryDir } = require('../src/memdir/paths');

// 用唯一临时目录当项目根 → getProjectMemoryDir 按 sha256(root) 哈希出隔离目录,
// 绝不碰真实项目记忆。返回 { root, indexPath }。
function makeProjectRoot(tag) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `khy-projmem-${tag}-`));
  const dir = getProjectMemoryDir(root);
  fs.mkdirSync(dir, { recursive: true });
  return { root, indexPath: path.join(dir, 'MEMORY.md') };
}

function withEnv(overrides, fn) {
  const keys = Object.keys(overrides);
  const saved = keys.map((k) => [k, process.env[k]]);
  for (const k of keys) {
    if (overrides[k] === undefined) delete process.env[k];
    else process.env[k] = overrides[k];
  }
  try { return fn(); } finally {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

const POPULATED = [
  '# 项目记忆 (Project Memory)',
  '',
  '## 索引',
  '- [部署流程](deploy.md) — 先跑迁移再切流量',
  '- [限流阈值](ratelimit.md) — 网关 429 冷却 20s',
  '',
].join('\n');

const EMPTY_SEED = [
  '# 项目记忆 (Project Memory)',
  '',
  '## 索引',
  '<!-- 在下面逐行追加指针 -->',
  '',
].join('\n');

test('loadProjectMemoryPrompt: 无索引文件 → null', () => {
  const { root } = makeProjectRoot('none');
  assert.strictEqual(memdir.loadProjectMemoryPrompt(root), null);
});

test('loadProjectMemoryPrompt: 只有空种子(0 条目)→ null(不花上下文)', () => {
  const { root, indexPath } = makeProjectRoot('seed');
  fs.writeFileSync(indexPath, EMPTY_SEED);
  assert.strictEqual(memdir.loadProjectMemoryPrompt(root), null);
});

test('loadProjectMemoryPrompt: 有真实指针条目 → 注入段(含项目根与条目)', () => {
  const { root, indexPath } = makeProjectRoot('pop');
  fs.writeFileSync(indexPath, POPULATED);
  const out = memdir.loadProjectMemoryPrompt(root);
  assert.ok(out, 'should return a section');
  assert.match(out, /项目记忆 \(Project Memory\)/);
  assert.match(out, /project-scoped/);
  assert.ok(out.includes(root), 'embeds the project root');
  assert.match(out, /部署流程/);
  assert.match(out, /限流阈值/);
});

test('loadProjectMemoryPrompt: KHY_DISABLE_MEMORY 主关 → null', () => {
  const { root, indexPath } = makeProjectRoot('master');
  fs.writeFileSync(indexPath, POPULATED);
  for (const v of ['1', 'true']) {
    withEnv({ KHY_DISABLE_MEMORY: v }, () => {
      assert.strictEqual(memdir.loadProjectMemoryPrompt(root), null, v);
    });
  }
});

test('loadProjectMemoryPrompt: KHY_PROJECT_MEMORY 门控关 → null(字节回退)', () => {
  const { root, indexPath } = makeProjectRoot('gate');
  fs.writeFileSync(indexPath, POPULATED);
  for (const v of ['0', 'false', 'off', 'no']) {
    withEnv({ KHY_PROJECT_MEMORY: v }, () => {
      assert.strictEqual(memdir.loadProjectMemoryPrompt(root), null, v);
    });
  }
});

test('loadProjectMemoryPrompt: 绝不抛(坏入参 fail-soft)', () => {
  assert.doesNotThrow(() => memdir.loadProjectMemoryPrompt(12345));
  assert.doesNotThrow(() => memdir.loadProjectMemoryPrompt(null));
});

test('getMemorySection: KHY_PROJECT_MEMORY_RECALL 关 → 不含项目段(字节回退到全局)', () => {
  // cwd 恰有维护过的项目记忆时也不注入(召回门控关)。这里断言:关召回门控 → 输出不含项目段头。
  const prompts = require('../src/constants/prompts');
  for (const v of ['0', 'false', 'off', 'no', 'disable', 'disabled']) {
    withEnv({ KHY_PROJECT_MEMORY_RECALL: v }, () => {
      const out = prompts.getMemorySection();
      // 无论全局记忆是否存在,项目段专属头「Project Memory」都不该出现。
      if (out) assert.ok(!/# 项目记忆 \(Project Memory\)/.test(out), `recall off should not inject project section (${v})`);
    });
  }
});

test('getMemorySection: 默认开时把维护过的项目记忆拼进全局记忆之后', () => {
  // 直接构造 cwd = 一个含维护索引的项目根,验证 getMemorySection 输出含项目段。
  const { root, indexPath } = makeProjectRoot('section');
  fs.writeFileSync(indexPath, POPULATED);
  const prompts = require('../src/constants/prompts');
  const prevCwd = process.cwd();
  try {
    process.chdir(root);
    const out = withEnv({ KHY_PROJECT_MEMORY_RECALL: undefined, KHY_DISABLE_MEMORY: undefined },
      () => prompts.getMemorySection());
    assert.ok(out, 'should return a memory section');
    assert.match(out, /# 项目记忆 \(Project Memory\)/);
    assert.match(out, /部署流程/);
  } finally {
    process.chdir(prevCwd);
  }
});
