# Qwen / 百炼模型接入总览

LubanNav 通过阿里云百炼（DashScope / Model Studio）接入 Qwen 系列模型，共涉及三种通道。本文统一说明模型选择、接入方式、限流与授权要点，以及各通道之间的关系。

## 1. 三种接入通道

| 通道 | 模型 | 用途 | 实现位置 |
| --- | --- | --- | --- |
| **实时语音**（WebRTC） | `qwen3.5-omni-flash-realtime` | 页面语音助手：全双工对话、导航工具调用、行走带路 | `src/lib/qwenRealtime.js` + `services/voice-gateway/server.mjs`（SDP 代理） |
| **音频合成**（TTS） | `qwen3-tts-flash` | 离线生成演示/视频配音音频（与实时助手同产品族） | `scripts/generate-demo-audio.mjs` → `public/demo-audio/` |
| **多模态交互套件**（参考） | `multimodal-dialog`（App 模式） | 面向 AI 硬件产品的可视化应用配置（Agent/插件/音色管理）；**当前未采用**，见 §5 | — |

## 2. 实时语音接入（qwen3.5-omni-flash-realtime）

### 链路

```text
浏览器 qwenRealtime.js                    函数计算网关 voice-gateway              百炼
  getUserMedia ──► PeerConnection              │                                  │
  createOffer ──► POST /voice/session ────────►│ 校验 Origin/限流/访问码            │
        │        {accessCode, offerSdp}        │ POST application/sdp (Bearer Key) │
        │                                      │ ────────────────────────────────►│
        │ ◄────────── {answerSdp} ─────────────│ ◄────────────── answer SDP ──────│
  setRemoteDescription ──► WebRTC 音频直连（PCM 16k 上行 / 24k 下行 + DataChannel）
  session.created ──► session.update（指令/工具/VAD 配置）
```

- 浏览器**不直接**调用百炼（CORS 限制），SDP 交换由函数计算代理；音频本身经 WebRTC 直连百炼，不经过网关。
- 会话协议为 OpenAI Realtime 兼容：`session.update` / `response.create` / `conversation.item.create` / `input_audio_buffer.*` 事件。
- 导航通过 Function Calling 调用 `set_navigation_route`，页面本地白名单 + A* 验证后回传真实距离/耗时。

### 韧性机制（行走/车载场景）

| 机制 | 行为 |
| --- | --- |
| 自动重连 | `disconnected` 宽限 4 s 等 ICE 自愈；`failed` 或超时后自动重连（重新过网关换 token），退避 1→2→3→5→8→12→15 s 无限重试，用户可随时停止 |
| 慢速档 | 上游 401/403/429（授权/并发问题）自动切 60 s 间隔并显示具体原因，避免打爆网关与百炼 |
| 会话上限 | 10 分钟，到期自动续接（复用重连），重连成功即重置计时——1~10 分钟的长对话不中断 |
| 交互模式 | 全双工（`semantic_vad` 0.5/800ms）或按住说话（0.7/2500ms + 客户端开麦控制），嘈杂环境防误触发 |

### 授权与限流

- 每次建连/重连都需经网关重新交换一次 Answer SDP（token 随会话一次性下发，无法缓存复用）。
- 网关 `RATE_LIMIT_PER_WINDOW` 默认 **30 次/5 分钟**（≈ 10 s/次），覆盖 15 s 重连节奏 + 手动操作余量；多平板同时演示时可调大，但先确认百炼模型并发配额。
- 上游错误按原状态透传：`401/403` = API Key 权限/地域/Workspace 配置问题；`429` = 模型并发或配额满；`5xx` = 服务瞬时故障。排查对照见 [services/voice-gateway/README.md](../services/voice-gateway/README.md)。

## 3. 音频合成（qwen3-tts-flash）

非实时 TTS，用于生成演示/视频配音。**注意不走 OpenAI 兼容的 `/audio/speech`**（返回 404），正确入口是原生多模态接口：

```bash
POST https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation
Authorization: Bearer $DASHSCOPE_API_KEY

{
  "model": "qwen3-tts-flash",
  "input": {
    "text": "要合成的文本",
    "voice": "Cherry",            # 音色；Cherry/Serena/Ethan/Noah 等
    "language_type": "Chinese"    # Chinese | English | Auto ...
  }
}
```

- 非流式响应 `output.audio.url` 为 OSS 完整音频（24 h 有效），下载即得 WAV。
- 流式输出中间 chunk 的 `audio.data` 为 Base64 音频片段，末 chunk 给完整 URL。
- 批量生成脚本：`node scripts/generate-demo-audio.mjs`（从 `.env.codex.local` / `.env` 读 `DASHSCOPE_API_KEY`，输出 `public/demo-audio/{zh,en}/`，幂等跳过已有文件）。

## 4. 权限、地域与 Key 管理要点

- 百炼 API Key 可设置访问限制（来源 IP / 可用模型）。**本地脚本直连失败（`403 Access denied by API-Key restrictions`）时，在控制台给 Key 增加对应模型的使用权限**，或新建无限制 Key 仅用于本地工具。
- 北京地域的 Workspace 与上海地域的 Key/模型互不通用：实时语音（WebRTC）走 `{workspace_id}.cn-beijing.maas.aliyuncs.com`；`dashscope.aliyuncs.com` 为上海地域端点。TTS 接口示例明确标注北京地域配置（`dashscope.base_http_api_url = 'https://dashscope.aliyuncs.com/api/v1'`）。
- 模型开通后可能需要数分钟生效；404 通常表示该 Key/Workspace 未开通该模型，403 表示 Key 未放行该模型。
- 查看账号可用的模型：`GET https://dashscope.aliyuncs.com/compatible-mode/v1/models`（Bearer Key）。
- 模型并发配额（如 2 次/秒）决定"同时能回答多少路用户"，与单个会话时长无关；长时间会话由客户端自动续接解决。

## 5. multimodal-dialog 套件（参考，未采用）

百炼多模态交互套件面向 AI/AR 眼镜、学习机、机器人等硬件：控制台可视化配置模型、提示词、Agent/插件、知识库、音色，客户端只凭 `workspace_id` + `app_id` 通过 WebRTC 接入（`/api/v1/webrtc/inference?model=multimodal-dialog`，连接后发 `run-task` 启动会话，支持 `duplex` / `push2talk` / `tap2talk` 三种交互模式）。

**对比现状（裸模型方案）**：

| | 现状（qwen3.5-omni-flash-realtime） | multimodal-dialog |
| --- | --- | --- |
| 指令/工具维护 | 代码内 `assistantKnowledge.js` 维护，30 s 推送 | 控制台可视化配置，代码零维护 |
| 音色 | 代码固定 `Tina` | 控制台音色管理 |
| 交互模式 | 客户端模拟按住说话 | 原生三种模式 |
| 迁移成本 | — | 重写 `qwenRealtime.js` 会话协议（run-task/continue-task）+ 控制台建应用 |

当前未迁移：客户端自动重连 + 10 分钟续接已解决行走长对话的稳定性问题；若后续需要控制台化配置（Agent/插件/知识库）或视频视觉能力，可沿此路径迁移，网关只需把 SDP 交换 endpoint 换成 `/webrtc/inference` 并透传 `app_id`。

## 相关文档

- [docs/voice-gateway.md](voice-gateway.md)：网关 HTTP 接口、错误码、部署
- [services/voice-gateway/README.md](../services/voice-gateway/README.md)：函数计算配置与百炼授权排查表
- [docs/frontend-modules.md §7](frontend-modules.md)：`qwenRealtime.js` / `voiceSession.js` 模块说明
- 官方：百炼实时语音接入（`/zh/model-studio/realtime-connect-model`）、非实时语音合成（`/zh/model-studio/non-realtime-tts-user-guide`）、多模态交互套件（`/zh/model-studio/multimodal-guidelines`）
