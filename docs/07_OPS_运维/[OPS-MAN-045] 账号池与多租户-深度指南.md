<!-- 文档分类: OPS-MAN-045 | 阶段: 运维 | 原路径: docs/07_OPS_运维/[OPS-MAN-045] 账号池与多租户-深度指南.md -->
# 账号池与多租户 — 深度指南（`khy pool`）

> 本文讲清楚两件事：①如何把多个「订阅型登录账号」（Kiro / Cursor / Trae / Windsurf / Warp 等）汇成一个**账号池**，让 KHY 在它们之间自动调度；②如何用同一套池子对外**铸造按客户隔离的访问令牌**，把 KHY 网关当成**多租户**服务分享给他人。
>
> 适用对象：想把多个 IDE/CLI 订阅额度集中复用、或想把网关分享给团队/客户的用户。命令入口统一为 `khy pool …`。

---

## 一、两类「池」先分清

KHY 网关的来源账号分两大类，账号池命令 `khy pool` 管理的是**第一类**：

| 类别 | 例子 | 怎么进池 | 本文是否覆盖 |
| --- | --- | --- | --- |
| **登录态账号池** | Kiro、Cursor、Trae、Windsurf、Warp | `khy pool import <provider>` 复用其本地登录态 | ✅ 本文主题 |
| API-key 账号 | DeepSeek、Qwen、GLM、OpenAI、Agnes 等 | `khy gateway config` 填 API Key | 见 [OPS-MAN-032] 网关自定义 provider 配置 |

> 同一个命令 `khy pool` 也能 `add <provider> [token]` 手动塞一个登录 token 进池（`source: manual`），但绝大多数人用 `import` 即可。

---

## 二、`khy pool` 全命令速查

> 提示：`pool` 是子命令，完整形式是 `khy pool <子命令>`。无子命令时默认显示 `pool status`。

| 命令 | 作用 |
| --- | --- |
| `khy pool list [provider]` | 列出池内账号（ID / 提供商 / 标签 / 状态 / token 预览 / 来源）；带 `provider` 只看某家 |
| `khy pool import <provider> [path]` | 从某提供商的本地登录态导入账号；不带 `path` 走交互选择 |
| `khy pool add <provider> [token]` | 手动新增一个登录 token（不带 token 会提示输入，并可顺手设为当前账号） |
| `khy pool use <provider> <id\|label\|email>` | 切换某提供商的**当前活跃账号**，并强制重连网关适配器 |
| `khy pool delete <id\|label\|email>` | 删除一个账号（`remove` 等价） |
| `khy pool enable <id\|label\|email>` | 启用一个被禁用的账号 |
| `khy pool disable <id\|label\|email>` | 禁用一个账号（不删除，临时停用） |
| `khy pool status` | 账号池概览：总数、调度模式、熔断器、各提供商当前活跃账号 |
| `khy pool scheduling [mode]` | 查看 / 设置调度模式（不带 `mode` 只查看） |
| `khy pool api [clientLabel]` | **多租户**：为一个客户铸造独立访问令牌（见第五节） |
| `khy pool auto-import now [provider] [sourcePath]` | 强制触发一次自动导入（绕过冷却） |

定位实现：`services/backend/src/cli/handlers/pool.js`（命令清单见文件头 `:3-14`）。

---

## 三、可导入的提供商矩阵

`import` / `add` 支持的提供商（`pool.js:23`）：

| 你输入的 provider | 实际归并到 | 说明 |
| --- | --- | --- |
| `windsurf` | windsurf | Windsurf 登录态 |
| `kiro` | kiro | Kiro（AWS CodeWhisperer）登录态 |
| `cursor` | cursor | Cursor 登录态 |
| `trae` | trae | Trae 登录态 |
| `warp` | warp | Warp 登录态 |
| `antigravity`（别名 `ag`） | **trae** | 归并到 trae（`pool.js:30-33`） |
| `nirvana`（别名 `nir`/`nrv`） | **trae** | 归并到 trae |

> 即 antigravity / nirvana 与 trae 共用同一条逻辑通道，导入后在 `trae` 名下统一管理。

示例：

```bash
# 从本地 Kiro 登录态导入（交互选择账号）
khy pool import kiro

# 指定来源文件导入
khy pool import trae /path/to/trae-source.zip

# 看池子整体状态
khy pool status

# 把某账号设为 cursor 的当前活跃账号
khy pool use cursor my-cursor-label
```

---

## 四、调度模式：三选一

当某提供商池内有多个可用账号时，KHY 按**调度模式**决定先用哪个。合法值仅三种（`pool.js:24`，默认 `Balance`）：

| 模式 | 语义 | 适合 |
| --- | --- | --- |
| `PerformanceFirst` | 性能优先：尽量用响应最快/额度最足的账号 | 追求速度、对账号轮换不敏感 |
| `Balance`（默认） | 均衡：在可用账号间平衡分配，兼顾稳定与轮换 | 大多数人 |
| `CacheFirst` | 缓存优先：尽量复用同一账号以提高上下文/缓存命中 | 长对话、希望少切号 |

```bash
# 查看当前模式与最大等待秒数
khy pool scheduling

# 切换为缓存优先
khy pool scheduling CacheFirst
```

> `pool scheduling`（不带参数）还会显示「最大等待秒数」——当所有账号都在冷却时，请求最多等待这么久再放弃。

---

## 五、多租户：把网关分享出去

`khy pool api [clientLabel]` 是把 KHY 网关当成**多租户服务**对外提供的入口：它为一个「客户标签」铸造一枚**独立的访问令牌**，对方用这枚令牌连你的网关，与你自己的使用相互隔离。

```bash
# 为客户 alice 铸造一枚专属令牌
khy pool api alice

# 不带标签时，自动用「当前活跃账号」派生一个默认客户名
khy pool api
```

机制（`pool.js:463-470` → `handlers/proxy.js handleProxyQuickstart`）：

1. 取客户标签（不传则用 `<provider>-<活跃账号>` 派生，再不行用 `khy-client-<时间戳>`）。
2. 调用代理快速接入，铸造一枚 **per-client managed token**。
3. 该令牌持久化到多租户客户注册表 **`proxy_server_auth.json`**（位于数据主目录；旧版本回退 `~/.khy/proxy_server_auth.json`，见 `customerRegistry.js:7-12`）。
4. 命令会打印对方的接入指引。

客户端接入时，网关同时接受两种鉴权头：

```http
Authorization: Bearer <令牌>
# 或
x-api-key: <令牌>
```

> 多租户令牌与你本机的使用相互独立：你可以为不同客户铸造不同令牌、单独吊销，而不影响自己的账号池。

---

## 六、自动导入与冷却绕过

```bash
# 强制立即导入一次（绕过冷却时间）
khy pool auto-import now

# 指定提供商 / 来源
khy pool auto-import now trae
khy pool auto-import now trae /path/to/source.zip
```

默认导入源优先级（`pool.js:489`）：

1. 环境变量 `KHY_POOL_AUTO_IMPORT_SOURCE`
2. 其次 `~/Downloads/nirvana-source.zip`

`now`（等价 `run` / `force`）会**绕过冷却时间**强制触发一次导入，适合你刚更新了登录态、想立刻刷进池子的场景。

---

## 七、相关文档

- [OPS-MAN-032] 网关-自定义provider配置-agnes —— API-key 类提供商与自定义 preset。
- [OPS-MAN-003] ai-管理-访问与登录 —— 网关访问、登录与适配器总览。
- [OPS-MAN-023] pip安装后-完整功能清单 —— 装完到底能干什么。
