'use strict';

/**
 * bundleArtifacts.js — pure deploy-bundle artifact generators (B1 split, 3rd seam).
 *
 * Carved out of cli/handlers/publish.js: the self-contained generators that
 * render a Dockerfile / docker-compose.yml / .env.example / README and the
 * filename timestamp for a deploy bundle. They depend only on fs/path and their
 * own arguments — no print/formatters, no other publish helper, no __dirname
 * location sensitivity — so they belong in the services layer. publish.js
 * imports them back under their original names; every call site is unchanged.
 */

const fs = require('fs');
const path = require('path');

function _writeDockerBundleDockerfile(backendDir) {
  const dockerfile = `FROM node:20-slim

WORKDIR /app

RUN apt-get update && \\
    apt-get install -y --no-install-recommends \\
      python3 python3-pip python3-dev \\
      curl \\
      build-essential \\
      libssl-dev \\
      ca-certificates && \\
    rm -rf /var/lib/apt/lists/*

COPY package.json ./
COPY vendor ./vendor
RUN npm install --omit=dev --no-audit --no-fund
RUN npm rebuild better-sqlite3 --build-from-source

COPY . .

RUN if [ -f akshare_scripts/requirements.txt ]; then \\
      python3 -m pip install --no-cache-dir -r akshare_scripts/requirements.txt --break-system-packages; \\
    fi

RUN mkdir -p /app/data

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \\
  CMD curl -fsS "http://localhost:\${PORT:-3000}/health" >/dev/null || exit 1

CMD ["sh", "-c", "node scripts/seed.js && node server.js"]
`;
  fs.writeFileSync(path.join(backendDir, 'Dockerfile'), dockerfile, 'utf-8');
}

function _writeDockerBundleCompose(bundleRoot, options = {}) {
  const backendContext = String(options.backendContext || './backend').trim().replace(/\\/g, '/') || './backend';
  const serviceName = String(options.serviceName || 'khy-backend').trim() || 'khy-backend';
  const compose = `services:
  ${serviceName}:
    build:
      context: ${backendContext}
      dockerfile: Dockerfile
    restart: unless-stopped
    ports:
      - "\${BACKEND_PORT:-13000}:3000"
    environment:
      NODE_ENV: production
      PORT: 3000
      DB_TYPE: \${DB_TYPE:-sqlite}
      DB_PATH: /app/data/khy-quant.db
      JWT_SECRET: \${JWT_SECRET:-change_this_in_production}
      KHY_DATA_HOME: /app/data/.khy
    volumes:
      - backend_data:/app/data
    healthcheck:
      test: ["CMD-SHELL", "curl -fsS http://$\${HEALTHCHECK_HOST:-127.0.0.1}:$$PORT/health >/dev/null || exit 1"]
      interval: 10s
      timeout: 5s
      retries: 5

volumes:
  backend_data:
`;
  fs.writeFileSync(path.join(bundleRoot, 'docker-compose.yml'), compose, 'utf-8');
}

function _writeDockerBundleEnvExample(bundleRoot) {
  const env = `# Docker runtime config
BACKEND_PORT=13000
DB_TYPE=sqlite
# For production, set a strong random secret:
JWT_SECRET=change_this_in_production
`;
  fs.writeFileSync(path.join(bundleRoot, '.env.example'), env, 'utf-8');
}

function _writeDockerBundleReadme(bundleRoot, meta = {}) {
  const serviceName = String(meta.serviceName || 'khy-backend').trim() || 'khy-backend';
  const readme = `# KHY OS Docker Bundle

Generated at: ${new Date().toISOString()}
Source backend: ${meta.sourceBackend || '(unknown)'}
Version: ${meta.version || '(unknown)'}

## Quick Deploy

1. Extract this archive.
2. Copy environment template:
   - \`cp .env.example .env\`
3. Start service:
   - \`docker compose up -d --build\`
4. Check status:
   - \`docker compose ps\`
   - \`docker compose logs -f ${serviceName}\`

## Access

- Backend API: \`http://<host>:\${BACKEND_PORT:-13000}\`
- Health check: \`http://<host>:\${BACKEND_PORT:-13000}/health\`

## Stop

- \`docker compose down\`

## Notes

- Default database is SQLite persisted in Docker volume \`backend_data\`.
- For first boot, container runs \`node scripts/seed.js\` before starting server.
- See \`INSTALL_LAYOUT.md\` / \`INSTALL_LAYOUT.json\` for directory structure and source mapping.
`;
  fs.writeFileSync(path.join(bundleRoot, 'README.md'), readme, 'utf-8');
}

function _writePipInstallBundleReadme(bundleRoot, meta = {}) {
  const installKind = String(meta.installKind || 'pip').toLowerCase();
  const isNpm = installKind === 'npm';
  const serviceName = String(meta.serviceName || 'khy-backend').trim() || 'khy-backend';
  const title = isNpm ? 'KHY OS npm-install Bundle' : 'KHY OS pip-install Bundle';
  const sourceLabel = isNpm ? 'Source npm root' : 'Source pip root';
  const installTreeLabel = isNpm ? 'npm-install/backend' : 'pip-install/khy_os/bundled/backend';
  const includeLines = isNpm
    ? [
      '- `npm-install/backend`',
      '- `docker-compose.yml` (Docker deploy entry)',
      '- `.env.example`',
      '- `INSTALL_LAYOUT.md` (directory + source mapping)',
      '- `INSTALL_LAYOUT.json` (machine-readable layout map)',
    ].join('\n')
    : [
      '- `pip-install/khy_platform`',
      '- `pip-install/khy_os`',
      '- `docker-compose.yml` (Docker deploy entry)',
      '- `.env.example`',
      '- `INSTALL_LAYOUT.md` (directory + source mapping)',
      '- `INSTALL_LAYOUT.json` (machine-readable layout map)',
    ].join('\n');

  const readme = `# ${title}

Generated at: ${new Date().toISOString()}
${sourceLabel}: ${meta.siteRoot || '(unknown)'}
Version: ${meta.version || '(unknown)'}

## This archive contains

${includeLines}

## Quick Deploy (Docker)

1. Extract this archive.
2. Copy environment template:
   - \`cp .env.example .env\`
3. Start service:
   - \`docker compose up -d --build\`
4. Check status:
   - \`docker compose ps\`
   - \`docker compose logs -f ${serviceName}\`

## Notes

- Docker build context points to: \`./${installTreeLabel}\`
- Default database is SQLite persisted in Docker volume \`backend_data\`.
- For production, update \`JWT_SECRET\` in \`.env\`.
`;
  fs.writeFileSync(path.join(bundleRoot, 'README.md'), readme, 'utf-8');
}

function _timestampForFileName(date = new Date()) {
  const pad = n => String(n).padStart(2, '0');
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

module.exports = {
  _writeDockerBundleDockerfile,
  _writeDockerBundleCompose,
  _writeDockerBundleEnvExample,
  _writeDockerBundleReadme,
  _writePipInstallBundleReadme,
  _timestampForFileName,
};
