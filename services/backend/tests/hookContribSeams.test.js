'use strict';

/**
 * hookContribSeams.test.js — Block B「插件注册点」核心交付:
 *   ToolPermission 单调收紧(绝无放松路径) + PromptSection 只追加。
 *
 * Asserted invariants(与任务卡一一对应):
 *   1. tighten 格 —— auto<confirm<deny 取更严者;未知/空裁决按「不表态」处理,
 *      因此坏 handler 既不能放松也不能意外收紧。
 *   2. **不可放松(核心不变式)** —— 对 STRATEGIES 的**全部有序对**穷举:收紧结果的严格度
 *      永远 >= 基线。这是「hook 无法削弱权限」的机器可证版本。
 *   3. block 语义 —— res.blocked → 取格上最严者,但基线已最严时不变(仍走 tighten)。
 *   4. 门控关 —— KHY_HOOK_TOOL_PERMISSION=off → 原样返回基线,hook 绝不触发。
 *   5. 绝不抛 —— hook 抛错/坏返回 → 回落基线(权限)或空串(提示词)。
 *   6. PromptSection —— 收集 sections/section、过滤空白、门控关 → 空串。
 */

const { test, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');

const seams = require('../src/services/hooks/hookContribSeams');
const { STRATEGIES } = require('../src/services/permissionPolicy/config');
const hookSystem = require('../src/services/hooks/hookSystem');

// 用 monkey-patch 替换 trigger/isInitialized,避免依赖磁盘 hooks.json(纯单元测试)。
const _origTrigger = hookSystem.trigger;
const _origIsInit = hookSystem.isInitialized;

function stubHook(result) {
  hookSystem.isInitialized = () => true;
  hookSystem.trigger = async () => result;
}
function stubThrow() {
  hookSystem.isInitialized = () => true;
  hookSystem.trigger = async () => {
    throw new Error('hook boom');
  };
}

beforeEach(() => {
  delete process.env.KHY_HOOK_TOOL_PERMISSION;
  delete process.env.KHY_HOOK_PROMPT_SECTION;
});

afterEach(() => {
  hookSystem.trigger = _origTrigger;
  hookSystem.isInitialized = _origIsInit;
  delete process.env.KHY_HOOK_TOOL_PERMISSION;
  delete process.env.KHY_HOOK_PROMPT_SECTION;
});

const strictness = (d) => STRATEGIES.indexOf(d);

// ── 1. tighten lattice ───────────────────────────────────────────────
test('tighten picks the stricter of two decisions', () => {
  assert.equal(seams.tighten('auto', 'confirm'), 'confirm');
  assert.equal(seams.tighten('confirm', 'auto'), 'confirm', 'hook cannot relax confirm→auto');
  assert.equal(seams.tighten('deny', 'auto'), 'deny', 'hook cannot relax deny→auto');
  assert.equal(seams.tighten('deny', 'confirm'), 'deny', 'hook cannot relax deny→confirm');
  assert.equal(seams.tighten('auto', 'deny'), 'deny', 'hook CAN tighten auto→deny');
});

test('tighten treats unknown/empty proposals as "no opinion"', () => {
  assert.equal(seams.tighten('confirm', 'bogus'), 'confirm');
  assert.equal(seams.tighten('confirm', ''), 'confirm');
  assert.equal(seams.tighten('confirm', undefined), 'confirm');
});

// ── 2. THE core invariant: exhaustive no-relaxation proof ────────────
test('EXHAUSTIVE: tighten never relaxes for any ordered pair of STRATEGIES', () => {
  for (const base of STRATEGIES) {
    for (const proposed of STRATEGIES) {
      const out = seams.tighten(base, proposed);
      assert.ok(
        strictness(out) >= strictness(base),
        `tighten(${base}, ${proposed}) = ${out} must never be weaker than base`
      );
      assert.equal(out, strictness(proposed) > strictness(base) ? proposed : base);
    }
  }
});

test('EXHAUSTIVE: applyToolPermissionHooks never relaxes any base decision', async () => {
  for (const base of STRATEGIES) {
    for (const proposed of STRATEGIES) {
      stubHook({ blocked: false, context: { decision: proposed } });
      const out = await seams.applyToolPermissionHooks(base, {});
      assert.ok(
        strictness(out) >= strictness(base),
        `hook proposing ${proposed} against base ${base} produced weaker ${out}`
      );
    }
  }
});

// ── 3. block semantics ───────────────────────────────────────────────
test('blocked:true tightens to the strictest strategy', async () => {
  stubHook({ blocked: true, context: {} });
  assert.equal(await seams.applyToolPermissionHooks('auto', ), STRATEGIES[STRATEGIES.length - 1]);
});

test('blocked:true cannot weaken an already-strictest base', async () => {
  const strictest = STRATEGIES[STRATEGIES.length - 1];
  stubHook({ blocked: true, context: {} });
  assert.equal(await seams.applyToolPermissionHooks(strictest, {}), strictest);
});

// ── 4. gate off → byte-identical fallback ────────────────────────────
test('gate OFF → base decision returned unchanged, hook never fires', async () => {
  let fired = false;
  hookSystem.isInitialized = () => true;
  hookSystem.trigger = async () => {
    fired = true;
    return { blocked: true, context: { decision: 'deny' } };
  };
  process.env.KHY_HOOK_TOOL_PERMISSION = 'off';

  assert.equal(await seams.applyToolPermissionHooks('auto', {}), 'auto');
  assert.equal(fired, false, 'gated off → trigger must not run');
});

test('uninitialized hook system → base decision unchanged', async () => {
  hookSystem.isInitialized = () => false;
  let fired = false;
  hookSystem.trigger = async () => {
    fired = true;
    return { blocked: true, context: {} };
  };
  assert.equal(await seams.applyToolPermissionHooks('confirm', ), 'confirm');
  assert.equal(fired, false);
});

// ── 5. never throws ──────────────────────────────────────────────────
test('hook that throws → falls back to base decision without throwing', async () => {
  stubThrow();
  await assert.doesNotReject(() => seams.applyToolPermissionHooks('confirm', {}));
  assert.equal(await seams.applyToolPermissionHooks('confirm', {}), 'confirm');
});

test('malformed hook result → base decision unchanged', async () => {
  for (const bad of [null, undefined, {}, { context: null }, { context: { decision: 42 } }]) {
    stubHook(bad);
    assert.equal(await seams.applyToolPermissionHooks('confirm', {}), 'confirm');
  }
});

// ── 6. PromptSection: append-only ────────────────────────────────────
test('collectPromptSections joins sections array', async () => {
  stubHook({ blocked: false, context: { sections: ['第一段', '第二段'] } });
  assert.equal(await seams.collectPromptSections({}), '第一段\n\n第二段');
});

test('collectPromptSections accepts a single section string', async () => {
  stubHook({ blocked: false, context: { section: '只有一段' } });
  assert.equal(await seams.collectPromptSections({}), '只有一段');
});

test('collectPromptSections filters blank/non-string entries', async () => {
  stubHook({ blocked: false, context: { sections: ['  keep  ', '', '   ', null, 7, {}] } });
  assert.equal(await seams.collectPromptSections({}), 'keep');
});

test('collectPromptSections gate OFF → empty string, hook never fires', async () => {
  let fired = false;
  hookSystem.isInitialized = () => true;
  hookSystem.trigger = async () => {
    fired = true;
    return { blocked: false, context: { section: 'should not appear' } };
  };
  process.env.KHY_HOOK_PROMPT_SECTION = 'off';

  assert.equal(await seams.collectPromptSections({}), '');
  assert.equal(fired, false);
});

test('collectPromptSections soft-fails to empty string when hook throws', async () => {
  stubThrow();
  await assert.doesNotReject(() => seams.collectPromptSections({}));
  assert.equal(await seams.collectPromptSections({}), '');
});

test('collectPromptSections returns empty string when no sections provided', async () => {
  stubHook({ blocked: false, context: {} });
  assert.equal(await seams.collectPromptSections({}), '');
});
