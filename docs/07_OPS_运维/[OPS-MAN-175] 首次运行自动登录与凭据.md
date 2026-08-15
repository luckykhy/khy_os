<!-- 文档分类: OPS-MAN-175 | 阶段: 运维 | 原路径: 新建（根目录 6 份会话日志合并归档） -->
# 首次运行自动登录与凭据

> 第一次敲 `khy` 时不需要先注册账号：CLI 会用**当前操作系统用户名**派生一个机器本地管理员，生成随机密码落到数据家的凭据文件，然后自己登录进去。本文讲这条链路每一步实际做了什么、凭据存在哪、哪些环境变量能改它的行为、以及跨机器复制项目后要做什么。
>
> **归档来源**：本文由根目录 6 份一次性会话记录合并而成（归档日期 2026-08-15）：`AUTO_LOGIN_ENABLED.md`、`FIXED_AUTO_LOGIN.md`、`FINAL_AUTO_LOGIN_COMPLETE.md`、`FINAL_AUTO_LOGIN_GUIDE.md`、`PASSWORD_AUTO_FILL.md`、`CLI_AUTO_USERNAME.md`。原文带具体机器路径与用户名，且互相矛盾（其中一份提出的 `KHY_CLI_SKIP_AUTH` 从未实现，见第五节），本文按**代码实测**重写，不保留原文表述。
>
> 实现依据（核实来源）：
> - CLI 登录流程：`services/backend/bin/khy.js`（`ensureAuthenticated` 一带）
> - 凭据生成与持久化的唯一真源：`services/backend/src/services/credentialGenerator.js`
> - 凭据文件落盘位置解析：`services/backend/src/utils/dataHome.js`
> - 服务端播种路径：`services/backend/scripts/seed.js`、`src/services/manageDbBootstrap.js`
> - Web 端登录页预填：`services/ai-backend/src/routes/auth.js`

---

## 一、首次运行发生了什么

```
khy
  │
  ├─0 凭据文件已存在？ → 读出来直接登录（2 秒超时），成功即进 CLI
  │
  ├─1 打印登录提示，并给出凭据文件的**路径**（不打印明文密码）
  │
  ├─2 第一次尝试（且 KHY_CLI_AUTO_LOGIN ≠ 0）：
  │     ├─ 探测系统用户名 → 规范化为合法用户名
  │     ├─ 凭据文件存在且用户名对得上 → 取其中密码
  │     ├─ 凭据文件不存在        → 现场生成并落盘（loadOrCreateDefaultAdminCredentials）
  │     ├─ 仍拿不到密码           → 退到环境变量 KHY_DEFAULT_PASSWORD
  │     ├─ 登录 → 成功即进 CLI
  │     └─ 登录返回「用户不存在」 → 自动注册（10 秒超时）→ 成功即进 CLI
  │
  └─3 上面都没成 → 交互式登录表单，用户名已预填系统用户名，只需输密码
        └─ 非交互环境（管道 / CI）没有表单可填 → 报错退出（exit 1）
```

**用户名怎么来的**：`os.userInfo().username`，回退 `%USERNAME%`（Windows）/ `$USER`（Linux/macOS），然后转小写并剔除 `[a-z0-9_-]` 之外的字符。所以换一台机器会自动得到那台机器的用户名，不用改配置。

**密码怎么来的**：`credentialGenerator.js` 用机器指纹材料（主机名、设备 id）混 `crypto.randomBytes` 熵，生成约 16 位混合字符集密码。**不存在跨机器可预测的固定默认密码**，也没有 `admin/admin123` 这类硬编码残留。

**为什么后端没起也能登进去**：生成的默认管理员是**本地**凭据，CLI 不需要后端在跑就能认它。后端未运行时 CLI 会提示这一点。但注册新用户、Web 界面等需要后端的能力仍然要先启动后端。

---

## 二、凭据文件

| 项 | 值 |
| --- | --- |
| 文件名 | `default-admin.json` |
| 目录 | `<数据家>/credentials/`（便携部署落在便携根的 `.khy/credentials/`） |
| 内容 | 用户名 + **明文**密码（数据库里存的始终只是 bcrypt 哈希） |
| 权限 | 尽力 `chmod 0600`；Windows 上设置失败会被忽略 |
| 幂等性 | 文件已存在就**永不重新生成、永不覆盖** |

**数据家（data home）怎么解析**：真源是 `services/backend/src/utils/dataHome.js`，按序为 ① 环境变量 `KHY_DATA_HOME` ② `~/.khy/.location.json` 记录的钉住位置 ③ 已有非空的 `~/.khy` 原地钉死 ④ 全新安装选剩余空间最大的**非系统盘** ⑤ 兜底 `~/.khy`。所以凭据文件的绝对路径**因机器而异**，本文刻意不写死某个盘符——要看自己这台机器的实际路径，跑：

```bash
node -e "console.log(require('./services/backend/src/services/credentialGenerator').getDefaultAdminCredentialsPath())"
```

CLI 在登录提示里也会打印这个路径。

> ⚠️ 这个文件里是**明文密码**。它属于机器本地凭据，不要复制到别的机器、不要进版本库（`.khy/` 已在 `.gitignore` 内）、不要贴进 issue 或聊天记录。换机器时的正确做法是让新机器自己生成一份（第四节）。

---

## 三、想跳过自动登录 / 换掉生成的密码

```powershell
# 关掉自动登录，每次手动输（用户名仍会预填）
$env:KHY_CLI_AUTO_LOGIN = "0"

# 指定 CLI 自动登录用的密码（不写凭据文件）
$env:KHY_DEFAULT_PASSWORD = "<密码>"

# 指定默认管理员的用户名 / 密码（纯环境变量模式：不落盘、调用方不打印）
$env:KHY_ADMIN_USERNAME = "<用户名>"
$env:KHY_ADMIN_PASSWORD = "<密码>"

# 把数据家（连带凭据目录）指到别处
$env:KHY_DATA_HOME = "<目录>"
```

Linux/macOS 用 `export KHY_CLI_AUTO_LOGIN=0` 等价形式。

| 变量 | 作用域 | 说明 |
| --- | --- | --- |
| `KHY_CLI_AUTO_LOGIN` | CLI | 置 `0` 关闭首次尝试的自动登录；其余值等同开启 |
| `KHY_DEFAULT_PASSWORD` | CLI | 凭据文件取不到密码时的回退来源 |
| `KHY_ADMIN_USERNAME` | 凭据生成 | 覆盖「用系统用户名」的默认行为 |
| `KHY_ADMIN_PASSWORD` | 凭据生成 | 纯环境变量模式，**不写凭据文件** |
| `DEFAULT_ADMIN_PASSWORD` | 凭据生成 | `KHY_ADMIN_PASSWORD` 的历史别名 |
| `KHY_DATA_HOME` | 全局 | 显式指定数据家，凭据目录随之移动 |

> 红线：真密码只经环境变量瞬时注入，**绝不写进源码、配置模板或提交**。上表里的变量用于本机会话，不要固化到仓库文件里。

---

## 四、跨机器复制项目后

1. **配置全局 `khy` 命令**：`portable-setup.bat`（Windows）/ `portable-setup.sh`
2. **直接跑 `khy`**：用户名按新机器的系统用户自动探测，凭据在本机现场生成——**不需要**先跑任何 setup 脚本
3. 需要完整能力（Web 界面、注册新用户、数据库）时再启动后端：`npm run dev --workspace services/backend`

如果想在启动 CLI 之前就把管理员账号播种进数据库（例如要立刻用 Web 界面登录），跑 `scripts/setup/first-time-setup.bat`，它等价于 `node services/backend/scripts/quick-setup.js`；失败时的兜底是 `npm run seed --workspace services/backend`。

---

## 五、故障排查

| 症状 | 原因 | 处理 |
| --- | --- | --- |
| 一直弹登录表单，不自动登录 | 凭据文件不存在且现场生成失败（多为数据家不可写） | 看 CLI 打印的错误行；用 `KHY_DATA_HOME` 指到可写目录 |
| 「用户不存在，正在自动注册…」后失败 | 注册需要后端，后端未运行 | 先起后端；或用本地默认管理员（凭据文件那份）登录 |
| 凭据文件里的密码登不进去 | 数据库里的账号是另一套凭据（例如被 `reset-admin-password` 改过） | `node services/ai-backend/scripts/reset-admin-password.js --password <新密码>` |
| 想重新生成凭据 | 生成是幂等的，文件在就不会重来 | 删掉 `<数据家>/credentials/default-admin.json` 再跑 `khy` |
| 非交互环境下报「自动登录失败且非交互模式」 | 管道/CI 里没有表单可填 | 预先设 `KHY_DEFAULT_PASSWORD`，或先在交互终端里跑一次让凭据落盘 |

**`KHY_CLI_SKIP_AUTH` 不存在**。归档来源里有一份文档把它写成「跳过认证模式」的开关，全仓检索确认代码中**从无此变量**——设它不会有任何效果。要免输密码请用第三节的自动登录链路。

---

## 关联

- 访问与登录（Web 侧）：`[OPS-MAN-003] ai-管理-访问与登录`
- 快速开始：`[OPS-MAN-027] 快速开始`
- 便携版部署：`docs/06_DEPLOY_部署/PORTABLE.md`
- 环境开关命名规范：`[OPS-MAN-058] 环境开关与文档命名规范`
- 一次性脚本的位置约定：`docs/03_DESIGN_设计/[DESIGN-ARCH-068] 仓库层级板块规范`
