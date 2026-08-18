'use strict';

/**
 * 记忆 RAG 的降级契约（node:test）—— 铁律 F4 的正面证明。
 *
 * 目标陈述里的验收项：「降级测试：断掉 embedding 后端，对话功能与旧行为一致」。
 * 「一致」在这里被钉成**逐字节深相等**，而不是「顺序差不多」：
 *
 *   rankMemories(q, {enableVector:true}) 在 embedding 打不通时
 *     必须 deepStrictEqual
 *   rankMemories(q, {enableVector:false})
 *
 * 为什么要这么严：混合打分公式是 `(w_lex·lexNorm + w_sem·semNorm) × recency`，
 * 归一化之后**绝对分值**与纯词法路径的 `keywordScore × recency` 完全不同。如果降级
 * 分支复用了归一化公式，排序看起来对，但 `minScore` 边界与所有依赖绝对分值的下游
 * （诊断输出、阈值判断）会静默改变语义。所以 scoring.js 的降级分支刻意重写了
 * **原表达式**，本测试就是钉住这一点 —— 深相等能抓到这类改写，顺序断言抓不到。
 *
 * 「断掉后端」用真实手法制造：绑一个端口拿到号、立刻关掉，于是三个候选端点
 * （env / Ollama / 网关）全部指向必然 ECONNREFUSED 的地址。不 mock 任何模块 ——
 * mock 掉 embeddingClient 就只能证明「我的 mock 返回了 null」，证明不了真实的
 * 连接失败路径会走到降级。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const paths = require('../../../src/memdir/paths');
const memdir = require('../../../src/memdir/memdir');
const engine = require('../../../src/services/memoryEngine');
const scoring = require('../../../src/services/memoryEngine/scoring');
const vectorStore = require('../../../src/services/memoryEngine/vectorStore');
const embeddingClient = require('../../../src/services/embeddingClient');

const NOW = Date.UTC(2026, 7, 16, 12, 0, 0);

/** 拿一个必然连不上的本地端口：绑上去、记下号、立刻关闭。 */
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
  'KHY_MEMORY_EMBED_MODEL',
  'KHY_LEARN_EMBED_MODEL',
  'KHY_LEARN_EMBED_URL',
  'KHY_LEARN_EMBED_TIMEOUT_MS',
  'OLLAMA_HOST',
  'KHY_GATEWAY_URL',
  'PROXY_AUTH_TOKEN',
];

/**
 * 临时记忆目录 + 三个 embedding 端点全部指向死端口。
 * @param {(tmp:string)=>Promise<any>} fn
 */
async function withDeadBackend(fn) {
  const saved = {};
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-degrade-'));
  const port = await deadPort();
  const dead = `http://127.0.0.1:${port}`;

  process.env.KHY_MEMORY_DIR = tmp;
  process.env.KHY_MEMORY_MERGE_LEGACY = 'off';
  delete process.env.KHY_MEMORY_VECTOR_RECALL; // 默认开：正是要测「开着但打不通」
  delete process.env.KHY_MEMORY_VECTOR_HITS;
  process.env.KHY_MEMORY_EMBED_MODEL = 'stub-embed-model';
  process.env.KHY_LEARN_EMBED_URL = `${dead}/v1/embeddings`;
  process.env.OLLAMA_HOST = dead;
  process.env.KHY_GATEWAY_URL = dead;
  process.env.PROXY_AUTH_TOKEN = 'not-used'; // 免去读 proxy_server_auth.json
  process.env.KHY_LEARN_EMBED_TIMEOUT_MS = '500'; // ECONNREFUSED 是立即的，这只是保险
  paths._resetCache();
  embeddingClient._resetCache();

  try {
    return await fn(tmp);
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
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

/** 一组够让排序有话可说的记忆（分数各不相同，顺序不是巧合）。 */
function seedMemories() {
  memdir.saveMemory('project', 'gateway listen address', '网关监听地址由 PROXY_HOST 与 PROXY_PORT 决定。', {
    description: '网关监听地址',
    filename: 'p-gateway.md',
  });
  memdir.saveMemory('reference', 'gateway docs', '网关的接口文档在 docs 目录下。', {
    description: '网关文档位置',
    filename: 'r-gateway-docs.md',
  });
  memdir.saveMemory('feedback', 'ask before deleting', '删除记忆前必须先问用户。', {
    description: '删除前先确认',
    filename: 'f-ask.md',
  });
  memdir.saveMemory('user', 'prefers chinese', '用户偏好中文回复。', {
    description: '语言偏好',
    filename: 'u-lang.md',
  });
  memdir.saveMemory('project', 'wheel purity', 'wheel 里不得夹带凭据。', {
    description: 'wheel 纯净度',
    filename: 'p-wheel.md',
  });
}

test('embedding 后端不可达 ⇒ 确实不可达（前置条件自检，避免测试假绿）', async () => {
  await withDeadBackend(async () => {
    const vec = await embeddingClient.embedText('网关监听地址');
    assert.strictEqual(vec, null, '三个端点全部失败 ⇒ embedText 返回 null（不抛）');
    const avail = await embeddingClient.isAvailable({ force: true });
    assert.strictEqual(avail.available, false);
  });
});

test('后端断掉 ⇒ rankMemories 与 enableVector:false 深相等（F4 逐字节降级）', async () => {
  await withDeadBackend(async () => {
    seedMemories();
    const query = '网关 监听 地址 端口';

    const degraded = await scoring.rankMemories(query, { nowMs: NOW, enableVector: true });
    const legacy = await scoring.rankMemories(query, { nowMs: NOW, enableVector: false });

    assert.ok(degraded.length > 0, '降级后照样召回（记忆功能不因 RAG 故障而中断）');
    assert.deepStrictEqual(degraded, legacy, '逐字节相同：分值、字段集、顺序都不变');
    assert.ok(
      degraded.every((m) => m.vectorScore === undefined),
      '降级路径不该凭空多出 vectorScore 字段'
    );
    // 绝对分值仍是原表达式，而不是归一化后的近似值。
    for (const m of degraded) {
      assert.strictEqual(m.score, m.keywordScore * m.recency, '分值 = keywordScore × recency');
    }
  });
});

test('后端断掉 ⇒ 与总开关 KHY_MEMORY_VECTOR_RECALL=off 深相等', async () => {
  await withDeadBackend(async () => {
    seedMemories();
    const query = '网关 监听 地址 端口';

    const backendDown = await scoring.rankMemories(query, { nowMs: NOW });
    process.env.KHY_MEMORY_VECTOR_RECALL = 'off';
    const switchOff = await scoring.rankMemories(query, { nowMs: NOW });

    assert.deepStrictEqual(backendDown, switchOff, '「打不通」与「主动关掉」走的是同一条路');
  });
});

test('对话侧：buildRelevantMemorySection 的注入块在后端断掉时与旧行为一致', async () => {
  await withDeadBackend(async () => {
    seedMemories();
    const query = '网关 监听 地址 端口';

    const degraded = await engine.buildRelevantMemorySection(query, { nowMs: NOW });
    process.env.KHY_MEMORY_VECTOR_RECALL = 'off';
    const legacy = await engine.buildRelevantMemorySection(query, { nowMs: NOW });

    assert.ok(degraded, '降级后仍产出注入块');
    assert.strictEqual(degraded, legacy, '注入给模型的文本逐字符相同');
  });
});

test('后端断掉 ⇒ 不写侧车（没有向量可存，也不留半张表）', async () => {
  await withDeadBackend(async () => {
    seedMemories();
    await scoring.rankMemories('网关 监听 地址', { nowMs: NOW });
    assert.strictEqual(fs.existsSync(vectorStore.sidecarPath()), false);
  });
});

test('后端断掉 ⇒ 零重叠查询仍然返回空（降级不放宽召回门槛）', async () => {
  await withDeadBackend(async () => {
    seedMemories();
    const out = await scoring.rankMemories('zzz qqq completely unrelated', { nowMs: NOW });
    assert.deepStrictEqual(out, []);
  });
});

test('后端断掉 ⇒ 一次 rankMemories 不会拖慢对话（快速失败，非超时等待）', async () => {
  await withDeadBackend(async () => {
    seedMemories();
    const t0 = process.hrtime.bigint();
    await scoring.rankMemories('网关 监听 地址', { nowMs: NOW });
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    // ECONNREFUSED 是立即返回的；这里给足 3 秒的宽松上界，只为抓住
    // 「降级路径退化成等三次超时」这类回归（那会让每回合对话多等十几秒）。
    assert.ok(ms < 3000, `降级耗时 ${ms.toFixed(0)}ms，应远小于超时上界`);
  });
});
