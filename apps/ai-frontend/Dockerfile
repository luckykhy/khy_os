# Stage 1: Build
FROM node:22-alpine AS builder

WORKDIR /app
ARG NPM_REGISTRY=https://registry.npmjs.org
RUN npm config set registry $NPM_REGISTRY
COPY package*.json ./
RUN npm install --no-audit --no-fund --package-lock=false
COPY . .

# AI backend endpoint baked in at build time. Override per environment with
# `docker build --build-arg VITE_AI_API_BASE_URL=<url>`; the localhost:9090
# default only applies to a plain local build. The nginx.conf upstream
# (ai-backend:9090) is the compose-network service contract and is configured there.
ARG VITE_AI_API_BASE_URL=http://localhost:9090
ENV VITE_AI_API_BASE_URL=$VITE_AI_API_BASE_URL

RUN npm run build

# Stage 2: Serve
FROM nginx:alpine

COPY --from=builder /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80
