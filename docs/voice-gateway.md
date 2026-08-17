# 语音网关（services/voice-gateway）

单文件 Node.js 20 HTTP 服务（`server.mjs`，无第三方依赖），部署为阿里云函数计算 Web 函数。它的唯一职责是：**校验演示访问码，并以服务端永久 API Key 代理一次 WebRTC Offer/Answer SDP 交换**。音频在建连后由浏览器与百炼直接传输，不经过本服务。

## 1. 为什么需要网关

- 百炼浏览器端点不接受跨域 SDP 请求，必须由服务端代理建连。
- 长期百炼 API Key 与 Workspace ID 只能存在于函数环境变量，不能进入网页、GitHub 仓库或浏览器。
- 函数不向浏览器返回任何百炼密钥或临时凭证，只返回一次性 Answer SDP。

## 2. 时序

```text
浏览器                          网关 /voice/session                 百炼
  │  POST {accessCode, offerSdp}      │                              │
  │ ─────────────────────────────────▶│  校验 Origin / 限流 / 访问码   │
  │                                   │  POST application/sdp        │
  │                                   │  Authorization: Bearer <Key> │
  │                                   │ ────────────────────────────▶│
  │                                   │ ◀──────────── answer SDP ────│
  │ ◀──────── {answerSdp} ────────────│                              │
  │  setRemoteDescription(answer)                                    │
  │ ══════════════ WebRTC 音频直连（PCM 双向 + DataChannel 事件）══════▶│
```

前端对应实现：`src/lib/qwenRealtime.js` 的 `requestWebRtcAnswer()`（见 [frontend-modules.md §7](frontend-modules.md)）。

## 3. HTTP 接口

监听端口：`FC_SERVER_PORT` → `PORT` → 默认 `9000`；`server.requestTimeout = 30s`。只接受 `POST /voice/session` 与 `OPTIONS`（任意路径的预检）。

### 请求

```json
POST /voice/session
Content-Type: application/json
Origin: https://gistudio.github.io

{ "accessCode": "...", "offerSdp": "v=0\r\n..." }
```

- 请求体上限 128 KB（超出 413）。
- `offerSdp` 必须以 `v=0` 开头。

### 成功响应

```json
200 OK
Cache-Control: no-store

{ "answerSdp": "v=0\r\n..." }
```

### 错误码

| 状态 | `error` | 触发条件 |
| --- | --- | --- |
| 400 | `invalid_json` | 请求体不是合法 JSON |
| 400 | `invalid_offer_sdp` | `offerSdp` 缺失或不以 `v=0` 开头 |
| 401 | `invalid_access_code` | 访问码不匹配（`timingSafeEqual` 恒定时间比较） |
| 403 | `origin_not_allowed` | `Origin` 不在白名单（含 OPTIONS） |
| 404 | `not_found` | 方法或路径不匹配 |
| 413 | `request_too_large` | 请求体超过 128 KB |
| 429 | `rate_limited` | 超过频率限制 |
| 502 | `upstream_rejected` / `invalid_upstream_sdp` | 百炼拒绝或返回非法 SDP |
| 503 | `service_not_configured` | 服务端环境变量缺失 |
| 504 | `upstream_timeout` | 百炼交换超过 20 s |
| 500 | `voice_gateway_failed` / `internal_error` | 其他服务端错误（5xx 对外统一脱敏） |

CORS：仅白名单 Origin 回写 `Access-Control-Allow-Origin`（`Vary: Origin`），允许方法 `POST, OPTIONS`，允许头 `Content-Type`，预检缓存 600 s。

### 上游调用

```text
POST https://<QWEN_WORKSPACE_ID>.cn-beijing.maas.aliyuncs.com/api/v1/webrtc/realtime?model=qwen3.5-omni-flash-realtime
Authorization: Bearer <DASHSCOPE_API_KEY>
Content-Type: application/sdp
Body: <offerSdp>
```

超时 20 s（AbortController）。上游非 2xx 会记录 `x-request-id` 到服务端日志。

## 4. 环境变量

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `DASHSCOPE_API_KEY` | 是 | 北京地域、属于目标 Workspace 的永久 API Key |
| `QWEN_WORKSPACE_ID` | 是 | 北京地域 Workspace ID（仅允许 `[a-zA-Z0-9-]`） |
| `LUBANNAV_ACCESS_CODE`（或 `ACCESS_CODE`） | 是 | 演示访问码 |
| `ALLOWED_ORIGINS` | 否 | 逗号分隔来源白名单，默认 `https://gistudio.github.io` |
| `RATE_LIMIT_PER_WINDOW` | 否 | 5 分钟窗口内每 `客户端IP:Origin` 的最大请求数，默认 10 |
| `FC_SERVER_PORT` / `PORT` | 否 | 监听端口，默认 9000 |

**安全要求**：前三项严禁写入 GitHub Pages、仓库或任何 `VITE_*` 变量（所有 `VITE_*` 都会进入构建后的公开 JavaScript）。访问码由访客在页面临时输入，只保存在页面内存。

## 5. 函数计算部署要点

- 函数类型：Web 函数 / 自定义运行时 Node.js 20；启动命令 `node server.mjs`；监听端口 9000。
- HTTP 触发器：`POST`、`OPTIONS`，无需认证；公网路径 `/voice/session`。
- 必须允许 Pages 域名发起 `POST` 与预检 `OPTIONS`；来源白名单、访问码、频率限制与配额都在服务端执行。
- 更新代码后重新部署函数，再以 Pages 来源测试 `OPTIONS` 与 `POST`。

前端网关地址覆盖方式：本地 `.env.local` 的 `VITE_VOICE_GATEWAY_URL`；Pages 构建时 Actions 变量 `VOICE_GATEWAY_URL`（注入为 `VITE_VOICE_GATEWAY_URL`）。

## 6. 与会话前端的约束对应

| 网关行为 | 前端处理（`qwenRealtime.js`） |
| --- | --- |
| 401 | 提示「访问码无效，请重新输入」 |
| 403 | 提示「当前网页来源未被允许」 |
| 429 | 提示「请求过于频繁」 |
| 502 | 提示「百炼语音服务暂时拒绝连接」 |
| 非 JSON / 缺 `answerSdp` | `gateway-payload` 错误 |
| 网络不可达 | `gateway-network` 错误 |

服务本身的更深入背景见 [`services/voice-gateway/README.md`](../services/voice-gateway/README.md)。
