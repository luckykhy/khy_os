'use strict';

/**
 * timelineAppendMerge — 纯叶子(零 IO、确定性、绝不抛):把一段流式 text/thinking chunk 并入
 * 实时时间线,尾部同型段合并时用**单次**数组分配替代历史的**双重**分配。
 *
 * goal「希望 khyos 能够流畅使用」· 承 GC-churn 消除同族 [[staticItemsMemo]] · [[liveTimelineLazyNorm]]。
 *
 * 根因(reducer 侧,每 chunk 而非每 render):useQueryBridge 的 tlAppendText/tlAppendThinking 在
 * **每个**流式 text/thinking chunk(~25fps)上把 chunk 并入尾部同型段。历史写法
 *   `[...timeline.slice(0, -1), merged]`
 * 每 chunk 分配**两个**数组:`slice(0, -1)` 先分配一个 N-1 长数组,spread 再分配一个 N 长数组,
 * 合计 2(N-1) 次引用拷贝。N = 时间线段数,随 turn 增长(每个工具调用 + 交替文本各加段),故这是
 * 每 chunk O(N) 的**双重**分配 GC churn——与 [[staticItemsMemo]](每 render N 数组分配)、
 * [[liveTimelineLazyNorm]](每 render N 段预映射浅拷贝)同一类。
 *
 * 修:尾部同型合并改为 `const next = arr.slice(); next[next.length-1] = merged;` —— **单次**分配
 * N 长数组 + N 次引用拷贝,产出数组内容与历史写法**逐字节相同**(前缀 0..N-2 段引用同样保持不变,
 * 故下游按段身份记忆的 memo 不受影响),仅把每 chunk 的数组分配从 2 次降到 1 次。
 *
 * 诚实边界:这是**常数级(~2×)**的每 chunk 分配削减(仍是 O(N)/chunk,非渐进级消除)——如实标注,
 * 不夸大为复杂度改进。收益在长 turn(段数多)+ 长流式回答(chunk 多)时累积成可感 GC 压力下降。
 *
 * 门控 KHY_TIMELINE_APPEND_SINGLE_ALLOC(默认开;off/0/false/no → 逐字节回退历史双分配写法)。
 * 契约:绝不抛;任何异常 → 回退历史写法 / 原引用。
 */

const OFF_VALUES = ['0', 'false', 'off', 'no'];

/**
 * 门控查询。默认开;仅 0/false/off/no 关。
 * @param {object} [env]
 * @returns {boolean}
 */
function isEnabled(env = process.env) {
  const raw = env && env.KHY_TIMELINE_APPEND_SINGLE_ALLOC;
  const v = String(raw == null ? '' : raw).trim().toLowerCase();
  return !OFF_VALUES.includes(v);
}

/**
 * 历史双分配写法(逐字节回退真源)。与旧 tlAppendText/tlAppendThinking 内联表达式等价。
 */
function _legacyAppend(arr, text, type) {
  const last = arr[arr.length - 1];
  if (last && last.type === type) {
    return [...arr.slice(0, -1), { type, text: last.text + text }];
  }
  return [...arr, { type, text }];
}

/**
 * 把 chunk 并入时间线尾部同型段,尾合并用单次分配。
 *
 * 语义与旧 tlAppendText/tlAppendThinking 完全一致:
 *   - 空 chunk → 原样返回传入的 timeline(同一引用)。
 *   - 尾段 type === 传入 type → 合并文本(last.text + text),产出新数组(尾段替换)。
 *   - 否则 → 追加新段。
 * 产出数组内容与历史 `[...timeline.slice(0,-1), merged]` 逐字节相同,仅分配次数由 2 降到 1。
 *
 * @param {Array} timeline  当前时间线(useState 值;调用方传 s.timeline || [])
 * @param {string} text     本次 chunk 文本
 * @param {'text'|'thinking'} type  段类型
 * @param {object} [env]
 * @returns {Array} 新时间线(或空 chunk 时的原引用)
 */
function appendMergingLast(timeline, text, type, env = process.env) {
  if (!text) return timeline;
  try {
    const arr = Array.isArray(timeline) ? timeline : [];
    const last = arr[arr.length - 1];
    if (last && last.type === type) {
      const merged = { type, text: last.text + text };
      if (isEnabled(env)) {
        // 单次分配:slice() 复制一份 N 长数组,再原位替换尾段 → 一次分配、N 次引用拷贝。
        const next = arr.slice();
        next[next.length - 1] = merged;
        return next;
      }
      // 门控关:逐字节回退历史双分配。
      return [...arr.slice(0, -1), merged];
    }
    // 尾段非同型 / 空时间线:追加(与历史一致,本就单次分配)。
    return [...arr, { type, text }];
  } catch {
    // 极端异常兜底:仍尽量不抛,回退历史写法;再异常 → 原引用。
    try { return _legacyAppend(Array.isArray(timeline) ? timeline : [], text, type); }
    catch { return timeline; }
  }
}

module.exports = { isEnabled, appendMergingLast, _legacyAppend, OFF_VALUES };
