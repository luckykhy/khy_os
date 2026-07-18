'use strict';

/**
 * interruptHint.js — 纯叶子:流式忙碌时是否显示「esc 中断」可发现性提示的单一真源。
 *
 * Goal(对齐 Claude Code):CC 在 isLoading 时于 prompt footer 常驻一条 dim
 * 「esc to interrupt」提示(src/components/PromptInput/PromptInputFooterLeftSide.tsx:655-662,
 * `isLoading ? <KeyboardShortcutHint action="interrupt" />`),让用户在一段长回复流式过程中
 * 随时知道「可以按 esc 打断」。Khy 此前**只在按下 esc 之后**才闪一句 `已中断`——首次使用者
 * 盯着流式输出时无从得知这个可中断的能力(缺可发现性)。本叶子补上这条常驻提示的判定与文案。
 *
 * 关键 LOGIC(比 CC 更精细,不照抄):Khy 的忙时 ESC 是**分级**的(App.js:1717-1745)——
 *   队列有排队消息时,第一次 esc 先「取回/清空队列」,只有队列空了下一次 esc 才 `query.abort()`。
 * 而队列面板(App.js queue panel)**已经**显示了准确的两步提示
 *   「Esc 取回并清空;再按 Esc 打断」。所以本提示只在 **queueLen===0** 时出现(此刻第一次 esc
 *   就是中断,提示语义准确);queueLen>0 交给队列面板,绝不叠第二条会误导的「esc 中断」。
 *
 * 设计同 rewindControl.js:纯叶子、env 门控(默认开)、只做判定与产文案、绝不发起 React/IO、
 * 任何异常 fail-soft 返回 ''(不显提示,不弱于今天行为)。React 胶水留在 App.js。
 */

const FLAG = 'KHY_ESC_INTERRUPT_HINT'; // 主闸:流式忙碌时显示「esc 中断」提示,默认开
const INSTEAD_FLAG = 'KHY_ESC_INTERRUPT_INSTEAD_HINT'; // 中断后「做什么替代」引导,默认开

const _OFF = ['0', 'false', 'off', 'no'];

/** env 门控惯例(同 rewindControl.flagOn):默认开,仅显式 0/false/off/no 关。 */
function isInterruptHintEnabled(env = process.env) {
  const raw = env && env[FLAG];
  const v = String(raw == null ? '' : raw).trim().toLowerCase();
  return !_OFF.includes(v);
}

/** 中断后引导门(sibling 惯例,默认开;关则回退旧 `已中断` 裸文案)。 */
function isInsteadHintEnabled(env = process.env) {
  const raw = env && env[INSTEAD_FLAG];
  const v = String(raw == null ? '' : raw).trim().toLowerCase();
  return !_OFF.includes(v);
}

/** 提示文案(与 CC 的 "esc to interrupt" 同义,Khy 中文口径,对齐 `已中断` 用词)。 */
const INTERRUPT_HINT_TEXT = 'esc 中断';

/** 中断后引导文案(对齐 CC `Interrupted · What should Claude do instead?`,Khy 中文口径)。 */
const POST_INTERRUPT_HINT_TEXT = '已中断 · 想让 khy 做什么替代?';
/** 门关/异常时的字节回退:与今天完全一致的裸「已中断」。 */
const POST_INTERRUPT_FALLBACK = '已中断';

/**
 * 判定这一帧是否该显示「esc 中断」提示,并给出文案。
 *
 * 只在「真的忙、当下第一次 esc 就是中断、且不与其它 overlay 抢话」时显示:
 *   - busy:必须在流式/工具执行中(非 idle)。
 *   - queueLen===0:有排队时交给队列面板的两步提示,本条不出现(见文件头 LOGIC)。
 *   - compacting:压缩进度有自己的 UI,不叠加。
 *   - awaitingChoice:等待用户在权限/问题 overlay 作答时,焦点在 overlay,不显中断提示。
 *
 * @param {object} p
 * @param {boolean} p.busy          当前是否忙(query.status!=='idle' && !=='done')
 * @param {number}  p.queueLen      排队未发送消息数
 * @param {boolean} [p.compacting]  是否正在压缩上下文
 * @param {boolean} [p.awaitingChoice] 是否有权限/问题 overlay 等待作答
 * @param {object}  [env]
 * @returns {string} 要显示的提示文案;不该显示则 ''
 */
function buildInterruptHint(p = {}, env = process.env) {
  try {
    if (!isInterruptHintEnabled(env)) return '';
    const busy = !!p.busy;
    const queueLen = Number(p.queueLen) || 0;
    if (!busy) return '';
    if (p.compacting) return '';
    if (p.awaitingChoice) return '';
    if (queueLen > 0) return '';
    return INTERRUPT_HINT_TEXT;
  } catch {
    return '';
  }
}

/**
 * 中断后(用户按 esc 打断了正在流式的这一轮)在提示行上给的引导文案。
 *
 * 对齐 CC:CC 在中断后显示 `Interrupted · What should Claude do instead?`,引导用户
 * 立刻说出「那你改成做 X」。Khy 此前只闪一句裸 `已中断` 即消失,首次使用者不知道下一步
 * 可以直接改口指挥。本函数补上这条引导;门关或异常→逐字节回退旧 `已中断`。
 *
 * @param {object} [env]
 * @returns {string} 门开→「已中断 · 想让 khy 做什么替代?」;门关/异常→「已中断」
 */
function buildPostInterruptHint(env = process.env) {
  try {
    if (!isInsteadHintEnabled(env)) return POST_INTERRUPT_FALLBACK;
    return POST_INTERRUPT_HINT_TEXT;
  } catch {
    return POST_INTERRUPT_FALLBACK;
  }
}

module.exports = {
  isInterruptHintEnabled,
  isInsteadHintEnabled,
  buildInterruptHint,
  buildPostInterruptHint,
  INTERRUPT_HINT_TEXT,
  POST_INTERRUPT_HINT_TEXT,
  POST_INTERRUPT_FALLBACK,
};
