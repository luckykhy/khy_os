'use strict';

/**
 * entityRegistry.js — 核心实体抽离、UID 铸造与指针化去重（DESIGN-ARCH-036 §3.3 可索引性 / §5 UID）。
 *
 * 晶格铸造规范要求：同一实体在结构化产出里只能存在一个拓扑节点，凡引用皆走唯一
 * 标识符（UID），绝不在上下文里反复用自然语言描述同一对象。本模块就是那张
 * 「实体 ⇄ UID」的真值表。
 *
 * UID 采用**内容寻址**：sha1(归一描述).slice ——
 *   - 确定性：同一次输入里“那个文件 a.js”出现三遍 → 同一 UID → 三处指针、一份描述。
 *   - 可复现：不依赖 Date.now()/随机数，单测稳定（也便于跨轮上下文压缩做指针替换）。
 *
 * 每次熔炉铸造用一个**独立实例**（new EntityRegistry()），UID 作用域=单个 envelope，
 * 不跨请求续命（与 healingLoop 会话级隔离同理，防止张冠李戴）。
 */

const crypto = require('crypto');

// 归一化：剥语气词/标点/多余空白 + 小写，使“ a.js ”“a.js！”“那个 a.js”尽量收敛到同一键。
const FILLER_RE = /(那个|这个|一个|的|了|呀|呢|吧|啊|嘛|请|帮我|麻烦|the|a|an|please|kindly)/gi;

function _normalize(desc) {
  return String(desc || '')
    .toLowerCase()
    .replace(FILLER_RE, ' ')
    .replace(/[\s,，。.!！?？;；:：'"`、]+/g, ' ')
    .trim();
}

class EntityRegistry {
  constructor() {
    this._byKey = new Map();   // normalizedKey -> entity
    this._byUid = new Map();   // uid -> entity
  }

  /**
   * 登记一个实体并取得其 UID。描述归一后若已存在则复用（指针去重），否则铸造新节点。
   *
   * @param {string} type        实体类别原语（file / url / process / topic / variable / actor …）
   * @param {string} description  自然语言里指代该实体的片段
   * @param {object} [attrs]      已抽取的原子属性（合并进现有节点，后到补全先到）
   * @returns {string} uid
   */
  mint(type, description, attrs = {}) {
    const key = `${String(type || 'entity')}::${_normalize(description)}`;
    const existing = this._byKey.get(key);
    if (existing) {
      // 复用同一拓扑节点，仅补全缺失属性（绝不重复建第二个节点）。
      existing.attrs = { ...attrs, ...existing.attrs };
      existing.mentions += 1;
      return existing.uid;
    }
    const hash = crypto.createHash('sha1').update(key).digest('hex').slice(0, 8);
    const uid = `${_uidPrefix(type)}_${hash}`;
    const entity = {
      uid,
      type: String(type || 'entity'),
      canonical: String(description || '').trim(),
      attrs: { ...attrs },
      mentions: 1,
    };
    this._byKey.set(key, entity);
    this._byUid.set(uid, entity);
    return uid;
  }

  get(uid) {
    return this._byUid.get(uid) || null;
  }

  has(uid) {
    return this._byUid.has(uid);
  }

  /** 全部实体节点（拓扑节点集合）。 */
  list() {
    return Array.from(this._byUid.values());
  }

  /** uid → 规范描述 的指针表，供上下文压缩时做指针化替换（§5）。 */
  pointerTable() {
    const table = {};
    for (const e of this._byUid.values()) table[e.uid] = e.canonical;
    return table;
  }

  /** 被多处引用（mentions>1）的实体——指针化收益最大者。 */
  deduplicatedCount() {
    let saved = 0;
    for (const e of this._byUid.values()) saved += Math.max(0, e.mentions - 1);
    return saved;
  }
}

// 类别 → UID 前缀，使 UID 自带可读语义（file_1a2b、proc_9f...）。
function _uidPrefix(type) {
  const t = String(type || 'ent').toLowerCase();
  if (t.startsWith('file')) return 'file';
  if (t.startsWith('url') || t.startsWith('link')) return 'url';
  if (t.startsWith('proc') || t.startsWith('process')) return 'proc';
  if (t.startsWith('var')) return 'var';
  if (t.startsWith('topic')) return 'topic';
  if (t.startsWith('actor') || t.startsWith('user')) return 'actor';
  return 'ent';
}

module.exports = { EntityRegistry, _normalize };
