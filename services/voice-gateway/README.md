# LubanNav voice gateway

阿里云百炼 WebRTC 的音频在建连后由浏览器与百炼直接传输，但浏览器不能跨域调用百炼完成 SDP 交换。因此函数计算负责校验 LubanNav 演示访问码，并以服务端永久 API Key 代理一次 Offer/Answer SDP 交换。

## 函数计算配置

- 函数类型：Web 函数 / 自定义运行时 Node.js 20；
- 启动命令：`node server.mjs`；
- 监听端口：`9000`；
- HTTP 触发器：`POST`、`OPTIONS`，无需认证；
- 公网路径：`/voice/session`。

环境变量：

```text
DASHSCOPE_API_KEY=<北京地域、属于下方 Workspace 的永久 API Key>
QWEN_WORKSPACE_ID=<部署方的北京地域 Workspace ID>
LUBANNAV_ACCESS_CODE=<演示访问码>
ALLOWED_ORIGINS=https://gistudio.github.io
RATE_LIMIT_PER_WINDOW=10
```

不要把前三项写进 GitHub Pages、仓库或任何 `VITE_*` 变量。更新代码后重新部署函数，再以 Pages 来源测试 `OPTIONS` 和 `POST`。

请求与响应：

```json
{"accessCode":"...","offerSdp":"v=0\r\n..."}
```

```json
{"answerSdp":"v=0\r\n..."}
```

函数不再向浏览器返回临时百炼密钥。它只返回一次性的 Answer SDP，并设置 `Cache-Control: no-store`。
