'use strict';

// Viewport.sliceLineForSelection — 应用内自绘选择的**渲染侧**分段逻辑。
//
// 为什么单独测这个纯函数,而不是起 ink 渲染器:
//   ink 的渲染测试要构造完整 yoga 树 + 假 stdout,成本高、在 CI 上偶发。而这里真正
//   会出错的东西是**算术**(行区间裁剪、半开区间、边界列),把它抽成纯函数后可以用
//   零依赖直接打穿全部边界,渲染层剩下的只是「三段拼起来」这种肉眼可验的接线。
//
// 守的核心不变量(最有价值的几条):
//   I1  head + mid + tail === line —— 反色不吞字符。这条挂了,复制出的文本就与屏幕
//       不一致,而用户完全看不出来(屏幕上反色的地方"看起来"就是选中的)。
//   I2  同一坐标系:lineIdx 是 **lines 数组下标 == 屏幕行**。这条不变量一旦被打破
//       (比如某天有人给 lines 加了软换行投影),选区会整体错位而不会报错。
//   I3  start/end 是**半开** [from, to):拖到第 5 列反色到第 4 列。
//   I4  未命中 → highlighted:false;命中但零宽 → 也是 highlighted:true。
//       两者渲染结果相同,但语义不同,不能用 mid==='' 反推。
//
// `node --test`。

const test = require('node:test');
const assert = require('node:assert');
const { sliceLineForSelection } = require('../../../../src/cli/tui/ink-components/Viewport');

/** 断言 I1:分段不得吞字符。 */
function assertIdentity(seg, line) {
  assert.equal(
    seg.head + seg.mid + seg.tail,
    line === '' ? ' ' : line,
    `分段与原文不一致: ${JSON.stringify(seg)} vs ${JSON.stringify(line)}`
  );
}

// ── 未命中 / 降级 ────────────────────────────────────────────────────────────
test('V-01: selection 为 null/undefined → highlighted:false,原文完整回传', () => {
  for (const sel of [null, undefined]) {
    const seg = sliceLineForSelection('hello world', 3, sel);
    assert.equal(seg.highlighted, false);
    assert.equal(seg.mid, '');
    assertIdentity(seg, 'hello world');
  }
});

test('V-02: 行在选区之外(上方/下方)→ 不反色', () => {
  const sel = { anchor: { line: 5, col: 2 }, head: { line: 7, col: 4 } };
  for (const row of [0, 4, 8, 100]) {
    const seg = sliceLineForSelection('abcdef', row, sel);
    assert.equal(seg.highlighted, false, `行 ${row} 不该反色`);
    assertIdentity(seg, 'abcdef');
  }
});

test('V-03: 空行在未命中时退化成单空格(与无选区路径的 `line || \' \'` 对齐)', () => {
  const seg = sliceLineForSelection('', 9, { anchor: { line: 0, col: 0 }, head: { line: 1, col: 1 } });
  assert.equal(seg.highlighted, false);
  assert.equal(seg.head, ' ');
  assert.equal(seg.mid, '');
  assert.equal(seg.tail, '');
});

test('V-04: 畸形 selection(start/end 缺失、NaN 坐标)→ 降级为不反色,绝不抛', () => {
  const cases = [
    {},
    { start: null, end: null },
    { anchor: { line: 0, col: 0 } },
    { start: { line: NaN, col: 0 }, head: { line: 1, col: 1 } },
    { start: { line: 0, col: NaN }, head: { line: 1, col: 1 } },
    { start: { line: Infinity, col: 0 }, head: { line: 1, col: 1 } },
    'not-an-object',
    42,
  ];
  for (const sel of cases) {
    assert.doesNotThrow(() => sliceLineForSelection('abc', 0, sel), JSON.stringify(sel));
    const seg = sliceLineForSelection('abc', 0, sel);
    assert.equal(seg.highlighted, false, `畸形输入必须降级: ${JSON.stringify(sel)}`);
    assertIdentity(seg, 'abc');
  }
});

// ── 单行选区 ─────────────────────────────────────────────────────────────────
test('V-05: 单行选区切出 head/mid/tail 三段,且拼回恒等原文', () => {
  const seg = sliceLineForSelection('hello world', 2, {
    anchor: { line: 2, col: 0 },
    head: { line: 2, col: 5 },
  });
  assert.equal(seg.highlighted, true);
  assert.equal(seg.head, '');
  assert.equal(seg.mid, 'hello');
  assert.equal(seg.tail, ' world');
  assertIdentity(seg, 'hello world');
});

test('V-06: 半开区间 —— end.col 那一列**不**反色(拖到第 5 列反色到第 4 列)', () => {
  const seg = sliceLineForSelection('abcdef', 0, {
    anchor: { line: 0, col: 1 },
    head: { line: 0, col: 3 },
  });
  assert.equal(seg.head, 'a');
  assert.equal(seg.mid, 'bc', 'col 3 的 d 不该被选中');
  assert.equal(seg.tail, 'def');
});

test('V-07: 零宽选区(按下未拖动)→ highlighted:true 但 mid 为空', () => {
  const seg = sliceLineForSelection('abcdef', 0, {
    anchor: { line: 0, col: 3 },
    head: { line: 0, col: 3 },
  });
  assert.equal(seg.highlighted, true, '零宽 ≠ 未命中,语义不同不能混');
  assert.equal(seg.mid, '');
  assert.equal(seg.head, 'abc');
  assert.equal(seg.tail, 'def');
  assertIdentity(seg, 'abcdef');
});

test('V-08: 整行被选中 → 单段 mid,无空 Text 节点', () => {
  const seg = sliceLineForSelection('abcdef', 0, {
    anchor: { line: 0, col: 0 },
    head: { line: 0, col: 6 },
  });
  assert.equal(seg.highlighted, true);
  assert.equal(seg.head, '');
  assert.equal(seg.mid, 'abcdef');
  assert.equal(seg.tail, '');
});

// ── 跨行选区(首/中/末行三种角色)──────────────────────────────────────────────
test('V-09: 跨行 —— 首行从 start.col 到行尾', () => {
  const sel = { anchor: { line: 1, col: 3 }, head: { line: 3, col: 2 } };
  const seg = sliceLineForSelection('abcdefgh', 1, sel);
  assert.equal(seg.head, 'abc');
  assert.equal(seg.mid, 'defgh', '首行:到本行末尾');
  assert.equal(seg.tail, '');
});

test('V-10: 跨行 —— 中间行**整行**反色', () => {
  const sel = { anchor: { line: 1, col: 3 }, head: { line: 3, col: 2 } };
  const seg = sliceLineForSelection('abcdefgh', 2, sel);
  assert.equal(seg.highlighted, true);
  assert.equal(seg.head, '');
  assert.equal(seg.mid, 'abcdefgh');
  assert.equal(seg.tail, '');
});

test('V-11: 跨行 —— 末行从行首到 end.col(不含)', () => {
  const sel = { anchor: { line: 1, col: 3 }, head: { line: 3, col: 2 } };
  const seg = sliceLineForSelection('abcdefgh', 3, sel);
  assert.equal(seg.head, '');
  assert.equal(seg.mid, 'ab', '末行:从行首到 col 2');
  assert.equal(seg.tail, 'cdefgh');
});

// ── 边界:坐标越界必须被裁剪而不是崩 ─────────────────────────────────────────
test('V-12: col 越界(负数 / 超过行长)被裁剪,绝不抛', () => {
  const over = sliceLineForSelection('abc', 0, {
    anchor: { line: 0, col: 0 },
    head: { line: 0, col: 999 },
  });
  assert.equal(over.mid, 'abc', 'end 超出行长 → 裁到行尾');
  assertIdentity(over, 'abc');

  const neg = sliceLineForSelection('abc', 0, {
    anchor: { line: 0, col: -5 },
    head: { line: 0, col: 2 },
  });
  assert.equal(neg.highlighted, true);
  assert.equal(neg.mid, 'ab', '起点负数 → 裁到 0');
  assertIdentity(neg, 'abc');
});

test('V-13: 反向选区(anchor 在 head 之后)→ **主动归一化**,渲染与正向一致', () => {
  // 上游的 `selection.js` 同样在 normalizeSelection 里交换 anchor/head(用户可能反着拖),
  // 渲染侧必须同口径 —— 否则「从右下往左上拖」会一个字符都不反色,看起来像功能坏了。
  const reversed = sliceLineForSelection('abcdef', 0, {
    anchor: { line: 0, col: 4 },
    head: { line: 0, col: 2 },
  });
  const forward = sliceLineForSelection('abcdef', 0, {
    anchor: { line: 0, col: 2 },
    head: { line: 0, col: 4 },
  });
  assert.equal(reversed.highlighted, true);
  assert.equal(reversed.mid, 'cd', '反向拖选应得到与正向相同的区间 [2,4)');
  assert.deepEqual(reversed, forward, '两个方向必须渲染成完全一样的东西');
  assertIdentity(reversed, 'abcdef');
});

test('V-14: 跨行选中空行 → 该行仍占一个空格高,不得塌行', () => {
  const sel = { anchor: { line: 0, col: 1 }, head: { line: 2, col: 1 } };
  const seg = sliceLineForSelection('', 1, sel);
  assert.equal(seg.highlighted, true, '空行在选区中间也是「选中」——复制时会产出空行');
  // 必须是 `' '` 而不是 '' —— 空串会让这一行在 ink 里渲染成 0 高,长转录里表现为
  // 「选中一个空行以后整篇往上错位一行」。这与无选区路径的 `line || ' '` 同口径。
  assert.equal(seg.mid, ' ', '空行选中仍要吐出占位空格');
  assert.equal(seg.head, '');
  assert.equal(seg.tail, '');
});

// ── I1 恒等性的规模抽查(最容易静默退化的一条)─────────────────────────────────
test('V-15: 随机化抽查 —— head+mid+tail 恒等于原文,且 mid 与 extractText 语义一致', () => {
  const lines = ['a', 'hello world', 'D:/Portable/khy-os/a.js', '中文内容测试', '', '  indented'];
  for (const line of lines) {
    for (let a = 0; a <= line.length; a++) {
      for (let b = a; b <= line.length; b++) {
        const seg = sliceLineForSelection(line, 0, {
          anchor: { line: 0, col: a },
          head: { line: 0, col: b },
        });
        assertIdentity(seg, line);
        // 空行的 `mid` 是占位空格(见 V-14),不参与 slice 比对 —— 但非空行必须严格相等。
        if (line !== '') {
          assert.equal(seg.mid, line.slice(a, b), `[${a},${b}) 取词应等于 slice`);
        }
      }
    }
  }
});

test('V-16: lineIdx 非数字 → 降级为不反色(不静默按 0 处理)', () => {
  const sel = { anchor: { line: 0, col: 0 }, head: { line: 0, col: 3 } };
  for (const bad of [undefined, null, NaN, 'x', {}]) {
    const seg = sliceLineForSelection('abcdef', bad, sel);
    assert.equal(seg.highlighted, false, `lineIdx=${JSON.stringify(bad)} 不该命中`);
    assertIdentity(seg, 'abcdef');
  }
});
