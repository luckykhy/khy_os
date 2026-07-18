FROM node:20-slim

WORKDIR /app

# System dependencies (curl for healthcheck, build tools for better-sqlite3)
RUN sed -i 's|deb.debian.org|mirrors.aliyun.com|g' /etc/apt/sources.list.d/debian.sources 2>/dev/null; \
    sed -i 's|deb.debian.org|mirrors.aliyun.com|g' /etc/apt/sources.list 2>/dev/null; \
    true

RUN apt-get update && \
    apt-get install -y --no-install-recommends curl build-essential ca-certificates python3 python3-dev && \
    rm -rf /var/lib/apt/lists/*

ENV PYTHON=/usr/bin/python3
ENV npm_config_python=/usr/bin/python3

# Copy shared package
COPY platform/packages/shared /app/packages/shared

# Copy ai-backend package files
COPY services/ai-backend/package*.json services/ai-backend/.npmrc ./

RUN npm install --no-audit --no-fund && npm cache clean --force

# Copy ai-backend source
COPY services/ai-backend/ ./

# Symlink shared node_modules
RUN ln -sf /app/node_modules /app/packages/shared/node_modules

# Data directory
RUN mkdir -p /app/data

EXPOSE 9090

HEALTHCHECK --interval=10s --timeout=5s --retries=5 \
  CMD curl -f http://localhost:9090/api/health || exit 1

CMD ["node", "server.js"]
