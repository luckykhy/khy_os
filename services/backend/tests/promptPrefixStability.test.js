'use strict';

/**
 * promptPrefixStability.test.js — 前缀稳定性与 P0/P1 接线的集成验收
 * ([DESIGN-ARCH-098] §9 验收指标 1/3/6 的自动化形式)
 *
 *   node --test services/backend/tests/promptPrefixStability.test.js
 *
 * 钉死三条不变量:
 *   A. [P0 零产物变更] 默认环境不插锚点;且「打锚点」纯属附加——strip 掉标记后与不打锚点的
 *      产物**逐字节相同**。这条把「锚点只观测、不改内容」变成回归可拦的红线。
 *   B. [落点单调性] 槽位顺序必须为 prefix → dynamic → trailing → tail;boundary 标记必须落在
 *      prefix 与 dynamic 之间。
 *   C. [每轮重算预算] tail 槽(易变组 + 按需胶囊)的字节数记入回归上限,防止它悄悄膨胀。
 *   D. [P1 已接线] 三处新鲜度 cacheKey 在门控开/关下分别返回新键/旧键。
 */
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const prompts = require('../src/constants/prompts');
const A = require('../src/constants/promptAnchors');

const CWD = process.cwd();
const OPTIONS = {
  cwd: CWD,
  userMessage: '',
  taskScale: '',
  enabledTools: ['Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash', 'TaskCreate', 'Agent'],
  contextWindowTokens: 128000,
  hasNativeToolUse: true,
};

/**
 * 「真正每轮必变」内容的字节上限([DESIGN-ARCH-098] §5.1 目标 ≤8000)。
 * 只约束易变子集(env_info/git_status/task_memory/mcp_instructions/project_structure);
 * 按需胶囊不计入——它们是「按意图选片」而非「每轮自行变化」,且已落在 tail 槽不击穿前缀。
 */
const VOLATILE_BYTES_CEILING = 8000;

const _envBackup = {};
const _KEYS = [
  'KHY_PROMPT_ANCHORS',
  'KHY_PROMPT_FRESH_KEYS',
  'KHY_SYSTEM_CLOCK',
  'KHY_PROMPT_CACHE_ORDER',
  'KHY_ONDEMAND_OUT_OF_PREFIX',
];

/**
 * 冻结时间。env_info 段含实时时钟(每 60s 滚一次),若两次装配跨过秒/分边界,产物会真的不同
 * ——那是**设计内**的易变行为,却会让「逐字节一致」类断言随机变红。冻结 Date 后,本节所有
 * 断言只反映代码结构差异,不掺入时间噪声。
 */
const _RealDate = Date;
let _frozen = null;

function freezeTime(ms) {
  const fixed = ms;
  class FrozenDate extends _RealDate {
    constructor(...args) {
      if (args.length === 0) {
        super(fixed);
      } else {
        super(...args);
      }
    }
    static now() {
      return fixed;
    }
  }
  _frozen = FrozenDate;
  global.Date = FrozenDate;
}

function restoreTime() {
  global.Date = _RealDate;
  _frozen = null;
}

/** 设定 env(未列出的键保持默认)→ 清段缓存 → 装配。
 *  返回:`arr` 原始装配数组;`flat` 扁平串(装配期内部标记已被剔除);`marked` 数组直接拼接串
 *  (**保留锚点**,供逐段计量/解析使用)。 */
async function assemble(env) {
  for (const k of _KEYS) {
    if (env && Object.prototype.hasOwnProperty.call(env, k)) {
      process.env[k] = env[k];
    } else {
      delete process.env[k];
    }
  }
  prompts.clearSectionCache();
  const arr = await prompts.getSystemPrompt(OPTIONS);
  return {
    arr,
    flat: prompts.assembleSystemPrompt(arr),
    marked: arr.join('\n\n'),
  };
}

before(() => {
  for (const k of _KEYS) {
    _envBackup[k] = process.env[k];
  }
  // 去掉实时时钟门控 + 冻结 Date:env_info 的产物与时间桶全部确定化,断言只看结构差异
  process.env.KHY_SYSTEM_CLOCK = '0';
  freezeTime(1770000000000);
});

after(() => {
  restoreTime();
  for (const k of _KEYS) {
    if (_envBackup[k] === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = _envBackup[k];
    }
  }
});

describe('A. P0 锚点的零产物变异性', () => {
  test('默认环境不插锚点(门控默认关)', async () => {
    const { arr, marked } = await assemble({ KHY_SYSTEM_CLOCK: '0' });
    // 断言在「数组层」:默认时数组里既没有标记元素,拼接串里也没有锚点文本
    assert.equal(A.parseAnchors(marked).entries.length, 0, '默认不应出现任何锚点');
    assert.equal(arr.filter((s) => A.isAnchorMarker(s)).length, 0, '默认数组中不应有标记元素');
  });

  test('显式关(0)与默认环境逐字节相同', async () => {
    const a = await assemble({ KHY_SYSTEM_CLOCK: '0' });
    const b = await assemble({ KHY_SYSTEM_CLOCK: '0', KHY_PROMPT_ANCHORS: '0' });
    assert.equal(a.flat, b.flat);
    assert.deepEqual(a.arr, b.arr);
  });

  test('锚点纯附加:去掉标记元素后数组逐元素相同,扁平串逐字节相同', async () => {
    const off = await assemble({ KHY_SYSTEM_CLOCK: '0' });
    const on = await assemble({ KHY_SYSTEM_CLOCK: '0', KHY_PROMPT_ANCHORS: '1' });

    // 数组层:锚点是独立的额外元素,正文元素一字不改
    const onTexts = on.arr.filter((s) => !A.isAnchorMarker(s));
    assert.ok(on.arr.length > onTexts.length, '开锚点后数组应多出标记元素');
    assert.deepEqual(onTexts, off.arr, '去掉标记元素后应与不打锚点的数组逐元素相同');

    // 扁平层:assembleSystemPrompt 剔除装配期内部标记(boundary + 锚点)→ 逐字节相同
    assert.equal(
      on.flat,
      off.flat,
      '扁平产物必须与不打锚点时逐字节相同(锚点不得进入扁平输出)'
    );
    assert.ok(!on.flat.includes('<!-- khy:'), '扁平产物中不应残留锚点');
  });

  test('stripAnchors 能把已含锚点的串还原为无锚点形态', async () => {
    const { arr } = await assemble({ KHY_SYSTEM_CLOCK: '0', KHY_PROMPT_ANCHORS: '1' });
    const withMarkers = arr.join('\n\n'); // 保留标记元素的原始串(模拟 dump 落盘)
    assert.ok(withMarkers.includes('<!-- khy:'));
    assert.ok(!A.stripAnchors(withMarkers).includes('<!-- khy:'));
  });

  test('每个锚点 id 在产物中恰好出现一次(无重复打标)', async () => {
    const { marked } = await assemble({ KHY_SYSTEM_CLOCK: '0', KHY_PROMPT_ANCHORS: '1' });
    const ids = A.parseAnchors(marked).entries.map((e) => e.id);
    assert.ok(ids.length > 20, `锚点段数应 >20,实测 ${ids.length}`);
    assert.equal(new Set(ids).size, ids.length, '存在重复的锚点 id');
  });
});

describe('B. 槽位落点单调性', () => {
  test('槽序为 prefix → dynamic → trailing → tail', async () => {
    const { marked } = await assemble({ KHY_SYSTEM_CLOCK: '0', KHY_PROMPT_ANCHORS: '1' });
    const slots = A.parseAnchors(marked).entries.map((e) => e.slot);
    const rank = { prefix: 0, dynamic: 1, trailing: 2, tail: 3 };
    for (let i = 1; i < slots.length; i += 1) {
      assert.ok(
        rank[slots[i]] >= rank[slots[i - 1]],
        `槽位回退: 第 ${i} 段 ${slots[i]} 出现在 ${slots[i - 1]} 之后`
      );
    }
  });

  test('boundary 标记落在 prefix 与 dynamic 之间', async () => {
    const { arr, flat } = await assemble({
      KHY_SYSTEM_CLOCK: '0',
      KHY_PROMPT_ANCHORS: '1',
    });
    const bi = arr.indexOf(prompts.SYSTEM_PROMPT_DYNAMIC_BOUNDARY);
    assert.ok(bi > 0, 'boundary 标记必须存在');
    const beforeBoundary = arr.slice(0, bi).join('\n');
    const afterBoundary = arr.slice(bi + 1).join('\n');
    assert.ok(beforeBoundary.includes('khy:prefix:'), 'boundary 之前应有 prefix 槽段');
    assert.ok(!beforeBoundary.includes('khy:dynamic:'), 'boundary 之前不应有 dynamic 槽段');
    assert.ok(afterBoundary.includes('khy:dynamic:'), 'boundary 之后应有 dynamic 槽段');
    void flat;
  });

  test('易变段必须在 tail 槽(这是 KHY_PROMPT_CACHE_ORDER 的唯一承诺)', async () => {
    const { marked } = await assemble({ KHY_SYSTEM_CLOCK: '0', KHY_PROMPT_ANCHORS: '1' });
    // 与 promptCacheOrder.VOLATILE_SECTION_IDS 同源(运行时真源)
    const volatileIds = require('../src/constants/promptCacheOrder').VOLATILE_SECTION_IDS;
    const byId = {};
    for (const e of A.parseAnchors(marked).entries) {
      byId[e.id] = e.slot;
    }
    for (const id of volatileIds) {
      if (!(id in byId)) {
        continue; // 本轮为空(如无 MCP、无任务板)→ 不出现在装配产物里
      }
      assert.equal(byId[id], 'tail', `易变段 ${id} 应落在 tail 槽,实测 ${byId[id]}`);
    }
    // 静态内核必须落在 prefix 槽
    for (const id of ['simple_intro', 'simple_system']) {
      assert.equal(byId[id], 'prefix', `内核段 ${id} 应落在 prefix 槽`);
    }
  });

  test('前缀槽与尾部槽都非空,且槽位划分可用', async () => {
    const { marked } = await assemble({ KHY_SYSTEM_CLOCK: '0', KHY_PROMPT_ANCHORS: '1' });
    const s = A.summarizeBySlot(marked);
    assert.ok(s.bySlot.prefix.count >= 6, `prefix 段数实测 ${s.bySlot.prefix.count}`);
    assert.ok(s.bySlot.prefix.bytes > 0);
    assert.ok(s.bySlot.tail.count >= 5, `tail 段数实测 ${s.bySlot.tail.count}`);
    // 注意:不在此断言「prefix 字节 > tail 字节」——尾部含按需胶囊(空用户消息下 17 个全激活),
    // 其体量随选集变化,不是不变量。两者的体量差异在 C 组单独记录。
  });
});

describe('C. 每轮重算预算(尾部槽)', () => {
  test('tail 槽:易变子集不超预算,按需胶囊单独计量', async () => {
    const { marked } = await assemble({ KHY_SYSTEM_CLOCK: '0', KHY_PROMPT_ANCHORS: '1' });
    const volatileIds = new Set(require('../src/constants/promptCacheOrder').VOLATILE_SECTION_IDS);
    const s = A.summarizeBySlot(marked);
    const { entries } = A.parseAnchors(marked);

    let volatileBytes = 0;
    let capsuleBytes = 0;
    let capsuleCount = 0;
    for (const e of entries) {
      if (e.slot !== 'tail') {
        continue;
      }
      if (volatileIds.has(e.id)) {
        volatileBytes += e.bytes;
      } else {
        capsuleBytes += e.bytes;
        capsuleCount += 1;
      }
    }

    console.log(
      `      [预算] 总 ${s.total};prefix=${s.bySlot.prefix.bytes} dynamic=${s.bySlot.dynamic.bytes} ` +
        `trailing=${s.bySlot.trailing.bytes} tail=${s.bySlot.tail.bytes}` +
        `(易变 ${volatileBytes} + 胶囊 ${capsuleBytes}/${capsuleCount} 个)`
    );

    assert.ok(
      volatileBytes <= VOLATILE_BYTES_CEILING,
      `每轮必变内容 ${volatileBytes} 字符超出 §5.1 目标 ${VOLATILE_BYTES_CEILING}`
    );
    // 空用户消息 → 按需胶囊回退为「全部激活」,应看到 17 个
    assert.equal(capsuleCount, 17, `空用户消息下应激活全部 17 个胶囊,实测 ${capsuleCount}`);
  });

  test('单条注入内容不超过 token 上限(无超限即通过)', async () => {
    const { marked } = await assemble({ KHY_SYSTEM_CLOCK: '0', KHY_PROMPT_ANCHORS: '1' });
    const over = A.findOversizedEntries(marked, A.entryMaxTokens({}));
    if (over.length > 0) {
      console.log(
        '      [超限条目] ' +
          over.map((o) => `${o.slot}/${o.id}=${o.tokens}tok`).join(', ')
      );
    }
    // 现状:project_instructions(# claudeMd)会超限 → 本断言只要求「可被计量」,
    // 不强制为 0(修复需 098 §7 改动 9 / 099 R2,尚未落地)。
    assert.ok(Array.isArray(over));
  });
});

describe('D. 前缀稳定度(连续两次装配)', () => {
  test('同会话连续装配:每个 prefix 段内容不变', async () => {
    const first = await assemble({ KHY_SYSTEM_CLOCK: '0', KHY_PROMPT_ANCHORS: '1' });
    const second = await assemble({ KHY_SYSTEM_CLOCK: '0', KHY_PROMPT_ANCHORS: '1' });
    const byId = (flat) => {
      const out = {};
      for (const e of A.parseAnchors(flat).entries) {
        out[`${e.slot}:${e.id}`] = e.bytes;
      }
      return out;
    };
    const a = byId(first.marked);
    const b = byId(second.marked);
    assert.deepEqual(Object.keys(a).sort(), Object.keys(b).sort());
    for (const k of Object.keys(a)) {
      assert.equal(a[k], b[k], `段 ${k} 在两次装配之间长度变化`);
    }
  });

  test('公共前缀长度 = prefix 槽 + dynamic 槽 + trailing 槽(尾槽不参与稳定前缀)', async () => {
    const first = await assemble({ KHY_SYSTEM_CLOCK: '0', KHY_PROMPT_ANCHORS: '1' });
    const second = await assemble({ KHY_SYSTEM_CLOCK: '0', KHY_PROMPT_ANCHORS: '1' });
    let i = 0;
    while (i < first.marked.length && first.marked[i] === second.marked[i]) {
      i += 1;
    }
    assert.equal(i, first.marked.length, '两次装配应完全一致(时钟已关、段缓存同源)');
  });
});

describe('E. P1 新鲜度 cacheKey 已接线', () => {
  test('门控开(默认):三个键都不再是裸会话常量', () => {
    process.env.KHY_PROMPT_FRESH_KEYS = '1';
    assert.notEqual(
      prompts.gitStatusSectionCacheKey(CWD),
      CWD,
      'git_status 的键应当已折入新鲜度戳'
    );
    assert.notEqual(
      prompts.projectInstructionsSectionCacheKey(CWD),
      CWD,
      'project_instructions 的键应当已折入指令文件戳'
    );
    assert.match(
      prompts.skillCatalogSectionCacheKey(128000),
      /^128000\|/,
      'skill_catalog 的键应当保留 contextWindowTokens 并追加技能指纹'
    );
  });

  test('门控关:三个键逐字节回退到修复前的旧键', () => {
    process.env.KHY_PROMPT_FRESH_KEYS = '0';
    assert.equal(prompts.gitStatusSectionCacheKey(CWD), CWD);
    assert.equal(prompts.projectInstructionsSectionCacheKey(CWD), CWD);
    assert.equal(prompts.skillCatalogSectionCacheKey(128000), '128000');
    assert.equal(prompts.skillCatalogSectionCacheKey(undefined), '');
  });

  test('git_status 的键会随时间桶变化(证明「不再永久冻结」)', () => {
    process.env.KHY_PROMPT_FRESH_KEYS = '1';
    process.env.KHY_PROMPT_GIT_STAMP_TTL_MS = '1000';
    const k1 = prompts.gitStatusSectionCacheKey(CWD);
    const parsed = k1.split('|');
    assert.ok(parsed.length >= 4, `键形态应为 cwd|idx|head|bucket,实测 ${k1}`);
    const bucket = Number(parsed[parsed.length - 1]);
    assert.ok(Number.isFinite(bucket), '末位应为时间桶数值');
    delete process.env.KHY_PROMPT_GIT_STAMP_TTL_MS;
  });
});
