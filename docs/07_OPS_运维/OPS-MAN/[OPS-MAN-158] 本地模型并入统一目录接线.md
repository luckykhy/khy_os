# [OPS-MAN-158] 本地模型并入统一目录接线

## 背景 / 断桥

`services/backend/src/services/gateway/localOllamaProbe.js` 是一个 never-throw、非阻塞的
适配器:复用 `ollamaModelManager` 的 `isOllamaRunning()` / `listModels()`(单一真源 `OLLAMA_HOST`,
不重造 HTTP、不硬编端口),发现本地 Ollama 正在服务的模型,返回
`{ running, models:[{id, source:'local'}], error }`。Ollama 未运行 / 未安装 / 探测超时 → 返回
空列表(never-throw),绝不挂起检测流、绝不臆造模型。

它的文件头明写「for the per-user catalog」,但**此前零生产消费者**:统一目录
`modelCatalogGraph.buildCatalogGraph`(chat / image / video 三源的 authoritative 超集)从不
并入本地模型。本地模型能力完全休眠——典型的「能力存在,但没接线」。

## 改动(全 additive · 门关字节回退)

在 `buildCatalogGraph` 追加第 4 源(继 §1 chat / §2 image / §3 video 之后),把
`localOllamaProbe.fetchLocalModels()` 的结果作 `source:'local'` 边并入:

```js
if (live && _localModelCatalogEnabled()) {
  try {
    const { fetchLocalModels } = require('./localOllamaProbe');   // 惰性
    const probe = await fetchLocalModels();
    if (probe && probe.running && Array.isArray(probe.models)) {
      const seenLocal = new Set();
      for (const m of probe.models) {
        const model = m && m.id;
        if (!model || seenLocal.has(model)) continue;
        seenLocal.add(model);
        edges.push({
          provider: 'ollama', providerLabel: 'ollama (local)', model,
          keyIds: [], keyCount: 0,
          capability: modelCapability.classifyCapability(model),
          tier: modelTier.resolveTier(model),
          status: 'active', connectionMode: 'direct', isDefault: false,
          source: 'local',
        });
      }
      sources.localModels = seenLocal.size;
    }
  } catch { /* local probe optional; never breaks catalog assembly */ }
}
```

### 关键不变量

1. **仅 `live` 发现时探测**:本地模型只能靠探测「正在运行的服务器」得知——没有静态清单能说
   Ollama 装了什么。故本地探测属 live 发现路径(与 §1 的远程 live 模型 join 同一语义),
   **绝不**上默认静态快路径。快路径(`live:false`)因此逐字节回退,从不发网络。
2. **门控 `KHY_LOCAL_MODEL_CATALOG` default-on**:门关 → §4 整块短路(连惰性 require 都不触发)。
3. **三重回退**:门关 / 非 live / Ollama 未运行(`probe.running===false`)任一 → 无 `source:'local'`
   边、`sources.localModels===0` → 与接线前逐字节等价。探测 never-throw + 外层 try/catch 双保险,
   本地探测绝不破坏目录装配。
4. **状态透明**:`sources` 块新增 `localModels` 计数,与既有 `imageBackends`/`videoBackends` 对齐。
5. **纯度**:`modelTier` / `modelCapability`(纯函数)真算本地模型的 tier / capability,不臆造。

## 验证

```
node --check services/backend/src/services/gateway/modelCatalogGraph.js
node --test services/backend/tests/gateway/localOllamaProbeCatalogWiring.test.js   # 8/8
node node_modules/jest/bin/jest.js services/backend/tests/modelCatalogGraph.test.js  # 32/32 既有回归
```

覆盖矩阵(见 `localOllamaProbeCatalogWiring.test.js`,require.cache 桩使 hermetic 零网络):
- live + 门开 + running,2 模型 → 2 条 `source:'local'` 边,`sources.localModels===2`,
  provider/connectionMode/status/keyCount/capability 全断言。
- live + 门开 + `running:false` → 无本地边,探测被查但返空。
- **非 live** → 探测**从不被调用**(快路径字节回退)。
- **门关**(`KHY_LOCAL_MODEL_CATALOG=0`)→ 短路,探测从不被调用。
- 去重:重复 id → 去重。
- never-throw:探测抛错 → 目录照常返回,无本地边。
- 源级断言:`modelCatalogGraph` require `./localOllamaProbe`、以 `live && _localModelCatalogEnabled()`
  为门、emit `source: 'local'`、`sources` 报 `localModels`。
- 叶契约断言:`localOllamaProbe` 复用 `ollamaModelManager`(不重造 HTTP)、失败返 `running:false`(never-throw)。

## 相关

- 承 [OPS-MAN-155]/[OPS-MAN-156]/[OPS-MAN-157] 同为「能力存在但没接线」送别礼系列。
- 维护映射区:`local-model-catalog-graph`。所有 `modelCatalogPivots` 分组视图(by-model /
  by-provider / by-capability / by-tier / by-status / by-connection / flat)自动纳入本地模型。
