# LubanNav 容器部署

前端是**纯静态站点**（Vite + Preact + Leaflet），运行时不需要任何后端，一个
nginx 容器即可。地图数据、路网、地点与全部预计算路线都是同源静态 JSON。

## 端口

| 服务 | 端口 | 说明 |
| --- | --- | --- |
| 网站（必需） | **8080** | 页面 + 静态 API 全部同源输出 |
| 语音网关（可选） | 9000 | 局域网自建语音网关；默认走阿里云函数计算，可不启 |
| 机器人 WiFi 桥（可选） | 8900 | 在车机/局域网主机上跑，一般不进本容器 |

出站无需开端口：天气（Open-Meteo）与机器人 WebSocket 都是浏览器主动外连。

## 快速开始（单容器）

```bash
# 在仓库根目录构建
docker build -f deploy/Dockerfile -t luban-nav .
docker run -d --name luban-nav -p 8080:8080 luban-nav
# 打开 http://<容器IP>:8080
```

## docker compose（推荐实验方式）

```bash
cd deploy
docker compose up -d          # 只起网站
docker compose --profile voice up -d   # 网站 + 语音网关
```

### 局域网自建语音网关

1. `cd deploy && cp voice-gateway.env.example voice-gateway.env`，填入
   `DASHSCOPE_API_KEY`、`QWEN_WORKSPACE_ID`、`LUBANNAV_ACCESS_CODE`；
2. 重新构建前端并注入网关地址（构建期 `VITE_*`，写死在产物里）：

```bash
VITE_VOICE_GATEWAY_URL=http://192.168.1.10:9000/voice/session \
VOICE_ALLOWED_ORIGINS=http://192.168.1.10:8080 \
docker compose --profile voice up -d --build
```

3. `ALLOWED_ORIGINS` 必须包含站点的 Origin，否则网关会拒绝跨域请求
   （`server.mjs` 默认只允许 `https://gistudio.github.io`）。

密钥只进容器环境变量，不会进入前端产物；访问码仍由浏览器
localStorage / `?accessCode=` 传递。

## 新开实验容器的规格建议

- 多阶段构建只需在**构建时**联网拉 npm 包；运行时镜像不联网也能跑；
- 1–2 CPU / 1–2 GB 内存足够（`npm run build` 峰值约 1 GB）；
- 开放 8080（必选）、9000（语音网关）、8900（车机桥，可选）；
- 网页 Web Bluetooth 需要真实蓝牙硬件，容器/服务器上不可用，BLE 联调仍在
  Mac 上跑 `npm run ble:simulator`。

## 注意事项

- `dist/` 与 `public/api/v1/routes/`（约 459 MB）是构建产物，已通过
  `.dockerignore` 排除，构建上下文只有约 20 MB；
- 构建完全离线可复现（OSM 快照与室内补丁都随仓库提交），不会在构建时联网；
- 需要 HTTPS 时，在前置反代（宿主 nginx / caddy）终结 TLS 后转发 8080，
  并相应更新 `VOICE_ALLOWED_ORIGINS`。
