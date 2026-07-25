<!-- 文档分类: DEPLOY-MAN-017 | 阶段: 部署 | 原路径: docs/指南/部署指南-无域名.md -->
# KHY-OS 手动部署（无域名 / 仅 IP）

当域名过期或暂不可用时，你仍然可以仅凭服务器的公网 IP 地址部署 KHY-OS。本指南覆盖完整的手动流程，不依赖 `khy deploy`。

目标环境：Ubuntu 20.04+ / Debian 12+ / CentOS 8+，且具备公网 IP。

---

## 目录

1. 概述
2. 前置条件
3. 安装 Node.js 与 Python
4. 安装 KHY-OS
5. 引导初始化后端
6. 配置环境变量
7. 安装并配置 nginx
8. 创建 systemd 服务
9. 开放防火墙端口
10. 启动与验证
11. 移动端远程访问
12. 使用 self-signed SSL 证书启用 HTTPS
13. 日常运维
14. 升级 KHY-OS
15. 故障排查

---

## 1. 概述

在没有域名的情况下：
- 无法使用 Let's Encrypt（其签发证书需要域名）
- 直接通过 `http://<IP>/` 访问
- 可选使用 self-signed HTTPS 加密流量（浏览器会显示安全警告）
- 其余所有功能均完全一致

架构：

```
          Phone / Browser
               |
        http://<IP>:80
               |
        ┌──────────────┐
        │    nginx      │  :80
        │  reverse proxy│
        └──┬───┬───┬────┘
           │   │   │
    ┌──────┘   │   └──────┐
    ▼          ▼          ▼
 backend   ai-backend   bridge
  :3000      :9090       :9222
```

---

## 2. 前置条件

### 硬件

| 项目 | 最低配置 | 推荐配置 |
|------|---------|-------------|
| CPU | 2 核 | 4 核及以上 |
| RAM | 2 GB | 4 GB 及以上 |
| 磁盘 | 10 GB | 20 GB 及以上 |
| 网络 | 公网 IP | 公网 IP |

### 确认你的公网 IP

```bash
curl -4 ifconfig.me
# Example output: 47.96.123.45
```

记下它——下面所有配置都会用到这个 IP。请将 `YOUR_IP` 替换为你的实际 IP。

### SSH 访问

```bash
ssh root@YOUR_IP
# Or if you have a non-root user with sudo:
ssh user@YOUR_IP
```

---

## 3. 安装 Node.js 与 Python

### Node.js（>= 18.x）

```bash
# Ubuntu/Debian
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt-get install -y nodejs

# CentOS/RHEL
curl -fsSL https://rpm.nodesource.com/setup_18.x | sudo bash -
sudo yum install -y nodejs

# Verify
node -v   # v18.x or higher
npm -v    # 9.x or higher
```

### Python（>= 3.10）

大多数现代发行版已预装 Python 3.10+：

```bash
python3 --version   # Should be 3.10+

# If not:
# Ubuntu/Debian
sudo apt-get install -y python3 python3-pip

# CentOS/RHEL
sudo dnf install -y python3 python3-pip
```

---

## 4. 安装 KHY-OS

```bash
pip install khy-os

# Verify
khy --version
```

### 定位后端目录

安装完成后，找到后端代码所在位置：

```bash
BACKEND_DIR=$(python3 -c "
from khy_platform.cli import get_bundle_dir
print(get_bundle_dir())
")
echo "Backend directory: $BACKEND_DIR"

# Project root is the parent
PROJECT_ROOT=$(dirname "$BACKEND_DIR")
echo "Project root: $PROJECT_ROOT"
```

记下这些路径——本指南全程都会用到：

```bash
# Add to ~/.bashrc for convenience
echo "export KHY_BACKEND=$BACKEND_DIR" >> ~/.bashrc
echo "export KHY_ROOT=$PROJECT_ROOT" >> ~/.bashrc
source ~/.bashrc
```

---

## 5. 引导初始化后端

```bash
cd $KHY_BACKEND

# Install npm dependencies
npm install --production

# Create data directory
mkdir -p data

# Run bootstrap if first time (generates .env, seeds database)
khy --help
```

这会创建：
- `$KHY_BACKEND/.env` —— 环境变量
- `$KHY_BACKEND/data/` —— SQLite 数据库

---

## 6. 配置环境变量

编辑后端的 `.env` 文件：

```bash
nano $KHY_BACKEND/.env
```

需要设置的关键变量：

```env
# Server
NODE_ENV=production
PORT=3000

# Bridge
BRIDGE_PORT=9222

# Optional: fix a persistent bridge PIN (otherwise random on each restart)
# BRIDGE_PIN=123456

# Optional: JWT secret for mobile login (otherwise random on each restart)
# JWT_SECRET=your-random-secret-string-here

# AI API keys (fill in your own)
# ANTHROPIC_API_KEY=sk-ant-...
# OPENAI_API_KEY=sk-...
```

生成一个随机的 JWT secret：

```bash
echo "JWT_SECRET=$(openssl rand -hex 32)" >> $KHY_BACKEND/.env
```

---

## 7. 安装并配置 nginx

### 安装

```bash
# Ubuntu/Debian
sudo apt-get update && sudo apt-get install -y nginx

# CentOS/RHEL
sudo dnf install -y nginx

# Enable auto-start
sudo systemctl enable nginx
```

### WebSocket 升级映射

```bash
sudo tee /etc/nginx/conf.d/khy-ws-map.conf > /dev/null << 'EOF'
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}
EOF
```

### 站点配置（基于 IP，无域名）

```bash
sudo tee /etc/nginx/sites-available/khy.conf > /dev/null << 'NGINX'
server {
    listen 80 default_server;
    server_name _;

    # ── Quant Frontend (SPA) ──
    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # ── Backend API + WebSocket ──
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

    # ── AI Management Panel ──
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

    # ── Mobile Remote Control ──
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

    # ── Health Check ──
    location /health {
        proxy_pass http://127.0.0.1:3000/health;
    }

    # ── Performance ──
    gzip on;
    gzip_types text/plain text/css application/json application/javascript text/xml application/xml;
    gzip_min_length 1024;
    gzip_vary on;

    client_max_body_size 50m;
}
NGINX
```

### 启用并测试

```bash
# Remove default site
sudo rm -f /etc/nginx/sites-enabled/default

# Enable KHY site
sudo ln -sf /etc/nginx/sites-available/khy.conf /etc/nginx/sites-enabled/khy.conf

# Test config syntax
sudo nginx -t

# Start/reload
sudo systemctl restart nginx
```

> **CentOS/RHEL 注意**：默认没有 `sites-available/sites-enabled` 目录。请改为将文件放在 `/etc/nginx/conf.d/khy.conf`，并跳过创建符号链接的步骤。

---

## 8. 创建 systemd 服务

首先，获取绝对路径：

```bash
NODE_BIN=$(which node)
echo "Node: $NODE_BIN"
echo "Backend: $KHY_BACKEND"
echo "Project root: $KHY_ROOT"
```

### 服务 1：khy-backend（端口 3000）

```bash
sudo tee /etc/systemd/system/khy-backend.service > /dev/null << EOF
[Unit]
Description=KHY Backend API Server
After=network.target

[Service]
Type=simple
User=$(whoami)
WorkingDirectory=$KHY_BACKEND
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

### 服务 2：khy-ai（端口 9090）

```bash
sudo tee /etc/systemd/system/khy-ai.service > /dev/null << EOF
[Unit]
Description=KHY AI Management Backend
After=network.target

[Service]
Type=simple
User=$(whoami)
WorkingDirectory=$KHY_ROOT/ai-backend
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

### 服务 3：khy-bridge（端口 9222）

```bash
sudo tee /etc/systemd/system/khy-bridge.service > /dev/null << EOF
[Unit]
Description=KHY Mobile Bridge Server
After=network.target

[Service]
Type=simple
User=$(whoami)
WorkingDirectory=$KHY_BACKEND
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

### 全部启用

```bash
sudo systemctl daemon-reload
sudo systemctl enable khy-backend khy-ai khy-bridge
```

---

## 9. 开放防火墙端口

只需对外暴露 nginx 使用的端口：

```bash
# UFW (Ubuntu/Debian)
sudo ufw allow 22/tcp     # SSH
sudo ufw allow 80/tcp     # HTTP
sudo ufw enable
sudo ufw status

# firewalld (CentOS/RHEL)
sudo firewall-cmd --permanent --add-service=ssh
sudo firewall-cmd --permanent --add-service=http
sudo firewall-cmd --reload
```

内部端口（3000、9090、9222）保持关闭——所有流量都由 nginx 代理。

如果你的服务器位于云平台（AWS、Aliyun、Tencent），还需在云控制台检查**安全组**规则，放行 80 端口入站。

---

## 10. 启动与验证

### 启动所有服务

```bash
sudo systemctl start khy-backend khy-ai khy-bridge nginx
```

### 检查状态

```bash
# Quick check
sudo systemctl is-active khy-backend khy-ai khy-bridge nginx

# Detailed status
sudo systemctl status khy-backend
sudo systemctl status khy-ai
sudo systemctl status khy-bridge
```

### 测试端点

```bash
# Internal health checks
curl -s http://127.0.0.1:3000/health && echo " Backend OK"
curl -s http://127.0.0.1:9222/health && echo " Bridge OK"

# External (replace YOUR_IP)
curl -s http://YOUR_IP/health && echo " Nginx OK"
```

### 在浏览器中验证

在你的电脑或手机上打开：

| URL | 服务 |
|-----|---------|
| `http://YOUR_IP/` | 量化前端 |
| `http://YOUR_IP/ai/` | AI 管理面板 |
| `http://YOUR_IP/remote/` | 移动端远程控制（登录页） |
| `http://YOUR_IP/health` | 健康检查 JSON |

---

## 11. 移动端远程访问

### 通过 nginx（推荐）

在手机上打开：

```
http://YOUR_IP/remote/
```

1. 注册账号（首次）或登录
2. 开始使用远程控制

### 直连访问（不经 nginx）

如果未配置 nginx，可直接访问 bridge：

```
http://YOUR_IP:9222/
```

这需要在防火墙中开放 9222 端口：

```bash
sudo ufw allow 9222/tcp
```

### 管理员 PIN 登录

如需快速进行管理员访问，可查看 bridge 的 PIN：

```bash
# View bridge logs for PIN
journalctl -u khy-bridge -n 20 | grep PIN

# Or restart bridge and check
sudo systemctl restart khy-bridge
journalctl -u khy-bridge -n 5
```

在移动端登录页底部，点击 “Admin PIN Login” 并输入 6 位 PIN。

---

## 12. 使用 self-signed SSL 证书启用 HTTPS

没有域名时，Let's Encrypt 无法工作。可改用 self-signed 证书——流量被加密，但浏览器会显示安全警告。

### 生成证书

```bash
sudo mkdir -p /etc/nginx/ssl

sudo openssl req -x509 -nodes -days 365 \
    -newkey rsa:2048 \
    -keyout /etc/nginx/ssl/khy-selfsigned.key \
    -out /etc/nginx/ssl/khy-selfsigned.crt \
    -subj "/CN=YOUR_IP"
```

### 更新 nginx 配置

```bash
sudo tee /etc/nginx/sites-available/khy.conf > /dev/null << 'NGINX'
server {
    listen 80 default_server;
    server_name _;
    # Redirect HTTP → HTTPS
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl default_server;
    server_name _;

    ssl_certificate     /etc/nginx/ssl/khy-selfsigned.crt;
    ssl_certificate_key /etc/nginx/ssl/khy-selfsigned.key;
    ssl_protocols       TLSv1.2 TLSv1.3;
    ssl_ciphers         HIGH:!aNULL:!MD5;

    # ── Quant Frontend (SPA) ──
    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    # ── Backend API + WebSocket ──
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

    # ── AI Management Panel ──
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

    # ── Mobile Remote Control ──
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

    # ── Health Check ──
    location /health {
        proxy_pass http://127.0.0.1:3000/health;
    }

    # ── Performance ──
    gzip on;
    gzip_types text/plain text/css application/json application/javascript text/xml application/xml;
    gzip_min_length 1024;
    gzip_vary on;

    client_max_body_size 50m;
}
NGINX
```

### 应用并开放 443 端口

```bash
sudo nginx -t
sudo systemctl restart nginx

# Firewall
sudo ufw allow 443/tcp
```

### 访问

```
https://YOUR_IP/
https://YOUR_IP/remote/
```

浏览器会显示 “Not secure” 警告——点击 “Advanced” → “Proceed”（对你自己的服务器是安全的）。

### 续期 self-signed 证书

证书在 365 天后过期。重新生成：

```bash
sudo openssl req -x509 -nodes -days 365 \
    -newkey rsa:2048 \
    -keyout /etc/nginx/ssl/khy-selfsigned.key \
    -out /etc/nginx/ssl/khy-selfsigned.crt \
    -subj "/CN=YOUR_IP"

sudo nginx -s reload
```

---

## 13. 日常运维

### 查看日志

```bash
# Real-time logs
journalctl -u khy-backend -f
journalctl -u khy-ai -f
journalctl -u khy-bridge -f

# All KHY logs combined
journalctl -u "khy-*" -f

# Last 100 lines
journalctl -u khy-backend -n 100

# Logs since a time
journalctl -u khy-backend --since "2026-06-01 12:00"

# Nginx logs
sudo tail -f /var/log/nginx/access.log
sudo tail -f /var/log/nginx/error.log
```

### 重启服务

```bash
# Single service
sudo systemctl restart khy-backend

# All
sudo systemctl restart khy-backend khy-ai khy-bridge

# Restart nginx (after config change)
sudo nginx -t && sudo systemctl restart nginx
```

### 检查磁盘占用

```bash
# Backend data
du -sh $KHY_BACKEND/data/

# Logs
journalctl --disk-usage

# Clean old logs (keep last 7 days)
sudo journalctl --vacuum-time=7d
```

### 备份用户数据库

```bash
# Bridge user accounts
cp $KHY_BACKEND/data/bridge-users.db ~/backup/bridge-users-$(date +%Y%m%d).db

# Main database
cp $KHY_BACKEND/data/*.db ~/backup/
```

---

## 14. 升级 KHY-OS

```bash
# Step 1: Upgrade package
pip install --upgrade khy-os

# Step 2: Re-install npm dependencies (in case of new packages)
cd $KHY_BACKEND && npm install --production

# Step 3: Restart all services
sudo systemctl restart khy-backend khy-ai khy-bridge

# Step 4: Verify
curl -s http://127.0.0.1:3000/health
curl -s http://127.0.0.1:9222/health
```

### 回滚到指定版本

```bash
pip install khy-os==0.1.79
cd $KHY_BACKEND && npm install --production
sudo systemctl restart khy-backend khy-ai khy-bridge
```

---

## 15. 故障排查

### 服务无法启动

```bash
# Check error details
journalctl -u khy-backend -n 50 --no-pager

# Common causes:
# 1. Port conflict
sudo lsof -i :3000

# 2. Node.js not found
which node

# 3. Missing npm packages
cd $KHY_BACKEND && npm install --production

# 4. Permission denied on data directory
sudo chown -R $(whoami):$(whoami) $KHY_BACKEND/data
```

### 502 Bad Gateway

上游 Node.js 服务已宕机：

```bash
# Check which service died
sudo systemctl status khy-backend khy-ai khy-bridge

# Restart the failed one
sudo systemctl restart khy-backend

# Check logs
journalctl -u khy-backend -n 50
```

### 手机无法连接

```bash
# 1. Is nginx running?
sudo systemctl status nginx

# 2. Is port 80 open?
sudo ufw status
# Also check cloud security group if on AWS/Aliyun

# 3. Can you reach the server at all?
# From phone, try: http://YOUR_IP/health

# 4. Is bridge running?
curl -s http://127.0.0.1:9222/health
```

### WebSocket 频繁断开

```bash
# Check nginx WebSocket map exists
cat /etc/nginx/conf.d/khy-ws-map.conf
# Should contain: map $http_upgrade $connection_upgrade { ... }

# Check proxy timeout (should be 86400s for WS)
grep proxy_read_timeout /etc/nginx/sites-available/khy.conf
```

### “Address Already in Use”

```bash
# Find what's using the port
sudo lsof -i :3000
sudo lsof -i :9222

# Kill it
sudo kill $(sudo lsof -t -i :3000)

# Then restart service
sudo systemctl restart khy-backend
```

### 数据库锁定 / 损坏

```bash
# Bridge user database
ls -la $KHY_BACKEND/data/bridge-users.db*

# If corrupted, remove and restart (users will need to re-register)
rm $KHY_BACKEND/data/bridge-users.db*
sudo systemctl restart khy-bridge
```

### 服务器重启之后

已 `enable` 的服务会在开机时自动启动。请验证：

```bash
sudo systemctl is-enabled khy-backend khy-ai khy-bridge nginx
# Should all show "enabled"

# If any shows "disabled":
sudo systemctl enable khy-backend khy-ai khy-bridge nginx
```

---

## 速查卡

```
┌─────────────────────────────────────────────────┐
│  KHY-OS IP Deployment — Quick Reference          │
├─────────────────────────────────────────────────┤
│  Access:                                         │
│    http://YOUR_IP/          Frontend             │
│    http://YOUR_IP/ai/       AI Panel             │
│    http://YOUR_IP/remote/   Mobile Remote        │
│    http://YOUR_IP/health    Health Check         │
│                                                  │
│  Services:                                       │
│    sudo systemctl status khy-backend khy-ai      │
│                           khy-bridge nginx       │
│    sudo systemctl restart khy-backend            │
│                                                  │
│  Logs:                                           │
│    journalctl -u khy-backend -f                  │
│    journalctl -u khy-bridge -f                   │
│    sudo tail -f /var/log/nginx/error.log         │
│                                                  │
│  Update:                                         │
│    pip install --upgrade khy-os                   │
│    sudo systemctl restart khy-backend khy-ai     │
│                           khy-bridge             │
│                                                  │
│  Ports (internal, nginx proxies all):            │
│    3000  backend                                 │
│    8080  frontend                                │
│    8090  ai-frontend                             │
│    9090  ai-backend                              │
│    9222  bridge                                  │
└─────────────────────────────────────────────────┘
```
