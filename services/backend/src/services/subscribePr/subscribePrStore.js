'use strict';

/**
 * subscribePrStore.js — `/subscribe-pr` 的薄壳 IO 层:持久化 PR/分支 CI 订阅列表。
 *
 * 为什么存在:订阅需要**跨独立 `khy` 调用可发现**的落点。镜像 remoteDevSessionStore 的成熟做法:在
 * `getDataDir('pr-subscriptions')/subscriptions.json` 放一个原子写(temp + rename)的 JSON 数组,
 * best-effort、绝不抛、损坏/缺失一律当「空订阅」。
 *
 * 所有逻辑(解析、该不该通知、去抖)都在纯叶子 subscribePrPlan;本壳只做 fs 读写,绝不决策。
 */

const fs = require('fs');
const path = require('path');
const { getDataDir } = require('../../utils/dataHome');

/** 订阅列表文件绝对路径:<dataHome>/pr-subscriptions/subscriptions.json */
function listPath() {
  return path.join(getDataDir('pr-subscriptions'), 'subscriptions.json');
}

/** 读订阅数组,缺失/损坏 → []。 */
function readAll() {
  try {
    const raw = fs.readFileSync(listPath(), 'utf8');
    const obj = JSON.parse(raw);
    return Array.isArray(obj) ? obj.filter((x) => x && typeof x === 'object') : [];
  } catch {
    return [];
  }
}

/** 原子写订阅数组(temp + rename)。成功返回数组,失败 null。 */
function writeAll(subscriptions) {
  if (!Array.isArray(subscriptions)) return null;
  try {
    const file = listPath();
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(subscriptions, null, 2));
    fs.renameSync(tmp, file);
    return subscriptions;
  } catch {
    return null;
  }
}

/** 按 key upsert 一条订阅(已存在则不重复添加,返回 {list, added})。 */
function upsert(descriptor) {
  const list = readAll();
  if (!descriptor || !descriptor.key) return { list, added: false };
  const idx = list.findIndex((s) => s && s.key === descriptor.key);
  if (idx >= 0) {
    return { list, added: false }; // 已订阅,保留原记录(含 lastClassification)
  }
  list.push(descriptor);
  writeAll(list);
  return { list, added: true };
}

/** 按 key 移除一条订阅,返回 {list, removed}。 */
function remove(key) {
  const list = readAll();
  const next = list.filter((s) => !(s && s.key === key));
  const removed = next.length !== list.length;
  if (removed) writeAll(next);
  return { list: next, removed };
}

/** 更新某 key 的 lastClassification(去抖依据),best-effort。 */
function updateClassification(key, classification) {
  const list = readAll();
  let changed = false;
  for (const s of list) {
    if (s && s.key === key) { s.lastClassification = classification; changed = true; }
  }
  if (changed) writeAll(list);
  return changed;
}

module.exports = {
  listPath,
  readAll,
  writeAll,
  upsert,
  remove,
  updateClassification,
};
