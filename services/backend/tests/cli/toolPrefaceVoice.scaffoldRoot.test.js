'use strict';

/**
 * scaffoldFiles 旁白 root 回退测试 —— 修「我先把 . 的骨架搭起来」(字面点)。
 *
 * scaffoldFiles 的输入参数只有 directories/files，root 是结果字段 → preface 读到 undefined
 * → 历史念出字面 '.'。门控开：无有效 root 时说「项目骨架」；门控关：逐字节回退字面 '.'。
 */

const { toolProgressReason } = require('../../src/cli/toolPrefaceVoice');

const FLAG = 'KHY_SCAFFOLD_VOICE_ROOT_FALLBACK';

function withFlag(val, fn) {
  const prev = process.env[FLAG];
  if (val === undefined) delete process.env[FLAG];
  else process.env[FLAG] = val;
  try { return fn(); } finally {
    if (prev === undefined) delete process.env[FLAG];
    else process.env[FLAG] = prev;
  }
}

describe('toolPrefaceVoice — scaffoldFiles root 回退', () => {
  test('门控开 + 无 root(输入只有 directories/files) → 说「项目骨架」而非字面 .', () => {
    withFlag(undefined, () => {
      const s = toolProgressReason('scaffoldFiles',
        { directories: ['src/main/java/com/example/demo'], files: [{ path: 'pom.xml' }] },
        { mode: 'full' });
      expect(s).toContain('项目骨架');
      expect(s).not.toContain(' . ');
      expect(s).not.toMatch(/把 \. 的/);
    });
  });

  test('门控开 + 有真实 root → 保留措辞「把 X 的骨架搭起来」', () => {
    withFlag(undefined, () => {
      const s = toolProgressReason('scaffoldFiles', { root: 'demo-api' }, { mode: 'full' });
      expect(s).toBe('把 demo-api 的骨架搭起来，结构铺开了细节就好补。');
    });
  });

  test('门控关(0)→ 逐字节回退历史(字面 .)', () => {
    withFlag('0', () => {
      const s = toolProgressReason('scaffoldFiles',
        { directories: ['src'], files: [{ path: 'pom.xml' }] }, { mode: 'full' });
      expect(s).toBe('把 . 的骨架搭起来，结构铺开了细节就好补。');
    });
  });

  test('门控关(off)同样字面回退', () => {
    withFlag('off', () => {
      const s = toolProgressReason('scaffoldFiles', {}, { mode: 'full' });
      expect(s).toBe('把 . 的骨架搭起来，结构铺开了细节就好补。');
    });
  });
});
