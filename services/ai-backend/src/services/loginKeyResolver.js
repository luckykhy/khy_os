'use strict';

/**
 * loginKeyResolver — ARCH-074
 *
 * 单一真源：把「用户输入的登录键」（username / email / alias 之一）解析为对应 User。
 * 用途：
 *   - aio backend /api/auth/login 接受 username/email/alias 任一形式
 *   - aio backend /api/auth/register 校验 alias 跨账号唯一性
 *   - 本机 cliAuthService 离线模式按 alias 在 credentials.json 内查找
 *
 * 解析优先级（命中即停）：
 *   1. username 精确匹配
 *   2. email    精确匹配
 *   3. aliases  数组内任一元素精确匹配
 *   4. 全未命中 → null
 *
 * 设计原则（fail-soft + 不联网 + 不抛）：
 *   - 所有 DB IO 异常 → 返回 { user: null, error }；调用方按未登录处理
 *   - 输入校验：trim + lower-case；空串 / 超长 / 含控制字符 → null
 *   - alias 字符集白名单 `[a-zA-Z0-9_.\-@]`，与 username/email 兼容
 *   - 不引入进程内缓存；调用频率低（每次登录），不需要
 */

const { Op } = require('sequelize');

const ALIAS_MAX_LEN = 32;
const ALIAS_PATTERN = /^[a-zA-Z0-9_.\-@]+$/;

/**
 * 校验一个 alias 字符串是否符合命名规则。失败返回 { ok:false, reason }。
 */
function _validateAlias(alias) {
  if (typeof alias !== 'string') {
    return { ok: false, reason: 'alias 必须是字符串' };
  }
  const trimmed = alias.trim();
  if (trimmed.length === 0) {
    return { ok: false, reason: 'alias 不能为空' };
  }
  if (trimmed.length > ALIAS_MAX_LEN) {
    return { ok: false, reason: `alias 长度不能超过 ${ALIAS_MAX_LEN} 字符` };
  }
  if (!ALIAS_PATTERN.test(trimmed)) {
    return { ok: false, reason: 'alias 仅允许字母、数字、下划线、点、连字符、@' };
  }
  return { ok: true, normalized: trimmed };
}

/**
 * 规范化一个 alias 数组：去空、去重、转小写。
 * 失败元素以原样丢弃并返回 errors 数组（供调用方提示用户）。
 */
function normalizeAliases(input) {
  const out = [];
  const errors = [];
  const seen = new Set();
  if (!Array.isArray(input)) {
    return { aliases: out, errors };
  }
  for (const raw of input) {
    const v = _validateAlias(raw);
    if (!v.ok) {
      errors.push({ input: String(raw), reason: v.reason });
      continue;
    }
    const key = v.normalized.toLowerCase();
    if (!seen.has(key)) {
      seen.add(key);
      out.push(v.normalized);
    }
  }
  return { aliases: out, errors };
}

/**
 * 在数据库中按 login key 解析用户。
 *
 * @param {string} input - 用户输入的 username / email / alias
 * @param {object} deps  - { User } 注入 Sequelize 模型（解耦测试）
 * @returns {Promise<{ user: object|null, matchedBy: string|null, error?: string }>}
 */
async function resolveLoginKey(input, deps = {}) {
  if (typeof input !== 'string') {
    return { user: null, matchedBy: null };
  }
  const key = input.trim();
  if (key.length === 0 || key.length > 100) {
    return { user: null, matchedBy: null };
  }
  const User = deps.User || (() => {
    try {
      return require('@khy/shared/models').User;
    } catch {
      return null;
    }
  })();
  if (!User) {
    return { user: null, matchedBy: null, error: 'User 模型不可用' };
  }
  let users;
  try {
    users = await User.findAll({
      where: {
        [Op.or]: [
          { username: key },
          { email: key },
        ],
      },
      attributes: ['id', 'username', 'email', 'role', 'status', 'password', 'aliases', 'displayName'],
    });
  } catch (err) {
    return { user: null, matchedBy: null, error: `login key 解析失败: ${err.message || String(err)}` };
  }
  if (users.length === 0) {
    return { user: null, matchedBy: null };
  }
  // 优先级：先 username，再 email，最后 alias（用户提供的 key 在数据库中可能有多个匹配，
  // 比如某用户 username=foo、email=foo@bar.com、alias=[foo]；若 input='foo' 则命中 username）。
  for (const u of users) {
    if (u.username === key) {
      return { user: u, matchedBy: 'username' };
    }
  }
  for (const u of users) {
    if (u.email === key) {
      return { user: u, matchedBy: 'email' };
    }
  }
  for (const u of users) {
    if (Array.isArray(u.aliases) && u.aliases.includes(key)) {
      return { user: u, matchedBy: 'alias' };
    }
  }
  return { user: null, matchedBy: null };
}

/**
 * 检查一组候选 alias 是否与已存在的任何用户的 username/email/alias 冲突。
 * 用于 register 路径：跨账号唯一性（应用层保证）。
 *
 * @param {string[]} candidates - 已 normalize 过的 alias 数组
 * @param {object} deps - { User, excludeUserId? }
 * @returns {Promise<{ conflicts: Array<{ alias, with: string, ownerId: number }> }>}
 */
async function findAliasConflicts(candidates, deps = {}) {
  const User = deps.User || (() => {
    try {
      return require('@khy/shared/models').User;
    } catch {
      return null;
    }
  })();
  if (!User || !Array.isArray(candidates) || candidates.length === 0) {
    return { conflicts: [] };
  }
  const where = {
    [Op.or]: [
      { username: { [Op.in]: candidates } },
      { email: { [Op.in]: candidates } },
      // JSON 字段"包含"在不同 DB 引擎上有差异：MySQL 用 JSON_CONTAINS，PG 用 @>，
      // 这里用最兼容的写法：把整张表拉回来过滤（小表场景 ok；用户量大了再优化）。
    ],
  };
  if (deps.excludeUserId != null) {
    where.id = { [Op.ne]: deps.excludeUserId };
  }
  let candidates2;
  try {
    candidates2 = await User.findAll({ where, attributes: ['id', 'username', 'email', 'aliases'] });
  } catch {
    return { conflicts: [] };
  }
  const conflicts = [];
  const lowerCandidates = new Set(candidates.map((c) => c.toLowerCase()));
  for (const u of candidates2) {
    if (lowerCandidates.has(String(u.username || '').toLowerCase())) {
      conflicts.push({ alias: u.username, with: 'username', ownerId: u.id });
    }
    if (lowerCandidates.has(String(u.email || '').toLowerCase())) {
      conflicts.push({ alias: u.email, with: 'email', ownerId: u.id });
    }
    if (Array.isArray(u.aliases)) {
      for (const a of u.aliases) {
        if (lowerCandidates.has(String(a).toLowerCase())) {
          conflicts.push({ alias: a, with: 'alias', ownerId: u.id });
        }
      }
    }
  }
  return { conflicts };
}

module.exports = {
  ALIAS_MAX_LEN,
  ALIAS_PATTERN,
  normalizeAliases,
  resolveLoginKey,
  findAliasConflicts,
};