'use strict';

/**
 * wellKnown.js — `/.well-known/*` 路由：把 khy-os 作为**标准 A2A agent** 发布出去。
 *
 * 为什么需要它：审计发现（A2）khy 有 A2A 出站客户端，却**没有**任何服务端发现端点 ——
 * 全仓 `.well-known` 只出现在出站拉取那一行，`routes/` 下 `a2a` 零命中。结果是
 * 「khy 能调别人，别人永远发现不了 khy」，互操作是单向的。本路由补上那一半。
 *
 * 挂载点（server.js）：`app.use('/.well-known', wellKnownRoutes)`
 *
 * 端点：
 *   GET /.well-known/agent-card.json   标准 A2A v0.3.0 Agent Card（**公开**，无需鉴权）
 *   GET /.well-known/agent.json        v0.2.x 历史路径；默认 **404**，可由
 *                                      KHY_A2A_LEGACY_AGENT_JSON=1 显式打开
 *   其余路径                            404
 *
 * 为什么公开不挂 authMiddleware：A2A 规范要求 Agent Card 端点**未经鉴权即可读取** ——
 * 它正是外部 orchestrator 用来判断「要不要给我令牌」的依据。挂上鉴权会让发现流程死锁。
 * 卡片只含能力元数据，不含凭据；`securitySchemes` 描述的是**如何**鉴权，不是密钥本身。
 *
 * 为什么响应**不套** khy 的 `{success,data}` 信封：`.well-known` 是**协议边界**，
 * 响应体必须逐字段符合标准 schema，多一层信封外部客户端就读不懂了。
 * （`envelopeMiddleware` 只包装带布尔 `success` 字段的对象，故本路由天然不受影响 ——
 *   但这一点必须写在这里，否则将来有人「顺手统一格式」就会把协议打穿。）
 *
 * 门控 KHY_A2A_ENABLED（default-on，CANON off）：关 → 全部 404。
 * 零硬编码：`url` 优先取 `KHY_A2A_PUBLIC_URL`，缺省则**从请求头推导**
 * `protocol://host`，绝不写死域名/端口（AGENTS.md 工程规则 1）。
 *
 * @module routes/wellKnown
 */

const express = require('express');
const router = express.Router();

const agentCardSpec = require('../services/a2a/agentCardSpec');
const builtinAgents = require('../services/a2a/builtinAgentManifest');
const { A2A_CARD_FALLBACK_URL } = require('../constants/serviceDefaults');

/** 读取 agent 实现版本；失败回退 '0.0.0'，绝不因取不到版本而 500。 */
function resolveAgentVersion() {
  const fromEnv = String(process.env.KHY_A2A_AGENT_VERSION || '').trim();
  if (fromEnv) return fromEnv;
  try {
    // eslint-disable-next-line global-require
    const pkg = require('../../package.json');
    return String((pkg && pkg.version) || '0.0.0');
  } catch {
    return '0.0.0';
  }
}

/**
 * 推导本次请求对外可见的 base URL。
 * 优先 env（部署在反代后时，请求头里的 host 是内网地址，必须能覆盖）；
 * 否则从请求头推导 —— 这样同一份代码在 127.0.0.1 / 局域网 / 反代下都给出正确 URL。
 * @param {import('express').Request} req
 * @returns {string}
 */
function resolveBaseUrl(req) {
  const configured = String(process.env.KHY_A2A_PUBLIC_URL || '').trim();
  if (configured) return configured;
  try {
    return `${req.protocol}://${req.get('host')}`;
  } catch {
    return '';
  }
}

/**
 * 构造当前 Agent Card。任何异常都退化成「最小合法卡片」，绝不 500 ——
 * 发现端点挂掉会让所有外部 orchestrator 把 khy 判为不可用。
 * @param {import('express').Request} req
 * @returns {object}
 */
function buildCard(req) {
  const { card } = agentCardSpec.buildAgentCard({
    baseUrl: resolveBaseUrl(req),
    version: resolveAgentVersion(),
    name: 'khy-os',
    description:
      'khy-os AI platform. Publishes the built-in analyst agents over the A2A protocol; ' +
      'MCP is used for tool access.',
    // 技能来自内置 agent 清单（单一真源）—— 卡片上写的就是真实存在的 agent 能力。
    skills: builtinAgents.toSkillSeeds(),
    provider: { organization: 'khy-os' },
    defaultInputModes: ['text', 'text/plain', 'application/json'],
    defaultOutputModes: ['text', 'text/plain', 'application/json'],
  });
  return card;
}

/** 发送纯 JSON（显式不套信封）。 */
function sendJson(res, status, body) {
  res.status(status).type('application/json; charset=utf-8').send(JSON.stringify(body));
}

router.get('/agent-card.json', (req, res) => {
  if (!agentCardSpec.isPublishEnabled(process.env)) {
    return sendJson(res, 404, { error: 'A2A agent card publishing is disabled' });
  }
  try {
    return sendJson(res, 200, buildCard(req));
  } catch (error) {
    // fail-soft：回一张最小合法卡片，而不是 500。外部据此至少知道 khy 在线。
    return sendJson(res, 200, {
      protocolVersion: agentCardSpec.A2A_PROTOCOL_VERSION,
      name: 'khy-os',
      description: 'khy-os AI platform (degraded card)',
      url: resolveBaseUrl(req) || A2A_CARD_FALLBACK_URL,
      version: '0.0.0',
      capabilities: { streaming: false, pushNotifications: false, stateTransitionHistory: false },
      defaultInputModes: ['text'],
      defaultOutputModes: ['text'],
      skills: [],
    });
  }
});

router.get('/agent.json', (req, res) => {
  const enabled = String(process.env.KHY_A2A_LEGACY_AGENT_JSON || '').trim().toLowerCase();
  // 默认关：本实现遵循 v0.3.0，不主动声称一份 v0.2.x 的历史路径。
  if (!['1', 'true', 'on', 'yes'].includes(enabled)) {
    return sendJson(res, 404, {
      error: 'legacy agent.json is not published (set KHY_A2A_LEGACY_AGENT_JSON=1 to opt in)',
    });
  }
  if (!agentCardSpec.isPublishEnabled(process.env)) {
    return sendJson(res, 404, { error: 'A2A agent card publishing is disabled' });
  }
  try {
    return sendJson(res, 200, buildCard(req));
  } catch {
    return sendJson(res, 404, { error: 'failed to build agent card' });
  }
});

router.use((req, res) => sendJson(res, 404, { error: `no well-known document at ${req.path}` }));

module.exports = router;
module.exports.buildCard = buildCard;
module.exports.resolveBaseUrl = resolveBaseUrl;
module.exports.resolveAgentVersion = resolveAgentVersion;
