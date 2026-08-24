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
ALLOWED_ORIGINS=https://gistudio.github.io  # 逗号分隔白名单; 传 '0.0.0' / '*' / '0.0.0.0' 表示通配(放行任意来源, 含 http://localhost:4173 与 http://127.0.0.1:4173 本地演示)
RATE_LIMIT_PER_WINDOW=30
```

不要把前三项写进 GitHub Pages、仓库或任何 `VITE_*` 变量。更新代码后重新部署函数，再以 Pages 来源测试 `OPTIONS` 和 `POST`。

## 百炼侧授权排查（"授权侧"问题定位）

实时语音建连时，网关会用上述永久 API Key 在**北京地域**与百炼完成一次 Offer/Answer SDP 交换（`qwen3.5-omni-flash-realtime`）。每次断线重连都会重新交换一次，因此授权侧的常见故障与表现如下：

| 现象（客户端提示） | 网关日志 | 原因与处理 |
|---|---|---|
| 百炼授权失败，请检查 API Key 与 Workspace | `upstream rejected status=401/403` | API Key 无该模型权限、地域不是北京、Workspace ID 不匹配。到百炼控制台确认：模型服务已开通、已领取实时语音免费额度、Key 归属正确 Workspace。 |
| 百炼并发或限流，正在等待后自动重试 | `upstream rejected status=429` | 模型并发（QPS/并发路数）已满或触发配额。控制台调高并发（如 2 路）或等待配额恢复；客户端会以 60s 慢速退避自动重试。 |
| 百炼语音服务暂时拒绝连接 | `upstream rejected status=5xx` | 服务端瞬时故障，客户端自动重试。 |

模型并发（如 2 次/秒）只决定"同时能回答多少路用户"，与每个会话的时长无关；走路导航的长时间会话由客户端自动续接，不额外占用建连配额以外的资源。

请求与响应：

```json
{"accessCode":"...","offerSdp":"v=0\r\n..."}
```

```json
{"answerSdp":"v=0\r\n..."}
```

函数不再向浏览器返回临时百炼密钥。它只返回一次性的 Answer SDP，并设置 `Cache-Control: no-store`。
