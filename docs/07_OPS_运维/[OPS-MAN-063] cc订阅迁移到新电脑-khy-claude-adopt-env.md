# CC 订阅迁移到新电脑（khy claude adopt-env）

> 目标：在 **A 电脑**（已配好 Claude Code 中转订阅）上把凭据固化，然后在 **B 电脑**
> `pip install` khy 之后，**原样还原同一套 CC 订阅**，直接就能用、不用重新申请或重配。

---

## 一、你要迁移的到底是什么

Claude Code（以及 khy）用来打 CC 模型的,是**三个环境变量**——不是账号密码,而是一套“指向哪个中转 + 用哪个 token”的配置:

| 变量 | 含义 | 例子 |
|---|---|---|
| `ANTHROPIC_BASE_URL` | 中转/网关端点 | `https://ai.mindflow.com.cn` |
| `ANTHROPIC_AUTH_TOKEN` | 中转的访问 token（**机密**） | `sk-****`（Bearer） |
| `ANTHROPIC_MODEL` | 默认模型（可选） | `claude-opus-4-8` |

> 官方直连的人用的是 `ANTHROPIC_API_KEY`（走 `x-api-key`）；中转/网关用的是
> `ANTHROPIC_AUTH_TOKEN`（走 `Authorization: Bearer`）。khy 会**根据来源自动选对**请求头。

**唯一需要搬到新电脑的东西 = 上面这几项。** 迁移 = 把它们安全地复制到 B 电脑并让 khy 认得。

> ⚠️ 安全:`ANTHROPIC_AUTH_TOKEN` 是机密。**只能通过私密渠道**（scp/SSH、U 盘、密码管理器）
> 传输,**绝不要**发到聊天/邮件/公共仓库/截图。任何进入公开 PyPI 包的 token 都会被爬走盗用——
> 所以 khy **不会**把 token 打进发布包,凭据只留在你本机。

---

## 二、A 电脑:把当前 CC 订阅固化成一个可迁移文件

在 A 电脑（当前 shell 里已经有 CC 那套 env,也就是你平时能正常跑 `claude` 的环境）执行:

```bash
khy claude adopt-env
```

它会把当前 `ANTHROPIC_*` 写进本机的 **`~/.khy/.env`**（权限 `600`,token 打码显示）:

```
✓ 已把当前 Claude Code 凭据固化到本地: ~/.khy/.env
  凭据类型: ANTHROPIC_AUTH_TOKEN  → auth scheme: bearer
  端点:     https://ai.mindflow.com.cn
  默认模型: claude-opus-4-8
  token:    sk-****(len=51)  (仅存本机 · 永不进包)
```

这个 `~/.khy/.env` 就是**唯一要迁移的产物**。它在 `site-packages` 之外,所以 `pip install -U khy-os`
升级时**永远不会覆盖它**——A 电脑上你写一次,以后升级都记得。

- Linux/macOS 路径:`~/.khy/.env`
- Windows 路径:`%USERPROFILE%\.khy\.env`

### 更省事:一键导出到桌面(方便拷到新电脑)

如果你想要一个**放在桌面、随手就能拷走**的迁移文件:

```bash
khy claude export-env                 # 默认写到 ~/Desktop/khy-cc-env.env
khy claude export-env "D:\\khy-cc.env"  # 也可指定任意路径
```

它优先读当前 shell 的 CC env;若 shell 没有,就回退导出你已经 `adopt-env` 存过的
`~/.khy/.env`。**屏幕只显打码 token,文件里是明文**(权限 600)。

```
✓ 已导出凭据迁移文件: /home/you/Desktop/khy-cc-env.env
  凭据类型: ANTHROPIC_AUTH_TOKEN
  端点:     https://ai.mindflow.com.cn
  token:    sk-****(len=51)  (文件里是明文 · 屏幕只显打码)
  ⚠ 这是含 live token 的机密文件。只走私密渠道拷到新电脑,用完请删除。
```

> ⚠ 桌面这个文件**含明文 token**,是机密。只走私密渠道(scp/U 盘/密码管理器)拷到新电脑,
> **用完删除**,切勿提交 git / 发聊天 / 贴截图。新电脑上把它放到 `~/.khy/.env` 即可(见第三章方式 1)。

---

## 三、B 电脑:pip 安装后还原

先在 B 电脑装 khy:

```bash
pip install -U khy-os
```

然后**任选一种**方式还原(从最省事到最手动):

### 方式 1（推荐）：直接把凭据文件拷过去

把 A 电脑的 `~/.khy/.env` 安全复制到 B 电脑的同一路径即可,khy 每次启动会自动加载。

```bash
# 在 B 电脑上,通过 SSH 从 A 拉取（示例;换成你的主机名/用户）
mkdir -p ~/.khy
scp userA@A-host:~/.khy/.env ~/.khy/.env
chmod 600 ~/.khy/.env
```

Windows(PowerShell)对应:

```powershell
New-Item -ItemType Directory -Force "$env:USERPROFILE\.khy" | Out-Null
# 用 scp / U 盘把 .env 放到:
#   %USERPROFILE%\.khy\.env
```

> 只需拷这**一个文件**。里面就是第一章那三行 `KEY=VALUE`,没有别的依赖。

### 方式 2：在 B 电脑先设好同样的 env,再 adopt

如果你不想拷文件,而是手动把同一套变量配到 B 的 shell(比如 B 上也装了 Claude Code、
env 已经有了),那就直接:

```bash
# 例:临时在当前 shell 设置（换成你真实的中转与 token）
export ANTHROPIC_BASE_URL="https://ai.mindflow.com.cn"
export ANTHROPIC_AUTH_TOKEN="sk-你的token"
export ANTHROPIC_MODEL="claude-opus-4-8"

# 固化到 ~/.khy/.env,之后不用每次 export
khy claude adopt-env
```

### 方式 3：只手写文件

直接在 B 电脑创建 `~/.khy/.env`,内容就是:

```dotenv
ANTHROPIC_BASE_URL=https://ai.mindflow.com.cn
ANTHROPIC_AUTH_TOKEN=sk-你的token
ANTHROPIC_MODEL=claude-opus-4-8
```

保存后 `chmod 600 ~/.khy/.env`。

### 方式 4：用随包内置的“中转预设”(只带 token,不用记端点)

中转端点(如 `https://ai.mindflow.com.cn`)**不是机密**,已作为**可选预设**随包内置。
所以在 B 电脑你**只需要自带 token**,端点由预设提供,不用记不用抄:

```bash
# 1) 只把 token 放进当前 shell(端点来自预设,绝不随包发布 token)
export ANTHROPIC_AUTH_TOKEN="sk-你的token"

# 2) 启用预设并固化到 ~/.khy/.env
khy claude use-relay mindflow

# 不带名字可列出所有可用预设:
khy claude use-relay
```

> 为什么端点能进包、token 不能:端点是公开 URL,预设只是**你显式选中才生效**的可选项,
> 不会变成所有人的默认(否则会把别人的官方 key 悄悄发到这个中转)。token 是机密,
> 任何进公开包的 token 都会被爬走——所以它永远只来自你本机的 shell/文件。

---

## 四、验证还原成功

1. **连通性**（打中转端点应返回 HTTP 200/401 之类的真实响应,而非连不上）:

   ```bash
   # Linux/macOS
   curl -sS -o /dev/null -w "%{http_code}\n" \
     -H "Authorization: Bearer $ANTHROPIC_AUTH_TOKEN" \
     "$ANTHROPIC_BASE_URL/v1/models"
   ```

   ```powershell
   # Windows PowerShell（注意整条不要换行拆断参数）
   Invoke-WebRequest -Uri "$env:ANTHROPIC_BASE_URL/v1/models" -Headers @{ Authorization = "Bearer $env:ANTHROPIC_AUTH_TOKEN" } | Select-Object -ExpandProperty StatusCode
   ```

2. **让 khy 打一次 CC 模型**（正常返回内容即还原成功）:

   ```bash
   khy "用一句话自我介绍"
   ```

---

## 五、工作原理（为什么升级也不丢）

- khy 启动时会额外加载 `~/.khy/.env`（`dotenv`,`override:false`）。
  - **真实 shell 环境变量优先级更高**:如果 B 电脑的 shell 里已经 `export` 了这几项,那以 shell 为准;
    `~/.khy/.env` 只在变量“没设”时兜底填入。
- 填入后,khy 走的是与 CC 完全相同的 env 代码路径 → 自动识别 `ANTHROPIC_AUTH_TOKEN` →
  用 `Authorization: Bearer` 打你的中转。
- `~/.khy/.env` 在 `site-packages` 之外 → `pip install -U khy-os` **不覆盖** → 一次配置,长期有效。

---

## 六、安全与边界

- **token 只在你自己的机器上**（A 和 B 的 `~/.khy/.env`,权限 600),**从不进入 pip 发布包**。
  发布包是公开的,任何写进去的密钥都会被盗——这是硬底线。
- 传输 token 只走私密渠道;**不要**把 `~/.khy/.env` 提交进 git、发聊天、贴截图。
- 想撤销:删掉 B 电脑的 `~/.khy/.env`(并从对应 shell profile 里移除相关 `export`)即可,
  khy 会回退到无该凭据的状态。
- 换了中转或 token:在 A 上重新 `khy claude adopt-env`(会**就地覆盖**旧值,幂等),再把新
  `~/.khy/.env` 同步到 B。

---

## 七、常见问题

**Q：B 电脑没装 Claude Code,只装了 khy,能用吗?**
能。你要迁移的只是那三个环境变量,和 Claude Code 本身是否安装无关。用方式 1/3 放好
`~/.khy/.env` 即可。

**Q：`khy claude adopt-env` 说“未检测到凭据”?**
说明当前 shell 没有 `ANTHROPIC_AUTH_TOKEN` / `ANTHROPIC_API_KEY`。先 `export` 好(方式 2),
或直接用方式 1/3 放文件。

**Q：会不会和我 shell 里已有的 env 冲突?**
不会。真实 shell env 优先,`~/.khy/.env` 只兜底。想强制以文件为准,就把 shell 里的
`export` 删掉。

**Q：多台电脑都要?**
把同一个 `~/.khy/.env` 分发到每台机器的相同路径即可。
