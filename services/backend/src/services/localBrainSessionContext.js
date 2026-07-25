'use strict';

/**
 * localBrainSessionContext.js — 会话级前后文关联，从 localBrainService.js 按职责抽出
 * 以降巨石（沿用 localBrainCalc.js / localBrainTextOps.js 的抽取-再导出谱系，
 * DESIGN-ARCH-051 lineage）。
 *
 * 单一职责：进程内、纯内存的离线会话上下文缓冲——记录最近若干轮对话、做粗粒度话题/
 * 实体抽取，并把跟进/指代性短句（"再来一个" / "那上海呢" / "它什么意思"）借助前文
 * 展开为独立查询。无网络、无磁盘、无模型，仅依赖标准内置与 Date.now()。
 *
 * localBrainService 以同名（含 `_`-前缀）别名复用这些导出，故 Tier-1/Tier-2 的调用点
 * 与对外导出契约保持不变。
 */

const _CTX_MAX_TURNS = 20;        // 保留最近 N 轮（user+assistant 各算一轮）
const _CTX_MAX_AGE_MS = 30 * 60 * 1000; // 30 分钟超龄淘汰

// 停用词表：主题提取与实体提取各用一份。提升为模块常量,避免 _extractTopic /
// _extractEntities 在**每轮对话(user+assistant)**都重建 Set——两者由 pushContext
// 每轮调用。只读消费(`.has`),从不改动/逃逸,故按值一次构建即可。
const _TOPIC_STOPWORDS = new Set([
  '的', '了', '在', '是', '我', '有', '和', '就', '不', '都', '一', '个', '也',
  '请', '帮', '吗', '呢', '吧', '啊', '把', '要', '能', '可以', '给', '再', '看看',
  '什么', '怎么', '如何', '哪', '为什么', '多少', '几', '还', '又', '那', '这',
  'the', 'a', 'an', 'is', 'are', 'it', 'i', 'me', 'my', 'do', 'does',
  'what', 'how', 'why', 'can', 'please', 'help', 'show', 'tell', 'give',
]);
const _ENTITY_STOPWORDS = new Set([
  'this', 'that', 'what', 'when', 'where', 'which', 'have', 'with', 'from',
  'your', 'about', 'some', 'them', 'then', 'than', 'been', 'each', 'make',
  'like', 'does', 'will', 'would', 'could', 'should', 'more', 'just', 'also',
  'into', 'very', 'well', 'here', 'there',
]);

/**
 * 会话级上下文缓冲区。
 * 结构: { role: 'user'|'assistant', text, category?, topic?, entities?, ts }
 * 进程内单例，REPL 循环持续期间有效。
 */
const _contextBuffer = [];

/** 轻量清洗：折叠空白并去除首尾空格（与 localBrainService 的同名工具一致）。 */
// 收敛到 utils/collapseWhitespaceLoose 单一真源(逐字节委托,调用点不变)
const _cleanInput = require('../utils/collapseWhitespaceLoose');

/**
 * 记录一轮对话到上下文缓冲区。
 */
function pushContext(role, text, meta = {}) {
  const entry = {
    role,
    text: String(text || '').slice(0, 1000), // 截断防止爆内存
    category: meta.category || '',
    topic: meta.topic || _extractTopic(text),
    entities: meta.entities || _extractEntities(text),
    ts: Date.now(),
  };
  _contextBuffer.push(entry);
  // 淘汰超龄 + 超量
  const cutoff = Date.now() - _CTX_MAX_AGE_MS;
  while (_contextBuffer.length > 0 && (_contextBuffer.length > _CTX_MAX_TURNS * 2 || _contextBuffer[0].ts < cutoff)) {
    _contextBuffer.shift();
  }
}

/**
 * 获取最近 N 轮上下文（默认全部）。
 */
function getContext(n) {
  const limit = n || _contextBuffer.length;
  return _contextBuffer.slice(-limit);
}

/**
 * 清空上下文（新会话时调用）。
 */
function clearContext() {
  _contextBuffer.length = 0;
}

/**
 * 从文本中提取粗粒度话题关键词（用于话题延续检测）。
 */
function _extractTopic(text) {
  const t = _cleanInput(text);
  if (!t) return '';
  // 提取最重要的 2~3 个实词(_TOPIC_STOPWORDS 为模块常量,见文件顶部)
  return t
    .replace(/[^一-龥a-zA-Z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length >= 2 && !_TOPIC_STOPWORDS.has(w.toLowerCase()))
    .slice(0, 4)
    .join(' ');
}

/**
 * 从文本中提取命名实体（城市、文件名、数字、英文单词等）。
 * 粗粒度——用于代词/指代解析。
 */
function _extractEntities(text) {
  const t = String(text || '');
  const ents = [];
  // 城市名（中文）
  const cities = t.match(/(?:北京|上海|广州|深圳|杭州|成都|武汉|南京|重庆|西安|天津|长沙|青岛|大连|厦门|苏州|东京|纽约|伦敦|巴黎|首尔|新加坡|洛杉矶|旧金山|悉尼)/g);
  if (cities) ents.push(...cities.map(c => ({ type: 'city', value: c })));
  // 文件路径
  const files = t.match(/(?:~\/|\.\/|\/)?[\w.-]+(?:\/[\w.-]+)*\.\w{1,10}/g);
  if (files) ents.push(...files.map(f => ({ type: 'file', value: f })));
  // 货币名
  const currencies = t.match(/(?:美元|人民币|欧元|英镑|日元|韩元|港币|USD|CNY|EUR|GBP|JPY)/gi);
  if (currencies) ents.push(...currencies.map(c => ({ type: 'currency', value: c })));
  // 加密货币
  const cryptos = t.match(/(?:比特币|以太坊|btc|eth|bitcoin|ethereum|doge|sol)/gi);
  if (cryptos) ents.push(...cryptos.map(c => ({ type: 'crypto', value: c })));
  // 重要英文实词（>= 4 字符，排除常见停用词）
  const enWords = t.match(/\b[a-zA-Z]{4,}\b/g);
  if (enWords) {
    ents.push(...enWords.filter(w => !_ENTITY_STOPWORDS.has(w.toLowerCase())).slice(0, 3).map(w => ({ type: 'word', value: w })));
  }
  return ents.slice(0, 10);
}

// ── 指代/跟进意图解析 ────────────────────────────────────────────────

/**
 * 检测当前输入是否为跟进/指代性查询（需要前文才有意义的短句）。
 *
 * 例: "再来一个" / "换一个" / "还有呢" / "那文件呢" / "它什么意思"
 *     "那 北京 呢" / "上海的呢" / "英镑呢"
 */
const _FOLLOWUP_RE = /^(再来|再讲|再说|换一个|再给|还有|另一个|继续|下一个|more|another|next|again|one more)[\s一个吗呢？?!！]*$/i;
const _PRONOUN_RE = /(它|这个|那个|上面|刚才|之前|前面|上一个|上次|那|这|its?|that|the one|previous|last one|above)/i;
const _FOLLOWUP_TOPIC_RE = /^(?:那|那个|这个)?(.{1,20})(呢|的呢|怎么样|如何|多少|几|怎样|那边|那里)[？?]?$/;

/**
 * 尝试将一个跟进/指代查询用前文上下文展开为独立查询。
 *
 * @param {string} input - 用户原始输入
 * @returns {{ resolved: string, context: string }|null}
 *   resolved — 展开后的查询（可直接传入 detect/tryFallback）
 *   context  — 用到的上下文摘要（用于调试/展示）
 */
function resolveFollowUp(input) {
  const text = _cleanInput(input);
  if (!text) return null;

  const recentUser = _contextBuffer.filter(e => e.role === 'user').slice(-3);
  const recentAssistant = _contextBuffer.filter(e => e.role === 'assistant').slice(-3);
  if (recentUser.length === 0) return null;

  const lastUser = recentUser[recentUser.length - 1];
  const lastAssistant = recentAssistant[recentAssistant.length - 1];

  // 模式 1: "再来一个" / "换一个" — 重复上次同类查询
  if (_FOLLOWUP_RE.test(text)) {
    // 找到最近一轮的 category，生成同类查询
    if (lastAssistant) {
      const cat = lastAssistant.category;
      if (cat === '笑话') return { resolved: '讲个笑话', context: `续: ${cat}` };
      if (cat === '名言') return { resolved: '来个名言', context: `续: ${cat}` };
      if (cat === '冷知识') return { resolved: '冷知识', context: `续: ${cat}` };
      if (cat === '天气' && lastUser.topic) {
        // 同城市再查 → 但天气不太需要"再来一个"，可能用户想换城市
        return null;
      }
    }
    // 无法确定 → 重复上次用户输入
    if (lastUser.text) return { resolved: lastUser.text, context: `重复: "${lastUser.text.slice(0, 30)}"` };
    return null;
  }

  // 模式 2: "那 XX 呢" / "XX的呢" — 话题延续，替换实体
  const topicM = text.match(_FOLLOWUP_TOPIC_RE);
  if (topicM && lastUser) {
    const newSubject = topicM[1].trim();
    const prevText = lastUser.text;
    // 尝试在上次查询中替换关键实体
    // 例: 上次 "北京天气" → 现在 "上海呢" → 解析为 "上海天气"
    if (lastAssistant) {
      const cat = lastAssistant.category;
      if (cat === '天气') return { resolved: `${newSubject}天气`, context: `话题延续: 天气 → ${newSubject}` };
      if (cat === '汇率') return { resolved: `${newSubject}汇率`, context: `话题延续: 汇率 → ${newSubject}` };
      if (cat === '加密货币') return { resolved: `${newSubject}价格`, context: `话题延续: 币价 → ${newSubject}` };
      if (cat === '词典') return { resolved: `${newSubject}什么意思`, context: `话题延续: 词典 → ${newSubject}` };
      if (cat === '节假日') return { resolved: `${newSubject}节假日`, context: `话题延续: 节假日 → ${newSubject}` };
      if (cat === 'IP') return { resolved: `${newSubject}IP`, context: `话题延续: IP → ${newSubject}` };
    }
    // 通用: 将新主语嫁接到上次查询的谓语上
    // 上次: "北京天气" → topic: "北京 天气"，用 newSubject 替换第一个词
    if (lastUser.topic) {
      const topicWords = lastUser.topic.split(/\s+/);
      if (topicWords.length >= 2) {
        topicWords[0] = newSubject;
        return { resolved: topicWords.join(''), context: `实体替换: ${lastUser.topic} → ${topicWords.join('')}` };
      }
    }
  }

  // 模式 3: 含代词指代 — 尝试替换代词为上文实体
  if (_PRONOUN_RE.test(text) && lastAssistant) {
    const entities = lastAssistant.entities || lastUser.entities || [];
    if (entities.length > 0) {
      // 取上文最显著的实体替换代词
      const primaryEntity = entities[0].value;
      let resolved = text
        .replace(/它|这个|那个|上面的?|刚才的?|之前的?|前面的?|上一个|上次的?|that|the one|previous|last one/gi, primaryEntity)
        .replace(/\s+/g, ' ')
        .trim();
      // 避免无意义的展开
      if (resolved !== text && resolved.length > 3) {
        return { resolved, context: `指代: "${primaryEntity}"` };
      }
    }
  }

  return null;
}

/**
 * 生成简短的上下文摘要，附加到搜索查询中以提高相关性。
 * 仅在检测到话题延续时使用。
 */
function _getContextHint() {
  const recent = _contextBuffer.slice(-4);
  if (recent.length === 0) return '';
  const topics = recent
    .map(e => e.topic)
    .filter(Boolean);
  // 去重
  return [...new Set(topics)].slice(-2).join(' ');
}

module.exports = {
  pushContext,
  getContext,
  clearContext,
  resolveFollowUp,
  _getContextHint,
  // 次级导出（便于测试与潜在复用）
  _extractTopic,
  _extractEntities,
};
