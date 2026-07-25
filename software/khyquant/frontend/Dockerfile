# Stage 1: Build
FROM node:18-alpine AS builder

WORKDIR /app
RUN npm config set registry https://registry.npmmirror.com
COPY package*.json ./
RUN npm ci
COPY . .

ARG VITE_API_BASE_URL=http://localhost:3000
ENV VITE_API_BASE_URL=$VITE_API_BASE_URL

RUN npm run build

# Stage 2: Serve
FROM nginx:alpine

COPY --from=builder /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf

EXPOSE 80
