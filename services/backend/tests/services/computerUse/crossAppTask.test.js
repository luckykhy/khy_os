'use strict';

/**
 * crossAppTask.test.js — 跨应用连贯任务（如「浏览器搜攻略 → 备忘录记顺序 →
 * 地图核对 → 日历建日程」）所依赖的四项能力验收：
 *
 *   1. 跨应用暗记（remember/scratchpad）：应用 A 读到的信息活到应用 D
 *   2. 执行计划每轮注入：长任务里模型不丢失「做到第几步」的阶段感
 *   3. 应用识别：备忘录 / 地图 / 日历 等系统小应用进入 targetApps 清单
 *   4. 迭代预算：轮数随应用数放大，四应用任务不会在最后一个应用前耗尽
 *
 * 全程注入 fake gateway / fake controller，零真实截屏与桌面操控。
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const appTarget = require('../../../src/services/computerUse/appTarget');
const {
  ComputerUseAgent,
  SYSTEM_PROMPT,
  _internals,
} = require('../../../src/services/computerUse/computerUseAgent');

// ── 测试夹具 ──────────────────────────────────────────────────────────────

// 1x1 合法 PNG：agent 只要求截图文件存在可读，视觉 diff 本身 fail-soft。
const PNG_1X1_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';

function makeShot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-crossapp-'));
  const file = path.join(dir, 'shot.png');
  fs.writeFileSync(file, Buffer.from(PNG_1X1_BASE64, 'base64'));
  return { dir, file };
}

function fakeController(shotPath) {
  return {
    capabilities: () => ({ summary: { canSee: true } }),
    observe: jest.fn(async () => ({
      success: true,
      path: shotPath,
      elements: [],
      clickable: [],
      recognized: null,
    })),
    screenshot: jest.fn(async () => ({ success: true, path: shotPath })),
    activate: jest.fn(async () => ({ success: true })),
  };
}

function queuedGateway(responses, sink) {
  const queue = responses.slice();
  return {
    generate: jest.fn(async (opts) => {
      if (sink) {
        sink.push(typeof opts === 'string' ? opts : JSON.stringify(opts));
      }
      return queue.shift() || { content: '{"action":"finish","summary":"queue drained"}' };
    }),
  };
}

function cleanup(...paths) {
  for (const p of paths) {
    if (!p) {
      continue;
    }
    try {
      fs.rmSync(p, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
}

// ── 1. 跨应用暗记 ─────────────────────────────────────────────────────────

describe('跨应用暗记（remember scratchpad）', () => {
  test('写入后可读回，同 key 覆盖旧值（允许修正）', () => {
    const notes = [];
    expect(_internals._recordNote(notes, { key: '游览顺序', value: '1. 断桥 2. 白堤' }).success).toBe(
      true
    );
    expect(notes).toEqual([{ key: '游览顺序', value: '1. 断桥 2. 白堤' }]);

    expect(
      _internals._recordNote(notes, { key: '游览顺序', value: '1. 断桥 2. 白堤 3. 苏堤' }).success
    ).toBe(true);
    expect(notes).toHaveLength(1);
    expect(notes[0].value).toContain('苏堤');
  });

  test('key 或 value 为空时拒绝写入', () => {
    const notes = [];
    expect(_internals._recordNote(notes, { key: '', value: 'x' }).success).toBe(false);
    expect(_internals._recordNote(notes, { key: 'k', value: '   ' }).success).toBe(false);
    expect(_internals._recordNote(notes, {}).success).toBe(false);
    expect(notes).toHaveLength(0);
  });

  test('非字符串 value 序列化后写入', () => {
    const notes = [];
    expect(_internals._recordNote(notes, { key: 'k', value: ['a', 'b'] }).success).toBe(true);
    expect(notes[0].value).toBe('["a","b"]');
  });

  test('超出条数上限丢弃最旧一条', () => {
    const notes = [];
    for (let i = 0; i < 30; i++) {
      _internals._recordNote(notes, { key: 'k' + i, value: 'v' + i });
    }
    expect(notes.length).toBeLessThanOrEqual(24);
    expect(notes.some((n) => n.key === 'k29')).toBe(true);
    expect(notes.some((n) => n.key === 'k0')).toBe(false);
  });

  test('单条 value 超长被截断', () => {
    const notes = [];
    _internals._recordNote(notes, { key: 'k', value: 'x'.repeat(2000) });
    expect(notes[0].value.length).toBe(600);
  });

  test('_executeAction 处理 remember；缺 notes 上下文时 fail-soft 不抛', async () => {
    const notes = [];
    const ok = await _internals._executeAction(
      {},
      { action: 'remember', key: 'a', value: '1' },
      { notes }
    );
    expect(ok.success).toBe(true);
    expect(notes).toEqual([{ key: 'a', value: '1' }]);

    const missing = await _internals._executeAction(
      {},
      { action: 'remember', key: 'a', value: '1' },
      {}
    );
    expect(missing.success).toBe(false);
    expect(missing.error).toContain('notes');
  });

  test('暗记不进「任务进度」摘要（与「已记录的信息」段重复）', () => {
    const hist = [
      { action: 'remember', summary: 'remembered「景点」', success: true },
      { action: 'type', summary: 'typed "abc"', success: true },
    ];
    const s = _internals._summarizeProgress(hist);
    expect(s).toContain('typed');
    expect(s).not.toContain('remembered');
  });

  test('暗记原文注入决策提示词', () => {
    const prompt = _internals._buildDecisionPrompt({
      goal: '整理周末行程',
      history: [],
      lastElements: [],
      lastClickable: [],
      notes: [{ key: '游览顺序', value: '1. 断桥残雪\n2. 白堤\n3. 苏堤' }],
    });
    expect(prompt).toContain('已记录的信息');
    expect(prompt).toContain('游览顺序');
    expect(prompt).toContain('苏堤');
  });

  test('SYSTEM_PROMPT 文档化 remember 与跨应用铁律', () => {
    expect(SYSTEM_PROMPT).toContain('"action": "remember"');
    expect(SYSTEM_PROMPT).toContain('跨应用任务铁律');
  });

  test('remember 不消耗操作预算，且随结果返回', async () => {
    const shot = makeShot();
    const gateway = queuedGateway([
      { content: '{"action":"remember","key":"景点","value":"断桥/白堤/苏堤"}' },
      { content: '{"action":"remember","key":"格式","value":"游览顺序：\\n1.\\n2.\\n3."}' },
      { content: '{"action":"finish","summary":"ok"}' },
    ]);
    const actuations = [];
    const agent = new ComputerUseAgent({ gateway, controller: fakeController(shot.file) });
    const result = await agent.run('记两条', {
      onIteration: (s) => actuations.push(s.actuationCount),
    });

    expect(result.finished).toBe(true);
    expect(result.notes).toHaveLength(2);
    expect(result.notes[0]).toEqual({ key: '景点', value: '断桥/白堤/苏堤' });
    // 两次 remember 之后操作预算仍未被消耗
    expect(Math.max.apply(null, actuations)).toBe(0);

    cleanup(shot.dir, result.journalPath && path.dirname(result.journalPath));
  });
});

// ── 2. 执行计划每轮注入 ───────────────────────────────────────────────────

describe('执行计划每轮注入决策提示词', () => {
  test('state.plan 出现在提示词里并带推进指引', () => {
    const prompt = _internals._buildDecisionPrompt({
      goal: '整理周末行程',
      plan: '1. 浏览器搜攻略\n2. 备忘录记顺序\n3. 地图核对\n4. 日历建日程',
      history: [],
      lastElements: [],
      lastClickable: [],
    });
    expect(prompt).toContain('## 执行计划');
    expect(prompt).toContain('日历建日程');
    expect(prompt).toContain('已完成的步骤不要重做');
  });

  test('无 plan 时不注入计划段', () => {
    const prompt = _internals._buildDecisionPrompt({
      goal: 'x',
      history: [],
      lastElements: [],
      lastClickable: [],
    });
    expect(prompt).not.toContain('## 执行计划');
  });

  test('planFirst 生成的计划真正进入之后每一轮（回归：原先只写进轨迹日志）', async () => {
    const shot = makeShot();
    const prompts = [];
    const gateway = queuedGateway(
      [
        { content: '第1步 打开浏览器搜攻略；第2步 写备忘录；第3步 地图核对；第4步 建日历日程' },
        { content: '{"action":"remember","key":"景点","value":"断桥/白堤/苏堤"}' },
        { content: '{"action":"finish","summary":"完成"}' },
      ],
      prompts
    );
    const agent = new ComputerUseAgent({ gateway, controller: fakeController(shot.file) });
    const result = await agent.run('打开浏览器搜攻略，写进备忘录，再建日历日程', {
      planFirst: true,
    });

    expect(result.finished).toBe(true);
    // 第 1 次调用是生成计划；之后每一次决策调用都必须带上计划文本
    const decisionPrompts = prompts.slice(1);
    expect(decisionPrompts.length).toBeGreaterThanOrEqual(2);
    for (const p of decisionPrompts) {
      expect(p).toContain('执行计划');
      expect(p).toContain('建日历日程');
    }

    cleanup(shot.dir, result.journalPath && path.dirname(result.journalPath));
  });
});

// ── 3. 系统小应用识别 ─────────────────────────────────────────────────────

describe('应用识别：系统自带小应用进入跨应用清单', () => {
  const GOAL =
    '打开浏览器搜索「杭州 西湖 一日游 攻略」，把 3 个景点按顺序写进备忘录，' +
    '再用地图确认三者距离判断顺序是否合理，最后在日历里创建本周六的日程';

  test('四应用任务按出现顺序解析出完整清单', () => {
    const apps = appTarget.resolveTargetApps(GOAL).map((a) => a.name);
    expect(apps).toEqual(['Chrome', '备忘录', '地图', '日历']);
  });

  test('主应用取清单首个（浏览器）', () => {
    expect(appTarget.resolveTargetApp(GOAL).app).toBe('Chrome');
  });

  test('备忘录 / 日历 / 地图 的常见别名都能命中', () => {
    const pick = (t) => appTarget.resolveTargetApps(t).map((a) => a.name);
    expect(pick('打开便签写一条')).toContain('备忘录');
    expect(pick('open sticky notes')).toContain('备忘录');
    expect(pick('在日程表里加一条')).toContain('日历');
    expect(pick('add it to my calendar')).toContain('日历');
    expect(pick('用高德地图查一下')).toContain('地图');
    expect(pick('待办事项里加一条')).toContain('待办');
  });

  test('「设置」不被泛化误命中（设置提醒 ≠ 设置应用）', () => {
    expect(appTarget.resolveTargetApps('设置提醒时间')).toEqual([]);
    expect(appTarget.resolveTargetApps('打开系统设置').map((a) => a.name)).toContain('设置');
  });

  test('多应用清单会触发跨应用协作提示词段', () => {
    const prompt = _internals._buildDecisionPrompt({
      goal: GOAL,
      app: 'Chrome',
      targetApps: ['Chrome', '备忘录', '地图', '日历'],
      history: [],
      lastElements: [],
      lastClickable: [],
    });
    expect(prompt).toContain('跨应用协作（涉及 4 个应用）');
    expect(prompt).toContain('备忘录');
    expect(prompt).toContain('日历');
  });
});

// ── 4. 迭代预算随应用数放大 ───────────────────────────────────────────────

describe('guiEval 迭代预算', () => {
  const { RunEngine } = require('../../../src/services/guiEval/runEngine');
  const engine = new RunEngine();

  test('单应用任务保持 30 轮下限', () => {
    expect(engine._resolveIterationBudget({ environment: { apps: ['Chrome'] } })).toBe(30);
  });

  test('四应用任务放大到 60 轮以上（固定 30 轮不够走完四个应用）', () => {
    const budget = engine._resolveIterationBudget({
      environment: { apps: ['Chrome', '备忘录', '地图', '日历'] },
      checkpoints: [{}, {}, {}, {}],
    });
    expect(budget).toBeGreaterThanOrEqual(60);
    expect(budget).toBeLessThanOrEqual(100);
  });

  test('environment.maxIterations 显式覆盖', () => {
    expect(
      engine._resolveIterationBudget({ environment: { apps: ['a', 'b'], maxIterations: 12 } })
    ).toBe(12);
  });

  test('上限封顶 100，缺省环境不炸', () => {
    const many = Array.from({ length: 40 }, (_, i) => 'app' + i);
    expect(engine._resolveIterationBudget({ environment: { apps: many } })).toBe(100);
    expect(engine._resolveIterationBudget({})).toBe(30);
    expect(engine._resolveIterationBudget(null)).toBe(30);
  });
});
