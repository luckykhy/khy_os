'use strict';

/**
 * proxySubscription.js — 「代理管理」订阅组 HTTP 路由。
 *
 * 前端粘贴订阅地址即添加订阅组(仿 Clash Verge 的订阅 → 代理组流程):
 *   GET    /            列出当前用户的订阅组(不含 nodes 明细)
 *   GET    /:id         取单个订阅组(含 nodes 明细)
 *   POST   /            {url, name?} → 抓取解析并落库;或 {content, name?} → 原始内容导入(免 fetch/SSRF)
 *   POST   /:id/refresh 重新抓取并刷新该组节点
 *   DELETE /:id         删除订阅组
 *
 * 安全:用户提供的订阅 URL 是 SSRF 敏感面 —— 抓取前**必须**经 ssrfGuard.validateUrl 解析校验
 * (拒非 http(s) 协议 / 私网 IP / 元数据地址)。抓取复用 proxyConfigService.requestTextWithMeta(带
 * 重定向、gzip 解码,并带回 subscription-userinfo 头供流量/到期进度条),内容解码后交纯叶子
 * proxyNodeParse.parseProxyNodes 解成节点对象。`content` 原始导入分支无网络 = 无 SSRF 面,直接解析。
 *
 * 挂载点(server.js)带 authMiddleware,故 req.user.id 恒可用,按用户命名空间隔离。
 */

const express = require('express');
const router = express.Router();

const ssrfGuard = require('../services/ssrfGuard');
const proxyConfigService = require('../services/proxyConfigService');
const { parseProxyNodes } = require('../services/proxyNodeParse');
const { parseSubscriptionUserinfo } = require('../services/subscriptionUserinfo');
const store = require('../services/proxySubscriptionStore');

const FETCH_TIMEOUT_MS = 15000;

function _ownerId(req) {
  return String(req?.user?.id || '');
}

// 收敛到 utils/trimIfString 单一真源(逐字节委托,调用点不变)
const _trim = require('../utils/trimIfString');

// 把已抓/已贴的文本解析为节点结果(整段 base64 兜底重解)。纯解析,无网络。
function _parseText(text) {
  let result = parseProxyNodes(text);
  if (result.nodes.length === 0) {
    const b64 = _tryDecodeBase64(text);
    if (b64) {
      const retry = parseProxyNodes(b64);
      if (retry.nodes.length > 0) result = retry;
    }
  }
  return result;
}

// 抓取订阅 URL(SSRF 校验 → requestTextWithMeta → 节点解析 + subscription-userinfo 元信息)。
async function _fetchAndParse(url) {
  // 1) SSRF 闸门:拒非 http(s)、私网、元数据地址。抛 SsrfBlockedError。
  await ssrfGuard.validateUrl(url);

  // 2) 抓取正文 + 响应头(复用既有带重定向/解压的抓取器)。
  const { text, headers } = await proxyConfigService.requestTextWithMeta(url, FETCH_TIMEOUT_MS);

  // 3) 解析为节点对象。订阅常是**整段 base64**,proxyNodeParse 只吃已解码文本,故先原样试,
  //    解不出且像 base64 blob 则解码再试(与 proxyConfigService 的 base64 判定一致)。
  const result = _parseText(text);

  // 4) 流量/到期元信息(subscription-userinfo 头;Node 已把头名小写)。纯叶子 fail-soft → null。
  const userinfo = parseSubscriptionUserinfo(headers && headers['subscription-userinfo'], process.env, { nowMs: Date.now() });

  return { result, userinfo };
}

function _tryDecodeBase64(raw) {
  const text = String(raw || '').trim().replace(/\s+/g, '');
  if (!text || text.length < 24) return '';
  if (!/^[A-Za-z0-9+/_=-]+$/.test(text)) return '';
  try {
    let std = text.replace(/-/g, '+').replace(/_/g, '/');
    const mod = std.length % 4;
    if (mod !== 0) std += '='.repeat(4 - mod);
    const out = Buffer.from(std, 'base64').toString('utf8');
    return out && out.trim() ? out : '';
  } catch {
    return '';
  }
}

// GET / — 列出订阅组(不含 nodes)
router.get('/', (req, res) => {
  try {
    const groups = store.listGroups(_ownerId(req));
    return res.json({ success: true, data: { total: groups.length, subscriptions: groups } });
  } catch (error) {
    return res.status(500).json({ success: false, message: `查询订阅组失败: ${error.message}`, data: null });
  }
});

// GET /:id — 单个订阅组(含 nodes)
router.get('/:id', (req, res) => {
  try {
    const group = store.getGroup(_ownerId(req), req.params.id);
    if (!group) {
      return res.status(404).json({ success: false, message: '未找到该订阅组', data: null });
    }
    return res.json({ success: true, data: group });
  } catch (error) {
    return res.status(500).json({ success: false, message: `查询订阅组失败: ${error.message}`, data: null });
  }
});

// POST / — 新增订阅组 {url, name?} 或 {content, name?}(原始内容导入,免 fetch/SSRF)
router.post('/', async (req, res) => {
  const url = _trim(req.body?.url);
  const content = _trim(req.body?.content);
  const name = _trim(req.body?.name);
  if (!url && !content) {
    return res.status(400).json({ success: false, message: '订阅地址或订阅内容不能为空', data: null });
  }
  try {
    let result;
    let userinfo = null;
    if (url) {
      const fetched = await _fetchAndParse(url);
      result = fetched.result;
      userinfo = fetched.userinfo;
    } else {
      // 原始内容导入:本地文件/裸贴 → 无网络 = 无 SSRF 面,直接解析。
      result = _parseText(content);
    }
    if (result.nodes.length === 0) {
      return res.status(422).json({
        success: false,
        message: url
          ? '未能从该订阅地址解析出任何代理节点,请确认链接有效'
          : '未能从该内容解析出任何代理节点,请确认格式(节点链接 / Clash YAML / base64)',
        data: null,
      });
    }
    const group = store.addGroup({
      ownerId: _ownerId(req),
      name: name || (url ? _defaultName(url) : '本地导入'),
      url: url || '',
      format: result.format,
      nodes: result.nodes,
      protocolCount: result.protocolCount,
      userinfo,
    });
    return res.json({ success: true, data: group });
  } catch (error) {
    if (error && error.name === 'SsrfBlockedError') {
      return res.status(400).json({ success: false, message: `订阅地址被安全策略拒绝: ${error.message}`, data: null });
    }
    return res.status(502).json({ success: false, message: `添加订阅组失败: ${error.message}`, data: null });
  }
});

// POST /:id/refresh — 重新抓取刷新
router.post('/:id/refresh', async (req, res) => {
  const ownerId = _ownerId(req);
  const group = store.getGroup(ownerId, req.params.id);
  if (!group) {
    return res.status(404).json({ success: false, message: '未找到该订阅组', data: null });
  }
  try {
    const { result, userinfo } = await _fetchAndParse(group.url);
    if (result.nodes.length === 0) {
      const updated = store.updateGroup(ownerId, group.id, { lastError: '刷新时未解析出节点' });
      return res.status(422).json({ success: false, message: '刷新时未解析出任何节点', data: updated });
    }
    const updated = store.updateGroup(ownerId, group.id, {
      nodes: result.nodes,
      protocolCount: result.protocolCount,
      format: result.format,
      userinfo,
      lastError: null,
    });
    return res.json({ success: true, data: updated });
  } catch (error) {
    const updated = store.updateGroup(ownerId, group.id, { lastError: error.message });
    if (error && error.name === 'SsrfBlockedError') {
      return res.status(400).json({ success: false, message: `订阅地址被安全策略拒绝: ${error.message}`, data: updated });
    }
    return res.status(502).json({ success: false, message: `刷新订阅组失败: ${error.message}`, data: updated });
  }
});

// DELETE /:id — 删除订阅组
router.delete('/:id', (req, res) => {
  try {
    const ok = store.removeGroup(_ownerId(req), req.params.id);
    if (!ok) {
      return res.status(404).json({ success: false, message: '未找到该订阅组', data: null });
    }
    return res.json({ success: true, data: { removed: true } });
  } catch (error) {
    return res.status(500).json({ success: false, message: `删除订阅组失败: ${error.message}`, data: null });
  }
});

function _defaultName(url) {
  try {
    const host = new URL(url).hostname;
    return host || '订阅组';
  } catch {
    return '订阅组';
  }
}

module.exports = router;
