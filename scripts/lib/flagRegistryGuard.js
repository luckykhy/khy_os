'use strict';

/**
 * flagRegistryGuard.js — KHY_* flag 中央注册表的结构完整性机器守卫。
 *
 * 背景(goal 2026-07-03「khy 中有许多规则但是缺乏优先级,我希望能完善」):flagRegistry.js 把
 * 散落的 KHY_* 门控父→子优先级收敛成单一声明式真源。声明式表一旦被弱模型「顺手」改坏——写了个
 * 指向不存在父门控的 `parent`、造出 A→B→A 环(resolver 递归会栈溢出)、填了非法 mode/off 名或
 * numeric 边界倒挂(min>max)——注册表就会静默失灵或崩溃。本守卫把这些结构不变量变成**确定性的
 * 机器检查**:谁把表改坏,提交时(pre-commit → check:small-model:safety)立刻被点名挡回。
 *
 * 与既有守卫正交互补:leafContractGuard 看「自声明纯叶子是否仍零 IO」;本守卫看「flag 注册表这张
 * 声明式表本身是否自洽」。二者都属「差距代码化」——把只活在强模型脑子里的纪律固化成可执行门禁。
 *
 * 检测策略:**查活表**。守卫 require flagRegistry 并调 listFlags()/OFF_WORDS,对**运行时真实
 * 生效的数据结构**断言,而非文本解析源码(文本解析对 JS 对象字面量脆弱且易漂移)。
 *
 * 规则(默认门只收零误报、结构性、高价值的三条,对齐「零误报是底线」)：
 *   a. parent-exists(error)：每个 `parent` 必须是表内已登记的 name。悬垂父门控 → 子恒被误判。
 *   b. no-cycles(error)：parent 关系不得成环(DFS)。环会让 resolver 无限递归(虽有 _seen 兜底,
 *      但环本身是设计错误,必须挡)。
 *   c. valid-shape(error)：mode ∈ VALID_MODES;default-on 的 off ∈ VALID_OFF_NAMES;
 *      numeric 的 min/default/max 为有限数且 min≤default≤max。
 *   d. deterministic(守卫自身行为)：findings 按 (rule, flag) 稳定排序,输出确定性、可测。
 *
 * 可选门(默认不进 CI,仅 --strict-warnings / 显式开时报,避免全仓刷屏):
 *   e. unregistered-child(warning)：源码里 inline 读的 `KHY_*` 与某已登记 parent 同前缀却未登记
 *      → 建议登记(仅 assessSources 传入源码时评估;闭集限已登记 parent,防 firehose)。
 *   f. novel-dialect(warning)：源码里新增本地 `_FALSY`/off 词表且方言不匹配三张 OFF_WORDS 之一
 *      → 引导改用 canonical(仅 assessSources 传入源码时评估)。
 *
 * 契约:零 IO(注入 registry;源码由调用方读入后传入)、确定性、绝不抛。env 门控
 * KHY_FLAG_REGISTRY_GUARD(默认开,仅显式 0/false/off/no 关;关 → 返回空 findings)。
 * 本守卫是发现层的纯逻辑核:自身不碰 fs(CLI 壳负责读文件),对自己零发现。
 */

// ── env 门控(默认开,仅 0/false/off/no 关)─────────────────────────────
const OFF = new Set(['0', 'false', 'off', 'no']);
function isEnabled(env) {
  const v = (env || process.env || {}).KHY_FLAG_REGISTRY_GUARD;
  return !(v !== undefined && OFF.has(String(v).trim().toLowerCase()));
}

/** 惰性取注册表(可注入覆盖,测试用)。fail-soft:取不到 → 空表,该维度不误报。 */
function _resolveRegistry(deps) {
  if (deps && deps.registry && typeof deps.registry === 'object') return deps.registry;
  try { return require('../../services/backend/src/services/flagRegistry'); } catch { /* try next */ }
  try { return require('../../services/backend/src/services/flagRegistry.js'); } catch { return null; }
}

/**
 * 从注册表构建 name→spec 映射与有效名集合。绝不抛。
 * @param {object} registry
 * @returns {{ specs: Array, byName: Map, validModes: Set, validOff: Set }}
 */
function _index(registry) {
  const validModes = registry && registry.VALID_MODES instanceof Set
    ? registry.VALID_MODES : new Set(['default-on', 'opt-in', 'numeric']);
  const validOff = registry && registry.VALID_OFF_NAMES instanceof Set
    ? registry.VALID_OFF_NAMES
    : new Set(Object.keys((registry && registry.OFF_WORDS) || { CANON: 1, EXTENDED: 1, MINIMAL: 1 }));
  let specs = [];
  try {
    specs = (registry && typeof registry.listFlags === 'function') ? registry.listFlags() : [];
    if (!Array.isArray(specs)) specs = [];
  } catch { specs = []; }
  const byName = new Map();
  for (const s of specs) if (s && typeof s.name === 'string') byName.set(s.name, s);
  return { specs, byName, validModes, validOff };
}

/**
 * 规则 a + c:逐 flag 校验 parent 存在性与形状合法性。把 finding 追加进 out。
 */
function _auditShape(idx, out) {
  const { specs, byName, validModes, validOff } = idx;
  for (const s of specs) {
    const flag = (s && s.name) || '(unnamed)';
    // c. mode 合法
    if (!validModes.has(s.mode)) {
      out.push({ severity: 'error', rule: 'valid-shape', flag, message: `mode '${s.mode}' 非法(应 ∈ ${[...validModes].join('/')})` });
    }
    // c. default-on 的 off 名合法
    if (s.mode === 'default-on') {
      if (s.off === undefined || !validOff.has(s.off)) {
        out.push({ severity: 'error', rule: 'valid-shape', flag, message: `off '${s.off}' 非法(应 ∈ ${[...validOff].join('/')})` });
      }
    }
    // c. numeric 边界:min/default/max 为有限数且 min≤default≤max
    if (s.mode === 'numeric') {
      const { min, max } = s;
      const def = s.default;
      const finite = (x) => typeof x === 'number' && Number.isFinite(x);
      if (!finite(def)) {
        out.push({ severity: 'error', rule: 'valid-shape', flag, message: `numeric default '${def}' 非有限数` });
      }
      if (min !== undefined && !finite(min)) {
        out.push({ severity: 'error', rule: 'valid-shape', flag, message: `numeric min '${min}' 非有限数` });
      }
      if (max !== undefined && !finite(max)) {
        out.push({ severity: 'error', rule: 'valid-shape', flag, message: `numeric max '${max}' 非有限数` });
      }
      if (finite(min) && finite(max) && min > max) {
        out.push({ severity: 'error', rule: 'valid-shape', flag, message: `numeric 边界倒挂:min ${min} > max ${max}` });
      }
      if (finite(min) && finite(def) && def < min) {
        out.push({ severity: 'error', rule: 'valid-shape', flag, message: `numeric default ${def} < min ${min}` });
      }
      if (finite(max) && finite(def) && def > max) {
        out.push({ severity: 'error', rule: 'valid-shape', flag, message: `numeric default ${def} > max ${max}` });
      }
    }
    // a. parent 存在
    if (s.parent !== undefined) {
      if (typeof s.parent !== 'string' || !byName.has(s.parent)) {
        out.push({ severity: 'error', rule: 'parent-exists', flag, message: `parent '${s.parent}' 未登记(悬垂父门控 → 子门控恒被误判)` });
      }
    }
  }
}

/**
 * 规则 b:parent 关系无环(DFS)。悬垂 parent 不当作边(已由规则 a 报)。
 */
function _auditCycles(idx, out) {
  const { specs, byName } = idx;
  const WHITE = 0; const GRAY = 1; const BLACK = 2;
  const color = new Map();
  for (const s of specs) if (s && s.name) color.set(s.name, WHITE);
  const reported = new Set();

  function visit(name, path) {
    color.set(name, GRAY);
    const spec = byName.get(name);
    const parent = spec && spec.parent;
    if (typeof parent === 'string' && byName.has(parent)) {
      const c = color.get(parent);
      if (c === GRAY) {
        // 找到环:path 从 parent 回到当前。稳定化环签名去重(同一环只报一次)。
        const cycle = path.slice(path.indexOf(parent)).concat(parent);
        const sig = [...cycle].sort().join('|');
        if (!reported.has(sig)) {
          reported.add(sig);
          out.push({ severity: 'error', rule: 'no-cycles', flag: name, message: `parent 关系成环:${cycle.join(' → ')}` });
        }
      } else if (c === WHITE) {
        visit(parent, path.concat(parent));
      }
    }
    color.set(name, BLACK);
  }

  // 确定性:按 name 升序遍历。
  for (const name of Array.from(color.keys()).sort()) {
    if (color.get(name) === WHITE) visit(name, [name]);
  }
}

/** findings 稳定排序:先 rule 字母序,再 flag 字母序,再 message。 */
function _sortFindings(findings) {
  return findings.sort((a, b) =>
    (a.rule || '').localeCompare(b.rule || '')
    || (a.flag || '').localeCompare(b.flag || '')
    || (a.message || '').localeCompare(b.message || ''));
}

/**
 * 评估注册表结构(规则 a/b/c/d)。纯函数:零 IO、确定性、绝不抛。
 * @param {object} [args]
 * @param {object} [args.registry] 注入的注册表(测试用);缺省惰性 require 真实 flagRegistry。
 * @param {object} [args.env]
 * @returns {{ findings: Array<{severity, rule, flag, message}> }}
 */
function assess({ registry, env } = {}) {
  if (!isEnabled(env)) return { findings: [] };
  try {
    const reg = registry || _resolveRegistry({});
    if (!reg) return { findings: [] };
    const idx = _index(reg);
    const findings = [];
    _auditShape(idx, findings);
    _auditCycles(idx, findings);
    return { findings: _sortFindings(findings) };
  } catch {
    return { findings: [] };
  }
}

module.exports = {
  isEnabled,
  assess,
  _index,
  _auditShape,
  _auditCycles,
  _sortFindings,
};
