'use strict';
/**
 * toolCallEqualsKvSplit.test.js — 纯叶子契约 + parseFunctionArgs 接线。
 *
 * 覆盖:门控(flagRegistry-first + 本地 CANON 回退)、splitEqualsKvPairs(开门只在 `,`+`<key>=`
 * 边界切、值内逗号保留·关门返 null·非字符串返 null·已 trim·多对仍切)、fail-soft;
 * parseFunctionArgs 门开修(command/content/awk 值内逗号保住、多对仍分、R4 URL 不回归)、
 * 门关逐字节回退 legacy 全逗号切(垃圾伪参数保留)、合法多对两态一致。
 */
const path = require('node:path');
const leaf = require(path.join(__dirname, '../src/services/toolCallEqualsKvSplit'));
// ── parseFunctionArgs 接线(真跑解析)────────────────────────────────────
function withEnv(mut, fn) {
  const saved = {};
  for (const k of Object.keys(mut)) { saved[k] = process.env[k]; if (mut[k] == null) delete process.env[k]; else process.env[k] = mut[k]; }
  try { return fn(); }
  finally { for (const k of Object.keys(mut)) { if (saved[k] == null) delete process.env[k]; else process.env[k] = saved[k]; } }
}
function freshParser() {
  delete require.cache[require.resolve('../src/services/toolCallParser')];
  delete require.cache[require.resolve('../src/services/toolCallEqualsKvSplit')];
  return require('../src/services/toolCallParser');
}

describe('Tool Call Equals Kv Split', () => {
  test('toolCallEqKvSplitEnabled: default ON; CANON off-words disable', () => {
      expect(leaf.toolCallEqKvSplitEnabled({})).toBe(true);
      for (const off of ['0', 'false', 'off', 'no']) {
        expect(leaf.toolCallEqKvSplitEnabled({ KHY_TOOLCALL_EQ_KV_SPLIT: off })).toBe(false, `off=${off}`);
      }
      expect(leaf.toolCallEqKvSplitEnabled({ KHY_TOOLCALL_EQ_KV_SPLIT: 'yes' })).toBe(true);
  });

  test('splitEqualsKvPairs: ON → splits only at comma-before-key=, keeps value commas', () => {
      expect(leaf.splitEqualsKvPairs('command=echo a).toEqual(b,c', {}), ['command=echo a,b,c']);
      expect(leaf.splitEqualsKvPairs('path=/a/b).toEqual(content=hello,world', {}), ['path=/a/b', 'content=hello,world']);
      // multi-pair still splits at every real boundary
      expect(leaf.splitEqualsKvPairs('a=1).toEqual(b=2, c=3', {}), ['a=1', 'b=2', 'c=3']);
      // hyphenated key boundary honored
      expect(leaf.splitEqualsKvPairs('x=v).toEqual(w, max-count=5', {}), ['x=v,w', 'max-count=5']);
  });

  test('splitEqualsKvPairs: OFF → null; non-string → null', () => {
      expect(leaf.splitEqualsKvPairs('a=1, b=2', { KHY_TOOLCALL_EQ_KV_SPLIT: '0' })).toBe(null);
      expect(leaf.splitEqualsKvPairs(null, {})).toBe(null);
      expect(leaf.splitEqualsKvPairs(42, {})).toBe(null);
  });

  test('fail-soft: never throws on bad env', () => {
      expect(() => leaf.splitEqualsKvPairs('a=1', undefined).not.toThrow());
      expect(() => leaf.toolCallEqKvSplitEnabled(null).not.toThrow());
  });

  test('parseFunctionArgs: gate ON → value commas preserved, multi-pair still split', () => {
      withEnv({ KHY_TOOLCALL_EQ_KV_SPLIT: undefined }, () => {
        const p = freshParser();
        expect(p.parseFunctionArgs('shell_command').toEqual('command=echo a,b,c'), { command: 'echo a,b,c' });
        expect(p.parseFunctionArgs('shell_command').toEqual('command=awk -F, x'), { command: 'awk -F, x' });
        expect(p.parseFunctionArgs('write_file').toEqual('path=/a/b, content=hello,world'), { path: '/a/b', content: 'hello,world' });
        // multi-pair unchanged from legacy
        expect(p.parseFunctionArgs('x').toEqual('a=1, b=2'), { a: 1, b: 2 });
        // R4 colon-KV path not regressed
        expect(p.parseFunctionArgs('shell_command').toEqual('command=curl https://x.com'), { command: 'curl https://x.com' });
      });
  });

  test('parseFunctionArgs: gate OFF → byte-revert to legacy (comma-truncated garbage preserved)', () => {
      withEnv({ KHY_TOOLCALL_EQ_KV_SPLIT: '0' }, () => {
        const p = freshParser();
        expect(p.parseFunctionArgs('shell_command').toEqual('command=echo a,b,c'), { command: 'echo a', b: '', c: '' });
        expect(p.parseFunctionArgs('write_file').toEqual('path=/a/b, content=hello,world'), { path: '/a/b', content: 'hello', world: '' });
        // legit multi-pair identical under both gates
        expect(p.parseFunctionArgs('x').toEqual('a=1, b=2'), { a: 1, b: 2 });
      });
  });

});
