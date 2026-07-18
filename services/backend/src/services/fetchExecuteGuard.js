'use strict';

/**
 * fetchExecuteGuard — 纯叶子:把「下载/解码出来的内容直接喂给 shell 解释器执行」这一类
 * 经典供应链 / 混淆执行签名(`curl … | sh`、`wget -O- … | bash`、`… | base64 -d | sh`、
 * `bash -c "$(curl …)"`、`bash <(curl …)`)确定性识别出来,升级为 critical,使 khy 既有的
 * shellSafetyValidator block 路径接管(fail-closed:静态无法证明安全的「取来即执行」一律拦)。
 *
 * 这对齐 Claude Code 的 tree-sitter「fail-closed:无法静态确证安全 → 需人类批准」哲学,
 * 但只针对**高置信度**的 fetch/decode-and-execute 这一窄类(几乎不会是开发场景里的良性命令),
 * 避免把 khy 全局翻成 fail-closed(那会对海量良性命令误报)。
 *
 * 关注点是**独立**的:它**不**复刻 shellSafetyValidator.DESTRUCTIVE_PATTERNS(字面破坏性命令)、
 * 也**不**复刻 detectDangerousBuiltin(argv[0] 是 eval/source);它只负责一件既有任何一处都没覆盖
 * 的事——「取来的/解码的数据流进了 shell 执行器」。单一真源:FETCHERS / DECODERS / SHELL_EXECUTORS
 * 三张表 + 数据流判据只在本叶子。
 *
 * 契约(与全仓纯叶子一致):零 IO、确定性、绝不抛(fail-soft 返回「未检出」)、env 门控
 * KHY_FETCH_EXEC_GUARD 默认开;关 = 调用方据 isEnabled() 短路,buildFetchExecuteRisks 返 []
 * → analyzeCommand 的 risks 不增 → maxSeverity 不变 → **字节回退**到旧行为。
 */

// ── 门控 ─────────────────────────────────────────────────────────────────────
const _FALSY = new Set(['0', 'false', 'off', 'no']);
function isEnabled(env = process.env) {
  try {
    const raw = env && env.KHY_FETCH_EXEC_GUARD;
    const v = String(raw === undefined || raw === null ? 'true' : raw).trim().toLowerCase();
    return !_FALSY.has(v);
  } catch {
    return true;
  }
}

// ── 词表(单一真源) ─────────────────────────────────────────────────────────
// 网络取数器:其 stdout 通常是远端内容。
const FETCHERS = new Set([
  'curl', 'wget', 'fetch', 'http', 'https', 'httpie', 'aria2c', 'lynx', 'links', 'links2',
]);
// 解码/解压器:其 stdout 是「还原后」的内容,常被用来绕过字面正则。
const DECODERS = new Set([
  'base64', 'base32', 'basenc', 'xxd', 'uudecode', 'openssl', 'rev', 'tr',
  'gunzip', 'zcat', 'bunzip2', 'unxz', 'xz', 'gzip', 'gpg',
]);
// shell 执行器:把 stdin / -c 参数当脚本执行的解释器。
const SHELL_EXECUTORS = new Set([
  'sh', 'bash', 'zsh', 'dash', 'ksh', 'fish', 'ash', 'eval', 'source', '.',
]);
// 裸解释器作为「管道汇」时也会把 stdin 当脚本执行(`curl … | python`)。
const STDIN_INTERPRETERS = new Set([
  'python', 'python2', 'python3', 'pypy', 'pypy3', 'perl', 'ruby', 'node', 'nodejs', 'bun', 'deno', 'php',
]);

// ── 工具:规整可执行名(去路径 / 小写 / 去 .exe),镜像 shellSafetyValidator.normalizeExe ──
function _normalizeExe(token) {
  if (!token) return '';
  const base = String(token).split(/[/\\]/).pop() || '';
  const lower = base.toLowerCase();
  return lower.endsWith('.exe') ? lower.slice(0, -4) : lower;
}

// ── 工具:取一段命令的「头」(跳过前导 VAR=val 赋值,规整) ─────────────────────
const _ENV_ASSIGN_RE = /^[A-Za-z_][A-Za-z0-9_]*=/;
function _headExe(segment) {
  const toks = String(segment || '').trim().split(/\s+/).filter(Boolean);
  let i = 0;
  while (i < toks.length && _ENV_ASSIGN_RE.test(toks[i])) i++;
  return toks[i] ? _normalizeExe(toks[i]) : '';
}

/**
 * 引号 / 括号感知地切分:在顶层把 cmd 按给定单字符分隔符集合切段。
 * 不进入 '...'、"..."、`...`、$(...)、<(...)/>(...) 内部。返回 {segments, sep} 列表中的 segments。
 * @param {string} cmd
 * @param {(prevCh:string, ch:string, nextCh:string)=>('pipe'|'break'|null)} classify
 *        在每个非保护字符处判定:它是数据管道边界('pipe')、独立命令边界('break')还是普通字符(null)。
 * @returns {Array<{text:string, leadSep:'pipe'|'break'|null}>}
 */
function _splitTopLevel(cmd, classify) {
  const out = [];
  let buf = '';
  let leadSep = null;
  let inS = false, inD = false, btick = false, paren = 0;
  const s = String(cmd || '');
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    const next = s[i + 1] || '';
    const prev = s[i - 1] || '';
    if (inS) { buf += ch; if (ch === "'") inS = false; continue; }
    if (inD) { buf += ch; if (ch === '"') inD = false; continue; }
    if (btick) { buf += ch; if (ch === '`') btick = false; continue; }
    if (ch === "'") { inS = true; buf += ch; continue; }
    if (ch === '"') { inD = true; buf += ch; continue; }
    if (ch === '`') { btick = true; buf += ch; continue; }
    if (ch === '$' && next === '(') { paren++; buf += ch; continue; }
    if ((ch === '<' || ch === '>') && next === '(') { paren++; buf += ch; continue; }
    if (ch === '(' && paren > 0) { paren++; buf += ch; continue; }
    if (ch === ')' && paren > 0) { paren--; buf += ch; continue; }
    if (paren > 0) { buf += ch; continue; }
    const kind = classify(prev, ch, next);
    if (kind === 'pipe' || kind === 'break') {
      out.push({ text: buf, leadSep });
      buf = '';
      leadSep = kind;
      // `||`/`&&` 消费两个字符;`|`/`;`/`\n` 一个。
      if ((ch === '|' && next === '|') || (ch === '&' && next === '&')) i++;
      continue;
    }
    buf += ch;
  }
  out.push({ text: buf, leadSep });
  return out;
}

// 顶层把整串切成「独立命令」(数据不跨这些边界流动):; && || 换行。
function _splitCommands(cmd) {
  return _splitTopLevel(cmd, (prev, ch, next) => {
    if (ch === ';') return 'break';
    if (ch === '\n' || ch === '\r') return 'break';
    if (ch === '&' && next === '&') return 'break';
    if (ch === '|' && next === '|') return 'break';
    return null;
  }).map((seg) => seg.text);
}

// 在一条「独立命令」里按数据管道 `|`(非 `||`)切成有序管道段。
function _splitPipes(command) {
  return _splitTopLevel(command, (prev, ch, next) => {
    if (ch === '|' && next !== '|' && prev !== '|') return 'pipe';
    return null;
  }).map((seg) => seg.text);
}

// 抽出所有 $(...) / `...` / <(...) / >(...) 的内层载荷(单层即可满足判据)。
function _extractSubstitutions(cmd) {
  const payloads = [];
  const s = String(cmd || '');
  let inS = false, inD = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    const next = s[i + 1] || '';
    if (inS) { if (ch === "'") inS = false; continue; }
    if (ch === "'" && !inD) { inS = true; continue; }
    if (ch === '"') { inD = !inD; continue; }
    // 反引号载荷(双引号内仍有效)
    if (ch === '`') {
      const end = s.indexOf('`', i + 1);
      if (end > i) { payloads.push(s.slice(i + 1, end)); i = end; }
      continue;
    }
    // 单引号内不展开,跳过
    if (inS) continue;
    if ((ch === '$' || ch === '<' || ch === '>') && next === '(') {
      // 平衡括号取内层
      let depth = 0;
      let j = i + 1; // 指向 '('
      let start = i + 2;
      for (; j < s.length; j++) {
        if (s[j] === '(') depth++;
        else if (s[j] === ')') { depth--; if (depth === 0) break; }
      }
      if (j < s.length && depth === 0) { payloads.push(s.slice(start, j)); i = j; }
    }
  }
  return payloads;
}

function _isProducer(exe) { return FETCHERS.has(exe) || DECODERS.has(exe); }
function _producerKind(exe) { return FETCHERS.has(exe) ? 'fetch' : (DECODERS.has(exe) ? 'decode' : null); }

/**
 * 核心判据:命令里是否存在「取来/解码的数据 → 流进 shell 执行器」。
 * @param {string} command
 * @returns {{detected:boolean, severity:'critical'|null, reasons:Array<{code:string, detail:string}>}}
 */
function analyzeFetchExecute(command) {
  const reasons = [];
  try {
    const cmd = String(command == null ? '' : command);
    if (!cmd.trim()) return { detected: false, severity: null, reasons };

    // (1) 管道数据流:在同一条独立命令的管道里,producer 在前、shell 执行器在后。
    for (const oneCommand of _splitCommands(cmd)) {
      const segs = _splitPipes(oneCommand);
      if (segs.length < 2) continue;
      const heads = segs.map((seg) => _headExe(seg));
      let producerAt = -1;
      let producerKind = null;
      for (let i = 0; i < heads.length; i++) {
        const h = heads[i];
        if (producerAt < 0 && _isProducer(h)) { producerAt = i; producerKind = _producerKind(h); continue; }
        if (producerAt >= 0 && i > producerAt) {
          // 下游汇是 shell 执行器,或裸解释器(把 stdin 当脚本)。
          if (SHELL_EXECUTORS.has(h) || STDIN_INTERPRETERS.has(h)) {
            reasons.push({
              code: producerKind === 'fetch' ? 'fetch_pipe_exec' : 'decode_pipe_exec',
              detail: `${producerKind === 'fetch' ? 'Downloaded' : 'Decoded'} content piped into shell executor `
                + `(${heads[producerAt]} → … → ${h}); fetch/decode-and-execute is blocked fail-closed.`,
            });
            break; // 一条管道报一次即可
          }
        }
      }
    }

    // (2) 命令替换 / 进程替换:外层是 shell 执行器(或本身就是 eval),内层载荷含 producer。
    //     例:`bash -c "$(curl …)"`、`sh <(wget -O- …)`、`eval "$(… | base64 -d)"`。
    const topCommands = _splitCommands(cmd);
    for (const oneCommand of topCommands) {
      const firstSeg = _splitPipes(oneCommand)[0] || oneCommand;
      const outerHead = _headExe(firstSeg);
      if (!SHELL_EXECUTORS.has(outerHead)) continue;
      const payloads = _extractSubstitutions(oneCommand);
      for (const payload of payloads) {
        // 载荷里任一管道段的头是 producer 即命中。
        const innerHeads = _splitPipes(payload).map((seg) => _headExe(seg));
        const hit = innerHeads.find((h) => _isProducer(h));
        if (hit) {
          reasons.push({
            code: 'subst_fetch_exec',
            detail: `Shell executor (${outerHead}) runs a command substitution that downloads/decodes content `
              + `(${hit}); fetch/decode-and-execute is blocked fail-closed.`,
          });
          break;
        }
      }
    }
  } catch {
    // 绝不抛:出错就当未检出(交回既有 layers,门控独立 fail-soft)。
    return { detected: false, severity: null, reasons: [] };
  }

  // 去重(同一命令多路径命中只留唯一 code)。
  const seen = new Set();
  const deduped = reasons.filter((r) => (seen.has(r.code) ? false : (seen.add(r.code), true)));
  return {
    detected: deduped.length > 0,
    severity: deduped.length > 0 ? 'critical' : null,
    reasons: deduped,
  };
}

/**
 * 产出可直接 splice 进 shellSafetyValidator.analyzeCommand 的 risks[] 的风险对象。
 * 门控关 → 返 [](零增量,字节回退)。绝不抛。
 * @param {string} command
 * @param {object} [env]
 * @returns {Array<{type:string, severity:'critical', detail:string}>}
 */
function buildFetchExecuteRisks(command, env = process.env) {
  try {
    if (!isEnabled(env)) return [];
    const res = analyzeFetchExecute(command);
    if (!res.detected) return [];
    return res.reasons.map((r) => ({
      type: 'fetch_execute',
      severity: 'critical',
      detail: r.detail,
      code: r.code,
    }));
  } catch {
    return [];
  }
}

/** 自描述(给工具 / CLI / 文档 / 提示词用)。 */
function describeFetchExecuteGuard() {
  return {
    gate: 'KHY_FETCH_EXEC_GUARD',
    defaultOn: true,
    severity: 'critical',
    summary: '取来即执行守卫(curl|sh / base64 -d|bash / bash -c "$(curl …)" 这类下载-解码-执行管道,'
      + '静态无法证明安全,fail-closed 升级为 critical 由 shellSafetyValidator 拦截;'
      + '门控关则零增量,字节回退到旧行为)。',
    fetchers: Array.from(FETCHERS),
    decoders: Array.from(DECODERS),
    executors: Array.from(SHELL_EXECUTORS),
  };
}

module.exports = {
  isEnabled,
  FETCHERS,
  DECODERS,
  SHELL_EXECUTORS,
  STDIN_INTERPRETERS,
  analyzeFetchExecute,
  buildFetchExecuteRisks,
  describeFetchExecuteGuard,
};
