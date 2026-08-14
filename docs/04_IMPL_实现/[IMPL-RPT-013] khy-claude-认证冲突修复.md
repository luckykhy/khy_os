<!-- 文档分类: IMPL-RPT-013 | 阶段: 实现 | 原路径: docs/指南/khy-claude-认证冲突修复.md -->
# KHY 与 Claude Code 认证冲突修复

> 修复日期：2026-05-27
> 状态：已实施
> 涉及文件：`khy_platform/_bootstrap.py` · `khy_platform/cli.py`

---

## 问题背景

每次 `khy` 启动时，Claude Code 都会变得无法使用，并报错：

```
401 {"error":{"message":"Invalid token","type":"new_api_error"}}
```

以及/或：

```
⚠ Auth conflict: Both a token (ANTHROPIC_AUTH_TOKEN) and an API key
  (ANTHROPIC_API_KEY) are set.
```

## 根因分析

用户的 Anthropic 认证信息存储在 `~/.claude/settings.json` 中：

```json
{
  "env": {
    "ANTHROPIC_AUTH_TOKEN": "sk-xxx",
    "ANTHROPIC_BASE_URL": "https://ai.mindflow.com.cn"
  }
}
```

KHY 的 `_sync_claude_code_auth_token()` 会在每次启动时运行，并检查
`os.environ` 中是否存在外部认证。但用户的认证信息**并不在 shell 环境变量中**——
它只存在于 `settings.json` 里。该检查漏掉了这种情况，于是向 settings.json
注入了 `ANTHROPIC_API_KEY=khy-xxx`。

结果：settings.json 同时存在 `ANTHROPIC_AUTH_TOKEN`（Mindflow）和
`ANTHROPIC_API_KEY`（KHY 本地代理）。Claude Code 选用了 KHY 的密钥，并
将其发送给 Mindflow——后者以 401 拒绝了该请求。

安全路径（`_maybe_configure_claude_code_settings`）带有 BASE_URL 守卫，
当 URL 非本地时会阻止注入。而出问题的路径
（`_sync_claude_code_auth_token`）缺少这个守卫。

### 故障链路

```
khy startup
  → _sync_claude_code_auth_token()
    → _has_external_anthropic_auth() checks os.environ only → False
    → injects ANTHROPIC_API_KEY=khy-xxx into settings.json
      → settings.json now has AUTH_TOKEN + API_KEY + mindflow URL
        → Claude Code sends khy-xxx to mindflow → 401
```

## 修复方案

### 1. `_has_external_anthropic_auth()` — 同时检查两种来源

修复前：仅检查 `os.environ`。
修复后：同时检查 **shell 环境变量** 和 **`~/.claude/settings.json`**，查找：
- `ANTHROPIC_AUTH_TOKEN`（非 khy 前缀）
- `ANTHROPIC_API_KEY`（非 khy 前缀）
- 指向非本地端点的 `ANTHROPIC_BASE_URL`

### 2. `_sync_claude_code_auth_token()` — 增加 BASE_URL 保护

加入了 `_maybe_configure_claude_code_settings()` 中已有的同款守卫：
如果 settings.json 中的 `ANTHROPIC_BASE_URL` 指向非本地 URL，则
拒绝注入 `ANTHROPIC_API_KEY`。

### 3. `_auto_configure_claude_settings()` → `_build_khy_proxy_env()`

`khy claude` 不再写入 `settings.json`。所有代理配置都通过子进程的
环境变量传递，并在进程退出时被丢弃——零残留。

### 4. `_cleanup_khy_auth_from_settings()`

当检测到外部认证时，bootstrap 会主动从 settings.json 中移除任何此前
注入的 KHY 密钥（`khy-` 前缀）和本地代理 URL。

## 防护层

| Layer | Location | Guard |
|-------|----------|-------|
| 1 | `_has_external_anthropic_auth()` | 检查 shell 环境变量 + settings.json 中的外部认证 |
| 2 | `_sync_claude_code_auth_token()` | BASE_URL 守卫：非本地 URL → 跳过注入 |
| 3 | `_maybe_configure_claude_code_settings()` | BASE_URL 守卫（已存在） |
| 4 | `_cleanup_khy_auth_from_settings()` | 主动移除残留的 khy- 密钥 |
| 5 | `_build_khy_proxy_env()` + `_launch_claude()` | khy claude 仅使用子进程环境变量，不写入 settings.json |

## 2026-05-27 补充加固

为避免今后与用户自管的 Claude Code 认证发生冲突，KHY 现在将
`~/.claude/settings.json` 视为 **opt-in 可写**：

- 默认：KHY **不**写入 Claude 设置。
- 仅在明确需要时启用：
  - `KHY_ALLOW_WRITE_CLAUDE_SETTINGS=1`
  - 或旧版别名 `KHY_MANAGE_CLAUDE_SETTINGS=1`

这同时适用于 bootstrap 同步和 AI 网关的模型槽位 API。

注意：在默认模式下，KHY 仍会执行一项范围很窄的单向卫生清理：
如果检测到外部 Anthropic 认证，它会从 `settings.json` 中移除残留的
KHY 注入的 `khy-*` API 密钥，以防止旧版冲突。

## 修复后的使用模式

| Command | Main model | Subagent | settings.json |
|---------|-----------|----------|---------------|
| `claude` | 外部认证 | 外部认证 | 不改动 |
| `khy claude` | KHY 适配器 | KHY 适配器 | 不改动（子进程环境变量） |
| `khy claude --hybrid` | 外部（claude/） | KHY 适配器 | 不改动（子进程环境变量） |
| `khy claude --hybrid-sub` | KHY 适配器 | 外部（claude/） | 不改动（子进程环境变量） |
| `khy`（后端） | 不适用 | 不适用 | 不改动（守卫生效中） |

## Doctor 自动修复

当 Claude 设置中仍残留旧版 `khy-*` 密钥时，使用内置的 doctor 修复器：

```bash
khy doctor --fix-claude-conflict
```

它会安全地移除常见的冲突残留（例如 `ANTHROPIC_API_KEY=khy-*`
与外部 `ANTHROPIC_AUTH_TOKEN` 共存），然后重新运行诊断。

## 验证方式

```bash
# Simulate khy startup without shell auth (the real scenario)
python3 -c "
import os
os.environ.pop('ANTHROPIC_AUTH_TOKEN', None)
os.environ.pop('ANTHROPIC_API_KEY', None)
from khy_platform._bootstrap import _has_external_anthropic_auth
print('Detected:', _has_external_anthropic_auth())  # Should be True
"

# Full bootstrap test
cp ~/.claude/settings.json /tmp/before.json
khy --help  # triggers bootstrap for non-version commands
diff /tmp/before.json ~/.claude/settings.json  # should show no change
```
