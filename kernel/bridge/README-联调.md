# khy-bridge 实战联调指南

把自研内核 KHY-OS 接到真 agent 上。两条路线对应需求1的两侧，都走同一个
`KhyBridge`（COM2 串口 ⇄ JSON，三面：控制/决策/事件），互不重复协议逻辑。

```
                ┌──────────── KHY-OS (QEMU) ────────────┐
                │  COM1 = 人类 TTY    COM2 = agent 通道  │
                └───────────────┬───────────────────────┘
                                │ unix socket (/tmp/khy-agent.sock)
                ┌───────────────┴───────────────┐
        side a │ 内置 KHY Node agent            │ side b
   khy-agent-run.js  (in-process, brain=网关)   khy-mcp.js (MCP server)
        决策面真模型决策                         外部 agent（Claude Code）驱动控制面
```

任一时刻 COM2 只接一个客户端（QEMU unix socket server 单连接），所以
side a 与 side b 二选一连，不同时连。

---

## 先决条件

```bash
make -C kernel            # 构建 ISO（产物 kernel/build/khy-os-kernel.iso）
```

启动带 agent 串口的 KHY-OS（COM1 走 stdio 给人，COM2 走 unix socket 给 agent）：

```bash
make -C kernel run-agent  # COM2 默认 = /tmp/khy-agent.sock（AGENT_SOCK 可改）
```

---

## 路线 A：内置 agent + 项目 AI 网关（真模型决策）

让 OS 里的 `ai <自然语言>` 和 `agentask <问题>` 由真实大模型作答。

1. 起项目 AI 网关（OpenAI 兼容，默认 `127.0.0.1:9100`，token 在
   `~/.khy/proxy_server_auth.json` 自动生成）。
2. 跑内置 agent：

   ```bash
   node kernel/bridge/khy-agent-run.js              # 连 /tmp/khy-agent.sock
   # 或显式：node kernel/bridge/khy-agent-run.js --socket /tmp/khy-agent.sock
   ```

3. 在 OS 的 COM1 shell 里：

   ```
   ai use model claude/claude-sonnet-4-20250514     # 选模型，落 /disk/etc/agent.conf
   ai 帮我把当前模型告诉我                            # GET，回显配置
   agentask 我可以删除整个磁盘吗                      # 决策面 → 模型判 DENY
   ```

   选模型后让 agent 重读配置（无需重启）：`kill -HUP <khy-agent-run 进程>`。

**环境变量**（均可选，opts > env > 默认）：

| 变量 | 含义 | 默认 |
|---|---|---|
| `KHY_GATEWAY_URL` | 网关 completions URL | `http://127.0.0.1:9100/v1/chat/completions` |
| `PROXY_AUTH_TOKEN` | bearer token | 读 `~/.khy/proxy_server_auth.json` 的 `authToken` |
| `KHY_BRAIN_MODEL` | 无 in-system 配置时的兜底模型 | `claude/claude-sonnet-4-20250514` |
| `KHY_BRAIN_TIMEOUT_MS` | 单次 HTTP 超时 | `2500`（< 内核 3s ask 死线） |

**松耦合保证**：网关不可达 / 401 / 超时，brain 自动降级为内置规则脑（`defaultBrain`），
内核永远拿得到合法答案，绝不被挂死。需要 `/disk` 才能持久化模型配置，故跑 `ai set ...`
时请给 QEMU 加 `-hda`（`run-agent` 默认未挂盘，可在 Makefile 加，或仅做非持久测试）。

---

## 路线 B：外部 agent（Claude Code）经 MCP 驱动 OS

让 Claude Code 直接 list/read/write KHY-OS 文件、看进程、读配置。

仓库根已带 `.mcp.json`（project-scoped），声明了 `khy-os` MCP server：

```json
{
  "mcpServers": {
    "khy-os": {
      "command": "node",
      "args": ["kernel/bridge/khy-mcp.js", "--socket", "/tmp/khy-agent.sock"],
      "env": { "KHY_MCP_CONNECT_TIMEOUT_MS": "60000" }
    }
  }
}
```

在仓库根开 Claude Code，它会发现该 server（首次需在 `/mcp` 里批准 project server）。
或手动注册：

```bash
claude mcp add khy-os -- node kernel/bridge/khy-mcp.js --socket /tmp/khy-agent.sock
```

`khy-mcp.js` 会**等待 COM2 socket 出现**（上限 `KHY_MCP_CONNECT_TIMEOUT_MS`，默认 30s，
.mcp.json 里设 60s），所以先开 Claude Code 再 `make run-agent` 也能自动挂上。

挂上后，Claude Code 会看到这些工具（与内置 agent 共用同一份 `khy-tools.js`）：

| 工具 | 作用 |
|---|---|
| `khy_list` / `khy_stat` / `khy_read` | 浏览/读取 KHY-OS 文件 |
| `khy_write` / `khy_mkdir` / `khy_remove` | 修改 KHY-OS 文件（`/bin` 受 EPERM 守卫保护） |
| `khy_ps` | 看进程表 |
| `khy_get_config` | 读 `/disk/etc/agent.conf` |

例：让 Claude “列出 KHY-OS 根目录并读 /etc/motd” → 走 `khy_list` + `khy_read` →
真实命中内核 VFS。

诊断只走 stderr，stdout 仅 MCP 协议字节，不会污染 JSON-RPC。
