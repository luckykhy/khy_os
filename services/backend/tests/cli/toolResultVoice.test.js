'use strict';

const {
  classifyToolFailureDetail,
  toolResultLooksFailed,
  toolResultReflection,
} = require('../../src/cli/toolResultVoice');

describe('toolResultVoice', () => {
  test('classifies edit mismatch before generic not_found', () => {
    expect(classifyToolFailureDetail('old_string not found in repl.js')).toBe('mismatch');
  });

  test('classifies common failure types with stable precedence', () => {
    expect(classifyToolFailureDetail('Permission denied: /root/secret.txt')).toBe('permission');
    expect(classifyToolFailureDetail('ENOENT: no such file or directory')).toBe('not_found');
    expect(classifyToolFailureDetail('Command timed out after 30000ms')).toBe('timeout');
    expect(classifyToolFailureDetail('Invalid JSON: cannot parse tool arguments')).toBe('parse');
    expect(classifyToolFailureDetail('fatal error: something broke')).toBe('generic');
  });

  test('detects whether a streamed tool result should be treated as failure', () => {
    expect(toolResultLooksFailed('Read 240 lines from backend/src/cli/repl.js')).toBe(false);
    expect(toolResultLooksFailed('Permission denied: /root/secret.txt')).toBe(true);
  });

  test('maps failure categories to decision-shaping partner hints', () => {
    expect(toolResultReflection('Read', false, 'Permission denied: /root/secret.txt'))
      .toBe('像是权限卡住了，我先换条不碰权限边界的路继续。');
    expect(toolResultReflection('Read', false, 'old_string not found in repl.js'))
      .toBe('上下文没对齐，我先把当前内容重新对齐再改。');
    expect(toolResultReflection('Read', false, 'Invalid JSON: cannot parse tool arguments'))
      .toBe('返回格式有点乱，我先把输入收窄一点再跑。');
  });

  test('maps successful tool types to next-step reflections', () => {
    expect(toolResultReflection('Read', true, 'Read 240 lines')).toBe('实现看清了，改动点也清楚了，我接着改。');
    expect(toolResultReflection('CreateFile', true, 'Wrote 128 bytes')).toBe('改动已经落下去了，我再跑一遍确认有没有偏。');
    expect(toolResultReflection('web_search', true, 'Found 5 web results')).toBe('外部信息够了，判断基础够了，我接着收口。');
  });
});
