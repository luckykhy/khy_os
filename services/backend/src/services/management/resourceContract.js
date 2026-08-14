'use strict';

/**
 * management/resourceContract.js — 可管理资源契约(单一真源声明)。
 *
 * KHY-OS「一切可管理、双入口、永不矛盾」长弧的地基:每个可管理对象只声明**一次**
 * 它的真源与操作实现(ops)。CLI handler 与 Web API 都只是调用这同一份 ops 的薄适配层
 * —— 两端执行的是同一个函数,故不可能不一致。矛盾从架构上消除,而非靠纪律比对。
 *
 * 设计红线:
 *   - ops 是写入真源的**唯一漏斗**;CLI/Web 都不得绕过 ops 直接读写真源。
 *   - 每个资源只有一个 sourceDetail(真源具体位置),注册时校验,杜绝双根(如 dataHome 分裂)。
 *   - capabilities 声明支持的操作;未声明的 op 不可调用(Web 404 / CLI 报错)。
 */

const SOURCE_KINDS = ['db', 'file', 'env', 'process'];

/**
 * 校验一份资源契约的形状。返回 { ok, errors }。
 * 不抛错——注册中心据此决定是否入册。
 * @param {object} contract
 */
function validateContract(contract) {
  const errors = [];
  const c = contract || {};

  if (!c.id || typeof c.id !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(c.id)) {
    errors.push('id 必须是非空小写 kebab-case 字符串(CLI 子命令 + Web 路由段共用)');
  }
  if (!c.label || typeof c.label !== 'string') {
    errors.push('label 必须是非空字符串');
  }
  if (!SOURCE_KINDS.includes(c.source)) {
    errors.push(`source 必须是 ${SOURCE_KINDS.join('|')} 之一`);
  }
  if (!c.sourceDetail || typeof c.sourceDetail !== 'string') {
    errors.push('sourceDetail 必须是非空字符串(真源唯一定位,杜绝双根)');
  }
  if (!Array.isArray(c.capabilities) || c.capabilities.length === 0) {
    errors.push('capabilities 必须是非空数组');
  }
  if (!c.ops || typeof c.ops !== 'object') {
    errors.push('ops 必须是对象(操作实现,唯一漏斗)');
  } else if (Array.isArray(c.capabilities)) {
    // 每个声明的能力都必须有对应的 op 实现;反之 ops 里也不该有未声明的能力。
    for (const cap of c.capabilities) {
      if (typeof c.ops[cap] !== 'function') {
        errors.push(`capability "${cap}" 缺少对应的 ops.${cap} 实现`);
      }
    }
    for (const opName of Object.keys(c.ops)) {
      if (!c.capabilities.includes(opName)) {
        errors.push(`ops.${opName} 未在 capabilities 中声明(能力与实现必须对齐)`);
      }
    }
  }
  if (c.schema != null && typeof c.schema !== 'object') {
    errors.push('schema 若提供必须是对象(资源项结构,供 CLI/Web 共用渲染契约)');
  }

  return { ok: errors.length === 0, errors };
}

/**
 * 标准 op 签名说明(供 resource 作者参照,不强制运行时校验):
 *   async (args, ctx) => result
 *   - args: 调用参数(CLI 解析的 options / Web 的 query|body),纯数据。
 *   - ctx:  { user, source:'cli'|'web' } —— 供审计/权限,**不改变真源选择**。
 *   - result: 纯数据(数组/对象),供两端按 schema 渲染。
 */

module.exports = {
  SOURCE_KINDS,
  validateContract,
};
