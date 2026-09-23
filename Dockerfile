# Dockerfile — khy-os service container image
#
# Builds on python:3.12-slim and installs Node.js 22.
#
# ⚠️ 重要：为什么这里必须 COPY 源码（2026-09-18 实测确认）
#
# `pip install khy-os` 装出来的 wheel **只有** khy_platform（Python 启动器）
# 与一个预打包的 `bundled/runtime/khy/bundle.mjs`，**不包含 services/backend
# 源码树**。证据三处：
#   - pyproject.toml: packages = ["khy_platform"]（wheel 只收该包）
#   - platform/khy_platform/cli.py:2070 注释原文：
#       "A standalone-bundle install (the pip wheel) genuinely has no backend
#        directory: the runtime is one bundle.mjs with its dependencies already
#        linked in."
#   - MANIFEST.in 里的 recursive-include services/backend 只作用于 sdist，不作用于 wheel
#
# 因此若 CMD 指向 `node services/backend/...` 而不先 COPY 源码，容器启动即
# MODULE_NOT_FOUND。本镜像现在**源码模式**运行：COPY 仓库树 + 装后端依赖。
#
# Usage:
#   docker build -t khy-os:latest .
#   docker run --rm -p 3000:3000 khy-os:latest            # HTTP 服务（默认）
#   docker run --rm -it khy-os:latest khy --version       # TUI/CLI（覆盖 CMD）

FROM python:3.12-slim AS base

# ── Labels ────────────────────────────────────────────────────────────────────
LABEL org.opencontainers.image.title="khy-os"
LABEL org.opencontainers.image.description="Khy OS AI platform operating system"
LABEL org.opencontainers.image.source="https://github.com/khy-os/khy-os"
LABEL org.opencontainers.image.licenses="Source-available"

# ── Build-time args ───────────────────────────────────────────────────────────
ARG DEBIAN_FRONTEND=noninteractive
ARG PIP_INDEX_URL="https://pypi.org/simple"
ARG NODE_MAJOR=22
# 与根 package.json 的 packageManager 及 workflow 里 pin 的版本保持一致。
ARG PNPM_VERSION=10.18.0

# ── Install system deps + Node.js 22 ─────────────────────────────────────────
# curl + ca-certificates are needed to fetch Node's install script.
# dumb-init is a minimal init for PID 1 signal reaping.
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
         curl \
         ca-certificates \
         dumb-init \
    && rm -rf /var/lib/apt/lists/* \
    && curl -fsSL https://deb.nodesource.com/setup_${NODE_MAJOR}.x | bash - \
    && apt-get update \
    && apt-get install -y --no-install-recommends nodejs \
    && rm -rf /var/lib/apt/lists/* \
    && node --version && npm --version \
    && corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate \
    && pnpm --version

# ── Install khy-os from PyPI ──────────────────────────────────────────────────
# 保留 pip 安装：它提供 `khy` 命令与 Python 启动器（其中 bundle.mjs 作为
# 独立运行时的兜底）。HTTP 服务本身走下面的源码树。
ARG KHY_OS_VERSION=""
RUN if [ -z "$KHY_OS_VERSION" ]; then \
      pip install --no-cache-dir khy-os; \
    else \
      pip install --no-cache-dir "khy-os==${KHY_OS_VERSION}"; \
    fi \
    && khy --version

# ── Non-root user (security best practice) ────────────────────────────────────
# The khy-os data directory must be writable (logs, cache, sqlite DBs).
RUN useradd -m -u 1000 -s /bin/bash khy \
    && mkdir -p /home/khy/.khy \
    && chown -R khy:khy /home/khy/.khy

# ── 源码树 + 后端依赖 ────────────────────────────────────────────────────────
# 放在 pip 安装之后、USER 切换之前：npm/pnpm 安装需要写权限。
# 只 COPY 运行 HTTP 服务真正需要的部分，避免把整仓（含 docs/apps/kernel）塞进镜像。
WORKDIR /app

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
# 必须把 **全部** workspace 成员的 package.json 都放进来：pnpm 的
# --frozen-lockfile 会校验锁文件与整个 workspace 的一致性，缺一个成员就会
# 报 ERR_PNPM_OUTDATED_LOCKFILE。成员清单以根 package.json 的 workspaces 为准。
COPY services/backend/package.json services/backend/
COPY services/ai-backend/package.json services/ai-backend/
COPY platform/packages/shared/package.json platform/packages/shared/
COPY platform/packages/ui-shared/package.json platform/packages/ui-shared/
COPY apps/ai-frontend/package.json apps/ai-frontend/
COPY apps/khyos-desktop/package.json apps/khyos-desktop/
COPY apps/provider-hub/package.json apps/provider-hub/
COPY software/khyquant/frontend/package.json software/khyquant/frontend/

# --frozen-lockfile：锁文件与 package.json 不同步时**构建即失败**，
# 而不是悄悄改锁文件。与 CI 的 install:core 保持同一纪律。
# filter 语法与根 package.json 的 install:prod 一致（khy-os-backend... 含其依赖闭包）。
RUN pnpm install --prod --frozen-lockfile \
    --filter khy-os-backend... \
    --filter @khy/shared...

# 源码放在依赖之后：改业务代码不必重装依赖（利用 layer cache）。
COPY services/backend/ services/backend/
COPY platform/packages/shared/ platform/packages/shared/

# 运行期目录需对 khy 用户可写（sqlite / logs / cache）。
RUN mkdir -p /home/khy/.khy /app/services/backend/logs /app/services/backend/data \
    && chown -R khy:khy /app /home/khy/.khy
USER khy
WORKDIR /app/services/backend

# ── Runtime defaults ──────────────────────────────────────────────────────────
ENV KHY_HOME=/home/khy/.khy
ENV PATH="/usr/local/bin:${PATH}"
# 端口钉死为 3000，与 fly.staging.toml 的 http_service.internal_port 对齐。
# docker-entrypoint.js 也会再设一次（双保险），此处显式声明便于阅读。
ENV PORT=3000
# 容器内不要写 .env（只读风险），用注入的环境变量。
ENV KHY_CONTAINER=1

# Fly / 编排层通过此端口访问 HTTP 服务。
EXPOSE 3000

# dumb-init reaps zombies and forwards signals properly.
# 默认以 HTTP 服务启动（供 Fly 的 http_service.checks 探活）；
# 需要 TUI/CLI 时用 `docker run ... khy` 覆盖 CMD 即可，不影响既有用法。
ENTRYPOINT ["/usr/bin/dumb-init", "--"]
CMD ["node", "docker-entrypoint.js"]

