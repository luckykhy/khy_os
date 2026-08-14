# Stage 1: Build
FROM node:22-alpine AS builder

WORKDIR /app
ARG NPM_REGISTRY=https://registry.npmjs.org
RUN npm config set registry $NPM_REGISTRY
COPY package*.json ./
RUN npm install --no-audit --no-fund --package-lock=false
COPY . .

ARG VITE_API_BASE_URL=http://localhost:3000
ENV VITE_API_BASE_URL=$VITE_API_BASE_URL

RUN npm run build

# Stage 2: Serve
FROM nginx:alpine

COPY --from=builder /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80
