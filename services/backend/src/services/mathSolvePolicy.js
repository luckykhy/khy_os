'use strict';

/**
 * mathSolvePolicy.js — 纯叶子:让 khy 正确解数学题(含图片给题)、给出步骤、并对可代入复核
 * 的解做**确定性验证**的单一真源。
 *
 * 目标(goal 2026-06-27):「希望我给 khy 数学题,如微积分、方程组……等等,可能以图片的形式
 * 给出,khy 可以正确解题,能给出步骤」。
 *
 * 先核实再动手(绝不重造):Khyos 已有
 *   - 视觉/OCR 栈(visionRouting / visionOcrFallback / adapterVisionCapability(codex 原生视觉)/
 *     ocrSnippetService(tesseract))——图片转文本/原生识图是它们的职责;本叶子**不**做数学 OCR
 *     (tesseract 对数学符号不可靠,真正的读题主路径是原生视觉模型),只在带图时命令模型「先准确
 *     转写题目并复述确认、读不出就如实说」。
 *   - groundTruth(精确有理数算术)/ answerVerifier(生成后确定性复核模型写出的纯数值等式)。
 * 真缺口有二,本叶子各补一刀:
 *   (1) **无任何**数学解题指令:没有东西识别「这是数学题」并命令模型分步骤解、解完自检。
 *   (2) **无方程解的代入复核**:answerVerifier 只复核模型写出的纯数值等式,无法把「模型给的解」
 *       代回方程验证是否真满足。本叶子补:教模型产出机器可核验块 → 用 groundTruth 的**同一套**
 *       精确有理数核(evaluateRational/equalsUnderBindings)代入验证,绝不重写一份算术求值器。
 *
 * 诚实能力边界(写进指令、GUARDS):确定性验证只覆盖**可代入的代数解**(方程/方程组,且解为
 * 有理数 → 代回精确比对左右相等)。**符号微积分恒等式**(如「∫ 的原函数对不对」)无法用本层
 * 确定性证明——指令要求模型自行求导回代自检并展示,但 khyos 不伪称已机器验证,如实标注。
 *
 * 纯叶子:零 IO、确定性、绝不抛、fail-soft、单一真源。env 门控 KHY_MATH_SOLVE(默认开;仅
 * 显式 0/false/off/no 关闭;关闭后 routeMathSolve 返回空指令、verifySolution 不复核 → 接缝
 * 字节回退,系统提示词与答复逐字节不变)。不使用 eval / new Function。
 */

const _FALSY = new Set(['0', 'false', 'off', 'no']);

/** 门控判定。默认开,仅显式 0/false/off/no 关闭。 */
function isEnabled(env) {
  const v = (env || process.env || {}).KHY_MATH_SOLVE;
  return !(v !== undefined && _FALSY.has(String(v).trim().toLowerCase()));
}

// ── 数学题意图识别(零假阳性优先;关键词为主,均为线性正则,无灾难性回溯)──────────
const _CALCULUS_RE = /(求导|导数|微分|偏导|积分|定积分|不定积分|原函数|极限|泰勒|级数|微积分|梯度|derivative|differentiat|integral|integrate|antiderivative|\blim\b|limit|taylor|∫|d\s*\/\s*dx)/i;
const _EQUATION_RE = /(方程组|方程|解方程|联立|未知数|求根|方程的根|不等式|solve\b|equation|simultaneous|inequalit)/i;
const _LINALG_RE = /(矩阵|行列式|线性方程组|特征值|特征向量|向量|matrix|matrices|determinant|eigen|linear\s+system)/i;
const _SOLVE_INTENT_RE = /(解一?下|解这|解出|求解|求出|求这|计算|算一?下|算出|化简|证明|展开|因式分解|solve|compute|evaluate|simplify|factor|find\s+(the\s+)?(value|roots?|solution|x\b))/i;
// 形如 `2x+3=7` / `x^2-5x+6=0` 的变量方程:左有字母、右有数字,中间仅数学字符(有界,防回溯)。
const _VAR_EQUATION_RE = /[A-Za-z][\sA-Za-z0-9+\-*/^().]{0,80}=[\s0-9A-Za-z+\-*/^().]{0,80}[0-9)]/;
// 是否含「数字 + 算符」的算式(配合解题意图判定),有界。
const _HAS_EXPR_RE = /\d\s*[-+*/^]\s*[0-9A-Za-z(]/;

// 去掉代码块与行内 code,避免示例里的字样干扰意图识别。委托单一真源 utils/stripCodeSpans。
const _stripCode = require('../utils/stripCodeSpans');

/**
 * 识别一段文本是否为数学题,并给出题型(用于指令措辞)。零假阳性优先。
 * @param {string} text
 * @returns {{isMath:boolean, kinds:string[]}}
 */
function detectMathProblem(text) {
  try {
    const cleaned = _stripCode(text);
    if (!cleaned.trim()) return { isMath: false, kinds: [] };
    const kinds = [];
    if (_CALCULUS_RE.test(cleaned)) kinds.push('calculus');
    if (_LINALG_RE.test(cleaned)) kinds.push('linear-algebra');
    if (_EQUATION_RE.test(cleaned) || _VAR_EQUATION_RE.test(cleaned)) kinds.push('equation');
    // 解题意图 + 存在算式:兜住「解一下 3*(4+5)」「计算 12/7」这类无领域关键词但确为数学题。
    if (!kinds.length && _SOLVE_INTENT_RE.test(cleaned) && _HAS_EXPR_RE.test(cleaned)) kinds.push('general');
    return { isMath: kinds.length > 0, kinds };
  } catch { return { isMath: false, kinds: [] }; }
}

// ── 解题指令(注入系统提示词)─────────────────────────────────────────────────
/**
 * 产出 [SYSTEM:] 数学解题协议指令。命中数学题才产出(否则空串)。
 * @param {object} args
 * @param {string[]} [args.kinds]   题型(detectMathProblem 的结果)
 * @param {boolean}  [args.hasImage] 本轮是否带图片(带图则强化「先转写+复述确认+读不出如实说」)
 * @returns {string}
 */
function buildMathSolveDirective({ kinds = [], hasImage = false } = {}) {
  const lines = [
    '[SYSTEM: 数学解题协议]',
    '本轮是数学题。请按以下协议作答,目标是「答案正确 + 步骤完整可验证」:',
  ];
  if (hasImage) {
    lines.push(
      '1) 读题(图片):先把图片里的题目**完整、准确**转写成文本——公式、上下标、分数、根号、',
      '   积分号、矩阵都要转对;并在作答开头**复述你读到的题目**,便于用户纠正。',
      '   **若图片中的数学内容看不清/读不出,如实说明并请用户补充或粘贴文字,绝不臆测、绝不编造题目。**',
    );
  }
  lines.push(
    `${hasImage ? '2' : '1'}) 分步骤:完整展示推导过程,每一步说明依据/所用定理,绝不跳步直接抛答案。`,
    `${hasImage ? '3' : '2'}) 精确计算:数值一律先给**精确值**(整数/最简分数/根式);需要小数时再给近似并标注「≈」。`,
    '   绝不靠心算;大整数/小数交由确定性运算,避免进位与浮点误差。',
    `${hasImage ? '4' : '3'}) 解完**必做自检**,并把自检过程展示出来:`,
    '   · 解方程/方程组:把解代回**每一个**原方程,验证左右两边相等;',
    '   · 不定积分:对你求得的原函数**求导**,验证恰好得回被积函数;',
    '   · 定积分/极限/数值题:复核关键数值算式;',
    '   · 化简/恒等式:代入具体数值到两边比对。',
    `${hasImage ? '5' : '4'}) 对**可代入数值复核**的题(解方程/方程组,且解为有理数),在答复中追加一个机器可核验块,`,
    '   khyos 会用精确有理数**自动代入复核**你的解是否真满足方程(这是给你的解上一道确定性保险):',
    '',
    '   ```khy-check',
    '   vars: x=2, y=1',
    '   eq: 2*x + 3*y = 7',
    '   eq: x - y = 1',
    '   ```',
    '',
    '   规则:`vars:` 写你给出的解(有理数,可写分数如 3/2);`eq:` 逐行写**原方程**;',
    '   乘法**必须显式写 `*`**(写 `2*x`,不要写 `2x`);无理数/超越解无法精确表示时可省略此块。',
    `${hasImage ? '6' : '5'}) 诚实边界:超出可确定性验证范围的结论(典型:符号微积分恒等式)如实标注「需人工复核」,`,
    '   绝不伪称「已验证」。你不确定的地方要说不确定。',
  );
  void kinds; // 题型目前不改变协议主体(协议对各类数学题通用);保留参数以备将来分型措辞。
  return lines.join('\n');
}

/**
 * 编排:识别数学题并产出注入指令。镜像 routeGroundTruth 的契约。
 * @param {object} args
 * @param {string}  args.text
 * @param {boolean} [args.hasImage]
 * @param {object}  [args.env]
 * @returns {{isMath:boolean, kinds:string[], directive:string}}
 */
function routeMathSolve({ text = '', hasImage = false, env } = {}) {
  if (!isEnabled(env)) return { isMath: false, kinds: [], directive: '' };
  const det = detectMathProblem(text);
  if (!det.isMath) return { isMath: false, kinds: [], directive: '' };
  return { isMath: true, kinds: det.kinds, directive: buildMathSolveDirective({ kinds: det.kinds, hasImage }) };
}

// ── 解的代入复核(生成后,消费模型吐出的 ```khy-check 块)──────────────────────
const SOLUTION_MARKER = '【khyos 解题复核】';
const _FENCE_RE = /```\s*khy-?check\s*\r?\n([\s\S]*?)```/gi;
const _MAX_BLOCKS = 8;
const _MAX_EQS = 40;

/**
 * 解析单个 khy-check 块体 → { bindings, eqs:[{text,lhs,rhs}] }。绝不抛。
 */
function _parseCheckBlock(body) {
  const bindings = {};
  const eqs = [];
  const linesArr = String(body || '').split(/\r?\n/);
  for (const rawLine of linesArr) {
    const line = rawLine.trim();
    if (!line) continue;
    const varsM = /^vars?\s*:\s*(.+)$/i.exec(line);
    if (varsM) {
      for (const pair of varsM[1].split(/[,;]/)) {
        const eqIdx = pair.indexOf('=');
        if (eqIdx <= 0) continue;
        const name = pair.slice(0, eqIdx).trim();
        const val = pair.slice(eqIdx + 1).trim();
        if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) && val) bindings[name] = val;
      }
      continue;
    }
    const eqM = /^eq\s*:\s*(.+)$/i.exec(line);
    if (eqM) {
      const rest = eqM[1].trim();
      if (rest.includes('<') || rest.includes('>')) continue;   // 只处理等式,不处理不等式
      const parts = rest.split('=');
      if (parts.length !== 2) continue;                          // 必须恰好一个 '='
      const lhs = parts[0].trim();
      const rhs = parts[1].trim();
      if (!lhs || !rhs) continue;
      eqs.push({ text: rest, lhs, rhs });
    }
  }
  return { bindings, eqs };
}

/**
 * 复核模型答复里 ```khy-check 块声明的解是否**精确满足**所列方程(代入 + 精确有理数比对)。
 * 复用 groundTruth.equalsUnderBindings(同一精确有理数核,零浮点),绝不另写求值器。
 * 无法精确求值的方程(含无理/超越/未绑定变量)一律跳过(零假阳性:无法确认即不下结论)。
 * @param {string} text  模型答复正文
 * @param {object} [env]
 * @returns {{ran:boolean, confirmed:Array<{eqText:string}>, falsified:Array<{eqText:string,lhs:string,rhs:string}>}}
 */
function verifySolution(text, env) {
  const result = { ran: false, confirmed: [], falsified: [] };
  try {
    if (!isEnabled(env)) return result;
    const raw = String(text == null ? '' : text);
    if (!raw || raw.indexOf('khy-check') === -1 && raw.indexOf('khycheck') === -1) return result;
    let gt;
    try { gt = require('./groundTruth'); } catch { return result; }
    if (typeof gt.equalsUnderBindings !== 'function') return result;

    let block;
    let blocks = 0;
    let totalEqs = 0;
    _FENCE_RE.lastIndex = 0;
    while ((block = _FENCE_RE.exec(raw)) !== null) {
      if (blocks >= _MAX_BLOCKS) break;
      blocks += 1;
      const { bindings, eqs } = _parseCheckBlock(block[1]);
      for (const eq of eqs) {
        if (totalEqs >= _MAX_EQS) break;
        totalEqs += 1;
        const r = gt.equalsUnderBindings(eq.lhs, eq.rhs, bindings);
        if (!r || !r.ok) continue;            // 无法精确求值(无理/超越/未绑定)→ 跳过,不下结论
        result.ran = true;
        if (r.equal) result.confirmed.push({ eqText: eq.text });
        else result.falsified.push({ eqText: eq.text, lhs: r.lhs, rhs: r.rhs });
      }
    }
  } catch { /* fail-soft:复核是附加证据,出错绝不阻断答复 */ }
  return result;
}

/**
 * 把代入复核结果组装成用户可见注记。
 *  - 有证伪 → 权威指出「此解不满足方程」(交由 answerVerifier 并入「可证伪」段)。
 *  - 全部满足 → 正向确认「已确定性验证解正确 ✓」。
 * @param {{ran:boolean, confirmed:Array, falsified:Array}} r
 * @returns {string|null}  正向确认注记(失败注记由 answerVerifier 的 buildVerificationNote 渲染)
 */
function buildSolutionConfirmation(r) {
  try {
    if (!r || !r.ran) return null;
    if (Array.isArray(r.falsified) && r.falsified.length) return null; // 有失败时不出正向注记
    const confirmed = Array.isArray(r.confirmed) ? r.confirmed : [];
    if (!confirmed.length) return null;
    return `\n\n${SOLUTION_MARKER} 我已用精确有理数把你给出的解代回每个原方程复核:全部 ${confirmed.length} 个方程都精确满足 ✓(此解经 khyos 确定性验证为真)。`;
  } catch { return null; }
}

module.exports = {
  isEnabled,
  SOLUTION_MARKER,
  detectMathProblem,
  buildMathSolveDirective,
  routeMathSolve,
  verifySolution,
  buildSolutionConfirmation,
};
