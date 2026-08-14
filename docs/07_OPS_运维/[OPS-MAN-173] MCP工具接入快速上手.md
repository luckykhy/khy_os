<!-- 文档分类: OPS-MAN-173 | 阶段: 运维 | 原路径: docs/07_OPS_运维/[OPS-MAN-173] MCP工具接入快速上手.md -->
# MCP 工具接入快速上手

> 用 `khy mcp` 从命令行把外部 MCP（Model Context Protocol）server 接进 khy：一键预设安装、增删改查、连通性验证、启用/禁用。本文含 18 条内置开源预设一览、缺失 `env` 提示机制，以及 stdio / SSE / HTTP 三种传输的 `mcp.json` 配置示例模板。
>
> 实现依据（核实来源）：
> - CLI 入口：`services/backend/src/cli/handlers/mcp.js`
> - 预设单一真源（18 条）：`services/backend/src/services/mcp/mcpServerPresets.js`
> - 配置读写与启用/禁用：`services/backend/src/services/mcp/mcpConfigStore.js`
> - 配置加载与自动连接：`services/backend/src/services/mcp/index.js`
> - 配置文件：`.khy/mcp.json`（用户级），项目级为 `./.khy/mcp.json`

---

## 一、命令总览

```bash
khy mcp add <名> [--scope user|project] [--env K=V] [--transport sse|http --url <地址>] -- <命令> [参数…]
khy mcp remove <名> [--scope user|project]
khy mcp presets                                   # 列出内置开源 server 预设
khy mcp show <名>                                 # 查看单台 server 配置详情
khy mcp test <名>                                 # 连接并验证一台已配置 server
khy mcp enable|disable <名> [--scope user|project] # 启用/禁用（不删除配置）
```

- `presets` / `show` / `test` 为只读或按需连接，**不受** `KHY_MCP_ADD` 门控约束（`presets` 由 `KHY_MCP_PRESETS` 门控）。
- `add` / `remove` / `enable` / `disable` 会写配置，需 `KHY_MCP_ADD` 开启。
- 解析/校验/构形在纯叶子 `mcpAddSpec`；文件读改写在薄 IO 层 `mcpConfigStore`。

---

## 二、用预设一键安装（`add` + `presets`）

预设让你免写完整启动命令。发现入口：

```bash
khy mcp presets
```

安装（短名或别名皆可，位置参数追加到命令末尾）：

```bash
khy mcp add github --env GITHUB_PERSONAL_ACCESS_TOKEN=<token>
khy mcp add filesystem ~/Documents
khy mcp add postgres postgresql://localhost/mydb
```

添加成功后会打印：写入路径、启动命令/端点、环境变量键、预设描述；若预设声明了敏感 `env` 但你没提供，会给出**缺失提示**（见第五节）。下次启动 khy 会话时会 `autoConnect` 自动连接。

> 门控关闭时（`KHY_MCP_PRESETS`）`presets` 返回空、`add <预设名>` 不做预设展开，逐字节回退为「必须手打完整命令」。

---

## 三、内置开源预设一览（18 条）

以下为 `mcpServerPresets.js` 的 `_PRESETS` 全量（据实 18 条）。`khy mcp presets` 输出按名称排序。

| 预设名 | 说明 | 传输 | 启动命令 | 需要 env |
| --- | --- | --- | --- | --- |
| `github` | GitHub 仓库/Issue/PR 读写 | stdio | `npx -y @modelcontextprotocol/server-github` | `GITHUB_PERSONAL_ACCESS_TOKEN` |
| `gitlab` | GitLab 项目/Issue/MR 读写 | stdio | `npx -y @modelcontextprotocol/server-gitlab` | `GITLAB_PERSONAL_ACCESS_TOKEN` |
| `git` | 本地 Git 仓库操作（status/diff/log/commit） | stdio | `uvx mcp-server-git` | — |
| `filesystem` | 受限目录内的文件读写 | stdio | `npx -y @modelcontextprotocol/server-filesystem` | — |
| `fetch` | 抓取网页并转成 Markdown | stdio | `uvx mcp-server-fetch` | — |
| `memory` | 基于知识图谱的持久记忆 | stdio | `npx -y @modelcontextprotocol/server-memory` | — |
| `sequential-thinking` | 结构化分步推理工具 | stdio | `npx -y @modelcontextprotocol/server-sequentialthinking` | — |
| `everything` | 官方参考/测试 server（验证连通） | stdio | `npx -y @modelcontextprotocol/server-everything` | — |
| `puppeteer` | 无头浏览器自动化（截图/点击/抓取） | stdio | `npx -y @modelcontextprotocol/server-puppeteer` | — |
| `brave-search` | Brave 联网搜索 | stdio | `npx -y @modelcontextprotocol/server-brave-search` | `BRAVE_API_KEY` |
| `slack` | Slack 频道/消息读写 | stdio | `npx -y @modelcontextprotocol/server-slack` | `SLACK_BOT_TOKEN`, `SLACK_TEAM_ID` |
| `postgres` | PostgreSQL 只读查询 | stdio | `npx -y @modelcontextprotocol/server-postgres` | — |
| `sqlite` | SQLite 数据库查询 | stdio | `uvx mcp-server-sqlite` | — |
| `time` | 时区换算与当前时间 | stdio | `uvx mcp-server-time` | — |
| `notion` | Notion 页面/数据库检索与读写 | stdio | `npx -y @notionhq/notion-mcp-server` | `NOTION_TOKEN` |
| `linear` | Linear 问题/项目/团队管理 | stdio | `npx -y mcp-linear` | `LINEAR_API_KEY` |
| `sentry` | Sentry 错误监控查询 | stdio | `npx -y @sentry/mcp-server` | `SENTRY_ACCESS_TOKEN` |
| `docker` | 本地 Docker 容器/镜像管理 | stdio | `uvx mcp-server-docker` | — |

**短名别名**（核实自 `_ALIASES`）：`gh`→`github`，`fs`/`file`/`files`→`filesystem`，`seq-thinking`/`sequentialthinking`→`sequential-thinking`，`brave`/`bravesearch`→`brave-search`，`pg`/`postgresql`→`postgres`。

**接位置参数的预设**（`argHint`）：`git`（`--repository <本地仓库路径>`）、`filesystem`（一个或多个允许访问的目录）、`postgres`（连接串）、`sqlite`（`--db-path <数据库文件>`）、`docker`（可追加 `--transport` 等）。

---

## 四、单台管理：show / test / enable / disable

```bash
khy mcp show github     # 来源/传输/状态/工具数/命令或端点/环境变量键/配置文件路径
khy mcp test github     # 主动连接并报告暴露工具数（不写配置）
khy mcp disable github  # 在该 server 配置上写 disabled:true → autoConnect 跳过
khy mcp enable github   # 删掉 disabled 字段
khy mcp remove github   # 从配置中删除
```

- `disable` = 写 `"disabled": true`（`loadConfig` 映射为内部 `_disabled` → `connectAll` 跳过）；`enable` = 删除该字段。
- `test` 若目标已禁用会提示先 `enable`。

---

## 五、缺失 env 提示机制

预设通过 `requiresEnv` 声明所需敏感环境变量。`resolvePreset` 会对比你 `--env` 提供的键，收集 `missingEnv`（**不阻断**：server 仍写入配置，但缺 token 连不上）。handler 会打印：

```
⚠ 该预设需要环境变量：GITHUB_PERSONAL_ACCESS_TOKEN。
  重新运行并追加，例：khy mcp add github --env GITHUB_PERSONAL_ACCESS_TOKEN=<你的值>
```

补齐方式：重新 `khy mcp add <名> --env KEY=VALUE`（会更新该 server 配置）。

---

## 六、`mcp.json` 三种传输配置示例

配置文件位于 `.khy/mcp.json`（用户级）。**JSON 不支持注释**，故以下用代码块给注释模板；实际写入时请去掉注释或用 `khy mcp add` 生成。三种传输分别为：`stdio`（本地子进程，最常见）、`sse`（Server-Sent Events）、`http`（Streamable HTTP）。

### 6.1 stdio（本地子进程）

```jsonc
{
  "mcpServers": {
    "my-stdio": {
      "type": "stdio",
      "command": "npx",                 // 可执行命令
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "~/Documents"],
      "env": { "SOME_TOKEN": "xxx" }   // 可选：注入子进程的环境变量
    }
  }
}
```

### 6.2 SSE（Server-Sent Events）

```jsonc
{
  "mcpServers": {
    "my-sse": {
      "type": "sse",
      "url": "https://mcp.example.com/sse",  // SSE 端点
      "headers": { "Authorization": "Bearer <token>" }  // 可选鉴权头
    }
  }
}
```

### 6.3 HTTP（Streamable HTTP）

```jsonc
{
  "mcpServers": {
    "my-http": {
      "type": "http",
      "url": "https://mcp.example.com/mcp",   // HTTP 端点
      "headers": { "Authorization": "Bearer <token>" }
    }
  }
}
```

### 6.4 禁用一台 server（示例条目通用做法）

在任意 server 配置里加 `"disabled": true`，`autoConnect` 会跳过它——本仓库 `.khy/mcp.json` 里的 `example-stdio` / `example-sse` / `example-http` 三条示例条目即用此法保持「可见但不连接」，同时不破坏现有可用配置的合法性。

---

## 七、最小可用 `mcp.json`（现有真实配置）

```json
{
  "mcpServers": {
    "deepseek-eyes": {
      "type": "stdio",
      "command": "D:\\Portable\\khy-os\\tools\\deepseek-eyes\\.venv\\Scripts\\python.exe",
      "args": ["-m", "deepseek_eyes"],
      "env": { "MODELSCOPE_API_KEY": "<your-key>" }
    }
  }
}
```

> 支持新格式 `{ "mcpServers": {...} }` 与 legacy `{ "servers": [...] }`（数组用 `enabled:false` 表示禁用）。推荐用新格式。

---

## 关联文档

- 自定义供应商接入：`[OPS-MAN-172] 自定义供应商接入指南.md`
- 项目规则总纲（命名/skill/权限/mcp）：`[OPS-MAN-169] 项目规则总纲-命名·skill·权限·mcp.md`
