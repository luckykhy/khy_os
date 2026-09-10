'use strict';
// 对抗式自�?2026-09-05):下划线滥用检�?+ 自适应策略测试�?//
// 锁定 underscoreEmphasis.adaptiveUnderscorePolicy / detectUnderscoreAbuse �?// outputIntegrityMonitor.detectUnderscoreAbuse 的行�?
//   - 滥用(snake_case 密集)�?自动禁用下划线强�?//   - 真正的强�?_italic_ 少量)�?仍启�?//   - 门控显式关闭 �?始终 false
//   - 门控显式强制开�?�?始终 true(不检测滥�?
//   - 未设�?�?adaptive 默认
// 零网络零 IO�?const {
  detectUnderscoreAbuse,
  adaptiveUnderscorePolicy,
  underscoreEmphasisEnabled,
  ABUSE_MIN_TOTAL,
  ABUSE_SNAKE_RATIO,
} = require('../../src/cli/underscoreEmphasis');
const { detectUnderscoreAbuse: monitorDetect } = require('../../src/services/outputIntegrityMonitor');
// ── detectUnderscoreAbuse 核心行为 ───────────────────────────────────────────
// ── adaptiveUnderscorePolicy 门控�?──────────────────────────────────────────
// ── 门控 underscoreEmphasisEnabled(legacy,�?text)─────────────────────────────
// ── outputIntegrityMonitor.detectUnderscoreAbuse 行为一�?──────────────────────
// ── 端到�?渲染器对抗式自愈 ──────────────────────────────────────────────────
function renderLite(text, gateValue) {
  const path = require.resolve('../../src/cli/markdownRenderer');
  delete require.cache[path];
  const prevForce = process.env.FORCE_COLOR;
  const prevGate = process.env.KHY_UNDERSCORE_EMPHASIS;
  process.env.FORCE_COLOR = '3';
  if (gateValue == null) delete process.env.KHY_UNDERSCORE_EMPHASIS;
  else process.env.KHY_UNDERSCORE_EMPHASIS = gateValue;
  try {
    return require(path).renderMarkdownLite(text);
  } finally {
    if (prevForce == null) delete process.env.FORCE_COLOR; else process.env.FORCE_COLOR = prevForce;
    if (prevGate == null) delete process.env.KHY_UNDERSCORE_EMPHASIS; else process.env.KHY_UNDERSCORE_EMPHASIS = prevGate;
    delete require.cache[path];
  }
}
const ITALIC = '[3m';

describe('Underscore Abuse', () => {
  test('detectUnderscoreAbuse:滥用场景(snake_case 密集)�?abuse=true', () => {
      // 7 个下划线,全在词内 �?ratio=1.0 > 0.6 �?total=7 �?5 �?滥用
      const r = detectUnderscoreAbuse('see /usr/local/bin/my_app_dir/config_file_path for some_var_name_and_other');
      expect(r.abuse).toBe(true);
      expect(r.total >= ABUSE_MIN_TOTAL).toBeTruthy();
      expect(r.ratio >= ABUSE_SNAKE_RATIO).toBeTruthy();
  });

  test('detectUnderscoreAbuse:短文�?1 个下划线)�?abuse=false(安全兜底)', () => {
      const r = detectUnderscoreAbuse('my_var and getUserName');
      expect(r.abuse).toBe(false);
      expect(r.total).toBe(1);
  });

  test('detectUnderscoreAbuse:真正的强�?_italic_ 少量,4 个下划线)�?abuse=false', () => {
      const r = detectUnderscoreAbuse('This is _emphasized_ text with _italic_');
      expect(r.abuse).toBe(false);
      expect(r.total).toBe(4);
      expect(r.ratio).toBe(0);
  });

  test('detectUnderscoreAbuse:空文�?/ 无下划线 �?abuse=false', () => {
      expect(detectUnderscoreAbuse('').abuse).toBe(false);
      expect(detectUnderscoreAbuse('no underscores here').abuse).toBe(false);
      expect(detectUnderscoreAbuse(null).abuse).toBe(false);
  });

  test('detectUnderscoreAbuse:边界�?5 个下划线全词�?�?ratio=1.0 �?滥用', () => {
      // a_b_c_d_e_f = 5 个下划线,全词�?�?ratio=1.0 >= 0.6 �?滥用
      const r = detectUnderscoreAbuse('a_b_c_d_e_f');
      expect(r.total).toBe(5);
      expect(r.ratio).toBe(1.0);
      expect(r.abuse).toBe(true);
  });

  test('adaptiveUnderscorePolicy:默认(未设�?= adaptive,滥用�?false', () => {
      assert.strictEqual(
        adaptiveUnderscorePolicy('see /usr/local/bin/my_app_dir/config_file_path for some_var_name_and_other', {}),
        false,
      );
  });

  test('adaptiveUnderscorePolicy:默认(未设�?= adaptive,真强调→ true', () => {
      assert.strictEqual(
        adaptiveUnderscorePolicy('This is _emphasized_ text', {}),
        true,
      );
  });

  test('adaptiveUnderscorePolicy:显式�?0/false/off/no)�?始终 false', () => {
      for (const v of ['0', 'false', 'off', 'no', 'OFF', 'False']) {
        assert.strictEqual(
          adaptiveUnderscorePolicy('This is _emphasized_ text', { KHY_UNDERSCORE_EMPHASIS: v }),
          false,
          `gate=${v} should be false`,
        );
      }
  });

  test('adaptiveUnderscorePolicy:显式强制开(1/true/on/yes)�?始终 true(不检测滥�?', () => {
      for (const v of ['1', 'true', 'on', 'yes']) {
        assert.strictEqual(
          adaptiveUnderscorePolicy('see /usr/local/bin/my_app_dir/config_file_path for some_var_name_and_other', {
            KHY_UNDERSCORE_EMPHASIS: v,
          }),
          true,
          `gate=${v} should be true even with abuse`,
        );
      }
  });

  test('adaptiveUnderscorePolicy:显式 adaptive �?同默�?, () => {
      assert.strictEqual(
        adaptiveUnderscorePolicy('see /usr/local/bin/my_app_dir/config_file_path for some_var_name_and_other', {
          KHY_UNDERSCORE_EMPHASIS: 'adaptive',
        }),
        false,
      );
      assert.strictEqual(
        adaptiveUnderscorePolicy('This is _emphasized_ text', { KHY_UNDERSCORE_EMPHASIS: 'adaptive' }),
        true,
      );
  });

  test('underscoreEmphasisEnabled:legacy �?text,默认开·显式关→ false', () => {
      expect(underscoreEmphasisEnabled({}).toBe(true);
      expect(underscoreEmphasisEnabled({ KHY_UNDERSCORE_EMPHASIS: 'off' }).toBe(false);
      expect(underscoreEmphasisEnabled({ KHY_UNDERSCORE_EMPHASIS: '1' }).toBe(true);
  });

  test('monitor.detectUnderscoreAbuse:滥用�?返回信号对象', () => {
      const r = monitorDetect('see /usr/local/bin/my_app_dir/config_file_path for some_var_name_and_other');
      expect(r).toBeTruthy();
      expect(r.type).toBe('underscore-abuse');
      expect(r.total >= ABUSE_MIN_TOTAL).toBeTruthy();
      expect(r.ratio >= ABUSE_SNAKE_RATIO).toBeTruthy();
  });

  test('monitor.detectUnderscoreAbuse:非滥用→ null', () => {
      expect(monitorDetect('This is _emphasized_ text').toBe(null);
      expect(monitorDetect('short my_var').toBe(null);
  });

  test('端到�?滥用文本,默认门控 �?自动抑制,下划线原样显�?�?italic 包裹)', () => {
      const abusive = 'see /usr/local/bin/my_app_dir/config_file_path for some_var_name_and_other';
      const out = renderLite(abusive, null);
      expect(out.includes('my_app_dir').toBe();
      expect(!out.includes(ITALIC).toBe();
  });

  test('端到�?真强�?默认门控 �?�?italic', () => {
      const out = renderLite('This is _emphasized_ text', null);
      expect(out.includes(ITALIC).toBe();
  });

  test('端到�?滥用文本,强制开 �?不抑�?legacy 行为)', () => {
      const abusive = 'see /usr/local/bin/my_app_dir/config_file_path for some_var_name_and_other';
      const out = renderLite(abusive, '1');
      // 强制开�?即使滥用也不抑制
      expect(out.includes('my_app_dir').toBe();
  });

  test('端到�?滥用文本,显式�?�?�?italic', () => {
      const abusive = 'see /usr/local/bin/my_app_dir/config_file_path for some_var_name_and_other';
      const out = renderLite(abusive, 'off');
      expect(!out.includes(ITALIC).toBe();
  });

});

