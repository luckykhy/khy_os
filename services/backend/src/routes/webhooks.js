'use strict';

/**
 * Webhooks Route — HTTP endpoints for external channel integrations.
 *
 * POST /webhooks/slack     — Slack Events API callback
 * POST /webhooks/dingtalk  — 钉钉 outgoing 机器人回调(头 timestamp+sign 验签)
 * POST /webhooks/feishu    — 飞书事件订阅(url_verification challenge + 加密事件解密)
 * GET  /webhooks/wecom     — 企业微信回调地址校验(echostr)
 * POST /webhooks/wecom     — 企业微信加密消息(msg_signature 验签 + 解密)
 *
 * 诚实边界:入站要真正跑通需要一个「公网可达」的本服务地址,并在对应平台后台把该地址填入
 * 机器人/事件订阅配置。本路由负责验签、解密、解析并 emit 'message';消息进一步交给 AI 处理
 * 依赖 messageRouter.setAIHandler(现状未接线,与 Slack 一致),故未配置 AI handler 时消息会被
 * 记录后丢弃 —— 这是既有限制,不在本次范围内。
 *
 * Register this router in the Express app:
 *   app.use('/webhooks', require('./routes/webhooks'));
 */

const express = require('express');
const router = express.Router();
const log = require('../utils/logger');

/**
 * Slack Events API endpoint.
 * Handles:
 *   - URL verification challenge
 *   - Event callbacks (message, app_mention)
 */
router.post('/slack', express.raw({ type: 'application/json' }), (req, res) => {
  const rawBody = req.body.toString('utf-8');
  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return res.status(400).json({ error: 'Invalid JSON' });
  }

  // URL verification challenge
  if (payload.type === 'url_verification') {
    return res.json({ challenge: payload.challenge });
  }

  // Verify signature
  const slackChannel = _getSlackChannel();
  if (slackChannel) {
    const sig = req.headers['x-slack-signature'];
    const ts = req.headers['x-slack-request-timestamp'];
    if (sig && ts && !slackChannel.verifySignature(sig, ts, rawBody)) {
      log.warn('Slack webhook signature verification failed');
      return res.status(401).json({ error: 'Invalid signature' });
    }
  }

  // Respond immediately (Slack requires < 3s response)
  res.status(200).json({ ok: true });

  // Process event asynchronously
  if (payload.type === 'event_callback' && payload.event) {
    if (slackChannel) {
      slackChannel.handleWebhookEvent(payload.event);
    } else {
      log.warn('Slack webhook received but no SlackChannel registered');
    }
  }
});

function _getSlackChannel() {
  try {
    const { getMessageRouter } = require('../services/channels/messageRouter');
    const router = getMessageRouter();
    const channels = router.getChannels();
    const slack = channels.find(ch => ch.name === 'slack');
    if (slack) {
      // Access internal channel map via router
      return router._channels?.get('slack') || null;
    }
  } catch { /* not registered */ }
  return null;
}

/** 取某个已注册的消息渠道(dingtalk/feishu/wecom),未注册返回 null。 */
function _getChannel(name) {
  try {
    const { getMessageRouter } = require('../services/channels/messageRouter');
    return getMessageRouter()._channels?.get(name) || null;
  } catch {
    return null;
  }
}

/**
 * 钉钉 outgoing 机器人回调。请求头带 timestamp + sign(HMAC-SHA256 验签)。
 */
router.post('/dingtalk', express.raw({ type: '*/*' }), (req, res) => {
  let payload;
  try {
    payload = JSON.parse(req.body.toString('utf-8'));
  } catch {
    return res.status(400).json({ error: 'Invalid JSON' });
  }
  const ch = _getChannel('dingtalk');
  if (!ch) {
    log.warn('dingtalk webhook received but no channel registered');
    return res.status(200).json({ ok: true });
  }
  const result = ch.handleInbound(
    { timestamp: req.headers.timestamp, sign: req.headers.sign },
    payload,
  );
  if (!result.ok) {
    log.warn(`dingtalk webhook rejected: ${result.error}`);
    return res.status(401).json({ error: result.error });
  }
  return res.status(200).json({ ok: true });
});

/**
 * 飞书事件订阅回调。首次配置回调地址时发 url_verification challenge;
 * 之后的事件可能是加密的(由 channel 的 encryptKey 解密)。
 */
router.post('/feishu', express.raw({ type: '*/*' }), (req, res) => {
  let payload;
  try {
    payload = JSON.parse(req.body.toString('utf-8'));
  } catch {
    return res.status(400).json({ error: 'Invalid JSON' });
  }
  const ch = _getChannel('feishu');
  if (!ch) {
    // 未注册时仍要能回明文 challenge,否则配置阶段无法通过。
    if (payload && payload.type === 'url_verification') {
      return res.json({ challenge: payload.challenge });
    }
    log.warn('feishu webhook received but no channel registered');
    return res.status(200).json({ ok: true });
  }
  const result = ch.handleInbound(payload);
  if (result.ok && result.kind === 'challenge') {
    return res.json({ challenge: result.challenge });
  }
  if (!result.ok) {
    log.warn(`feishu webhook rejected: ${result.error}`);
    return res.status(401).json({ error: result.error });
  }
  return res.status(200).json({ ok: true });
});

/**
 * 企业微信回调地址校验(GET,携 echostr)。返回解密后的明文。
 */
router.get('/wecom', (req, res) => {
  const ch = _getChannel('wecom');
  if (!ch) {
    log.warn('wecom verify received but no channel registered');
    return res.status(200).send('');
  }
  const result = ch.handleInbound({
    msgSignature: req.query.msg_signature,
    timestamp: req.query.timestamp,
    nonce: req.query.nonce,
    echostr: req.query.echostr,
  });
  if (result.ok && result.kind === 'verify') {
    return res.status(200).send(result.plaintext);
  }
  return res.status(401).send('');
});

/**
 * 企业微信加密消息(POST,XML body + query msg_signature/timestamp/nonce)。
 * 被动响应留空 200 即可(不做加密被动回复)。
 */
router.post('/wecom', express.raw({ type: '*/*' }), (req, res) => {
  const ch = _getChannel('wecom');
  const xmlBody = req.body ? req.body.toString('utf-8') : '';
  if (!ch) {
    log.warn('wecom webhook received but no channel registered');
    return res.status(200).send('');
  }
  const result = ch.handleInbound({
    msgSignature: req.query.msg_signature,
    timestamp: req.query.timestamp,
    nonce: req.query.nonce,
    xmlBody,
  });
  if (!result.ok) {
    log.warn(`wecom webhook rejected: ${result.error}`);
    return res.status(401).send('');
  }
  return res.status(200).send('');
});

module.exports = router;
