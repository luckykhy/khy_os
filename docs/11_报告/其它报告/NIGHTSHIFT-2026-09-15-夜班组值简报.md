# 夜班组值简报 — khy-os 测试覆盖率

**运行日期**：2026-09-15（01:00 启动，~01:55 提前收尾）
**目标**：测试覆盖率提升到 80%，顺手修真 bug。
**状态**：本轮延续昨夜 khyquant 前端主攻方向，挑 4 个 0% 叶子模块（2 个 utils + 1 个 composable + 1 个 Pinia store）补契约测试，共 31 用例全绿；顺手揪出并修正 1 处测试误读私有状态的问题。后端/Python/ai-frontend 仅做回归守卫，未改。

---

## 一、各区域基线（before）

| 区域 | 命令 | 基线结果 |
|---|---|---|
| Python 启动器 | python -m unittest discover -s platform/tests -t platform/tests | 187 tests OK（全绿，回归守卫） |
| ai-frontend | cd apps/ai-frontend && npm test | 41 files / 531 tests 全绿（回归守卫，无 coverage 配置） |
| khyquant 前端（非覆盖） | cd software/khyquant/frontend && npm test | 27 files / 343 tests 全绿（昨夜已修绿 interaction.wiring） |
| khyquant 前端（覆盖率） | npm run test:coverage | 全局 9.52%（lines/stmts）/ 77.06% branches / 52.25% functions，仍远低于 80% 阈值 |
| 后端 jest（定向） | 定向跑 routes + SaveInstruction | routes 17 套件 / 202 用例全绿；SaveInstruction 7 用例全绿（DEBT §三 B 例，已转绿） |

> 80% 目标远未达成（khyquant 9.52%、后端 ~42%），故本轮继续「挑最弱区域加测试 + 修测试暴露的真 bug」策略，不转债务清理。

## 二、本轮补测（新增 4 个 khyquant 测试文件，31 用例，全绿）

均落在 khyquant 前端，按 skill 决策矩阵选 0% 叶子模块（vitest + jsdom，跟邻居风格）：

- src/__tests__/mobileChartConfig.test.js（7 用例）：锁 src/utils/mobileChartConfig.ts 的 mobile/desktop 图表配置形状、getChartOptions 的 isMobile 分派、tickMarkFormatter(M/D) 与 timeFormatter(日期/日期+时间) 口径。
- src/__tests__/performanceOptimizer.test.js（5 用例）：锁 src/utils/performanceOptimizer.js 的 throttleData（前置式、窗口内抑制）、debounce（非活动触发、保留 this 与末次参数）、enableHardwareAcceleration（transform-gpu 样式 + 空 el 安全 no-op）。
- src/__tests__/useFuturesTickData.test.js（7 用例）：锁 src/composables/useFuturesTickData.js 的三形态响应解包（data.data / data.dates / 裸数组）、loading 标志生命周期、空 date 短路、formatDate(YYYYMMDD→YYYY-MM-DD)。
- src/__tests__/strategyStore.test.js（12 用例）：锁 src/stores/strategyStore.js（Pinia setup store）的 CRUD 状态迁移（active 列表 / 删除清选择 / start·stop 状态翻转 / 未知 id 抛错）、回测结果 localStorage 持久化与删除、事件 on/off/emit 生命周期、cleanup 全量复位。

## 三、本轮修复的问题

1. **测试误读 Pinia 私有状态（@rot，非产品 bug）**：strategyStore 是 setup store，其 backtestResults / backtestHistory / strategyPerformance 三个响应式 Map 未在 return 中暴露，外部只能通过 getBacktestResult / getBacktestHistory 读取器访问。新测试初版直接 store.backtestResults.set(...) 拿到 undefined 而报错。已把测试改为全程走 store 暴露的公开 API（runBacktest 造数据、getBacktestResult 断言、deleteStrategy 后断言 Map 已清），既锁住行为又符合封装边界。产品代码无需改动。

## 四、验收（全绿）

- khyquant 前端 npm test：31 files / 374 tests 全绿（昨夜 343 + 本轮 31 新用例，0 回归）。
- khyquant 前端 npm run test:coverage：全局 9.52% → 10.63%（lines/stmts），functions 52.25% → 55.76%。仍低于 80% 阈值（预期——只补叶子，未动大组件）。
- ai-frontend npm test：531 全绿；Python 启动器 187 全绿（均未改动，回归守卫）。
- 后端定向：routes 17 套件 / 202 用例 + SaveInstruction 7 用例全绿（DEBT §三 B 的 19 个「双 runner 皆死」例已实测转绿，jest 直接 PASS）。
- check-agent-rules.js 扫本轮 4 个新测试文件：no violations。
- khy doctor：33 通过 / 8 警告（均为预存环境项——Git 未装、akshare 未装、AI 密钥未配、relay 404、后端服务未运行等——非本轮引入；本轮未改任何后端/服务文件）。
- eslint：khyquant 前端 eslint.config.js 引用的 eslint-plugin-vue 在 node_modules 中缺失（预存依赖缺口，与本轮无关），故 4 个新测试文件改用 node --check 语法校验 + vitest 实跑全绿兜底。

## 五、遗留问题（下一夜）

1. **khyquant 前端全局 10.63% 离 80% 仍很远**——本轮补 4 个叶子模块（+31 用例）。大组件（SimpleTradingInterface.js 143KB、useDashboardQuotes.js 42KB、useDashboardHandover.js 13KB、useTouchGestures.ts、networkMonitor.js、requestInterceptor.js、stores/user.js）尚未覆盖。下一夜继续挑 0% 的纯函数/composable/store 补测，不为变绿写低价值组件快照。
2. **后端 jest 全量（test:backend / 根 test:all）仍红**——预存债务（DEBT.md §一/§五）：约 67 个 test:scripts 子测试红、CJK 断言腐蚀（「工具计量汇总」等）、缺 src/services/search/searchNecessity.js。本轮未改后端，未动。
3. **khyquant 前端 eslint 设施缺依赖**（eslint-plugin-vue 未安装，eslint.config.js 无法加载）——建议在下一夜跑 pnpm install 补上该 devDependency，恢复前端 eslint 守卫可用；本轮已用 node --check + vitest 实跑兜底。
4. DEBT.md §三 B 的「19 个双 runner 皆死套件」实测 SaveInstruction 已转绿（jest PASS 7/7）；若继续，可在下一夜逐一定向跑剩余例并回收。

## 六、本次改动文件清单

- software/khyquant/frontend/src/__tests__/mobileChartConfig.test.js（新增，7 用例）
- software/khyquant/frontend/src/__tests__/performanceOptimizer.test.js（新增，5 用例）
- software/khyquant/frontend/src/__tests__/useFuturesTickData.test.js（新增，7 用例）
- software/khyquant/frontend/src/__tests__/strategyStore.test.js（新增，12 用例）

> 所有改动留在工作区，**未 commit、未 push**。未改 constants/serviceDefaults.js、未碰版本 6 源、未放宽任何既有测试基线。
