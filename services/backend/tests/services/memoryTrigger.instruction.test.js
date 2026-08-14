'use strict';

/**
 * memoryTrigger — instruction 分支(项目约定 → 指令文件候选)的确定性测试。
 *
 * 锁定:① 高置信度项目约定命中 kind='instruction'(target=khy·scope=project);
 * ② 零假阳性(一次性任务/疑问句/身份/偏好均不误判为 instruction);③ identity/preference
 * 仍各归其类(instruction 不抢);④ 子门控 KHY_INSTRUCTION_CANDIDATE 关 → instruction 恒不触发;
 * ⑤ INSTRUCTION_RE 与 IDENTITY_RE/PREFERENCE_RE 正交。
 */

const test = require('node:test');
const assert = require('node:assert');

const mt = require('../../src/services/memoryTrigger');

// 每个用例前把三道门控都置开(默认开,但显式化以防环境残留)。
function withGatesOn(extra, fn) {
  const saved = {
    KHY_MEMORY_TRIGGER: process.env.KHY_MEMORY_TRIGGER,
    KHY_PROACTIVE_CAPTURE: process.env.KHY_PROACTIVE_CAPTURE,
    KHY_INSTRUCTION_CANDIDATE: process.env.KHY_INSTRUCTION_CANDIDATE,
  };
  process.env.KHY_MEMORY_TRIGGER = 'true';
  process.env.KHY_PROACTIVE_CAPTURE = 'true';
  process.env.KHY_INSTRUCTION_CANDIDATE = 'true';
  Object.assign(process.env, extra || {});
  try { return fn(); } finally {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

// ── instruction 命中 ─────────────────────────────────────────────────────────
test('项目统一用某包管理器 → instruction(target=khy·scope=project)', () => {
  withGatesOn({}, () => {
    const d = mt.classify('这个项目统一用 pnpm');
    assert.strictEqual(d.kind, 'instruction');
    assert.strictEqual(d.target, 'khy');
    assert.strictEqual(d.scope, 'project');
    assert.ok(d.note && d.note.includes('pnpm'));
  });
});

test('提交前必须跑测试 → instruction', () => {
  withGatesOn({}, () => {
    assert.strictEqual(mt.classify('提交前必须跑测试').kind, 'instruction');
  });
});

test('构建命令是 … → instruction', () => {
  withGatesOn({}, () => {
    assert.strictEqual(mt.classify('构建命令是 npm run build').kind, 'instruction');
  });
});

test('本项目禁止直接改 main → instruction', () => {
  withGatesOn({}, () => {
    assert.strictEqual(mt.classify('本项目禁止直接改 main 分支').kind, 'instruction');
  });
});

test('测试框架用 vitest → instruction', () => {
  withGatesOn({}, () => {
    assert.strictEqual(mt.classify('测试框架用 vitest').kind, 'instruction');
  });
});

test('英文 this project uses … → instruction', () => {
  withGatesOn({}, () => {
    assert.strictEqual(mt.classify('this project uses TypeScript strict mode').kind, 'instruction');
  });
});

// ── 零假阳性 ─────────────────────────────────────────────────────────────────
test('一次性任务陈述 → 不误判为 instruction', () => {
  withGatesOn({}, () => {
    assert.notStrictEqual(mt.classify('帮我修下这个 bug').kind, 'instruction');
    assert.notStrictEqual(mt.classify('给我写个快速排序').kind, 'instruction');
  });
});

test('疑问句(即便含约定词)→ 不误判为 instruction', () => {
  withGatesOn({}, () => {
    assert.notStrictEqual(mt.classify('这个项目用什么包管理器？').kind, 'instruction');
    assert.notStrictEqual(mt.classify('构建命令是什么怎么跑').kind, 'instruction');
  });
});

test('寒暄 → none', () => {
  withGatesOn({}, () => {
    assert.strictEqual(mt.classify('你好呀今天天气不错').kind, 'none');
  });
});

// ── 与 identity/preference 不冲突 ────────────────────────────────────────────
test('身份声明仍归 proactive/user-name(instruction 不抢)', () => {
  withGatesOn({}, () => {
    const d = mt.classify('我叫张三');
    assert.strictEqual(d.kind, 'proactive');
    assert.strictEqual(d.name, 'user-name');
  });
});

test('个人偏好仍归 proactive/feedback(instruction 不抢)', () => {
  withGatesOn({}, () => {
    const d = mt.classify('我习惯用 tab 缩进');
    assert.strictEqual(d.kind, 'proactive');
    assert.strictEqual(d.type, 'feedback');
  });
});

test('显式「请记住」仍归 explicit(优先级最高)', () => {
  withGatesOn({}, () => {
    assert.strictEqual(mt.classify('记住这个项目统一用 pnpm').kind, 'explicit');
  });
});

// ── 子门控 ───────────────────────────────────────────────────────────────────
test('KHY_INSTRUCTION_CANDIDATE=off → instruction 分支恒不触发(退化 none)', () => {
  withGatesOn({ KHY_INSTRUCTION_CANDIDATE: 'off' }, () => {
    assert.strictEqual(mt.classify('这个项目统一用 pnpm').kind, 'none');
  });
});

test('isInstructionCandidateEnabled: 默认开;{0,false,off,no} 关', () => {
  const saved = process.env.KHY_INSTRUCTION_CANDIDATE;
  try {
    delete process.env.KHY_INSTRUCTION_CANDIDATE;
    assert.strictEqual(mt.isInstructionCandidateEnabled(), true);
    for (const v of ['0', 'false', 'off', 'no', 'OFF']) {
      process.env.KHY_INSTRUCTION_CANDIDATE = v;
      assert.strictEqual(mt.isInstructionCandidateEnabled(), false, `应关: ${v}`);
    }
  } finally {
    if (saved === undefined) delete process.env.KHY_INSTRUCTION_CANDIDATE;
    else process.env.KHY_INSTRUCTION_CANDIDATE = saved;
  }
});

// ── 判据正交 ─────────────────────────────────────────────────────────────────
test('INSTRUCTION_RE 与 IDENTITY_RE/PREFERENCE_RE 正交', () => {
  // 项目约定命中 instruction,不命中身份/偏好。
  assert.ok(mt.INSTRUCTION_RE.test('这个项目统一用 pnpm'));
  assert.ok(!mt.IDENTITY_RE.test('这个项目统一用 pnpm'));
  assert.ok(!mt.PREFERENCE_RE.test('这个项目统一用 pnpm'));
  // 身份/偏好不命中 instruction。
  assert.ok(!mt.INSTRUCTION_RE.test('我叫张三'));
  assert.ok(!mt.INSTRUCTION_RE.test('我习惯用 tab'));
});
