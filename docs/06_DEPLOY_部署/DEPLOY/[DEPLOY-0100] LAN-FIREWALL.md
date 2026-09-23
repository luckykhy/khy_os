# LAN-FIREWALL — 局域网登录防火墙放行

> **ARCH-074 配套文档**：ai-backend 在 `[DESIGN-ARCH-074]` 设计下默认绑 `0.0.0.0`，
> 让局域网（LAN）上其他机器可用「账号 + 密码」通过 `http://<本机IP>:9090/api/auth/login` 登录。
> 但 **操作系统防火墙** 默认会拦截入站连接，本文件给出 Windows / macOS 两条放行命令。
>
> **不打通**也能用：仅在本机（127.0.0.1）登录 ai-backend 时无需任何防火墙配置，
> 这是大多数用户场景。需要 LAN 访问时按本文操作。
>
> **安全注意**：放行后 `ai-backend` 的 `/api/auth/login`、`/api/health`、`/api/ai-gateway/status`
> 等公开端点对 LAN 可见；鉴权强依赖 bcrypt + JWT 校验，**不要**在没有 HTTPS 的情况下把
> 本机暴露到公网；本文所有命令只针对 **受信局域网**（家用 / 公司内网）。

---

## 1. 确认 ai-backend 监听状态

无论是否放行防火墙，先确认 ai-backend 是否真的在 `0.0.0.0` 上监听。

**Windows（PowerShell）**：

```powershell
netstat -ano | Select-String ":9090\s+.*LISTENING"
# 期望看到：  TCP    0.0.0.0:9090    0.0.0.0:0    LISTENING    <pid>
# 若看到  127.0.0.1:9090  → AI_MGMT_HOST 被收紧到 127.0.0.1，LAN 不会通，先 unset 环境变量
```

**macOS / Linux**：

```bash
lsof -nP -iTCP:9090 -sTCP:LISTEN
# 期望 NAME 列含 node，ADDRESS 列是 *:9090（=0.0.0.0:9090）
```

如果监听地址是 `127.0.0.1` / `[::1]`：

```bash
# 检查环境变量
echo "AI_MGMT_HOST=$AI_MGMT_HOST"
# 临时覆盖（一次性）
AI_MGMT_HOST=0.0.0.0 node server.js
# 永久写入 .env
echo "AI_MGMT_HOST=0.0.0.0" >> services/ai-backend/.env
```

---

## 2. Windows 防火墙（管理员 PowerShell）

> Windows 自带防火墙默认阻止入站连接。khy-os 的 ai-backend 端口（默认 **9090**）需要
> 新增一条入站规则。

```powershell
# 一次性放行（推荐「新建规则向导」控制台）
New-NetFirewallRule -DisplayName "khy-os ai-backend (LAN 9090)" `
  -Direction Inbound `
  -Protocol TCP `
  -LocalPort 9090 `
  -Action Allow `
  -Profile Private,Domain `
  -RemoteAddress LocalSubnet
```

参数说明：
- `-Profile Private,Domain` —— **只**对家庭 / 公司内网生效，**不**对 Public（咖啡馆 / 机场 WiFi）放行，避免外出时把本机暴露到公网。
- `-RemoteAddress LocalSubnet` —— 进一步收紧到「本机所在子网」（如 192.168.1.0/24）。
  需要给某台固定设备（如 NAS）开例外，可写 `-RemoteAddress 192.168.1.50`。
- **不要**省略 `-Profile` 默认值；不写就三种网络（Private / Domain / Public）全放行，公网可见。

如需删除规则：

```powershell
Remove-NetFirewallRule -DisplayName "khy-os ai-backend (LAN 9090)"
```

---

## 3. macOS 防火墙（系统设置 / `pfctl`）

macOS 默认开启「应用级防火墙」（系统设置 → 网络 → 防火墙）。`pfctl` 是底层包过滤，
桌面端用「系统设置」更直观。

### 3.1 桌面 GUI（推荐）

1. 系统设置 → 网络 → 防火墙 → 点 🔒 解锁 → 选项…
2. 「自动允许内置软件接受传入连接」已开启 → **无需再放行** node 二进制。
3. 若防火墙开启但 node 仍被拦截，在「允许下列应用接受传入连接」里把 node 添加进去。

### 3.2 命令行（`pfctl`，需要 root）

macOS 自带 `socketfilterfw` / `pfctl` 两个 CLI：

```bash
# 临时放行 9090/TCP（重启失效）
sudo /usr/libexec/ApplicationFirewall/socketfilterfw --add /usr/local/bin/node
sudo /usr/libexec/ApplicationFirewall/socketfilterfw --unblock /usr/local/bin/node

# 永久：编辑 /etc/pf.conf 加一行
sudo tee -a /etc/pf.conf > /dev/null <<'EOF'
# khy-os ai-backend (LAN only)
pass in proto tcp from 192.168.0.0/16 to any port 9090
EOF
sudo pfctl -f /etc/pf.conf
```

`192.168.0.0/16` 是家用路由器默认网段；公司网段按需调整（如 `10.0.0.0/8`）。
**不要**写 `from any to any port 9090` ——这等于把本机 9090 暴露到公网。

---

## 4. Linux（iptables / nftables / firewalld）

按发行版三选一：

```bash
# Debian/Ubuntu (ufw)
sudo ufw allow from 192.168.0.0/16 to any port 9090 proto tcp

# RHEL/Fedora (firewalld)
sudo firewall-cmd --permanent --zone=trusted --add-port=9090/tcp
sudo firewall-cmd --reload

# 通用 iptables
sudo iptables -A INPUT -p tcp --dport 9090 -s 192.168.0.0/16 -j ACCEPT
```

把 `192.168.0.0/16` 换成你的实际 LAN 网段。

---

## 5. 验证

在本机（127.0.0.1）测：

```bash
curl -i http://127.0.0.1:9090/api/health
# 期望 200 {"status":"ok",...}
```

在同 LAN 上 **另一台机器** 测（把 `<host>` 换成 ai-backend 所在机器的内网 IP）：

```powershell
# Windows / Linux / macOS 通用
curl -i http://<host>:9090/api/health
```

如果返回 `Connection timed out`：
- 检查 ai-backend 是否真的在 `0.0.0.0` 监听（见 §1）
- 检查本机防火墙规则是否生效：`netsh advfirewall firewall show rule name="khy-os ai-backend"`
- 检查路由器 / 交换机是否做了 AP isolation（家用路由器少见，企业 WiFi 常见）

如果返回 `200 ok`，继续验证账号密码：

```bash
curl -i -X POST http://<host>:9090/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"username":"<你的用户名>","password":"<你的密码>"}'
# 期望 200 {"success":true,"data":{"token":"...","user":{...}}}
# 401 Invalid credentials → 账号密码错；不是网络问题
```

---

## 6. 与设计文档的引用关系

- 设计真源：[DESIGN-ARCH-074] §3.6 LAN 暴露
- 默认账号密码补齐：[DESIGN-ARCH-074] §3.5
- ai-backend 启服入口：`services/ai-backend/server.js`
- AI_MGMT_HOST 单一真源：`services/backend/src/constants/serviceDefaults.js`
- 默认管理员凭据文件：`.khy/credentials/default-admin.json`（生成自 `credentialGenerator.js`）

---

## 7. 不做的事 / 留给后续

- **不**写 systemd / launchd 服务文件——本机/便携式部署默认是「手动起 node 进程」，
  这层留给具体部署载体
- **不**配 HTTPS / Let's Encrypt——LAN 内 HTTP 即可；公网部署请走反向代理（caddy / nginx）
  并配合 [DEPLOY-MAN-016] 部署指南-域名
- **不**做自动安全审计（如端口扫描 / 弱口令提示）——留作 `khy doctor` 后续增强