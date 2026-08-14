'use strict';

// Unit tests for endsWithUnfulfilledIntent (fake-completion guard).
// The helper flags replies that END with a first-person promise to act
// ("让我访问这些页面…" / "Let me fetch those pages") while the turn issued
// zero tool calls, so the >=400-char concludeNow short-circuit cannot
// finalize an unfulfilled promise as the answer.

const { endsWithUnfulfilledIntent } = require('../src/services/toolUseLoopCore');

describe('endsWithUnfulfilledIntent', () => {
  test('flags Chinese promise ending (the exact weather bug)', () => {
    const reply = '我找到了以下关于曲靖天气的页面。让我访问这些页面来获取具体的天气信息。';
    expect(endsWithUnfulfilledIntent(reply)).toBe(true);
  });

  test('flags promise followed by trailing URL list lines', () => {
    const reply = '搜索结果如下，让我访问这些页面来获取具体的天气信息：\n'
      + '1. https://weather.example.com/qujing\n'
      + '2. https://tianqi.example.cn/qujing\n'
      + '- https://forecast.example.org/qujing';
    expect(endsWithUnfulfilledIntent(reply)).toBe(true);
  });

  test('flags English promise endings', () => {
    expect(endsWithUnfulfilledIntent('Here are the results. Let me fetch these pages for details.')).toBe(true);
    expect(endsWithUnfulfilledIntent("I found three sources. I'll visit them to check the forecast.")).toBe(true);
    expect(endsWithUnfulfilledIntent('Now I will search for the latest data.')).toBe(true);
  });

  test('flags other first-person lead-ins (我来/我将/接下来我/现在我)', () => {
    expect(endsWithUnfulfilledIntent('好的。接下来我查询最新的天气数据。')).toBe(true);
    expect(endsWithUnfulfilledIntent('资料已列出。现在我打开第一个链接查看内容。')).toBe(true);
    expect(endsWithUnfulfilledIntent('我将检索相关页面。')).toBe(true);
  });

  test('does NOT flag promise phrasing in the middle of a final answer', () => {
    const reply = '让我访问的页面已经处理完毕。曲靖今天多云转晴，气温 15-24℃，'
      + '东北风 2 级，空气质量优。建议穿轻薄外套出行。';
    expect(endsWithUnfulfilledIntent(reply)).toBe(false);
  });

  test('does NOT flag inclusive narration「让我们看…」', () => {
    expect(endsWithUnfulfilledIntent('综上所述，让我们看清了整体趋势。')).toBe(false);
  });

  test('does NOT flag normal conclusive answers', () => {
    expect(endsWithUnfulfilledIntent('曲靖今天多云，气温 15-24℃，适合出行。')).toBe(false);
    expect(endsWithUnfulfilledIntent('Task completed. All files were updated and tests pass.')).toBe(false);
  });

  test('does NOT flag lead-in without an action verb continuation', () => {
    expect(endsWithUnfulfilledIntent('让我知道你还需要什么帮助。')).toBe(false);
  });

  test('fail-soft on garbage input: never throws, returns false', () => {
    expect(endsWithUnfulfilledIntent(null)).toBe(false);
    expect(endsWithUnfulfilledIntent(undefined)).toBe(false);
    expect(endsWithUnfulfilledIntent(42)).toBe(false);
    expect(endsWithUnfulfilledIntent('')).toBe(false);
    expect(endsWithUnfulfilledIntent('   ')).toBe(false);
  });
});
