'use strict';

/**
 * statusLabels.test.js — pure streaming status-label & classification helpers.
 *
 * Extracted verbatim from the cli/repl.js god file as part of the
 * behavior-preserving split. These were per-request closures with NO direct
 * test coverage; this pins their contracts as an importable, pure module.
 */

const {
  extractToolStep,
  phaseActionLabel,
  phaseStageLabel,
  normalizeProgressKey,
  normalizeStatusDedupKey,
  isFailureMetricOnlyStatus,
  isLowValueGatewayStatus,
  isFailureSignalStatus,
  shouldBypassStartSilent,
  isDynamicProgressStatus,
  deriveLiveActivity,
  stripTrailingEllipsis,
  thinkingClause,
} = require('../../src/cli/repl/statusLabels');

describe('extractToolStep', () => {
  test('extracts and clamps a [n / m] step marker', () => {
    expect(extractToolStep('foo [2 / 5] bar')).toBe('2/5');
    expect(extractToolStep('[7/3]')).toBe('3/3'); // current clamped to total
    expect(extractToolStep('[0/4]')).toBe('1/4'); // current floored to 1
  });

  test('returns empty string when absent or invalid', () => {
    expect(extractToolStep('no marker')).toBe('');
    expect(extractToolStep('[1/0]')).toBe(''); // total <= 0
    expect(extractToolStep('')).toBe('');
  });
});

describe('phaseActionLabel', () => {
  test('maps known phases and falls back generically', () => {
    expect(phaseActionLabel('init')).toBe('初始化链路');
    expect(phaseActionLabel('REQUEST')).toBe('请求上游模型'); // case-insensitive
    expect(phaseActionLabel('done')).toBe('完成请求');
    expect(phaseActionLabel('mystery')).toBe('推进执行链路');
  });
});

describe('phaseStageLabel', () => {
  test('refines init by detail keyword', () => {
    expect(phaseStageLabel('init', 'gateway probe')).toBe('初始化/通道预检');
    expect(phaseStageLabel('init', '正在 RAG 检索')).toBe('初始化/上下文召回');
    expect(phaseStageLabel('init', '')).toBe('初始化/请求准备');
  });

  test('refines tool_progress with step markers and outcome', () => {
    expect(phaseStageLabel('tool_progress', 'running [1 / 3]')).toBe('工具执行/步骤 1/3');
    expect(phaseStageLabel('tool_progress', 'success ✓')).toBe('工具执行/结果确认');
    expect(phaseStageLabel('tool_progress', 'plain')).toBe('工具执行/推进中');
  });

  test('falls back for unknown phase', () => {
    expect(phaseStageLabel('mystery', 'x')).toBe('执行/阶段推进');
  });
});

describe('normalizeProgressKey', () => {
  test('collapses heartbeat lines to a single live key', () => {
    expect(normalizeProgressKey('request', '正在生成响应（已耗时 5s）')).toBe('request:_heartbeat_');
    expect(normalizeProgressKey('request', '已 12s 未收到新输出')).toBe('request:_heartbeat_');
  });

  test('collapses upstream-request lines to a single key', () => {
    expect(normalizeProgressKey('request', '请求上游模型 ...')).toBe('request:_upstream_');
  });

  test('templates elapsed-time tokens for non-heartbeat lines', () => {
    expect(normalizeProgressKey('init', 'warming up 3s'))
      .toBe(normalizeProgressKey('init', 'warming up 9s'));
  });
});

describe('normalizeStatusDedupKey', () => {
  test('shares one key for heartbeat messages', () => {
    expect(normalizeStatusDedupKey('request', '等待模型响应中')).toBe('request:_heartbeat_');
  });

  test('templates channel identifiers and elapsed times so cosmetic variants coalesce', () => {
    const a = normalizeStatusDedupKey('request', '首选通道: alpha 冷却 3s');
    const b = normalizeStatusDedupKey('request', '首选通道: beta 冷却 9s');
    expect(a).toBe(b);
  });
});

describe('isFailureMetricOnlyStatus', () => {
  test('true for zero-failure metric lines worded with 失败', () => {
    expect(isFailureMetricOnlyStatus('失败率 0%')).toBe(true);
    expect(isFailureMetricOnlyStatus('失败 0/12')).toBe(true);
  });

  test('false for real failures and non-failure text', () => {
    expect(isFailureMetricOnlyStatus('请求失败 3/12')).toBe(false);
    expect(isFailureMetricOnlyStatus('all good')).toBe(false);
    expect(isFailureMetricOnlyStatus('')).toBe(false);
  });
});

describe('isLowValueGatewayStatus', () => {
  test('true only for request-phase gateway chatter', () => {
    expect(isLowValueGatewayStatus('request', '首选通道切换中')).toBe(true);
    expect(isLowValueGatewayStatus('request', '正常推理')).toBe(false);
    expect(isLowValueGatewayStatus('done', '首选通道')).toBe(false);
  });
});

describe('isFailureSignalStatus', () => {
  test('true for failed tool status and failure-worded text', () => {
    expect(isFailureSignalStatus('tool_progress', '', { success: false })).toBe(true);
    expect(isFailureSignalStatus('request', 'timeout occurred')).toBe(true);
  });

  test('false for zero-failure metric lines and clean text', () => {
    expect(isFailureSignalStatus('request', '失败率 0%')).toBe(false);
    expect(isFailureSignalStatus('request', 'all fine')).toBe(false);
  });
});

describe('shouldBypassStartSilent', () => {
  test('terminal phases and real failures bypass; clean request does not', () => {
    expect(shouldBypassStartSilent('done', '')).toBe(true);
    expect(shouldBypassStartSilent('summary', '')).toBe(true);
    expect(shouldBypassStartSilent('tool_progress', '', { success: false })).toBe(true);
    expect(shouldBypassStartSilent('request', 'error!')).toBe(true);
    expect(shouldBypassStartSilent('request', '失败率 0%')).toBe(false);
    expect(shouldBypassStartSilent('request', 'thinking')).toBe(false);
  });
});

describe('isDynamicProgressStatus', () => {
  test('true for self-overwriting elapsed-time heartbeats', () => {
    expect(isDynamicProgressStatus('request', '正在生成响应（已耗时 4s）')).toBe(true);
    expect(isDynamicProgressStatus('request', '请求上游模型')).toBe(true);
    expect(isDynamicProgressStatus('request', '静态文本')).toBe(false);
    expect(isDynamicProgressStatus('init', '正在生成响应（已耗时 4s）')).toBe(false);
  });
});

describe('stripTrailingEllipsis', () => {
  test('removes a trailing … or ... and trims', () => {
    expect(stripTrailingEllipsis('正在搜索…')).toBe('正在搜索');
    expect(stripTrailingEllipsis('正在执行...')).toBe('正在执行');
    expect(stripTrailingEllipsis('no ellipsis')).toBe('no ellipsis');
    expect(stripTrailingEllipsis('')).toBe('');
  });
});

describe('thinkingClause', () => {
  test('returns the last meaningful sentence, trimmed to the cap', () => {
    expect(thinkingClause('先读配置。再看网关适配器怎么处理内容')).toBe('再看网关适配器怎么处理内容');
    expect(thinkingClause('   ')).toBe('');
    const long = '这是一段非常非常非常非常非常非常非常非常非常非常非常非常非常长的推理需要被裁剪掉尾巴而且更长一些确保超过上限';
    expect(thinkingClause(long).length).toBeLessThanOrEqual(36);
    expect(thinkingClause(long).endsWith('…')).toBe(true);
  });
});

describe('deriveLiveActivity — real current event', () => {
  test('tool phase → running tool narration (去尾省略号)', () => {
    expect(deriveLiveActivity({
      status: 'tool',
      runningTool: { name: 'grep', input: { pattern: 'foo', path: '/x/khy_os' } },
    })).toBe('正在 khy_os 里搜索 "foo"');
  });

  test('tool phase → bash command reads as "测试中"-style live event', () => {
    expect(deriveLiveActivity({
      status: 'tool_progress',
      runningTool: { name: 'bash', input: { command: 'npm test' } },
    })).toBe('正在执行 `npm test`');
  });

  test('tool phase with no running tool falls back to gateway detail', () => {
    expect(deriveLiveActivity({ status: 'tool', statusDetail: '工具执行链路' })).toBe('工具执行链路');
  });

  test('thinking phase → last reasoning clause', () => {
    expect(deriveLiveActivity({
      status: 'thinking',
      thinkingTail: '搜到不少文件。让我看核心处理逻辑——网关适配器',
    })).toBe('让我看核心处理逻辑——网关适配器');
  });

  test('request/summary phases surface the gateway detail (the stall message)', () => {
    expect(deriveLiveActivity({ status: 'request', statusDetail: '等待模型响应中' })).toBe('等待模型响应中');
    expect(deriveLiveActivity({ status: 'summary', statusDetail: '汇总交付结果' })).toBe('汇总交付结果');
  });

  test('streaming phase stays silent (visible text already shows)', () => {
    expect(deriveLiveActivity({ status: 'streaming', statusDetail: 'x', thinkingTail: 'y' })).toBe('');
  });

  test('KHY_LIVE_ACTIVITY=0 reverts to bare phase words', () => {
    expect(deriveLiveActivity({
      status: 'tool',
      runningTool: { name: 'grep', input: { pattern: 'foo' } },
      env: { KHY_LIVE_ACTIVITY: '0' },
    })).toBe('');
  });

  test('empty input → empty string', () => {
    expect(deriveLiveActivity({})).toBe('');
    expect(deriveLiveActivity({ status: 'thinking' })).toBe('');
  });
});
