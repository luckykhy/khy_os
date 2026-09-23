# [IMPL-RPT-044] khyos 账号体系收口实施记录 — ARCH-074 落地

> **承接设计**：[DESIGN-ARCH-074] khy-os 账号体系收口-用户名唯一键 alias 软冲突 密码必填 局域网登录
> **前序记录**：[IMPL-RPT-043] 任务列表截断修复（无关，但同分支）
> **落地时间**：2026-09-02
> **改动统计**：8 个代码文件 + 1 个设计文档 + 1 个部署文档 + 2 个索引登记

---

## 0. 改动一览

| # | 文件 | 改动类型 | 摘要 |
|---|---|---|---|
| 1 | `platform/packages/shared/src/models/User.js` | 加字段 | `aliases: JSON default []` + `displayName: STRING(80)`；`PUBLIC_ATTRIBUTES`/`REFERENCE_ATTRIBUTES` 加入 |
| 2 | `services/ai-backend/src/services/loginKeyResolver.js` | **新建** | 纯函数 `resolveLoginKey` / `normalizeAliases` / `findAliasConflicts` |
| 3 | `services/ai-backend/src/routes/auth.js` | 改路由 | `/login` 走 `resolveLoginKey`；`/register` 接 aliases 并做跨账号唯一性校验 |
| 4 | `services/backend/src/services/credentialGenerator.js` | 加函数 | `ensureDefaultAdminPassword()`：aio backend User admin 若无密码则同步 default-admin.json 的随机密码 |
| 5 | `services/backend/src/services/cliAuthService.js` | 改函数 | `_loadBuiltinAccounts` 触发默认密码补齐；`_loadCredentials` 软校验 aliases 字段；`register` 接 aliases 第六个参数；`login` 按 username/email/alias 查找 |
| 6 | `services/backend/src/cli/tui/ink-components/App.js` | 改 UI | runAuthForm 表单加「别名（可选，逗号分隔）」字段；登录态变更清 banner 冻结 ref |
| 7 | `services/backend/src/constants/serviceDefaults.js` | 加常量 | `AI_MGMT_HOST` 默认 `'0.0.0.0'`，env 可覆盖 |
| 8 | `services/ai-backend/server.js` | 改 listen | `app.listen(PORT, AI_MGMT_HOST, ...)`，LAN 暴露；启动横幅告知 |
| 9 | `docs/03_DESIGN_设计/[DESIGN-ARCH-074] ...md` | **新建** | 设计文档（单一真源） |
| 10 | `docs/06_DEPLOY_部署/LAN-FIREWALL.md` | **新建** | Windows / macOS / Linux 防火墙放行说明 |
| 11 | `docs/00_INDEX_文档索引.md` | 索引登记 | 主索引加 074 + LAN-FIREWALL |
| 12 | `docs/03_DESIGN_设计/00_INDEX_设计-分类索引.md` | 索引登记 | 设计分类索引加 074 |
| 13 | `docs/06_DEPLOY_部署/00_INDEX_部署-分类索引.md` | 索引登记 | 部署分类索引加 LAN-FIREWALL |

---

## 1. 各改动详情

### 1.1 User 模型加字段

```text
aliases     JSON      default []      comment: '登录别名集合（不含 username/email）。应用层全局唯一。'
displayName STRING(80) nullable      comment: '昵称，仅展示用，不参与登录'
```

- `aliases` JSON 字段不带 DB unique index（跨 DB 引擎一致性），唯一性由 `loginKeyResolver.findAliasConflicts` 在 register 路径应用层校验
- `displayName` 仅 banner / whoami 用，门控 `KHY_BANNER_USE_DISPLAY_NAME` 默认关（不在本次落地）
- `PUBLIC_ATTRIBUTES` / `REFERENCE_ATTRIBUTES` 加入 `displayName`；`aliases` 只入 PUBLIC（REFERENCE 标签不含列表）

### 1.2 loginKeyResolver 新建

3 个公开函数，全是纯函数（DB IO 通过 `deps.User` 注入）：

- `resolveLoginKey(input, deps)` — 解析 login key（username → email → alias）
- `normalizeAliases(list)` — 字符串数组去重 / 字符集 / 长度校验
- `findAliasConflicts(candidates, deps)` — 跨账号唯一性校验（拉表过滤；用户量大了再优化为 JSON_CONTAINS）

### 1.3 aio backend /api/auth/register + /login

- `/register`：
  - 接受 `aliases: string[]`
  - `normalizeAliases` 校验 + 拒绝与 username/email 重复
  - `findAliasConflicts` 检查跨账号唯一
  - 唯一冲突返回 **409**，alias 字符集违规返回 **400**，username/email 占用返回 **409**
- `/login`：
  - `username` 字段语义化为「login key」
  - `resolveLoginKey` 命中后 bcrypt 比对，签发 JWT
  - 响应里附 `matchedBy: 'username' | 'email' | 'alias'`（便于排查）

### 1.4 credentialGenerator.ensureDefaultAdminPassword

```text
loadOrCreateDefaultAdminCredentials() → 拿到 username + 明文密码
  ↓
findOne({ username }) → 取 aio backend User.admin
  ↓
comparePassword(明文) → true  → ok:true, updated:false
                  → false → user.password = 明文; user.save() → ok:true, updated:true
  ↓
数据库不可用 / 找不到用户 / bcrypt 写入失败 → ok:false, reason
```

- 完全幂等：bcrypt 校验已通过就立刻返回
- 完全 fail-soft：任何一步失败返回 `{ ok: false, reason }`，调用方不抛
- 启动期由 `cliAuthService._loadBuiltinAccounts()` 异步触发（fire-and-forget，不阻塞 CLI 启动）

### 1.5 cliAuthService 改动

- `_loadBuiltinAccounts`：首次调用时 fire-and-forget 触发 `ensureDefaultAdminPassword`；更新成功会在 stderr 打印一行
- `_loadCredentials`：脏值软校验（`aliases` 非数组 → 落到 `[]`）
- `register(username, password, email, securityQuestion, securityAnswer, aliases)`：第 6 参 `aliases`，透传 aio backend register；同时镜像到 credentials.json
- `login`：本机兜底路径按 `username / email / aliases` 任一查找；返回值增加 `matchedBy` 字段

### 1.6 App.js runAuthForm

register 表单新增第 5 个字段：

```text
别名 (可选，逗号分隔;用于局域网/别机登录):
```

不填 = 不使用别名。客户端校验 1-8 个 + 单个 ≤32 字符；字符集精确校验交给后端。

### 1.7 serviceDefaults.AI_MGMT_HOST

新增常量：

```text
const AI_MGMT_HOST = process.env.AI_MGMT_HOST || '0.0.0.0';
```

默认 `0.0.0.0`（与 Node `app.listen(port)` 默认行为一致）；env 收紧到 `127.0.0.1` 可回退到仅本机。

### 1.8 ai-backend server.js listen

```js
let AI_MGMT_HOST = '0.0.0.0';
try {
  const { AI_MGMT_HOST: hostFromDefaults } = require('./src/constants/serviceDefaults');
  if (typeof hostFromDefaults === 'string' && hostFromDefaults.length > 0) {
    AI_MGMT_HOST = hostFromDefaults;
  }
} catch { /* serviceDefaults 加载失败时退回硬编码默认 */ }
if (process.env.AI_MGMT_HOST && process.env.AI_MGMT_HOST.length > 0) {
  AI_MGMT_HOST = process.env.AI_MGMT_HOST;
}
...
const server = app.listen(PORT, AI_MGMT_HOST, () => { ... });
```

启动横幅在绑 0.0.0.0 时多打一行「LAN: 9090/tcp 放行后，其他机器可 http://<本机IP>:9090/api/auth/login」，把端口暴露事实告知用户。

### 1.9 文档

- [DESIGN-ARCH-074] 详细设计（why / 数据契约 / 行为契约 / 文件清单 / 兼容性 / 验收）
- [LAN-FIREWALL.md] 防火墙放行命令（Windows `New-NetFirewallRule` / macOS `socketfilterfw` & `pfctl` / Linux `ufw`/`firewalld`/`iptables`）

---

## 2. 验收记录

### 2.1 CI 全绿

```text
[✓] node scripts/ci/check-agent-rules.js    8 文件零违规
[✓] node scripts/ci/check-version-sync.js   4+2 版本轨道一致
[✓] node scripts/ci/check-gov-rules.js      GOV-MOD-004 / GOV-TOOL-004 / 005 通过
[✓] node scripts/ci/check-repo-layout.js    无结构发现（074 + LAN-FIREWALL 索引齐全）
[✓] node --check <8 个代码文件>             零语法错误
```

### 2.2 模块加载

```text
[✓] cliAuthService.js      loaded; exports 16 个公开 API
[✓] credentialGenerator.js loaded; ensureDefaultAdminPassword = function
[✓] loginKeyResolver.js   loaded; exports normalizeAliases / resolveLoginKey / findAliasConflicts
[✓] serviceDefaults.js    AI_MGMT_HOST = '0.0.0.0'
```

### 2.3 行为正确性

```text
[✓] normalizeAliases(['  Foo  ', 'foo', 'bar@x.com', '', 'has space', 'good_name'])
      → ['Foo','bar@x.com','good_name'] (去重 / 大小写不敏感 / 空串拒绝 / 含空格拒绝)
[✓] resolveLoginKey('alice')    → matchedBy = 'username'
[✓] resolveLoginKey('alice@x.com') → matchedBy = 'email'
[✓] resolveLoginKey('ali')      → matchedBy = 'alias'（真 User 模型下）
```

### 2.4 jest 单元测试

```text
PASS tests/auth.sessionSecurityRoutes.test.js          3/3
PASS tests/services/authSessionService.test.js
PASS tests/services/authPolicy.test.js
PASS tests/security/authGuard.exports.test.js
PASS tests/routes/auth.sessions.test.js
33/33 passed, 0 failed
```

### 2.5 现场端到端（推荐手动复测）

```powershell
# 1) 验证 banner 与 whoami 一致
khy whoami
# 进 REPL → 顶部 banner 「欢迎你，<whoami 用户名>」

# 2) 验证默认账号密码补齐
Remove-Item "$env:USERPROFILE\.khy\credentials\default-admin.json" -ErrorAction SilentlyContinue
# 重启 ai-backend / khy
# 期望 stderr: [cliAuthService] 默认管理员密码已在数据库中更新为新随机密码
# 期望 .khy/credentials/default-admin.json 重新生成
# 期望 /api/auth/login 用 default-admin.json 里的密码能登入

# 3) 验证 alias 跨账号唯一性
# 在 A 机 /register --as 别名1
# 在 B 机 /register --as 别名1
# 期望 B 报「alias 已被其他账号占用」

# 4) 验证 LAN 登录（他机）
netstat -ano | Select-String ":9090\s+.*LISTENING"   # 应看到 0.0.0.0:9090
# （防火墙规则参考 LAN-FIREWALL.md）
curl http://<A机IP>:9090/api/health                   # 200
curl -X POST http://<A机IP>:9090/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"<A机账号>","password":"<密码>"}'  # 200 + token
```

---

## 3. 已知限制 / 留给后续

- **`displayName` 渲染**：banner 仍按 username 显示；切到 `displayName` 走 `KHY_BANNER_USE_DISPLAY_NAME` 门控（默认关）。
- **`aliases` 唯一性**：当前 `findAliasConflicts` 把整张 users 表拉回内存过滤；用户表大时改 `JSON_CONTAINS` / PG `@>` 等原生查询。
- **`alias` 类型细分**（email / nickname）：本设计把 email 视作 alias 特例。后续如需 `alias.type` 字段，按 user/email/nickname 三类路由。
- **OAuth / SAML / LDAP**：本文不做，留作 [DESIGN-ARCH-074] §7「不做」清单。
- **HTTPS**：LAN-FIREWALL.md 不配 HTTPS；公网部署请走反向代理 + [DEPLOY-MAN-016]。
- **WebAuthn**：User 模型已有 webauthn_* 字段，本设计不动。

---

## 4. 引用关系

- 设计：[DESIGN-ARCH-074]
- 横幅修复：[IMPL-RPT-043] 任务列表截断修复（无关）→ 后续会加 [IMPL-RPT-NNN] khyos 启动横幅与登录账号对齐（本次上一轮独立修复）
- 配套部署文档：[LAN-FIREWALL.md]
- 单一真源：
  - 鉴权路由：`services/ai-backend/src/routes/auth.js`
  - 本机鉴权：`services/backend/src/services/cliAuthService.js`
  - User 模型：`platform/packages/shared/src/models/User.js`
  - 默认账号密码：`services/backend/src/services/credentialGenerator.js`
  - 服务启服：`services/ai-backend/server.js`
  - 服务默认值：`services/backend/src/constants/serviceDefaults.js`