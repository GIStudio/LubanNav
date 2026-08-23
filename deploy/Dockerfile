# syntax=docker/dockerfile:1
# LubanNav 生产镜像：Node 构建静态站点 → nginx 运行。
#
# 构建参数：
#   VITE_VOICE_GATEWAY_URL   可选。让前端语音聊天指向自建网关，例如
#                            http://<宿主机IP>:9000/voice/session
#                            不传时使用默认的阿里云函数计算网关。
#
# 用法（在仓库根目录执行）：
#   docker build -f deploy/Dockerfile -t luban-nav .
#   docker run --rm -p 8080:8080 luban-nav
FROM node:22-alpine AS build

ARG VITE_VOICE_GATEWAY_URL=
ENV VITE_VOICE_GATEWAY_URL=${VITE_VOICE_GATEWAY_URL}

WORKDIR /app

# 先装依赖，利用层缓存
COPY package.json package-lock.json ./
RUN npm ci

# 源码与数据（.dockerignore 已排除生成物与重型目录）
COPY index.html vite.config.js ./
COPY src ./src
COPY public ./public
COPY scripts ./scripts
COPY config ./config

# 生成寻路图 + 静态 API + Vite 构建（全部离线）
RUN npm run build

# ---- 运行时：纯静态 nginx ----
FROM nginx:1.27-alpine

COPY deploy/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/dist /usr/share/nginx/html

EXPOSE 8080
