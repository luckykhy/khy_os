'use strict';

/**
 * docMarkerSync.js — 纯叶子(零 IO · 确定性 · 绝不抛 · 可单测)。
 *
 * 文档新鲜度系统 Layer 3(内嵌值自动同步)的纯替换器。
 *
 * 诉求:命令清单 / 端口 / 版本号等「可从代码提取的事实」在文档里常写死,代码一改就漂移。
 * 用 **opt-in 标记块**框住这些值,由 SSOT 自动填充:
 *
 *   <!-- khy-docs-sync:begin key=ai-backend-port source=serviceDefaults -->
 *   (此区块由 khy docs check --fix 依据 SSOT 自动生成,请勿手工编辑)
 *   9090
 *   <!-- khy-docs-sync:end key=ai-backend-port -->
 *
 * 标记是 HTML 注释:md 与生成的 html 里都**隐形**,md-to-pdf 原样透传。
 * token `khy-docs-sync` 刻意避开 `khy-metadata-*`(那是元数据 hook 的命名空间)。
 *
 * 本叶子只做纯替换:给定文档文本与 valueMap(key→值文本),把每个**成对且 key 已知**的
 * 标记块**内部**替换为 valueMap 的值(标记行逐字保留 → 幂等)。free prose 绝不动。
 *
 * 门控 KHY_DOCS_MARKER_SYNC(默认开;{0,false,off,no} 关)。
 *
 * 诚实边界(刻意):
 *   ① 未知 key(valueMap 无此 key)→ 该块留原样 + 上报(unknownKeys),不清空不猜测。
 *   ② 标记不平衡 / 嵌套 / begin 无对应 end → 跳过该块,不动文本。
 *   ③ 无 SSOT 的值(如前端 8090 端口散在各处)→ 由 buildValueMap **拒绝**入表(不杜撰)。
 */

const _OFF = ['0', 'false', 'off', 'no'];

/** KHY_DOCS_MARKER_SYNC 门控:默认开(unset → 开),{0,false,off,no} 关。 */
function docMarkerSyncEnabled(env = process.env) {
  const raw = env && env.KHY_DOCS_MARKER_SYNC;
  const v = String(raw == null ? '' : raw).trim().toLowerCase();
  return !_OFF.includes(v);
}

// begin/end 标记(捕获 key)。允许 begin 行携带额外属性(如 source=...)。
const BEGIN_RE = /<!--\s*khy-docs-sync:begin\s+key=([A-Za-z0-9._-]+)(?:\s+[^>]*?)?\s*-->/;
const END_RE = /<!--\s*khy-docs-sync:end\s+key=([A-Za-z0-9._-]+)\s*-->/;

// 供 --fix 生成的固定提示行(位于 begin 之后,值之前;幂等复刻)。
const NOTICE = '(此区块由 khy docs check --fix 依据 SSOT 自动生成,请勿手工编辑)';

/**
 * 同步文档里所有受管标记块。
 * @param {string} docText
 * @param {Map<string,string>|Object} valueMap  key → 值文本(多行值原样)。
 * @returns {{text:string, changed:boolean, changedRegions:Array<{key:string}>, unknownKeys:string[], skipped:Array<{key:string,reason:string}>}}
 */
function syncManagedRegions(docText, valueMap) {
  const result = { text: '', changed: false, changedRegions: [], unknownKeys: [], skipped: [] };
  try {
    if (typeof docText !== 'string') { result.text = ''; return result; }
    const get = _mapGetter(valueMap);
    const lines = docText.split('\n');
    const out = [];
    let i = 0;
    while (i < lines.length) {
      const line = lines[i];
      const bm = line.match(BEGIN_RE);
      if (!bm) { out.push(line); i += 1; continue; }

      const key = bm[1];
      // 找配对 end(必须 key 一致,且中间不得再出现 begin → 防嵌套)。
      let j = i + 1;
      let nested = false;
      let endIdx = -1;
      for (; j < lines.length; j += 1) {
        if (BEGIN_RE.test(lines[j])) { nested = true; break; }
        const em = lines[j].match(END_RE);
        if (em) {
          if (em[1] === key) { endIdx = j; }
          break;
        }
      }

      if (endIdx === -1 || nested) {
        // 不平衡 / 嵌套 / end key 不匹配 → 跳过该块,原样保留 begin 行,继续。
        result.skipped.push({ key, reason: nested ? 'nested' : 'unbalanced' });
        out.push(line);
        i += 1;
        continue;
      }

      const beginLine = lines[i];
      const endLine = lines[endIdx];

      if (!get.has(key)) {
        // 未知 key:整块原样保留(begin..end),不动内部。
        result.unknownKeys.push(key);
        for (let k = i; k <= endIdx; k += 1) out.push(lines[k]);
        i = endIdx + 1;
        continue;
      }

      // 已知 key:重建块内部 = NOTICE + 值(按行)。
      const value = String(get.get(key));
      const rebuilt = [beginLine, NOTICE, ...value.split('\n'), endLine];
      const original = lines.slice(i, endIdx + 1);
      if (rebuilt.join('\n') !== original.join('\n')) {
        result.changed = true;
        result.changedRegions.push({ key });
      }
      out.push(...rebuilt);
      i = endIdx + 1;
    }
    result.text = out.join('\n');
    return result;
  } catch {
    // fail-soft:出错则返回原文不变。
    return { text: typeof docText === 'string' ? docText : '', changed: false, changedRegions: [], unknownKeys: [], skipped: [] };
  }
}

function _mapGetter(valueMap) {
  if (valueMap instanceof Map) return valueMap;
  const m = new Map();
  if (valueMap && typeof valueMap === 'object') {
    for (const k of Object.keys(valueMap)) m.set(k, valueMap[k]);
  }
  return m;
}

/**
 * 从注入的 SSOT 依赖构造 key → 值文本表。
 *  - slash-commands ← getBuiltinSlashCommands()(每命令一行 `/cmd — 说明`)
 *  - ai-backend-port ← serviceDefaults.AI_BACKEND_DEFAULT_PORT
 *  - khy-version ← package.json version
 * 无 SSOT 的值(如前端 8090)**不入表**(杜绝杜撰)。
 * @param {{slashCommands?:Array, aiBackendPort?:number|string, khyVersion?:string}} deps
 * @returns {Map<string,string>}
 */
function buildValueMap(deps = {}) {
  const m = new Map();
  try {
    if (Array.isArray(deps.slashCommands) && deps.slashCommands.length) {
      const lines = deps.slashCommands
        .map((c) => {
          const cmd = c && (c.cmd || c.command || c.name);
          if (!cmd) return null;
          const desc = c && (c.desc || c.description || c.label);
          return desc ? `- \`${cmd}\` — ${desc}` : `- \`${cmd}\``;
        })
        .filter(Boolean);
      if (lines.length) m.set('slash-commands', lines.join('\n'));
    }
    if (deps.aiBackendPort != null && String(deps.aiBackendPort).trim() !== '') {
      m.set('ai-backend-port', String(deps.aiBackendPort).trim());
    }
    if (deps.khyVersion != null && String(deps.khyVersion).trim() !== '') {
      m.set('khy-version', String(deps.khyVersion).trim());
    }
    // frontend-port 刻意不提供:无 SSOT(散在 gateway.js),只报漂移不自动同步。
  } catch {
    /* fail-soft */
  }
  return m;
}

module.exports = {
  docMarkerSyncEnabled,
  syncManagedRegions,
  buildValueMap,
  NOTICE,
};
