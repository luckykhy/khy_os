<!-- 文档分类: DEPLOY-MAN-016 | 阶段: 部署 | 原路径: docs/指南/部署指南-域名.md -->
# KHY-OS 服务器部署指南

在 Linux 服务器上部署 KHY-OS 全栈服务的生产环境部署指南。

适用环境：Ubuntu 20.04+ / Debian 12+ / CentOS 8+，域名 `ai.khyquant.top`。

---

## 目录

1. 架构概览
2. 前置条件
3. 一键部署
4. 手动分步部署
5. 服务管理
6. SSL 证书
7. Nginx 配置
8. 移动端远程控制
9. 监控与故障排查
10. 更新与重新部署
11. 防火墙配置
12. 常见问题

---

## 1. 架构概览

```
                          Internet
                             |
                      [ ai.khyquant.top ]
                             |
                     ┌───────────────┐
                     │    nginx      │  :80 / :443
                     │  (reverse     │  Let's Encrypt HTTPS
                     │   proxy)      │
                     └───┬───┬───┬───┘
                         │   │   │
          ┌──────────────┘   │   └──────────────┐
          │                  │                  │
          ▼                  ▼                  ▼
   ┌────────────┐    ┌────────────┐     ┌────────────┐
   │  frontend  │    │ ai-frontend│     │   bridge   │
   │   :8080    │    │   :8090    │     │   :9222    │
   │  Quant SPA │    │  AI Panel  │     │  Mobile WS │
   └──────┬─────┘    └──────┬─────┘     └────────────┘
          │                 │
          ▼                 ▼
   ┌────────────┐    ┌────────────┐
   │  backend   │    │ ai-backend │
   │   :3000    │    │   :9090    │
   │ Express API│    │  AI Mgmt   │
   └────────────┘    └────────────┘
```

### URL 路由

| Path | Upstream | 说明 |
|------|----------|-------------|
| `/` | frontend:8080 | 量化交易 SPA |
| `/api/` | backend:3000 | REST API + WebSocket |
| `/ai/` | ai-frontend:8090 | AI 管理面板 |
| `/ai/api/` | ai-backend:9090 | AI 网关 API + WebSocket |
| `/remote/` | bridge:9222 | 移动端远程控制页面 |
| `/remote/ws` | bridge:9222 | 移动端 WebSocket 连接 |
| `/health` | backend:3000 | 健康检查端点 |

---

## 2. 前置条件

### 硬件要求

| 组件 | 最低配置 | 推荐配置 |
|-----------|---------|-------------|
| CPU | 2 核 | 4 核及以上 |
| RAM | 2 GB | 4 GB 及以上 |
| 磁盘 | 10 GB | 20 GB 及以上 |
| 网络 | 公网 IP | 公网 IP + 域名 |

### 软件要求

- **操作系统**：Ubuntu 20.04+、Debian 11+、CentOS 8+，或任意基于 systemd 的 Linux
- **Node.js**：>= 18.x
- **Python**：>= 3.10（用于 pip 安装）
- **pip**：>= 21.0

### DNS 配置

`ai.khyquant.top` 是 `khyquant.top` 的子域名。无需额外购买——只需在你的域名注册商（阿里云 / 腾讯云 / Cloudflare 等）处添加一条 DNS 记录：

```
Type: A
Name: ai                          (registrar auto-appends .khyquant.top)
Value: <your-server-public-ip>
TTL: 300
```

> 注意：主域名 `khyquant.top` 保持不变。新增的 `ai` 子域名指向 KHY-OS 服务器，其 IP 可以与主站不同。

验证 DNS 解析是否生效：

```bash
dig ai.khyquant.top +short
# Should return your server's IP
```

---

## 3. 一键部署

最简单的部署方式，一条命令搞定全部流程。

### 步骤 1：安装 KHY-OS

```bash
# Install via pip
pip install khy-os

# Verify installation
khy --version
```

### 步骤 2：部署

```bash
sudo khy deploy --domain ai.khyquant.top
```

这一条命令将会：

1. 检查前置条件（Linux、Node.js、root 权限）
2. 安装系统软件包（nginx、certbot）
3. 引导初始化后端（npm install、.env、数据库播种）
4. 生成并安装 nginx 反向代理配置
5. 申请 Let's Encrypt SSL 证书
6. 创建并启动 3 个 systemd 服务
7. 运行健康检查并显示汇总信息

### 步骤 3：验证

```bash
# Check deployment status
khy deploy status

# Test endpoints
curl https://ai.khyquant.top/health
```

在浏览器中打开：

- `https://ai.khyquant.top/` -- 量化交易前端
- `https://ai.khyquant.top/ai/` -- AI 管理面板
- `https://ai.khyquant.top/remote/?token=<token>` -- 移动端远程控制

### 选项

```bash
# Deploy without SSL (internal network)
sudo khy deploy --domain ai.khyquant.top --no-ssl

# Specify email for Let's Encrypt
sudo khy deploy --domain ai.khyquant.top --email admin@ai.khyquant.top

# Only regenerate nginx config
sudo khy deploy nginx --domain ai.khyquant.top

# Only setup/renew SSL
sudo khy deploy ssl --domain ai.khyquant.top

# Show deployment status
khy deploy status
```

---

## 4. 手动分步部署

如果你希望手动控制每一步，或者需要自定义配置，可以采用此方式。

### 4.1 安装 Node.js

```bash
# Ubuntu/Debian
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs

# CentOS/RHEL
curl -fsSL https://rpm.nodesource.com/setup_18.x | sudo bash -
sudo yum install -y nodejs

# Verify
node -v  # Should be v18.x or higher
```

### 4.2 安装 KHY-OS

```bash
pip install khy-os

# First run triggers bootstrap (npm install, .env generation, DB seed)
khy --help
```

### 4.3 安装 nginx

```bash
# Ubuntu/Debian
sudo apt-get update && sudo apt-get install -y nginx

# CentOS/RHEL
sudo dnf install -y nginx

# Enable and start
sudo systemctl enable nginx
sudo systemctl start nginx
```

### 4.4 配置 nginx

创建 WebSocket 升级映射：

```bash
sudo tee /etc/nginx/conf.d/khy-ws-map.conf > /dev/null << 'EOF'
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}
EOF
```

创建站点配置：

```bash
sudo tee /etc/nginx/sites-available/khy.conf > /dev/null << 'EOF'
server {
    listen 80;
    server_name ai.khyquant.top;

    # Quant Frontend (SPA)
    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # Backend API + WebSocket
    location /api/ {
        proxy_pass http://127.0.0.1:3000/api/;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 86400s;
    }

    # AI Management Panel
    location /ai/ {
        proxy_pass http://127.0.0.1:8090/;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location /ai/api/ {
        proxy_pass http://127.0.0.1:9090/api/;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_read_timeout 86400s;
    }

    # Mobile Remote Control
    location /remote/ {
        proxy_pass http://127.0.0.1:9222/;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location /remote/ws {
        proxy_pass http://127.0.0.1:9222/;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_read_timeout 86400s;
        proxy_send_timeout 86400s;
    }

    # Health Check
    location /health {
        proxy_pass http://127.0.0.1:3000/health;
    }

    # Performance
    gzip on;
    gzip_types text/plain text/css application/json application/javascript text/xml application/xml;
    gzip_min_length 1024;
    gzip_vary on;

    client_max_body_size 50m;
}
EOF
```

启用站点并重载：

```bash
# Remove default site if present
sudo rm -f /etc/nginx/sites-enabled/default

# Enable KHY site
sudo ln -sf /etc/nginx/sites-available/khy.conf /etc/nginx/sites-enabled/khy.conf

# Test and reload
sudo nginx -t
sudo nginx -s reload
```

### 4.5 使用 Let's Encrypt 配置 SSL

```bash
# Install certbot
sudo apt-get install -y certbot python3-certbot-nginx

# Request certificate (auto-modifies nginx config for HTTPS)
sudo certbot --nginx -d ai.khyquant.top \
    --non-interactive --agree-tos \
    --email admin@ai.khyquant.top --redirect

# Verify auto-renewal
sudo certbot renew --dry-run
```

### 4.6 创建 systemd 服务

定位后端目录：

```bash
# If installed via pip
BACKEND_DIR=$(python3 -c "
from khy_platform.cli import get_bundle_dir
print(get_bundle_dir())
")
echo "Backend: $BACKEND_DIR"

# Project root is parent of backend
PROJECT_ROOT=$(dirname "$BACKEND_DIR")
NODE_BIN=$(which node)
```

**服务 1：khy-backend（端口 3000）**

```bash
sudo tee /etc/systemd/system/khy-backend.service > /dev/null << EOF
[Unit]
Description=KHY Backend API Server
After=network.target

[Service]
Type=simple
User=$(whoami)
WorkingDirectory=$BACKEND_DIR
ExecStart=$NODE_BIN server.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production
Environment=PORT=3000
StandardOutput=journal
StandardError=journal
SyslogIdentifier=khy-backend

[Install]
WantedBy=multi-user.target
EOF
```

**服务 2：khy-ai（端口 9090）**

```bash
sudo tee /etc/systemd/system/khy-ai.service > /dev/null << EOF
[Unit]
Description=KHY AI Management Backend
After=network.target

[Service]
Type=simple
User=$(whoami)
WorkingDirectory=$PROJECT_ROOT/ai-backend
ExecStart=$NODE_BIN server.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production
StandardOutput=journal
StandardError=journal
SyslogIdentifier=khy-ai

[Install]
WantedBy=multi-user.target
EOF
```

**服务 3：khy-bridge（端口 9222）**

```bash
sudo tee /etc/systemd/system/khy-bridge.service > /dev/null << EOF
[Unit]
Description=KHY Mobile Bridge Server
After=network.target

[Service]
Type=simple
User=$(whoami)
WorkingDirectory=$BACKEND_DIR
ExecStart=$NODE_BIN -e "const b=require('./src/bridge/bridgeServer');b.startBridgeServer().then(r=>{console.log('Bridge:',r.port?'http://0.0.0.0:'+r.port:'failed');});setInterval(()=>{},60000);"
Restart=always
RestartSec=5
Environment=NODE_ENV=production
Environment=BRIDGE_PORT=9222
StandardOutput=journal
StandardError=journal
SyslogIdentifier=khy-bridge

[Install]
WantedBy=multi-user.target
EOF
```

**启用并启动所有服务：**

```bash
sudo systemctl daemon-reload
sudo systemctl enable khy-backend khy-ai khy-bridge
sudo systemctl start khy-backend khy-ai khy-bridge

# Verify
sudo systemctl status khy-backend khy-ai khy-bridge
```

### 4.7 验证部署

```bash
# Health checks
curl -s http://127.0.0.1:3000/health | jq .
curl -s http://127.0.0.1:9222/health | jq .
curl -s https://ai.khyquant.top/health  | jq .

# Service status
systemctl is-active khy-backend khy-ai khy-bridge nginx
```

---

## 5. 服务管理

### 控制服务

```bash
# Start/stop/restart individual services
sudo systemctl start khy-backend
sudo systemctl stop khy-backend
sudo systemctl restart khy-backend

# Restart all KHY services
sudo systemctl restart khy-backend khy-ai khy-bridge

# Check status
sudo systemctl status khy-backend
sudo systemctl status khy-ai
sudo systemctl status khy-bridge

# Quick status check via khy deploy
khy deploy status
```

### 查看日志

```bash
# Follow backend logs in real-time
journalctl -u khy-backend -f

# View AI backend logs
journalctl -u khy-ai -f

# View bridge logs
journalctl -u khy-bridge -f

# View all KHY logs combined
journalctl -u "khy-*" -f

# View last 100 lines of backend logs
journalctl -u khy-backend -n 100

# View logs since a specific time
journalctl -u khy-backend --since "2026-06-01 12:00:00"

# View nginx access log
sudo tail -f /var/log/nginx/access.log

# View nginx error log
sudo tail -f /var/log/nginx/error.log
```

### 服务端口参考

| 服务 | 端口 | Systemd Unit | 日志标签 |
|---------|------|-------------|---------|
| Backend API | 3000 | khy-backend | khy-backend |
| AI Backend | 9090 | khy-ai | khy-ai |
| Bridge（移动端） | 9222 | khy-bridge | khy-bridge |
| Frontend | 8080 | (manual/docker) | - |
| AI Frontend | 8090 | (manual/docker) | - |
| nginx | 80/443 | nginx | nginx |

---

## 6. SSL 证书

### 自动续期

Let's Encrypt 证书有效期为 90 天。Certbot 会安装一个自动续期的 cron 任务 / systemd timer。

```bash
# Check renewal timer
sudo systemctl status certbot.timer

# Manual dry-run to verify renewal works
sudo certbot renew --dry-run

# Force renewal
sudo certbot renew --force-renewal
```

### 查看证书信息

```bash
# Check certificate expiry
sudo certbot certificates

# Or via openssl
echo | openssl s_client -servername ai.khyquant.top -connect ai.khyquant.top:443 2>/dev/null \
  | openssl x509 -noout -dates
```

### 重新签发证书

```bash
# If certificate is broken or domain changed
sudo certbot --nginx -d ai.khyquant.top \
    --non-interactive --agree-tos \
    --email admin@ai.khyquant.top --redirect

# Or via khy deploy
sudo khy deploy ssl --domain ai.khyquant.top
```

---

## 7. Nginx 配置

### 重新生成配置

```bash
# Via khy deploy
sudo khy deploy nginx --domain ai.khyquant.top

# Or via bridge command (generates bridge-only config)
khy bridge nginx --prefix /remote
```

### 自定义配置

主配置文件位于：

- Debian/Ubuntu：`/etc/nginx/sites-available/khy.conf`
- CentOS/RHEL：`/etc/nginx/conf.d/khy.conf`

编辑后：

```bash
# Always test before reloading
sudo nginx -t

# Reload
sudo nginx -s reload
```

### 常见自定义

**修改客户端上传大小限制：**

```nginx
client_max_body_size 100m;  # Default: 50m
```

**添加限流：**

```nginx
# In http block (/etc/nginx/nginx.conf)
limit_req_zone $binary_remote_addr zone=api:10m rate=30r/s;

# In location /api/ block
limit_req zone=api burst=50 nodelay;
```

**为 AI 面板添加 IP 白名单：**

```nginx
location /ai/ {
    allow 192.168.0.0/16;
    allow 10.0.0.0/8;
    deny all;
    proxy_pass http://127.0.0.1:8090/;
    # ... rest of config
}
```

---

## 8. 移动端远程控制

bridge 服务器提供一个基于网页的远程控制界面，可在同一网络下的手机上访问，也可通过公网域名访问。

### 访问方式

**通过公网域名（经 nginx 代理）：**

```
https://ai.khyquant.top/remote/?token=<token>
```

**通过局域网直连（无需 nginx）：**

```
http://<server-lan-ip>:9222/?token=<token>
```

### 获取令牌

```bash
# If running khy ai (TUI mode), the URL is printed at startup:
#   Mobile: http://192.168.1.5:9222/?token=abc123...

# Or via bridge command
khy bridge token

# Or via bridge status
khy bridge status
```

### 令牌有效期

令牌在 30 分钟后过期。bridge 服务器每次重启都会生成新令牌。获取新令牌：

```bash
sudo systemctl restart khy-bridge
khy bridge token
```

### 功能特性

- 从手机向 CLI 发送命令
- 实时查看 AI 响应（流式文本、思考过程、工具调用）
- 批准或拒绝权限请求（工具执行、文件写入）
- 断线自动重连
- 支持竖屏和横屏两种方向

---

## 9. 监控与故障排查

### 快速健康检查

```bash
# All-in-one status
khy deploy status

# Individual endpoint checks
curl -sf http://127.0.0.1:3000/health && echo "Backend OK" || echo "Backend FAIL"
curl -sf http://127.0.0.1:9090/api/health && echo "AI Backend OK" || echo "AI Backend FAIL"
curl -sf http://127.0.0.1:9222/health && echo "Bridge OK" || echo "Bridge FAIL"
curl -sf https://ai.khyquant.top/health && echo "Nginx+SSL OK" || echo "External FAIL"
```

### 常见问题

**问题：502 Bad Gateway**

上游服务未运行。

```bash
# Check which service is down
sudo systemctl status khy-backend khy-ai khy-bridge

# Restart the failed service
sudo systemctl restart khy-backend

# Check logs for errors
journalctl -u khy-backend -n 50
```

**问题：SSL 证书不生效**

```bash
# Check if certbot succeeded
sudo certbot certificates

# Re-run certbot
sudo certbot --nginx -d ai.khyquant.top --non-interactive --agree-tos --redirect

# Common cause: DNS not pointing to this server
dig ai.khyquant.top +short
```

**问题：WebSocket 连接失败**

```bash
# Check nginx WS map exists
cat /etc/nginx/conf.d/khy-ws-map.conf

# Test WebSocket manually
curl -i -N \
  -H "Connection: Upgrade" \
  -H "Upgrade: websocket" \
  -H "Sec-WebSocket-Version: 13" \
  -H "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==" \
  http://127.0.0.1:9222/
```

**问题：服务无法启动**

```bash
# Check detailed error
journalctl -u khy-backend -n 50 --no-pager

# Common causes:
# 1. Port already in use
sudo lsof -i :3000
# 2. Node.js not found
which node
# 3. npm dependencies missing
cd /path/to/backend && npm install
```

**问题：端口 3000/9090/9222 上出现 "Address already in use"**

```bash
# Find what's using the port
sudo lsof -i :3000

# Kill the process
sudo kill <PID>

# Or stop conflicting service
sudo systemctl stop <conflicting-service>
```

**问题：写入文件时出现 Permission denied**

```bash
# Ensure the service user owns the data directory
sudo chown -R $(whoami):$(whoami) /path/to/backend/data
```

### 资源监控

```bash
# Service memory/CPU usage
systemctl status khy-backend  # Shows memory in "Memory:" line

# Detailed process info
ps aux | grep -E 'khy|node'

# Disk usage
du -sh /path/to/backend/data/

# Open connections
ss -tlnp | grep -E '3000|9090|9222|80|443'
```

---

## 10. 更新与重新部署

### 更新 KHY-OS

```bash
# Upgrade pip package
pip install --upgrade khy-os

# Restart services to pick up new code
sudo systemctl restart khy-backend khy-ai khy-bridge
```

### 完整重新部署

重新运行 `khy deploy` 是幂等且安全的：

```bash
sudo khy deploy --domain ai.khyquant.top
```

它会：
- 跳过已安装的软件包
- 用最新模板覆盖 nginx 配置
- 保留现有的 SSL 证书
- 用更新后的代码重启所有服务

### 回滚

```bash
# Install a specific version
pip install khy-os==0.1.79

# Restart services
sudo systemctl restart khy-backend khy-ai khy-bridge
```

---

## 11. 防火墙配置

### UFW（Ubuntu/Debian）

```bash
sudo ufw allow 22/tcp    # SSH
sudo ufw allow 80/tcp    # HTTP (nginx)
sudo ufw allow 443/tcp   # HTTPS (nginx)
sudo ufw enable
sudo ufw status
```

内部端口（3000、9090、9222）无需开放——nginx 会通过 80/443 代理所有流量。

### firewalld（CentOS/RHEL）

```bash
sudo firewall-cmd --permanent --add-service=http
sudo firewall-cmd --permanent --add-service=https
sudo firewall-cmd --permanent --add-service=ssh
sudo firewall-cmd --reload
```

### 局域网直接访问（可选）

如果你希望从局域网直接访问 bridge（不经过 nginx），还需开放端口 9222：

```bash
sudo ufw allow 9222/tcp  # Bridge direct access (LAN only)
```

---

## 12. 常见问题

### 问：可以在没有域名的服务器上部署吗？

可以。使用 `--no-ssl` 并通过 IP 访问：

```bash
sudo khy deploy --domain <server-ip> --no-ssl
```

然后访问 `http://<server-ip>/`。

### 问：可以使用其他子域名吗？

可以。你域名的任意子域名都可以——只需添加一条 DNS A 记录并部署：

```bash
# Example: deploy to app.khyquant.top instead
sudo khy deploy --domain app.khyquant.top
```

### 问：如何添加 www 前缀支持？

用两个域名运行 certbot：

```bash
sudo certbot --nginx -d ai.khyquant.top -d www.ai.khyquant.top
```

并在 nginx 配置中同时添加两者：`server_name ai.khyquant.top www.ai.khyquant.top;`

### 问：可以用 Docker 代替 systemd 吗？

可以。使用项目内置的 `docker-compose.yml`：

```bash
cd /path/to/khy-os
docker compose up -d
```

然后配置 nginx 代理到 Docker 发布的端口。端口保持一致（3000、8080、8090、9090）。

### 问：如果 certbot 报错 "Challenge failed" 怎么办？

这意味着 Let's Encrypt 无法通过端口 80 访问你的服务器。请检查：

1. DNS A 记录指向你服务器的公网 IP
2. 防火墙已开放端口 80
3. nginx 正在运行并监听端口 80
4. 没有其他服务占用端口 80

```bash
# Debug
dig ai.khyquant.top +short
sudo ufw status
sudo systemctl status nginx
sudo lsof -i :80
```

### 问：如何监控 SSL 证书过期时间？

```bash
# Quick check
khy deploy status

# Detailed
sudo certbot certificates
```

Certbot 会通过 systemd timer 在证书过期前 30 天自动续期。除非 timer 损坏，否则无需手动操作。

### 问：移动端远程控制会占用多少带宽？

极少。WebSocket 连接仅传输文本块（AI 响应），活跃使用时通常低于 10 KB/s。空闲连接每 25 秒发送一次心跳 ping（约 50 字节）。
