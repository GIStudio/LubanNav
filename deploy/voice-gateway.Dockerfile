# LubanNav 语音网关（可选服务）镜像
# server.mjs 只依赖 Node 内置模块，无第三方依赖。
# 环境变量见 deploy/voice-gateway.env.example
FROM node:22-alpine

WORKDIR /app
COPY services/voice-gateway/server.mjs ./

EXPOSE 9000
CMD ["node", "server.mjs"]
