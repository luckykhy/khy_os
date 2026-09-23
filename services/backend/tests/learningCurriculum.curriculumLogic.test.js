'use strict';

/**
 * learningCurriculum.curriculumLogic.test.js — locks the pure / deterministic
 * logic of the learning-curriculum engine:
 *   - getLayers/getLayer: JSON 地板层 + 动态 Bug 层(id 10) 合并、按 id 升序
 *   - getRank / countCompletedLayers: 修仙境界阶梯阈值契约（空 → 凡人，
 *     全通关 → 大师，next/layersToNext/inRankPct 计算）
 *   - prompt builders: 题目/层级/源码文件注入、beginner 块只在 level==='beginner'
 *     追加、ragContext 空串保持字节兼容
 *   - buildLearningMemoryContext: 空进度 → ''，有完成项 → 分层清单 + 笔记 + 总 XP
 *   - export/importProgress: 版本信封、merge 取并集/较大值、replace 覆盖、
 *     错误路径（NO_PATH / NOT_FOUND / PARSE_FAILED / INVALID_SCHEMA）结构化返回
 *   - 路径自愈 resolveSourceAbs（old→new 前缀重映射）、readFilePreview、scanDir
 * 进度 IO 通过 KHYOS_HOME 指向一次性 tmp 目录隔离，绝不读写真实用户数据；
 * 课程数据（curriculum.json）只读。谁改境界阈值 / 提示词契约先红。
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'lc-test-'));
const GROWTH_DIR = path.join(TMP_HOME, 'growth');
const PROGRESS_FILE = path.join(GROWTH_DIR, 'learning_progress.json');
const savedKhyosHome = process.env.KHYOS_HOME;

function freshProgress(overrides = {}) {
  return {
    completedTopics: [],
    viewedTopics: [],
    currentLayer: 0,
    totalXP: 0,
    startedAt: new Date().toISOString(),
    lastVisit: null,
    streak: { count: 0, lastDate: null },
    notes: {},
    source: 'cli-learning-curriculum',
    ...overrides,
  };
}

function seedProgress(p) {
  fs.mkdirSync(GROWTH_DIR, { recursive: true });
  fs.writeFileSync(PROGRESS_FILE, JSON.stringify(p, null, 2), 'utf-8');
}

before(() => {
  process.env.KHYOS_HOME = TMP_HOME; // wins unconditionally in dataHome
  seedProgress(freshProgress());
});

after(() => {
  if (savedKhyosHome === undefined) delete process.env.KHYOS_HOME;
  else process.env.KHYOS_HOME = savedKhyosHome;
  fs.rmSync(TMP_HOME, { recursive: true, force: true });
});

// Load AFTER the env redirection so all lazy dataHome resolution lands in tmp.
const curriculum = require('../src/services/learningCurriculum');
const { BUG_CASES } = require('../src/data/bugCases');

// 地板层（剔除动态覆盖层/动态知识点）——与模块内 _floorLayers 同口径
function floorLayers() {
  return curriculum
    .getLayers()
    .filter((l) => !l._source)
    .map((l) =>
      (l.topics || []).some((t) => t._dynamic)
        ? { ...l, topics: l.topics.filter((t) => !t._dynamic) }
        : l
    );
}

function completeAllFloorTopics() {
  const keys = [];
  for (const l of floorLayers()) {
    for (const t of l.topics) keys.push(`${l.id}:${t.id}`);
  }
  return keys;
}

describe('learningCurriculum 层结构', () => {
  test('getLayers: 合并后 id 严格升序，且包含 id=10 的 Bug 层（主题数 = BUG_CASES 数）', () => {
    const layers = curriculum.getLayers();
    const ids = layers.map((l) => l.id);
    for (let i = 1; i < ids.length; i++) {
      assert.ok(ids[i] > ids[i - 1], `层 id 必须升序: ${ids.join(',')}`);
    }
    const bugLayer = layers.find((l) => l.id === 10);
    assert.ok(bugLayer, 'Bug 层 (id 10) 必须存在');
    assert.strictEqual(bugLayer.topics.length, BUG_CASES.length);
    assert.ok(bugLayer.topics.every((t) => t._bugCase === true), 'Bug 层主题必须带 _bugCase 标记');
  });

  test('getLayer: 已知 id 返回层，未知 id 返回 null', () => {
    assert.ok(curriculum.getLayer(10), 'id 10 可查到');
    assert.strictEqual(curriculum.getLayer(999), null);
  });
});

describe('learningCurriculum 修仙境界（getRank / countCompletedLayers）', () => {
  test('空进度 → Lv0 凡人，next 练气，layersToNext=1，inRankPct=0，非大师', () => {
    const r = curriculum.getRank(freshProgress());
    assert.strictEqual(r.level, 0);
    assert.strictEqual(r.name, '凡人');
    assert.strictEqual(r.next, '练气');
    assert.strictEqual(r.layersToNext, 1);
    assert.strictEqual(r.inRankPct, 0);
    assert.strictEqual(r.isMaster, false);
    assert.strictEqual(r.completedLayers, 0);
  });

  test('全地板层通关 → Lv7 大师（isMaster=true, next=null, inRankPct=100）', () => {
    const p = freshProgress({ completedTopics: completeAllFloorTopics() });
    const r = curriculum.getRank(p);
    assert.strictEqual(r.name, '大师');
    assert.strictEqual(r.isMaster, true);
    assert.strictEqual(r.next, null);
    assert.strictEqual(r.inRankPct, 100);
    assert.strictEqual(r.completedLayers, floorLayers().length);
    assert.ok(r.completedLayers >= 12, `大师线需 ≥12 个通关层，实际 ${r.completedLayers}`);
  });

  test('countCompletedLayers: 空 → 0；全部 → 地板层总数', () => {
    assert.strictEqual(curriculum.countCompletedLayers(freshProgress()), 0);
    assert.strictEqual(
      curriculum.countCompletedLayers({ completedTopics: completeAllFloorTopics() }),
      floorLayers().length,
    );
  });

  test('境界阈值单调：整层通关 3 层 → 筑基（minLayers=3）', () => {
    // 显式构造 3 个「整层通关」：取前 3 个有知识点的地板层，全部 key
    const floors = floorLayers().filter((l) => l.topics.length > 0);
    assert.ok(floors.length >= 3, '课程至少要有 3 个含知识点的层');
    const three = floors
      .slice(0, 3)
      .flatMap((l) => l.topics.map((t) => `${l.id}:${t.id}`));
    const r3 = curriculum.getRank(freshProgress({ completedTopics: three }));
    assert.strictEqual(r3.completedLayers, 3);
    assert.strictEqual(r3.name, '筑基');
    assert.strictEqual(r3.next, '金丹');
    assert.ok(r3.inRankPct >= 0 && r3.inRankPct <= 100);
  });
});

describe('learningCurriculum 学习记忆与提示词构建', () => {
  test('buildLearningMemoryContext: 无完成项 → 空串（提示词保持字节兼容）', () => {
    seedProgress(freshProgress());
    assert.strictEqual(curriculum.buildLearningMemoryContext(), '');
  });

  test('buildLearningMemoryContext: 有完成项 → 分层清单 + 笔记首行 + 总 XP', () => {
    seedProgress(
      freshProgress({
        completedTopics: ['1:1', '1:2'],
        totalXP: 20,
        notes: { '1:1': '第一行笔记\n第二行' },
      }),
    );
    const ctx = curriculum.buildLearningMemoryContext();
    assert.match(ctx, /学习记忆/);
    assert.match(ctx, /第 1 层/);
    assert.match(ctx, /笔记: 第一行笔记/, '只取笔记首行');
    assert.doesNotMatch(ctx, /第二行/);
    assert.match(ctx, /总 XP: 20/);
    assert.match(ctx, /已完成: 2 个知识点/);
    seedProgress(freshProgress());
  });

  test('buildLearningPrompt: 含题目/描述/源码文件；beginner 块仅 level=beginner 追加', () => {
    seedProgress(freshProgress());
    const layer = curriculum.getLayer(10);
    const topic = layer.topics[0];
    const base = curriculum.buildLearningPrompt(layer, topic, {});
    assert.ok(base.includes(topic.title), `缺题目: ${topic.title}`);
    assert.ok(base.includes(layer.title), '缺层标题');
    assert.ok(!base.includes('零基础讲解模式'), '非 beginner 不得追加零基础块');
    const beginner = curriculum.buildLearningPrompt(layer, topic, { level: 'beginner' });
    assert.ok(beginner.includes('零基础讲解模式'));
    assert.ok(beginner.includes('learn improve'));
    // 非 beginner 档位 → 与默认字节一致
    assert.strictEqual(curriculum.buildLearningPrompt(layer, topic, { level: 'expert' }), base);
  });

  test('ragContext 注入：空 → 无 grounding 块；有内容 → 「检索到的相关材料」块', () => {
    seedProgress(freshProgress());
    const layer = curriculum.getLayer(10);
    const topic = layer.topics[0];
    const withRag = curriculum.buildSimpleTopicPrompt(layer, topic, {
      ragContext: 'chunk-1: some code',
    });
    assert.match(withRag, /检索到的相关材料/);
    assert.match(withRag, /chunk-1: some code/);
    const noRag = curriculum.buildSimpleTopicPrompt(layer, topic, {});
    assert.doesNotMatch(noRag, /检索到的相关材料/);
  });

  test('buildLayerOverviewPrompt / buildSimpleLayerPrompt: 层主题清单完整 + simple 版 3-5 句指令', () => {
    seedProgress(freshProgress());
    const layer = curriculum.getLayer(10);
    const overview = curriculum.buildLayerOverviewPrompt(layer, {});
    for (const t of layer.topics) assert.ok(overview.includes(t.title), `缺主题: ${t.title}`);
    const simple = curriculum.buildSimpleLayerPrompt(layer, {});
    assert.ok(simple.includes('3-5 句话'), 'simple 版应要求 3-5 句话');
    const simpleTopic = curriculum.buildSimpleTopicPrompt(layer, layer.topics[0], {});
    assert.ok(simpleTopic.includes('3-5 句话'), 'simple 知识点版应要求 3-5 句话');
  });

  test('buildBugCasePrompt: 症状/根因/修复/经验/范例三元组齐全；detailDoc 存在时附文档行', () => {
    seedProgress(freshProgress());
    const c = BUG_CASES[0];
    const prompt = curriculum.buildBugCasePrompt(c);
    assert.ok(prompt.includes(c.title), `缺案例标题: ${c.title}`);
    assert.ok(prompt.includes(c.severity), '缺严重等级');
    assert.ok(prompt.includes(c.symptom), '缺症状描述');
    assert.ok(prompt.includes(c.rootCause), '缺根因');
    assert.ok(prompt.includes(c.fix), '缺修复要点');
    assert.ok(prompt.includes(c.lesson), '缺经验总结');
    assert.ok(prompt.includes(c.example.input), '缺范例 input');
    assert.ok(prompt.includes(c.example.reasoning), '缺范例 reasoning');
    assert.ok(prompt.includes(c.example.output), '缺范例 output');
    if (c.detailDoc) {
      assert.ok(prompt.includes(c.detailDoc), '缺 detailDoc 行');
    }
  });
});

describe('learningCurriculum 进度导出 / 导入', () => {
  test('exportProgress: 写出带版本信封的文件，返回 {ok, path, completed, totalXP}', () => {
    seedProgress(freshProgress({ completedTopics: ['1:1'], totalXP: 10 }));
    const dest = path.join(TMP_HOME, 'out', 'progress.json');
    const res = curriculum.exportProgress(dest);
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.completed, 1);
    assert.strictEqual(res.totalXP, 10);
    const file = JSON.parse(fs.readFileSync(res.path, 'utf-8'));
    assert.strictEqual(file.tool, 'khy-learn');
    assert.strictEqual(file.type, 'learning-progress');
    assert.strictEqual(file.version, 1);
    assert.deepStrictEqual(file.progress.completedTopics, ['1:1']);
  });

  test('exportProgress: 目标目录不可写 → 结构化 {ok:false, error:"WRITE_FAILED"}', () => {
    const blocker = path.join(TMP_HOME, 'blocker');
    fs.writeFileSync(blocker, 'x');
    const res = curriculum.exportProgress(path.join(blocker, 'sub', 'p.json'));
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.error, 'WRITE_FAILED');
  });

  test('importProgress: merge 模式取 completed 并集 / XP 较大值 / notes 拼接', () => {
    seedProgress(
      freshProgress({
        completedTopics: ['1:1'],
        totalXP: 100,
        notes: { '1:1': 'A' },
      }),
    );
    const src = path.join(TMP_HOME, 'import.json');
    fs.writeFileSync(
      src,
      JSON.stringify({
        tool: 'khy-learn',
        type: 'learning-progress',
        version: 1,
        progress: freshProgress({
          completedTopics: ['1:2'],
          totalXP: 10,
          notes: { '1:1': 'B' },
        }),
      }),
    );
    const res = curriculum.importProgress(src, { merge: true });
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.mode, 'merge');
    const after = curriculum.getProgress();
    assert.deepStrictEqual(
      after.completedTopics.sort(),
      ['1:1', '1:2'],
      'completed 取并集',
    );
    assert.strictEqual(after.totalXP, 100, 'XP 取较大值');
    assert.match(after.notes['1:1'], /A/);
    assert.match(after.notes['1:1'], /B/, 'notes 拼接');
    assert.strictEqual(res.completedAfter, 2);
  });

  test('importProgress: replace 模式整体覆盖（旧 completed 被丢弃）', () => {
    seedProgress(freshProgress({ completedTopics: ['1:1'], totalXP: 999 }));
    const src = path.join(TMP_HOME, 'import2.json');
    fs.writeFileSync(
      src,
      JSON.stringify(freshProgress({ completedTopics: ['2:1'], totalXP: 5 })),
    );
    const res = curriculum.importProgress(src, { merge: false });
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.mode, 'replace');
    const after = curriculum.getProgress();
    assert.deepStrictEqual(after.completedTopics, ['2:1']);
    assert.strictEqual(after.totalXP, 5);
  });

  test('importProgress: 无路径 / 文件不存在 / 坏 JSON / 非对象 schema → 结构化错误且不动现有进度', () => {
    seedProgress(freshProgress({ completedTopics: ['1:1'] }));
    const snap = curriculum.getProgress().completedTopics.slice();
    const noPath = curriculum.importProgress('');
    assert.strictEqual(noPath.ok, false);
    assert.strictEqual(noPath.error, 'NO_PATH');
    const notFound = curriculum.importProgress(path.join(TMP_HOME, 'nope.json'));
    assert.strictEqual(notFound.error, 'NOT_FOUND');
    const badJson = path.join(TMP_HOME, 'bad.json');
    fs.writeFileSync(badJson, '{oops');
    assert.strictEqual(curriculum.importProgress(badJson).error, 'PARSE_FAILED');
    const badSchema = path.join(TMP_HOME, 'bad-schema.json');
    fs.writeFileSync(badSchema, '"just a string"');
    assert.strictEqual(curriculum.importProgress(badSchema).error, 'INVALID_SCHEMA');
    assert.deepStrictEqual(curriculum.getProgress().completedTopics, snap, '失败路径不得改动现有进度');
  });
});

describe('learningCurriculum 路径自愈与源码预览', () => {
  test('resolveSourceAbs: old→new 前缀重映射（backend/ → services/backend/）', () => {
    const abs = curriculum.resolveSourceAbs('backend/src/cli/router.js');
    assert.ok(abs, '重映射后应解析成功');
    assert.match(abs, new RegExp(`services[\\\\/]backend[\\\\/]src[\\\\/]cli[\\\\/]router\\.js`));
    assert.ok(fs.existsSync(abs));
    // 字面新路径同样可解析；不存在的路径 → null
    assert.ok(curriculum.resolveSourceAbs('services/backend/src/cli/router.js'));
    assert.strictEqual(curriculum.resolveSourceAbs('definitely_missing_xyz_12345.js'), null);
  });

  test('readFilePreview: 文件 → {type:"file", lines, total}；目录 → {type:"dir"}；缺失 → null', () => {
    const f = curriculum.readFilePreview('services/backend/src/utils/growthDataDir.js');
    assert.ok(f, '应可预览');
    assert.strictEqual(f.type, 'file');
    assert.ok(f.lines.length > 0 && f.total >= f.lines.length);
    const d = curriculum.readFilePreview('services/backend/src/cli');
    assert.strictEqual(d.type, 'dir');
    assert.ok(d.lines.length > 0);
    assert.strictEqual(curriculum.readFilePreview('definitely_missing_xyz_12345.js'), null);
  });

  test('scanDir: 旧前缀目录 + *.js → 非空且全部 .js；*Adapter.js → 全部以 Adapter.js 结尾', () => {
    // 结果路径由 path.join 拼出（Windows 下分隔符为 \\），断言保持分隔符无关
    const split = (f) => f.split(/[\\/]/);
    const handlers = curriculum.scanDir('backend/src/cli/handlers', '*.js');
    assert.ok(handlers.length > 0, 'handlers 目录应有 JS 文件');
    assert.ok(handlers.every((f) => f.endsWith('.js')));
    assert.ok(handlers.every((f) => split(f).includes('handlers') && split(f).includes('backend')));
    const adapters = curriculum.scanDir('backend/src/services/gateway/adapters', '*Adapter.js');
    assert.ok(adapters.length > 0, 'adapters 目录应有 *Adapter.js');
    assert.ok(adapters.every((f) => f.endsWith('Adapter.js')));
    // 不存在的目录 → []
    assert.deepStrictEqual(curriculum.scanDir('definitely_missing_dir', '*.js'), []);
  });
});

describe('learningCurriculum 完整性检查', () => {
  test('checkFileReferences: total = ok + missing，条目含 layer/topic/file 三字段', () => {
    const r = curriculum.checkFileReferences();
    assert.strictEqual(r.total, r.ok.length + r.missing.length, 'total 必须等于 ok+missing');
    for (const e of [...r.ok, ...r.missing]) {
      assert.ok('layer' in e && 'topic' in e && 'file' in e);
    }
  });

  test('syncCurriculum: 报告结构稳定；suggestions 仅含 add-topic / fix-ref 两种动作', () => {
    const rep = curriculum.syncCurriculum();
    assert.ok(Array.isArray(rep.uncovered));
    assert.ok(Array.isArray(rep.stale));
    assert.ok(Array.isArray(rep.suggestions));
    for (const s of rep.suggestions) {
      assert.ok(
        s.action === 'add-topic' || s.action === 'fix-ref',
        `未知 suggestion 动作: ${s.action}`,
      );
    }
    for (const s of rep.stale) {
      assert.ok(curriculum.buildSyncPrompt({ ...rep, uncovered: [] }).includes(s.file));
    }
    const prompt = curriculum.buildSyncPrompt(rep);
    assert.match(prompt, /CURRICULUM SYNC/);
  });

  test('getNextTopic / findByQuery: 结构契约（空查询 → null；数字查询 → 层定位）', () => {
    seedProgress(freshProgress());
    const next = curriculum.getNextTopic();
    assert.ok(
      next === null || (next.layer && next.topic),
      'getNextTopic 必须是 null 或 {layer, topic}',
    );
    assert.strictEqual(curriculum.findByQuery(null), null);
    assert.strictEqual(curriculum.findByQuery('  '), null);
    const byNum = curriculum.findByQuery('10');
    assert.ok(byNum && byNum.layer.id === 10, '数字 "10" 定位到 Bug 层');
  });
});
