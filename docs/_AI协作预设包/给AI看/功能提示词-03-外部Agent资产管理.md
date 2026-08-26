# 功能提示词 03 — 外部 Agent 资产管理层

> 用途:把这一整份内容贴给任何一个有仓库读写权限的 AI 助手,它就能独立把「再接一家外部
> agent 工具」这件事做完做对。本文件是**提示词**,不是设计文档——落地实现见
> `services/backend/src/services/agentAssets/`,契约测试见同层 `__tests__/agentAssets.*.test.js`。
>
> 放置说明:本文件原计划放在仓库根 `prompts/feature/`,但根目录是**封闭白名单**
> (`scripts/ci/check-repo-layout.js` 的 `layer-registry` 规则会硬失败),故收进
> 已注册的 `docs/_AI协作预设包/给AI看/`——AI 面向的协作预设本来就归这里。

---

## 一、这一层解决什么问题

用户在 A 工具里沉淀的**记忆 / 工具 / 技能**,换到 B 工具等于清零:每一家都用私有目录 +
私有格式存这三类资产,彼此不认。本层给出**厂商无关的中间表示(IR)**与**统一适配器契约**,
让 khy 能跨工具发现、读取、写入、同步这三类资产;khy 自己也只是同一契约上的一个适配器。

已接入的家数与落点(注册表 `agentAssets/registry.js`,每家**恰好一行**):

| id | 标签 | 适配器模块 |
| --- | --- | --- |
| `khy-os` | khy-os 本地资产库 | `khyOs` |
| `opencode` | opencode | `opencode` |
| `claude-code` | Claude Code | `claudeCode` |
| `harness` | 通用 agent harness | `harness` |
| `deepseek-harness` | DeepSeek Harness | `deepseekHarness` |
| `openclaw` | OpenClaw | `openclaw` |

---

## 二、目录与职责(改之前先认清边界)

```
services/backend/src/services/agentAssets/
  assetModel.js        纯叶子:IR 定义、校验、身份、内容哈希、凭据脱敏/还原、冲突判定
  registry.js          声明式注册表:表项只有 { id, label, module },零厂商知识
  _adapterBase.js      唯一的 IO 面:探测/遍历/读写/frontmatter 解析与序列化
  sync.js              编排层:发现、导入、冲突处理,完全不认识任何一家的形状
  adapters/<vendor>.js 每家一个文件,实现下面的八函数契约
```

**硬约束:注册表与编排层里不得出现任何厂商专属分支。**
验收判据就是这一条——「新增一家 = 一个适配器文件 + 表里一行」,由
`agentAssets.model.test.js` 的「注册表:零厂商专属逻辑」与
`agentAssets.adapters.test.js` 的「新增一家 = 一个适配器文件 + 表里一行」两组测试机器锁死。

---

## 三、适配器契约(八个函数,一个都不能少)

```js
detect(env)                            → { ok, root, via } | { ok:false, error, checked }
capabilities(env)                      → { id, label, detected, root, kinds:{memory,tool,skill}, rootEnvKeys }
listMemories(env) / listTools(env) / listSkills(env)
                                       → { ok:true, assets, root } | { ok:false, error, checked, unsupported }
readAsset(kind, id, env)               → { ok:true, asset } | { ok:false, error }
writeAsset(kind, asset, opts, env)     → { ok, dryRun, plan, written } | { ok:false, error }
removeAsset(kind, id, opts, env)       → { ok, dryRun, plan, removed } | { ok:false, error }
```

所有 IO 一律走 `_adapterBase`,适配器里**不要**自己 `require('fs')`。

---

## 四、不可协商的红线(每一条都有测试盯着)

1. **绝不读取、复制、打印、提交任何凭据**(API key / token / 密码 / session)。
   外部工具的配置文件里常混有凭据:出口一律过 `redactCredentials`,回写一律走
   `restoreRedacted` 用**目标侧现值**填回。占位符 `__KHY_REDACTED__` **永远不许落盘**。
   已知会踩的具体位置:OpenClaw 的 `openclaw.json` 顶层 `secrets` 段(整段不进遍历)、
   DeepSeek Harness 的 `.credentials.yaml` 与 `.env`(见该适配器导出的 `NEVER_READ`)。
2. **不修改外部工具自身的源码**,只读写它们的资产文件。
3. **绝不硬编码盘符、绝对路径、用户名**,所有路径由环境变量与用户主目录推算。
   探测顺序的固定写法:khy 自己的覆盖变量 `KHY_AGENT_ASSETS_<TOOL>_ROOT` 进 `envKeys`
   (**硬的**:设了但目录不存在就直接报错,绝不静默回退);外部工具自己的变量只做**候选**
   (指错了继续往下找)。
4. **缺失的能力显式声明为不支持,而不是抛异常,也不是返回空列表。**
   空列表会被上层读成「装了但一条都没有」,与「这家根本不存这类资产」是两回事。
   参照 `deepseekHarness.listMemories` 的写法:`{ ok:false, unsupported:true, error:<说明委托给谁>, checked }`。
5. **干跑优先**:所有写操作支持 `dryRun`,**默认为真**,调用方显式传 `false` 才真正落盘。
6. **同名不同内容默认保留双方**并生成冲突副本,同时在返回值里列出冲突清单,绝不静默覆盖。
7. **中间表示必须无损可逆**:无法无损表达的字段原样保留在 `raw` 里,不得静默丢弃。
   凭据是唯一一处**有意的、可审计的**有损。
8. **探测失败要说清「找了哪些位置」**,不得只说「未找到」。

---

## 五、接一家新工具的标准动作(照这个顺序做)

1. **先去 GitHub / 官方文档调研,不要猜磁盘布局。** 至少查清五件事:
   资产根怎么定位(有哪些环境变量)、三类资产各自的文件形态、
   配置文件的**方言**(是不是容忍 JSON5 / 是不是手写 YAML 带注释)、
   有没有**保留名**或内部目录、凭据落在哪几个文件里。
   在适配器头部的注释里写明「这是查证的,不是猜的」以及查的是哪一页。
2. **按查证结论声明能力,允许三类不一致。** 能力不对等不是缺陷,是事实:
   - DeepSeek Harness:`memory` 不支持(记忆整体委托给 MCP 服务器)、
     `tool` **可读不可写**(MCP 插件行在手写 YAML 里,dump 回写会丢注释、
     把 `!!js process.env.X` 压成字面量——那是有损写入)、`skill` 可读可写。
   - OpenClaw:三类全可读可写,但 `tool` 只碰 `openclaw.json` 的 `mcp.servers` 一个键。
3. **写适配器文件**,IO 全部走 `_adapterBase`,注意两条底座语义:
   - `walkFiles(root, {maxDepth:1})` 会同时给出 `<name>.md` 与 `<name>/SKILL.md`,
     但不会进第三层;发现规则跟着上游走(dsh 刻意只认单层,OpenClaw 允许深到 6 层)。
   - `parseFrontmatter` 只解析一层嵌套 map;两层嵌套会让 `parsed=false`,
     但 `raw` 仍逐字节保留 —— 回写务必用 `serializeFrontmatter(null, body, raw)` 走 raw 分支。
4. **注册表加一行**,形如 `Object.freeze({ id, label, module })`。**只加这一行。**
   如果你发现还得改 `sync.js` 或 `registry.js` 的逻辑,说明抽象漏了,回头改抽象而不是加分支。
5. **补契约测试**,假资产树建在系统临时目录里(`fs.mkdtempSync`),
   靠 `KHY_AGENT_ASSETS_*_ROOT` 覆盖变量指过去,**不依赖本机装没装那家工具**(CI 上一台都不会装)。
   每家至少覆盖:探测失败列出查过的目录、三类资产的读取、
   native → IR → native **逐字节**往返、凭据在出口被抹且回写时用目标侧现值填回、
   干跑默认不落盘、声明为不支持的能力返回 `unsupported` 而不是抛。
6. **跑验证**:

   ```powershell
   npm run test:one -- services/backend/src/services/__tests__/agentAssets.adapters.test.js
   npm run check:layout
   npm run quality:pr
   ```

   Jest 全量务必**从 PowerShell 跑**;Git Bash 下 `SHELL=bash.exe` 会造成大批假失败。

---

## 六、已经踩过的坑(别再踩一遍)

- **`__proto__` 是 OpenClaw 的保留服务器名。** `JSON.parse` 把它建成普通自有属性,
  但之后 `Object.assign` / 普通赋值走 `[[Set]]` 会命中 `Object.prototype` 的原型设置器:
  既污染原型,条目又悄悄丢了。读取侧要跳过它,**回写侧必须用 `Object.defineProperty` 把它带回去**
  ——它是用户文件里的内容,khy 无权静默抹掉。
  造这个 fixture 时也要注意:测试里必须写**字面 JSON 文本**,
  用对象字面量 `{ '__proto__': ... }` 根本造不出这个形态。
- **`!!js` 动态表达式会毒死整篇 YAML 解析。** cordis 允许在 `config` / `disabled` 里写 JS 表达式,
  js-yaml 的安全 schema 认不得这个标签会**整篇**失败——只有一行动态配置的用户整个工具列表就读不出来。
  解法是注册一个自定义标签把表达式原样保留成带前缀的字符串:既不执行,也不丢弃。
- **配置是 JSON5 形态(带注释 / 尾逗号)时,读写都要明确拒绝,而不是重写。**
  重写会把用户的注释抹掉;宁可不写,并在错误里说清为什么。
- **跨工具导入的记忆不要往用户手工策展的文件里塞。** OpenClaw 自己就用
  `memory/imports/<来源>/` 收别家的记忆,顺着上游的约定走,`MEMORY.md` 一个字节都不碰。
- **同工具原地写回不要替用户插 frontmatter。** OpenClaw 的记忆本就是裸 Markdown,
  写回时凭空多一段 frontmatter 既破坏往返等价,也是不可预期的副作用。
- **不引入新的第三方依赖。** `js-yaml` 能用是因为它**已经**是 `services/backend` 的直接依赖。

---

## 七、阅读结论优先于本文件

如果代码事实与本文件的描述冲突,**以代码为准**,并在你的最终报告里明确指出冲突点,
顺手把本文件改对。提示词写错了不修,下一个 AI 还会照着错的做一遍。
