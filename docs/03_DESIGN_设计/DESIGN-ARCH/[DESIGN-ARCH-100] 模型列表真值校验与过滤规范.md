<!-- 文档分类: DESIGN-ARCH-100 | 阶段: 设计 | 原路径: 新建 -->
# [DESIGN-ARCH-100] 模型列表真值校验与过滤规范

> **强制规范 · 模型选择面「存在性真值」的单一真源** · 回答两个问题：①为什么前端会展示后端根本调不通的模型；②任何入口要展示/应用一个模型之前,必须经过哪几道闸。
>
> **定位**：本文管**模型列表从「候选池」收敛为「真值表」**这件事。它不替代 `constants/models.js`（模型**名**的单一真源）、`gateway/modelCuration.js`（用户对展示列表的**增删改**意图）、`modelFeatureRegistry`（**能力**记录）。
>
> **实现单一真源**：`services/backend/src/services/gateway/modelListTruth.js`（纯叶子）。本文是规则的散文真源,该叶子是规则的代码真源,两者必须同步。
>
> **门控**：`KHY_MODEL_LIST_TRUTH`（默认开,仅 `{0,false,off,no}` 关;关 → 逐字节回退今日行为）。
>
> **谁该读**：任何要新增 gateway 适配器、新增模型来源、改动模型选择器 / 自动路由 / 最近模型 / 启动默认值的人或 AI。

---

## 一、现象（用户逐字报告）

> 「在 khyos 系统的多模型选择功能中,前端 TUI 与后端实际模型列表经常不一致：tui 会莫名跳转到不存在的模型（如 Oenaigpt5.3 code review、winsurful claude sonnet3.5）并触发报错,且模型列表中频繁出现大量真实不存在的模型。」

拆成四条可验证的症状：

| # | 症状 | 真实含义 |
| --- | --- | --- |
| S1 | 列表里「大量真实不存在的模型」 | 展示的是**猜测**（静态目录 / 本机扫描 / env 逗号串），被当成了事实 |
| S2 | 「莫名跳到不存在的模型」 | 存在**绕过列表构建**的应用路径（F2 最近模型、启动默认、历史残留），把早已不存在的 `(adapter, model)` 直接写进偏好 |
| S3 | 「前端与后端不一致」 | 同一条记录在**列表侧**判「可选」、在**调用侧**判 404 —— 存在性结论从未被收敛到单一真值 |
| S4 | 「选中后报错」 | 报错不是根因,是 S1/S2 的下游表现（`model_not_found` 只在真正调用时才暴露） |

> 关于用户举的两个名字（用户手抄,已失真）：`gpt-5.3-codex-review` 是本仓真实存在过的 codex 模型 ID（见 `services/backend/tests/gatewayModelSelection.strictProbe.test.js`）;`claude sonnet3.5` 对应 windsurf 通道静态目录里的 `claude-3.5-sonnet`（`windsurfAdapter.js:83`）与本机扫描出的 `sonnet3.5` 形态。名字对不上不影响定性 —— 它们都是**「被当事实展示的猜测」**。

---

## 二、根因定位（附证据）

**一句话根因**：适配器的 `listModels()` 是**候选池**而不是**真值表**。它把「上游亲口返回的 id」与「静态目录 / 本机正则扫描 / env 逗号串」扁平地混成同一个数组,下游无从分辨**事实**与**猜测**,于是把猜测展示成可选模型。

`gateway/modelCuration.js:4-8` 早已把这条定性写在模块头上,只是当时只治了 web 管理页一侧：

> 各 gateway 适配器的 listModels() 有的返回硬编码静态列表（claude/cursor/warp），有的带硬编码 fallback（codex/kiro/relay）。网关的 available 只代表「已装/已登录/可达」，与模型 ID 是否真实解耦，导致 UI 出现「不存在的模型」。

### RC1 — 静态硬编码目录被无差别并入列表，且标成「内置」而非「猜测」

`services/backend/src/services/gateway/adapters/_ideTokenMixin.js` 的 `buildModelList()`（≈282-360）把 `knownModels`（静态目录）与扫描结果一起 `addModel()`,来源由 `resolveSource()` 回落到 `builtin` / `local`。

- `windsurfAdapter.js:82-92` `KNOWN_MODELS`：`claude-3.5-sonnet`、`kimi2.6`、`swe-1.6-m1.5` …
- `claudeAdapter.js:826-858`：`discoverySource: 'builtin'`
- `codexAdapter.js:801-839`：`FALLBACK_MODELS` → `discoverySource: 'builtin'`
- `traeAdapter.js:2363-2389`：无 token 时直接返回 `KNOWN_MODELS` → `discoverySource: 'builtin'`

### RC2 — 本机扫描用正则把**任意文本**当模型 ID

- `gateway/modelDiscovery.js:49-50` `MODEL_ID_REGEX`、`:84-98` `isLikelyModelId()`：只要字符串里含 `gpt|claude|sonnet|…` 就算模型 ID。
- `adapters/_ideTokenMixin.js:171` `MODEL_TOKEN_REGEX = /\b[a-zA-Z0-9][a-zA-Z0-9._:-]{2,80}\b/g`、`:183-204` `extractModelIdsFromString()`：对 IDE `storage.json` 里**任意字符串值**全量抽 token,再按 `isLikelyModelId` 过滤。
- `modelDiscovery.js:176-181`：对所有文件类型（含 JSON）都额外跑一遍宽正则兜底。

→ `claude sonnet 3.5` 这种**散文片段**就是这样变成「模型 ID」的（`claude-3.5-sonnet`、`sonnet3.5` 亦然）。

### RC3 — 垃圾 ID 会被**持久化**，形成自污染闭环

- `cli/handlers/gatewayProviderKeyPool.js:239-315` `handleGatewayDiscoverModels` → `modelDiscovery.updateRelayModelsInEnvFile()`（`modelDiscovery.js:236-258`）把扫描结果 **merge 进 `.env` 的 `RELAY_API_MODELS`**。
- `adapters/relayApiAdapter.js:573-590` `parseRelayModelHints()` 把它读回来,标 `discoverySource: 'hint'`。

→ 一次扫描的产物会永久留在模型列表里；`.env` 每被读一次,垃圾就复活一次。

### RC4 — 默认过滤几乎全关，且只对 codex 生效

`cli/handlers/gateway.js` 常量块（≈198-207）：

```js
const MODEL_HIDE_FALLBACK_MODELS_ENABLED =
  String(process.env.KHY_MODEL_HIDE_FALLBACK_MODELS || 'false').toLowerCase() !== 'false'; // → false
const MODEL_HIDE_HINT_MODELS_ENABLED =
  String(process.env.KHY_MODEL_HIDE_HINT_MODELS || 'false').toLowerCase() !== 'false';     // → false
```

- `'false' !== 'false'` → **两个默认全关**。
- 即便打开,`_filterModelsByReliability()` 里 `hideHintForAdapter = adapterType === 'codex'`、`hideFallbackForAdapter = adapterType === 'codex'` —— **只对 codex 生效**。

唯一默认开的是 `MODEL_HIDE_UNVERIFIED_ENABLED`,但它只在「generation 告警 **且** 条目 > 3」时做「留默认 + 按族去重到 3 条」的**降噪**,不是存在性校验。

### RC5 — 已存在的存在性探针没有参与列表构建

`aiGatewayModelMethods.js:763` 有 `verifyModel()`（真跑一次最小生成）、`modelCuration` 有 `getVerifyStatus()` / `recordVerify()`（TTL 缓存）,但 `buildGatewayModelChoices()` 的列表构建**完全不看**探活结果 —— 它只用通道级 `testAdapter`。探活结论只在 web 管理页被投影显示。→ 同一模型,web 说「failed」,TUI 说「可用」。

### RC6 — 应用路径无对账，且「最近模型」写入路径写错被静默吞掉

- `cli/handlers/gatewayModelChoices.js` `applyGatewayModelSelection()` 直接持久化**任意** `{adapter, model}`（写 `.env` 偏好 + `lastVerifiedModelStore`）,不校验它是否在刚构建出的列表里。
- `cli/tui/ink-components/App.js` `resolveModelPicker()` 里的 recent store require 路径原为 `'../../services/gateway/recentModelsStore'` —— 从 `cli/tui/ink-components/` 解析指向**不存在的** `cli/services/…`,`MODULE_NOT_FOUND` 被 `catch {}` 吞掉 → **TUI 从未记录最近模型**,而 `recent_models.json` 里的历史残留**永久有效**。
- 同一个 `resolveModelPicker()` 又被 F2（`App.js` ≈4478-4492）直接调用：F2 从 `recent_models.json` 读出 `(adapter, model)` 就**直接应用**,不校验存在性 → **这就是「TUI 莫名跳到不存在的模型」的主路径**。
- `cli/repl/startup.js:28-67` `offerModelSelection()` 也直连 `aiGateway.listModels()` 自建一份列表（不经任何真值闸）；`agentModelProjection` 投影进来的外部智能体模型同样只按「适配器是否启用」过滤。

### RC7 — ModelPicker 数字跳转索引错位（次要但真实）

`cli/tui/ink-components/ModelPicker.js`：行号标签用**全局下标** `i + 1`,而数字键选中用 `filtered[n - 1]`。列表一滚动（`start > 0`）标签就与实际选中的行脱节 —— 用户按「3」选中的不是屏幕上写着「3.」的那一行。这独立贡献了「莫名跳到（别的）模型」的主观体验。

### RC8 — 结论未收敛：至少 6 条入口各自拼列表

TUI `ModelPicker`、经典 CLI inquirer、`repl/startup.js`、`agentModelProjection` 投影、`apiAdapter.availableModels`、`arena`/`moa` —— 彼此不共享「已证实存在」的证据集。

---

## 三、规则

### 3.1 来源分级表（唯一分类）

| 来源标记 | 含义 | 分级 | 说明 |
| --- | --- | --- | --- |
| `remote` / `remote+local` | 上游 `/models`（或原生模型接口）亲口返回 | **权威（事实）** | 唯一可证实来源;命中即触发「上游权威覆盖律」 |
| `config` | 用户配置（`config.json` / `config.toml` 的 `model=`） | 可信 | 用户显式声明 |
| `user` | `modelCuration` 里用户手加的模型 | 可信 | 用户显式声明 |
| `proxy` / `commandcode-config` / `baseline` / `injected` | 用户自己的代理、工具配置、厂商基线 | 可信（保守） | 有据可依,欠拦安全 |
| `local` | **本机 IDE storage 正则扫描拾取** | **未经证实** | RC2 的主要产物 |
| `builtin` | **源码里硬编码的静态目录 / fallback** | **未经证实** | RC1 的主要产物 |
| `hint` | `RELAY_API_MODELS` 等 env 逗号串 | **未经证实** | RC3 的产物 |
| `static` / `preset` / `guess` / `fallback` | 同类猜测的其它写法 | **未经证实** | 保留位,防止换名绕过 |
| （无标记） | 适配器未打标 | 按可信处理 | 欠拦安全:宁可放过,不得误杀 |

> **新增静态目录时必须打 `builtin` 标记**,否则不受本律覆盖。

### 3.2 三条律（`modelListTruth.js` 的代码真源）

**律 1 —— 上游权威覆盖律（authority）**

> 某适配器产出 **≥1 条 `remote` 记录**时,该 remote 集合即为该适配器**唯一权威**：所有**未经证实**来源一律剔除,**除非**它是权威 id 的**结构性变体**（复合路由 `id::mode`,或记录的 `_baseModelId` 命中权威集）。
>
> 该适配器**没有**任何 `remote` 记录时（上游不可达 / 该通道本就没有列表接口）→ **一条都不剔除**。不知道就承认不知道：不臆造,也不滥杀。但这些条目会被打上 `unverified: true`,UI 必须显式标注。

**律 2 —— 形态律（shape）,恒定律,不看来源**

> ID 必须匹配 `^[A-Za-z0-9][A-Za-z0-9._:/-]{2,95}$`,且**原始串**不得含空白 / CJK / 引号 / 括号 / `\` / `@` / URL 形状。
>
> **判序不可颠倒**：先看原始串,再做规范化。因为本仓的规范化（`normalizeModelIdCompact`）会**剥掉内部空白**,若先规范化,`claude sonnet3.5` 会被洗成 `claudesonnet3.5` 从而蒙混过关 —— 这正是 RC2 的机理。

**律 3 —— 实测律（verify）,恒定律,不看来源**

> 探活（`modelCuration.getVerifyStatus()`,TTL 内）判定 `failed` 的模型剔除。**实测失败是对「存在」的反证。** `unknown` / `verified` 保留。

**逃生口**：若三条律把列表清成空,保留**默认模型（`isDefault`）或权威的一条**作为入口；该条若形态亦非法,则返回**空列表**（空是诚实的,不展示垃圾）。

### 3.3 选择入口对账律（防 S2）

> 任何**绕过列表构建**的应用路径（F2 最近模型、启动默认值、自然语言直选、env 残留）在写入偏好前,必须与**最近一次构建出的可选快照**对账。不在快照里 → **拒绝应用、不落盘、给出可执行提示**。
>
> 无快照（本次会话尚未构建过列表）→ 放行（不阻断正常路径）。
> `adapter === 'auto'` 或 `model` 为空（adapter 级默认模型入口）→ 放行。

实现：`gatewayModelChoices.js` 的 `getLastSelectableKeys()` / `isSelectableNow()`；消费点 `App.js` 的 `resolveModelPicker()`。

### 3.4 「最近模型」净化律（防 S2 的另一半）

> `recent_models.json` 记的是「用户曾选过什么」,**不是**「什么现在还存在」。每次构建出真实 catalog 后,必须以该 catalog 为准剪枝（`recentModelsStore.pruneRecentModels()`）,把已不存在的条目**忘掉**。
>
> 写入路径的 `require` 失败**不得**被静默 catch 掉而不留痕（RC6）—— 路径写错就是功能静默失效。

### 3.5 呈现律

> - 未经证实来源在 UI 上**必须带来源标签**,且 `unverified: true` 的条目必须显式标注（如 `[未证实·内置]` 黄色标签）。
> - 过滤动作必须**可见**：构建时的 notice 需按原因分类汇总（`无上游证据的猜测模型 / 形态非法 / 实测失败`），不得静默丢弃。

---

## 四、接线点（谁必须经过什么）

**咽喉点（唯一实现点）**：`services/backend/src/services/gateway/aiGatewayModelMethods.js` 的 `listModels(adapterKey, opts)` —— 先 `modelCuration.applyOverrides()`（用户意图），再 `modelListTruth.filterByUpstreamAuthority()`（存在性真值）。全仓消费方一次收口。

| 入口 | 文件 | 必须经过 |
| --- | --- | --- |
| **全部消费方** | `aiGateway.listModels(key)` | 律 1/2/3 |
| TUI `ModelPicker`（`/model`、`Meta+P`） | `cli/tui/ink-components/App.js` → `buildGatewayModelChoices` | 咽喉点 + 3.4 剪枝 + 3.5 标注 |
| 经典 CLI 选择器（无 TTY 自动选 / inquirer） | `cli/handlers/gatewayModelChoices.js` | 同上 |
| 自然语言切模型（「切换到 X 的模型」） | `App.js openModelPickerForVendor` / `handleModelSwitchByVendor` | 同上 |
| 自动模型选择（auto / 级联） | `cli/handlers/gateway.js` 的 auto 候选排序 | 律 1/2/3（自动路由不得落到猜测模型） |
| 启动默认模型 | `cli/repl/startup.js offerModelSelection` | 走 `aiGateway.listModels` → 已被咽喉点覆盖 |
| `khy ide <name>` 模型选择 | `cli/handlers/ide.js` | 显式套 curation + 真值（绕过咽喉点时必须补） |
| 外部智能体投影 | `services/gateway/agentModelProjection.js` | 投影结果并入列表后同样过律 1/2/3 |
| web 可用模型 / OpenAI 兼容端点 | `aiManagementServer.js`、`aiManagementOpenaiCompat.js` | 默认过滤（选择面只给真值） |
| **管理面（增删改 / 逐条探活）** | `aiManagementGatewayAdmin.js` | `{ unfiltered: true }` 显式看全量 —— 用户得先看得见才能隐藏/改名/验证 |
| 子 agent 选模型 | `tools/AgentTool/index.js` | 默认过滤（不得把猜测模型派给子 agent） |
| 目录多枢轴视图（超集） | `services/gateway/modelCatalogGraph.js` | 直连 `apiAdapter.listModels()`，登记在册的例外（它需要原始复合 id 分桶） |
| F2 最近模型轮换 | `App.js` chord 分支 | 3.3 对账 + 3.4 剪枝 |

> 关键 1：`aiGateway.listModels()` 是**唯一咽喉点**；任何绕开它直连适配器的入口都会把猜测条目当可调用模型展示，由 `check:model-list-truth` 守卫在提交时点名。
>
> 关键 2：`_filterModelsByReliability()`（TUI 与经典 CLI 共用）再跑一次真值律，是因为上面的 codex 跨提供商 / hint / builtin 过滤可能把最后一条 remote 剔掉，从而让「上游权威」消失 —— 重跑保证裁剪后的集合仍自洽。
>
> 关键 3：真值律**先于**「列表太短就跳过」的捷径执行 —— 单条垃圾模型不该因为列表只有一条就免检。

---

## 五、门控与回退

| 门控 | 默认 | 关闭后的行为 |
| --- | --- | --- |
| `KHY_MODEL_LIST_TRUTH` | 开 | `isEnabled()` 恒 `false` → `bypassed: true`、零剔除 → 逐字节回退今日行为 |

**已注册**：`services/backend/src/services/flagRegistry.js`。flagRegistry 不可用时退本地 CANON 解析（`{0,false,off,no}` 为关,空/未设 = 开）。

**fail-soft**：真值层缺失、抛异常、`modelCuration` 不可用 → 一律降级为「零剔除」,绝不因真值层故障清空用户的模型列表。

---

## 六、验收

```bash
# 单元（纯叶子三条律 + 门控 + fail-soft）
npx jest tests/services/gateway/modelListTruth.test.js --runInBand

# 接线（候选池 → 真值表；windsurf 场景：静态目录/扫描件不得进选择器）
npx jest tests/gatewayModelListTruth.wiring.test.js --runInBand

# 回归（既有 codex 跨提供商裁剪 + 非交互自动选）
npx jest tests/gatewayModelSelection.strictProbe.test.js --runInBand

# 工程守卫
node scripts/ci/check-leaf-contract.js services/backend/src/services/gateway/modelListTruth.js
node scripts/ci/check-flag-registry.js
npm run check:model-list-truth        # 绕开咽喉点的直连 / 未打标的静态目录
```

手工验证（有 windsurf token 的机器）：

```bash
khy gateway model          # 列表里不应再出现 claude-3.5-sonnet / kimi2.6 / 句子片段
khy gateway model --json   # 每条应能看到来源标签;unverified 项必须带标注
KHY_MODEL_LIST_TRUTH=off khy gateway model   # 应与改动前逐字节一致（回退验证）
```

---

## 七、收口状态与遗留

**已收口**

| # | 项 | 落点 |
| --- | --- | --- |
| 1 | 律 1/2/3 的单一真源 | `services/gateway/modelListTruth.js`（纯叶子）+ `KHY_MODEL_LIST_TRUTH` |
| 2 | 咽喉点 | `aiGateway.listModels(key, opts)`;管理面 `{ unfiltered: true }` |
| 3 | 选择器 / 自动路由 / F2 / 启动 / `khy ide` / 子 agent | 全部经咽喉点或显式补闸 |
| 4 | 静态目录打标 | `cursorAdapter.js`、`vscodeAdapter.js` 已打 `discoverySource: 'builtin'` |
| 5 | 扫描脏数据第一道闸 | `modelDiscovery.isLikelyModelId()`（形态律 + 裸家族词拒收）+ `acceptRawValue()`（先看原始串） |
| 6 | 选择入口对账 + 最近模型剪枝 | `isSelectableNow()` / `recentModelsStore.pruneRecentModels()` |
| 7 | 选择器数字跳转索引错位 | `ModelPicker.js` 行号与跳转统一按**窗口位置** |
| 8 | TUI recent 写入路径写错被静默吞掉 | `App.js` require 路径修正（`../../services/...` → `../../../services/...`） |
| 9 | 守卫 | `npm run check:model-list-truth`（已接入 `check:structure`） |

**遗留（已知未收口，按优先级）**

1. **写侧闸（RC3 余量）**：`khy gateway discover-models` 仍会把通过形态律的扫描结果 merge 进 `.env` 的 `RELAY_API_MODELS`。下一步：默认只落高置信来源（`config` / 用户显式指定），扫描候选需显式开关。
2. **web 管理页的 `verifyStatus` 投影**：管理面返回的是全量（`unfiltered`），应当额外带上每条的探活状态，让「未证实 / 已证实 / 实测失败」在同一个界面里可判。
3. **`extractFromText` 的宽正则**：`modelDiscovery.js:176-181` 对所有文件类型（含 JSON）仍跑一遍宽正则兜底；`_ideTokenMixin.extractModelIdsFromString` 同理。它们产出的 token 现在会被形态律 + 权威律拦下，但**扫描本身仍偏宽**，长期应收窄为「只在 model-ish 的键/值上抽」。
4. **`.env` 存量清理**：`RELAY_API_MODELS` 里可能已存有历史垃圾。建议提供 `khy gateway models prune --dry-run` 用律 1/2/3 体检并给出清理建议（不自动改写用户配置）。

---

## 八、与既有规范的关系

| 既有真源 | 关系 |
| --- | --- |
| `docs/10_规范/DESIGN-LAY/[DESIGN-LAY-005] 仓库层级板块规范.md` | 本文档落在 `docs/03_DESIGN_设计/`（L2 横切 `docs/` 层）,符合两轴命名 |
| `services/backend/src/constants/models.js` | 管模型**名**的单一真源;本文管模型**存在性**,不复制其数组 |
| `services/backend/src/services/gateway/modelCuration.js` | 管用户对展示列表的**增删改**意图(`model_overrides.json`);真值律在其**之前**执行,过滤结果再进 curation |
| `services/backend/src/services/gateway/modelExistenceEvidence.js` | 管 **错误显示层**的纠偏注解;本文管**列表构建层**的准入,两者互不替代 |
| `docs/10_规范/其它规范/[DESIGN-GOV-001] 治理总纲与可执行规则.md` | 本文属 MOD（模块）/ API 契约条款的补充,新增门控已按治理要求注册 |
