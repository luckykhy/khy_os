'use strict';

// staticItemsMemo.js — pure leaf (zero IO, deterministic, never throws).
//
// 目的:消除 useQueryBridge 每次 render 都重建整份 `staticItems` 包装数组的浪费。
//
// 背景(诊断):`staticItems` = banner + messages.map(每条包一层 {kind,key,msg}),在 hook 体里
// **每次 render 都重跑**(每个流式帧 ~25fps 的 setStreaming、每次按键的输入 state、每秒 nowTick 都
// 触发 render)。但 committed transcript(messages)只在真正提交/回溯/压缩时变;绝大多数 render 里
// messages 引用**原封不动**(useState 值未变)。于是每帧凭空 new 出 N+1 个包装对象 → O(messages)
// 分配/GC 压力,随会话变长越来越重(长会话里打字/流式发卡)。Ink `<Static>` 只渲染新增项(按长度
// 增量),故这些重建的对象绝大多数从不产生新渲染 = 纯 GC 噪声。
//
// 修复:按 messages **数组引用**记忆。messages 是 useState 值 —— 仅当内容真变时 setMessages 才产生
// 新数组引用(已核实:所有写入走 [...m]/concat/map,无原位 push/splice;patchUserCheckpointId 无命中
// 时返回同引用)。故「引用未变 ⟺ 内容未变」:引用命中 → 复用上次的 items(零分配);引用变 → 重建。
// 重建时内容与今日 `[{kind:'banner',...}].concat(messages.map(...))` **逐字节等价**(deepEqual)。
//
// 门控 KHY_STATIC_ITEMS_MEMO 默认开;关 → 每次都重建(逐字节回退今日:每 render 一份新数组)。
// 纯叶子无跨 render 状态:缓存由调用方(hook 的 useRef)注入 `prev` 并接住返回的 `cache`。

const OFF_VALUES = ['0', 'false', 'off', 'no'];

function isEnabled(env = process.env) {
  const raw = env && env.KHY_STATIC_ITEMS_MEMO;
  const v = String(raw == null ? '' : raw).trim().toLowerCase();
  return !OFF_VALUES.includes(v);
}

/**
 * 构造 committed <Static> 区的包装数组 —— 与今日表达式逐字节等价:
 *   [{ kind:'banner', key:'banner' }].concat(messages.map((msg,i)=>({ kind:'message', key:`m${i}`, msg })))
 * @param {Array} messages
 * @returns {Array<{kind:string,key:string,msg?:*}>}
 */
function buildStaticItems(messages) {
  const msgs = Array.isArray(messages) ? messages : [];
  const items = new Array(msgs.length + 1);
  items[0] = { kind: 'banner', key: 'banner' };
  for (let i = 0; i < msgs.length; i++) {
    items[i + 1] = { kind: 'message', key: `m${i}`, msg: msgs[i] };
  }
  return items;
}

/**
 * 按 messages 数组引用记忆包装数组。调用方(hook)用 useRef 持有 `prev`,并把返回的 `cache`
 * 写回 ref;下次传入即命中。绝不抛(异常 → 退回重建 + 空缓存,逐字节回退)。
 *
 * @param {{msgs:Array, items:Array}|null} prev - 上次返回的 cache(首次传 null)
 * @param {Array} messages - 当前 messages(useState 值)
 * @param {object} [env]
 * @returns {{ items:Array, cache:{msgs:Array,items:Array}|null }}
 */
function reconcileStaticItems(prev, messages, env = process.env) {
  try {
    if (!isEnabled(env)) {
      // 门控关:每次重建、不缓存(逐字节回退今日每 render 一份新数组)。
      return { items: buildStaticItems(messages), cache: null };
    }
    if (prev && prev.msgs === messages && Array.isArray(prev.items)) {
      // 引用命中(内容未变)→ 复用上次 items,零分配。
      return { items: prev.items, cache: prev };
    }
    const items = buildStaticItems(messages);
    return { items, cache: { msgs: messages, items } };
  } catch {
    return { items: buildStaticItems(messages), cache: null };
  }
}

module.exports = { isEnabled, buildStaticItems, reconcileStaticItems, OFF_VALUES };
