'use strict';

// 收敛到 utils/normalizeToolName 单一真源(逐字节委托,调用点不变)
const normalizeToolName = require('../utils/normalizeToolName');

// ── 过程叙述「不机械」:变体轮换 + 续接句 ────────────────────────────────────
// 用户反馈:多次连续调同类工具时,合成旁白每次都吐同一句(「我先补一下外部信息,先把
// 外部事实补齐,再回来收口。」×N),读起来死板。修法:给每条旁白一个**首发句**(=历史
// 原句,保证 occurrence 0 字节级不变、老测试与单工具回合零行为变化)+ 一组更短的**续接
// 句**;调用方按「本回合该类工具已出现的次数」(occurrence)传入,_voice 在 occurrence>=1
// 时轮换续接句,从而连续同类调用绝不逐字重复、且不再每次复述完整仪式感措辞。
//
// 纯函数、确定性(无随机),续接句 ≥2 条即可保证相邻两次不同(occ1→c[0]、occ2→c[1]…
// 满一轮才回头)。env KHY_TOOL_PREFACE_VARY=0/false/off 把 occurrence 钉死为 0 → 完全
// 回退历史「每次同一句」行为(安全回滚)。
function _varyEnabled(env = process.env) {
  const flag = String((env && env.KHY_TOOL_PREFACE_VARY) || '')
    .trim()
    .toLowerCase();
  return !(flag === '0' || flag === 'false' || flag === 'off' || flag === 'no');
}

function _voice(occurrence, first, continuations) {
  const occ = _varyEnabled() && Number.isInteger(occurrence) && occurrence > 0 ? occurrence : 0;
  if (occ === 0 || !Array.isArray(continuations) || continuations.length === 0) {
    return first;
  }
  return continuations[(occ - 1) % continuations.length];
}

// scaffoldFiles 旁白的 root 回退（修「我先把 . 的骨架搭起来」——字面点）。
// scaffoldFiles 的**输入参数**只有 directories/files，root 是**结果字段**，故 preface 读到的
// params.root 恒为 undefined → 历史回退成字面 '.'。门控开：无有效 root 时说「项目骨架」而非
// 念出一个点；门控关：逐字节回退历史（字面 '.'）。flagRegistry 优先，回退本地 CANON。
const _SCAFFOLD_FALSY = new Set(['0', 'false', 'off', 'no']);
function _scaffoldRootFallbackEnabled(env) {
  const e = env || (typeof process !== 'undefined' ? process.env : undefined) || {};
  try {
    const reg = require('../services/flagRegistry');
    if (
      reg &&
      typeof reg.isRegistryEnabled === 'function' &&
      reg.isRegistryEnabled(e) &&
      typeof reg.isFlagEnabled === 'function'
    ) {
      return reg.isFlagEnabled('KHY_SCAFFOLD_VOICE_ROOT_FALLBACK', e);
    }
  } catch {
    /* 注册表不可用 → 本地回退 */
  }
  const v = e.KHY_SCAFFOLD_VOICE_ROOT_FALLBACK;
  return !(v !== undefined && _SCAFFOLD_FALSY.has(String(v).trim().toLowerCase()));
}

// 失败步根因提取(lazy + memoized):从结构化结果里取一句「为什么没通」,让失败旁白说出根因
// 而非死板的「我先看下报错」。叶子缺失/门控关/无根因 → null,调用方逐字节回退旧 canned 行。
let _keyFinding; // undefined=未尝试,null=不可用
function _salientReason(result) {
  try {
    if (_keyFinding === undefined) {
      try {
        _keyFinding = require('./outcomeKeyFinding');
      } catch {
        _keyFinding = null;
      }
    }
    if (!_keyFinding || typeof _keyFinding.salientErrorReason !== 'function') {
      return null;
    }
    return _keyFinding.salientErrorReason(result, process.env);
  } catch {
    return null;
  }
}

// 把工具名归一为「计数键」,供调用方按类别累计 occurrence(读/写/搜… 各自独立计数)。
// 单一真源,避免调用方各自复刻 normalizeToolName。
function occurrenceKey(toolName = '') {
  return normalizeToolName(toolName);
}

// ── 连续同类工具的 preface 抑制(修「刷屏」)────────────────────────────────────
// 会话现场:模型连开 3 个 scaffoldFiles → 意图旁白吐 3 句近义骨架话(「我先把项目骨架…」
// →「接着补项目骨架。」→「再铺一层项目结构。」),连同一串 write 的「我先把改动落下去…」,
// 满屏都是相似的过程仪式感措辞。occurrence 轮换只保证相邻不逐字重复,但一串同类工具仍逐个
// 出一句 → 刷屏。修法:记「上一条**已发出** preface 的工具类别」,当前工具与之同类即抑制——
// 于是一串同类工具只在**首个**开口,其余静默,直到出现不同类工具再说话(此时不同类工具重置
// 追踪,同类工具若之后非连续地再次出现,仍走 occurrence 续接句)。
//
// 纯函数、确定性。lastPrefaceKey 由调用方维护(TUI 侧 ref、REPL 侧闭包变量),因为
// before/during/after 三拍与跨回合状态都活在调用方;本函数只做「该不该压」这一决策。
// KHY_TOOL_PREFACE_DEDUP=0/false/off/no 关闭 → 恒返 false(逐条照发,字节回退历史刷屏行为)。
// flagRegistry 优先,回退本地 CANON 4 词。
const _DEDUP_FALSY = new Set(['0', 'false', 'off', 'no']);
function _prefaceDedupEnabled(env) {
  const e = env || (typeof process !== 'undefined' ? process.env : undefined) || {};
  try {
    const reg = require('../services/flagRegistry');
    if (
      reg &&
      typeof reg.isRegistryEnabled === 'function' &&
      reg.isRegistryEnabled(e) &&
      typeof reg.isFlagEnabled === 'function'
    ) {
      return reg.isFlagEnabled('KHY_TOOL_PREFACE_DEDUP', e);
    }
  } catch {
    /* 注册表不可用 → 本地回退 */
  }
  const v = e.KHY_TOOL_PREFACE_DEDUP;
  return !(v !== undefined && _DEDUP_FALSY.has(String(v).trim().toLowerCase()));
}

// 返回 true 表示「本条 preface 应被抑制」(当前工具与上一条已发出 preface 的工具同类)。
// 门控关 / 无有效工具名 / 无上一条 → false(照常发出)。
function suppressConsecutivePreface(toolName, lastPrefaceKey, env) {
  if (!_prefaceDedupEnabled(env)) {
    return false;
  }
  const key = occurrenceKey(toolName);
  if (!key) {
    return false;
  }
  const last = String(lastPrefaceKey || '');
  if (!last) {
    return false;
  }
  return key === last;
}

// ── 过程旁白口吻自然化(修「都是我先/让我 xx」opener 单调)────────────────────────
// 2026-07-05 /goal:中间过程说明太死板——`toolProgressReason` 每条首发句都以「我先…」开头,
// 且带「先把…，再…」的仪式感尾巴,读起来像模板。occurrence 轮换(_voice 续接句)只在同类工具
// 重复时才换措辞;一串**不同类**工具(read→edit→bash)各自 occurrence 0 → 全开「我先」。
// 修法:把每条首发句改写成更短、更口语、每类工具措辞各异的自然句(去「我先」+ 去「先把…再…」
// 仪式),续接句沿用。门控 KHY_TOOL_PREFACE_NATURAL_VOICE(默认开,仅 CANON 4 词关)→ 关时逐字节
// 回退历史「我先…」措辞(旧测试与保守回滚不受影响)。flagRegistry 优先,回退本地 CANON。
const _NATURAL_FALSY = new Set(['0', 'false', 'off', 'no']);
function _naturalVoiceEnabled(env) {
  const e = env || (typeof process !== 'undefined' ? process.env : undefined) || {};
  try {
    const reg = require('../services/flagRegistry');
    if (
      reg &&
      typeof reg.isRegistryEnabled === 'function' &&
      reg.isRegistryEnabled(e) &&
      typeof reg.isFlagEnabled === 'function'
    ) {
      return reg.isFlagEnabled('KHY_TOOL_PREFACE_NATURAL_VOICE', e);
    }
  } catch {
    /* 注册表不可用 → 本地回退 */
  }
  const v = e.KHY_TOOL_PREFACE_NATURAL_VOICE;
  return !(v !== undefined && _NATURAL_FALSY.has(String(v).trim().toLowerCase()));
}

// ── 执行中/结果两拍的复述感修正(2026-08-26 用户反馈「中途的工具调用说明太机械」)──────
// 前一轮 KHY_TOOL_PREFACE_NATURAL_VOICE 只治了 `toolProgressReason`(意图拍)的措辞。剩下两拍
// 仍是**纯模板查表**:`toolRunningNarration` 11 条分支里只有 websearch/webfetch 走 _voice 轮换,
// 其余 9 条是死字符串;`toolOutcomeNarration` 的成功分支同样只有 websearch/webfetch 会换。于是
// 一个多步任务里连读三个文件 → 三次「正在读取 x…」+ 三次「x 读完了，结构我摸清了——接着…」,
// 逐字重复,像机器复述。另外 running 的兜底 `'正在执行…'` 只有动作没有目标,贴着红线②的禁区。
// 开 → 这两拍的每类工具都给 occurrence 续接句(首发句保持不变,故 occ 0 与历史逐字一致),兜底
// 改成带目标的句子;关 → 逐字节回退到「只有 websearch 会换」的历史行为。flagRegistry 优先。
const _LIVE_FALSY = new Set(['0', 'false', 'off', 'no']);
function _liveVoiceEnabled(env) {
  const e = env || (typeof process !== 'undefined' ? process.env : undefined) || {};
  try {
    const reg = require('../services/flagRegistry');
    if (
      reg &&
      typeof reg.isRegistryEnabled === 'function' &&
      reg.isRegistryEnabled(e) &&
      typeof reg.isFlagEnabled === 'function'
    ) {
      return reg.isFlagEnabled('KHY_TOOL_NARRATION_LIVE_VOICE', e);
    }
  } catch {
    /* 注册表不可用 → 本地回退 */
  }
  const v = e.KHY_TOOL_NARRATION_LIVE_VOICE;
  return !(v !== undefined && _LIVE_FALSY.has(String(v).trim().toLowerCase()));
}

// Separator-agnostic basename: a Windows path ("D:\\...\\Desktop") must yield
// "Desktop" even when this runs on a POSIX host (path.basename only splits the
// host separator). Strips a trailing separator first, then takes the last
// segment after either / or \.
function baseNameAnyOs(p) {
  const s = String(p || '').replace(/[\\/]+$/, '');
  if (!s) {
    return '';
  }
  const parts = s.split(/[\\/]+/);
  return parts[parts.length - 1] || s;
}

function toolProgressReason(toolName, params = {}, options = {}) {
  const mode = options.mode === 'lite' ? 'lite' : 'full';
  const occ = options.occurrence;
  const name = normalizeToolName(toolName);
  const pathHint = String(params.file_path || params.filePath || params.path || '').trim();
  const patternHint = String(params.pattern || params.query || params.q || '').trim();
  const commandHint = String(params.command || '').trim();
  const baseName = pathHint ? baseNameAnyOs(pathHint) : '';
  // nat=true → 自然口吻首发句(去「我先」+ 去「先把…再…」仪式);false → 逐字节回退历史措辞。
  const nat = _naturalVoiceEnabled(process.env);

  if (name === 'grep' || name === 'glob' || name === 'find' || name === 'search' || name === 'ls') {
    const where = baseName || pathHint;
    if (patternHint && pathHint) {
      return _voice(
        occ,
        nat
          ? `在 ${where} 里搜 "${patternHint}"，定位要动的地方。`
          : `我先在 ${where} 里找 "${patternHint}"，先把位置卡准，后面就不会改偏。`,
        [
          `再在 ${where} 里翻一下 "${patternHint}"。`,
          `顺手查查 ${where} 里有没有 "${patternHint}"。`,
          `接着在 ${where} 里定位 "${patternHint}"。`,
        ]
      );
    }
    if (patternHint) {
      return _voice(
        occ,
        nat
          ? `定位 "${patternHint}" 在哪，圈出要动的范围。`
          : `我先把 "${patternHint}" 的位置卡准，这样后面改动范围就能收住。`,
        [
          `再定位一下 "${patternHint}"。`,
          `接着找 "${patternHint}" 在哪。`,
          `顺带把 "${patternHint}" 的位置也卡准。`,
        ]
      );
    }
    if (pathHint) {
      return _voice(
        occ,
        nat
          ? `看下 ${baseName} 的结构，找到切入口。`
          : `我先看下 ${baseName} 的结构，先找到切入口，后面改起来会更稳。`,
        [`再看下 ${baseName} 的结构。`, `接着摸一下 ${baseName} 的布局。`]
      );
    }
    return mode === 'lite'
      ? _voice(occ, nat ? '定位相关位置，再往下走。' : '我先把相关位置卡准，再往下走。', [
          '再定位一下相关位置。',
          '接着把位置卡准。',
        ])
      : '';
  }
  if (name === 'read' || name === 'readfile' || name === 'notebookread') {
    if (baseName) {
      return _voice(
        occ,
        nat
          ? `看下 ${baseName} 是怎么写的，找准要改的地方。`
          : `我先看下 ${baseName} 的实现，先把改动点摸准，再动手。`,
        [`再翻一下 ${baseName}。`, `接着看 ${baseName} 这块。`, `顺带读一下 ${baseName}。`]
      );
    }
    return mode === 'lite'
      ? _voice(
          occ,
          nat ? '看下当前实现，找准要改的地方。' : '我先看下当前实现，先把改动点摸准，再动手。',
          ['再看一段实现。', '接着往下读。']
        )
      : '';
  }
  if (name === 'write' || name === 'writefile' || name === 'createfile') {
    if (baseName) {
      return mode === 'lite'
        ? _voice(
            occ,
            nat
              ? `把改动写进 ${baseName}，写完回头验一下。`
              : `我先改 ${baseName}，先把核心改动落下去，改完马上回看结果。`,
            [`接着写 ${baseName}。`, `再把 ${baseName} 落下去。`]
          )
        : _voice(
            occ,
            nat
              ? `把改动写回 ${baseName}，落盘后顺手验一下。`
              : `我先把改动写回 ${baseName}，先落盘，再顺手验一下。`,
            [`接着写 ${baseName}。`, `再把改动落到 ${baseName}。`]
          );
    }
    return mode === 'lite'
      ? _voice(occ, nat ? '把改动落下去，写完回看结果。' : '我先把改动落下去，改完再回看结果。', [
          '接着写下一处。',
          '再落一处改动。',
        ])
      : '';
  }
  if (name === 'edit' || name === 'editfile' || name === 'multiedit' || name === 'notebookedit') {
    if (baseName) {
      return _voice(
        occ,
        nat
          ? `动手改 ${baseName}，改完看看有没有副作用。`
          : `我先改 ${baseName}，先把核心改动落下去，改完马上回看结果。`,
        [`接着改 ${baseName}。`, `再调一处 ${baseName}。`, `顺手把 ${baseName} 也改了。`]
      );
    }
    return mode === 'lite'
      ? _voice(occ, nat ? '把这处改掉，改完再回看。' : '我先把改动落下去，改完再回看结果。', [
          '接着改下一处。',
          '再调一处。',
        ])
      : '';
  }
  if (name === 'bash' || name === 'shell' || name === 'shellcommand' || name === 'command') {
    if (commandHint) {
      const maxLen = mode === 'lite' ? 80 : 60;
      const shortCmd =
        commandHint.length > maxLen ? commandHint.slice(0, maxLen - 3) + '...' : commandHint;
      return _voice(
        occ,
        nat
          ? `跑下 \`${shortCmd}\`，看看现场跟预期对不对。`
          : `我先跑下 \`${shortCmd}\`，先看现场是不是跟预期一致。`,
        [`接着跑 \`${shortCmd}\`。`, `再执行一条：\`${shortCmd}\`。`, `顺手跑下 \`${shortCmd}\`。`]
      );
    }
    return mode === 'lite'
      ? _voice(
          occ,
          nat ? '看下现场，确认跟预期对不对。' : '我先看下现场，先确认它是不是跟预期一致。',
          ['再跑一条确认下。', '接着看现场。']
        )
      : '';
  }
  if (name === 'websearch' || name === 'webfetch') {
    if (patternHint) {
      return _voice(
        occ,
        nat
          ? `查一下 "${patternHint}" 的外部资料，补齐再回来。`
          : `我先补一下 "${patternHint}" 的外部信息，先把外部事实补齐，再回来收口。`,
        [
          `顺手把 "${patternHint}" 也查一下。`,
          `接着补 "${patternHint}" 的资料。`,
          `再查一条："${patternHint}"。`,
          `把 "${patternHint}" 的情况也补齐。`,
        ]
      );
    }
    return _voice(
      occ,
      nat
        ? '查一下外部资料，补齐事实再回来。'
        : '我先补一下外部信息，先把外部事实补齐，再回来收口。',
      ['继续补充外部信息。', '再查一轮外部资料。', '接着往下查。']
    );
  }
  if (name === 'scaffoldfiles') {
    const rawRoot = String(params.root || '.').trim();
    const hasRoot = rawRoot && rawRoot !== '.';
    if (_scaffoldRootFallbackEnabled(process.env) && !hasRoot) {
      return _voice(
        occ,
        nat
          ? '把项目骨架搭起来，结构铺开了细节就好补。'
          : '我先把项目骨架搭起来，先把结构铺开，后面细节就能顺着补。',
        ['接着补项目骨架。', '再铺一层项目结构。']
      );
    }
    const root = rawRoot;
    return _voice(
      occ,
      nat
        ? `把 ${root} 的骨架搭起来，结构铺开了细节就好补。`
        : `我先把 ${root} 的骨架搭起来，先把结构铺开，后面细节就能顺着补。`,
      [`接着补 ${root} 的骨架。`, `再铺一层 ${root} 的结构。`]
    );
  }
  if (name === 'agent' || name === 'task') {
    const role = String(params.role || params.subagent_type || '子任务').trim();
    return _voice(
      occ,
      nat
        ? `这部分交给 ${role} 并行跑，回头我来收。`
        : `我先把这部分交给 ${role} 并行跑，先把耗时部分摊开，等会儿我来收。`,
      [`再开一个 ${role} 并行跑。`, `接着派一个 ${role} 摊开跑。`]
    );
  }
  return '';
}

// Present-continuous "执行中" narration — the staged-transparency companion to
// toolProgressReason's future-intent preface ("我先看下…"). Shown live UNDER a
// running tool row while it executes, so a multi-step turn reads as running
// commentary (intent → 正在做 → 结果) instead of a black box. Short, factual,
// no trailing rationale (the intent line already carried the "why").
function toolRunningNarration(toolName, params = {}, options = {}) {
  const name = normalizeToolName(toolName);
  const occ = options.occurrence;
  const pathHint = String(params.file_path || params.filePath || params.path || '').trim();
  const patternHint = String(params.pattern || params.query || params.q || '').trim();
  const commandHint = String(params.command || '').trim();
  const baseName = pathHint ? baseNameAnyOs(pathHint) : '';
  // 门控包装:关时只返首发句(= 历史死字符串),开时按 occurrence 轮换续接句。
  const live = _liveVoiceEnabled(options.env);
  const _live = (first, continuations) => (live ? _voice(occ, first, continuations) : first);

  if (name === 'ls' || name === 'glob' || name === 'find') {
    return baseName
      ? _live(`正在列出 ${baseName} 的条目…`, [
          `继续看 ${baseName} 下还有什么…`,
          `再列一遍 ${baseName}…`,
        ])
      : _live('正在列出条目…', ['继续列出条目…', '再看一层目录…']);
  }
  if (name === 'grep' || name === 'search') {
    if (patternHint && baseName) {
      return _live(`正在 ${baseName} 里搜索 "${patternHint}"…`, [
        `继续在 ${baseName} 里找 "${patternHint}"…`,
        `换个位置搜 "${patternHint}"…`,
      ]);
    }
    if (patternHint) {
      return _live(`正在搜索 "${patternHint}"…`, [
        `继续找 "${patternHint}"…`,
        `再搜一轮 "${patternHint}"…`,
      ]);
    }
    return _live('正在搜索…', ['继续搜索…', '再找一轮…']);
  }
  if (name === 'read' || name === 'readfile' || name === 'notebookread') {
    return baseName
      ? _live(`正在读取 ${baseName}…`, [`接着读 ${baseName}…`, `再翻一段 ${baseName}…`])
      : _live('正在读取…', ['接着往下读…', '再读一段…']);
  }
  if (name === 'write' || name === 'writefile' || name === 'createfile') {
    return baseName
      ? _live(`正在写入 ${baseName}…`, [`继续写 ${baseName}…`, `补齐 ${baseName} 剩下的内容…`])
      : _live('正在写入…', ['继续写入…', '补齐剩下的内容…']);
  }
  if (name === 'edit' || name === 'editfile' || name === 'multiedit' || name === 'notebookedit') {
    return baseName
      ? _live(`正在修改 ${baseName}…`, [`接着改 ${baseName}…`, `再动一处 ${baseName}…`])
      : _live('正在修改…', ['接着改下一处…', '再动一处…']);
  }
  if (name === 'bash' || name === 'shell' || name === 'shellcommand' || name === 'command') {
    if (commandHint) {
      const short = commandHint.length > 50 ? commandHint.slice(0, 47) + '...' : commandHint;
      return _live(`正在执行 \`${short}\`…`, [
        `接着跑 \`${short}\`…`,
        `再执行一条 \`${short}\`…`,
      ]);
    }
    return _live('正在执行命令…', ['接着跑下一条命令…', '再执行一条命令…']);
  }
  if (name === 'websearch' || name === 'webfetch') {
    if (patternHint) {
      return _voice(occ, `正在检索 "${patternHint}"…`, [
        `继续检索 "${patternHint}"…`,
        `再查 "${patternHint}"…`,
      ]);
    }
    return _voice(occ, '正在检索外部信息…', ['继续检索外部信息…', '再查一轮…']);
  }
  if (name === 'scaffoldfiles') {
    const root = String(params.root || '.').trim();
    return root && root !== '.'
      ? _live(`正在生成 ${root} 的骨架…`, [`继续补 ${root} 的骨架…`, `再生成一部分 ${root}…`])
      : _live('正在生成骨架…', ['继续补骨架…', '再生成一部分…']);
  }
  if (name === 'agent' || name === 'task') {
    const role = String(params.role || params.subagent_type || '子任务').trim();
    return _live(`${role} 正在并行执行…`, [
      `${role} 还在跑，我先往下走…`,
      `${role} 这一路继续推进…`,
    ]);
  }
  // 兜底:红线②要求「动作 + 目标」,拿工具名当目标念出来;工具名都取不到时才回到
  // 无目标的历史句(此时确实没有可说的目标)。
  const label = live ? String(toolName || '').trim() : '';
  return label
    ? _voice(occ, `正在执行 ${label}…`, [`${label} 继续执行…`, `再调一次 ${label}…`])
    : '正在执行…';
}

// "结果 + 行动" completion narration — the third beat of the before→during→after
// lifecycle (intent → 正在做 → 这步的结果是…接着我…). Driven by the STRUCTURED
// tool result (counts, line totals, exit code), NOT by parsing rendered text, so
// it reads like a person reacting to what actually came back and naming the next
// move — event-driven, not a fixed "✓ 完成" stamp. Returns '' for a FAILED/denied
// step (those are surfaced by the error UI + retry nudge, not a "done, next is…"
// reflection) and '' when nothing concrete can be said, so the caller can stay
// silent rather than emit filler.
// 批2 — 失败步衔接句开关。缺口④:失败步此前直接静音(返 ''),让多步任务在出错处读起来
// 像突然卡死。开启后(默认 on)失败步给一句中性的「这步没走通,我先看报错再调整」衔接,
// 把恢复动作说出来——原始报错仍由错误 UI + 重试 nudge 呈现,这里只补"人会有的反应"那一拍。
// KHY_TOOL_OUTCOME_FAIL=0/false/off/no 回退旧的"失败即静音"行为。
function _failOutcomeEnabled(env = process.env) {
  const flag = String((env && env.KHY_TOOL_OUTCOME_FAIL) || '')
    .trim()
    .toLowerCase();
  return !(flag === '0' || flag === 'false' || flag === 'off' || flag === 'no');
}

function toolOutcomeNarration(toolName, result = {}, params = {}, options = {}) {
  if (!result || typeof result !== 'object') {
    return '';
  }

  const name = normalizeToolName(toolName);
  const occ = options.occurrence;
  const p = params || {};
  const pathHint = String(p.file_path || p.filePath || p.path || '').trim();
  const baseName = pathHint ? baseNameAnyOs(pathHint) : '';
  // 门控包装(同 toolRunningNarration):关时只返首发句(= 历史死字符串),开时按本回合
  // 该类工具的出现次数轮换续接句,避免连读三个文件出三句逐字相同的结果旁白。
  const live = _liveVoiceEnabled(options.env);
  const _live = (first, continuations) => (live ? _voice(occ, first, continuations) : first);

  const failed =
    result.success === false ||
    result.isError ||
    result.is_error ||
    result.error != null ||
    result.denied;
  if (failed) {
    if (!_failOutcomeEnabled()) {
      return '';
    }
    // 有根因就说出根因(实时汇报「为什么没通」),取不到才回退旧 canned 行。
    const reason = _salientReason(result);
    if (reason) {
      return baseName
        ? `${baseName} 没通：${reason}——我据此调整，不盲试。`
        : `没通：${reason}——我据此调整，不盲试。`;
    }
    return baseName
      ? `${baseName} 这一步没走通，我先看下报错信息再调整方案。`
      : '这一步没走通，我先看下报错信息再调整方案。';
  }
  const out = result.output || result.content || result.text || '';
  const outStr = typeof out === 'string' ? out : '';

  // First finite number / array length among the candidates (mirrors the
  // structured fields summarizeToolResult reads), else null.
  const countOf = (...cands) => {
    for (const c of cands) {
      if (typeof c === 'number' && Number.isFinite(c)) {
        return c;
      }
      if (Array.isArray(c)) {
        return c.length;
      }
    }
    return null;
  };

  if (name === 'ls' || name === 'glob' || name === 'find' || name === 'findfiles') {
    const n = countOf(result.count, result.entries, result.files);
    if (n === 0) {
      return baseName
        ? _live(`${baseName} 这个位置现在是空的，我换个地方再找找。`, [
            `${baseName} 里也没东西，我再换个位置。`,
            `${baseName} 同样是空的，换条路找。`,
          ])
        : _live('这个位置现在是空的，我换个地方再找找。', [
            '这里也没东西，我再换个位置。',
            '同样是空的，换条路找。',
          ]);
    }
    if (n != null) {
      const where = baseName ? `${baseName} 下` : '这里';
      return _live(`好，${where}一共 ${n} 个条目，我心里大致有数了——接着挑关键的看一眼。`, [
        `${where}有 ${n} 个条目，先挑要紧的看。`,
        `这一层 ${n} 个，范围收窄了，继续往里走。`,
      ]);
    }
    return baseName
      ? _live(`${baseName} 列完了，接着挑关键的看一眼。`, [
          `${baseName} 也列完了，先挑要紧的看。`,
          `${baseName} 过了一遍，继续往里走。`,
        ])
      : _live('列完了，接着挑关键的看一眼。', [
          '这层也列完了，先挑要紧的看。',
          '过了一遍，继续往里走。',
        ]);
  }
  if (name === 'read' || name === 'readfile' || name === 'notebookread') {
    const lines =
      typeof result.lines === 'number' ? result.lines : outStr ? outStr.split('\n').length : null;
    if (baseName && lines != null) {
      return _live(`${baseName} 读完了，${lines} 行，结构我摸清了——接着按需要往下改。`, [
        `${baseName} 也看完了，${lines} 行，要点记下了。`,
        `${baseName} 这 ${lines} 行过了一遍，接着往下。`,
      ]);
    }
    if (baseName) {
      return _live(`${baseName} 读完了，结构我摸清了——接着按需要往下改。`, [
        `${baseName} 也看完了，要点记下了。`,
        `${baseName} 过了一遍，接着往下。`,
      ]);
    }
    return _live('读完了，结构清楚了，接着往下改。', [
      '这份也看完了，要点记下了。',
      '又过了一遍，接着往下。',
    ]);
  }
  if (name === 'grep' || name === 'search' || name === 'searchcontent') {
    const n = countOf(result.count, result.matches);
    if (n === 0) {
      return _live('这一轮没找到匹配，我换个关键词再找找。', [
        '这个词也没命中，我再换一个。',
        '仍然没有匹配，换个思路找。',
      ]);
    }
    if (n != null) {
      return _live(`找到 ${n} 处匹配，我逐个核对，先从第一处入手。`, [
        `这轮 ${n} 处，接着往下核对。`,
        `又是 ${n} 处，一并对一遍。`,
      ]);
    }
    return _live('匹配拿到了，我逐个核对。', [
      '这轮结果也拿到了，接着核对。',
      '又拿到一批，继续对。',
    ]);
  }
  if (name === 'write' || name === 'writefile' || name === 'createfile') {
    return baseName
      ? _live(`${baseName} 写好了，我回头跑一下确认它确实生效。`, [
          `${baseName} 也落盘了，稍后一起验。`,
          `${baseName} 写完，接着下一处。`,
        ])
      : _live('写好了，我回头验证一下。', ['这份也落盘了，稍后一起验。', '写完，接着下一处。']);
  }
  if (name === 'edit' || name === 'editfile' || name === 'multiedit' || name === 'notebookedit') {
    return baseName
      ? _live(`${baseName} 改好了，我回头验一下改动没有副作用。`, [
          `${baseName} 这处也改完了，接着下一处。`,
          `${baseName} 改动落下了，稍后一起验。`,
        ])
      : _live('改好了，我回头验证一下。', ['这处也改完了，接着下一处。', '改动落下了，稍后一起验。']);
  }
  if (name === 'bash' || name === 'shell' || name === 'shellcommand' || name === 'command') {
    if (result._background) {
      return _live('命令已经在后台跑起来了，我先继续别的，回头看它的输出。', [
        '这条也挂到后台了，我先做别的。',
        '后台又多了一条，回头一起收。',
      ]);
    }
    const exit = typeof result.exitCode === 'number' ? result.exitCode : 0;
    if (exit === 0) {
      return _live('命令跑通了，我接着往下走。', [
        '这条也过了，继续下一条。',
        '又通了一条，接着往下。',
      ]);
    }
    if (!_failOutcomeEnabled()) {
      return '';
    }
    // 非零退出:说出输出里的根因,而非笼统「看下报错」。取不到才回退。
    const reason = _salientReason(result);
    if (reason) {
      return `命令没通（exit ${exit}）：${reason}——我据此调整。`;
    }
    return `命令返回了非零退出码（${exit}），我先看下输出里的报错再调整。`;
  }
  if (name === 'websearch' || name === 'webfetch') {
    const n = countOf(result.count, result.results, result.data && result.data.results);
    if (n != null && n > 0) {
      return _voice(occ, `外部查到 ${n} 条，我把要点整理出来再回到正题。`, [
        `这轮又拿到 ${n} 条，一并归拢进来。`,
        `补到 ${n} 条，继续往下整理。`,
        `又是 ${n} 条，接着汇总。`,
      ]);
    }
    return _voice(occ, '外部信息拿到了，我把要点整理出来。', [
      '这轮资料也拿到了，继续归拢。',
      '又补齐一部分，接着整理。',
    ]);
  }
  if (name === 'todowrite') {
    return _live('待办清单更新好了，我照着它继续往下推进。', [
      '清单又对齐了一次，接着往下推。',
      '进度记上了，继续下一项。',
    ]);
  }
  if (name === 'agent' || name === 'task') {
    return _live('子任务那边有结果回来了，我把它收拢进主线。', [
      '又有一路子任务回来了，一并收拢。',
      '这一路的结果也到了，接着合。',
    ]);
  }
  return '';
}

// ── Task-level proactive plan announcement ("先讲清楚整件事怎么做") ───────────
// The before→during→after beats above are all PER-TOOL. This is the missing
// TASK-LEVEL beat. For a multi-step task the model is asked to outline its
// approach inside an <execution_plan> block, which the loop parses into
// { steps: [{ id, description, toolHint, parallelGroup, status }] } and then
// STRIPS from the visible text. Without surfacing it the agent silently chains
// tools — the plan the model already wrote is never shown. composePlanAnnouncement
// turns that parsed plan into ONE proactive, first-person statement of the whole
// job, so a complex turn opens with "here is what I am going to do, step by step"
// instead of a black box. Pure + deterministic; returns '' for an absent or
// single-step plan (a one-step "plan" adds nothing the per-tool preface does not),
// so the caller can stay silent.
function composePlanAnnouncement(plan, options = {}) {
  const steps = plan && Array.isArray(plan.steps) ? plan.steps.filter(Boolean) : null;
  if (!steps || steps.length < 2) {
    return '';
  }
  const maxShown = Number.isFinite(options.maxSteps) ? Math.max(2, options.maxSteps) : 6;
  const shown = steps.slice(0, maxShown);
  const lines = shown.map((s, i) => {
    const desc = String((s && s.description) || '').trim();
    return `${i + 1}. ${desc || '（待定）'}`;
  });
  // 同一会话里每回合都念同一句开场 + 同一句收尾 → 模板感。turnIndex(回合序号)当
  // occurrence 轮换措辞;turn 0/缺省或门控关 → 逐字节保持历史两句。
  const turn = _liveVoiceEnabled(options.env) ? Number(options.turnIndex) : 0;
  const parts = [
    _voice(turn, '我先讲下这件事打算怎么做：', [
      '这件事我打算这么拆：',
      '先把这轮的做法说在前面：',
      '这次的路径是这样：',
    ]),
    ...lines,
  ];
  const omitted = steps.length - shown.length;
  if (omitted > 0) {
    parts.push(`…（还有 ${omitted} 步，共 ${steps.length} 步）`);
  }
  if (steps.some((s) => s && s.parallelGroup)) {
    parts.push('其中标了同组的步骤可以并行推进。');
  }
  parts.push(
    _voice(turn, '我先从第 1 步开始。', [
      '这就从第 1 步动手。',
      '按上面的顺序，从第 1 步开始。',
      '先落第 1 步。',
    ])
  );
  return parts.join('\n');
}

// Forward-looking step transition ("第 2 步：…") — the task-level companion to
// toolOutcomeNarration's per-tool "结果 + 行动". Driven by the loop's
// onPlanProgress(stepIndex, status). Conservative by construction: it narrates
// ONLY a step BECOMING in_progress (the forward move the user cares about) and
// returns '' for every other transition, an out-of-range index, a missing
// description, or step 1 (already covered by the upfront announcement) — so it
// never doubles up with the per-tool outcome line.
function composePlanProgress(plan, stepIndex, status, options = {}) {
  const steps = plan && Array.isArray(plan.steps) ? plan.steps : null;
  if (!steps || steps.length === 0) {
    return '';
  }
  if (status !== 'in_progress') {
    return '';
  }
  const idx = Number(stepIndex);
  if (!Number.isInteger(idx) || idx <= 0 || idx >= steps.length) {
    return '';
  }
  const desc = String((steps[idx] && steps[idx].description) || '').trim();
  if (!desc) {
    return '';
  }
  // 一个任务里每步都念「第 N 步：…」→ 步数越多越像报菜名。用**步序**当 occurrence
  // (第一条可见步进 idx=1 → occ 0 → 逐字节保持历史句),之后逐步换连接词;门控关 → 全程历史句。
  const occ = _liveVoiceEnabled(options.env) ? idx - 1 : 0;
  return _voice(occ, `第 ${idx + 1} 步：${desc}。`, [
    `接着第 ${idx + 1} 步，${desc}。`,
    `往下是第 ${idx + 1} 步：${desc}。`,
    `第 ${idx + 1} 步，${desc}。`,
  ]);
}

// ── 段内点名检测(放宽过程叙述 gating)──────────────────────────────────────
// 缺口④:此前 TUI 的抑制条件是"模型一吐任何字就静音合成 preface",于是模型刚说一句
// 无关的话(「好的」「我来看看」)就把后续每个工具的意图叙述全掐掉,过程读起来缺细节。
// 放宽为:仅当模型本段文字**已具体点到这个工具的动作**时才静音——否则合成 preface 照常出。
//
// 判定走并集、宽松命中即视为"已点名"(保守偏向静音,避免在模型已自述时叠一条冗余):
//   1) 该工具类别关键词(读/看/搜/改/写/跑…)命中;
//   2) 路径 basename(跨 OS)出现在文字里;
//   3) 命令首 token(去路径后的裸命令名)出现在文字里;
//   4) pattern/query 被原样回显。
// 纯函数、单一真源,供 useQueryBridge 的 reducer 与单测共用。
const TOOL_MENTION_KEYWORDS = {
  ls: ['列', '目录', '条目'],
  glob: ['列', '找', '文件'],
  find: ['找', '查', '搜'],
  grep: ['搜', '找', 'grep', '查找', '匹配'],
  search: ['搜', '找', '查找', '检索'],
  read: ['读', '看', '查看'],
  readfile: ['读', '看', '查看'],
  notebookread: ['读', '看', '查看'],
  write: ['写', '写入', '创建', '新建'],
  writefile: ['写', '写入', '创建', '新建'],
  createfile: ['写', '创建', '新建'],
  edit: ['改', '修改', '编辑'],
  editfile: ['改', '修改', '编辑'],
  multiedit: ['改', '修改', '编辑'],
  notebookedit: ['改', '修改', '编辑'],
  bash: ['跑', '执行', '运行', '命令'],
  shell: ['跑', '执行', '运行', '命令'],
  shellcommand: ['跑', '执行', '运行', '命令'],
  command: ['跑', '执行', '运行', '命令'],
  websearch: ['搜', '检索', '联网', '外部'],
  webfetch: ['检索', '抓取', '外部', '获取'],
  scaffoldfiles: ['骨架', '脚手架', '搭', '生成'],
  agent: ['子任务', '并行', '委派', '交给'],
  task: ['子任务', '并行', '委派', '交给'],
};

function segmentMentionsTool(segmentText, toolName, params = {}) {
  const text = String(segmentText || '');
  if (!text.trim()) {
    return false;
  }
  const name = normalizeToolName(toolName);

  // 1) category keywords
  const keywords = TOOL_MENTION_KEYWORDS[name] || [];
  for (const kw of keywords) {
    if (kw && text.includes(kw)) {
      return true;
    }
  }

  const p = params || {};

  // 2) path basename (≥2 chars to avoid noise from a single-letter name)
  const pathHint = String(p.file_path || p.filePath || p.path || '').trim();
  if (pathHint) {
    const base = baseNameAnyOs(pathHint);
    if (base && base.length >= 2 && text.includes(base)) {
      return true;
    }
  }

  // 3) bare command name (first token, path-stripped)
  const commandHint = String(p.command || '').trim();
  if (commandHint) {
    const bare = baseNameAnyOs(commandHint.split(/\s+/)[0] || '');
    if (bare && bare.length >= 2 && text.includes(bare)) {
      return true;
    }
  }

  // 4) pattern / query echoed verbatim
  const patternHint = String(p.pattern || p.query || p.q || '').trim();
  if (patternHint && patternHint.length >= 2 && text.includes(patternHint)) {
    return true;
  }

  return false;
}

function buildStreamingToolPreface(toolName, inputHint = '', options = {}) {
  const hint = String(inputHint || '').trim();
  return toolProgressReason(
    toolName,
    {
      command: hint,
      path: hint,
      file_path: hint,
      pattern: hint,
      query: hint,
      q: hint,
    },
    options
  );
}

module.exports = {
  toolProgressReason,
  toolRunningNarration,
  toolOutcomeNarration,
  composePlanAnnouncement,
  composePlanProgress,
  segmentMentionsTool,
  buildStreamingToolPreface,
  occurrenceKey,
  suppressConsecutivePreface,
  _voice,
};
