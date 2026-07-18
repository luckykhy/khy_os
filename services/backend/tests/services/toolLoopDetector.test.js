'use strict';

/**
 * Tests for toolLoopDetector.js — 8-detector tool loop detection.
 */

// Mock the contextWasm module to provide a JS-only fnv1aHash
jest.mock('../../src/services/contextWasm', () => ({
  fnv1aHash: (str) => {
    let h = 0x811c9dc5;
    const s = String(str);
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(16);
  },
}));

let mod;
try {
  mod = require('../../src/services/toolLoopDetector');
} catch {
  mod = null;
}

const _skip = !mod;
const descFn = _skip ? describe.skip : describe;

descFn('ToolLoopDetector', () => {
  const { ToolLoopDetector, DEFAULT_CONFIG } = mod || {};

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

  test('check returns ok for first tool call', () => {
    const result = detector.check('read_file', { path: '/foo' });
    expect(result.level).toBe('ok');
    expect(result.stuck).toBe(false);
  });

  test('genericRepeat triggers warning after threshold', () => {
    // Use a neutral (non-fs, non-shell) tool so only genericRepeat applies;
    // fs/shell tools also trip the path/shell-intent detectors at a lower count.
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

  test('actionStagnation detects same tool called repeatedly', () => {
    for (let i = 0; i < 5; i++) {
      detector.recordCall('read_file', { path: `/file_${i}` });
    }
    const result = detector.check('read_file', { path: '/file_next' });
    expect(result.detector).toBe('actionStagnation');
    expect(result.stuck).toBe(true);
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

  // ── Detector 11: web-retrieval failure streak (死缠烂打) ──────────────
  describe('Detector 11: webRetrievalFailureStreak', () => {
    // Drive a single web-retrieval attempt through check → record → outcome.
    function attempt(d, toolName, params, success) {
      const verdict = d.check(toolName, params);
      d.recordCall(toolName, params);
      d.recordOutcome(toolName, params, success
        ? { success: true, output: 'data' }
        : { success: false, error: 'fetch failed' });
      return verdict;
    }

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
      // 5th attempt sees 4 prior consecutive failed web records.
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
      // success breaks the streak
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
});
