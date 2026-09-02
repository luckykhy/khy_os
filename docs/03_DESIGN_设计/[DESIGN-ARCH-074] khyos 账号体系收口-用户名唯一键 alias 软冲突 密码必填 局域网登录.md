# [DESIGN-ARCH-074] khy-os 账号体系收口 — 用户名为唯一键 + alias 软冲突 + 密码必填 + 局域网登录

> **定位**：把 khy-os 的"账号"语义统一为「**用户名**」(用户名=账号)，允许 alias 软冲突，强制密码存在，
> 并把 ai-backend 的 `/api/auth/login` 端点对齐到「局域网可登录」。本文是该改造的唯一真源。
> **适用边界**：仅描述账号体系的登录键、alias、密码、LAN 暴露四个变更点的运行时契约；
> 仓库层级见 `[DESIGN-ARCH-068]`，通道选择见 `[DESIGN-ARCH-071]`，核任务循环见 `[DESIGN-ARCH-073]`。
> **代码锚点**：`platform/packages/shared/src/models/User.js`（User 单一真源）、
> `services/backend/src/services/cliAuthService.js`（本机 CLI 鉴权）、
> `services/ai-backend/src/routes/auth.js`（aio 后端鉴权路由）、
> `services/ai-backend/server.js`（aio 后端启服）。
> **承接需求**：用户反馈 "khyos 欢迎语和登录账号不对"（已修复，参见 `[IMPL-RPT-NNN] khyos
> 启动横幅与登录账号对齐`），并在此基础上对账号体系做四项收口。

---

## 0. 设计总览（why + what）

```text
       ┌──── 改动 1 ────┐    ┌──── 改动 2 ────┐    ┌──── 改动 3 ────┐    ┌──── 改动 4 ────┐
       │  账号=用户名   │    │ alias 软冲突  │    │  密码必填      │    │ 局域网可登录   │
       │  (User.username)   │ (User.aliases  │    │ (default-admin │    │ (ai-backend 绑│
       │  是唯一键)        │  全局唯一)      │    │  也设密码)     │    │  0.0.0.0)    │
       └────────┬─────────┘    └────────┬──────┘    └────────┬──────┘    └────────┬─────┘
                │                       │                    │                    │
                ▼                       ▼                    ▼                    ▼
       ┌────────────────────────────────────────────────────────────────────────────────┐
       │  /api/auth/login · /khy login ·  /khy register · /khy whoami · 横幅用户名   │
       │                                                                                │
       │  共同口径：User.username 是唯一键；aliases 是登录别名集合；password 必填；     │
       │  LAN 上 /api/auth/login 接受 username 或任一 alias，bcrypt 校验后签发 JWT。   │
       └────────────────────────────────────────────────────────────────────────────────┘
```

**不动的事项**（保持兼容）：
- **不**做密码找回链路变更（已有的密保问题 / 邮箱验证码链路继续生效）。
- **不**改 khyos 子命令路由表。
- **不**做"重命名 username"功能——username 一旦写入不可改。
- **不**做"OAuth / SAML / LDAP"接入——本文只做本机密码登录 + LAN 暴露。

---

## 1. 语义对齐（before / after）

| 维度 | 现状 (before) | 设计后 (after) |
|---|---|---|
| 唯一键 | `User.username` 唯一（已 unique: true） | 同左，不变 |
| 别名 | 没有任何别名机制；CLI 只能按字面 username 登录 | 新增 `User.aliases: string[]`，**全局唯一**；登录键 = `username ∪ aliases` |
| 邮件登录 | `/api/auth/login` 已支持 `Op.or [{username}, {email: username}]`（auth.js:51-53） | 同左，**保持**；`email` 视作 alias 的特例 |
| 密码 | `default-admin` 默认无密码（`credentialGenerator.js` 静默生成） | 强制设密码：首次启动若 default-admin 无密码，自动补随机密码并显式提示用户 |
| CLI 默认账号 | `default-admin` 静默登录（CLI_BUILTIN_ACCOUNTS 或 default-admin.json） | 保留；密码补齐后 CLI 静默登录仍可用；首次 CLI 启动打印一行告知随机密码所在路径 |
| LAN 暴露 | `app.listen(PORT)` 不传 host（Node 默认绑 0.0.0.0），但 .env 文档没说 | 显式 `app.listen(PORT, AI_MGMT_HOST)`；`AI_MGMT_HOST` 默认 `0.0.0.0`；同时补 `LAN-FIREWALL.md` 说明 Windows/macOS 防火墙放行 |
| /api/auth/login | 接受 `username` 或 `email` | 接受 `username`、任意 `alias`、`email`（统一为「login key」语义） |
| banner 显示 | 修了：用 `cliAuth.checkSession().username` | 同左，banner 与 whoami 真源同口径 |

---

## 2. 数据契约

### 2.1 User 模型（`platform/packages/shared/src/models/User.js`）

新增字段：

```text
aliases     DataTypes.JSON     default: []    comment: '登录别名集合（不含 username/email）。全局唯一。'
displayName DataTypes.STRING(80)  nullable  comment: '昵称，仅展示用，不参与登录。'
```

约束：
- `aliases` 数组内元素去重、长度 1..32、字符集 `[a-zA-Z0-9_.\-@]`，与 username 同。
- 唯一性约束**应用层**保证（hook + 服务层校验），不靠数据库 unique index（JSON 字段的 unique 在各 DB 引擎上不统一）。
- `username` 字段保持 `unique: true`（数据库层）。

**Sequelize 模型同步**：新字段不带 `field` 映射，列名 = 字段名；migration 在首次启动时由 `sequelize.sync({ alter: true })` 触发（既有的同步策略）。

### 2.2 本机 credentials.json（`~/.khyquant/credentials.json`）

新增字段：

```text
aliases     string[]    // 与 User.aliases 镜像；离线登录仍按 username/alias 查找
```

约束：
- 与 User.aliases 同口径（去重、字符集、长度）。
- `_loadCredentials()` 在读出时做软校验：丢弃非数组 / 元素非字符串的脏值，落到 `[]`。
- `_saveCredentials()` 写回时合并现有 username、email、aliases（保证 username 始终在查找集合内）。

### 2.3 session.json（`~/.khyquant/session.json`）

**不**新增字段；保留 `username`（不变）+ `expiresAt`（既有）。

---

## 3. 行为契约

### 3.1 登录键解析

`resolveLoginKey(input)` 是新的纯叶子，统一三处入口（aio backend、CLI、本机 credentials）：

```text
输入：任意字符串
行为：
  1. trim + lower-case
  2. 先按 User.username 精确匹配 → 命中即返回 user 对象
  3. 否则按 User.email 精确匹配 → 命中即返回 user 对象
  4. 否则按 User.aliases 数组内任一元素精确匹配 → 命中即返回 user 对象
  5. 全未命中 → 返回 { user: null }
```

实现位置：
- 服务端：`services/ai-backend/src/services/loginKeyResolver.js`（新）+ 在 `routes/auth.js` 的 `/login`、`/register` 引用
- 本机：`services/backend/src/services/cliAuthService.js` 内部 `_findLocalUserByLoginKey()`（新）

### 3.2 Register 路径

- `aio backend /api/auth/register`：保留原 `username + email + password`；可选 `aliases: string[]`，后端去重 + 跨账号唯一校验
- CLI `/register`：`runAuthForm` 表单增加可选字段「别名（逗号分隔）」；不填则 `aliases = []`
- 默认账号迁移：`credentialGenerator` 检测 default-admin 无密码时**不阻塞启动**，但下次 `khy login` 之前会跑一次"补密码"动作（见 §3.5）

### 3.3 Login 路径

- 服务端：`POST /api/auth/login` 把 `username` 字段语义化为「login key」，走 `resolveLoginKey`
- 本机 CLI：先匹配内置账号（既有 `_loadBuiltinAccounts()`），否则 `resolveLoginKey`-style 在 credentials.json 找

### 3.4 whoami / banner

- `getCurrentUser()` 增加 `aliases` 字段透传（来自 credentials.json 字段或 DB 同步）
- banner 已修：用 `cliAuth.checkSession().username`，与 whoami 一致
- 后续若 `displayName` 落地，banner 优先显示 displayName（仅当 `KHY_BANNER_USE_DISPLAY_NAME` 门打开，默认关）

### 3.5 默认账号密码补齐（迁移）

触发时机：
1. 启动期：aio backend `User.findOne({ role:'admin' })` 检测 default-admin 无 password（即 bcrypt 哈希的特定格式校验失败，视为空），自动生成 16 字符随机密码、bcrypt 后写回 DB、把明文密码写到 `.khy/credentials/default-admin.json`（已有路径）
2. 启动期：CLI `cliAuthService` 读 `.khy/credentials/default-admin.json`，若 password 字段是占位 `<random>` 标记，则同样补齐（**幂等**：写过的不会再覆盖）

不做的事：
- **不**强制 default-admin 改密码；首次出现随机密码时打 `console.log`（带明文）一次，仅此一次，用户自己决定是否改
- **不**改 username 字段
- **不**触动 email 字段

代码锚点（实施时落地）：
- `services/backend/src/services/credentialGenerator.js` 加 `_ensureDefaultAdminPassword(user)` 纯函数
- `services/backend/src/services/cliAuthService.js` 的 `_loadBuiltinAccounts()` 调用前先跑 `_ensureDefaultAdminPassword()`

### 3.6 LAN 暴露

- `services/ai-backend/server.js` 改 `app.listen(PORT, AI_MGMT_HOST)`
- `AI_MGMT_HOST` 走 `serviceDefaults.js` 单一真源：`process.env.AI_MGMT_HOST || '0.0.0.0'`
- **不**改 CORS 默认（保留 `'*'` 以满足 LAN）；若用户希望收紧，写 `AI_MGMT_CORS_ORIGINS`
- 新文档 `docs/06_DEPLOY_部署/LAN-FIREWALL.md`（Windows 防火墙 PowerShell + macOS `pfctl` 两条命令）

---

## 4. 文件改动清单（实施时按此顺序）

| # | 文件 | 改动 | 风险 |
|---|---|---|---|
| 1 | `platform/packages/shared/src/models/User.js` | 加 `aliases` JSON 字段 + `displayName` STRING 字段 | 低（purely additive） |
| 2 | `services/ai-backend/src/services/loginKeyResolver.js` | 新增；纯函数 `resolveLoginKey(input, models)` | 无（新建） |
| 3 | `services/ai-backend/src/routes/auth.js` | `/login` 改走 `resolveLoginKey`；`/register` 加 aliases 接收 + 跨账号唯一校验 | 中（鉴权路径） |
| 4 | `services/backend/src/services/credentialGenerator.js` | 加 `_ensureDefaultAdminPassword()` 纯函数 | 低 |
| 5 | `services/backend/src/services/cliAuthService.js` | `_loadBuiltinAccounts` 调用前补密码；`login()` 按 login key 查找本地 credentials；credentials.json 写回合并 aliases | 中（鉴权路径） |
| 6 | `services/backend/src/cli/tui/ink-components/App.js` | runAuthForm 表单加 alias 字段；register 成功后清 banner 冻结 ref（已有） | 低 |
| 7 | `services/backend/src/constants/serviceDefaults.js` | 加 `AI_MGMT_HOST` 默认 `'0.0.0.0'` | 极低 |
| 8 | `services/ai-backend/server.js` | `app.listen(PORT, AI_MGMT_HOST)` | 中（网络可达性） |
| 9 | `docs/06_DEPLOY_部署/LAN-FIREWALL.md` | 新增；Windows / macOS 防火墙放行说明 | 无（文档） |
| 10 | `docs/04_IMPL_实现/[IMPL-RPT-NNN] khyos 账号体系收口.md` | 新增；实施记录 | 无（文档） |

---

## 5. 兼容性 / 回滚

**前向兼容**（老 users）：
- 老 credentials.json（无 `aliases` 字段）→ `_loadCredentials()` 软校验落到 `[]`，行为不变
- 老 aio backend（无 `aliases` 列）→ `sequelize.sync({ alter: true })` 启动时加列；列默认 `[]`，不影响登录

**回滚**：
- 改动 1-2、5-7 都是 purely additive（仅加字段 / 加分支）；回滚 = 去掉新分支
- 改动 3（routes/auth.js）有原 `/login` 备份，git revert 即可
- 改动 8（server.js listen host）若 LAN 有问题，回滚到不传 host（Node 默认 0.0.0.0）

**老默认账号迁移**：
- 迁移幂等：写过的 default-admin.json 不会再次被覆盖
- 若用户删除 default-admin.json 后重启，会重新生成新的随机密码（这是预期行为）

---

## 6. 验收（必跑）

### 6.1 单元层

```text
[ ] loginKeyResolver:  username/email/alias/不存在 四种输入的解析正确
[ ] credentialGenerator:  default-admin 首次补密码幂等
[ ] cliAuthService:  本机按 alias 命中 credentials.json
[ ] User.js 模型:  aliases / displayName 字段能 save + load roundtrip
```

### 6.2 集成层

```text
[ ] aio backend /api/auth/login:  username 命中；alias 命中；email 命中；都未命中 401
[ ] aio backend /api/auth/register:  alias 跨账号重复时 400
[ ] aio backend /api/auth/login:  默认账号密码已补齐后能登录
[ ] khy whoami:  username 与 banner 一致
[ ] khy logout / login newUser:  banner 立即刷新（清冻结 ref）
```

### 6.3 网络层

```text
[ ] ai-backend listen 0.0.0.0 (Node 默认):  netstat -ano | findstr :9090  看到 0.0.0.0:9090
[ ] 同局域网他机 curl http://<本机IP>:9090/api/health  → 200 ok
[ ] 防火墙未放行时 curl 返回 timeout（符合预期；需走 LAN-FIREWALL.md）
[ ] 防火墙放行后 curl http://<本机IP>:9090/api/auth/login  → 401 (wrong password) 而非 403/超时
```

### 6.4 体检脚本

```text
[ ] node scripts/ci/check-agent-rules.js  全绿
[ ] node scripts/ci/check-version-sync.js  全绿
[ ] node scripts/ci/check-gov-rules.js     全绿
[ ] node scripts/ci/check-repo-layout.js   全绿
[ ] node --check 改过的所有 .js / .ts      零错
```

### 6.5 文档同步

```text
[ ] docs/00_INDEX 或 docs/03_DESIGN_设计/00_INDEX_设计-分类索引.md 加 ARCH-074 索引
[ ] AGENTS.md 顶级「版本同步」「配置文件位置」节加 aliases/displayName 字段说明（如必要）
[ ] docs/06_DEPLOY_部署/LAN-FIREWALL.md 与本设计互相引用
```

---

## 7. 已知风险 / 不做

| 项 | 状态 |
|---|---|
| OAuth / SAML / LDAP | 不做，留给后续 |
| 密码找回链路（密保、邮箱验证码、手机） | 不动 |
| 跨服务（trading backend 与 ai-backend）的 session 互通 | 既已共享 User + JWT，继续保持；不在本文范围 |
| WebAuthn 字段 | 不动 |
| 横幅 displayName 渲染 | 门控关，不在本次落地 |
| alias 类型细分（email/nickname） | 本设计只把 email 视作 alias 特例；细分留作未来扩展 |
| session.json 写回包含 alias 列表 | 不做（session 只放 username；alias 是账号属性，不是会话属性） |

---

## 8. 关联文档

- 横幅修复：[IMPL-RPT-NNN] khyos 启动横幅与登录账号对齐（待创建）
- 实施记录：[IMPL-RPT-NNN] khyos 账号体系收口（待创建）
- 启服入口：`services/ai-backend/server.js`
- 鉴权路由：`services/ai-backend/src/routes/auth.js`
- 本机鉴权：`services/backend/src/services/cliAuthService.js`
- User 模型：`platform/packages/shared/src/models/User.js`
- 防火墙：`docs/06_DEPLOY_部署/LAN-FIREWALL.md`（待创建）