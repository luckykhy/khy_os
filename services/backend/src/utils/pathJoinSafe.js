'use strict';

/**
 * pathJoinSafe.js — 「空段守卫的 path.join」单一真源。
 *
 * 收敛 src/ 下 4 处逐字节相同的私有 `_join(...parts)`
 * (services/mcp/ccMcpBridge · skills/ccSkillBridge · agents/ccAgentBridge · commands/ccCommandBridge):
 *   任一段为 undefined/null/'' → 返回 ''(不拼出半截路径);否则 `path.join(...parts.map(String))`;
 *   fail-soft(异常 → '')。用途:CC 桥拼 ~/.claude/... 探测路径,缺参时不误拼根路径。
 *
 * **刻意不收敛**:services/output/jsonSchemaValidate 的 `_join(path, seg)` 是 JSON-pointer 拼接
 *   (`${path}/${String(seg)}`),语义完全不同,留原样(C 组)。
 *
 * 契约:确定性、不 mutate、绝不抛。仅用 path.join(纯字符串规范化,无文件系统访问)。
 *
 * 各消费方保留同名本地 `const _join = require('.../pathJoinSafe')` → 调用点逐字节不变。
 */

const path = require('path');

function pathJoinSafe(...parts) {
  try {
    if (parts.some((p) => p === undefined || p === null || p === '')) return '';
    return path.join(...parts.map(String));
  } catch {
    return '';
  }
}

module.exports = pathJoinSafe;
