# Dockerfile — khy-os CLI container image
#
# Builds on python:3.12-slim and installs Node.js 22 so both the pip wheel
# (Python + bundled Node runtime) and the global npm CLI entry work.
#
# Usage:
#   docker build -t khy-os:latest .
#   docker run --rm -it khy-os:latest khy --version
#
# The image is deliberately minimal: no build tools, no git, no extra shells.
# khy-os's pip wheel ships its own bundled runtime; Node is only needed for the
# npm entry shim that forwards to the same bundled khy.js.

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
    && node --version && npm --version

# ── Install khy-os from PyPI ──────────────────────────────────────────────────
# The pip wheel bundles the full Node runtime + Python sources, so `khy` works
# out of the box. We pin to the latest released version at build time; CI
# rebuilds this tag on every release via the Docker workflow.
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
USER khy
WORKDIR /home/khy

# ── Runtime defaults ──────────────────────────────────────────────────────────
ENV KHY_HOME=/home/khy/.khy
ENV PATH="/usr/local/bin:${PATH}"

# dumb-init reaps zombies and forwards signals properly.
ENTRYPOINT ["/usr/bin/dumb-init", "--"]
CMD ["khy"]
