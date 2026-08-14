'use strict';

// docPathIndex 叶子契约测试(node:test)。
// Layer 1(过时提醒)的派生核心:正文引用解析 → 反向索引 → 变更→嫌疑文档匹配。绝不抛。
const test = require('node:test');
const assert = require('node:assert');

const {
  docsFreshnessEnabled,
  extractSourcePaths,
  buildDocPathIndex,
  matchStaleSuspects,
  _cleanSourcePath,
} = require('../../src/services/docsFreshness/docPathIndex');

test('docsFreshnessEnabled 默认开(unset / 空 / 未知值),{0,false,off,no} 关', () => {
  assert.strictEqual(docsFreshnessEnabled({}), true);
  assert.strictEqual(docsFreshnessEnabled({ KHY_DOCS_FRESHNESS: '' }), true);
  assert.strictEqual(docsFreshnessEnabled({ KHY_DOCS_FRESHNESS: 'x' }), true);
  for (const off of ['0', 'false', 'off', 'no', 'OFF', ' No ']) {
    assert.strictEqual(
      docsFreshnessEnabled({ KHY_DOCS_FRESHNESS: off }),
      false,
      `${JSON.stringify(off)} 应关`,
    );
  }
});

test('_cleanSourcePath:剥行号/范围/锚点,锚定 ROOT_SEGMENTS + 源码扩展名', () => {
  assert.strictEqual(_cleanSourcePath('services/backend/src/cli/router.js'), 'services/backend/src/cli/router.js');
  assert.strictEqual(_cleanSourcePath('services/backend/src/cli/router.js:3230'), 'services/backend/src/cli/router.js');
  assert.strictEqual(_cleanSourcePath('services/backend/src/cli/router.js:3-14'), 'services/backend/src/cli/router.js');
  assert.strictEqual(_cleanSourcePath('services/backend/src/cli/router.js:3230:5'), 'services/backend/src/cli/router.js');
  assert.strictEqual(_cleanSourcePath('services/backend/src/cli/router.js#main'), 'services/backend/src/cli/router.js');
  assert.strictEqual(_cleanSourcePath('./scripts/docs/md-to-pdf.js'), 'scripts/docs/md-to-pdf.js');
  assert.strictEqual(_cleanSourcePath('kernel\\src\\sched.c'), 'kernel/src/sched.c');
  // 说明文字混入 → 只取首 token。
  assert.strictEqual(_cleanSourcePath('services/backend/src/x.js 的 case'), 'services/backend/src/x.js');
});

test('_cleanSourcePath:拒绝裸文件名 / 非源码扩展 / 非 ROOT 段 / 路径穿越', () => {
  assert.strictEqual(_cleanSourcePath('router.js'), null);       // 裸文件名,不锚定
  assert.strictEqual(_cleanSourcePath('services/README.md'), null); // 非源码扩展
  assert.strictEqual(_cleanSourcePath('foo/bar.js'), null);      // foo 非 ROOT 段
  assert.strictEqual(_cleanSourcePath('services/../etc/passwd.sh'), null); // 穿越
  assert.strictEqual(_cleanSourcePath(''), null);
  assert.strictEqual(_cleanSourcePath(null), null);
  assert.strictEqual(_cleanSourcePath(42), null);
});

test('extractSourcePaths:从「真源:」「实现:」正文抽路径,去重', () => {
  const text = [
    '# 某文档',
    '真源:`services/backend/src/services/tokenUsageService.js`。',
    '实现见 `scripts/docs/md-to-pdf.js` 与 `services/backend/src/cli/router.js:2158`。',
    '再次提到 `services/backend/src/services/tokenUsageService.js`(重复不应双计)。',
    '这段 `npm run test` 不是路径,`foo.py` 裸名也不算。',
  ].join('\n');
  const paths = extractSourcePaths(text);
  assert.deepStrictEqual(
    paths.sort(),
    [
      'scripts/docs/md-to-pdf.js',
      'services/backend/src/cli/router.js',
      'services/backend/src/services/tokenUsageService.js',
    ],
  );
});

test('extractSourcePaths:垃圾/空输入不抛,返回 []', () => {
  assert.deepStrictEqual(extractSourcePaths(''), []);
  assert.deepStrictEqual(extractSourcePaths(null), []);
  assert.deepStrictEqual(extractSourcePaths(undefined), []);
  assert.deepStrictEqual(extractSourcePaths(12345), []);
});

test('buildDocPathIndex:反向 source → [doc],跨文档合并', () => {
  const docs = [
    { path: 'docs/A.md', text: '真源 `services/backend/src/x.js`' },
    { path: 'docs/B.md', text: '也引用 `services/backend/src/x.js` 和 `scripts/y.js`' },
  ];
  const idx = buildDocPathIndex(docs);
  assert.strictEqual(idx.generatedBy, 'prose-scan');
  assert.strictEqual(idx.docCount, 2);
  assert.deepStrictEqual(idx.bySource.get('services/backend/src/x.js').sort(), ['docs/A.md', 'docs/B.md']);
  assert.deepStrictEqual(idx.bySource.get('scripts/y.js'), ['docs/B.md']);
});

test('buildDocPathIndex:坏输入(非数组/缺 text/缺 id)跳过不抛', () => {
  const idx = buildDocPathIndex([
    null,
    { text: '`services/backend/src/z.js`' }, // 无 path/id → 跳过
    { path: 'docs/C.md' },                    // 无 text → 跳过
    'garbage',
  ]);
  assert.strictEqual(idx.docCount, 0);
  assert.strictEqual(idx.bySource.size, 0);
  assert.deepStrictEqual(buildDocPathIndex(null).bySource.size, 0);
});

test('matchStaleSuspects:exact 命中,置信 exact', () => {
  const idx = buildDocPathIndex([
    { path: 'docs/A.md', text: '真源 `services/backend/src/cli/router.js`' },
  ]);
  const r = matchStaleSuspects(['services/backend/src/cli/router.js'], idx);
  assert.strictEqual(r.suspects.length, 1);
  assert.strictEqual(r.suspects[0].doc, 'docs/A.md');
  assert.strictEqual(r.suspects[0].confidence, 'exact');
  assert.deepStrictEqual(r.suspects[0].matchedSources, ['services/backend/src/cli/router.js']);
  assert.deepStrictEqual(r.unmatchedChanges, []);
});

test('matchStaleSuspects:同目录兄弟 → prefix 低置信', () => {
  const idx = buildDocPathIndex([
    { path: 'docs/A.md', text: '引用 `services/backend/src/cli/router.js`' },
  ]);
  // 改的是同目录另一文件(repl.js),文档没直接引用它,但同目录 → prefix。
  const r = matchStaleSuspects(['services/backend/src/cli/repl.js'], idx);
  assert.strictEqual(r.suspects.length, 1);
  assert.strictEqual(r.suspects[0].confidence, 'prefix');
});

test('matchStaleSuspects:exact 覆盖 prefix(同文档两路命中升级为 exact)', () => {
  const idx = buildDocPathIndex([
    { path: 'docs/A.md', text: '引用 `services/backend/src/cli/router.js` 和 `services/backend/src/cli/repl.js`' },
  ]);
  const r = matchStaleSuspects(['services/backend/src/cli/router.js'], idx);
  // router.js exact 命中 A;repl.js 同目录 prefix 也命中 A → 该文档最终 exact。
  assert.strictEqual(r.suspects.length, 1);
  assert.strictEqual(r.suspects[0].confidence, 'exact');
});

test('matchStaleSuspects:无命中 → 进 unmatchedChanges', () => {
  const idx = buildDocPathIndex([
    { path: 'docs/A.md', text: '引用 `services/backend/src/cli/router.js`' },
  ]);
  const r = matchStaleSuspects(['frontend/src/App.vue'], idx);
  assert.deepStrictEqual(r.suspects, []);
  assert.deepStrictEqual(r.unmatchedChanges, ['frontend/src/App.vue']);
});

test('matchStaleSuspects:归一化 ./ 与反斜杠;垃圾输入不抛', () => {
  const idx = buildDocPathIndex([
    { path: 'docs/A.md', text: '`services/backend/src/cli/router.js`' },
  ]);
  const r = matchStaleSuspects(['./services/backend/src/cli/router.js'], idx);
  assert.strictEqual(r.suspects.length, 1);
  assert.doesNotThrow(() => matchStaleSuspects(null, idx));
  assert.doesNotThrow(() => matchStaleSuspects(['x'], null));
});

test('matchStaleSuspects:确定性排序(exact 先于 prefix)', () => {
  const idx = buildDocPathIndex([
    { path: 'docs/Exact.md', text: '`services/backend/src/cli/router.js`' },
    { path: 'docs/Prefix.md', text: '`services/backend/src/cli/steps.js`' },
  ]);
  // 改 router.js(Exact 直引=exact)与 repl.js(与两文档同目录=prefix)。
  const r = matchStaleSuspects(
    ['services/backend/src/cli/router.js', 'services/backend/src/cli/repl.js'],
    idx,
  );
  assert.strictEqual(r.suspects[0].confidence, 'exact');
  const confidences = r.suspects.map((s) => s.confidence);
  // exact 全部排在 prefix 前。
  const firstPrefix = confidences.indexOf('prefix');
  if (firstPrefix >= 0) {
    assert.ok(!confidences.slice(firstPrefix).includes('exact'), 'exact 不应出现在 prefix 之后');
  }
});
