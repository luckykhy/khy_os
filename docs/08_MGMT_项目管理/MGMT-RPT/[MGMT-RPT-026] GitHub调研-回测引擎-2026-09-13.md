# GitHub 调研 — 回测引擎与策略模拟板块 — 2026-09-13

> 每日板块轮转调研（索引 4/12）：khy-os 回测引擎板块（`software/khyquant/services/backtestEngine.js` 日级引擎、`tickBacktestEngine.js` tick 级引擎、`strategyEngine.js` 策略执行、`routes/backtest.js` 回测路由）对标 GitHub 开源量化回测框架，寻找可借鉴点。
> 注：`services/backend/src/services/backtestEngine.js` 是 quantApp 的兼容别名 shim（[DESIGN-TOOL-002] §3.4），真实实现位于 L4 应用层 `software/khyquant`。

## 调研对象

khy-os 回测引擎板块现状：

| 组件 | 位置 | 机制 |
|---|---|---|
| 日级回测 | `software/khyquant/services/backtestEngine.js` | vm 沙箱执行策略 signal 函数，单标的、按收盘价零成本成交，算 8 项指标 |
| tick 级回测 | `software/khyquant/services/tickBacktestEngine.js` | 期货 tick CSV，有佣金/滑点/保证金/多空，但无 T+1 |
| 策略执行 | `software/khyquant/services/strategyEngine.js` | JS/Python/TDX 三语言，有硬编码 0.0003 佣金 + 0.001 印花税雏形 |
| 回测路由 | `software/khyquant/routes/backtest.js` | 收 `symbols[]` 但只跑 `symbols[0]`，结果落 Sequelize 无指纹 |

**短板（5 条）**：

1. **无 A股 T+1 结算**：`backtestEngine.js:202-217` 的 buy/sell 在同一条 bar 内即时成交且同 bar 可卖，不符合 A股「今日买入不可今日卖出」核心规则，结果系统性失真。
2. **日级引擎零交易成本**：`backtestEngine.js:208` 直接 `cash -= qty*close`，无佣金、无印花税、无滑点；`strategyEngine.js` 已有成本雏形但未进主引擎。
3. **结果不可复现**：`routes/backtest.js` 落库无「策略代码 + 参数 + 数据区间」指纹，同参数改数据或改策略代码后无法对照复跑。
4. **无基准对齐与扩展风险指标**：只有 Sharpe（无风险利率=0）+ 最大回撤 + 胜率，缺 Sortino/Calmar/年化波动率/beta/alpha/超额收益，无 vs HS300 或买入持有对比。
5. **单标的**：`routes/backtest.js:53` 只跑 `symbols[0]`，多资产组合回测缺失。

## 对标项目

| 项目 | Star（2026-09-13） | 技术栈 / 许可 | 相关度 | 链接 |
|---|---|---|---|---|
| backtrader | ~23.2k | Python / GPLv3 | 高：broker/commission/slippage/sizer/Cerebros 分层，最贴近 Node 单进程引擎 | https://github.com/mementum/backtrader |
| QuantConnect/Lean | ~21.6k | C# + Python / Apache-2.0 | 高：多资产/基准对齐/WalkForward，体量巨大取设计 | https://github.com/QuantConnect/Lean |
| freqtrade | ~54.3k | Python / GPLv3 | 高：hyperopt + 回测缓存指纹（可复现性典范） | https://github.com/freqtrade/freqtrade |
| microsoft/qlib | ~48.5k | Python / MIT | 高（A股）：T+1/涨跌停/中国市场规则唯一权威参照 | https://github.com/microsoft/qlib |
| vectorbt | ~9.1k | Python / 许可证 NOASSERTION | 中：向量化多参数批量回测架构，Pro 化只借设计 | https://github.com/polakowo/vectorbt |
| nautilus_trader | ~28.9k | Rust + Python / LGPLv3 | 中：生产级事件驱动，对日频单进程引擎过重 | https://github.com/nautechsystems/nautilus_trader |

**关键发现**：七大框架无一内置 A股 T+1/涨跌停——它们面向欧美/加密市场，默认即时成交。T+1 与涨跌停是**必须自实现的市场规则**，qlib 是规则参照的唯一权威来源。

## 值得借鉴的点

### 1. A股 T+1 结算锁定（P0）

**对方怎么做**：qlib 回测执行语义中「今日买入不可今日卖出」是 A股核心规则。开源界无现成 Node 实现，需自实现：维护 `lockedShares` 计数，bar i 买入的份额在 bar i+1 才允许卖出。

**khy-os 现状差在哪**：`backtestEngine.js:202-217` buy/sell 同 bar 即时成交，T+0 失真。

**改哪些文件**：`software/khyquant/services/backtestEngine.js`（模拟循环，加 `lockedShares` + 当日不可卖判定）。

### 2. 交易成本模型：佣金 + 印花税 + 滑点参数化（P0）

**对方怎么做**：backtrader `comminfo.py` 的 `CommInfoBase` 支持 perc/fixed 佣金，`brokers/bbroker.py` 提供 `set_slippage_perc()`/`set_slippage_fixed()`；每笔 trade 记录费用字段。khy-os `strategyEngine.js:468/494` 已有 0.0003 佣金 + 0.001 印花税硬编码雏形，但未进主引擎。

**khy-os 现状差在哪**：`backtestEngine.js` 零成本成交，A股卖出 0.1% 印花税 + 双边佣金完全缺失。

**改哪些文件**：`software/khyquant/services/backtestEngine.js`（加 `commissionRate`/`stampDutyRate`/`slippage` 可选参数，默认对齐 strategyEngine 的 0.0003/0.001，trade 记录费用字段）。

### 3. 结果指纹可复现（P0）

**对方怎么做**：freqtrade `optimize/backtest_caching.py` 用 SHA-1 对 config + 策略文件哈希生成唯一 key，参数/策略变更自动失效缓存。

**khy-os 现状差在哪**：`routes/backtest.js` 落库无指纹，结果不可对照复跑。

**改哪些文件**：`software/khyquant/routes/backtest.js`（加 `resultFingerprint = sha1(strategy.code + JSON.stringify(params) + symbol + start + end + 成本参数)` 字段）。

### 4. 基准对齐 + 补齐风险指标（P1）

**对方怎么做**：Lean 对 benchmark 算 excess return、Sortino、Calmar、beta/alpha；vectorbt `portfolio/` 支持 benchmark series。

**khy-os 现状差在哪**：只有 Sharpe（rf=0）+ 最大回撤 + 胜率，缺 Sortino/Calmar/年化波动率/beta/alpha，无 HS300 对比。

**改哪些文件**：`backtestEngine.js` 指标段（纯计算，加 `benchmarkClose` 可选输入）。

### 5. 参数网格 / 滚动验证（P1）

**对方怎么做**：backtrader Cerebros 多实例批量回测容器；Lean WalkForward 滚动 in-sample/out-of-sample；freqtrade hyperopt + overfitting 防护（train/test split、random-seed）。

**khy-os 现状差在哪**：单参数单标的，无 grid search、无 walk-forward、无过拟合防护。

**改哪些文件**：`backtestEngine.js` 加 `paramsGrid` 选项（Node 单进程天然适合循环批量跑）。

### 6. 涨跌停 ±10%/±20% 成交约束（P1）

**对方怎么做**：qlib 数据含 limit-up/limit-down 标志，涨停无法买入 / 跌停无法卖出。

**khy-os 现状差在哪**：`klineDataService` 已有 `changePercent`，但引擎未判定涨跌停跳过成交。

**改哪些文件**：`backtestEngine.js` 模拟循环（数据侧已有 `changePercent`，只需判定 |changePercent| ≥ 阈值时该 bar 不可成交）。

### 7. 多资产组合回测（P2）

**对方怎么做**：bt `bt/backtesting.py` 的 `universe` 多资产 + 组合再平衡；Lean 单算法内多 symbol 跨资产组合净值。

**khy-os 现状差在哪**：`routes/backtest.js:53` 只跑 `symbols[0]`。

**改哪些文件**：`routes/backtest.js` + `backtestEngine.js`（重构量大，留后续）。

## 落地建议（排序）

| # | 行动 | 优先级 | 工作量 |
|---|---|---|---|
| 1 | A股 T+1 结算锁定（`lockedShares`，当日买入次日才可卖） | P0 | 1 小时 |
| 2 | 交易成本模型：佣金 0.0003 + 印花税 0.001（卖出）+ 滑点参数化，trade 记录费用 | P0 | 1 小时 |
| 3 | 结果指纹：SHA-1(策略代码 + 参数 + 标的 + 区间 + 成本参数) 随回测记录落库 | P0 | 半小时 |
| 4 | 基准对齐 + Sortino/Calmar/年化波动率/beta/alpha 补齐 | P1 | 半天 |
| 5 | 参数网格 + walk-forward in/out-of-sample | P1 | 1 天 |
| 6 | 涨跌停 ±10%/±20% 成交约束 | P1 | 半天（依赖数据侧标志） |
| 7 | 多资产组合回测 | P2 | 数天 |

## 参考链接

- https://github.com/mementum/backtrader — `comminfo.py`、`brokers/bbroker.py`、`sizers.py`、`cerebro.py`
- https://github.com/freqtrade/freqtrade — `optimize/backtest_caching.py`（指纹）、`optimize/hyperopt/`
- https://github.com/microsoft/qlib — A股 T+1/涨跌停规则参照
- https://github.com/QuantConnect/Lean — 基准对齐、WalkForward
- https://github.com/polakowo/vectorbt — 向量化多参数（仅借设计，许可证 NOASSERTION）
- https://github.com/nautechsystems/nautilus_trader — 确定性重放（思想参照）

## 落地记录

### 已实现条目（3 条 P0）

**P0-1 A股 T+1 结算锁定（qlib 规则，自实现）** — ✅ 已实现
- `software/khyquant/services/backtestEngine.js`：模拟循环新增 `lockedShares` 计数——bar i 买入的份额进 `lockedShares`，bar i+1 循环顶 `position += lockedShares` 解锁；卖出仅作用于已解锁的 `position`，当日买入不可当日卖出。`options.tPlus1` 默认 `true`（A股），可设 `false` 退回 T+0（非 A股标的）。
- 强制平仓分支把 `position + lockedShares` 一并了结，避免 T+1 锁定的余仓在数据末尾被遗漏。

**P0-2 交易成本模型：佣金 + 印花税 + 滑点（backtrader comminfo 分层设计）** — ✅ 已实现
- `backtestEngine.js` 新增 `DEFAULT_COSTS`（commissionRate 0.0003 双边、stampDutyRate 0.001 仅卖出、slippage 0.001、tPlus1 true）作为本引擎成本单一真源，对齐 `strategyEngine.js:468/494` 既有的 0.0003/0.001 硬编码，两套引擎不再分叉。
- `resolveCosts(options)` 解析有效成本模型（数值可覆盖、未指定走默认）；买入按 `close*(1+slippage)` 成交、卖出按 `close*(1-slippage)`，trade 记录新增 `commission`/`stampDuty`/`slippageCost`/`totalCost` 字段。
- 结果对象新增顶层 `totalCommission`/`totalStampDuty`/`totalSlippageCost` 与 `execution` 元数据块（成本参数 + 费用合计），让使用者看清数字是在哪些假设下产生的。

**P0-3 结果指纹可复现（freqtrade backtest cache key）** — ✅ 已实现
- `backtestEngine.js` 新增 `buildFingerprint({signalCode, params, symbol, startDate, endDate, costs})`：对确定性决定结果的要素做 SHA-1，取 16 位 hex。同输入恒同指纹，改策略代码/参数/区间/成本模型任一即变。
- `run()` 返回结果携带 `fingerprint` 字段；`routes/backtest.js` 把 `resultFingerprint` + `execution` 写进 `Backtest.parameters`（JSON 字段），**不改 DB schema/migration**（符合「不改 schema」红线）。

### 改动文件清单

| 文件 | 类型 | 说明 |
|---|---|---|
| `software/khyquant/services/backtestEngine.js` | 改 | T+1 结算（`lockedShares`）、成本模型（`DEFAULT_COSTS`/`resolveCosts`/滑点/印花税/费用字段）、结果指纹（`buildFingerprint`）、导出附 `buildFingerprint`/`resolveCosts`/`DEFAULT_COSTS` |
| `software/khyquant/routes/backtest.js` | 改 | 回测落库追加 `resultFingerprint` + `execution` 到 `parameters` JSON 字段 |
| `software/khyquant/tests/backtestEngine.test.js` | 新增 | 5 个 `node:test` 用例（成本默认/覆盖、指纹确定性+输入敏感、T+1 锁定、成本降资金） |

### 检查结果

- `require('./software/khyquant/services/backtestEngine.js')` + `require('./routes/backtest.js')`：✅ 加载成功
- `node --test software/khyquant/tests/backtestEngine.test.js`：✅ 5/5 通过
- `node scripts/ci/check-agent-rules.js backtestEngine.js routes/backtest.js backtestEngine.test.js`：✅ 3 文件零违规

### 未实现项（标「待人工决策」，P1/P2）

- **P1 基准对齐 + 风险指标补齐（Sortino/Calmar/年化波动率/beta/alpha、vs HS300 或买入持有）**：纯计算层，加在指标段，需先定基准数据源（HS300 指数 K线），留后续
- **P1 参数网格 + walk-forward in/out-of-sample**：`backtestEngine.run` 加 `paramsGrid` 选项即可（Node 单进程循环批量跑），但优化目标函数与过拟合防护（deflated Sharpe）需单独立项
- **P1 涨跌停 ±10%/±20% 成交约束**：依赖数据侧 `changePercent` 判定，`klineDataService` 已有该字段，引擎侧只需加「|changePercent| ≥ 阈值时该 bar 不可成交」判定
- **P2 多资产组合回测**：`routes/backtest.js:53` 只跑 `symbols[0]`，需重构 `backtestEngine.run` 支持多 symbol 组合结算，重构量大
- **`strategyEngine.js` 硬编码佣金/印花税收敛到 `DEFAULT_COSTS`**：本次只统一了主引擎，`strategyEngine.js:468/494` 的 0.0003/0.001 仍各自硬编码，留后续统一引用
