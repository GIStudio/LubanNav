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
| 401/403/429/5xx | `upstream_rejected`（附 `upstreamStatus`、`upstreamCode`） | 百炼上游按原状态透传：401/403 = Key 权限/地域/Workspace 配置问题；429 = 模型并发或配额满；5xx = 服务瞬时故障。`upstreamCode` 为百炼错误码（如 `InvalidApiKey`） |
| 502 | `invalid_upstream_sdp` | 上游 2xx 但返回的 SDP 不以 `v=0` 开头 |
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

超时 20 s（AbortController）。上游非 2xx 会记录 `x-request-id` 到服务端日志，并**按原状态码透传**给客户端（见上表），便于前端区分授权失败、并发限流与服务故障。

### 与限流/自动重连的配合

- 每次建连/重连都会经过本网关重新换取 Answer SDP（token 随会话一次性下发，无法复用缓存），因此网关限流直接决定自动重连的可用节奏。
- 客户端断线自动重连按 1→2→3→5→8→12→15 s 退避；一旦收到上游 401/403/429（透传状态），客户端切换到 60 s 慢速档，避免把网关和百炼打得更死，恢复后自动回到快速档。
- `RATE_LIMIT_PER_WINDOW` 默认 **30 次 / 5 分钟**（≈ 每 10 s 一次）：覆盖 15 s 间隔的自动重连（20 次/5 min）+ 手动操作余量。若需支撑多台平板同时演示，可适当调大，但请先确认百炼侧模型并发配额（如 2 路 QPS）。

## 4. 环境变量

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `DASHSCOPE_API_KEY` | 是 | 北京地域、属于目标 Workspace 的永久 API Key |
| `QWEN_WORKSPACE_ID` | 是 | 北京地域 Workspace ID（仅允许 `[a-zA-Z0-9-]`） |
| `LUBANNAV_ACCESS_CODE`（或 `ACCESS_CODE`） | 是 | 演示访问码 |
| `ALLOWED_ORIGINS` | 否 | 逗号分隔来源白名单，默认 `https://gistudio.github.io` |
| `RATE_LIMIT_PER_WINDOW` | 否 | 5 分钟窗口内每 `客户端IP:Origin` 的最大请求数，默认 30（配合前端自动重连节奏，见上） |
| `FC_SERVER_PORT` / `PORT` | 否 | 监听端口，默认 9000 |

**安全要求**：前三项严禁写入 GitHub Pages、仓库或任何 `VITE_*` 变量（所有 `VITE_*` 都会进入构建后的公开 JavaScript）。访问码保存在本浏览器 localStorage（前端键 `luban-nav:voice-access-code`，清空输入框即删除），也可由分享链接 `?accessCode=...` 自动预填并覆盖保存，页面读取后立即从 URL 移除（不留在地址栏、浏览器历史或复制分享链接中）。

## 5. 函数计算部署要点

- 函数类型：Web 函数 / 自定义运行时 Node.js 20；启动命令 `node server.mjs`；监听端口 9000。
- HTTP 触发器：`POST`、`OPTIONS`，无需认证；公网路径 `/voice/session`。
- 必须允许 Pages 域名发起 `POST` 与预检 `OPTIONS`；来源白名单、访问码、频率限制与配额都在服务端执行。
- 更新代码后重新部署函数，再以 Pages 来源测试 `OPTIONS` 与 `POST`。

前端网关地址覆盖方式：本地 `.env.local` 的 `VITE_VOICE_GATEWAY_URL`；Pages 构建时 Actions 变量 `VOICE_GATEWAY_URL`（注入为 `VITE_VOICE_GATEWAY_URL`）。

## 6. 与会话前端的约束对应

| 网关行为 | 前端处理（`qwenRealtime.js`） |
| --- | --- |
| 401 `invalid_access_code` | 提示「访问码无效，请重新输入」 |
| 403 `origin_not_allowed` | 提示「当前网页来源未被允许」 |
| 429 `rate_limited` | 提示「请求过于频繁」 |
| 透传 `upstreamStatus=401/403` | 提示「百炼授权失败，请检查语音网关的 API Key 与 Workspace 配置」；重连切 60 s 慢速档 |
| 透传 `upstreamStatus=429` | 提示「百炼并发或限流，正在等待后自动重试」；重连切 60 s 慢速档 |
| 透传上游 5xx | 提示「百炼语音服务暂时拒绝连接，正在自动重试」；快速档自动重连 |
| 非 JSON / 缺 `answerSdp` | `gateway-payload` 错误 |
| 网络不可达 | `gateway-network` 错误 |

服务本身的更深入背景见 [`services/voice-gateway/README.md`](../services/voice-gateway/README.md)。
