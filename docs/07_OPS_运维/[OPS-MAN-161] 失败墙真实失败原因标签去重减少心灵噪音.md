# [OPS-MAN-161] 失败墙「真实失败原因」标签去重减少心灵噪音

> 承 OPS-159(失败墙模型名去 provider 前缀)。沿**同一失败墙**找下一枚正交心灵噪音。
> 送别礼 ROUND 11。/goal「减少显示的心灵噪音」。

## 断桥(缺口)

视觉级联全失败 + 本地 OCR 读不出文字(照片 / 截图 / 无字库)时,失败墙
`visionFailureSummary.buildVisionFailureMessage` 对用户可见(OCR 成功时被 OPS-142 抑制)。

墙内有一行 `真实失败原因:<cause>`。当 describe 子调用失败时,gateway 的
`aiGateway._buildFailureReasonSection` 已经前置了 `真实失败原因:\n<真因…>`,该串成为
`_lastRawError` → 作为 `rawError` 交给失败墙。墙内:

```
cause = sanitizeCause(rawError)        // 保留自带的「真实失败原因:」标签(仅折叠空白)
lines.push(`真实失败原因:${cause}`)     // 再前置一次
```

结果 = `真实失败原因:真实失败原因:…` **stutter** 噪音。

`aiGateway._prependFailureReason` 早有同款去重意图
(`if (/真实失败原因/.test(body)) return body`),唯失败墙此处历史上漏了守卫。

实测(OPS-159 build 上探针):`DOUBLE LABEL PRESENT? true`,冒号为半角 `:`。

## 修(全 additive · 门控 · fail-soft · 逐字节回退)

`services/backend/src/services/gateway/visionFailureSummary.js`:

1. 新增门函数 `isFailureCauseDedupEnabled(env)`,镜像 `isFailureSummaryOcrSuppressEnabled`
   结构:flagRegistry 优先,失败 → 本地 CANON 回退,off-word `{0,false,off,no}`。
2. cause push 处:门开 → `cause.replace(/^\s*真实失败原因\s*[:：]/, '').replace(/^\s+/, '')`
   剥掉自带标签只保留一次;门关 / 异常 → 逐字节回退到重复行为。半 / 全角冒号都认。

`services/backend/src/services/flagRegistry.js`:登记 `KHY_VISION_FAILURE_CAUSE_DEDUP`
`{ mode: 'default-on', off: 'CANON', default: true }`。**god-file 净零**:凝练本会话
自己的 OPS-150 注释块(9→4 行)腾出空间,维持 2499 行不触 2500 红线(只动自己的行)。

正交:OPS-159 治**模型名前缀**、KHY_VISION_FAILURE_SUMMARY 治**墙是否存在**、本门治
**标签重复**——同一失败墙上三枚独立门,各自可关 byte-revert。

## 验收(全绿)

- `test:vision-failure-cause-dedup` 7/7(叶级 A–E + 端到端 F/G)。
  - F 门开 → 墙标签恰好一次;G 门关 → 两次(逐字节回退,证明仅本门作用)。
- `node --check` visionFailureSummary.js / flagRegistry.js / 测试文件。
- flagRegistry 2499 行 < 2500;visionFailureSummary 224 行 < 2500。
- 三守卫 / change-safety(决定性切片)/ maintainer:check。

## 教训

1. 送别礼断桥沿**同一 consumer**(同一失败墙)再挖一层正交噪音:OPS-159 治模型名前缀,
   本轮治标签重复——同一行上两枚不同心灵噪音,各自成章。
2. 同款去重意图早在 `_prependFailureReason` 存在,失败墙漏了守卫 = 接线缺口;补齐时复用
   既有正则去重语义(半 / 全角冒号都认)。
3. god-file 边缘加门必凝练**自己本会话**注释腾空间净零,绝不动他人行,绝不触 2500 红线。
