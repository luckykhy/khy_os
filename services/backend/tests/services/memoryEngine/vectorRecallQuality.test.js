'use strict';

/**
 * 记忆 RAG 的检索质量（node:test）—— 目标陈述的验收项：
 * 「构造 20 条记忆 + 5 个查询的固定用例，Top-3 命中率达标」。
 *
 * ## 这个测试证明什么、不证明什么
 *
 * **不证明** nomic-embed-text 的语义质量 —— CI 里没有 Ollama，也不该有。真实模型的
 * 效果要靠手动层（见文末 TODO 提到的 memory:eval）去量。
 *
 * **证明**的是改造真正修掉的那个缺陷：向量召回从「对词法命中的 5 条做后置重排」
 * 变成了「对全量记忆做召回、再与词法池取并集」。判据是每个用例都**先自证词法不可达**：
 *
 *   1. `enableVector:false` 下，目标记忆**不在** Top-3（甚至根本不在词法池里）
 *   2. `enableVector:true`  下，目标记忆**进入** Top-3
 *
 * 第 1 条是关键。少了它，这个测试就可能靠词法重叠假绿 —— 那样即使把向量层整个删掉，
 * 测试照样通过。有了它，每个用例都是一次真实的「改述查询召回」。
 *
 * ## stub embedding 是怎么做的
 *
 * 起一个真实的本地 HTTP 服务，实现 openai 兼容的 `/v1/embeddings`，向量 = 文本在
 * 若干**概念轴**上的命中计数。轴的两半词表刻意不相交（`mem` 侧只出现在记忆里、
 * `qry` 侧只出现在查询里），于是它模拟的正是「一个认得近义词的 embedding 模型」。
 *
 * 不 mock `embeddingClient`：mock 掉它就只能证明「我的 mock 返回了向量」，
 * 证明不了端点解析、批量切分、侧车缓存、余弦计算这一整条真实链路。
 *
 * fixture 的正确性本身也被机械校验（见「fixture 自校验」一测）：15 条干扰记忆必须
 * 在所有概念轴上命中为零。手写语料最容易犯的错就是干扰项里不小心漏进一个轴词，
 * 那会造出一个强假阳性，还让上面的命中率看起来更好。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');

const paths = require('../../../src/memdir/paths');
const memdir = require('../../../src/memdir/memdir');
const scoring = require('../../../src/services/memoryEngine/scoring');
const vectorStore = require('../../../src/services/memoryEngine/vectorStore');
const embeddingClient = require('../../../src/services/embeddingClient');

const NOW = Date.UTC(2026, 7, 16, 12, 0, 0);

// ── 概念轴：mem 侧词表只出现在记忆里，qry 侧只出现在查询里，两半不相交 ────────
const AXES = Object.freeze([
  {
    id: 'port-bind',
    mem: ['监听', '反向代理', 'proxy_host', 'proxy_port'],
    qry: ['upstream', '端口', '绑定', '什么位置'],
  },
  {
    id: 'retry',
    mem: ['重试', '退避', 'retrywithbackoff', '失败'],
    qry: ['接口', '挂掉', '多跑两遍'],
  },
  {
    id: 'wheel',
    mem: ['wheel', 'pip', '纯净度', '审计', '夹带'],
    qry: ['python', '打包产物', '发布', '校验脚本'],
  },
  {
    id: 'render',
    mem: ['滚动区', '终端渲染', 'ansi', '追加'],
    qry: ['命令行', '刷屏', '抖动', '消除'],
  },
  {
    id: 'privacy',
    mem: ['用量', '计数', '本地文件', '不上报'],
    qry: ['统计信息', '云端', '传出去', '外传'],
  },
]);

const ALL_AXIS_TERMS = AXES.flatMap((a) => [...a.mem, ...a.qry]);

/** 一个文本在各概念轴上的命中计数 = 它的向量。全无命中 ⇒ 零向量 ⇒ 余弦恒为 0。 */
function embedOf(text) {
  const s = String(text).toLowerCase();
  return AXES.map((ax) => {
    let n = 0;
    for (const term of [...ax.mem, ...ax.qry]) {
      let from = 0;
      for (;;) {
        const at = s.indexOf(term, from);
        if (at < 0) {
          break;
        }
        n++;
        from = at + term.length;
      }
    }
    return n;
  });
}

/** 拿一个必然连不上的本地端口（用来堵住 Ollama / 网关端点，避免测试悄悄打到真机）。 */
function deadPort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

const ENV_KEYS = [
  'KHY_MEMORY_DIR',
  'KHY_MEMORY_MERGE_LEGACY',
  'KHY_MEMORY_VECTOR_RECALL',
  'KHY_MEMORY_VECTOR_HITS',
  'KHY_MEMORY_VECTOR_FLOOR',
  'KHY_MEMORY_VECTOR_WEIGHT',
  'KHY_MEMORY_EMBED_MODEL',
  'KHY_LEARN_EMBED_MODEL',
  'KHY_LEARN_EMBED_URL',
  'KHY_LEARN_EMBED_MAX_TEXTS',
  'OLLAMA_HOST',
  'KHY_GATEWAY_URL',
  'PROXY_AUTH_TOKEN',
];

/**
 * 临时记忆目录 + 真实的 stub embedding 服务。
 *
 * @param {(ctx:{tmp:string, calls:Array<string[]>}) => Promise<any>} fn
 *        ctx.calls 记录每次 embedding 请求收到的文本数组（用于断言缓存复用）。
 */
async function withStub(fn) {
  const saved = {};
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
  }
  const calls = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (d) => chunks.push(d));
    req.on('end', () => {
      let input = [];
      try {
        const j = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
        input = Array.isArray(j.input) ? j.input : [];
      } catch {
        input = [];
      }
      calls.push(input.map(String));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          data: input.map((t, index) => ({ index, embedding: embedOf(t) })),
        })
      );
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const blocked = `http://127.0.0.1:${await deadPort()}`;

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-ragq-'));
  process.env.KHY_MEMORY_DIR = tmp;
  process.env.KHY_MEMORY_MERGE_LEGACY = 'off';
  delete process.env.KHY_MEMORY_VECTOR_RECALL; // 默认开
  delete process.env.KHY_MEMORY_VECTOR_HITS;
  delete process.env.KHY_MEMORY_VECTOR_FLOOR; // 用出厂默认值测出厂行为
  delete process.env.KHY_MEMORY_VECTOR_WEIGHT;
  delete process.env.KHY_LEARN_EMBED_MAX_TEXTS;
  process.env.KHY_MEMORY_EMBED_MODEL = 'stub-embed-model';
  process.env.KHY_LEARN_EMBED_URL = `http://127.0.0.1:${port}/v1/embeddings`;
  process.env.OLLAMA_HOST = blocked; // 堵死：绝不打到开发机上真跑着的 Ollama
  process.env.KHY_GATEWAY_URL = blocked;
  process.env.PROXY_AUTH_TOKEN = 'not-used'; // 免去读 proxy_server_auth.json
  paths._resetCache();
  embeddingClient._resetCache();

  try {
    return await fn({ tmp, calls });
  } finally {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = saved[k];
      }
    }
    paths._resetCache();
    embeddingClient._resetCache();
    await new Promise((resolve) => server.close(resolve));
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

// ── 固定语料：5 条目标 + 15 条干扰 = 20 条 ───────────────────────────────────
// 干扰项刻意堆叠查询里的高频汉字与二元组（什么/怎么/哪个/几/在/行/除/次…），
// 这样目标记忆在纯词法排序里会被它们压到 Top-3 之外 —— 这正是要复现的缺陷现场。

const TARGETS = Object.freeze([
  {
    file: 't1-proxy-listen.md',
    type: 'project',
    name: 'proxy listen address',
    description: '反向代理监听地址',
    body: 'PROXY_HOST 与 PROXY_PORT 共同决定服务监听在哪里。',
  },
  {
    file: 't2-retry-ladder.md',
    type: 'project',
    name: 'failover ladder',
    description: '请求失败后的重试阶梯',
    body: 'retryWithBackoff 按指数退避逐级升档，用尽后走兜底通道。',
  },
  {
    file: 't3-wheel-purity.md',
    type: 'project',
    name: 'artifact purity audit',
    description: 'wheel 构建后的纯净度审计',
    body: 'audit_pip_artifacts 确认 wheel 未夹带源码与凭据。',
  },
  {
    file: 't4-no-scroll-region.md',
    type: 'feedback',
    name: 'no scroll region',
    description: '终端渲染禁用滚动区',
    body: '强制规则 4：输出一律追加，不得用 ANSI 滚动区做原地覆写。',
  },
  {
    file: 't5-usage-local.md',
    type: 'project',
    name: 'usage stays local',
    description: '用量数据只留本机',
    body: '计数结果只写本地文件，不上报任何远端服务。',
  },
]);

const DECOYS = Object.freeze([
  {
    file: 'd01-ask-or-decide.md',
    type: 'user',
    name: 'ask or decide',
    description: '什么时候该问用户',
    body: '拿不准怎么办：什么情况下停下来问，什么情况下自己拍板；在哪个环节问都要先说清楚。',
  },
  {
    file: 'd02-no-guessing.md',
    type: 'feedback',
    name: 'no guessing',
    description: '不要凭猜测下结论',
    body: '拿不准就说不准，不会的事情不要装作会；不确定的时候先去核对。',
  },
  {
    file: 'd03-doc-layout.md',
    type: 'project',
    name: 'docs layout',
    description: '文档目录怎么排',
    body: 'docs 目录按编号分册，哪个编号对应哪个主题，在索引里能查到。',
  },
  {
    file: 'd04-cli-help.md',
    type: 'reference',
    name: 'cli help',
    description: '帮助信息在哪里看',
    body: 'khy help 会列出全部子命令；界面上每一行都能点开看细节。',
  },
  {
    file: 'd05-report-honestly.md',
    type: 'feedback',
    name: 'report honestly',
    description: '进度要诚实说',
    body: '做到哪一步就说到哪一步，跑不通就说跑不通，不要含糊过去。',
  },
  {
    file: 'd06-short-answers.md',
    type: 'user',
    name: 'short answers',
    description: '喜欢简短的回答',
    body: '回答尽量短，几句话说完；要长篇的时候会明确提出来。',
  },
  {
    file: 'd07-env-switches.md',
    type: 'project',
    name: 'env switches',
    description: '开关都走环境变量',
    body: '每个新增行为都要能一键关回原样；哪个开关管哪个行为，在 .env.example 里都标了。',
  },
  {
    file: 'd08-issue-tracker.md',
    type: 'reference',
    name: 'issue tracker',
    description: '问题单在哪里提',
    body: '缺陷与需求都提到同一个看板上，会有人分派。',
  },
  {
    file: 'd09-no-silent-cap.md',
    type: 'feedback',
    name: 'no silent cap',
    description: '不要静默截断',
    body: '只取前几条的时候必须说清楚丢了什么，不能让人以为覆盖全了。',
  },
  {
    file: 'd10-single-source.md',
    type: 'project',
    name: 'single source of truth',
    description: '同一个事实只写一处',
    body: '模型名与主机地址都只在一处定义，别处引用；改一处全都跟着变。',
  },
  {
    file: 'd11-prefers-cn.md',
    type: 'user',
    name: 'prefers chinese',
    description: '偏好中文交流',
    body: '回复用中文，代码里的标识符保持英文。',
  },
  {
    file: 'd12-changelog.md',
    type: 'reference',
    name: 'changelog location',
    description: '变更记录写在哪',
    body: '每次改动都在变更记录里留一行，写清为什么改。',
  },
  {
    file: 'd13-confirm-destructive.md',
    type: 'feedback',
    name: 'confirm destructive',
    description: '破坏性操作先确认',
    body: '删除与覆盖之前先看清目标，问过再动手。',
  },
  {
    file: 'd14-line-budget.md',
    type: 'project',
    name: 'line budget',
    description: '单文件不超两千五百行',
    body: '超了就拆，拆的时候把边界说清楚，不要为了行数硬拆。',
  },
  {
    file: 'd15-model-ids.md',
    type: 'reference',
    name: 'model ids',
    description: '模型标识去哪里查',
    body: '全部模型标识在 constants 里，不要在别处写字面量。',
  },
]);

/** 5 个改述查询：用词与目标记忆刻意不相交，只在概念上对齐。 */
const CASES = Object.freeze([
  { query: 'upstream 端口绑定在什么位置', target: 't1-proxy-listen.md' },
  { query: '接口挂掉时能不能多跑两遍', target: 't2-retry-ladder.md' },
  { query: 'python 打包产物发布前跑哪个校验脚本', target: 't3-wheel-purity.md' },
  { query: '命令行界面刷屏抖动怎么消除', target: 't4-no-scroll-region.md' },
  { query: '统计信息会不会被传出去到云端', target: 't5-usage-local.md' },
]);

function seedCorpus() {
  for (const m of [...TARGETS, ...DECOYS]) {
    memdir.saveMemory(m.type, m.name, m.body, {
      description: m.description,
      filename: m.file,
      updated: new Date(NOW).toISOString(),
    });
  }
}

// ── fixture 自校验 ──────────────────────────────────────────────────────────

test('fixture 自校验：20 条记忆、5 个查询，且干扰项在所有概念轴上命中为零', () => {
  assert.strictEqual(TARGETS.length + DECOYS.length, 20, '语料恰好 20 条');
  assert.strictEqual(CASES.length, 5, '查询恰好 5 个');
  assert.strictEqual(new Set([...TARGETS, ...DECOYS].map((m) => m.file)).size, 20, '文件名无重复');

  for (const d of DECOYS) {
    const text = `${d.name} ${d.description} ${d.body}`;
    const v = embedOf(text);
    const hit = AXES.map((ax, i) => (v[i] > 0 ? ax.id : null)).filter(Boolean);
    assert.deepStrictEqual(hit, [], `干扰项 ${d.file} 不该命中任何概念轴（命中: ${hit.join(',')}）`);
  }

  // 每条目标只命中它自己那一根轴（否则语义信号会互相串台）。
  TARGETS.forEach((t, idx) => {
    const v = embedOf(`${t.name} ${t.description} ${t.body}`);
    const hit = v.map((n, i) => (n > 0 ? i : -1)).filter((i) => i >= 0);
    assert.deepStrictEqual(hit, [idx], `${t.file} 应只命中轴 ${AXES[idx].id}`);
  });

  // 每个查询也只命中它自己那一根轴。
  CASES.forEach((c, idx) => {
    const v = embedOf(c.query);
    const hit = v.map((n, i) => (n > 0 ? i : -1)).filter((i) => i >= 0);
    assert.deepStrictEqual(hit, [idx], `查询「${c.query}」应只命中轴 ${AXES[idx].id}`);
    assert.strictEqual(TARGETS[idx].file, c.target, '用例与目标一一对应');
  });
});

test('stub 服务返回的是 openai 兼容形状，embeddingClient 能直接吃下', async () => {
  await withStub(async ({ calls }) => {
    const vecs = await embeddingClient.embedTexts(['监听 反向代理', '完全无关的一句话']);
    assert.ok(Array.isArray(vecs) && vecs.length === 2, '两条文本两个向量');
    assert.strictEqual(vecs[0].length, AXES.length);
    assert.ok(vecs[0][0] > 0, '命中轴的分量为正');
    assert.deepStrictEqual(vecs[1], [0, 0, 0, 0, 0], '无命中 ⇒ 零向量');
    assert.strictEqual(embeddingClient.cosine(vecs[0], vecs[1]), 0, '零向量的余弦为 0，不是 NaN');
    assert.strictEqual(calls.length, 1, '一次批量请求');
  });
});

// ── 检索质量主用例 ─────────────────────────────────────────────────────────

test('20 条记忆 / 5 个改述查询：Top-3 命中率达标，且每个用例都自证词法不可达', async () => {
  await withStub(async () => {
    seedCorpus();

    const rows = [];
    for (const c of CASES) {
      // 先跑纯词法（关掉向量），确认这个用例在改造前确实召不回。
      const lex = await scoring.rankMemories(c.query, {
        limit: 3,
        nowMs: NOW,
        enableVector: false,
      });
      const lexTop3 = lex.map((m) => m.filename);

      const hyb = await scoring.rankMemories(c.query, {
        limit: 3,
        nowMs: NOW,
        enableVector: true,
      });
      const hybTop3 = hyb.map((m) => m.filename);

      rows.push({
        query: c.query,
        target: c.target,
        lexHard: !lexTop3.includes(c.target),
        lexPool: lex.length,
        hit: hybTop3.includes(c.target),
        rank: hybTop3.indexOf(c.target) + 1,
        hybTop3,
      });
    }

    const hits = rows.filter((r) => r.hit).length;
    const hard = rows.filter((r) => r.lexHard).length;

    const report = rows
      .map(
        (r) =>
          `  ${r.hit ? '✔' : '✘'} 「${r.query}」→ ${r.target}` +
          ` | 词法不可达=${r.lexHard} | 混合排名=${r.rank || '未召回'}` +
          ` | Top3=${r.hybTop3.join(', ')}`
      )
      .join('\n');

    assert.strictEqual(
      hard,
      5,
      `全部 5 个用例都必须词法不可达，否则测试可能靠词法重叠假绿：\n${report}`
    );
    assert.ok(hits >= 4, `Top-3 命中率 ${hits}/5，未达标（要求 ≥4/5）：\n${report}`);

    // 达标线是 4/5；但既然 stub 的语义信号是确定性的，就把实际结果也钉住 ——
    // 命中率从 5/5 掉到 4/5 仍算"达标"，那种静默退步不该没人看见。
    assert.strictEqual(hits, 5, `当前实现应 5/5 全中；掉到 ${hits}/5 说明有回归：\n${report}`);
  });
});

test('纯语义候选真的是"从词法池外"被捞进来的（并集，而非后置重排）', async () => {
  await withStub(async () => {
    seedCorpus();
    // t3 的用词与它的查询零重叠 —— 它连词法池（minScore=1）都进不去。
    const c = CASES[2];

    const lexAll = await scoring.rankMemories(c.query, {
      limit: 20,
      nowMs: NOW,
      enableVector: false,
    });
    assert.ok(
      !lexAll.some((m) => m.filename === c.target),
      '前置条件：目标记忆完全不在词法池内（不只是排名靠后）'
    );

    const hyb = await scoring.rankMemories(c.query, { limit: 3, nowMs: NOW, enableVector: true });
    const got = hyb.find((m) => m.filename === c.target);
    assert.ok(got, '改造后它被语义召回捞了回来');
    assert.strictEqual(got.keywordScore, 0, '它的词法分确实是 0');
    assert.ok(got.vectorScore > 0.9, `余弦相似度应接近 1，实际 ${got.vectorScore}`);
    assert.ok(got.score > 0, '并集里它拿到了正分');
  });
});

test('语义地板：低于 KHY_MEMORY_VECTOR_FLOOR 的候选拿 0 分并被丢弃', async () => {
  await withStub(async () => {
    // 两条记忆都只靠语义进池，词法分均为 0。构造它们与查询的余弦分别落在
    // 默认地板 0.35 的两侧：above ≈ 0.447、below ≈ 0.316。
    memdir.saveMemory('project', 'above floor', '监听 重试 重试', {
      description: 'a',
      filename: 'above.md',
      updated: new Date(NOW).toISOString(),
    });
    memdir.saveMemory('project', 'below floor', '监听 重试 重试 重试', {
      description: 'b',
      filename: 'below.md',
      updated: new Date(NOW).toISOString(),
    });

    const query = 'upstream 端口绑定在什么位置'; // 4 次命中轴 0，零词法重叠
    const out = await scoring.rankMemories(query, { limit: 10, nowMs: NOW, enableVector: true });
    const names = out.map((m) => m.filename);

    assert.strictEqual(scoring.semFloor(), 0.35, '用的是出厂地板值');
    assert.ok(names.includes('above.md'), `地板之上的候选应保留（实际: ${names.join(',')}）`);
    assert.ok(!names.includes('below.md'), `地板之下的候选应丢弃（实际: ${names.join(',')}）`);

    const above = out.find((m) => m.filename === 'above.md');
    assert.strictEqual(above.keywordScore, 0, '它完全靠语义进来的');
    assert.ok(
      Math.abs(above.vectorScore - 4 / (4 * Math.sqrt(5))) < 1e-6,
      `余弦应为 0.447…，实际 ${above.vectorScore}`
    );
  });
});

// ── 词法归一化的加性平滑（回归防护） ──────────────────────────────────────
//
// 这一条是阶段四验证**发现**的缺陷所钉的桩。原实现用纯池内最大值归一化
// （lexNorm = kw / maxKw），于是在「一池子词法证据都很弱」时，最弱的那条也被抬到
// 满分 1.0，与一个余弦 1.0 的完美语义命中同分（各 0.5），随后由 recency/文件名的
// tiebreak 决定名次 —— 改述查询就这样输给了三个共享的高频虚词。

test('弱词法池不该把噪声抬到满分：完美语义命中必须压过 kw=3 的虚词重叠', async () => {
  await withStub(async () => {
    seedCorpus();
    const c = CASES[2]; // 目标 t3 的词法分是 0，池内最大词法分仅 3

    const out = await scoring.rankMemories(c.query, { limit: 20, nowMs: NOW, enableVector: true });
    const target = out.find((m) => m.filename === c.target);
    assert.ok(target, '目标被召回');

    const noise = out.filter((m) => m.vectorScore === 0 && m.keywordScore > 0);
    assert.ok(noise.length >= 3, '池里确实有若干纯词法噪声（前置条件）');
    const worstMaxKw = Math.max(...noise.map((m) => m.keywordScore));
    assert.ok(worstMaxKw <= 3, `池内最大词法分应当很弱，实际 ${worstMaxKw}`);

    for (const n of noise) {
      assert.ok(
        target.score > n.score,
        `完美语义命中 (${target.score.toFixed(4)}) 应严格高于噪声 ` +
          `${n.filename} kw=${n.keywordScore} (${n.score.toFixed(4)})`
      );
    }
  });
});

test('加性平滑只动词法/语义的配比，不动纯词法结果的顺序（单调性）', async () => {
  await withStub(async () => {
    seedCorpus();
    const query = 'python 打包产物发布前跑哪个校验脚本';
    const base = await scoring.rankMemories(query, { limit: 20, nowMs: NOW, enableVector: false });

    process.env.KHY_MEMORY_LEX_SOFT = '0'; // 退回纯池内最大值归一化
    try {
      const off = await scoring.rankMemories(query, { limit: 20, nowMs: NOW, enableVector: false });
      assert.deepStrictEqual(off, base, '降级路径根本不经过归一化，开关无影响');
    } finally {
      delete process.env.KHY_MEMORY_LEX_SOFT;
    }

    // 混合路径里，改 LEX_SOFT 不该改变「纯词法条目之间」的相对次序。
    const orderOf = async (soft) => {
      if (soft === null || soft === undefined) {
        delete process.env.KHY_MEMORY_LEX_SOFT;
      } else {
        process.env.KHY_MEMORY_LEX_SOFT = String(soft);
      }
      const out = await scoring.rankMemories(query, { limit: 20, nowMs: NOW, enableVector: true });
      return out.filter((m) => m.vectorScore === 0).map((m) => m.filename);
    };
    try {
      assert.deepStrictEqual(await orderOf(0), await orderOf(6), 'LEX_SOFT 不改纯词法条目的次序');
      assert.deepStrictEqual(await orderOf(50), await orderOf(6), '取值再大也一样');
    } finally {
      delete process.env.KHY_MEMORY_LEX_SOFT;
    }
  });
});

// ── 侧车缓存：召回质量之外，别每回合把全部记忆重嵌一遍 ──────────────────────

test('侧车缓存：第二次查询只嵌入 query 本身，不重嵌任何记忆', async () => {
  await withStub(async ({ calls }) => {
    seedCorpus();

    await scoring.rankMemories(CASES[0].query, { limit: 3, nowMs: NOW });
    const warmup = calls.length;
    assert.ok(warmup >= 2, `冷启动应至少两次请求（query + 记忆批次），实际 ${warmup}`);
    const embedded = calls.slice(1).reduce((n, texts) => n + texts.length, 0);
    assert.strictEqual(embedded, 20, '冷启动把 20 条记忆全嵌了（默认预算 32 ≥ 20）');
    assert.ok(fs.existsSync(vectorStore.sidecarPath()), '向量已落盘');

    calls.length = 0;
    await scoring.rankMemories(CASES[1].query, { limit: 3, nowMs: NOW });
    assert.strictEqual(calls.length, 1, '第二次查询只发一次请求');
    assert.deepStrictEqual(calls[0], [CASES[1].query], '而且只嵌 query 本身');
  });
});

test('内容改了 ⇒ 只重嵌改动的那一条，其余仍走缓存', async () => {
  await withStub(async ({ calls }) => {
    seedCorpus();
    await scoring.rankMemories(CASES[0].query, { limit: 3, nowMs: NOW });

    const t = TARGETS[0];
    memdir.saveMemory(t.type, t.name, `${t.body} 补一句：默认端口见 .env.example。`, {
      description: t.description,
      filename: t.file,
      updated: new Date(NOW + 1000).toISOString(),
    });

    calls.length = 0;
    await scoring.rankMemories(CASES[0].query, { limit: 3, nowMs: NOW + 1000 });
    const memoryTexts = calls.slice(1).flat();
    assert.strictEqual(memoryTexts.length, 1, `只该重嵌 1 条，实际 ${memoryTexts.length}`);
    assert.ok(memoryTexts[0].includes('反向代理监听地址'), '重嵌的正是改动的那一条');
  });
});

test('单回合嵌入预算有界：冷启动不会把全部记忆一次嵌完（防首轮卡顿）', async () => {
  await withStub(async ({ calls }) => {
    seedCorpus();
    process.env.KHY_MEMORY_VECTOR_EMBED_PER_TURN = '6';
    try {
      await scoring.rankMemories(CASES[0].query, { limit: 3, nowMs: NOW });
      const embedded = calls.slice(1).reduce((n, texts) => n + texts.length, 0);
      assert.strictEqual(embedded, 6, `单回合只嵌 6 条，实际 ${embedded}`);

      // 覆盖率是渐进上升的：下一回合继续补，而不是每回合重头再来。
      calls.length = 0;
      await scoring.rankMemories(CASES[0].query, { limit: 3, nowMs: NOW });
      const more = calls.slice(1).reduce((n, texts) => n + texts.length, 0);
      assert.strictEqual(more, 6, '第二回合再补 6 条（前 6 条走缓存）');
      const table = vectorStore.load({ model: 'stub-embed-model' });
      assert.strictEqual(Object.keys(table.entries).length, 12, '侧车里已累积 12 条');
    } finally {
      delete process.env.KHY_MEMORY_VECTOR_EMBED_PER_TURN;
    }
  });
});

// ── 兜底：向量层不该改坏原本词法就能命中的查询 ─────────────────────────────

test('原本词法就命中的查询，开着向量也照样命中（单调，不倒退）', async () => {
  await withStub(async () => {
    seedCorpus();
    const query = '滚动区 终端渲染';
    const lex = await scoring.rankMemories(query, { limit: 3, nowMs: NOW, enableVector: false });
    const hyb = await scoring.rankMemories(query, { limit: 3, nowMs: NOW, enableVector: true });
    assert.strictEqual(lex[0].filename, 't4-no-scroll-region.md', '词法本来就第一');
    assert.strictEqual(hyb[0].filename, 't4-no-scroll-region.md', '开向量后仍然第一');
  });
});

test('零重叠且零语义相关的查询仍然返回空（向量层不放宽召回门槛）', async () => {
  await withStub(async () => {
    seedCorpus();
    const out = await scoring.rankMemories('zzz qqq unrelated gibberish', {
      limit: 3,
      nowMs: NOW,
      enableVector: true,
    });
    assert.deepStrictEqual(out, [], '既无词法命中又在地板之下 ⇒ 不召回');
  });
});

test('概念轴词表两半不相交（fixture 不变量：否则"改述"是假的）', () => {
  for (const ax of AXES) {
    for (const m of ax.mem) {
      for (const q of ax.qry) {
        assert.ok(
          !m.includes(q) && !q.includes(m),
          `轴 ${ax.id}: 记忆侧「${m}」与查询侧「${q}」不该互为子串`
        );
      }
    }
  }
  // 轴与轴之间也不该有共享词（否则一条记忆会同时命中两根轴）。
  const seen = new Map();
  for (const ax of AXES) {
    for (const t of [...ax.mem, ...ax.qry]) {
      assert.ok(!seen.has(t) || seen.get(t) === ax.id, `词「${t}」被多根轴共用`);
      seen.set(t, ax.id);
    }
  }
  assert.strictEqual(seen.size, ALL_AXIS_TERMS.length, '轴词表无重复项');
});
