# [DESIGN-ARCH-116] khyos 插件系统契约（@khy/plugin-sdk）

> **定位**：本文件是 khyos **自有插件系统**契约的单一真源——把散在
> `services/backend/src/plugin-loader/index.js` 的内置回退校验器提出来，独立成可发布、
> 可被第三方插件依赖的 `@khy/plugin-sdk` 包。它与 `[DESIGN-TOOL-002] 拓展契约与核心边界规范`
> 分工：069 管「拓展（extensions）的目录/manifest/发现/惰性激活边界」，本文件管
> 「KhyPlugin 插件的 manifest 必填契约与发现源 6 路边界」。
>
> 对应书《Claude Code实战：Harness工程之道》1.3.3「Plugins 是分发形式而非新能力」：
> 能力（skill / 命令 / 钩子 / 子智能体）khyos 已有，缺的是标准化**分发/校验层**。

## 1. 背景：为什么补这个包

khyos 的「插件」实际有三套并存机制，各管一层：

| 机制 | 位置 | 管什么 | 状态 |
|------|------|--------|------|
| ① 用户命令插件 | `services/backend/src/cli/plugins.js` → `~/.khyquant/commands/*.js` | 自定义 CLI 命令 | 已实现 |
| ② KhyPlugin 加载器 | `services/backend/src/plugin-loader/index.js` → 发现 6 源 + manifest + 命名空间 + 版本门控 + 激活 | 可注册命令/工具/钩子的「真」插件 | 已实现大半 |
| ③ CC 桥 | `services/backend/src/skills/ccSkillBridge.js` | 发现 CC 磁盘上的 SKILL.md（不装不跑） | 已实现，默认开 |

②的 manifest 校验**散在 loader 内置回退校验器里**，且 `@khy/plugin-sdk` 包并不存在
（`platform/packages/` 里此前只有 shared/ui-shared）。后果：

- 校验逻辑没有独立真源，第三方插件作者无法依赖一个稳定契约；
- 发现源 6 路（config / workspace / global / ext:builtin / dir / env）仅以注释描述，
  无 schema 常量，「哪条源是惰性、哪条是即时」无法被测试钉死。

补 `@khy/plugin-sdk` 即把**契约真源**独立出来，让 ② 与 ③ 各就各位：
CC 侧继续「发现/安装」，khyos 侧「运行/校验」。

## 2. 落地件

| 项 | 路径 | 说明 |
|----|------|------|
| 包 | `platform/packages/plugin-sdk/`（`@khy/plugin-sdk`，G2 v1.6.5） | 与 `@khy/shared` 同版本轨道 |
| 入口 | `platform/packages/plugin-sdk/index.js` | 零依赖、require 时零副作用 |
| 测试 | `services/backend/tests/plugin-sdk.test.js`（26 条全绿） | 标准本体 |
| wire | `services/backend/src/plugin-loader/index.js` | `require('@khy/plugin-sdk')` 成功即用，缺包回退内置校验器（逐字节一致） |
| 版本轨道 | `scripts/ci/check-version-sync.js` G2 组 9 源→10 源 | 加 `platform/packages/plugin-sdk/package.json` |
| workspace | `pnpm-workspace.yaml` | packages + `khy-os-backend>@khy/plugin-sdk: workspace:*` override |

## 3. SDK 导出（契约真源）

`@khy/plugin-sdk` 导出 6 个成员：

| 导出 | 类型 | 作用 |
|------|------|------|
| `validateManifest(m)` | 函数 | manifest 校验真源：4 必填字段，返回 `{ valid, errors }` |
| `MANIFEST_FIELDS` | 常量数组 | 4 必填字段（`name`/`namespace`/`engines.khy`/`main`）+ 各自 error 文案 |
| `SOURCES` | 常量数组 | 发现源 6 路 schema：`{ source, eager, notes }` |
| `SOURCE_ORDER` | 常量数组 | 6 路优先级序（高→低） |
| `PERMISSIONS` | 常量数组 | 权限键（`network`/`fs`/`shell`/`http`） |
| `defineKhyPlugin(def)` | 工厂 | 补 no-op 生命周期，作者只实现自己用到的钩子 |

### 3.1 manifest 4 必填字段

| 字段 | 类型 | 缺了报 |
|------|------|--------|
| `name` | string | `missing required field: name` |
| `namespace` | string | `missing required field: namespace` |
| `engines.khy` | string | `missing required field: engines.khy` |
| `main` | string | `missing required field: main` |

非对象输入报 `manifest must be an object`。多给合法字段不影响 `valid`。

### 3.2 发现源 6 路（eager/lazy 边界）

| # | source | eager | 说明 |
|---|--------|-------|------|
| 1 | `config` | ✅ | `~/.khyquant/config.json` 的 `plugins` 列表——显式 path |
| 2 | `workspace` | ✅ | `node_modules/khy-*` 与 `@scope/khy-*` |
| 3 | `global` | ✅ | npm 全局 `khy-*` |
| 4 | `ext:builtin` | ❌ **惰性** | extensionRoots 目录扫描（`KHY_PLUGIN_LAZY_LOAD` 门控） |
| 5 | `dir` | ✅ | `~/.khyquant/plugins/<name>/` 目录扫描 |
| 6 | `env` | ✅ | `KHY_PLUGINS=名1,名2` require.resolve |

**只有第 4 路（目录扫描）是惰性的**——这是 `[DESIGN-TOOL-002] §4` 的边界：
目录扫描源用户可能随手丢个文件夹进来，启动期激活会把每个内置拓展的模块体
都计入 boot 时间，正是要禁的。其余 5 路是**显式命名**（config 条目 / 依赖 / env
变量），被点名即加载意图，启动期即时激活。测试 `plugin-sdk.test.js` 把这条钉死：
`SOURCES.filter(s => !s.eager)` 必须恰好等于 `['ext:builtin']`。

## 4. wire 语义（fail-soft 不变）

`plugin-loader/index.js` 的加载逻辑（行 52 起）保持原有结构：

```js
try {
  ({ validateManifest } = require('@khy/plugin-sdk'));
} catch {
  // 缺包 → 内置回退校验器，与 SDK 逐字节一致
}
```

- `@khy/plugin-sdk` 声明为 **optional peerDependency**（`peerDependenciesMeta.optional: true`），
  干净安装可缺，走回退；
- 回退校验器与 SDK 的 `validateManifest` **逐字节一致**（同 4 字段、同 error 文案、
  同 `{ valid, errors }` 形状），由 `tests/plugin-sdk.test.js` 的
  「loader fallback byte-compatibility」一组断言钉死；
- `KHY_PLUGIN_DEBUG=1` 才打印回退提示，默认静默。

## 5. 与 CC 生态的关系

`ccSkillBridge.js`（默认开，`KHY_CC_SKILL_BRIDGE`）继续存在，负责**发现**
CC 装到磁盘的 SKILL.md（`~/.claude/skills` / `~/.claude/plugins/cache` /
`~/.claude/local-plugins`）。它**不安装、不联网、不执行**。

khyos 因此同时具备：

- **借 CC 生态**：ccSkillBridge 读 CC 磁盘，CC 负责发现与安装；
- **自有插件系统**：`plugin-loader` + `@khy/plugin-sdk`，khyos 负责运行、命名空间、
  版本门控、校验。

二者并行、互不替代。本契约只钉死自有侧的标准，不触碰 CC 桥。

## 6. 校验

- `node services/backend/node_modules/jest/bin/jest.js tests/plugin-sdk.test.js` — 26 条全绿
- `node scripts/ci/check-version-sync.js` — G2 10 源全绿（EXIT=0）
- `node scripts/ci/check-agent-rules.js --changed` — EXIT=0
- 8 个 plugin 相关套件（plugin-sdk / plugin-system / pluginContribResolver /
  pluginInvoker / pluginToolBridge / cli-plugins / pluginChain / pluginDoctorPort）全绿

> 本文件为 `.md`，按仓库 FILE-FORMAT-PROTOCOL 同步生成 `.html`（`npm run docs:build`）。

## 6. Hooks 配置层契约（.khy/hooks.json）—— 姊妹篇

> 第 3 节钉死**插件** manifest 契约；第 6 节钉死 **Hooks** 配置契约。
> 二者共用同一套「单一真源 + 测试先行」手法。

Hooks 配置真源是 `services/backend/src/services/domain/extensions/hooks/hookConfigSchema.js`
的 `validateHooksConfig(raw)` / `normalizeHook(h)` 两个纯函数（零 IO、返回
`{ valid, errors, warnings }`，与 `@khy/plugin-sdk` 的 `validateManifest` 同形状）。

### 6.1 接受的顶层形状

与 `hookRegistry.load()` 现有解析一致，两种：

| 形状 | 例 |
|------|-----|
| 对象包 | `{ version: 1, hooks: [ ... ], disabled: [ "id" ] }` |
| 裸数组（legacy） | `[{ event, command, ... }]` |

### 6.2 字段契约

| 字段 | 类型 | 必填 | 说明 |
|------|------|------|------|
| `version` | number | 推荐 | 缺则 warning 级（兼容旧配置，不阻断加载） |
| `hooks` | array | ✅ | 每个元素是一个 hook |
| `disabled` | string[] | 否 | 被禁用的 hook `source` 标识 |
| `hooks[].event` | HOOK_EVENTS 之一 | ✅ | 11 事件见 `hookRegistry.HOOK_EVENTS` |
| `hooks[].command` | string | ✅（command 型） | JSON 配置只收 command 型；`handler` 是运行时函数，不可序列化 |
| `hooks[].pattern` | string | 否 | 必须可编译为 `RegExp`；过滤 `context.toolName`/`context.prompt` |
| `hooks[].timeout` | number > 0 | 否 | 默认 10000 |
| `hooks[].priority` | int ≥ 0 | 否 | 默认 100，小者优先 |
| `hooks[].enabled` | boolean | 否 | 默认 `true` |
| `hooks[].source` | string | 否 | hook 自身标识（`disabled` 列表与 `khy plugin status` 以此为准） |

### 6.3 阻断 / 审计语义（command hook 退出码）

`hookRunner._runCommandHook` 的退出码契约（已测试钉死）：

| 退出码 | 语义 |
|--------|------|
| `0`（无 stdout） | `allow`——放行 |
| `0` + stdout JSON | `modify`——JSON 按**每事件白名单** `filterCommandOutput` 过滤后才入上下文（如 `PreToolUse` 只许合并 `params`，`iteration` 等控制字段一律丢弃） |
| `2` | `block`——拦截，`reason` 取 stderr |

跨平台注：Linux `sh -c` 与 Windows `cmd /c node <file>` 都会透传**直接跑 node
文件**的退出码；只有 `cmd /c node -e "..."` 这种嵌套引号写法在 Windows 下会
被 cmd 吞掉退出码——故 Hooks 配置里的 `command` 应指向**脚本文件**而非内联
`-e`，Windows 上 block 才可靠。

### 6.4 最小可运行样例

`.khy/hooks.json`（用户级，gitignored 目录，不进发布物）已落两条
`PreToolUse` 拦截，覆盖 1.4 决策树的「敏感信息拦截 → 确定性 Hooks」场景：

```json
{
  "version": 1,
  "hooks": [
    { "event": "PreToolUse", "command": "node \"scripts/security/guardDangerousCommand.js\"",
      "timeout": 5000, "priority": 10, "source": "khy:DangerousCommandGuard" },
    { "event": "PreToolUse", "command": "node \"scripts/security/detectFileLeak.js\"",
      "timeout": 5000, "priority": 20, "source": "khy:SecretLeakGuard" }
  ],
  "disabled": []
}
```

- `khy:DangerousCommandGuard`：拦危险 shell（`rm -rf /` 等），命中即 `exit 2`
- `khy:SecretLeakGuard`：拦秘密落盘（`sk-*`/`AKIA*`/`ghp_*`/私钥 PEM 等高特征正则），
  命中即 `exit 2`，只报标签不回显密钥值

两条 `command` 均指向 **脚本文件**而非内联 `node -e`——这是 6.3 节所述 Windows
嵌套引号吞退出码缺口的规避。脚本读 stdin 的 PreToolUse context（`{ toolName,
params }`），自身崩溃时 fail-open（`exit 0`），绝不因守卫自身故障而误阻断。

接线点：`auditTrajectory/wire.js` 在审计通道 attach 时主动 `hookSystem.init(cwd)`，
触发 `registry.load(cwd)` → 读 `<cwd>/.khy/hooks.json` 与 `<appHome>/hooks.json`。
合 schema 的 hook 入表，未知 `event` 被 `_register` 跳过并 warn。

> 注：真实 PreToolUse context 形状是 `{ toolName, params }`（见
> `services/backend/src/services/toolCalling.js:1995`），**没有** `args` 字段。
> 早期草稿读 `r.args[0]` 形同虚设，已按 `params` 修正。

### 6.5 校验

- `node services/backend/node_modules/jest/bin/jest.js tests/hooksConfig.test.js` — 17 条全绿
- 6 个 hooks 相关套件（hooksConfig / hook-lifecycle / hookContribSeams /
  hookApprovableMetadata / hookFaultIsolation / hookTelemetry）全绿（63 条）
- `node scripts/ci/check-agent-rules.js --changed` — EXIT=0
