# [OPS-MAN-100] 便携 CLI 子系统（claude/codex/opencode 开箱即用、可更新）

> 直接回应用户诉求：「我希望 npm 安装后，khy 可以把 claude、codex、opencode 做成
> 可更新的便携版，开箱即用。」现象（Windows 终端实测）：`khy claude` / `khy codex` /
> `khy opencode` 全部报「未检测到 xxx 命令」（`spawn codex ENOENT`），因为这三个 CLI 只被
> spawn 裸命令、完全依赖系统 PATH，用户机器上没全局装 → 恒 ENOENT。本条把它们做成装进
> khy 数据家 `~/.khy/tools/` 下、由 khy 自己解析路径 / 自己拉起 / 可 `khy tools update`
> 保持最新的便携版；且在 `khy claude` 启动前若未安装 → **交互确认**「是否现在安装便携版?[Y/n]」，
> 点头即装、装完复检直接继续本次启动。

## 一句话

claude（`@anthropic-ai/claude-code`）与 codex（`@openai/codex`）npm 包发布的是**带
node shebang 的 JS 入口**；npm 在 Windows 上生成 `.cmd`/`.ps1` shim，直接 spawn 裸名依赖
PATH → 便携安装不在 PATH → 恒 ENOENT。本子系统**绕开全部 shim/PATH 问题**：读**已安装包
`package.json` 的 `bin` 字段** → 定位真实 JS 入口 → 返回启动规格
`{ command: process.execPath, argsPrefix: [entryAbs] }`，即用当前 Node 直接跑入口脚本，
跨平台一致、不碰 PATH、不碰 `.cmd`。原生二进制入口（shebang 嗅探）回退为直接执行。
opencode 保留其既有专用解析器 `opencodeBinResolver`，泛化解析器对它返回 null（不打架）。

## 为什么需要它（真实缺口 = 只认 PATH 的裸 spawn）

- **确定性缺陷**：claudeAdapter/codexAdapter 的 spawn 分支只会 `spawn('claude'|'codex', ...)`
  （Windows 上 `cmd.exe /c claude.cmd`），完全依赖系统 PATH。用户没全局装 → ENOENT。
- **便携安装约定**：`npm install <pkg>@latest --prefix ~/.khy/tools/<pkg>-portable`，
  包自成 `node_modules` 隔离安装，不污染全局、不需管理员权限。
- **可更新**：`khy tools update <tool>` = 重跑同一 `@latest` 安装命令。

## 怎么做的（SSOT + 纯叶解析 + 变更安装器 + 交互桥 + god-file 外科接线）

**纯叶** `services/backend/src/services/gateway/adapters/portableCliRegistry.js`（SSOT）：
- 冻结 `_TOOLS`：claude/codex/opencode 各自 `{key,pkg,bin,portableDir,versionArgs}`。
- `_NATIVE_RESOLVER = new Set(['opencode'])`：交由专用解析器处理，泛化解析器跳过。
- `listTools/isKnownTool/getTool/hasNativeResolver`；HOW-TO-EXTEND 抄写式注释。

**纯叶** `portableCliResolver.js`（除 fs 只读探测外无副作用、绝不抛）：
- `resolveLaunchSpec(toolKey, {env,toolsRoot})`：门 `KHY_PORTABLE_CLI`（default-on）关 → null；
  opencode → null；`KHY_<TOOL>_BIN` 覆盖优先；便携命中 → 读 `package.json.bin` 定位入口 →
  `_isNodeEntry`（.js/.cjs/.mjs 或 node shebang）→ node 规格，否则直接执行。
- `resolveSpawn(toolKey, args, {fallback})`：命中 → `argsPrefix + 业务 args`；未命中 → 逐字节
  回退调用方给的裸命令 fallback。`isInstalled` / `packageDir` 供 detect / 诊断。

**变更叶（有网络+落盘）** `portableCliInstaller.js`：门 `KHY_PORTABLE_CLI_INSTALL`（default-on）；
`install(toolKey)` = `npm install <pkg>@latest --prefix <root>/<portableDir> --no-audit --no-fund`
（**参数数组**、杜绝命令注入；包名/前缀来自 SSOT + 受信数据家，不含用户自由文本；绝不写 key）；
win32 经 `cmd.exe /d /s /c npm ...`。`update` 是 `install` 的语义别名（`@latest`）。

**极薄接线叶** `portableAdapterSpawn.js`：`forTool(key)` → `{portableSpawn, portableInstalled}`
两个绑定 toolKey 且**绝不抛**的封装，使 codex/claude 两个逼近 2500 行上限的 god-file 的
spawn/detect 接线各仅数行（默认便携根 `~/.khy/tools`，用 `getDataHome()+'tools'` 而非
`getDataDir` 避免在热路径顺手建空目录）。

**交互桥** `cli/handlers/_portableAutoInstall.js`：门 `KHY_PORTABLE_CLI_AUTOINSTALL`（default-on）；
适配器不可用 + 便携工具 + 交互环境（有 rl + TTY）→ 问「[Y/n]」→ 点头装 → 强制 `detect(true)`
复检 available。非交互/门关/非便携工具 → 不提示（走原报错路径）。

**god-file 外科接线**（additive、逐字节回退）：
- codexAdapter/claudeAdapter：module 顶 `const {portableSpawn,portableInstalled} =
  require('./portableAdapterSpawn').forTool('codex'|'claude');`；spawn else 分支先算裸命令
  fallback、再 `const _sp = portableSpawn(args, fbCmd, fbArgs); spawn(_sp.command, _sp.args, ...)`；
  detect 尾 `if (!_available && portableInstalled()) _available = true;`；getStatus 不可用
  detail 追加「可运行 khy tools install <tool> 安装便携版」。
- ide.js 可用性门（:60）：不可用时先经 `_portableAutoInstall`，装成功即复检继续。
- opencodeBinResolver：`_candidateBases` 增补数据家 `getDataHome()`（`_PORTABLE_TAIL[0]==='tools'`
  故根是数据家本身）候选，让 `khy tools install opencode` 落到 `~/.khy/tools/` 也能被解析。

**管理命令** `cli/handlers/tools.js` + `router.js` `case 'tools'` + `commandSchema.js` 登记：
`khy tools list|install <tool>|update <tool>|path <tool>`。

## 诚实边界

- 门全 default-on、CANON falsy `['0','false','off','no']` 关闭 → 逐字节回退到原裸命令行为。
- 安装器绝不把任何 key/token 写盘或入参；仅执行固定 `npm install`（参数数组防注入）。
- 交互桥仅在 TTY + 有 rl 时提示；非交互环境不替用户拍板下载。
- opencode 走既有专用解析器，本子系统只为它补一个数据家候选，不接管其解析。
- 便携根默认 `~/.khy/tools`（`KHY_TOOLS_DIR` 覆盖），只读路径（list/path）不建空目录。

## 验证

```
npm run test:portable-cli                   # 纯逻辑 25/25(门开命中/门关回退/恶意 env 不抛/win32·posix)
node --check services/backend/src/services/gateway/adapters/portableCliRegistry.js
node --check services/backend/src/services/gateway/adapters/portableCliResolver.js
node --check services/backend/src/services/gateway/adapters/portableCliInstaller.js
node --check services/backend/src/services/gateway/adapters/portableAdapterSpawn.js
node --check services/backend/src/cli/handlers/tools.js
node --check services/backend/src/cli/handlers/_portableAutoInstall.js
npm run arch:god                            # codex/claude 接线后无新增超限(codex 2492, claude 2448)
```
