FROM node:20-slim

WORKDIR /app

# ── 使用阿里云镜像加速 apt ──
RUN sed -i 's|deb.debian.org|mirrors.aliyun.com|g' /etc/apt/sources.list.d/debian.sources 2>/dev/null; \
    sed -i 's|deb.debian.org|mirrors.aliyun.com|g' /etc/apt/sources.list 2>/dev/null; \
    true

# ── 安装系统依赖 ──
# python3/pip: akshare + ML推理
# curl: 健康检查
# build-essential: better-sqlite3 原生编译
RUN apt-get update && \
    apt-get install -y --no-install-recommends \
        python3 python3-pip python3-dev \
        curl \
        build-essential \
        libssl-dev \
        ca-certificates && \
    rm -rf /var/lib/apt/lists/*

# ── 升级pip ──
RUN python3 -m pip install --no-cache-dir --upgrade pip \
    -i https://mirrors.aliyun.com/pypi/simple/ \
    --trusted-host mirrors.aliyun.com \
    --break-system-packages

# ── 安装ML推理依赖（先复制requirements，利用Docker层缓存）──
# 版本固定：joblib序列化与sklearn版本强绑定，必须与训练环境一致
COPY services/backend/ml/requirements.txt /tmp/ml-requirements.txt
RUN python3 -m pip install --no-cache-dir -r /tmp/ml-requirements.txt \
    -i https://mirrors.aliyun.com/pypi/simple/ \
    --trusted-host mirrors.aliyun.com \
    --break-system-packages \
    --timeout 300

# ── 安装AKShare数据源依赖 ──
# akshare==1.16.87 固定版本，确保接口字段名称稳定
COPY services/backend/akshare_scripts/requirements.txt /tmp/akshare-requirements.txt
RUN python3 -m pip install --no-cache-dir -r /tmp/akshare-requirements.txt \
    -i https://mirrors.aliyun.com/pypi/simple/ \
    --trusted-host mirrors.aliyun.com \
    --break-system-packages \
    --timeout 300

# ── 配置npm使用阿里云镜像 ──
RUN npm config set registry https://registry.npmmirror.com

# 告知Node.js使用系统Python
ENV PYTHON=/usr/bin/python3
ENV npm_config_python=/usr/bin/python3

# ── 复制 shared 包 ──
COPY platform/packages/shared /app/packages/shared

# ── 安装Node依赖（先复制package.json，利用Docker层缓存）──
COPY services/backend/package*.json ./
# backend/package.json uses "@khy/shared": "workspace:*" for monorepo local dev.
# In Docker single-package build, rewrite it to a local file dependency.
RUN node -e "const fs=require('fs');const p=JSON.parse(fs.readFileSync('package.json','utf8'));if(p.dependencies&&p.dependencies['@khy/shared'])p.dependencies['@khy/shared']='file:packages/shared';fs.writeFileSync('package.json',JSON.stringify(p,null,2));"
# Avoid workspace-style lockfile links (e.g. ../../../packages/shared) in container builds.
RUN rm -f package-lock.json
RUN npm install --omit=dev --no-audit --no-fund
# Retain the generated package-lock.json for reproducible future builds
# better-sqlite3需要从源码编译以匹配Node版本
RUN npm rebuild better-sqlite3 --build-from-source

# Symlink shared node_modules
RUN ln -sf /app/node_modules /app/packages/shared/node_modules

# ── 复制源码（保留已修改的 package.json）──
RUN cp package.json /tmp/package.json.patched
COPY services/backend/ .
RUN cp /tmp/package.json.patched package.json

# ── 确保数据目录存在 ──
RUN mkdir -p /app/data

# ── Security: run as non-root user ──
RUN groupadd -r khyquant && useradd -r -g khyquant -s /bin/false khyquant \
    && chown -R khyquant:khyquant /app
USER khyquant

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD curl -f http://localhost:3000/health || exit 1

# 启动：先执行seed初始化数据库，再启动服务
CMD ["sh", "-c", "node scripts/seed.js && node server.js"]
