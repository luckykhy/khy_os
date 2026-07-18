'use strict';

/**
 * management/managementRegistry.js — 可管理资源注册中心。
 *
 * 「永不矛盾」的物理点:`invoke()` 是 CLI 与 Web **共同且唯一**的调用入口。
 * 两端都经此调用资源契约的 ops,因此对同一资源、同一操作,两端执行的是同一份代码。
 *
 * register() 时校验契约 + 真源唯一性(同一 sourceDetail 不可被两个资源占用,
 * 直接堵死 dataHome 类「双根」分裂)。
 */

const { validateContract } = require('./resourceContract');

const _resources = new Map(); // id -> contract
const _sources = new Map();   // `${source}:${sourceDetail}` -> id (真源占用表)

class ManagementError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'ManagementError';
    this.code = code || 'MANAGE_ERROR';
  }
}

/**
 * 注册一个资源契约。重复 id 覆盖前先解绑其旧真源占用(便于测试重置/热重载)。
 * @param {object} contract
 */
function register(contract) {
  const { ok, errors } = validateContract(contract);
  if (!ok) {
    throw new ManagementError(`资源契约非法 [${contract && contract.id}]: ${errors.join('; ')}`, 'INVALID_CONTRACT');
  }
  const id = contract.id;
  const sourceKey = `${contract.source}:${contract.sourceDetail}`;

  // 真源唯一性:别的资源已占用同一真源 → 拒绝(防双根/双写)。
  const owner = _sources.get(sourceKey);
  if (owner && owner !== id) {
    throw new ManagementError(`真源冲突: "${sourceKey}" 已被资源 "${owner}" 占用,不能再绑定到 "${id}"`, 'SOURCE_CONFLICT');
  }

  // 覆盖注册:先清掉该 id 旧的真源占用。
  if (_resources.has(id)) {
    const old = _resources.get(id);
    _sources.delete(`${old.source}:${old.sourceDetail}`);
  }
  _resources.set(id, contract);
  _sources.set(sourceKey, id);
  return contract;
}

/** 取资源契约;不存在返回 null。 */
function get(id) {
  return _resources.get(id) || null;
}

/** 列出全部资源 id。 */
function listIds() {
  return Array.from(_resources.keys());
}

/**
 * 统一调用入口 —— CLI 与 Web 共用。
 * @param {string} id      资源 id
 * @param {string} op      操作名(必须在 capabilities 内)
 * @param {object} [args]  操作参数
 * @param {object} [ctx]   { user, source:'cli'|'web' }
 */
async function invoke(id, op, args = {}, ctx = {}) {
  const contract = _resources.get(id);
  if (!contract) throw new ManagementError(`未知资源: ${id}`, 'UNKNOWN_RESOURCE');
  if (!contract.capabilities.includes(op)) {
    throw new ManagementError(`资源 "${id}" 不支持操作: ${op}`, 'UNSUPPORTED_OP');
  }
  const fn = contract.ops[op];
  if (typeof fn !== 'function') {
    throw new ManagementError(`资源 "${id}" 操作 "${op}" 无实现`, 'NO_IMPL');
  }
  return fn(args || {}, { source: ctx.source || 'unknown', user: ctx.user || null });
}

/**
 * 产出全量资源 × 能力矩阵(供对等守卫 + 文档 + 前端动态渲染)。
 */
function describe() {
  return listIds().sort().map((id) => {
    const c = _resources.get(id);
    return {
      id: c.id,
      label: c.label,
      source: c.source,
      sourceDetail: c.sourceDetail,
      capabilities: c.capabilities.slice(),
      schema: c.schema || null,
    };
  });
}

/** 仅供测试:清空注册表。 */
function _reset() {
  _resources.clear();
  _sources.clear();
}

module.exports = {
  register,
  get,
  listIds,
  invoke,
  describe,
  ManagementError,
  _reset,
};
