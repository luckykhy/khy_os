'use strict';

/**
 * structuredFurnace.test.js — 「万物结构化熔炉引擎」验收测试（DESIGN-ARCH-036）。
 *
 * 全程零网络、零模型：熔炉是纯词法坍缩器，输入自然语言、输出封印结构化意图。
 * 覆盖 /goal 五大交付物与全部防呆铁律：
 *   §3.1 绝对前置拦截 —— assertForged 拒绝裸 payload / 篡改；intercept 是唯一入口。
 *   §3.2 三级坍缩    —— 熵路由 L0/L1/L2，分别产出 ActionIntent / TaskGraph(DAG) / StateMachine。
 *   §3.3 晶格规范    —— 原子性 / 无歧义性(confidence 量化) / 可索引性(实体带 UID + 指针去重)。
 *   §3.4 拒损与降级  —— 多重矛盾/死锁/缺要素 → 拒损抛 FurnaceRejection；低置信/单矛盾 → 降级锁写。
 *   §5  防呆        —— ①依赖必成 DAG非扁平 ②时序/因果必有向边 ③禁定语从句 ④矛盾不脑补 ⑤实体必带 UID。
 *   §4.4 场景验证表  —— 三段高熵输入在传统 vs 熔炉模式下的可管理性对比断言。
 */

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const furnace = require('../../../src/services/structuredFurnace');
const { EntityRegistry } = require('../../../src/services/structuredFurnace/entityRegistry');
const { TaskGraph } = require('../../../src/services/structuredFurnace/taskGraph');
const forgeSchema = require('../../../src/services/structuredFurnace/forgeSchema');
const S = require('../../../src/services/metaplan/constraintStrategy');

describe('§3.1 绝对前置拦截 + 封印守卫', () => {
  test('intercept 产出封印信封，assertForged 放行', () => {
    const env = furnace.intercept('请帮我创建一个 config.json 文件');
    assert.equal(env.sealed, true);
    assert.equal(env.kind, 'ActionIntent');
    assert.doesNotThrow(() => furnace.assertForged(env));
  });

  test('裸 payload（未经熔炉）被 assertForged 拒绝（致命架构违规守卫）', () => {
    assert.throws(() => furnace.assertForged({ kind: 'ActionIntent', payload: {} }), /前置拦截/);
  });

  test('篡改 payload 后封印校验失败', () => {
    const env = furnace.intercept('删除 build 目录');
    const tampered = { ...env, payload: { ...env.payload, action: 'CREATE' } };
    assert.throws(() => furnace.assertForged(tampered), /篡改|校验失败/);
    assert.equal(furnace.isForged(tampered), false);
  });

  test('空输入拒损（缺要素枚举含 raw）', () => {
    try {
      furnace.intercept('   ');
      assert.fail('应抛 FurnaceRejection');
    } catch (e) {
      assert.ok(e instanceof furnace.FurnaceRejection);
      assert.equal(e.kind, 'MISSING_ELEMENTS');
      assert.deepEqual(e.missing, ['raw']);
    }
  });
});

describe('§3.2 L0 降维打击 → ActionIntent', () => {
  test('简单单任务剥语气词、映射标准动作原语', () => {
    const env = furnace.intercept('请帮我创建一个 config.json 文件');
    assert.equal(env.level, 'L0');
    assert.equal(env.payload.action, 'CREATE');
    assert.ok(forgeSchema.ACTION_PRIMITIVES.includes(env.payload.action));
  });

  test('高风险动作（DELETE）锁级升至 Code_Hard', () => {
    const env = furnace.intercept('删除 build 目录');
    assert.equal(env.payload.action, 'DELETE');
    assert.equal(env.payload.strategy, S.STRATEGIES.CODE_HARD);
  });

  test('未知动词映射为 UNKNOWN（不脑补动作，防呆④）', () => {
    const env = furnace.intercept('x');
    assert.equal(env.payload.action, 'UNKNOWN');
  });
});

describe('§3.2 L1 意图织网 → TaskGraph（DAG）', () => {
  test('因果/条件复合句织成带条件边的图（防呆②：依赖必有向边）', () => {
    const env = furnace.intercept('如果测试通过就部署到生产，否则通知我');
    assert.equal(env.level, 'L1');
    assert.equal(env.kind, 'TaskGraph');
    assert.ok(env.payload.graph.nodes.length >= 2);
    assert.ok(env.payload.graph.edges.length >= 1, '含依赖必须非空边，禁止扁平列表');
    assert.ok(env.payload.graph.edges.some((e) => e.type === 'cond'));
  });

  test('顺序复合句织成 seq 边链', () => {
    const env = furnace.intercept('先构建项目，然后运行测试，接着部署');
    assert.equal(env.payload.graph.nodes.length, 3);
    assert.equal(env.payload.graph.edges.length, 2);
    assert.ok(env.payload.graph.edges.every((e) => e.type === 'seq'));
  });

  test('防呆②：含依赖却退化为零边的图被 schema 拒收', () => {
    const bad = {
      kind: 'TaskGraph', uid: 'tg_x',
      graph: { nodes: [{ uid: 'n1', action: 'BUILD', params: {} }], edges: [] },
      entities: {}, strategy: S.STRATEGIES.PROMPT_SOFT,
    };
    const r = forgeSchema.validateTaskGraph(bad, { hadDependency: true });
    assert.equal(r.valid, false);
    assert.deepEqual(r.missing, ['edges']);
  });
});

describe('§3.2 L2 骨相重构 → StateMachine', () => {
  test('混乱长文切片重构为状态机', () => {
    const env = furnace.intercept('这个需求有点乱我也不确定到底要干嘛，可能需要部署但是先别部署，你看着办吧反正大概就这样');
    assert.equal(env.level, 'L2');
    assert.equal(env.kind, 'StateMachine');
    assert.ok(env.payload.machine.states.length >= 1);
    assert.ok(env.payload.machine.initial);
  });
});

describe('§3.3 晶格铸造规范', () => {
  test('无歧义性：模糊词被量化为 confidence 而非保留原文', () => {
    const { clean, confidence, hadVague } = forgeSchema.coerceVagueness('可能需要部署');
    assert.equal(hadVague, true);
    assert.equal(confidence, 0.6);
    assert.ok(!forgeSchema.VAGUE_RE.test(clean), '清洗后不得残留模糊词');
  });

  test('原子性：含连接词的值非原子（应拆边）', () => {
    assert.equal(forgeSchema.isAtomic('构建并且部署'), false);
    assert.equal(forgeSchema.isAtomic('build'), true);
  });

  test('防呆③：定语从句被识别并拒收', () => {
    assert.equal(forgeSchema.hasRelativeClause('那个昨天刚刚创建的非常重要的文件'), true);
    const bad = {
      kind: 'ActionIntent', uid: 'ai_x', action: 'READ',
      target: { uid: 'file_1' }, params: { note: '那个昨天刚刚创建的非常重要的文件' },
      confidence: 1, strategy: S.STRATEGIES.PROMPT_SOFT,
      entities: { file_1: { uid: 'file_1', type: 'file', canonical: 'a.txt' } },
    };
    const r = forgeSchema.validateActionIntent(bad);
    assert.equal(r.valid, false);
    assert.match(r.error, /定语从句/);
  });

  test('可索引性（防呆⑤）：核心实体带全局 UID，重复指代去重为单节点', () => {
    const reg = new EntityRegistry();
    const u1 = reg.mint('file', '那个 a.js');
    const u2 = reg.mint('file', 'a.js');
    assert.equal(u1, u2, '同一实体归一后应复用同一 UID');
    assert.equal(reg.list().length, 1);
    assert.ok(u1.startsWith('file_'));
    assert.equal(reg.deduplicatedCount(), 1);
  });

  test('target 悬空指针（未登记于 entities）被拒收', () => {
    const bad = {
      kind: 'ActionIntent', uid: 'ai_x', action: 'READ',
      target: { uid: 'file_ghost' }, params: {}, confidence: 1,
      strategy: S.STRATEGIES.PROMPT_SOFT, entities: {},
    };
    assert.equal(forgeSchema.validateActionIntent(bad).valid, false);
  });
});

describe('§3.4 拒损与降级机制', () => {
  test('死锁（成环 DAG）→ 拒损 DEADLOCK_CYCLE（防呆④不脑补调和）', () => {
    const g = new TaskGraph();
    g.addNode({ uid: 'a', action: 'BUILD' });
    g.addNode({ uid: 'b', action: 'TEST' });
    g.addEdge('a', 'b', 'seq');
    g.addEdge('b', 'a', 'seq'); // 环
    const cycle = g.findCycle();
    assert.ok(cycle && cycle.length > 0);
    assert.throws(
      () => furnace.adjudicate({ payload: { kind: 'TaskGraph', confidence: 1 }, cycle }),
      (e) => e instanceof furnace.FurnaceRejection && e.kind === 'DEADLOCK_CYCLE',
    );
  });

  test('多重矛盾 → 拒损 CONTRADICTION', () => {
    try {
      furnace.intercept('先创建 a.txt。然后又不要创建 a.txt 了。算了改主意。还是分析一下日志吧。');
      assert.fail('应拒损');
    } catch (e) {
      assert.ok(e instanceof furnace.FurnaceRejection);
      assert.equal(e.kind, 'CONTRADICTION');
      assert.ok(e.conflicts.length >= 2);
    }
  });

  test('低置信/单矛盾 → 降级沙箱并锁写（不阻断）', () => {
    const env = furnace.intercept('这个需求有点乱我也不确定到底要干嘛，可能需要部署但是先别部署，你看着办吧反正大概就这样');
    assert.equal(env.verdict, 'DEGRADE');
    assert.equal(env.degraded, true);
    assert.equal(env.writeLocked, true);
    assert.equal(S.atLeast(env.strategy, S.STRATEGIES.CODE_HARD), true, '降级锁级至少 Code_Hard');
  });

  test('缺要素校验失败 → 拒损 MISSING_ELEMENTS 带枚举', () => {
    const validation = forgeSchema.validateActionIntent({ kind: 'ActionIntent' });
    assert.equal(validation.valid, false);
    assert.throws(
      () => furnace.adjudicate({ payload: { kind: 'ActionIntent' }, validation }),
      (e) => e instanceof furnace.FurnaceRejection && e.kind === 'MISSING_ELEMENTS' && e.missing.length > 0,
    );
  });
});

describe('§5 防呆铁律汇总', () => {
  test('防呆①：依赖输入产出 DAG 结构（nodes+edges）而非扁平列表', () => {
    const env = furnace.intercept('先构建，然后测试');
    assert.ok(Array.isArray(env.payload.graph.nodes));
    assert.ok(Array.isArray(env.payload.graph.edges));
    assert.ok(env.payload.graph.edges.length > 0);
  });

  test('防呆⑤：每个被铸造实体携带全局 UID', () => {
    const env = furnace.intercept('创建 config.json 文件');
    const ents = Object.values(env.entities);
    assert.ok(ents.length >= 1);
    assert.ok(ents.every((e) => typeof e.uid === 'string' && e.uid.length > 0));
  });
});

describe('§4.4 场景验证表（高熵输入：传统 vs 熔炉模式）', () => {
  // 传统模式：原始 NL 字符串原样进业务逻辑——不可索引、无结构、歧义保留。
  // 熔炉模式：坍缩为可管理结构——节点/状态可枚举、实体可指针化、不确定性被量化。
  const cases = [
    { label: '高熵-条件分支', raw: '如果构建成功就部署，否则回滚并通知运维', expectKinds: ['TaskGraph'] },
    { label: '高熵-顺序流水', raw: '先拉取代码，然后构建，接着测试，最后部署', expectKinds: ['TaskGraph'] },
    { label: '高熵-混乱反悔', raw: '这个需求挺乱的我也不太确定，可能要部署但又先别，你看着办大概就这样吧', expectKinds: ['TaskGraph', 'StateMachine'] },
  ];

  for (const c of cases) {
    test(`[${c.label}] 熔炉模式可管理性优于传统模式`, () => {
      let env;
      try {
        env = furnace.intercept(c.raw);
      } catch (e) {
        // 拒损也是“可管理”的确定性结果（带枚举），优于传统模式静默吞歧义。
        assert.ok(e instanceof furnace.FurnaceRejection);
        assert.ok(e.kind && (e.missing.length + e.conflicts.length) > 0);
        return;
      }
      assert.ok(c.expectKinds.includes(env.kind), `${env.kind} 应属 ${c.expectKinds}`);
      // 可管理性断言：传统模式只有一坨字符串(0 可枚举单元)；熔炉模式可枚举节点/状态。
      const units = env.kind === 'TaskGraph'
        ? env.payload.graph.nodes.length
        : env.payload.machine.states.length;
      assert.ok(units >= 1, '熔炉模式产出 >=1 可枚举执行单元');
      // 不确定性被显式量化（confidence 数值），而非自然语言里的“可能/大概”。
      assert.equal(typeof env.payload.confidence, 'number');
    });
  }
});
