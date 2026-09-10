'use strict';
/**
 * Tests for toolLoopDetector.js �?8+ detector tool loop detection.
 *
 * node:test 风格（jest 通道通过 findStandaloneTestFiles 排除本文件，�?test:node）�?
 * contextWasm 提供真实 fnv1aHash（纯 JS 实现，可离线加载），无需 mock�?
 */
const mod = require('../../src/services/toolLoopDetector');
const { ToolLoopDetector, DEFAULT_CONFIG } = mod;
describe('ToolLoopDetector', () => {
  let detector;
  beforeEach(() => {
    detector = new ToolLoopDetector({
      warningThreshold: 3,
      criticalThreshold: 5,
      circuitBreakerThreshold: 10,
      unknownToolThreshold: 3,
      stagnationThreshold: 5,
    });
  });
  // ── Detector 8: actionStagnation (param-diversity aware) ────────────
  describe('Detector 8: actionStagnation param diversity', () => {
    // Raise other thresholds so only actionStagnation is in play, and assert
    // on _checkActionStagnation() directly to avoid detector-order coupling.
    function makeDetector(extra = {}) {
      return new ToolLoopDetector({
        criticalThreshold: 100,
        circuitBreakerThreshold: 100,
        stagnationThreshold: 5,
        stagnationCriticalThreshold: 8,
        ...extra,
      });
    }
  });
  // ── Detector 8: env-overridable thresholds ───────────────────────
  describe('Detector 8: env threshold overrides', () => {
    const ENV_KEYS = [
      'KHY_TOOL_STAGNATION_THRESHOLD',
      'KHY_TOOL_STAGNATION_CRITICAL_THRESHOLD',
      'KHY_TOOL_STAGNATION_DISTINCT_RATIO',
    ];
    const MODULE_PATH = require.resolve('../../src/services/toolLoopDetector');
    // Env vars are read at module load, so re-require with a cleared cache.
    function loadWithEnv(env) {
      const saved = {};
      for (const k of ENV_KEYS) {
        saved[k] = process.env[k];
        if (env[k] === undefined) delete process.env[k];
        else process.env[k] = env[k];
      }
      delete require.cache[MODULE_PATH];
      try {
        return require(MODULE_PATH);
      } finally {
        for (const k of ENV_KEYS) {
          if (saved[k] === undefined) delete process.env[k];
          else process.env[k] = saved[k];
        }
        delete require.cache[MODULE_PATH];
      }
    }
  });
  // ── Detector 11: web-retrieval failure streak (死缠烂打) ──────────────
  describe('Detector 11: webRetrievalFailureStreak', () => {
    function attempt(d, toolName, params, success) {
      const verdict = d.check(toolName, params);
      d.recordCall(toolName, params);
      d.recordOutcome(toolName, params, success
        ? { success: true, output: 'data' }
        : { success: false, error: 'fetch failed' });
      return verdict;
    }
  });
});

describe('Tool Loop Detector', () => {
  test('check returns ok for first tool call', () => {
        const result = detector.check('read_file', { path: '/foo' });
        expect(result.level).toBe('ok');
        expect(result.stuck).toBe(false);
  });

  test('genericRepeat triggers warning after threshold', () => {
        for (let i = 0; i < 3; i++) {
          detector.recordCall('custom_action', { kind: 'compute', value: 42 });
        }
        const result = detector.check('custom_action', { kind: 'compute', value: 42 });
        expect(result.level).toBe('warning');
        expect(result.detector).toBe('genericRepeat');
  });

  test('genericRepeat triggers critical at higher threshold', () => {
        for (let i = 0; i < 5; i++) {
          detector.recordCall('custom_action', { kind: 'compute', value: 7 });
        }
        const result = detector.check('custom_action', { kind: 'compute', value: 7 });
        expect(result.level).toBe('critical');
        expect(result.detector).toBe('genericRepeat');
  });

  test('circuitBreaker trips at total call count', () => {
        for (let i = 0; i < 10; i++) {
          detector.recordCall(`tool_${i}`, {});
        }
        const result = detector.check('tool_final', {});
        expect(result.stuck).toBe(true);
        expect(result.detector).toBe('circuitBreaker');
  });

  test('unknownTool detects calls to unregistered tools', () => {
        detector.registerTools(['read_file', 'edit_file', 'shell_command']);
        detector.recordCall('nonexistent_tool', {});
        detector.recordCall('another_fake', {});
        detector.recordCall('yet_another', {});
        const result = detector.check('fourth_unknown', {});
        expect(result.detector).toBe('unknownTool');
        expect(result.stuck).toBe(true);
  });

  test('actionStagnation detects the SAME tool + SAME params repeated (true loop)', () => {
        for (let i = 0; i < 5; i++) {
          detector.recordCall('read_file', { path: '/file_same' });
        }
        const result = detector.check('read_file', { path: '/file_same' });
        expect(result.stuck).toBe(true);
  });

  test('actionStagnation does NOT trip when params change (normal scan)', () => {
        // 相同工具名但参数全部不同(扫描不同目录/文件)= 正常批量操作�?
        // read_file �?FS �?�?pathIntentRepeat 兜底),多样性豁免适用�?
        for (let i = 0; i < 8; i++) {
          detector.recordCall('read_file', { path: `/file_${i}` });
        }
        const result = detector.check('read_file', { path: '/file_next' });
        expect(result.detector).not.toBe('actionStagnation');
        expect(result.stuck).toBe(false);
  });

  test('actionStagnation suppressed by param diversity across a long streak', () => {
        // 同一工具连续多次、参数全部不�?= 持续有进�?多样性抑制永不阻断�?
        // 注意:①参数必须每次不�?genericRepeat 按「同参数总次数」判�?重复参数会触发它);
        // ②调用次数须低于 circuitBreakerThreshold(10),否则 circuitBreaker 会抢先触发�?
        for (let i = 0; i < 9; i++) {
          detector.recordCall('read_file', { path: `/file_${i}` });
        }
        const result = detector.check('read_file', { path: '/file_next' });
        expect(result.detector).not.toBe('actionStagnation');
        expect(result.stuck).toBe(false);
  });

  test('shell_command with different commands does NOT stagnate (scan pattern)', () => {
        // 用户报告场景:同一 shell_command 工具扫描多个不同路径被误判停滞�?
        for (let i = 0; i < 8; i++) {
          detector.recordCall('shell_command', { command: `Get-ChildItem C:/path_${i}` });
        }
        const result = detector.check('shell_command', { command: 'Get-ChildItem C:/path_next' });
        expect(result.detector).not.toBe('actionStagnation');
        expect(result.stuck).toBe(false);
  });

  test('DEFAULT_CONFIG exposes stagnation thresholds and distinct ratio', () => {
          expect(DEFAULT_CONFIG.stagnationThreshold).toBe(5);
          expect(DEFAULT_CONFIG.stagnationCriticalThreshold).toBe(8);
          expect(DEFAULT_CONFIG.stagnationDistinctRatio).toBe(0.75);
  });

  test('identical params at critical threshold still trigger critical (blocked)', () => {
          const d = makeDetector();
          for (let i = 0; i < 8; i++) {
            d.recordCall('custom_action', { value: 'same' });
          }
          const verdict = d._checkActionStagnation();
          expect(verdict.detector).toBe('actionStagnation');
          expect(verdict.level).toBe('critical');
          expect(verdict.stuck).toBe(true);
          expect(verdict.message).toMatch(/called 8 times consecutively/);
          expect(verdict.message).toMatch(/critical threshold: 8/);
  });

  test('identical params at warning threshold trigger warning', () => {
          const d = makeDetector();
          for (let i = 0; i < 5; i++) {
            d.recordCall('custom_action', { value: 'same' });
          }
          const verdict = d._checkActionStagnation();
          expect(verdict.detector).toBe('actionStagnation');
          expect(verdict.level).toBe('warning');
  });

  test('all-distinct params on a scan-class tool never trigger critical', () => {
          const d = makeDetector();
          // read_file is an FS tool �?pathIntentRepeat backstops it, so the
          // diversity exemption applies.
          for (let i = 0; i < 9; i++) {
            d.recordCall('read_file', { path: `/file_${i}` });
          }
          const verdict = d._checkActionStagnation();
          expect(verdict.level).toBe('ok');
          expect(verdict.stuck).toBe(false);
  });

  test('generic tool with all-distinct params STILL triggers critical (noise bypass)', () => {
          const d = makeDetector();
          // custom_action has NO intent-level backstop detector; a model could
          // append a nonce field to make every callHash distinct and bypass
          // genericRepeat/noProgress. The diversity exemption must not apply.
          for (let i = 0; i < 8; i++) {
            d.recordCall('custom_action', { value: 'same', nonce: i });
          }
          const verdict = d._checkActionStagnation();
          expect(verdict.detector).toBe('actionStagnation');
          expect(verdict.level).toBe('critical');
          expect(verdict.stuck).toBe(true);
  });

  test('low param diversity (ratio below 0.75) still triggers critical on scan tool', () => {
          const d = makeDetector();
          // 8 shell calls, only 2 distinct param sets �?ratio 0.25 < 0.75.
          for (let i = 0; i < 8; i++) {
            d.recordCall('shell_command', { command: i < 4 ? 'ls /a' : 'ls /b' });
          }
          const verdict = d._checkActionStagnation();
          expect(verdict.detector).toBe('actionStagnation');
          expect(verdict.level).toBe('critical');
          expect(verdict.stuck).toBe(true);
          expect(verdict.message).toMatch(/2 distinct param set/);
  });

  test('diversity exactly at the ratio threshold suppresses stagnation (scan tool)', () => {
          const d = makeDetector();
          // 8 fs calls, 6 distinct param sets �?ratio 0.75 �?0.75 �?suppressed.
          const paths = ['/a', '/a', '/b', '/b', '/c', '/d', '/e', '/f'];
          for (const p of paths) {
            d.recordCall('read_file', { path: p });
          }
          const verdict = d._checkActionStagnation();
          expect(verdict.level).toBe('ok');
  });

  test('custom stagnationDistinctRatio config is honored', () => {
          const d = makeDetector({ stagnationDistinctRatio: 0.9 });
          // 6 distinct of 8 �?0.75 < 0.9 �?triggers under the stricter ratio.
          const paths = ['/a', '/a', '/b', '/b', '/c', '/d', '/e', '/f'];
          for (const p of paths) {
            d.recordCall('read_file', { path: p });
          }
          const verdict = d._checkActionStagnation();
          expect(verdict.level).toBe('critical');
  });

  test('KHY_TOOL_STAGNATION_* env vars override defaults at module load', () => {
          const fresh = loadWithEnv({
            KHY_TOOL_STAGNATION_THRESHOLD: '2',
            KHY_TOOL_STAGNATION_CRITICAL_THRESHOLD: '3',
            KHY_TOOL_STAGNATION_DISTINCT_RATIO: '0.5',
          });
          expect(fresh.DEFAULT_CONFIG.stagnationThreshold).toBe(2);
          expect(fresh.DEFAULT_CONFIG.stagnationCriticalThreshold).toBe(3);
          expect(fresh.DEFAULT_CONFIG.stagnationDistinctRatio).toBe(0.5);
    
          // Behavioral check: 3 identical calls trip critical under the low threshold.
          const d = new fresh.ToolLoopDetector({ criticalThreshold: 100 });
          for (let i = 0; i < 3; i++) {
            d.recordCall('custom_action', { value: 'same' });
          }
          const verdict = d._checkActionStagnation();
          expect(verdict.level).toBe('critical');
          expect(verdict.stuck).toBe(true);
  });

  test('invalid env values fall back to built-in defaults', () => {
          const fresh = loadWithEnv({
            KHY_TOOL_STAGNATION_THRESHOLD: 'not-a-number',
            KHY_TOOL_STAGNATION_CRITICAL_THRESHOLD: '-1',
            KHY_TOOL_STAGNATION_DISTINCT_RATIO: '2',
          });
          expect(fresh.DEFAULT_CONFIG.stagnationThreshold).toBe(5);
          expect(fresh.DEFAULT_CONFIG.stagnationCriticalThreshold).toBe(8);
          expect(fresh.DEFAULT_CONFIG.stagnationDistinctRatio).toBe(0.75);
  });

  test('reset clears all state', () => {
        for (let i = 0; i < 5; i++) {
          detector.recordCall('edit_file', { path: '/x' });
        }
        detector.reset();
        const result = detector.check('edit_file', { path: '/x' });
        expect(result.level).toBe('ok');
        expect(detector.totalCalls).toBe(0);
  });

  test('recordOutcome attaches result hash to history', () => {
        detector.recordCall('shell', { cmd: 'ls' });
        detector.recordOutcome('shell', { cmd: 'ls' }, { success: true, output: 'file.txt' });
        expect(detector.history.length).toBe(1);
        expect(detector.history[0].resultHash).toBeTruthy();
  });

  test('classifies dedicated and shell-wrapped web tools', () => {
          const { _isWebTool, _shellCommandIsWebFetch } = mod;
          expect(_isWebTool('WebFetch')).toBe(true);
          expect(_isWebTool('web_search')).toBe(true);
          expect(_isWebTool('web_browser')).toBe(true);
          expect(_isWebTool('read_file')).toBe(false);
          expect(_shellCommandIsWebFetch('curl https://x.com')).toBe(true);
          expect(_shellCommandIsWebFetch('wget https://x.com')).toBe(true);
          expect(_shellCommandIsWebFetch('iwr https://x.com')).toBe(true);
          expect(_shellCommandIsWebFetch('ls -la')).toBe(false);
  });

  test('trips critical after consecutive failed fetches across different tools', () => {
          const d = new ToolLoopDetector({ webFailWarning: 3, webFailCritical: 4 });
          attempt(d, 'WebFetch', { url: 'https://news.example.com' }, false);
          attempt(d, 'curl', { command: 'curl https://news.example.com' }, false);
          attempt(d, 'web_search', { url: 'https://news.example.com' }, false);
          attempt(d, 'web_browser', { url: 'https://news.example.com' }, false);
          const verdict = d.check('wget', { command: 'wget https://news.example.com' });
          expect(verdict.detector).toBe('webRetrievalFailureStreak');
          expect(verdict.level).toBe('critical');
          expect(verdict.stuck).toBe(true);
          expect(verdict.message).toMatch(/WebSearch/);
  });

  test('warns at the warning threshold', () => {
          const d = new ToolLoopDetector({ webFailWarning: 3, webFailCritical: 4 });
          attempt(d, 'WebFetch', { url: 'https://x' }, false);
          attempt(d, 'curl', { command: 'curl https://x' }, false);
          attempt(d, 'web_search', { url: 'https://x' }, false);
          const verdict = d.check('wget', { command: 'wget https://x' });
          expect(verdict.detector).toBe('webRetrievalFailureStreak');
          expect(verdict.level).toBe('warning');
  });

  test('does NOT trip on a legitimate search→fetch progression', () => {
          const d = new ToolLoopDetector({ webFailWarning: 3, webFailCritical: 4 });
          attempt(d, 'web_search', { query: 'latest news' }, true);
          const verdict = d.check('WebFetch', { url: 'https://news.example.com/article' });
          expect(verdict.level).toBe('ok');
  });

  test('a successful fetch resets the failure streak', () => {
          const d = new ToolLoopDetector({ webFailWarning: 3, webFailCritical: 4 });
          attempt(d, 'WebFetch', { url: 'https://x' }, false);
          attempt(d, 'curl', { command: 'curl https://x' }, false);
          attempt(d, 'web_search', { url: 'https://x' }, false);
          attempt(d, 'WebFetch', { url: 'https://x' }, true);
          const verdict = d.check('curl', { command: 'curl https://x' });
          expect(verdict.level).toBe('ok');
  });

  test('ignores non-web tools entirely', () => {
          const d = new ToolLoopDetector({ webFailWarning: 3, webFailCritical: 4 });
          attempt(d, 'read_file', { path: '/a' }, false);
          attempt(d, 'read_file', { path: '/b' }, false);
          attempt(d, 'read_file', { path: '/c' }, false);
          const verdict = d._checkWebRetrievalFailureStreak('edit_file', { path: '/d' });
          expect(verdict.level).toBe('ok');
  });

  test('reset clears web-streak state', () => {
          const d = new ToolLoopDetector({ webFailWarning: 3, webFailCritical: 4 });
          attempt(d, 'WebFetch', { url: 'https://x' }, false);
          attempt(d, 'curl', { command: 'curl https://x' }, false);
          attempt(d, 'web_search', { url: 'https://x' }, false);
          d.reset();
          const verdict = d.check('wget', { command: 'wget https://x' });
          expect(verdict.level).toBe('ok');
  });

});

