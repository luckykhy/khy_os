# [OPS-MAN-151] 缓存前缀击穿归因接线（promptPrefixShape → cacheWarning → REPL）

## 背景 — 「能力存在但没接线」

`services/backend/src/constants/promptPrefixShape.js` 是一枚**完整实现且带契约测试**的纯叶子
（`captureShape` / `compareShape` / `describeReasons` / `isPrefixShapeEnabled`，门控
`KHY_CACHE_PREFIX_SHAPE` 默认开），对标 Reasonix `cache_shape.go`：把「provider 前缀缓存
命中率低」从一个数字变成**可定位**——直接告诉你「这一轮为什么没命中」（系统提示 / 工具集 /
工具顺序变了）。

但它**此前零消费者**（`grep -rl promptPrefixShape src` 只命中自身与其测试），`flagRegistry`
里 `KHY_CACHE_PREFIX_SHAPE` 亦是登记却无人读的孤儿门。既有 `cacheWarning.js` 只报一个百分比，
命中低时不知道是谁击穿了前缀——正是本叶子要补的洞。本轮把它接线。

## 修改（全 additive，与既有装饰性 footer 同构）

1. **capture（发送侧）** — `aiGatewayGenerateMethod.js` 的 `finishResult` 终局（成功分支，
   `result.success === true`）对本轮实际发往 wire 的 `options.system` + `options.tools` 拍前缀
   快照，挂到 `result.prefixShape`。纯确定性哈希、零 IO、绝不抛；门控关 → `captureShape` 返
   `null` → 不挂字段（逐字节回退）。display-only，绝不影响生成/重试/内容。

2. **attribution helper（判定侧）** — `cacheWarning.js` 新增 `prefixAttributionFor(input, env)`：
   委派 `promptPrefixShape` 叶子，给定本轮 `curShape`（= `result.prefixShape`）与调用方持有的
   `prevShape`，产出「为什么没命中」的一行归因。首观 / 前缀未变 → `text:null`；门控关 / 无
   `curShape` / 任何错误 → `null`（逐字节 no-op）。纯无状态，调用方存 `shape` 作下轮 `prevShape`。

3. **display（消费侧）** — `replSession.js` 缓存命中率警告块：新增进程作用域基线
   `_lastPrefixShape`；**仅当命中率跌破阈值（已有 `cw.text` 警告）时**才调
   `prefixAttributionFor` 并追加一行 `↳ 缓存前缀被击穿：…变了`。无低命中警告时归因属噪音，故
   不显示。每轮（无论是否警告）刷新 `_lastPrefixShape` 以供下轮趋势对比；无 shape → 保持不动。

## 不变量

1. **归因只在命中率低时出现**——`display-only`，attribution 无低命中警告即噪音。
2. **门控关 = 逐字节回退**：`KHY_CACHE_PREFIX_SHAPE=off` → 不挂 `result.prefixShape` →
   `prefixAttributionFor` 返 null → REPL 不打归因行；与本刀之前逐字节等价。
3. **纯确定性 + fail-soft**：SHA-256 短哈希确定性；任何异常在每一层 catch 成安全空值，绝不
   打断生成返回或回合。
4. **绝不回灌模型/碰权限/预算**：只是给返回对象加一个诊断字段 + 打一行 dim 提示。

## 验证

- `node --test tests/cli/cacheWarning.test.js tests/constants/promptPrefixShape.test.js` → 30/30
  （cacheWarning 13→20：+7 覆盖 `prefixAttributionFor` 首观/系统提示变/前缀未变/门控关/坏输入
  + 两条源级接线断言；promptPrefixShape 叶子 10 例既有）。
- `node --check` × 3 源文件 ok；`wc -l`：cacheWarning 249 < 2500，两处 god-file
  （aiGatewayGenerateMethod 3494 / replSession 9832）grandfathered 仅 additive。
- 我切片 `check-change-safety` 显式 positional → exit 0；`flag-registry` PASS；
  `leaf-contract` PASS；`agent-rules` 0 error（1 warn = replSession:3652 `no-opaque-status`
  pre-existing 非我）；`maintainer:check` exit 0。

## 教训

1. 孤儿叶子（实现+测试俱全但零消费者）= 「能力存在没接线」最直接一类；判据 =
   `grep -rl <leaf> src` 只命中自身。
2. 归因/诊断类信息只在**触发条件**（命中率低）下呈现，否则是噪音；把「一个数字」升级成
   「可定位」才是叶子的价值。
3. capture 落在**发送侧**（system+tools 在 scope 的 `finishResult` chokepoint），compare/display
   落在**消费侧**（REPL 持跨回合基线），中间靠 `result.prefixShape` 一个 additive 字段传递——
   不威胁 B3 外科手术式改动。

不 commit（feat/0.1.104 / 1.0.0 里程碑同批）。
