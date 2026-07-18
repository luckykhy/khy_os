<!-- 文档分类: OPS-MAN-047 | 阶段: 运维 | 原路径: docs/07_OPS_运维/[OPS-MAN-047] 代理服务器深度指南-khy-proxy.md -->
# 代理服务器深度指南（`khy proxy`）

> `khy proxy` 是 KHY 的 **HTTP 反向代理服务器**——把网关里可用的模型对外暴露成标准 API（Anthropic / OpenAI 协议）。Claude Code、Codex、各类 IDE 把自己的 base URL 指向它即可用上 KHY 的全部适配器。本文把它的全部子命令讲清楚，命令均可直接照抄。
>
> 默认监听 `127.0.0.1:9100`（`PROXY_PORT` 改端口、`PROXY_HOST` 改绑定地址）。实现：`services/backend/src/cli/handlers/proxy.js` + `services/backend/src/services/gateway/proxyServer.js`。

---

## 一、它和 `khy gateway` / `khy claude` 的关系

- **`khy proxy`** = 对外的 HTTP 服务器（协议转换 + 适配器级联 + 多租户令牌）。
- **`khy gateway`** = 管理「网关里有哪些来源/模型」（见 [OPS-MAN-003] §8 四类配置模式）。`gateway status`/`gateway model` 会自动触发 proxy 的 switch-center 同步（用 `SWITCH_CENTER_AUTO_SYNC=false` 关）。
- **`khy claude`** = 一键拉起 Claude Code 并把它的 `ANTHROPIC_BASE_URL` 指向本代理（见 [OPS-MAN-004]）。

一句话：网关决定「有什么模型」，proxy 决定「怎么把它们当 API 发出去、发给谁」。

---

## 二、生命周期与状态

| 命令 | 作用 |
| --- | --- |
| `khy proxy start [--port <n>]` | 启动反代守护进程，打印入口 URL 与 auth token |
| `khy proxy start --https [--https-port 9443] [--tls-cert <path>] [--tls-key <path>]` | 以 HTTPS 启动；裸 `--https` 会自动在 `~/.khyquant/proxy_certs/` 生成自签证书 |
| `khy proxy stop` | 停止守护进程 |
| `khy proxy status` | 运行状态、auth 来源、令牌计数、路由模式、配置文件路径 |
| `khy proxy quickstart [客户名] [--token <t>]` | 一键启动并打印接入参数；给了客户名则顺手为其铸一枚令牌 |

```bash
khy proxy quickstart                 # 最省心：起服务 + 打印接入参数
khy proxy status                     # 忘了 token / 端口就看这里
PROXY_PORT=8080 khy proxy start      # 换端口
```

客户端接入（把 base URL 指向本代理，用 `khy-` 开头的令牌鉴权）：

```bash
export ANTHROPIC_BASE_URL=http://127.0.0.1:9100
export ANTHROPIC_API_KEY=khy-你的token        # 或 Authorization: Bearer khy-...
# OpenAI 风格客户端：OPENAI_BASE_URL=http://127.0.0.1:9100/v1
```

**配置 / 状态文件**：`~/.khyquant/proxy.json`（配置）、`~/.khyquant/proxy_server_runtime.json`（运行时/PID）、`~/.khyquant/proxy_certs/`（自签证书）；多租户令牌库 `proxy_server_auth.json`（位于数据主目录，默认 `~/.khy/`）。

---

## 三、多租户：`client` 与 `token`

把网关分享给别人时，给每个客户铸一枚**独立、可单独吊销**的令牌。推荐用 `client` 子命令（更现代）：

| 命令 | 作用 |
| --- | --- |
| `khy proxy client add <客户名> [token]` | 为客户新增令牌（不给则自动生成） |
| `khy proxy client list` | 列出全部客户令牌（默认动作） |
| `khy proxy client rotate <token_id> [新token]` | 轮换某客户令牌 |
| `khy proxy client on\|off <token_id>` | 启用 / 停用 |
| `khy proxy client del <token_id>` | 删除（别名 delete/remove/revoke） |

```bash
khy proxy client add acme-corp        # 给客户 acme-corp 铸一枚令牌
khy proxy client list
khy proxy client rotate <token_id>    # 疑似泄露立即轮换
khy proxy client off <token_id>       # 临时停用
```

> `khy proxy token …`（set/rotate/create/list/enable/disable/delete）是更早的「主令牌 + 受管令牌」兼容接口，与 `client` 操作同一套令牌库。新用户用 `client` 即可。多租户与账号池的关系见 [OPS-MAN-045]。

---

## 四、HTTPS 证书：`cert`

```bash
khy proxy cert generate [--force] [--cn localhost] [--days 825] \
  [--tls-dir <dir>] [--tls-cert <c>] [--tls-key <k>]
khy proxy cert status        # 看证书/私钥路径与是否存在
```

裸 `khy proxy start --https` 会在 `~/.khyquant/proxy_certs/` 自动生成证书；要自带证书就用 `--tls-cert/--tls-key` 指定。

---

## 五、上游订阅（Clash / VPN）：`subscription` / `sub`

当代理出口需要走机场订阅时：

| 命令 | 作用 |
| --- | --- |
| `khy proxy subscription list` | 列出已配置订阅（默认动作） |
| `khy proxy subscription add <url> [name]` | 新增（别名 import） |
| `khy proxy subscription remove <id\|name\|url>` | 删除 |
| `khy proxy subscription use <id\|name\|url>` | 切换当前订阅 |
| `khy proxy subscription refresh [id\|name\|url] [--timeout 12000]` | 刷新订阅内容 |
| `khy proxy subscription apply [id\|name\|url] [--timeout 12000]` | 应用订阅 |

```bash
khy proxy subscription add https://example.com/sub myclash
khy proxy subscription apply myclash --timeout 12000
```

---

## 六、TLS 指纹旁路：`tls`

部分上游按 TLS 指纹拦截时，用指纹旁路改写握手特征：

```bash
khy proxy tls start | stop | status
khy proxy tls fingerprint <name>     # name: chrome_auto / chrome_120 / firefox_auto / firefox_120 / safari / random
```

---

## 七、IDE 模型代理切换：`switch-center`（统一）与 trae/windsurf-switch（兼容）

把 Trae / Windsurf 这类 IDE 的模型出口统一切到 KHY 网关或自定义端点。**推荐用统一入口 `switch-center`**：

```bash
khy proxy switch-center status [--provider trae|windsurf]
khy proxy switch-center sync   [--provider trae|windsurf]
khy proxy switch-center use    <id|名称> [--provider trae|windsurf]
khy proxy switch-center remove <id|名称> [--provider trae|windsurf]
khy proxy switch-center test   [id|名称] [--provider …] [--model xxx]
khy proxy switch-center add --provider trae <名称> --endpoint <openai_base> --models <m1,m2>
```

> `trae-switch` / `windsurf-switch` 是各自的**旧兼容子命令**（add/use/remove/test/sync），功能被 `switch-center` 收敛；新用户用 `switch-center`。
>
> 注意：switch-center 同步会把 `RELAY_API_*` 与 `PROXY_MODEL_ROUTE_MAP` 写进网关 `.env`。

---

## 八、cursor2api 集成：`cursor2api`

接入 cursor2api（把 Cursor 能力转成 API）：

```bash
khy proxy cursor2api setup <zip路径> [--port 3010] [--token khy-xxx]   # 解压安装（别名 extract/install/import）
khy proxy cursor2api prepare [--force-install] [--force-build]         # 预构建（别名 build）
khy proxy cursor2api start [--port 3010] [--token khy-xxx] [--no-auth]
khy proxy cursor2api stop
khy proxy cursor2api status                                            # 默认动作
khy proxy cursor2api token status | set <token> | rotate | clear
```

---

## 九、相关文档

- [OPS-MAN-004] claude-code-代理配置 —— 用 `khy claude` 一键把 Claude Code 指向本代理。
- [OPS-MAN-045] 账号池与多租户-深度指南 —— 令牌铸造与账号池的关系。
- [OPS-MAN-003] ai-管理-访问与登录 §8 —— 网关四类配置模式总览。
