<!-- 文档分类: OPS-MAN-046 | 阶段: 运维 | 原路径: docs/07_OPS_运维/[OPS-MAN-046] 旗舰特性目录-vault-notify-mesh-insights-forge-image2web.md -->
# 旗舰特性目录 — vault / notify / mesh / insights / forge / image2web

> KHY 内置了一批「代码里早就有、文档里却找不到」的实用命令。本文把它们逐个讲清楚：是什么、入口命令、典型用法、当前状态。所有命令都可直接照抄。
>
> 状态图例：✅ 可用（已实现）｜🚧 开发中（占位桩，暂不可用）。

| 命令 | 一句话 | 状态 |
| --- | --- | --- |
| `khy vault` | 本地密钥保险库，密钥永不进模型上下文 | ✅ |
| `khy notify` | 把长任务完成/阻塞点推送到手机或桌面 | ✅ |
| `khy mesh` | 同机多实例互相发现与跨进程消息 | ✅ |
| `khy insights` | 会话洞见：轮次/工具/话题/耗时复盘 | ✅ |
| `khy forge` | 跨 GitHub/Gitee/GitLab 搜索与克隆仓库 | ✅ |
| `khy image2web` | 截图 → 可运行 HTML 网页 | ✅ |
| `khy voice` | 语音控制 | 🚧 |

---

## 一、`vault` — 本地密钥保险库 ✅

把 API Key、令牌等敏感值存在本地保险库（`~/.khyos/vault`，文件权限 0600）。在提示词、HTTP 配置里用占位符 `{{vault:NAME}}` 引用，真实值在**服务端注入**，**永远不进入模型上下文**。

```bash
khy vault list                 # 列出全部密钥（始终打码显示）
khy vault set <name> [value]   # 存/改一个密钥；省略 value 则从 stdin 读入
khy vault get <name> --reveal  # 查看；不加 --reveal 默认打码
khy vault rm <name>            # 删除
khy vault on | off             # 启用/停用保险库
```

引用语法（例如在自定义 HTTP 请求头里）：

```
Authorization: Bearer {{vault:MY_TOKEN}}
```

> 适合：不想把密钥明文写进提示词或配置文件，又要让 KHY 在请求里用到它。

---

## 二、`notify` — 终端外推送 ✅

配置一个推送目标，让 KHY 在**长任务完成 / 遇到阻塞点**时，把消息推到你的手机或桌面。配置存 `~/.khyos/push.json`（0600）。KHY 自身不带推送后端，你提供目标即可。

```bash
khy notify status                  # 查看当前配置（目标打码）
khy notify set <provider> <target> # 设目标；省略 target 从 stdin 读
khy notify test                    # 发一条测试通知
khy notify send <title> [body]     # 手动发一条
khy notify clear                   # 清空配置
khy notify on | off                # 启用/停用
```

支持的 provider：**ntfy / Bark / Discord / Slack / 通用 webhook**。

```bash
# 例：用 ntfy 推到自己的主题
khy notify set ntfy https://ntfy.sh/my-khy-topic
khy notify test
```

---

## 三、`mesh` — 同机多实例协作 ✅

让同一台机器上的多个 KHY 实例互相发现、挂接、收发消息（注册表在 `~/.khyos/peers/`，存活性用进程探测）。适合一个窗口跑长任务、另一个窗口给它发指令。

```bash
khy mesh peers                       # 列出在线实例（自动清理已退出的）
khy mesh register --name dev         # 注册本实例，打印其 id
khy mesh send <peerId> "<消息>"       # 给某实例的收件箱投递消息
khy mesh inbox <id>                  # 读取并清空某实例收件箱
khy mesh attach <selfId> <peerId>    # 把本实例挂接到某实例（设默认对端）
khy mesh detach <selfId>             # 解除挂接
khy mesh on | off                    # 启用/停用
```

---

## 四、`insights` — 会话洞见 ✅

对一次会话做复盘：对话轮次、最常用的工具、话题关键词、耗时。读取已持久化的会话记录。

```bash
khy insights                # 复盘当前/最近一次会话
khy insights <sessionId>    # 复盘指定会话
khy insights list           # 列出可分析的历史会话
khy insights on | off       # 启用/停用
```

---

## 五、`forge` — 跨平台仓库搜索与拉取 ✅

跨 **GitHub / Gitee / GitLab** 搜索、勘察、克隆、更新仓库。令牌从环境变量读取（`GITHUB_TOKEN` / `GITEE_TOKEN` / `GITLAB_TOKEN`），从不回显。

```bash
khy forge search "<关键词>" [--platform github|gitee|gitlab] [--limit N] [--json]
khy forge recon <owner/repo|git-url> [--platform ...] [--ref BRANCH]
khy forge commits <owner/repo|git-url> [--platform ...] [--limit N]
khy forge code "<查询>" [--repo owner/repo]      # 仅 GitHub
khy forge ratelimit                              # 仅 GitHub
khy forge clone <owner/repo|git-url> [--dir NAME] [--depth 1] [--ssh]
khy forge update [dir] [--remote origin] [--branch main]   # 别名 pull
```

- `search` / `recon` / `commits` / `clone` / `update` 三平台都支持；`code`、`ratelimit` **仅 GitHub**。
- 每个子命令都支持 `--json` 输出，便于脚本消费。
- 推送/提交不在 forge 里：用 `khy repo publish`（推送）、`khy repo save`（提交）。

```bash
# 例：搜 Gitee 上的 agent 项目并克隆第一个
khy forge search "ai agent" --platform gitee --limit 5
khy forge clone owner/some-repo --depth 1
```

---

## 六、`image2web` — 截图变可运行网页 ✅

把一张网页截图（文件或剪贴板）交给 AI 网关，**还原成单文件可运行的 HTML**。若 AI 只返回片段，会自动包成完整 `<!doctype html>` 文档。

```bash
khy image2web <图片路径|paste> [还原提示词] [--out index.html] [--overwrite]
```

参数：

- 输入来源：图片路径，或 `paste` / `--clipboard` / `--paste` 从剪贴板取图。
- 输出：`--out`（或 `--output`）指定文件名；目标已存在会自动改名，除非 `--overwrite`（或 `--force`）。
- 只看不存：`--print` / `--stdout` / `--no-save` 把 HTML 打到标准输出而不落盘。

```bash
khy image2web ./landing.png 还原这个网页为可运行 HTML --out landing.html
khy image2web paste 还原成响应式网页 --out clipboard-page.html
```

成功后打印输出路径与所用的 AI provider/模型。

---

## 七、`voice` — 语音控制 🚧

```bash
khy voice
```

**当前为占位桩，暂无实际功能**（`router.js:2874` 注释 `Voice control placeholder`，运行只打印「语音控制功能正在开发中…」并提示用系统级 Win+H 语音输入）。列在此处是为了如实说明它的状态——请勿据此预期可用的语音能力。

---

## 八、延伸：`khy-expand` 虚拟模型

如果你想把 KHY 的**全部能力栈当成一个可订阅的模型**对外提供，KHY 暴露了虚拟模型 `khy-expand`：外部客户端在网关 HTTP API 里选择 `model: "khy-expand"`，即可命中 KHY 的本地确定性能力 → 协同注入 → 直路由的完整链路（详见 [OPS-MAN-045] 多租户一节与网关文档）。它不是 CLI 子命令，而是网关侧的虚拟模型入口。

---

## 相关文档

- [OPS-MAN-045] 账号池与多租户-深度指南
- [OPS-MAN-023] pip安装后-完整功能清单
- [OPS-MAN-035] 特性访问-维护速查
