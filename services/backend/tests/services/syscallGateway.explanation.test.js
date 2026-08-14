'use strict';

/**
 * syscallGateway.explanation.test.js — Part D 端到端布线。
 *
 * 证明网关的 makeControlPrompter 在 L1/L2 审批时，把 preExecutionExplainer 的
 * 执行前说明随 input 下发给宿主 onControlRequest（宿主据此渲染）。
 */

const { makeControlPrompter } = require('../../src/services/syscallGateway');
const { buildIntent } = require('../../src/services/syscallGateway/intentSchema');

function capturePrompter() {
  const seen = [];
  const onControlRequest = async ({ request }) => {
    seen.push(request.input);
    // L2 需要回传 typed 才算确认；这里给齐以便观察 input。
    return { response: { behavior: 'allow', typed: 'YES' } };
  };
  return { prompter: makeControlPrompter(onControlRequest), seen };
}

describe('makeControlPrompter 注入执行前说明', () => {
  test('L1 写入：input.explanation 存在且 depth=standard', async () => {
    const { prompter, seen } = capturePrompter();
    const intent = buildIntent({ tool: 'write_file', params: { path: '/proj/src/a.txt' }, cwd: '/proj', home: '/home/u' });
    await prompter.askL1(intent);
    expect(seen).toHaveLength(1);
    expect(seen[0].explanation).toBeTruthy();
    expect(typeof seen[0].explanation.text).toBe('string');
    expect(seen[0].explanation.level).toBe('L1');
  });

  test('L2 破坏性：input.explanation 详尽且标记高风险', async () => {
    const { prompter, seen } = capturePrompter();
    const intent = buildIntent({ tool: 'deleteFile', params: { path: '/proj/x' }, isDestructive: true, cwd: '/proj', home: '/home/u' });
    const res = await prompter.confirmL2(intent);
    expect(res.typed).toBe('YES');           // 新契约：confirmL2 返回 { typed, session }
    expect(res.session).toBe(false);         // behavior=allow（非 allow-always）→ 非会话免审
    expect(seen).toHaveLength(1);
    expect(seen[0].explanation.depth).toBe('detailed');
    expect(seen[0].explanation.headline).toMatch(/⚠/);
  });
});
