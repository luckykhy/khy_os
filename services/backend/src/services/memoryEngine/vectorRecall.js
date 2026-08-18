'use strict';

/**
 * memoryEngine/vectorRecall.js — 记忆的语义（向量）召回层。
 *
 * ## 这个文件修的是什么缺陷
 *
 * 改造前它是一个**后置重排器**：`scoring.rankMemories` 先按关键词重叠过滤
 * （`minScore = 1`）、再截断到 `limit = 5`，**然后**才拿这 5 条去算余弦相似度。
 * 于是余弦相似度只能给「已经词法命中」的 5 条重新排序，**永远救不回一条
 * 改述查询下语义相关、但用词不重叠的记忆** —— 而那恰恰是向量检索唯一真正
 * 不可替代的价值。这是 Top-3 命中率上不去的根因，跟有没有 embedding 客户端无关。
 *
 * 改造后本模块变成**召回器**：对全量记忆算相似度，交给 `scoring` 与词法召回池
 * 取并集，再一起打分排序。截断发生在并集之后。
 *
 * ## 另外两处改动
 *
 * - **F2**：删掉了本模块自己的 `http.request` 实现（它直连 embedding 端点，绕过
 *   aiGateway，且没有 Ollama / 网关回退）。现在一律走 `services/embeddingClient`
 *   这一个真源。
 * - **持久化**：向量经 `vectorStore` 侧车落盘，按内容 hash 失效。改造前每次查询都要
 *   把候选重嵌一遍。
 *
 * ## 有界与降级
 *
 * - 冷启动不一次嵌完：单回合最多嵌 `KHY_MEMORY_VECTOR_EMBED_PER_TURN`（默认 32）条
 *   新记忆，其余留给后续回合。已缓存的立即参与召回，所以覆盖率是渐进上升而不是
 *   「第一回合卡住十几秒」。
 * - 查询向量嵌不出来（服务不可达/模型没装）即返回 null，调用方**逐字节**退回纯词法路径（F4）。
 *
 * @module memoryEngine/vectorRecall
 */

const embeddingClient = require('../embeddingClient');

const vectorStore = require('./vectorStore');

const OFF = /^(0|false|no|off)$/i;

function _envInt(name, def, min, max) {
  const n = parseInt(process.env[name], 10);
  if (!Number.isFinite(n)) {
    return def;
  }
  let r = n;
  if (typeof min === 'number') {
    r = Math.max(min, r);
  }
  if (typeof max === 'number') {
    r = Math.min(max, r);
  }
  return r;
}

/**
 * 向量召回总开关。默认开；`KHY_MEMORY_VECTOR_RECALL ∈ {0,false,no,off}` 关。
 *
 * 读**活** env（不是模块加载期常量）—— 改造前它是加载期 const，导致测试必须
 * `jest.resetModules()` 才能改，而且运行期改环境变量无效。
 *
 * @returns {boolean}
 */
function isEnabled() {
  const v = process.env.KHY_MEMORY_VECTOR_RECALL;
  if (v == null || String(v).trim() === '') {
    return true;
  }
  return !OFF.test(String(v).trim());
}

/** 单回合最多为多少条「尚无缓存向量」的记忆做嵌入（有界，防冷启动卡顿）。 */
function embedBudget() {
  return _envInt('KHY_MEMORY_VECTOR_EMBED_PER_TURN', 32, 1, 512);
}

/** 参与嵌入的正文截断长度（embedding 模型的上下文有限，且长尾对语义贡献递减）。 */
function _snippetChars() {
  return _envInt('KHY_MEMORY_VECTOR_SNIPPET_CHARS', 500, 80, 8000);
}

/**
 * 把一条记忆压成待嵌入文本。标题与摘要一起进去 —— 它们是人写的最凝练的语义标签，
 * 只嵌正文会丢掉这部分信号（与 `keywordScore` 给 name×3 / description×2 加权同理）。
 *
 * @param {object} frontmatter
 * @param {string} body
 * @returns {string}
 */
function memoryText(frontmatter, body) {
  const fm = frontmatter || {};
  const head = [String(fm.name || ''), String(fm.description || '')].filter(Boolean).join(' — ');
  const text = String(body || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, _snippetChars());
  return [head, text].filter(Boolean).join('\n');
}

/**
 * 语义召回：对全量记忆算与 query 的余弦相似度。
 *
 * 走缓存优先：只为「侧车里没有、或 hash 已变」的记忆调 embedding，且单回合嵌入条数有界。
 *
 * @param {string} query
 * @param {Array<{filename:string, frontmatter:object, body:string}>} entries
 *        全量候选（**不是**词法过滤后的子集 —— 那正是改造前的缺陷）
 * @param {object} [opts]
 * @param {number} [opts.nowMs]        - 可注入时钟（测试用）
 * @param {number} [opts.embedBudget]  - 覆盖单回合嵌入预算
 * @returns {Promise<Map<string, number>|null>}
 *          filename → 余弦相似度；embedding 不可用时返回 null（调用方据此逐字节降级）
 */
async function recall(query, entries, opts = {}) {
  if (!isEnabled()) {
    return null;
  }
  if (!query || !String(query).trim()) {
    return null;
  }
  if (!Array.isArray(entries) || entries.length === 0) {
    return null;
  }

  // 1) 先嵌查询。失败即判定 embedding 不可用 —— 这一步同时充当探活，
  //    比先去嵌一堆记忆再发现打不通要省得多。
  let queryVec;
  try {
    queryVec = await embeddingClient.embedText(String(query));
  } catch {
    return null;
  }
  if (!Array.isArray(queryVec) || queryVec.length === 0) {
    return null;
  }

  const model = embeddingClient.embedModel();
  const nowMs = Number.isFinite(opts.nowMs) ? opts.nowMs : Date.now();

  // 2) 读侧车（模型不符会自动拿到空表 ⇒ 整表重建）。
  let table;
  try {
    table = vectorStore.load({ model });
  } catch {
    table = null;
  }
  if (!table) {
    return null;
  }
  if (!table.model) {
    table.model = model;
  }

  // 3) 分出命中与待嵌。
  const hashes = new Map();
  const cached = new Map();
  const pending = [];
  for (const e of entries) {
    if (!e || !e.filename) {
      continue;
    }
    const h = vectorStore.contentHash(e.frontmatter, e.body);
    hashes.set(e.filename, h);
    const vec = vectorStore.get(table, e.filename, h);
    if (vec) {
      cached.set(e.filename, vec);
    } else {
      pending.push(e);
    }
  }

  // 4) 为待嵌的记忆补向量，有界：单回合最多 budget 条，且按 embeddingClient 的
  //    批量上限分批。任一批失败就停下 —— 已经拿到的照样入库，下回合继续补。
  const budget = Number.isFinite(opts.embedBudget) ? opts.embedBudget : embedBudget();
  const todo = pending.slice(0, Math.max(0, budget));
  const fresh = [];
  if (todo.length > 0) {
    const batchSize = Math.max(1, embeddingClient.maxTexts());
    for (let i = 0; i < todo.length; i += batchSize) {
      const batch = todo.slice(i, i + batchSize);
      let vecs = null;
      try {
        vecs = await embeddingClient.embedTexts(
          batch.map((e) => memoryText(e.frontmatter, e.body))
        );
      } catch {
        vecs = null;
      }
      if (!vecs || vecs.length !== batch.length) {
        break; // 端点中途不稳:保住已得的，剩下的下回合再来
      }
      for (let k = 0; k < batch.length; k++) {
        fresh.push({
          filename: batch[k].filename,
          hash: hashes.get(batch[k].filename),
          vec: vecs[k],
        });
        cached.set(batch[k].filename, vecs[k]);
      }
    }
  }

  // 5) 落盘：写入新向量 + 清掉已删除记忆的残留。写失败只是「下回合再嵌一遍」，不影响本回合结果。
  if (fresh.length > 0) {
    try {
      vectorStore.put(table, fresh, nowMs);
      vectorStore.prune(table, new Set(hashes.keys()));
      vectorStore.save(table);
    } catch {
      /* 侧车不可写 ⇒ 退化为每回合重嵌，功能不受影响 */
    }
  }

  // 6) 算相似度。维度不符的（换过模型的残留）由 cosine 自然返回 0，不会污染排序。
  const sims = new Map();
  for (const [filename, vec] of cached) {
    sims.set(filename, embeddingClient.cosine(queryVec, vec));
  }
  return sims.size > 0 ? sims : null;
}

/**
 * 命中统计开关。默认**关** —— 见下方 noteHits 的说明：这批数据目前没有读者，
 * 而每回合多读写一遍侧车是实打实的 IO。想为将来的冷落降权攒数据时打开它
 * （`KHY_MEMORY_VECTOR_HITS=1`）。
 *
 * @returns {boolean}
 */
function hitsEnabled() {
  const v = process.env.KHY_MEMORY_VECTOR_HITS;
  return v != null && /^(1|true|yes|on)$/i.test(String(v).trim());
}

/**
 * 记一次召回命中（写进侧车的 hits/lastHitAt）。
 *
 * 本轮**只写不读**：衰减立法第 3 档（冷落降权）明确不实施，先积累数据。
 * 因此默认关闭（见 hitsEnabled）—— 一个没有读者的字段不该让每个回合都多付一次
 * 侧车读写。失败静默：统计字段绝不该影响检索。
 *
 * @param {string[]} filenames
 * @param {number} [nowMs]
 */
function noteHits(filenames, nowMs) {
  if (!hitsEnabled()) {
    return;
  }
  if (!Array.isArray(filenames) || filenames.length === 0) {
    return;
  }
  try {
    const table = vectorStore.load({ model: embeddingClient.embedModel() });
    if (vectorStore.recordHits(table, filenames, nowMs) > 0) {
      vectorStore.save(table);
    }
  } catch {
    /* 统计失败不影响任何检索行为 */
  }
}

module.exports = {
  isEnabled,
  hitsEnabled,
  embedBudget,
  memoryText,
  recall,
  noteHits,
  // embedding 的唯一真源在 services/embeddingClient；此处只做转发，方便记忆侧调用。
  embedText: (text) => embeddingClient.embedText(text),
  cosine: (a, b) => embeddingClient.cosine(a, b),
};
