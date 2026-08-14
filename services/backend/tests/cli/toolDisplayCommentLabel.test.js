'use strict';

// 验证 toolDisplay._describeToolIntent 的 bash 分支接线:模型首行 `# 注释`
// 优先作权威标签(对齐 CC),门控关则逐字节回退旧动词猜测路径。
const test = require('node:test');
const assert = require('node:assert');
const { _describeToolIntent } = require('../../src/cli/toolDisplay');

test('bash 首行 # 注释 → 用作意图标签,优先于动词猜测', () => {
  // 没有注释时 rm 会落到「删除文件」;有注释则优先用注释
  assert.strictEqual(
    _describeToolIntent('bash', { command: '# 清理临时构建产物\nrm -rf build/.cache' }),
    '清理临时构建产物'
  );
});

test('bash 无注释 → 仍走旧动词猜测(git status)', () => {
  assert.strictEqual(_describeToolIntent('bash', { command: 'git status' }), '看看当前 Git 状态');
});

test('bash shebang 首行不夺标签 → 落到旧动词猜测路径(#! 非标签)', () => {
  // #!/bin/bash 非标签 → extractBashCommentLabel 返 undefined → 旧路径取首 token
  // basename = bash → 通用「执行 bash 命令」(旧 quirk,faithful)
  assert.strictEqual(
    _describeToolIntent('bash', { command: '#!/bin/bash\nnpm install' }),
    '执行 bash 命令'
  );
});

test('门控关 KHY_BASH_COMMENT_LABEL=0 → 注释被忽略,逐字节回退旧路径', () => {
  // 同一条注释命令,门控开时给标签「清理临时构建产物」;门控关时旧路径把首 token
  // `#` 当命令 → 通用「执行 # 命令」(旧 quirk),证明逐字节回退到改前行为。
  const saved = process.env.KHY_BASH_COMMENT_LABEL;
  process.env.KHY_BASH_COMMENT_LABEL = '0';
  try {
    assert.strictEqual(
      _describeToolIntent('bash', { command: '# 清理临时构建产物\nrm -rf build/.cache' }),
      '执行 # 命令'
    );
  } finally {
    if (saved === undefined) delete process.env.KHY_BASH_COMMENT_LABEL;
    else process.env.KHY_BASH_COMMENT_LABEL = saved;
  }
});

test('空命令 → 空串(不变)', () => {
  assert.strictEqual(_describeToolIntent('bash', { command: '' }), '');
});
