'use strict';

/**
 * routeLatencyStore.js — per-adapter 近期延迟 EWMA 存储(默认路由延迟感知的状态层)。
 *
 * `advancedDiagnostics.recordLatency` 把所有 operation 的延迟汇入一个全局指标 + 队列耗散,
 * 丢弃了 per-adapter 维度,故默认罚分器读不到「某个具体通道近期多慢」。本 store 专门补上
 * 这个维度:每个 adapter 一条指数加权移动平均(EWMA)+ 样本数 + 末次时间。
 *
 * 生命周期/持久化镜像 cacheEconomyStore.js(getDataDir + 内存 authoritative + 同步 JSON),
 * 但是**独立文件** `route_latency.json`——延迟统计的生命周期(滚动近期速度)与缓存计费累计
 * 经济学不同,不可共用一个文件。
 *
 * 纯遥测 + 一个派生统计:record 只更新 EWMA,不改任何 wire byte、不影响模型输出。唯一的行为
 * 杠杆是 getStats 被 routeLatencyPenalty 读成一笔软罚分(绝不硬 block)。record 无条件写入
 * (门关也写,无害);是否据此降权由消费侧(routeLatencyPenalty 门控)决定。
 *
 * 本文件做 fs IO,**不是纯叶子**(与 cacheEconomyStore 同待遇,不走 leafContractGuard)。
 */

const fs = require('fs');
const path = require('path');
const { getDataDir } = require('../../utils/dataHome');

// EWMA 平滑系数:新样本权重。0.3 → 约 3~4 个近期样本主导,老样本快速衰减。可 env 覆盖。
function _alpha() {
  const raw = Number(process.env.KHY_ROUTE_LATENCY_EWMA_ALPHA);
  return Number.isFinite(raw) && raw > 0 && raw <= 1 ? raw : 0.3;
}

function _num(v) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function _normalizeKey(adapterKey) {
  return String(adapterKey || '').trim().toLowerCase() || 'unknown';
}

function _emptyEntry(adapterKey) {
  return {
    adapterKey,
    ewmaMs: null, // null = 尚无样本;首样本直接置为该值。
    samples: 0,
    firstSeen: 0,
    lastSeen: 0,
  };
}

function _file() {
  return path.join(getDataDir('gateway'), 'route_latency.json');
}

// 内存 authoritative 状态(本进程拥有此文件)。惰性从磁盘播种,使近期延迟跨重启存活。
let _state = null;

function _loadState() {
  if (_state) return _state;
  try {
    const raw = JSON.parse(fs.readFileSync(_file(), 'utf-8'));
    const adapters = {};
    if (raw && typeof raw === 'object' && raw.adapters && typeof raw.adapters === 'object') {
      for (const [key, value] of Object.entries(raw.adapters)) {
        const k = _normalizeKey(key);
        const base = _emptyEntry(k);
        if (value && typeof value === 'object') {
          const e = Number(value.ewmaMs);
          base.ewmaMs = Number.isFinite(e) && e > 0 ? e : null;
          base.samples = _num(value.samples);
          base.firstSeen = _num(value.firstSeen);
          base.lastSeen = _num(value.lastSeen);
        }
        adapters[k] = base;
      }
    }
    _state = { adapters };
  } catch {
    _state = { adapters: {} };
  }
  return _state;
}

function _persist() {
  try {
    fs.writeFileSync(_file(), `${JSON.stringify(_loadState(), null, 2)}\n`, 'utf-8');
  } catch { /* best effort */ }
}

/**
 * 记录一次成功往返的延迟。非有限正数 → 忽略(fail-soft)。绝不抛。
 * @param {string} adapterKey  与 recordLatency 同口径 `adapter:<key>`
 * @param {number} latencyMs   Date.now() - startTime
 */
function record(adapterKey, latencyMs) {
  try {
    const ms = Number(latencyMs);
    if (!Number.isFinite(ms) || ms <= 0) return; // 坏样本不污染 EWMA
    const key = _normalizeKey(adapterKey);
    const state = _loadState();
    const entry = state.adapters[key] || _emptyEntry(key);
    const a = _alpha();
    entry.ewmaMs = (entry.ewmaMs === null || !Number.isFinite(entry.ewmaMs))
      ? ms
      : (a * ms) + ((1 - a) * entry.ewmaMs);
    entry.samples += 1;
    const now = Date.now();
    if (!entry.firstSeen) entry.firstSeen = now;
    entry.lastSeen = now;
    state.adapters[key] = entry;
    _persist();
  } catch { /* best effort — 遥测失败绝不影响主路径 */ }
}

/**
 * 读某 adapter 的延迟统计,供 routeLatencyPenalty 判罚。绝不抛。
 * @param {string} adapterKey
 * @returns {{ ewmaMs:number|null, samples:number, ageMs:number }}
 */
function getStats(adapterKey) {
  try {
    const key = _normalizeKey(adapterKey);
    const state = _loadState();
    const entry = state.adapters[key];
    if (!entry) return { ewmaMs: null, samples: 0, ageMs: Infinity };
    const ageMs = entry.lastSeen > 0 ? Math.max(0, Date.now() - entry.lastSeen) : Infinity;
    return { ewmaMs: entry.ewmaMs, samples: entry.samples, ageMs };
  } catch {
    return { ewmaMs: null, samples: 0, ageMs: Infinity };
  }
}

/**
 * 全量报告(运维用)。
 */
function getReport() {
  const state = _loadState();
  const now = Date.now();
  const adapters = {};
  for (const [key, entry] of Object.entries(state.adapters)) {
    adapters[key] = {
      ...entry,
      ageMs: entry.lastSeen > 0 ? Math.max(0, now - entry.lastSeen) : Infinity,
    };
  }
  return { alpha: _alpha(), adapters };
}

// 测试/运维钩子。
function _reset() {
  _state = { adapters: {} };
  try { fs.unlinkSync(_file()); } catch { /* ignore */ }
}

module.exports = {
  record,
  getStats,
  getReport,
  _reset,
};
