'use strict';

/**
 * toolFunnelGuard.test.js — verifies the executeTool integration seam of the
 * dynamic adaptive constraint engine ([DESIGN-ARCH-034] 接管点).
 *
 * The thesis under test: at the real tool funnel, the SAME write is waved through
 * for a strong model (宾客原则, zero validation) yet physically clamped for a weak
 * model (高压电笼, code-level AST blocking) — and irreversible ops escalate to
 * System_Block with fail-closed confirmation.
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const guard = require('../../../src/services/metaConstraint/toolFunnelGuard');
const { EXEC_APPROVED } = require('../../../src/services/execApproval');

const GUEST_MODEL = 'claude-opus-4-8'; // T0 → guest
const CAGE_MODEL = 'claude-haiku-4-5'; // T3 → cage

const VALID_JS = 'function f(){ return 1; }';
const BROKEN_JS = 'function f({ return 1; ;;;'; // unbalanced — babel/vm both reject

describe('toolFunnelGuard.enforce — kill-switch & fail-open', () => {
  test('KHY_METACONSTRAINT=off → 整体旁路放行', async () => {
    const prev = process.env.KHY_METACONSTRAINT;
    process.env.KHY_METACONSTRAINT = 'off';
    try {
      const v = await guard.enforce({
        tool: 'editFile',
        params: { path: '/app/src/a.js', content: BROKEN_JS },
        traceContext: { model: CAGE_MODEL },
      });
      assert.equal(v.allow, true);
      assert.equal(v.skipped, true);
    } finally {
      if (prev === undefined) delete process.env.KHY_METACONSTRAINT;
      else process.env.KHY_METACONSTRAINT = prev;
    }
  });
});

describe('toolFunnelGuard.enforce — 宾客原则 vs 高压电笼（同一次写入）', () => {
  test('强模型改源码 → Prompt_Soft 放行，连坏语法都不校验（零损耗）', async () => {
    const v = await guard.enforce({
      tool: 'editFile',
      params: { path: '/app/src/a.js', content: BROKEN_JS },
      traceContext: { model: GUEST_MODEL },
    });
    assert.equal(v.allow, true);
    assert.equal(v.band, 'guest');
    assert.equal(v.floor, 'Prompt_Soft');
  });

  test('弱模型改同一源码（合法）→ Code_Hard 过校验放行', async () => {
    const v = await guard.enforce({
      tool: 'editFile',
      params: { path: '/app/src/a.js', content: VALID_JS },
      traceContext: { model: CAGE_MODEL },
    });
    assert.equal(v.allow, true);
    assert.equal(v.band, 'cage');
    assert.equal(v.floor, 'Code_Hard');
  });

  test('弱模型改源码（坏语法）→ Code_Hard 代码级物理阻断', async () => {
    const v = await guard.enforce({
      tool: 'editFile',
      params: { path: '/app/src/a.js', content: BROKEN_JS },
      traceContext: { model: CAGE_MODEL },
    });
    assert.equal(v.allow, false);
    assert.equal(v.band, 'cage');
    assert.equal(v.floor, 'Code_Hard');
    assert.match(v.error, /Code_Hard/);
  });

  test('弱模型改 Markdown（creative 无语言）→ Code_Hard 但无可校验内容 → 放行', async () => {
    const v = await guard.enforce({
      tool: 'editFile',
      params: { path: '/app/README.md', content: '# title' },
      traceContext: { model: CAGE_MODEL },
    });
    assert.equal(v.allow, true);
    assert.equal(v.floor, 'Code_Hard');
  });
});

describe('toolFunnelGuard.enforce — System_Block 不可逆操作', () => {
  test('弱模型不可逆删除 + 无确认通道 → fail-closed 拦截', async () => {
    const v = await guard.enforce({
      tool: 'shell',
      params: { command: 'rm -rf build' },
      traceContext: { model: CAGE_MODEL }, // no onControlRequest
    });
    assert.equal(v.allow, false);
    assert.equal(v.floor, 'System_Block');
    assert.match(v.error, /fail-closed/);
  });

  test('网关已盖 EXEC_APPROVED 戳 → 免二次打断直接放行', async () => {
    const params = { command: 'rm -rf build' };
    params[EXEC_APPROVED] = true;
    const v = await guard.enforce({
      tool: 'shell',
      params,
      traceContext: { model: CAGE_MODEL },
    });
    assert.equal(v.allow, true);
    assert.equal(v.preApproved, true);
  });

  test('有确认通道且显式 allow → 放行', async () => {
    const v = await guard.enforce({
      tool: 'shell',
      params: { command: 'rm -rf build' },
      traceContext: { model: CAGE_MODEL, onControlRequest: async () => true },
    });
    assert.equal(v.allow, true);
    assert.equal(v.confirmed, true);
  });

  test('有确认通道但拒绝 → 拦截', async () => {
    const v = await guard.enforce({
      tool: 'shell',
      params: { command: 'rm -rf build' },
      traceContext: { model: CAGE_MODEL, onControlRequest: async () => false },
    });
    assert.equal(v.allow, false);
    assert.equal(v.floor, 'System_Block');
  });

  test('防呆⑤：强模型不可逆 → 仅 Code_Hard（非 Block），不被无谓挂起', async () => {
    const v = await guard.enforce({
      tool: 'deleteFile',
      params: { path: '/app/x.txt' },
      traceContext: { model: GUEST_MODEL },
    });
    assert.equal(v.band, 'guest');
    assert.equal(v.floor, 'Code_Hard');
    assert.equal(v.allow, true); // no content/language to validate → passes
  });
});

describe('toolFunnelGuard — 模型解析与工具链推断', () => {
  test('无 traceContext.model → 落 GATEWAY_PREFERRED_MODEL', () => {
    const prev = process.env.GATEWAY_PREFERRED_MODEL;
    process.env.GATEWAY_PREFERRED_MODEL = CAGE_MODEL;
    try {
      assert.equal(guard._resolveModelId({}), CAGE_MODEL);
      assert.equal(guard._resolveModelId({ model: GUEST_MODEL }), GUEST_MODEL);
    } finally {
      if (prev === undefined) delete process.env.GATEWAY_PREFERRED_MODEL;
      else process.env.GATEWAY_PREFERRED_MODEL = prev;
    }
  });

  test('扩展名 → 语言/执行器映射', () => {
    assert.equal(guard._toolchainForPath('/a/b.js').executor, 'js_babel_writer');
    assert.equal(guard._toolchainForPath('/a/b.py').language, 'python');
    assert.equal(guard._toolchainForPath('/a/b.md').executor, 'raw_string_injector');
  });

  test('content 跨参数名提取（content/new_string/text）', () => {
    assert.equal(guard._contentOf({ content: 'a' }), 'a');
    assert.equal(guard._contentOf({ new_string: 'b' }), 'b');
    assert.equal(guard._contentOf({ text: 'c' }), 'c');
    assert.equal(guard._contentOf({}), null);
  });
});
