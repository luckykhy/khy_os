'use strict';

/**
 * agentCardSpec.js — 纯叶子（零 IO、确定性、绝不抛、可单测）：标准 A2A Agent Card 的
 * 单一真源。
 *
 * 定位：khy-os 长期有两套「A2A」——一套是 `a2aRegistry` / `acpTransport` 那套**进程内
 * 私有 ACP 方言**（方法名形如 `<域>.<动作>`，与标准 A2A 的斜杠方法集毫无交集，见
 * `[DESIGN-NAM-002]` 的术语表），另一套是 `services/a2a/index.js` 那个 127 行的
 * **出站 HTTP 客户端**。前者从未发布过 Agent Card，后者的 `createLocalAgentCard()`
 * 只返回一个本地对象、字段还不符规范
 * （`authentication.schemes` 不是 A2A 字段，正确写法是 `securitySchemes` +
 * `security`；`capabilities.streaming: true` 是**空声明** —— 全仓没有一行 SSE 实现）。
 *
 * 本叶子把「发布出去的那张卡片长什么样」收敛成一个纯粹的数据变换：调用方把
 * 版本、公开 URL、技能清单、以及**真正实现了哪些能力**喂进来，得到一张
 * 通过 `src/contracts/a2a/agent-card.schema.json` 的卡片。
 *
 * 契约：
 *   - 零 IO —— 不读盘、不读 network、不读 package.json。版本号/URL 一律由调用方传入，
 *     或经 `opts.env`（默认 process.env）读取（env 是纯数据，不是 IO）。
 *   - 确定性 —— 同样输入必得同样输出；无时间戳、无随机数。
 *   - 绝不抛 —— 任何畸形输入都退化为安全默认值并在 `warnings` 里说明。
 *
 * 门控 KHY_A2A_ENABLED（default-on，CANON off）：关 → `isPublishEnabled()` 恒 false，
 * 路由不发布卡片、`/.well-known/agent-card.json` 回 404。本叶子自身只做数据变换，
 * 门控只决定「要不要把它挂出去」，由调用方（路由）判定。
 */

// ── 常量（协议层单一真源）─────────────────────────────────────────────────

const { A2A_CARD_FALLBACK_URL } = require('../../constants/serviceDefaults');

/** 本实现遵循的 A2A 协议修订。 */
const A2A_PROTOCOL_VERSION = '0.3.0';

/** Agent Card 的标准发布路径（RFC 8615 well-known URI）。 */
const AGENT_CARD_WELL_KNOWN_PATH = '/.well-known/agent-card.json';

/** v0.2.x 的历史路径。保留以兼容只认旧路径的客户端（可选发布，默认关）。 */
const AGENT_CARD_LEGACY_WELL_KNOWN_PATH = '/.well-known/agent.json';

/**
 * A2A v0.3.0 的 JSON-RPC 方法名（斜杠分隔：`<域>/<动作>`）。
 * 注意与私有 ACP 方言**毫无关系** —— 后者的方法是点分形式（`<域>.<动作>`），
 * 且作用域仅限单进程内。两者命名撞车而已，见 `[DESIGN-NAM-002]` 术语表。
 */
const A2A_METHODS = Object.freeze({
  SEND_MESSAGE: 'message/send',
  SEND_STREAMING_MESSAGE: 'message/stream',
  GET_TASK: 'tasks/get',
  LIST_TASKS: 'tasks/list',
  CANCEL_TASK: 'tasks/cancel',
  RESUBSCRIBE_TASK: 'tasks/resubscribe',
  PUSH_CONFIG_SET: 'tasks/pushNotificationConfig/set',
  PUSH_CONFIG_GET: 'tasks/pushNotificationConfig/get',
  PUSH_CONFIG_LIST: 'tasks/pushNotificationConfig/list',
  PUSH_CONFIG_DELETE: 'tasks/pushNotificationConfig/delete',
  GET_EXTENDED_CARD: 'agent/getAuthenticatedExtendedCard',
});

/**
 * A2A 协议自有错误码（JSON-RPC 2.0 实现级区间 -32000 ~ -32099）。
 * 历史上私有 ACP 用了 -40001 一类区间外编号（见审计 A11），标准 A2A 不使用那套。
 */
const A2A_ERROR_CODES = Object.freeze({
  TASK_NOT_FOUND: -32001,
  TASK_NOT_CANCELABLE: -32002,
  PUSH_NOTIFICATION_NOT_SUPPORTED: -32003,
  UNSUPPORTED_OPERATION: -32004,
  CONTENT_TYPE_NOT_SUPPORTED: -32005,
  INVALID_AGENT_RESPONSE: -32006,
});

/**
 * khy-os **当前真正实现**的 A2A 能力。
 *
 * 这三个布尔值是整张卡片里最容易被写错、后果最严重的一组字段：客户端读到
 * `streaming: true` 就会走 `message/stream`，而 khy 没有 SSE 实现 → 必然失败。
 * 因此这里**写死为实测结果**，并由 `scripts/ci/check-protocol-conformance.js`
 * 断言「声明为 true 的能力在代码里确有其事」。要打开某一项，先在代码里把它做出来、
 * 再把这里的布尔改成 true —— 不允许反过来先改卡片。
 *
 * - streaming: `message/stream` 与 `TaskStatusUpdateEvent` / `TaskArtifactUpdateEvent`
 *   —— 零实现，故 false。
 * - pushNotifications: `tasks/pushNotificationConfig/*` —— 零实现，故 false。
 * - stateTransitionHistory: `tasks/get` 返回完整状态迁移历史 —— 未暴露，故 false。
 */
const IMPLEMENTED_CAPABILITIES = Object.freeze({
  streaming: false,
  pushNotifications: false,
  stateTransitionHistory: false,
});

const FALSY = new Set(['0', 'false', 'off', 'no']);

/**
 * A2A 发布总闸是否打开。flagRegistry 优先，注册表不可用 → 本地 4 词 CANON 回退。
 * @param {object} [env]
 * @returns {boolean}
 */
function isPublishEnabled(env = process.env) {
  const e = env || {};
  const v = e.KHY_A2A_ENABLED;
  return !(v !== undefined && v !== null && FALSY.has(String(v).trim().toLowerCase()));
}

// ── 输入归一 ──────────────────────────────────────────────────────────────

/** 去掉字符串首尾空白；非字符串 → ''。 */
function asText(v) {
  return typeof v === 'string' ? v.trim() : '';
}

/**
 * 归一一个公开 base URL：去尾斜杠、只接受 http(s)、无 scheme 时补 http://。
 * 非法输入 → null（由调用方决定回退策略，本叶子不猜）。
 *
 * 注意「已带 scheme 但不是 http(s)」必须先判出来 —— 早期实现只看开头是不是
 * `http(s)://`，于是 `ftp://a.example` 被当成「没带 scheme」补成
 * `http://ftp://a.example`，再被 URL 解析成主机名 `ftp`、路径 `//a.example`
 * 这种荒谬结果，而且**不会**返回 null（静默产出坏 URL）。
 *
 * @param {string} raw
 * @returns {string|null}
 */
function normalizeBaseUrl(raw) {
  const s = asText(raw);
  if (!s) return null;
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(s);
  if (hasScheme && !/^https?:\/\//i.test(s)) return null;
  const withScheme = hasScheme ? s : `http://${s}`;
  const trimmed = withScheme.replace(/\/+$/, '');
  try {
    const u = new URL(trimmed);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, '')}`;
  } catch {
    return null;
  }
}

/**
 * khy 的「能力标签」→ 规范 AgentSkill。
 *
 * khy 内部的能力名是裸串（如 `technical_analysis`），规范要求 `id` / `name` /
 * `description` / `tags` 四项必填。这里做一次确定性映射：`id` 直接用能力名，
 * `name` 做可读化，`tags` 用能力名的下划线段，`description` 显式说明它是
 * 从能力标签推导出来的（而不是编一个听起来很厉害但没人验证过的描述）。
 *
 * @param {string} capability
 * @returns {{id:string,name:string,description:string,tags:string[]}}
 */
function skillFromCapability(capability) {
  const id = asText(capability).replace(/\s+/g, '_');
  const words = id.split(/[_\-.]/).filter(Boolean);
  const name = words.length ? words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ') : id;
  return {
    id,
    name: name || id,
    description: `khy-os capability \`${id}\`.`,
    tags: words.length ? words : [id],
  };
}

/**
 * 归一技能清单：接受字符串数组或已是规范形状的对象，输出规范 AgentSkill 数组。
 * 非法项被丢弃（不抛），条目数去重（按 id，后者覆盖前者）。
 * @param {Array<string|object>} [skills]
 * @returns {Array<object>}
 */
function normalizeSkills(skills) {
  const list = Array.isArray(skills) ? skills : [];
  const byId = new Map();
  for (const item of list) {
    let skill = null;
    if (typeof item === 'string') {
      skill = skillFromCapability(item);
    } else if (item && typeof item === 'object') {
      const id = asText(item.id) || asText(item.name);
      if (!id) continue;
      skill = {
        id,
        name: asText(item.name) || id,
        description: asText(item.description) || `khy-os capability \`${id}\`.`,
        tags: Array.isArray(item.tags) && item.tags.length ? item.tags.map(String) : [id],
      };
      if (Array.isArray(item.examples) && item.examples.length) {
        skill.examples = item.examples.map(String);
      }
      if (Array.isArray(item.inputModes) && item.inputModes.length) {
        skill.inputModes = item.inputModes.map(String);
      }
      if (Array.isArray(item.outputModes) && item.outputModes.length) {
        skill.outputModes = item.outputModes.map(String);
      }
    }
    if (skill && skill.id) byId.set(skill.id, skill);
  }
  return [...byId.values()];
}

// ── 构形 ──────────────────────────────────────────────────────────────────

/**
 * 构造一张**符合 A2A v0.3.0 且诚实**的 Agent Card。
 *
 * @param {object} [opts]
 * @param {string} [opts.baseUrl]       A2A 端点基址（必须由调用方给出；无 → warnings + 占位）
 * @param {string} [opts.version]       agent 实现版本（不是协议版本）
 * @param {string} [opts.name]
 * @param {string} [opts.description]
 * @param {Array<string|object>} [opts.skills]
 * @param {{organization?:string,url?:string}} [opts.provider]
 * @param {string} [opts.documentationUrl]
 * @param {Array<string>} [opts.defaultInputModes]
 * @param {Array<string>} [opts.defaultOutputModes]
 * @param {{streaming?:boolean,pushNotifications?:boolean,stateTransitionHistory?:boolean}} [opts.capabilities]
 *        覆盖实现态的能力（仅供「已经真的做了」的调用方使用；缺省取 IMPLEMENTED_CAPABILITIES）
 * @param {object} [opts.securitySchemes]
 * @param {Array<object>} [opts.security]
 * @param {boolean} [opts.supportsAuthenticatedExtendedCard]
 * @param {object} [opts.env]
 * @returns {{card: object, warnings: string[]}}
 */
function buildAgentCard(opts = {}) {
  const o = opts && typeof opts === 'object' ? opts : {};
  const warnings = [];

  const url = normalizeBaseUrl(o.baseUrl);
  if (!url) {
    warnings.push('baseUrl 缺失或非法 → 卡片 url 回落到占位地址（端口 0，不可用于真实发现）');
  }

  const name = asText(o.name) || 'khy-os';
  const description = asText(o.description) || 'khy-os AI platform agent';
  const version = asText(o.version) || '0.0.0';

  const skills = normalizeSkills(o.skills);
  if (skills.length === 0) {
    warnings.push('skills 为空 → 外部 orchestrator 无法判断本 agent 能做什么（卡片仍然合法）');
  }

  const caps = Object.assign({}, IMPLEMENTED_CAPABILITIES);
  const override = o.capabilities && typeof o.capabilities === 'object' ? o.capabilities : {};
  for (const key of Object.keys(IMPLEMENTED_CAPABILITIES)) {
    if (override[key] === true) caps[key] = true;
  }

  const card = {
    protocolVersion: A2A_PROTOCOL_VERSION,
    name,
    description,
    url: url || A2A_CARD_FALLBACK_URL,
    version,
    capabilities: {
      streaming: caps.streaming === true,
      pushNotifications: caps.pushNotifications === true,
      stateTransitionHistory: caps.stateTransitionHistory === true,
    },
    defaultInputModes:
      Array.isArray(o.defaultInputModes) && o.defaultInputModes.length
        ? o.defaultInputModes.map(String)
        : ['text'],
    defaultOutputModes:
      Array.isArray(o.defaultOutputModes) && o.defaultOutputModes.length
        ? o.defaultOutputModes.map(String)
        : ['text'],
    skills,
  };

  if (asText(o.documentationUrl)) {
    card.documentationUrl = asText(o.documentationUrl);
  }
  if (o.provider && typeof o.provider === 'object' && asText(o.provider.organization)) {
    card.provider = { organization: asText(o.provider.organization) };
    if (asText(o.provider.url)) card.provider.url = asText(o.provider.url);
  }
  if (o.securitySchemes && typeof o.securitySchemes === 'object') {
    card.securitySchemes = o.securitySchemes;
  }
  if (Array.isArray(o.security) && o.security.length) {
    card.security = o.security;
  }
  if (o.supportsAuthenticatedExtendedCard === true) {
    card.supportsAuthenticatedExtendedCard = true;
  }

  return { card, warnings };
}

/**
 * 结构自检：不依赖 ajv 的轻量形状校验（守卫之外再兜一层，用于运行期快速失败）。
 * @param {object} card
 * @returns {{ok: boolean, errors: string[]}}
 */
function validateCardShape(card) {
  const errors = [];
  const c = card && typeof card === 'object' ? card : null;
  if (!c) return { ok: false, errors: ['card 不是对象'] };

  const required = ['protocolVersion', 'name', 'description', 'url', 'version', 'capabilities'];
  for (const key of required) {
    if (c[key] === undefined || c[key] === null || c[key] === '') {
      errors.push(`缺必填字段: ${key}`);
    }
  }
  if (!/^\d+\.\d+(\.\d+)?$/.test(String(c.protocolVersion || ''))) {
    errors.push(`protocolVersion 非 semver 形: ${c.protocolVersion}`);
  }
  if (asText(c.url).endsWith('/')) {
    errors.push('url 不应带尾斜杠（规范要求不带）');
  }
  for (const key of ['defaultInputModes', 'defaultOutputModes', 'skills']) {
    if (!Array.isArray(c[key])) errors.push(`${key} 必须是数组`);
  }
  if (Array.isArray(c.defaultInputModes) && c.defaultInputModes.length === 0) {
    errors.push('defaultInputModes 不能为空数组');
  }
  if (Array.isArray(c.defaultOutputModes) && c.defaultOutputModes.length === 0) {
    errors.push('defaultOutputModes 不能为空数组');
  }
  if (c.security && !c.securitySchemes) {
    errors.push('声明了 security 却没有 securitySchemes（引用悬空）');
  }
  if (Array.isArray(c.skills)) {
    c.skills.forEach((s, i) => {
      for (const key of ['id', 'name', 'description', 'tags']) {
        if (!s || s[key] === undefined) errors.push(`skills[${i}] 缺 ${key}`);
      }
      if (s && !Array.isArray(s.tags)) errors.push(`skills[${i}].tags 必须是数组`);
    });
  }
  return { ok: errors.length === 0, errors };
}

module.exports = {
  A2A_PROTOCOL_VERSION,
  AGENT_CARD_WELL_KNOWN_PATH,
  AGENT_CARD_LEGACY_WELL_KNOWN_PATH,
  A2A_METHODS,
  A2A_ERROR_CODES,
  IMPLEMENTED_CAPABILITIES,
  isPublishEnabled,
  normalizeBaseUrl,
  skillFromCapability,
  normalizeSkills,
  buildAgentCard,
  validateCardShape,
};
