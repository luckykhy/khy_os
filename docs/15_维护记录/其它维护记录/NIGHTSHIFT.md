# NIGHTSHIFT.md — 夜班覆盖冲刺简报（覆盖式单文件）

> 本文件每夜被下一次夜班**覆盖式**更新；仅保留最近一夜的记录。
> 历史夜班的恢复记录请查 `tests/DEBT.md` §七/§八/§九 恢复日志。

---

## 夜班 5（2026-09-18 01:00 → 01:25）

**目标**：khy-os 全区域测试覆盖率推进（80% 总目标，分区域逐步逼近）。
**本次策略**：选 1–2 个最弱区域补测试（khyquant 前端弱覆盖模块），顺手修 bug；
不修改产品代码基线、不放宽任何现有测试。

---

### 1. 基线测量（开工前）

| 区域 | 工具 | 基线值 |
|------|------|--------|
| khyquant（software/khyquant/frontend） | vitest + v8 coverage | **17.28%** 语句覆盖（381 测试全绿，32 文件，昨夜遗留） |
| ai-frontend（apps/ai-frontend） | vitest | 531 测试全绿（41 文件基线） |
| Python 平台层（platform/） | python -m unittest | 187 测试全绿 |
| 后端 services/backend（jest） | jest | 全量 OOM（已知，v8 heap limit），定向 suite 执行 |

> 说明：本轮 01:00 开工时 ai-frontend 实际为 43 文件 / 544 测试（较 09-16 夜班
> 基线 41/531 增长，来自工作树中新增的 a11yContract / designTokenCompliance /
> themeParity 测试文件，预存变更），按「以实际基线为准」记录。

---

### 2. 本次新增测试（5 个文件，57 用例，全部通过）

全部落在 khyquant 前端 `src/__tests__/`（vitest + jsdom，与邻居风格一致，mock 邻居风格）：

#### 2.1 `requestInterceptor.test.js`（14 用例）
锁 `src/utils/requestInterceptor.js` 的错误分类契约：
- 请求配置器：GET 注入时间戳参数防缓存、非 GET 不注入、配置错误直接 reject
- 错误类型判定：5xx→server、404→notfound、401/403→auth（静默）、其他 4xx→client、
  ECONNABORTED→timeout、Network Error/ERR_NETWORK→network、无法识别→unknown
- 自定义 `response.data.message` 优先于默认文案
- 连续失败阈值：前 4 次不触发 `returnToSplash`，第 5 次触发（修复指引文案）；
  成功响应重置计数
- **测试技巧**：模块挂全局 axios（`main.js` 中调用已注释），测试自行
  `setupRequestInterceptor()` 装配一次，直接驱动 `axios.interceptors.*.handlers[0]`

#### 2.2 `sandboxExecute.test.js`（8 用例）
锁 `src/utils/sandboxExecute.js` 沙箱执行契约：成功归一（signals/auxiliaryData
缺省 `[]`/`{}`）、language/parameters 透传、`success=false` 走 `res.message` 文案
throw、HTTP 异常原样透传不吞。mock `@/utils/request`。

#### 2.3 `userStore.test.js`（16 用例）
锁 `src/stores/user.js`（Pinia setup store）公共暴露面：
- token 归一化 + localStorage 同步（空串清除）
- 连接模式切换凭证清洗：cloud→local 清云端 JWT、local→cloud/auto 清 local 伪 token
- `updateBackendUrl` trim + 持久化；`logout` 互斥、finally 清理、fail-soft
- `loginUser` 本地回退（local 模式无响应类错误回退本地登录；cloud 模式按
  `shouldFallbackLocalAuth` 回退）
- mock 邻居风格：`@/api/auth`、`@/services/localAuthService`、`@/utils/connectionMode`
  全部 hoisted mock；store 走 `setActivePinia(createPinia())` 每用例新建

#### 2.4 `useDashboardHandover.test.js`（10 用例）
锁 `src/composables/useDashboardHandover.js` 交接快照契约：摘要全零归一/非对象回退、
保留变更截断 5 条、`loadHandoverSnapshot` 成功/业务失败（fail-soft）/网络异常/
失败 ElMessage.error/并发排队（allowQueue 默认 true，完成后自动 queued_refresh）。
**未锁**：SSE 通道状态机（channelState ref 为内部私有，不在 return 暴露面，
按「只测公共 API」原则留待下夜用组件挂载级测试补）。

#### 2.5 `useDashboardLanAccess.test.js`（9 用例）
锁 `src/composables/useDashboardLanAccess.js` 公共可测契约：LAN URL 生成规则
（IP→`:8080`、域名→无端口、空→空串）、toggleQrCode 切换 + generateQrCode 短路
（无 canvas 不加载 QRCode；有 canvas 调 `loadQRCode`；失败 `ElMessage.error`）、
copyLanUrl 剪贴板成功/降级 `document.execCommand`。
**测试技巧**：jsdom 未实现 `document.execCommand`，需 `document.execCommand = vi.fn(() => true)`
注入替身（`vi.spyOn` 对不存在的属性会抛 "execCommand does not exist"）。

---

### 3. 覆盖率推进（before → after）

| 区域 | 覆盖前 | 覆盖后 | 变化 |
|------|--------|--------|------|
| khyquant 语句覆盖（全局） | 17.28% | **18.52%** | +1.24 pp |
| khyquant 分支 / 函数 | 80.38% / 63.9% | 81.64% / 63.88% | +1.26 pp / 持平 |
| khyquant 测试数 | 381（32 文件） | **438（37 文件）** | +57 用例 / +5 文件 |
| ai-frontend | 544 全绿（43 文件基线） | 544 全绿 | 持平 |
| Python 平台层 | 187 全绿 | 187 全绿 | 持平 |

> 80% 目标未达成（当前 khyquant 全局 18.52%），按规程继续下一夜推进。

---

### 4. 顺手 bug 修复

本次 **未发现产品代码 bug**。5 个新增文件均为纯测试添加，产品代码零改动。

测试技巧坑记录（非产品 bug，供下一夜参考）：
- jsdom 下 `vi.spyOn(document, 'execCommand')` 抛 "does not exist"，直接
  赋值 `document.execCommand = vi.fn(...)` 即可
- 模块级 composable 的内部 ref（如 `handoverRealtimeChannelState`）无法从
  公共暴露面写入，SSE 状态机需组件挂载级测试（下夜候选）
- `requestInterceptor.js` 挂在**全局 axios**（非 `request.js` 单例），
  `main.js` 调用已被注释——测试须自行 `setupRequestInterceptor()` 装配

---

### 5. 验收记录（按 AGENTS.md 验收顺序）

| 步骤 | 命令 | 结果 |
|------|------|------|
| 新增 5 文件单测 | `npx vitest run src/__tests__/{requestInterceptor,sandboxExecute,userStore,useDashboardHandover,useDashboardLanAccess}.test.js` | **57/57 通过** |
| eslint（改动文件） | `npx eslint src/__tests__/*.test.js --max-warnings 0`（khyquant，5 新文件） | **0 警告** |
| agent-rules（改动文件） | `node scripts/ci/check-agent-rules.js <5 个新文件>` | **无违规（5 文件）** |
| khyquant 全量测试 | `cd software/khyquant/frontend && npm test` | **37 文件 / 438 测试全绿** |
| khyquant 覆盖率 | `npm run test:coverage` | **语句 18.52% / 分支 81.64% / 函数 63.88% / 行 18.52%** |
| ai-frontend 全量 | `cd apps/ai-frontend && npx vitest run` | **43 文件 / 544 测试全绿** |
| Python 平台层 | `python -m unittest discover -s platform/tests -t platform/tests` | **187 全绿（OK）** |
| test:docs | `npm run test:docs` | **54 通过 / 0 失败** |
| test:scripts | `npm run test:scripts` | **964 通过 / 3 失败**（见下方说明） |
| khy doctor | `node services/backend/bin/khy.js doctor` | **36 通过 · 5 警告**（均为既有环境警告） |

#### test:scripts 3 个失败（均为预存 fixture 漂移债务，非本次引入）

本轮 5 个新增文件全部在 `software/khyquant/frontend/src/__tests__/`，
不在 test:scripts（`scripts/tests/**`）覆盖范围内，未修改 `scripts/tests/` 任何文件：

1. `coverage-gate.test.js:15` — 期望 threshold=60，实际 `undefined`（配置 fixture 漂移，09-16 已登记）
2. `provider-contract.test.js:14` — 期望 18 个 exporter，实际 19（fixture 漂移，09-16 已登记）
3. `externalRules.test.js:139` — 断言 `ARCH-068 是已知的外部规则` 失败（规则表漂移，**新增**，
   09-16 夜班时该用例通过；根因是 RULES-REGISTRY/外部规则表在 09-16 → 09-18 之间
   发生了变更（工作树 3528 个修改文件的大规模 churn），非测试腐坏，属预存债务）

#### doctor 5 个警告（均为既有环境警告）

Git 未安装、akshare 未安装、AI 密钥未配置、API 云端通道诊断异常、
云端未登录——与本次改动无关。

---

### 6. 遗留问题与下一夜计划

**遗留债务**（详见 `tests/DEBT.md`）：

- **khyquant 覆盖率**：18.52% 语句覆盖，距 80% 目标仍有 61.5 pp 差距。
  下一夜优先目标（按代码量与可测性排序）：
  1. `src/composables/useDashboardHandover.js` 的 SSE 状态机
     （需组件挂载级测试，mock fetch ReadableStream 驱动帧解析/重连退避）
  2. `src/utils/simpleTradingMarketData.js`（297 行，最大未覆盖 util）
  3. `src/utils/tickCsvParser.js`（275 行，已有 tickCsvParser.test.js，可加增量）
  4. `src/composables/useDashboardQuotes.js`（1060 行，最大 composable）
  5. `src/services/websocketService.js`（已有 17 用例，可补断线重连路径）

- **test:scripts 3 个 fixture 漂移失败**：`coverage-gate` / `provider-contract` /
  `externalRules`（ARCH-068）。前两个 09-16 已登记；第三个为本轮新发现，
  需同步外部规则表后对齐期望值。

- **后端 465 失败 suite**（`tests/DEBT.md` §一）：未触及；后端 jest 全量 OOM
  持续存在，定向 suite 正常。

- **后端弱覆盖模块**：09-16 已补 intentHeuristics；下一夜可继续挑
  `services/backend/src/services/` 下零依赖叶子模块（node:test）。

**下一夜开始时间**：2026-09-19 01:00
**下一夜目标区域**：khyquant `useDashboardHandover` SSE 状态机（挂载级）
+ 后端 `services/` 下一个零依赖叶子模块

---

*写入时间：2026-09-18 01:25（本地时间）*
*写入者：夜班组（khyos-testing skill，第 5 夜）*
