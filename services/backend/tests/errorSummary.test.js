'use strict';

const { compactAiErrorReply, compactGatewayStatusText } = require('../src/cli/errorSummary');

describe('errorSummary', () => {
  test('compacts structured gateway error into summary and suggestion preview', () => {
    const raw = [
      '真实失败原因:',
      '- claude [process]: recent process failure cached: canceled (cooldown 22s)',
      '- Relay API (claude-opus-4-6::direct) [unknown]: Client network socket disconnected before secure TLS connection was established',
      '',
      '已选择模型通道进程中断（非用户取消）: canceled',
      '',
      '建议下一步:',
      '  1) 运行 `khy gateway status` 查看各通道状态',
      '  2) 运行 `khy gateway model` 仅选择“可执行”模型',
      '  3) 运行 `khy gateway reconnect claude` 强制重连后重试',
    ].join('\n');

    const out = compactAiErrorReply(raw, {
      maxSummaryLen: 180,
      maxSuggestionLines: 2,
      maxFailurePreview: 1,
    });

    expect(out.summary).toContain('已选择模型通道进程中断');
    expect(out.hasStructuredDetails).toBe(true);
    expect(out.failureItems.length).toBeGreaterThanOrEqual(2);
    expect(out.suggestionPreview.length).toBe(2);
    expect(out.hiddenSuggestionCount).toBeGreaterThanOrEqual(1);
  });

  test('compacts gateway status text to one-line digest', () => {
    const raw = [
      '失败原因: 真实失败原因:',
      '- claude [process]: canceled',
      '- relay: tls disconnected',
      '建议下一步:',
      '1) gateway status',
      '2) gateway model',
      '3) gateway reconnect',
    ].join('\n');
    const out = compactGatewayStatusText(raw, { maxLen: 120 });

    expect(out.startsWith('失败摘要:')).toBe(true);
    expect(out.length).toBeLessThanOrEqual(120);
  });

  test('keeps plain text status when no structured sections', () => {
    const raw = 'Claude Code 重试中（等待冷却窗口，约 22s）';
    const out = compactGatewayStatusText(raw, { maxLen: 120 });

    expect(out).toBe(raw);
  });
});
