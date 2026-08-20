<!-- 文档分类: DESIGN-ARCH-069 | 阶段: 设计 | 原路径: 新建 -->
# [DESIGN-ARCH-069] 拓展契约与核心边界规范

> **强制规范 · 「什么是核、什么是拓展」的单一真源** · 回答四个问题：①khy 的**核**到哪儿为止；②一个拓展**长什么样**（目录、manifest、入口）；③它**装在哪、谁发现它、什么时候被加载**；④**删掉目录之后会怎样**。
>
> **定位**：本文管**拓展契约**。`[DESIGN-ARCH-068]` 管顶层目录的层级与依赖边，是本文的上位法；本文只把 L5 `extensions/` 这一层的内部规则写细，不复制也不覆盖它的层级表。运行时的常驻/按需边界真源是 `[DESIGN-ARCH-062]`，本文的惰性激活遵循它，不另立一套生命周期。
>
> **守卫**：`scripts/ci/check-repo-layout.js` 的 `extension-contract` 与 `extension-id-hardcode` 两条规则（`npm run check:layout`）——前者管拓展目录是否合契约，后者管**核**里有没有点名具体拓展。本文第三节的 manifest 字段清单在 `services/backend/src/services/extensions/extensionRoots.js` 内以常量落地；改本文须同步改该模块与守卫。
>
> **谁该读**：任何要新增一个功能板块、或要判断「这东西该进核还是该做成拓展」的人或 AI。

---

## 〇、为什么要有这一篇

khy 是复合项目，长期缺一条「核在哪儿结束」的线，后果是可以量化的：

**① 三套互不认识的拓展机制并存。** 同一个问题各有两三个答案：

| 机制 | manifest | 安装根 | 惰性 | 谁在用 |
| --- | --- | --- | --- | --- |
| `services/backend/src/plugin-loader/` | `package.json#khy` | `<dataHome>/plugins`、npm 全局、workspace | 否，启动即 `activate` | `replSession.js` 启动期 |
| `services/backend/src/services/extensions/extensionManager.js` | `openclaw.plugin.json` | `<appHome>/extensions` | 否 | `khy extension` 系列命令 |
| `services/backend/src/services/plugins/pluginContribResolver.js` | `openclaw.plugin.json` | `<appHome>/extensions` | **是** | 工具漏斗兜底 |

三者的路径常量是**复制**的，第三个的注释里明写「与 extensionManager 按构造保持同步」——即靠人记住，不靠机器。

**② 仓库自己的 `extensions/` 目录没有任何加载器扫描它。** 它在 `[DESIGN-ARCH-068]` 里被定义成「外部 IDE 桥接，不随主包分发」，而 `MANIFEST.in` 里却有 `recursive-include extensions *`——规范说不分发，打包说分发。

**③ 删掉目录 ≠ 拓展消失。** `extensions_state.json` 会留下条目，任何按 state 枚举的调用点继续报告一个幽灵拓展。

**④ 于是新功能只能往核里堆。** 加一条命令要改三处（`handlers/x.js` + `aliases.js` + `router.js` 的 switch），没有比这更便宜的路径，`services/backend` 因此不断变大而边界不断变模糊。

本文用**一套契约**替掉上面的三套，并给 `extensions/` 一个明确的、随包分发的定位。

---

## 一、核心边界

### 1.1 核是什么

**核 = 壳 + 漏斗 + 网关。** 三件，缺一不可，且**都不可作为拓展卸载**：

| 部件 | 落地位置 | 一句话职责 | 为什么必须在核里 |
| --- | --- | --- | --- |
| **壳** | `platform/`（L1）+ `services/backend/src/cli/` | 启动、REPL、命令注册表、路由 | 没有它，没有进程可以承载任何拓展 |
| **漏斗** | `services/backend/src/services/tool*`（工具调用单一出口） | 所有工具调用的唯一入口、权限与沙箱裁决 | 它是安全边界。拓展**穿过**漏斗，不得**绕过**漏斗 |
| **网关** | `services/backend/src/services/gateway/`、`services/ai-backend/` | 模型路由、密钥池、协议转换 | 拓展要用 AI，只能经由 `ctx.ai`，不得自持 provider 密钥 |

**判据（与 `[DESIGN-ARCH-068]` §1.1 的判据同构）**：问「删掉它，还能启动并跑通一次工具调用吗？」——不能 → 核；能 → 拓展。

### 1.2 六类拓展：机制与实现的切割线

用户的定位是「tool、plugin、scripts、mcp、software、协议都是拓展」。这六个词不是六种机制——
**机制只有一套**（本文全篇），六个词说的是**同一套机制的六类实现**：

| 类 | 现主要落点 | 做成拓展后的形态 |
| --- | --- | --- |
| tool | `services/backend/src/tools/*` | `capabilities: ["tools"]`，manifest 声明 + 入口导出 execute |
| plugin | `plugin-loader` 的五个发现源 | 已是拓展，只需换 canonical manifest |
| scripts | `scripts/*` | `kind: asset` 或 `runtime`，见 §1.6 裁定 |
| mcp | mcp 预设 / 生态注册表 | manifest `mcp` 字段，核代为拉起 |
| software | `software/*` | `kind: runtime`，通常一个域一个拓展 |
| 协议 | `gateway/protocolConverter/*` | `kind: runtime` + `provides` 服务名 |

**切割线**：一样东西属于「机制」还是「实现」，看它删掉之后**别的拓展还能不能被发现和激活**。
`extensionRoots` / `pluginContribResolver` / `contextFactory` 删掉，全部拓展一起消失 → 机制，留核。
`NotebookEdit` 删掉，只有它自己消失 → 实现，可迁。这与 §1.1 「删掉它还能跑通一次工具调用吗」
是同一条判据在不同粒度上的应用。

### 1.3 拓展**不能**做的事

拓展是加法，不是补丁。契约的价值全在这几条否定上：

- **不得绕过漏斗**：贡献的工具**不论走哪条注册路径**（§5.1 的两条都算），最终都落进同一个工具注册表，与内置工具走同一条 `executeTool` 路径、同一套权限裁决。注册路径有两条，**执行入口只有一个**——前者是实现细节，后者是安全边界。
- **不得自持模型密钥**：要 AI 走 `ctx.ai`，由网关统一路由计费。
- **不得写核的配置**：只能写自己的 `<pluginsHome>/<ns>/`。
- **不得要求核认识它**：核里**不允许**出现任何拓展 id 的硬编码分支。核要用一个拓展提供的能力时，按**服务名**去找（§3.4 的 `provides` + `extensionRoots.findProvider()`），不按 id 找目录。这一条已由 `extension-id-hardcode` 规则机器强制，基线 0——见第七节守卫。

---

### 1.4 粒度：按能力域打包，不按文件拆

一个拓展 = **一个能力域**，不是一个类、也不是一个目录下的全部东西。全仓约 190 个工具类若一对一
拆成 190 个拓展，每个都要一份 manifest、一次目录扫描、一条 state 记录，而「删掉桌面自动化」这种
真实意图仍然要删 3 个目录——粒度和意图对不上，管理成本反而比现在高。

**规则**：能力域 = 用户会**整块启用或整块删掉**的那个单位。目标约 15–25 个拓展，例如
`khy-desktop-automation`（DesktopControl + RPA + ComputerUse 三者合一）、`khy-disk-ops`、
`khy-protocol-anthropic`。一个域一个目录，删域即整块消失。

反向的判据同样成立：如果两样东西**从来不会被分开删**，它们就该在同一个拓展里；如果一个拓展里
有一半是用户想留、另一半想删的，那它切大了。

### 1.5 什么时候**不能**迁：入向耦合三档

判断一个东西能否迁出核，看的不是它自己有多独立，而是**核对它的入向引用**。三档，处置不同：

| 档 | 定义 | 处置 |
| --- | --- | --- |
| **硬入向** | 核 import 这个模块，或直接读它的内部状态 | **不能迁**，先断边再谈迁移 |
| **名字入向** | 核的策略表按**字符串**点名这个工具 | **可迁，但必须保留原名**（见 §5.1） |
| **零入向** | 核完全不认识它 | 自由迁移 |

硬入向的实例（本轮盘出，均**未**迁）：`_taskStore` 被 TUI、WS、压缩、worktree 四处直接读；
`cronScheduler` 被管理面、生命周期、自治三处 import；`diskCleanup` 被 `aiChatCore` 与
`directiveComposer` 调用。这三个看起来都像「独立功能」，但核已经长进去了。

名字入向是**可以带着迁**的，原因在于策略表的匹配是 fail-soft 的：表里点名一个不存在的工具，
它只是永远匹配不上，不报错、不崩。这条性质是「名字入向可迁」成立的全部依据——一旦某张表改成
「找不到就抛」，这条判据就失效了。

### 1.6 `scripts/` 的裁定

`scripts/` 不整体归一边，按**自指**切：

| 留核 | 拆走 |
| --- | --- |
| `scripts/{ci,lib,tests}` | `khy-portable`（`portable/` + `khytogo/`） |
| `scripts/{docs,release,maintenance}` | `khy-alpine-iso`（`alpine/`） |
| | `khy-installer`（`install/` + `setup/`） |
| | `khy-qoder-bridge`（`qoder-bridge/`） |
| | `khy-diagnostics`（`diagnostics/` + `bench/`） |

**`scripts/ci` 必须留核的理由是自指，不是重要性**：本契约的机器强制（`check-repo-layout.js`、
`check-pattern-coverage.js`）就住在那里。把契约的执法者做成受契约管辖的拓展，会得到一个
「删掉这个拓展就没人检查拓展合不合规」的循环——删目录即消失的语义在这里会反噬。同理
`scripts/lib` 是执法者的依赖，`scripts/tests` 是对执法者的验证。

`scripts/release` 与 `scripts/docs` 留核的理由不同：它们是**构建期**的，不参与运行时，
按 §6 的最后一条分支本来就不该是拓展。

### 1.7 现存功能的归类

以下是**目标态**。除已标注者外均为**待迁移**，不是既成事实——迁移按第七节的棘轮逐个进行。

| 目标拓展 id | 现位置 | 状态 |
| --- | --- | --- |
| `khy-markdown` | `extensions/tools/khy-markdown/`（原 `tools/khyos-markdown/`） | **✅ 已迁移**（第一个试点） |
| `khy-notebook` | `extensions/tools/khy-notebook/`（原 `…/src/tools/NotebookEditTool/`） | **✅ 已迁移**（第一个迁出核的**内置工具**） |
| `khy-trae-bridge` | `extensions/bridges/khy-trae-bridge/` | 已在位，`kind: ide-bridge` |
| `khy-quant` | `software/khyquant/` | 待迁移 |
| `khy-eyes` | `tools/deepseek-eyes/` | 待迁移 |
| 5 个 scripts 拓展 | `scripts/{portable,alpine,install,qoder-bridge,diagnostics,…}` | 待迁移，清单见 §1.6 |
| `khy-protocol-*` | `gateway/protocolConverter/*` | 待迁移 |
| `khy-mcp-presets` | mcp 预设 + 生态注册表 | 待迁移 |
| 约 15–25 个能力域拓展 | `services/backend/src/tools/*` | 待迁移，粒度见 §1.4 |
| `khy-web-admin` | `services/backend/src/{routes,models,controllers}` | 待迁移（体量最大，最后做） |
| `khy-ai-frontend` | `apps/ai-frontend/` | 待迁移 |

> `khy-quant` 的迁移**不改变** `[DESIGN-ARCH-068]` 对 `software/` 的定义：khyquant 现在就是「内置默认应用而非项目本身」，做成拓展是把这句话落到机器上，不是新的定位。

**`khy-notebook` 是本契约第一个可被引用的完整先例**：它证明了一个已经在核里、已经暴露给模型、
已经被约 20 处策略表点名的内置工具，可以在**行为逐字节不变**的前提下迁出去。迁移中实测出的两个
缺口（§5.1 命名、§5.2 广告）都已补上并有守卫。后续 tool 类迁移照它抄。

## 二、拓展根与优先级

一个拓展 = **一个目录**。目录是它的全部：id 是目录名，代码、manifest、资源都在里面，没有任何一个字节散落在别处。

### 2.1 五个根，按优先级降序

真源：`extensionRoots.listRoots()`。

| # | 根 | 用途 | 随包分发 |
| --- | --- | --- | --- |
| 1 | `KHY_EXTENSION_PATH`（path-list） | 开发/测试覆盖 | — |
| 2 | `<appRoot>/extensions/` | **仓库内置拓展** | **是** |
| 3 | `<appHome>/extensions/` | 用户安装的拓展 | 否 |
| 4 | `<appHome>/plugins/` | 遗留 plugin-loader 目录 | 否 |
| 5 | `<dataHome>/plugins/` | 遗留 plugin-loader 目录 | 否 |

同名（= 同目录名）拓展**先出现者胜**，后者被完全遮蔽。

**为什么仓库根优先于用户目录**（与多数插件系统相反）：内置拓展是平台承诺的一部分。若用户目录优先，一个同名目录就能静默顶替内置功能，且用户看不出发生了顶替。仓库优先意味着**要顶替就得改名**，于是冲突永远是可见的，而不是取决于扫描顺序。

**同一根内的扫描顺序按目录名排序**，不依赖文件系统返回序——冲突裁决因此确定可复现。

### 2.2 `extensions/` 层级定位的修订

`[DESIGN-ARCH-068]` §1 原将 L5 定义为「外部 IDE / 编辑器桥接，**不随主包分发**」。本文将其修订为：

> **L5 `extensions/`** = 内置拓展，随主包分发。每个子目录是一个自足拓展，遵循本规范的契约。IDE 桥接（`kind: ide-bridge`）是其中一类，不是全部。

这与既有的 `MANIFEST.in` 的 `recursive-include extensions *` 一致——修的是规范，不是打包行为。`[DESIGN-ARCH-068]` 的层级表已同步改写。 分类目录（§2.3）同样不改打包行为：`recursive-include` 本来就是递归的。

**禁止边不变**：「任何层 → L5/L6」仍然禁止。核**不 import 拓展**，只通过契约发现并激活它们；反向的 `拓展 → L2` 也不走深层相对路径，只走注入的 `ctx`。这条禁止边是拓展契约成立的前提，不是它的例外。

### 2.3 分类目录：`extensions/<分类>/<id>/`

按 §1.4 的粒度，`extensions/` 最终会有二十几个目录。二十几个兄弟目录平铺在一层，正是本篇要消灭的那个问题（「说不清哪个是什么」）换了个地方重现。因此**发现路径下探恰好一层**：

```
extensions/
├── tools/        工具能力域（tool）        khy-notebook / khy-markdown / khy-disk-ops …
├── protocols/    协议转换（协议）           khy-protocol-anthropic / khy-protocol-openai …
├── mcp/          MCP 预设与服务器（mcp）
├── scripts/      交付 / 运维脚本域（scripts） khy-portable / khy-installer …
├── software/     跑在平台之上的应用（software）khy-quant
└── bridges/      宿主 / IDE 插件桥（plugin）  khy-trae-bridge
```

六个分类名一一对应用户提出的六类（tool / plugin / scripts / mcp / software / 协议），不是另起一套词。

**分类目录的判据是「有没有 manifest」，不是一份分类名白名单。** 一个根下的直接子目录若自己没有可解析的 manifest、却含有带 manifest 的子目录，它就是分类目录：只负责归类，本身不是拓展。之所以不把分类名写进加载器：白名单要么写在加载器里（于是「文件系统就是注册表」变成「加载器里那张表才是注册表」），要么写进一个新的 `extensions/` 根 manifest（于是 `extensions/` 自己成了需要维护的注册表，「拖入目录」不再够用）。用「有无 manifest」判据两者都不需要——分类目录天然是空壳。

**收敛分类名是仓库卫生，由 CI 管，不由机制管。** `check-repo-layout` 的 `extension-contract` 规则强制上表六个名字，并报出「既不是拓展也不是分类目录」的目录。用户目录与 `KHY_EXTENSION_PATH` 下不受这条约束——那是别人的磁盘，不是本仓的卫生。

**三条必须成立的性质**，缺一条分类就从「布局」变成「语义」：

| 性质 | 为什么 |
| --- | --- |
| `id` 仍是**叶子**目录名，分类名不进 id | id 同时是 state 键、冲突键与孤儿检测键。分类名一旦渗进 id，把拓展移进分类目录就等于给它改身份——state 条目、冲突裁决与孤儿检测同时错位，比不分类糟得多 |
| 顶层直放仍然有效 | 否则「拖入目录即被发现」被收窄成「拖进正确的分类才被发现」，drop-in 承诺就打了折 |
| 自带 manifest 的目录**不再**下探 | 显式自我声明胜过按结构推断。否则一个拓展在自己目录里放了子拓展（vendor 场景）会被整块散开成分类 |

**为什么只下探一层**：`id` 必须唯一指代一个东西。允许任意深度后，「目录名」不再唯一，`a/khy-x` 与 `khy-x` 的关系就成了需要裁决的新问题。一层足够分类，两层开始需要规则。落地件是 `extensionRoots.MAX_DEPTH = 2`；孤儿检测（`findOrphanState`）与发现**必须同深度**——它只看一层的话，「把拓展移进分类目录」会让在位的拓展被列入残留名单，而残留名单是要被清理的。

删一层分类目录 = 删掉它整块内容，与逐个删拓展语义一致，`§4.1` 的承诺不变。

---

---

## 三、manifest：`khy.extension.json`

放在拓展目录根。**JSON，不是 JS**——manifest 必须能在不执行任何拓展代码的前提下读完，这是惰性激活的前提。

```jsonc
{
  "id": "khy-markdown",          // 必须等于目录名（不等则以目录名为准，守卫报错）
  "name": "Khy Markdown",        // 展示名
  "version": "1.0.0",
  "description": "零依赖跨平台 Markdown 编辑器",
  "kind": "runtime",             // runtime（默认）| ide-bridge | asset | toolchain
  "namespace": "md",             // 命令/工具的前缀，缺省取 id
  "engines": { "khy": ">=1.1.0" },
  "main": "khyos-md-bridge.js",  // 入口；kind=runtime 时必需且须在磁盘上存在
  "capabilities": ["commands", "tools", "mcp"],
  "provides": ["markdown-workbench"],  // 对核声明的服务名，见 3.4
  "commands": [{ "name": "open", "description": "打开编辑器" }],
  "tools":    [{ "name": "md_render", "description": "…", "inputSchema": {} }],
  "skills":   [],
  "mcp":      { "command": "node", "args": ["khyos-md-mcp.js"] },
  "permissions": { "network": false, "spawn": true, "database": false }
}
```

### 3.1 三种格式与迁移期

| 格式 | 地位 |
| --- | --- |
| `khy.extension.json` | **canonical**，新拓展只许用这个 |
| `openclaw.plugin.json` | 遗留，只读兼容；`manifestFormat` 字段会如实标出 |
| `package.json#khy` | 遗留，只读兼容；无 `khy` 字段的普通 npm 包**不**被当作拓展 |

同一目录里多种共存 → canonical 胜。遗留格式**不新增支持字段**：要用新字段，先迁到 canonical。

### 3.2 字段优先级（manifest 与入口导出冲突时）

- **JSON 可表达的**（标量、布尔、数组）→ **manifest 胜**。它是安装现场的声明意图，且能在不执行代码时读到。
- **运行时函数**（`execute`、`requiresSandboxEscape`、`validateInput`…）→ **入口导出胜**。JSON 装不下函数，manifest 里的同名项只可能是占位。

这条规则已在 `pluginContribResolver.js` 落地，本文只是把它升格为契约。

### 3.3 `id` 为什么必须是目录名

因为「删目录即消失」要成立，**键不能藏在文件内容里**。若 id 取自 manifest，删掉目录后 state 里的 id 就无从与磁盘核对，孤儿检测退化成猜测。以目录名为键，「这个 id 还在不在」永远是一次 `statSync`。

引入分类目录（§2.3）后这条要说得更准：id 是**叶子**目录名，分类名不进 id。写成 `"id": "tools/khy-x"` 看着更完整，实际把 state 键、冲突键与孤儿检测键一起改掉了——`extension-contract` 规则会报它。

### 3.4 `provides`：核按**服务名**找拓展

`capabilities` 说的是「我往注册表里贡献什么」（命令、工具、MCP），方向朝外；`provides` 说的是**核可以按什么名字找到我**，方向朝内。二者不可互相替代。

```jsonc
"provides": ["markdown-workbench"]
```

**为什么需要它。** §1.3 第四条禁止核里出现拓展 id 的硬编码分支，但核确实有「我需要一个 Markdown 工作台」这类真实需求——`khy md`、`khy docs browse`、WS 编辑器通道都要拿到那个目录。没有 `provides` 时，唯一的写法就是在核里写死 `khy-markdown`，于是第四条只能靠人守。有了它，核问的是 `findProvider('markdown-workbench')`：拓展可以改名、可以被第三方实现替换、可以装在任何一个根下，核一行都不用改。这正是第六节决策流程里「绝不为单个拓展在核里开分支」的可执行形式。

**裁决规则**（`extensionRoots.findProvider()`）：

| 规则 | 取值 | 理由 |
| --- | --- | --- |
| 多个提供者 | **根优先级高者胜**（§2.1 的根序） | 与目录同名冲突同一套裁决；不比版本号——版本裁决会让「装了什么」影响「用哪个」 |
| 入口探针 `probe` | 声明了服务但探针文件不在磁盘上 → 跳过，继续找下一个 | 否则一个同名空目录就能骗过解析 |
| 无提供者 | 返回 `null` | 调用方走既有的「没装这个拓展」路径，不新增分支 |

**服务名不是 id 的别名。** 它是一份能力契约：谁声明 `markdown-workbench`，就得提供 `main` 指向的那个入口所约定的形状。因此服务名要按**能力**取（`markdown-workbench`），不要按实现取（`muya-editor`）。

**核这一侧的落地形态**：每个服务在 `services/backend/src/services/extensions/` 下有且只有**一个**解析器模块，所有调用点都从它取目录，不各自实现一遍。形态有两种：带历史包袱的服务写**专用**解析器（如 `markdownWorkbench.js`，它还背着环境变量覆盖与迁移期 id 兜底两级）；没有包袱的直接用**通用**解析点 `providerModule.js`：

```js
const { requireFromProvider } = require('./extensions/providerModule');
const verifier = requireFromProvider('install-verifier', 'verify-install.js');  // 拓展缺席 → null
```

它存在的理由是一次实测：scripts 迁移后守卫立刻在核里揪出三处
`require('../../../../extensions/scripts/…')`。这种**加载期**相对 require 有两个问题，第二个是
致命的——写死了 id 与磁盘层数（下次移动就烂），以及删掉那个拓展目录会让整个核模块在加载期抛
`MODULE_NOT_FOUND`。**那不叫「删目录即消失」，那叫删目录即整机不可用**，正是 §4.1 要禁的。

**缺席时降级还是报错，由调用点按后果定，不由解析器统一定：**

| 调用点 | 缺席时 | 理由 |
| --- | --- | --- |
| `restoreAgentService` 的三面镜子 | **fail-soft**，跳过该面 | 少一面探测就是少一面，其余两面照常出结论。但摘要必须写「拓展未安装」而**不是**「探测失败」——「这台机器上没装这个能力」和「装了但坏了」是两个诊断，报同一句话会把人引向一个根本不存在的故障 |
| `portableAdapter` 的产物校验 | **fail-closed**，抛错 | `verifyArtifactManifest` / `runHealthCheck` 是更新落地前的校验闸。跳过它们等于装一个没验过的更新，比「更新失败」严重得多 |

报错文案里点**服务名**（`portable-artifact`）而不是拓展 id——既不触 §1.3 第四条，也更准确：
缺的是一个能力的提供者，不是某个具体实现。这一条是有代价的教训——本轮开工时，Markdown 工作台在核里有**三处互不认识的定位逻辑**，其中一处在试点迁目录后已经失效（`khy docs browse` 静默坏掉而无人发现，因为它 fail-soft）。一个服务一个解析器，是让「迁移一次、全部跟上」成立的前提。

**第三种形态：搬迁前先立 seam。** 上面两种都假定拓展已经在 `extensions/` 下了。`khy-quant`
（§1.7 的待迁移项）不是这个情形——它是全仓最重的一处 §1.5 **硬入向**：`services/backend/src`
里有 57 个纯 re-export 壳各自写死 `require('../../../../software/khyquant/<模块>')`，其中 19 个
路由壳被 `server.js` 在**启动期**直接 require。直接 `git mv` 会同时撞三面墙：57 处 require 路径
里带上 `khy-quant`，把 `extension-id-hardcode` 的 0 基线一次性染红；核 → L5 的边违反 §2.2；而删
目录仍然让 `server.js` 起不来，§4.1 的承诺照旧不成立。

结论是**搬迁前先断边**：先建解析器 `quantApp.js`，把 57 处「点名磁盘位置」收敛成一处「点名服务
`quant-app`」，再把壳改成从它取模块。断完之后搬目录是纯 `git mv` + 加 manifest，核一行都不用改。
它比 `markdownWorkbench.js` 多一级**迁移期兜底**——契约发现落空时回落到 L4 现址 `software/khyquant`，
让断边这一步成为纯重构（行为与迁移前一致），Phase 1 搬完即删掉这一支。兜底写的是 L4 目录名
`khyquant` 而不是拓展 id `khy-quant`，所以它自己不触 §1.3 第四条。

它与通用解析点 `providerModule.js` 有一处**刻意的不同**，值得单独记：后者把「拓展未安装」与
「装了但模块加载抛错」都吞成 `null`。对诊断/交付路径够用，对这里不够——一个路由模块里的真 bug
会因此从启动期大声崩退化成**静默 404**。所以 `quantApp.loadModule()` 只对「目录/文件不在」返回
`null`，文件在而 `require` 抛错时**照抛**。这正是上面那张表「『没装这个能力』和『装了但坏了』是
两个诊断」在加载层的对应写法。

### 3.5 `kind: "toolchain"`：核不 require、只按名字叫的脚本

交付、构建、诊断这类脚本迁进 `extensions/` 后，四种 kind 里没有一个装得下它们，于是本轮加了第四种。

它与 `runtime` 的区别是**执行位置**，不是重要性：核**不 require** 它的入口，而是照 manifest 的
`commands[].script` 起一个子进程。因此它拿不到 `ctx`，也不受惰性激活那一套约束——它只是一堆能被
按名字叫到的脚本。不塞进 `asset` 是因为 asset 是惰性的资源，没人「运行」它；这些是要运行的。

```jsonc
{
  "id": "khy-portable",
  "kind": "toolchain",
  "provides": ["portable-artifact"],
  "commands": [
    { "name": "build", "description": "构建便携版产物", "script": "build-portable-artifact.js" }
  ]
}
```

**入口字段是 `commands[].script`，不是 `main`。** 守卫（`check-repo-layout.js`）对 toolchain 走
单独一支：每条命令都必须有 `name`、必须声明 `script`、且该 `script` 必须在磁盘上存在。这一条要在
**提交时**核对而不是留给运行时——派发器只有在用户真的敲了那条命令时才会发现脚本不存在，而那通常
是发布当天。

**派发器 `scripts/lib/ext-run.js`。** `npm run portable:build:dev` 这类目标改成
`node scripts/lib/ext-run.js khy-portable build --kind portable-dev`。这层间接不是为了好看：没有它，删掉
`extensions/scripts/khy-portable/` 会让 `npm run portable:build:dev` 直接死于 node 的
`Cannot find module`；有了它，退化成一句
`[ext-run] 拓展 khy-portable 未安装 —— 命令 "build" 不可用。` 加非零退出。**这才是 §4.1 的
「删目录即消失」在交付脚本这条路径上的样子**——能力没了，仓库还是可用的。

派发器**自带一份两层目录扫描**，不复用 `extensionRoots`：`scripts/` 不许 import L2
（[DESIGN-ARCH-068] 第二节禁止边）。两份实现意味着两份会漂移的语义，所以
`scripts/tests/ext-run.test.js` 专门钉了「同深度、同分类规则、同缺失行为」，其中一例就是
「不下探第三层 —— 与 `extensionRoots.MAX_DEPTH` 同深度」。

---

---

## 四、生命周期

```
启动  ──►  ① 发现（只读 manifest，不 require 任何入口）
                │
                ├─ 目录不在 / manifest 坏 / 显式 disabled  ──►  这个拓展不存在，成本为零
                │
                ▼
           ② 索引贡献名（命令 → 命令注册表 plugin 优先级层；工具 → 漏斗兜底索引）
                │
           ②' 广告贡献名（工具 → 拼进给模型的工具清单，仅读 manifest）
                │
       首次真正调用某个贡献名
                ▼
           ③ 激活（require 入口 → activate(ctx) → 登记 disposables）
                │
           进程退出 / 显式禁用
                ▼
           ④ 停用（deactivate() → dispose 全部登记项）
```

**① 发现只读 manifest。** 一个从未被调用的拓展，其入口模块的模块体**永不执行**——零加载时间、零副作用。这是 `[DESIGN-ARCH-062]` 「按需」档的直接应用。

**②' 广告与索引必须同生共死。** 索引让工具「叫得动」，广告让模型「看得见」——只做前者，一个迁出核的工具就成了没人知道它存在的死代码。详见 §5.2；这是 `khy-notebook` 试点**实测**出来的缺口，不是推演。广告同样只读 manifest，绝不为了拿一行描述去 require 入口，否则惰性当场作废。

> **即时 vs 惰性的分界线**：`plugin-loader` 的五个发现源里，配置项、workspace 依赖、全局 npm、`KHY_PLUGINS` 这四个都是**被点名**的——点名本身就是加载意图，故在 `init()` 期激活。唯独**拓展根扫描**是对一棵用户可能只是拖进来一个文件夹的目录树的枚举，把它们在启动期激活，等于把每个内置拓展的模块体记到开机时间上，正是本节要禁止的事。所以拓展根来的候选只在 `init()` 里**占名**（状态 `discovered:lazy`，命名空间已占、manifest 已知、入口**未** require），首次使用时经 `activateNamespace(ns)` 激活。关掉 `KHY_PLUGIN_LAZY_LOAD` → 它们也回到即时激活，与其余四源同构。

**③ 激活是双门 fail-closed。** 中心门控（`KHY_PLUGIN_LAZY_LOAD`）与该拓展自身的 `enabled` 状态**都**要过；任一不过 → 当作未安装，走既有的「未知命令/未知工具」路径，不新增任何分支。激活有 5 秒超时，超时或抛错 → `disabled:timeout` / `disabled:error`，**不影响其他拓展和主流程**。

**④ 停用靠 disposables。** `ctx` 提供的每个注册动作都返回一个 dispose 句柄，停用时逐个调用。拓展不需要、也不允许自己去注册表里删东西。

### 4.1 「删除目录 → 拓展自动删除」

**文件系统就是注册表。** 三条推论，缺一不可：

1. 目录在 + manifest 可解析 → 该拓展**存在**。不需要任何 state 条目为它背书——这是 drop-in 的前提：拖进目录不必先登记。
2. 目录不在 → 该拓展**不存在**。state 里的残留条目**不得**让它复活。
3. 只有 `state[id].enabled === false` 这一种显式禁用，能压住一个在位的目录。

`extensions_state.json` 因此是**纯覆盖层**（只记「谁被显式禁用了」），不是注册表。指向已不存在目录的条目 = 残留，由 `extensionRoots.findOrphanState()` 识别、由 `extensionManager.pruneOrphanState()` 清除。清残留是**幂等**的（没残留则**不写盘**），且**不影响功能**——发现路径本来就看不见它们，清理只是让 state 文件不再积累谎言。

孤儿判定看**全部根**，不只看用户安装目录：一个内置拓展被显式禁用后，state 里那条记录对应的是**仓库根**里的目录；若只查用户目录，它会被判成孤儿删掉，等于默默把一个被禁用的拓展重新启用了。读（`extensionRoots`）与写（`extensionManager`）的分工也在此固定：只读探测器永不写盘，安装器是 state 的唯一写者。

---

## 五、贡献面

拓展能贡献什么，由 `ctx`（`plugin-loader/contextFactory.js`）划定。这是**能力的全集**——不在表里的一律做不到：

| 贡献点 | API | 命名空间化 | 备注 |
| --- | --- | --- | --- |
| 命令 | `ctx.commands.register` | `/<ns>.<name>` | 进命令注册表 `plugin: 60` 优先级层，永远盖不过内置命令 |
| 工具 | `ctx.tools.register` | `<ns>_<name>` | 经漏斗，与内置工具同一套权限裁决 |
| MCP 服务器 | manifest `mcp` 字段 | — | 由核代为拉起，拓展不自管进程 |
| 技能 | manifest `skills` | — | 走既有 skill 发现路径 |
| 数据源 | `ctx.dataSources` | — | |
| AI | `ctx.ai.generate` / `.stream` | — | **唯一**的模型访问通道 |
| 存储 | `ctx.storage`（KV） | 自动隔离 | 落在 `<pluginsHome>/<ns>/storage/` |
| 配置 | `ctx.config` | 自动隔离 | 落在 `<pluginsHome>/<ns>/config.json` |
| 日志 | `ctx.logger` | `[plugin:<ns>]` | |
| 网络 / 子进程 / 数据库 | `ctx.http` / `ctx.spawn` / `ctx.database` | — | 各需 manifest `permissions` 对应项 |

**命名空间化不是礼貌，是隔离**：两个拓展贡献同名命令时，因为都带各自前缀，**不会**互相覆盖；而拓展**永远**盖不过内置——`plugin: 60` 低于 `builtin: 100`，注册表拒绝降级覆盖。

### 5.1 两条注册路径，两套命名规则

上表只画了一条路径。实际有**两条**，它们写进的是同一个注册表，命名规则却不同——这一点此前没有
被写下来，`khy-notebook` 迁移时才撞出来：

| 路径 | 入口 | 工具名 | 谁在用 |
| --- | --- | --- | --- |
| **ctx 路径** | `contextFactory` 的 `ctx.tools.register(def)` | 强制改写为 `<ns>_<name>` | 拓展在 `activate(ctx)` 里主动注册 |
| **manifest 路径** | `pluginContribResolver.activateContributedTool()` | **按 `def.name` 原样** | manifest 声明 + 漏斗惰性激活 |

两套都合法，因为它们服务于不同意图：

- ctx 路径是**拓展自己想加一个新工具**。加前缀是对的：新工具没有历史包袱，前缀能防两个拓展撞名，
  也让用户一眼看出这工具来自哪个拓展。
- manifest 路径要能承载**从核里迁出来的既有工具**。这类工具的名字是已经对模型公开的 API，
  也已经被核内策略表按字符串点名（§1.5 的「名字入向」）。给它加前缀等于换了一个工具：
  模型不认识 `nb_NotebookEdit`，而 11 个内置 agent 的 denylist、`permissionPolicy` 的 matcher、
  `permissionStore` 的分类、`roleToolScope`、TUI 的 ProcessGroup 分类——约 20 处——全部落空。

**规则**：

1. **新增**的拓展工具走 ctx 路径，接受 `<ns>_<name>` 前缀。
2. **从核迁出**的工具走 manifest 路径，**必须保留原名**，且在 manifest 的 `_note` 里写明
   为什么不加前缀、原来在哪。
3. 保留原名的代价是**全局唯一**：两个拓展不能都叫 `NotebookEdit`。冲突由「先扫到者胜」裁决
   （§2.1），且后者被完全遮蔽——所以迁出的工具名必须当成全局标识符对待，不是局部名字。

> 与 §1.3 第一条不矛盾：两条路径都进同一个注册表、都经同一个 `executeTool`。分叉在**注册**，
> 不在**执行**。

### 5.2 执行兜底 ≠ 发现路径

`pluginContribResolver` 原本只有两个消费者方向的能力：`ownsTool(name)` 与
`activateContributedTool(name)`，且唯一的调用点在 `toolCalling.js` 的**执行**路径上——
也就是说，它只在模型**已经发出** `tool_use` 之后才会被问到。

而模型能不能发出这个 `tool_use`，取决于它有没有在工具清单里见过这个名字。那份清单由
`assembleToolPool()` 从**已加载**的工具生成，里面按定义永远没有惰性拓展。

两件事合起来的后果：**一个从核里迁出去的工具会「叫得动，但没人知道它存在」**。执行兜底是完好的，
迁移看起来是成功的，测试也是绿的——只是模型再也不会调用它了。这等于把工具从模型手里拿走。

**补法**（已落地）：`listDeclaredTools()` 从 manifest **纯 JSON 读**出全部声明的工具描述符，
由 `claudeAdapter.buildDirectToolDefs()` 在拼清单时合并进去。三条约束：

1. **绝不 require 任何入口**——manifest 之所以规定为 JSON 而不是 JS（§3），换来的正是
   「不执行拓展代码就能读到 name / description / inputSchema」这件事。为了广告去 require 入口，
   等于把 §4 的惰性整个作废。
2. **内置优先去重**：`pool` 里已有同名工具则跳过。与漏斗侧「内置永远赢」（`activateContributedTool`
   只在正常解析返回 `null` 之后才被触发）同向，不产生第二套优先级。
3. **整段 fail-soft**：拓展目录坏掉，宁可少广告一个工具，也不能让模型清单构建不出来。

**由此得出一条通则**：「删目录即消失」要成立，**发现、激活、广告三个面必须同时翻转**。任何一个
面留在旧状态，都会产生一种特定的假象——广告留着而目录没了 = 向模型撒谎；索引留着而广告没了 =
死代码。新增贡献面时，先问它属于这三面里的哪一面，再问它跟着目录一起消失了没有。

### 5.3 拓展如何拿到 `BaseTool`：它不拿

一个反复会被问到的问题：拓展导出的工具要不要继承 `BaseTool`？

**不要，也不能。** §2.2 的禁止边写着「拓展 → L2 不走深层相对路径」，而
`services/backend/src/tools/_baseTool` 正在 L2 深处。拓展**导出纯对象**
（`{ tools: [{ name, execute, prompt }] }`），由漏斗侧的 `activateContributedTool()` 调
`defineTool()` 把它包装成正式工具再注册。拓展一行核代码都不 import。

这不是风格选择，而是「删目录即消失」的必要条件：拓展一旦 import 了核的内部路径，它就和某个
特定版本的核绑死了，删得掉目录，删不掉这份耦合。

---

## 六、决策流程：这东西该做成什么

```
新功能来了
  │
  ├─ 删掉它，还能启动并跑通一次工具调用吗？
  │     └─ 不能 ──────────────────────────────► 核（services/backend，走既有三步注册）
  │
  ├─ 它要不要在核里留硬编码分支？
  │     └─ 要，且无法用 ctx 表达 ─────────────► 先补 ctx 能力，再做成拓展
  │                                              （绝不为单个拓展在核里开分支）
  │
  ├─ 它随主包分发吗？
  │     ├─ 是 ────────────────────────────────► extensions/<id>/（仓库内置拓展）
  │     └─ 否 ────────────────────────────────► 用户装到 <appHome>/extensions/<id>/
  │
  └─ 它根本不参与运行时（构建脚本、一次性工具）？
        └─ 是 ────────────────────────────────► tools/（L6，不是拓展）
```

**`tools/` 与 `extensions/` 的分界**：参与运行时 → 拓展；只在开发/构建期被开发者手动调用 → `tools/`。试点 `khyos-markdown` 正是踩线的例子——它被 `khy md` 命令在运行时拉起，所以它从来就不该在 `tools/`。

---

## 七、守卫与验证

```powershell
npm run check:layout                                      # extension-contract / extension-id-hardcode 都在内
npm run check:layout -- --list=extension-contract          # 打印全量清单
npm run check:layout -- --list=extension-id-hardcode       # 打印核里的 id 硬编码点
npm run check:layout -- --update-baseline                  # 修完一批后下调基线（绝不上调）
node --test scripts/tests/check-repo-layout.test.js
node --test services/backend/tests/extensions/contribToolLifecycle.test.js   # 契约第四节的机器化
```

`extension-contract`（warning + 基线，与 `[DESIGN-ARCH-068]` 第七节的四条 warning 规则同一套棘轮）检查 `extensions/` 下每个直接子目录：

| 检查 | 说明 |
| --- | --- |
| 有 canonical manifest | 缺 `khy.extension.json` → 计一处（遗留格式也计，从而形成迁移压力） |
| `id` 与目录名一致 | 不一致 → 计一处 |
| `kind` 合法 | 不在 `runtime` / `ide-bridge` / `asset` 内 → 计一处 |
| `main` 可解析 | `kind: runtime` 时 `main` 缺失或磁盘上不存在 → 计一处 |

**棘轮的作用**：基线是本轮完成后的实测值。此后每迁移一个功能进 `extensions/`，只要它带着合规 manifest，计数不涨；一旦有人塞进一个不合契约的目录，计数超基线**自动升为 error** 阻断合并。§1.7 表里那一长串「待迁移」因此不需要一次做完——契约先立，迁移在棘轮下逐个进行。

### 7.1 `extension-id-hardcode`：§1.3 第四条的机器强制

上一轮把「核里不允许出现拓展 id 的硬编码分支」写进了契约，但如实登记了它**没有机器强制**。本轮补上：

```powershell
npm run check:layout -- --list=extension-id-hardcode
```

规则扫 `services/backend/src` 下的全部 `.js`，找**分派用途**的拓展 id 字面量。基线 **0**——新增一处即超基线、即 error。

三条排除，每一条都是为了让规则只报真问题：

| 排除 | 理由 |
| --- | --- |
| 注释（行注释与跨行块注释） | 注释里提 id 是**说明**，不是分派。实现上必须整文件带状态地剥（`stripToCode`），逐行判断看不见跨行块注释的续行——这正是本轮规则第一版 6 个误报的全部来源 |
| 含中文的字符串 | 那是面向用户的提示文案。禁它只会逼出更含糊的报错信息，与规则的目的相反 |
| `kind: ide-bridge` 的拓展 id | 它们的路径由外部 IDE 决定，核改成服务名也影响不了那一侧 |

**唯一的白名单**是 `markdownWorkbench.js` 里的 `LEGACY_ID`——迁移期的兜底，服务名铺开后即删。白名单写在守卫脚本里而非文档里：要加一条，就得改守卫、就会进 diff、就会被评审看见。

**发现一个 id 硬编码时的正解**：不是加白名单，而是走 §3.4——给拓展的 manifest 加 `provides`，在 `services/extensions/` 下建（或复用）一个服务解析器，把调用点改成问服务名。

**本轮落地件**：

| 件 | 位置 | 作用 |
| --- | --- | --- |
| 根与 manifest 真源 | `services/backend/src/services/extensions/extensionRoots.js` | 五个根、三种格式、state 只读、孤儿识别；本轮新增 `provides` 归一与 `findProvider()` |
| 服务解析器（首例） | `…/services/extensions/markdownWorkbench.js` | `markdown-workbench` 的**唯一**定位与加载入口；四级解析：环境变量 → 服务名 → id 兜底 → 相对路径兜底 |
| 安装器 | `…/extensions/extensionManager.js` | 三个常量改从真源取；新增 `pruneOrphanState()` |
| 漏斗兜底 | `…/plugins/pluginContribResolver.js` | 改走真源，首次得以看见仓库 `extensions/` 根 |
| 启动期加载器 | `services/backend/src/plugin-loader/index.js` | 新增第 4 发现源（拓展根，惰性）与 `activateNamespace()` |
| 四个调用点归一 | `cli/handlers/md.js`、`cli/handlers/docs.js`、`services/aiManagementKhyosWs.js`、`services/mdEditorRegister.js` | 三套各自为政的定位逻辑（其一已失效）全部改从服务解析器取 |
| 守卫用例 | `scripts/tests/check-repo-layout.test.js` | 契约五项检查各一例 + 超基线升 error；本轮加 6 例覆盖 id 硬编码规则的三条排除与计数 |
| 贡献工具广告 | `…/plugins/pluginContribResolver.js` `listDeclaredTools()` + `gateway/adapters/claudeAdapter.js` | §5.2 的缺口补丁：让惰性拓展的工具进入模型清单，且不 require 入口 |
| 通用服务解析点 | `…/services/extensions/providerModule.js` | 按服务名惰性取拓展模块；本轮解掉核里 4 处指向 `extensions/` 的加载期硬 require |
| 交付脚本派发器 | `scripts/lib/ext-run.js` + `scripts/tests/ext-run.test.js` | 20 个 npm 目标改走它；31 例钉住「删目录即消失而不是即崩溃」|
| 路径漂移守卫 | `check-repo-layout.js` 的 `extension-path-drift` | 搬目录后断掉的相对 require 与算错的爬根算术，基线 0 |
| 服务解析器（硬入向） | `…/services/extensions/quantApp.js` + `tests/extensions/quantAppSeam.test.js` | `quant-app` 的唯一定位与加载入口；两级解析：服务名 → 迁移期 L4 兜底。为 `khy-quant` 断边而立，13 例钉住「未安装」与「装了但坏了」不同档 |
| 生命周期用例 | `services/backend/tests/extensions/contribToolLifecycle.test.js` | 13 例：拖入即发现 / 需要时才加载 / 删目录即消失 / 门控 fail-closed / 模型看得见 / `khy-notebook` 真实核验 |

### 7.2 `contribToolLifecycle`：把 §4 的三条承诺变成用例

用户对拓展机制的原话是三条：「删除目录拓展自动删除，拖入目录，启动并在需要时自动加载」。这三条
各自对应一组断言，而不是被笼统地测成「拓展能跑」。两条实现约束值得写下来，都是被实测逼出来的：

**每个用例起一个子进程。** resolver 有目录扫描缓存与 `require` 缓存，同一进程里先测「目录在」
再测「目录不在」，读到的是缓存行为而不是契约行为——用例会绿，但它证明不了任何事。子进程同时
让 `KHY_EXTENSION_PATH` 这类只在模块加载时读一次的环境变量能被逐例设置。

**`KHY_EXTENSION_PATH` 是前插，不是替换。** `listRoots()` 把它排在最高优先级，随后**照样**
push 仓库根、用户根与两个遗留 plugins 根。所以 fixture 进程永远还看得见真实的 `extensions/`，
以及别人机器上可能存在的 `~/.khyquant/extensions`。**断言必须收敛到 fixture 自己的工具名上**，
不能钉死整份清单——否则用例的成败取决于跑它的那台机器上装了什么。（本轮第一版就是这么红的。）

机制部分一律用临时目录当 fixture，只有最后一组「试点核验」打真实的 `khy-notebook`——那是实际
迁移的东西，它坏了就该红。

**这套用例做过变异测试**：把门控判断从 `listDeclaredTools()` 删掉、把 `claudeAdapter` 的广告
合并改成空数组、让 `listDeclaredTools()` 去 `require` 入口——三处各自被对应的那一条用例抓住。
绿的测试套件在被证明能为正确的原因变红之前，不算证据。

**兜底不得越过契约**：`markdownWorkbench.js` 的第 ④ 级相对路径兜底**仅在契约模块本身不可用时**才执行。无条件执行会绕过契约的全部判决——拓展被显式禁用、目录被删、仓库根被门控关闭，这三种情形下契约都已判「不可见」，而一条硬目录探测会把它捧回来，使 §4.1 第二条「目录不在 → 拓展不存在」失效。契约模块在位时，它的结论就是终局结论。任何后续服务解析器都须照此写。

### 7.3 `extension-path-drift`：搬目录搬坏了，机器来发现

拓展是**会被整体搬动**的目录。本轮把 `scripts/<子目录>/` 下的脚本迁到
`extensions/scripts/<id>/` 时，深度从 2 变成 3（`bench/` 那批变成 4），于是两类路径同时失准：

| 类 | 症状 | 危险度 |
| --- | --- | --- |
| 相对 `require` | 加载期抛 `MODULE_NOT_FOUND` | 低——它会自己叫 |
| `path.resolve(__dirname, '..', '..')` 爬根算术 | **不抛任何错**，静默算出一个错的根 | 高——到运行时才表现为「什么都没探测到」，而那看起来和「一切正常」很像 |

实测：迁移后 7 个文件的相对 require 断了，**21 个文件**的爬根算术错了。前者当场暴露，后者
一个都没暴露——`requireFromProvider` 明明解析成功，只是探到的东西是空的。

已有的 `unresolved-require` 够不着这两类：它只看 `../../` 起步的深层 require，于是单层
`../lib/x` 是它的盲区，`__dirname` 算术更完全不在它视野里。所以单列一条，只扫 `extensions/`：

```powershell
npm run check:layout -- --list=extension-path-drift
```

基线 **0**。判据分两支，分开是因为它们的正确性问题根本不同：

- **带具体路径段的**（`__dirname/../../services/backend/src`）→ 判**存不存在**（并试
  `.js/.cjs/.mjs/.json` 后缀，因为有些 join 是当 require 说明符用的）。这里**不能**复用
  `resolvesOnDisk`：那个函数答的是「node 能不能 require 它」，会因为一个真实存在的目录里没有
  `index.js` 就判它不存在。
- **纯 `..` 序列的**（拿祖先目录当基准）→ 判**落点**：必须落在**仓库根**或**本拓展内部**。
  中间的 `extensions/`、`extensions/<分类>/` 都真实存在，所以任何「路径存不存在」式的检查都
  看不见这类漂移——必须直接钉死落点。放行「本拓展内部」是被一个真实用例逼出来的：
  `khy-markdown/test/mcp-smoke.js` 用 `path.join(__dirname, '..')` 取自己的包目录，那是正当写法。

不以 `..` 开头的（`path.join(__dirname, 'traces')`）与所在深度无关，天然不会因搬家而漂，不在
规则视野内——否则运行时自建的输出目录会逼着人给规则加豁免名单。

**这条规则做过变异测试**：把单层 require 改回搬迁前的写法、把爬根少算一级、把爬根多算一级——
三处各自被抓住，且报出的诊断能区分「落在 extensions」与「爬出仓库」。规则第一版曾因误用
`resolvesOnDisk` 而「变异测试通过」，但那是**为错误的理由**通过的（它拿 require 语义去判一个普通
路径），一并记在这里：绿不等于对，得看它为什么绿。

---

---

## 关联

- 仓库层级与依赖边（上位法）：`[DESIGN-ARCH-068]` 仓库层级板块规范
- 常驻/一次性/按需 生命周期边界：`[DESIGN-ARCH-062]` khyos 后台常驻与按需加载生命周期边界
- 工具契约与漏斗：`[DESIGN-ARCH-015]` 编码规范、`npm run check:tool-contract`
- 项目定位（拓展的上游意图）：`[INIT-PRD-002]` 项目-定位
- 落地件：`services/backend/src/services/extensions/extensionRoots.js`（根与 manifest 单一真源）；完整清单见第七节
