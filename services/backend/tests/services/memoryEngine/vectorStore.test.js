'use strict';

/**
 * memoryEngine/vectorStore — 向量侧车的持久化契约（node:test）。
 *
 * 这一层是记忆 RAG 的**失效判据**所在。它错了不会报错，只会静默地拿陈旧向量去
 * 排序 —— 那种 bug 在使用中表现为「记忆偶尔召回得莫名其妙」，几乎不可能靠观察定位。
 * 所以这里逐条钉住每一条失效规则：
 *
 *   - 逐条失效：`hash = sha256(name \n description \n body)` 变了 ⇒ 该条不再命中
 *   - 整表失效：`model` 不符 ⇒ 拿到空表（不同模型的向量空间不可比，混用即静默错排）
 *   - 有界：超 `KHY_MEMORY_VECTOR_MAX_BYTES` 即拒写（返回 false，不落盘）
 *   - prune：记忆文件删了，残留向量必须清掉（否则会被召回到一条不存在的记忆）
 *
 * 全部走 KHY_MEMORY_DIR 临时目录，与真实记忆目录零接触。
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const paths = require('../../../src/memdir/paths');
const vectorStore = require('../../../src/services/memoryEngine/vectorStore');

const MODEL = 'stub-embed-model';

/** 确定性伪向量：只要 seed 不同，向量就不同；长度固定。 */
function vec(seed, dim = 8) {
  const out = new Array(dim);
  for (let i = 0; i < dim; i++) {
    out[i] = ((seed * 31 + i * 7) % 100) / 100;
  }
  return out;
}

async function withScratch(fn) {
  const saved = {};
  const KEYS = [
    'KHY_MEMORY_DIR',
    'KHY_MEMORY_MERGE_LEGACY',
    'KHY_MEMORY_VECTOR_MAX_BYTES',
    'KHY_MEMORY_VECTOR_PRECISION',
    'KHY_MEMORY_VECTOR_STORE',
  ];
  for (const k of KEYS) {
    saved[k] = process.env[k];
  }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'khy-vecstore-'));
  process.env.KHY_MEMORY_DIR = tmp;
  process.env.KHY_MEMORY_MERGE_LEGACY = 'off';
  delete process.env.KHY_MEMORY_VECTOR_MAX_BYTES;
  delete process.env.KHY_MEMORY_VECTOR_PRECISION;
  delete process.env.KHY_MEMORY_VECTOR_STORE;
  paths._resetCache();
  try {
    return await fn(tmp);
  } finally {
    for (const k of KEYS) {
      if (saved[k] === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = saved[k];
      }
    }
    paths._resetCache();
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

test('落盘往返：put → save → load → get 拿回同一条向量', async () => {
  await withScratch(async () => {
    const hash = vectorStore.contentHash({ name: 'a', description: 'd' }, 'body');
    const table = vectorStore.load({ model: MODEL });
    assert.strictEqual(Object.keys(table.entries).length, 0, '冷启动是空表');

    assert.strictEqual(vectorStore.put(table, [{ filename: 'a.md', hash, vec: vec(1) }]), 1);
    assert.strictEqual(table.dim, 8, '首条向量确立整表维度');
    assert.strictEqual(vectorStore.save(table), true);
    assert.ok(fs.existsSync(vectorStore.sidecarPath()), '侧车文件已生成');

    const reloaded = vectorStore.load({ model: MODEL });
    const got = vectorStore.get(reloaded, 'a.md', hash);
    assert.ok(Array.isArray(got), '重新加载后能取回向量');
    assert.strictEqual(got.length, 8);
    // 落盘按 KHY_MEMORY_VECTOR_PRECISION 量化，所以比对精度而非全等。
    for (let i = 0; i < got.length; i++) {
      assert.ok(Math.abs(got[i] - vec(1)[i]) < 1e-6, `第 ${i} 维在量化误差内`);
    }
  });
});

test('侧车以 "." 开头，不会被 listMemories 的 *.md 过滤器看见', async () => {
  await withScratch(async () => {
    assert.ok(vectorStore.SIDECAR_NAME.startsWith('.'), '文件名以 . 开头');
    assert.ok(!vectorStore.SIDECAR_NAME.endsWith('.md'), '不是 .md，不会被当成一条记忆');
    assert.strictEqual(
      path.resolve(path.dirname(vectorStore.sidecarPath())),
      path.resolve(paths.getMemoryDir()),
      '就放在记忆目录里（跟着记忆一起备份/迁移）'
    );
  });
});

test('逐条失效：正文改了 ⇒ hash 变 ⇒ get 未命中（不会拿陈旧向量去排序）', async () => {
  await withScratch(async () => {
    const fm = { name: 'gateway', description: '网关监听地址' };
    const h1 = vectorStore.contentHash(fm, '端口来自 PROXY_PORT。');
    const h2 = vectorStore.contentHash(fm, '端口来自 PROXY_PORT，默认 9100。');
    assert.notStrictEqual(h1, h2, '正文不同 ⇒ hash 不同');

    const table = vectorStore.load({ model: MODEL });
    vectorStore.put(table, [{ filename: 'g.md', hash: h1, vec: vec(2) }]);
    vectorStore.save(table);

    const reloaded = vectorStore.load({ model: MODEL });
    assert.ok(vectorStore.get(reloaded, 'g.md', h1), '旧 hash 命中');
    assert.strictEqual(vectorStore.get(reloaded, 'g.md', h2), null, '新 hash 未命中 ⇒ 触发重嵌');
  });
});

test('hash 只覆盖参与嵌入的三个字段：仅 mtime/其他 frontmatter 变化不触发重嵌', async () => {
  await withScratch(async () => {
    const a = vectorStore.contentHash({ name: 'n', description: 'd', type: 'project' }, 'b');
    const b = vectorStore.contentHash(
      { name: 'n', description: 'd', type: 'user', updated: '2026-01-01T00:00:00Z' },
      'b'
    );
    assert.strictEqual(a, b, 'name/description/body 未变 ⇒ hash 不变');
  });
});

test('整表失效：model 不符 ⇒ 拿到空表（不同模型的向量空间不可比）', async () => {
  await withScratch(async () => {
    const hash = vectorStore.contentHash({ name: 'a' }, 'b');
    const table = vectorStore.load({ model: MODEL });
    vectorStore.put(table, [{ filename: 'a.md', hash, vec: vec(3) }]);
    vectorStore.save(table);

    const same = vectorStore.load({ model: MODEL });
    assert.strictEqual(Object.keys(same.entries).length, 1, '同模型 ⇒ 表可用');

    const other = vectorStore.load({ model: 'another-embed-model' });
    assert.strictEqual(Object.keys(other.entries).length, 0, '换模型 ⇒ 整表作废');
    assert.strictEqual(other.model, 'another-embed-model', '空表带上新模型名');
    assert.strictEqual(other.dim, 0);
  });
});

test('整表失效：侧车损坏 ⇒ 拿到空表而不是抛异常（F4）', async () => {
  await withScratch(async () => {
    paths.ensureMemoryDirExists();
    fs.writeFileSync(vectorStore.sidecarPath(), '{ this is not json', 'utf-8');
    const table = vectorStore.load({ model: MODEL });
    assert.strictEqual(Object.keys(table.entries).length, 0);
    assert.strictEqual(table.version, vectorStore.SCHEMA_VERSION);
  });
});

test('整表失效：schema 版本不符 ⇒ 拿到空表', async () => {
  await withScratch(async () => {
    paths.ensureMemoryDirExists();
    fs.writeFileSync(
      vectorStore.sidecarPath(),
      JSON.stringify({
        version: vectorStore.SCHEMA_VERSION + 1,
        model: MODEL,
        dim: 8,
        entries: { 'a.md': { hash: 'x', vec: vec(4) } },
      }),
      'utf-8'
    );
    assert.strictEqual(Object.keys(vectorStore.load({ model: MODEL }).entries).length, 0);
  });
});

test('维度守卫：put 拒收与整表 dim 不一致的向量；get 也拒发', async () => {
  await withScratch(async () => {
    const table = vectorStore.load({ model: MODEL });
    const h = 'h';
    assert.strictEqual(vectorStore.put(table, [{ filename: 'a.md', hash: h, vec: vec(5, 8) }]), 1);
    assert.strictEqual(
      vectorStore.put(table, [{ filename: 'b.md', hash: h, vec: vec(6, 16) }]),
      0,
      '维度不符即拒收（同一模型不该产生变长向量，出现即说明端点串了）'
    );
    assert.strictEqual(table.entries['b.md'], undefined);

    // 直接伪造一条维度不符的残留，get 必须视为未命中。
    table.entries['c.md'] = { hash: h, vec: vec(7, 4), embeddedAt: 0, hits: 0, lastHitAt: null };
    assert.strictEqual(vectorStore.get(table, 'c.md', h), null);
  });
});

test('有界：超过 KHY_MEMORY_VECTOR_MAX_BYTES ⇒ save 返回 false 且不落盘', async () => {
  await withScratch(async () => {
    process.env.KHY_MEMORY_VECTOR_MAX_BYTES = String(64 * 1024); // 下限
    const table = vectorStore.load({ model: MODEL });
    const items = [];
    for (let i = 0; i < 40; i++) {
      items.push({ filename: `m${i}.md`, hash: `h${i}`, vec: vec(i, 768) });
    }
    assert.strictEqual(vectorStore.put(table, items), 40);
    assert.strictEqual(vectorStore.save(table), false, '超限拒写');
    assert.strictEqual(fs.existsSync(vectorStore.sidecarPath()), false, '没有留下半张表');
  });
});

test('prune：记忆文件删了，残留向量被清掉（否则会召回到不存在的记忆）', async () => {
  await withScratch(async () => {
    const table = vectorStore.load({ model: MODEL });
    vectorStore.put(table, [
      { filename: 'live.md', hash: 'h1', vec: vec(8) },
      { filename: 'gone.md', hash: 'h2', vec: vec(9) },
    ]);
    assert.strictEqual(vectorStore.prune(table, new Set(['live.md'])), 1);
    assert.ok(table.entries['live.md'], '存活的留下');
    assert.strictEqual(table.entries['gone.md'], undefined, '已删的清掉');
    assert.strictEqual(vectorStore.prune(table, new Set(['live.md'])), 0, '幂等');
  });
});

test('recordHits 只累加已存在的条目；hits 跨重嵌保留', async () => {
  await withScratch(async () => {
    const table = vectorStore.load({ model: MODEL });
    vectorStore.put(table, [{ filename: 'a.md', hash: 'h1', vec: vec(10) }], 1000);
    assert.strictEqual(table.entries['a.md'].hits, 0);
    assert.strictEqual(table.entries['a.md'].lastHitAt, null);

    assert.strictEqual(
      vectorStore.recordHits(table, ['a.md', 'nope.md'], 2000),
      1,
      '不存在的条目不会被凭空创建'
    );
    assert.strictEqual(table.entries['a.md'].hits, 1);
    assert.strictEqual(table.entries['a.md'].lastHitAt, 2000);

    // 内容改了要重嵌，但「这条记忆被用过几次」不该因此清零。
    vectorStore.put(table, [{ filename: 'a.md', hash: 'h2', vec: vec(11) }], 3000);
    assert.strictEqual(table.entries['a.md'].hash, 'h2', '向量已更新');
    assert.strictEqual(table.entries['a.md'].hits, 1, 'hits 保留');
    assert.strictEqual(table.entries['a.md'].lastHitAt, 2000, 'lastHitAt 保留');
  });
});

test('stats 报告后端/模型/维度/条数，且不因侧车缺失而抛', async () => {
  await withScratch(async () => {
    const cold = vectorStore.stats();
    assert.strictEqual(cold.exists, false);
    assert.strictEqual(cold.count, 0);
    assert.strictEqual(cold.backend, 'file', '本轮只实现 file 后端');

    const table = vectorStore.load({ model: MODEL });
    vectorStore.put(table, [{ filename: 'a.md', hash: 'h', vec: vec(12) }]);
    vectorStore.save(table);

    const warm = vectorStore.stats();
    assert.strictEqual(warm.exists, true);
    assert.strictEqual(warm.count, 1);
    assert.strictEqual(warm.model, MODEL);
    assert.strictEqual(warm.dim, 8);
    assert.ok(warm.bytes > 0);
  });
});

test('KHY_MEMORY_VECTOR_STORE=sqlite 是预留值：仍走 file，不静默失效', async () => {
  await withScratch(async () => {
    process.env.KHY_MEMORY_VECTOR_STORE = 'sqlite';
    assert.strictEqual(vectorStore.backend(), 'sqlite', '开关值被诚实报告');
    const table = vectorStore.load({ model: MODEL });
    vectorStore.put(table, [{ filename: 'a.md', hash: 'h', vec: vec(13) }]);
    assert.strictEqual(vectorStore.save(table), true, '未实现的后端值不会让记忆向量丢失');
    assert.ok(vectorStore.get(vectorStore.load({ model: MODEL }), 'a.md', 'h'));
  });
});

test('量化精度可配，且精度降低不改变形状', async () => {
  await withScratch(async () => {
    process.env.KHY_MEMORY_VECTOR_PRECISION = '2';
    const table = vectorStore.load({ model: MODEL });
    vectorStore.put(table, [{ filename: 'a.md', hash: 'h', vec: [0.123456, 0.987654] }]);
    assert.deepStrictEqual(table.entries['a.md'].vec, [0.12, 0.99]);
  });
});
