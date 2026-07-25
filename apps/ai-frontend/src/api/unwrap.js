/**
 * unwrap(res) — 后端响应信封解包的单一真源(SSOT)。
 *
 * 全站 REST 后端统一返回 `{ success, data, ... }` 信封;axios 又把它包进
 * `res.data`。此函数剥两层:先取 `res.data`(payload),若 payload 是带
 * `success`+`data` 的信封对象则返回 `payload.data`,否则原样透传 `payload ?? res`
 * (兼容极少数不套信封的端点)。
 *
 * 历史上这段逻辑被逐字复制到 13 个 composable/view 里(名为 `unwrap` 或
 * `unwrapResponse`),多处注释已自称 "shared" 却物理分叉——任何一处改了信封判定
 * 就会与其余悄悄矛盾。这里收敛为唯一定义;所有消费方 `import { unwrap }`。
 *
 * 纯函数:不改入参、无副作用、绝不抛(可选链 + ?? 兜底)。
 */
export function unwrap(res) {
  const payload = res?.data
  if (payload && typeof payload === 'object'
    && Object.prototype.hasOwnProperty.call(payload, 'success')
    && Object.prototype.hasOwnProperty.call(payload, 'data')) {
    return payload.data
  }
  return payload ?? res
}
