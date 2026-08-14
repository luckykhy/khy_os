FROM node:20-slim

WORKDIR /app

# System dependencies (curl for healthcheck, build tools for better-sqlite3)
ARG APT_MIRROR=""
RUN if [ -n "$APT_MIRROR" ]; then \
      if [ -f /etc/apt/sources.list.d/debian.sources ]; then \
        sed -i "s|deb.debian.org|${APT_MIRROR}|g" /etc/apt/sources.list.d/debian.sources; \
      elif [ -f /etc/apt/sources.list ]; then \
        sed -i "s|deb.debian.org|${APT_MIRROR}|g" /etc/apt/sources.list; \
      fi; \
    fi

RUN apt-get update && \
    apt-get install -y --no-install-recommends curl build-essential ca-certificates python3 python3-dev && \
    rm -rf /var/lib/apt/lists/*

ENV PYTHON=/usr/bin/python3
ENV npm_config_python=/usr/bin/python3

# Copy shared package
COPY platform/packages/shared /app/packages/shared

# Copy ai-backend package files
COPY services/ai-backend/package*.json ./

# ai-backend/package.json uses "@khy/shared": "^1.6.5" for monorepo local dev.
# In Docker single-package build, rewrite it to a local file dependency.
RUN node -e "const fs=require('fs');const p=JSON.parse(fs.readFileSync('package.json','utf8'));if(p.dependencies&&p.dependencies['@khy/shared'])p.dependencies['@khy/shared']='file:packages/shared';fs.writeFileSync('package.json',JSON.stringify(p,null,2));"
RUN rm -f package-lock.json
ARG NPM_REGISTRY=https://registry.npmjs.org
RUN npm config set registry $NPM_REGISTRY
RUN npm install --no-audit --no-fund

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
